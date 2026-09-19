import Foundation
import LocalAuthentication
import Security

private let protocolVersion = 1
private let maximumRequestBytes = 1_048_576

#if LLMTALLY_BUILD
private let sourceDigest = llmtallyBuildSourceDigest
#else
private let sourceDigest = "development"
#endif

private struct LookupRequest: Decodable {
    let version: Int
    let service: String
    let account: String
}

private struct WriteRequest: Decodable {
    let version: Int
    let service: String
    let account: String
    let secret: String
}

private struct Response: Encodable {
    let version: Int
    let ok: Bool
    let phase: String
    let status: OSStatus?

    private enum CodingKeys: String, CodingKey {
        case version
        case ok
        case phase
        case status
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(ok, forKey: .ok)
        try container.encode(phase, forKey: .phase)
        if let status {
            try container.encode(status, forKey: .status)
        } else {
            try container.encodeNil(forKey: .status)
        }
    }
}

private struct VersionResponse: Encodable {
    let version: Int
    let sourceDigest: String
}

private struct ValueResponse: Encodable {
    let version: Int
    let ok: Bool
    let phase: String
    let status: OSStatus?
    let value: String?

    private enum CodingKeys: String, CodingKey {
        case version
        case ok
        case phase
        case status
        case value
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(ok, forKey: .ok)
        try container.encode(phase, forKey: .phase)
        if let status {
            try container.encode(status, forKey: .status)
        } else {
            try container.encodeNil(forKey: .status)
        }
        if let value {
            try container.encode(value, forKey: .value)
        } else {
            try container.encodeNil(forKey: .value)
        }
    }
}

private enum Operation: String {
    case write
    case read
    case remove
    case findAccount = "find-account"

    var returnsValue: Bool {
        self == .read || self == .findAccount
    }
}

private struct Command {
    let operation: Operation
    let allowsInteraction: Bool
    let keychainPath: String?
}

private enum ItemLookup {
    case found(SecKeychainItem)
    case absent
    case failed(OSStatus)
    case duplicate
}

private enum AccessCreation {
    case created(SecAccess)
    case failed(OSStatus)
}

private func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value) else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"phase\":\"protocol\",\"status\":null,\"version\":1}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func finish(ok: Bool, phase: String, status: OSStatus?, exitCode: Int32) -> Never {
    emit(Response(version: protocolVersion, ok: ok, phase: phase, status: status))
    Foundation.exit(exitCode)
}

private func finishValue(
    ok: Bool,
    phase: String,
    status: OSStatus?,
    value: String?,
    exitCode: Int32
) -> Never {
    emit(ValueResponse(version: protocolVersion, ok: ok, phase: phase, status: status, value: value))
    Foundation.exit(exitCode)
}

private func parseCommand(_ arguments: [String]) -> Command? {
    var remaining = arguments
    let operation: Operation
    if remaining.first == "--read" {
        operation = .read
        remaining.removeFirst()
    } else if remaining.first == "--remove" {
        operation = .remove
        remaining.removeFirst()
    } else if remaining.first == "--find-account" {
        operation = .findAccount
        remaining.removeFirst()
    } else {
        operation = .write
    }

    var allowsInteraction = false
    if remaining.first == "--allow-ui" {
        guard operation == .read else {
            return nil
        }
        allowsInteraction = true
        remaining.removeFirst()
    }

    let keychainPath: String?
    if remaining.isEmpty {
        keychainPath = nil
    } else if remaining.count == 2, remaining[0] == "--keychain" {
        keychainPath = remaining[1]
    } else {
        return nil
    }
    return Command(operation: operation, allowsInteraction: allowsInteraction, keychainPath: keychainPath)
}

private func finishOperationFailure(
    _ operation: Operation,
    status: OSStatus?,
    exitCode: Int32
) -> Never {
    if operation.returnsValue {
        finishValue(ok: false, phase: operation.rawValue, status: status, value: nil, exitCode: exitCode)
    }
    finish(ok: false, phase: operation.rawValue, status: status, exitCode: exitCode)
}

private func readBoundedStandardInput() throws -> Data {
    var input = Data()
    while true {
        guard let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty else {
            return input
        }
        if input.count > maximumRequestBytes - chunk.count {
            throw CocoaError(.fileReadTooLarge)
        }
        input.append(chunk)
    }
}

private func lookupItem(
    service: String,
    account: String,
    keychain: SecKeychain?,
    authenticationContext: LAContext
) -> ItemLookup {
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnRef as String: true,
        kSecUseAuthenticationContext as String: authenticationContext,
    ]
    if let keychain {
        query[kSecMatchSearchList as String] = [keychain]
    }

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        return .absent
    }
    guard status == errSecSuccess else {
        return .failed(status)
    }
    guard let items = result as? [SecKeychainItem] else {
        return .failed(errSecInternalError)
    }
    guard items.count == 1, let item = items.first else {
        return items.isEmpty ? .absent : .duplicate
    }
    return .found(item)
}

private func makeRestrictedAccess(label: String) -> AccessCreation {
    var securityApplication: SecTrustedApplication?
    let securityStatus = SecTrustedApplicationCreateFromPath("/usr/bin/security", &securityApplication)
    guard securityStatus == errSecSuccess, let securityApplication else {
        return .failed(securityStatus)
    }

    var currentApplication: SecTrustedApplication?
    let currentStatus = SecTrustedApplicationCreateFromPath(nil, &currentApplication)
    guard currentStatus == errSecSuccess, let currentApplication else {
        return .failed(currentStatus)
    }

    var access: SecAccess?
    let accessStatus = SecAccessCreate(
        label as CFString,
        [securityApplication, currentApplication] as CFArray,
        &access
    )
    guard accessStatus == errSecSuccess, let access else {
        return .failed(accessStatus)
    }
    return .created(access)
}

private func write(
    _ request: WriteRequest,
    keychain: SecKeychain?,
    authenticationContext: LAContext
) -> Never {
    let secretData = Data(request.secret.utf8)
    switch lookupItem(
        service: request.service,
        account: request.account,
        keychain: keychain,
        authenticationContext: authenticationContext
    ) {
    case .found(let item):
        let status = SecItemUpdate(
            [
                kSecValueRef as String: item,
                kSecUseAuthenticationContext as String: authenticationContext,
            ] as CFDictionary,
            [kSecValueData as String: secretData] as CFDictionary
        )
        guard status == errSecSuccess else {
            finish(ok: false, phase: "update", status: status, exitCode: 1)
        }

        finish(ok: true, phase: "update", status: errSecSuccess, exitCode: 0)

    case .absent:
        let access: SecAccess
        switch makeRestrictedAccess(label: request.service) {
        case .created(let value):
            access = value
        case .failed(let status):
            finish(ok: false, phase: "access", status: status, exitCode: 1)
        }

        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: request.service,
            kSecAttrAccount as String: request.account,
            kSecAttrLabel as String: request.service,
            kSecAttrAccess as String: access,
            kSecValueData as String: secretData,
            kSecUseAuthenticationContext as String: authenticationContext,
        ]
        if let keychain {
            attributes[kSecUseKeychain as String] = keychain
        }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            finish(ok: false, phase: "add", status: status, exitCode: 1)
        }
        finish(ok: true, phase: "add", status: errSecSuccess, exitCode: 0)

    case .failed(let status):
        finish(ok: false, phase: "lookup", status: status, exitCode: 1)
    case .duplicate:
        finish(ok: false, phase: "lookup", status: errSecDuplicateItem, exitCode: 1)
    }
}

private func read(
    _ request: LookupRequest,
    keychain: SecKeychain?,
    authenticationContext: LAContext
) -> Never {
    switch lookupItem(
        service: request.service,
        account: request.account,
        keychain: keychain,
        authenticationContext: authenticationContext
    ) {
    case .found(let item):
        var length: UInt32 = 0
        var bytes: UnsafeMutableRawPointer?
        let status = SecKeychainItemCopyContent(item, nil, nil, &length, &bytes)
        guard status == errSecSuccess else {
            finishValue(ok: false, phase: "read", status: status, value: nil, exitCode: 1)
        }
        defer { SecKeychainItemFreeContent(nil, bytes) }
        let data = bytes.map { Data(bytes: $0, count: Int(length)) } ?? Data()
        guard let value = String(data: data, encoding: .utf8) else {
            finishValue(ok: false, phase: "read", status: errSecDecode, value: nil, exitCode: 1)
        }
        finishValue(ok: true, phase: "read", status: errSecSuccess, value: value, exitCode: 0)
    case .absent:
        finishValue(ok: false, phase: "read", status: errSecItemNotFound, value: nil, exitCode: 1)
    case .failed(let status):
        finishValue(ok: false, phase: "read", status: status, value: nil, exitCode: 1)
    case .duplicate:
        finishValue(ok: false, phase: "read", status: errSecDuplicateItem, value: nil, exitCode: 1)
    }
}

private func remove(
    _ request: LookupRequest,
    keychain: SecKeychain?,
    authenticationContext: LAContext
) -> Never {
    switch lookupItem(
        service: request.service,
        account: request.account,
        keychain: keychain,
        authenticationContext: authenticationContext
    ) {
    case .found(let item):
        let query: [String: Any] = [
            kSecValueRef as String: item,
            kSecUseAuthenticationContext as String: authenticationContext,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess else {
            finish(ok: false, phase: "remove", status: status, exitCode: 1)
        }
        finish(ok: true, phase: "remove", status: errSecSuccess, exitCode: 0)
    case .absent:
        finish(ok: true, phase: "remove", status: errSecSuccess, exitCode: 0)
    case .failed(let status):
        finish(ok: false, phase: "remove", status: status, exitCode: 1)
    case .duplicate:
        finish(ok: false, phase: "remove", status: errSecDuplicateItem, exitCode: 1)
    }
}

private func findAccount(
    _ request: LookupRequest,
    keychain: SecKeychain?,
    authenticationContext: LAContext
) -> Never {
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: request.service,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnAttributes as String: true,
        kSecUseAuthenticationContext as String: authenticationContext,
    ]
    if let keychain {
        query[kSecMatchSearchList as String] = [keychain]
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        finishValue(ok: false, phase: "find-account", status: status, value: nil, exitCode: 1)
    }
    guard status == errSecSuccess else {
        finishValue(ok: false, phase: "find-account", status: status, value: nil, exitCode: 1)
    }
    guard let matches = result as? [[String: Any]], matches.count == 1, let attributes = matches.first else {
        finishValue(ok: false, phase: "find-account", status: errSecDuplicateItem, value: nil, exitCode: 1)
    }
    guard let account = attributes[kSecAttrAccount as String] as? String else {
        finishValue(ok: false, phase: "find-account", status: errSecDecode, value: nil, exitCode: 1)
    }
    finishValue(ok: true, phase: "find-account", status: errSecSuccess, value: account, exitCode: 0)
}

private func run() -> Never {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        emit(VersionResponse(version: protocolVersion, sourceDigest: sourceDigest))
        Foundation.exit(0)
    }

    let interactionStatus = SecKeychainSetUserInteractionAllowed(false)
    guard interactionStatus == errSecSuccess else {
        finish(ok: false, phase: "access", status: interactionStatus, exitCode: 1)
    }
    var keychain: SecKeychain?
    #if LLMTALLY_KEYCHAIN_TESTING
    if runKeychainTestCommand(arguments: arguments) {
        Foundation.exit(0)
    }
    #endif
    guard let command = parseCommand(arguments) else {
        finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
    }
    if command.allowsInteraction {
        let allowStatus = SecKeychainSetUserInteractionAllowed(true)
        guard allowStatus == errSecSuccess else {
            finishValue(ok: false, phase: "read", status: allowStatus, value: nil, exitCode: 1)
        }
    }
    let authenticationContext = LAContext()
    authenticationContext.interactionNotAllowed = !command.allowsInteraction
    if let path = command.keychainPath {
        let openStatus = SecKeychainOpen(path, &keychain)
        guard openStatus == errSecSuccess else {
            finishOperationFailure(command.operation, status: openStatus, exitCode: 1)
        }
    }

    let input: Data
    do {
        input = try readBoundedStandardInput()
    } catch {
        finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
    }
    guard !input.isEmpty else {
        if command.operation.returnsValue {
            finishValue(ok: false, phase: "protocol", status: nil, value: nil, exitCode: 2)
        }
        finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
    }
    switch command.operation {
    case .write:
        guard let request = try? JSONDecoder().decode(WriteRequest.self, from: input),
              request.version == protocolVersion else {
            finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
        }
        write(request, keychain: keychain, authenticationContext: authenticationContext)
    case .read, .remove, .findAccount:
        guard let request = try? JSONDecoder().decode(LookupRequest.self, from: input),
              request.version == protocolVersion else {
            if command.operation.returnsValue {
                finishValue(ok: false, phase: "protocol", status: nil, value: nil, exitCode: 2)
            }
            finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
        }
        switch command.operation {
        case .read:
            read(request, keychain: keychain, authenticationContext: authenticationContext)
        case .remove:
            remove(request, keychain: keychain, authenticationContext: authenticationContext)
        case .findAccount:
            findAccount(request, keychain: keychain, authenticationContext: authenticationContext)
        case .write:
            finish(ok: false, phase: "protocol", status: nil, exitCode: 2)
        }
    }
}

run()
