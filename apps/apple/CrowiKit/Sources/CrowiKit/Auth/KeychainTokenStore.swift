import Foundation
#if canImport(Security)
import Security
#endif

/// RFC-0016 §3/§4.3/§14 — `kSecClassGenericPassword`, `service = bundle
/// identifier`, `account = workspace id`. One Keychain item per workspace;
/// deleting one item never touches another workspace's (§4.3) — the
/// structural per-workspace isolation the §10 CI-fixed test pins.
/// Not `public` — see `WorkspaceTokenStoring`'s doc comment (§14): the App
/// target can only ever obtain credentials through `WorkspaceStore`/
/// `WorkspaceContext`, never by constructing this type directly.
struct KeychainTokenStore: WorkspaceTokenStoring {
    private let service: String

    /// - Parameter service: the Keychain `kSecAttrService` value — production
    ///   code passes the bundle identifier (§4.3); tests pass a dedicated,
    ///   disposable service string so test runs never touch (or collide
    ///   with) a real app's stored credentials.
    init(service: String) {
        self.service = service
    }

    enum StoreError: Error, Equatable {
        case unhandledStatus(OSStatus)
        case encodingFailed
        case decodingFailed
    }

    private func query(forWorkspace workspaceId: String) -> [CFString: Any] {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: workspaceId,
        ]
        #if os(macOS)
        // CrowiKit is shared with the future Mac app. On macOS, opt into the
        // data-protection Keychain so this iOS-first generic-password storage
        // keeps the same accessibility semantics instead of falling back to
        // the older file-based Keychain behavior.
        query[kSecUseDataProtectionKeychain] = true
        #endif
        return query
    }

    func save(_ tokens: StoredTokenPair, forWorkspace workspaceId: String) throws {
        guard let data = try? JSONEncoder().encode(tokens) else {
            throw StoreError.encodingFailed
        }
        var addQuery = query(forWorkspace: workspaceId)
        addQuery[kSecValueData] = data
        // iOS 17 / macOS 14 floor — no locked-device access needed for a
        // foreground-only sign-in/refresh flow (§7.2's file-protection
        // baseline is the analogous rest-state guard for SwiftData; this is
        // the Keychain equivalent).
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess { return }
        guard addStatus == errSecDuplicateItem else {
            throw StoreError.unhandledStatus(addStatus)
        }
        // Already exists (e.g. a token refresh) — update in place.
        let updateStatus = SecItemUpdate(
            query(forWorkspace: workspaceId) as CFDictionary,
            [kSecValueData: data] as CFDictionary
        )
        guard updateStatus == errSecSuccess else {
            throw StoreError.unhandledStatus(updateStatus)
        }
    }

    func load(forWorkspace workspaceId: String) throws -> StoredTokenPair? {
        var readQuery = query(forWorkspace: workspaceId)
        readQuery[kSecReturnData] = true
        readQuery[kSecMatchLimit] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw StoreError.unhandledStatus(status)
        }
        guard let data = result as? Data else {
            throw StoreError.decodingFailed
        }
        guard let tokens = try? JSONDecoder().decode(StoredTokenPair.self, from: data) else {
            throw StoreError.decodingFailed
        }
        return tokens
    }

    func delete(forWorkspace workspaceId: String) throws {
        let status = SecItemDelete(query(forWorkspace: workspaceId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.unhandledStatus(status)
        }
    }
}
