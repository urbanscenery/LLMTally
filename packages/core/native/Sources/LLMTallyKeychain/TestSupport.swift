#if LLMTALLY_KEYCHAIN_TESTING
import Foundation
import Security

private struct TestResult: Encodable {
    let ok: Bool
    let phase: String
    let status: OSStatus
    let decryptAclCount: Int?
    let decryptTrustAll: Bool?
    let decryptTrustedApplicationCount: Int?
    let attributesMatch: Bool?
    let decryptPromptSelectors: [UInt16]?
    let decryptTrustedApplicationFingerprints: [String]?
    let nonIntegrityAuthorizationSets: [[String]]?
    let partitionDescriptions: [String]?

    init(
        ok: Bool,
        phase: String,
        status: OSStatus,
        decryptAclCount: Int?,
        decryptTrustAll: Bool?,
        decryptTrustedApplicationCount: Int?,
        attributesMatch: Bool?,
        decryptPromptSelectors: [UInt16]? = nil,
        decryptTrustedApplicationFingerprints: [String]? = nil,
        nonIntegrityAuthorizationSets: [[String]]? = nil,
        partitionDescriptions: [String]? = nil
    ) {
        self.ok = ok
        self.phase = phase
        self.status = status
        self.decryptAclCount = decryptAclCount
        self.decryptTrustAll = decryptTrustAll
        self.decryptTrustedApplicationCount = decryptTrustedApplicationCount
        self.attributesMatch = attributesMatch
        self.decryptPromptSelectors = decryptPromptSelectors
        self.decryptTrustedApplicationFingerprints = decryptTrustedApplicationFingerprints
        self.nonIntegrityAuthorizationSets = nonIntegrityAuthorizationSets
        self.partitionDescriptions = partitionDescriptions
    }
}

private func fingerprint(_ data: Data) -> String {
    var value: UInt64 = 14_695_981_039_346_656_037
    for byte in data {
        value ^= UInt64(byte)
        value = value &* 1_099_511_628_211
    }
    return String(value, radix: 16)
}

private func emitTestResult(_ result: TestResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(result) else {
        Foundation.exit(2)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func readTestPassword() -> Data? {
    guard let data = try? FileHandle.standardInput.readToEnd(),
          !data.isEmpty,
          data.count <= 128 else {
        return nil
    }
    return data
}

private func createTestKeychain(path: String) -> OSStatus {
    guard let password = readTestPassword() else {
        return errSecParam
    }
    var keychain: SecKeychain?
    return password.withUnsafeBytes { bytes in
        SecKeychainCreate(path, UInt32(password.count), bytes.baseAddress, false, nil, &keychain)
    }
}

private func deleteTestKeychain(path: String) -> OSStatus {
    var keychain: SecKeychain?
    let openStatus = SecKeychainOpen(path, &keychain)
    guard openStatus == errSecSuccess, let keychain else {
        return openStatus
    }
    return SecKeychainDelete(keychain)
}

private func inspectTestItem(path: String, service: String, account: String) -> TestResult {
    var keychain: SecKeychain?
    let openStatus = SecKeychainOpen(path, &keychain)
    guard openStatus == errSecSuccess, let keychain else {
        return TestResult(ok: false, phase: "inspect", status: openStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    }

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchSearchList as String: [keychain],
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnRef as String: true,
    ]
    var result: CFTypeRef?
    let findStatus = SecItemCopyMatching(query as CFDictionary, &result)
    guard findStatus == errSecSuccess, let result else {
        return TestResult(ok: false, phase: "inspect", status: findStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    }
    let item = result as! SecKeychainItem

    var access: SecAccess?
    let accessStatus = SecKeychainItemCopyAccess(item, &access)
    guard accessStatus == errSecSuccess, let access else {
        return TestResult(ok: false, phase: "inspect", status: accessStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    }
    var aclListReference: CFArray?
    let aclStatus = SecAccessCopyACLList(access, &aclListReference)
    guard aclStatus == errSecSuccess, let aclList = aclListReference as? [SecACL] else {
        return TestResult(ok: false, phase: "inspect", status: aclStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    }

    let attributeQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchSearchList as String: [keychain],
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnAttributes as String: true,
    ]
    var attributeResult: CFTypeRef?
    let attributeStatus = SecItemCopyMatching(attributeQuery as CFDictionary, &attributeResult)
    guard attributeStatus == errSecSuccess,
          let attributes = attributeResult as? [String: Any] else {
        return TestResult(ok: false, phase: "inspect", status: attributeStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    }
    let attributesMatch = attributes[kSecAttrService as String] as? String == service
        && attributes[kSecAttrAccount as String] as? String == account
        && attributes[kSecAttrLabel as String] as? String == service

    var decryptAclCount = 0
    var decryptTrustAll = false
    var decryptTrustedApplicationCount = 0
    var decryptPromptSelectors: [UInt16] = []
    var decryptTrustedApplicationFingerprints: [String] = []
    var nonIntegrityAuthorizationSets: [[String]] = []
    var partitionDescriptions: [String] = []
    for acl in aclList {
        guard let authorizations = SecACLCopyAuthorizations(acl) as? [String] else {
            continue
        }
        let sortedAuthorizations = authorizations.sorted()
        if !authorizations.contains(kSecACLAuthorizationIntegrity as String) {
            nonIntegrityAuthorizationSets.append(sortedAuthorizations)
        }
        if authorizations.contains(kSecACLAuthorizationPartitionID as String) {
            var applications: CFArray?
            var description: CFString?
            var selector = SecKeychainPromptSelector()
            let contentsStatus = SecACLCopyContents(acl, &applications, &description, &selector)
            guard contentsStatus == errSecSuccess, let description else {
                return TestResult(ok: false, phase: "inspect", status: contentsStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
            }
            partitionDescriptions.append(description as String)
        }
        guard authorizations.contains(kSecACLAuthorizationDecrypt as String) else {
            continue
        }
        decryptAclCount += 1
        var applications: CFArray?
        var description: CFString?
        var selector = SecKeychainPromptSelector()
        let contentsStatus = SecACLCopyContents(acl, &applications, &description, &selector)
        guard contentsStatus == errSecSuccess else {
            return TestResult(ok: false, phase: "inspect", status: contentsStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
        }
        decryptPromptSelectors.append(selector.rawValue)
        if applications == nil {
            decryptTrustAll = true
        } else if let applications {
            decryptTrustedApplicationCount += CFArrayGetCount(applications)
            if let trustedApplications = applications as? [SecTrustedApplication] {
                for trustedApplication in trustedApplications {
                    var trustedData: CFData?
                    let trustedStatus = SecTrustedApplicationCopyData(trustedApplication, &trustedData)
                    guard trustedStatus == errSecSuccess, let trustedData else {
                        return TestResult(ok: false, phase: "inspect", status: trustedStatus, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
                    }
                    decryptTrustedApplicationFingerprints.append(fingerprint(trustedData as Data))
                }
            }
        }
    }
    return TestResult(
        ok: decryptAclCount > 0 && !decryptTrustAll && attributesMatch,
        phase: "inspect",
        status: errSecSuccess,
        decryptAclCount: decryptAclCount,
        decryptTrustAll: decryptTrustAll,
        decryptTrustedApplicationCount: decryptTrustedApplicationCount,
        attributesMatch: attributesMatch,
        decryptPromptSelectors: decryptPromptSelectors.sorted(),
        decryptTrustedApplicationFingerprints: decryptTrustedApplicationFingerprints.sorted(),
        nonIntegrityAuthorizationSets: nonIntegrityAuthorizationSets.sorted { $0.joined(separator: "\u{0}") < $1.joined(separator: "\u{0}") },
        partitionDescriptions: partitionDescriptions.sorted()
    )
}

func runKeychainTestCommand(arguments: [String]) -> Bool {
    guard let command = arguments.first, command.hasPrefix("--test-") else {
        return false
    }
    let result: TestResult
    switch command {
    case "--test-create-keychain":
        guard arguments.count == 2 else {
            emitTestResult(TestResult(ok: false, phase: "create", status: errSecParam, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil))
            return true
        }
        let status = createTestKeychain(path: arguments[1])
        result = TestResult(ok: status == errSecSuccess, phase: "create", status: status, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    case "--test-delete-keychain":
        guard arguments.count == 2 else {
            emitTestResult(TestResult(ok: false, phase: "delete", status: errSecParam, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil))
            return true
        }
        let status = deleteTestKeychain(path: arguments[1])
        result = TestResult(ok: status == errSecSuccess, phase: "delete", status: status, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil)
    case "--test-inspect-item":
        guard arguments.count == 4 else {
            emitTestResult(TestResult(ok: false, phase: "inspect", status: errSecParam, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil))
            return true
        }
        result = inspectTestItem(path: arguments[1], service: arguments[2], account: arguments[3])
    default:
        emitTestResult(TestResult(ok: false, phase: "protocol", status: errSecParam, decryptAclCount: nil, decryptTrustAll: nil, decryptTrustedApplicationCount: nil, attributesMatch: nil))
        return true
    }
    emitTestResult(result)
    if !result.ok {
        Foundation.exit(1)
    }
    return true
}
#endif
