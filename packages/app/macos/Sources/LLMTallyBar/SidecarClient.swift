import Foundation
import LLMTallyKit

/// Spawns the Bun sidecar and speaks newline-delimited JSON-RPC 2.0 with
/// it. The Swift shell never opens SQLite or the vault directly — every
/// data question goes through this seam (03_design_spec / 01_plan §9).
final class SidecarClient {
    static let shared = SidecarClient()

    enum SidecarError: Error, LocalizedError {
        case notRunning
        case remote(String)
        case badResponse

        var errorDescription: String? {
            switch self {
            case .notRunning: return "sidecar is not running"
            case .remote(let message): return message
            case .badResponse: return "malformed sidecar response"
            }
        }
    }

    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let queue = DispatchQueue(label: "llmtally.sidecar")
    private var buffer = Data()
    private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
    private var nextRequestId = 0
    private var running = false

    func start() throws {
        guard !running else { return }

        // Dev checkout default: packages/app/src/sidecar-main.ts relative
        // to this source file. A bundled app overrides via environment.
        let sidecarPath = ProcessInfo.processInfo.environment["LLMTALLY_SIDECAR"]
            ?? URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()  // LLMTallyBar
                .deletingLastPathComponent()  // Sources
                .deletingLastPathComponent()  // macos
                .deletingLastPathComponent()  // app
                .appendingPathComponent("src/sidecar-main.ts").path

        // A bundled app launched from Finder inherits a bare PATH, so
        // `/usr/bin/env bun` fails there; probe the usual install spots.
        if let bun = Self.findBun() {
            process.executableURL = URL(fileURLWithPath: bun)
            process.arguments = [sidecarPath]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["bun", sidecarPath]
        }
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        // A dead sidecar must degrade to failed requests, never take the
        // app down with it: fail everything in flight and mark stopped.
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                self.running = false
                let waiting = self.pending
                self.pending.removeAll()
                for completion in waiting.values {
                    completion(.failure(SidecarError.notRunning))
                }
            }
        }
        try process.run()
        running = true
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
        guard running else { return }
        running = false
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        process.terminate()
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
            guard self.running else {
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
                try self.stdinPipe.fileHandleForWriting.write(contentsOf: data)
            } catch {
                self.pending.removeValue(forKey: id)
                self.running = false
                completion(.failure(SidecarError.notRunning))
            }
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

        if let error = reply["error"] as? [String: Any] {
            let message = error["message"] as? String ?? "sidecar error"
            completion(.failure(SidecarError.remote(message)))
        } else {
            completion(.success(reply["result"]))
        }
    }
}
