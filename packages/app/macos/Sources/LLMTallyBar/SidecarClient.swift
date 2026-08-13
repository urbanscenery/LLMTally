import Foundation
import LLMTallyKit

/// Spawns the Bun sidecar and speaks newline-delimited JSON-RPC 2.0 with
/// it. The Swift shell never opens SQLite or the vault directly — every
/// data question goes through this seam (03_design_spec / 01_plan §9).
///
/// Robustness contract (audit CX-41/GK-42): every request carries a
/// deadline, a dead helper is relaunched on the next request (with a
/// short backoff so a crash loop cannot spin), and stderr is captured
/// so a failing helper leaves a diagnosable trace instead of silence.
final class SidecarClient {
    static let shared = SidecarClient()

    enum SidecarError: Error, LocalizedError {
        case notRunning
        case remote(String)
        case badResponse
        case timeout

        var errorDescription: String? {
            switch self {
            case .notRunning: return "sidecar is not running"
            case .remote(let message): return message
            case .badResponse: return "malformed sidecar response"
            case .timeout: return "sidecar did not answer in time"
            }
        }
    }

    /// One helper launch: Foundation's Process can only run() once, so
    /// a restart is a fresh instance of everything, never a reuse.
    private final class Launch {
        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
    }

    private static let requestTimeout: TimeInterval = 20
    private static let restartBackoff: TimeInterval = 5

    private let queue = DispatchQueue(label: "llmtally.sidecar")
    private var launch: Launch?
    private var buffer = Data()
    private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
    private var nextRequestId = 0
    private var running = false
    private var stopped = false
    private var lastLaunchAt: Date?
    /// Consecutive request timeouts — a wedged helper answers nothing,
    /// so three strikes terminate it and let the restart path recover.
    /// A batch expiring together counts once: five reads killed by one
    /// slow scan are one silence, not five (audit grok C2-01).
    private var timeoutStrikes = 0
    private var lastStrikeAt: Date?
    /// Last stderr line — surfaced with failures for diagnosis.
    private(set) var lastStderrLine: String?

    func start() throws {
        try queue.sync { try startLocked() }
    }

    private func startLocked() throws {
        guard !running else { return }
        stopped = false

        let fresh = Launch()
        let process = fresh.process

        // Dev checkout default: packages/app/src/sidecar-main.ts relative
        // to this source file. A bundled app overrides via environment.
        // Resolution order: explicit override → the self-contained
        // binary shipped inside the bundle (bun build --compile, no bun
        // install needed) → the dev checkout's TypeScript via bun.
        let environment = ProcessInfo.processInfo.environment
        // Contents/Helpers, not Resources: a Mach-O in Resources is
        // treated as data by codesign and weakens verification
        let bundledSidecar = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Helpers/llmtally-sidecar")

        if let override = environment["LLMTALLY_SIDECAR"] {
            Self.configureBunLaunch(process, scriptPath: override)
        } else if FileManager.default.isExecutableFile(atPath: bundledSidecar.path) {
            process.executableURL = bundledSidecar
            process.arguments = []
        } else {
            let checkoutScript = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()  // LLMTallyBar
                .deletingLastPathComponent()  // Sources
                .deletingLastPathComponent()  // macos
                .deletingLastPathComponent()  // app
                .appendingPathComponent("src/sidecar-main.ts").path
            Self.configureBunLaunch(process, scriptPath: checkoutScript)
        }
        process.standardInput = fresh.stdinPipe
        process.standardOutput = fresh.stdoutPipe
        process.standardError = fresh.stderrPipe

        fresh.stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        fresh.stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { return }
            NSLog("llmtally sidecar stderr: %@", line)
            self?.queue.async { self?.lastStderrLine = line }
        }
        // A dead sidecar must degrade to failed requests, never take the
        // app down with it: fail everything in flight and mark stopped.
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                guard self.launch === fresh else { return }
                self.running = false
                let waiting = self.pending
                self.pending.removeAll()
                for completion in waiting.values {
                    completion(.failure(SidecarError.notRunning))
                }
            }
        }
        try process.run()
        launch = fresh
        buffer.removeAll()
        running = true
        lastLaunchAt = Date()
    }

    /// Dev path: run the checkout's TypeScript through bun. A Finder-
    /// launched app inherits a bare PATH, so probe the usual installs.
    private static func configureBunLaunch(_ process: Process, scriptPath: String) {
        if let bun = findBun() {
            process.executableURL = URL(fileURLWithPath: bun)
            process.arguments = [scriptPath]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["bun", scriptPath]
        }
    }

    private static func findBun() -> String? {
        var candidates: [String] = []
        if let override = ProcessInfo.processInfo.environment["LLMTALLY_BUN"] {
            candidates.append(override)
        }
        candidates.append(NSHomeDirectory() + "/.bun/bin/bun")
        candidates.append("/opt/homebrew/bin/bun")
        candidates.append("/usr/local/bin/bun")
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func stop() {
        queue.sync {
            stopped = true
            guard running, let launch else { return }
            running = false
            launch.stdoutPipe.fileHandleForReading.readabilityHandler = nil
            launch.stderrPipe.fileHandleForReading.readabilityHandler = nil
            launch.process.terminate()
        }
    }

    /// Typed request: re-serializes the JSON-RPC `result` and decodes it
    /// into the caller's DTO, so views never touch untyped payloads.
    func requestDecodable<T: Decodable>(_ method: String, params: [String: Any]? = nil,
                                        as type: T.Type,
                                        completion: @escaping (Result<T, Error>) -> Void) {
        request(method, params: params) { result in
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let value):
                guard let value, JSONSerialization.isValidJSONObject(value) else {
                    completion(.failure(SidecarError.badResponse))
                    return
                }
                do {
                    let data = try JSONSerialization.data(withJSONObject: value)
                    completion(.success(try JSONDecoder().decode(T.self, from: data)))
                } catch {
                    completion(.failure(error))
                }
            }
        }
    }

    func request(_ method: String, params: [String: Any]? = nil,
                 completion: @escaping (Result<Any?, Error>) -> Void) {
        queue.async {
            if !self.running {
                self.attemptRestart()
            }
            guard self.running, let launch = self.launch else {
                completion(.failure(SidecarError.notRunning))
                return
            }
            self.nextRequestId += 1
            let id = self.nextRequestId
            var body: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
            if let params { body["params"] = params }
            guard var data = try? JSONSerialization.data(withJSONObject: body) else {
                completion(.failure(SidecarError.badResponse))
                return
            }
            data.append(0x0A)
            self.pending[id] = completion
            do {
                // throwing write: a broken pipe becomes a failed request
                // (with SIGPIPE ignored in main.swift), not a dead app
                try launch.stdinPipe.fileHandleForWriting.write(contentsOf: data)
            } catch {
                self.pending.removeValue(forKey: id)
                self.running = false
                completion(.failure(SidecarError.notRunning))
                return
            }
            // deadline: one unanswered request must not park the UI in
            // loading forever (and pending must never grow unbounded)
            self.queue.asyncAfter(deadline: .now() + Self.requestTimeout) { [weak self] in
                guard let self, let waiting = self.pending.removeValue(forKey: id) else { return }
                waiting(.failure(SidecarError.timeout))
                // a helper that keeps timing out is wedged, and the
                // serial pipe means everything behind it dies too —
                // kill it so the backoff restart can recover (C1-04)
                let now = Date()
                if let last = self.lastStrikeAt, now.timeIntervalSince(last) < 2 {
                    return
                }
                self.lastStrikeAt = now
                self.timeoutStrikes += 1
                if self.timeoutStrikes >= 3, self.running, let launch = self.launch {
                    NSLog("llmtally sidecar unresponsive (3 timeouts); terminating for restart")
                    self.timeoutStrikes = 0
                    launch.process.terminate()
                }
            }
        }
    }

    /// Relaunches a dead helper on demand, at most once per backoff
    /// window — a helper that dies instantly must not spin the CPU.
    private func attemptRestart() {
        guard !stopped else { return }
        if let last = lastLaunchAt, Date().timeIntervalSince(last) < Self.restartBackoff {
            return
        }
        do {
            try startLocked()
            NSLog("llmtally sidecar restarted")
        } catch {
            NSLog("llmtally sidecar restart failed: %@", String(describing: error))
        }
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async {
            self.buffer.append(data)
            while let newline = self.buffer.firstIndex(of: 0x0A) {
                let line = self.buffer.prefix(upTo: newline)
                self.buffer.removeSubrange(...newline)
                self.dispatch(line: Data(line))
            }
        }
    }

    private func dispatch(line: Data) {
        guard
            let object = try? JSONSerialization.jsonObject(with: line),
            let reply = object as? [String: Any],
            let id = reply["id"] as? Int,
            let completion = pending.removeValue(forKey: id)
        else { return }

        timeoutStrikes = 0
        if let error = reply["error"] as? [String: Any] {
            let message = error["message"] as? String ?? "sidecar error"
            completion(.failure(SidecarError.remote(message)))
        } else {
            completion(.success(reply["result"]))
        }
    }
}
