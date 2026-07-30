import Foundation
#if canImport(Security)
import Security
#endif

/// The four `SecItem*` calls `KeychainTokenStore` makes, as an injectable
/// value — `.live` (the real Security-framework functions) is the production
/// default and the only conformer the app ever runs.
///
/// This seam exists for ONE reason: determinism of the CI-fixed tests
/// (`feature-ios-phase3` review round 1). `swift test`'s macOS test process
/// is unsigned, and the data-protection keychain (the
/// `kSecUseDataProtectionKeychain` branch below) hard-requires a
/// code-signing identity — every real-keychain call fails with
/// `errSecMissingEntitlement` (OSStatus -34018) in exactly the contexts the
/// Apple-island objective gate runs, so tests insisting on the real keychain
/// never actually executed there: they self-skipped, forever, on CI and dev
/// Macs alike. `KeychainTokenStoreTests` instead substitutes an in-memory
/// generic-password emulation at this boundary (same query dictionaries,
/// same OSStatus contract), which keeps every store-level behavior —
/// add-then-update, accessibility migration, per-workspace isolation —
/// deterministically exercised on every `swift test` run.
struct KeychainItemClient: Sendable {
    var add: @Sendable (_ attributes: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var update: @Sendable (_ query: CFDictionary, _ attributesToUpdate: CFDictionary) -> OSStatus
    var copyMatching: @Sendable (_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var delete: @Sendable (_ query: CFDictionary) -> OSStatus

    static let live = KeychainItemClient(
        add: { SecItemAdd($0, $1) },
        update: { SecItemUpdate($0, $1) },
        copyMatching: { SecItemCopyMatching($0, $1) },
        delete: { SecItemDelete($0) }
    )
}

/// RFC-0016 §3/§4.3/§14 — `kSecClassGenericPassword`, `service = bundle
/// identifier`, `account = workspace id`. One Keychain item per workspace;
/// deleting one item never touches another workspace's (§4.3) — the
/// structural per-workspace isolation the §10 CI-fixed test pins.
/// Not `public` — see `WorkspaceTokenStoring`'s doc comment (§14): the App
/// target can only ever obtain credentials through `WorkspaceStore`/
/// `WorkspaceContext`, never by constructing this type directly.
struct KeychainTokenStore: WorkspaceTokenStoring {
    private let service: String
    private let client: KeychainItemClient

    /// - Parameter service: the Keychain `kSecAttrService` value — production
    ///   code passes the bundle identifier (§4.3); tests pass a dedicated,
    ///   disposable service string so test runs never touch (or collide
    ///   with) a real app's stored credentials.
    /// - Parameter client: the `SecItem*` boundary — production always uses
    ///   the default `.live`; tests substitute the in-memory emulation (see
    ///   `KeychainItemClient`'s doc comment for why).
    init(service: String, client: KeychainItemClient = .live) {
        self.service = service
        self.client = client
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
        // This app is foreground-only — there is no background sync that
        // would need to read the token while the device is locked (e.g.
        // right after boot, before the user's first unlock). `.whenUnlocked`
        // is therefore the *correct*, most restrictive class rather than a
        // gratuitous tightening: the token is only ever read/written from a
        // user-driven sign-in/refresh, which already requires an unlocked
        // device. If a background-sync feature is ever added, that is the
        // moment to deliberately relax this to `.afterFirstUnlock` (readable
        // before first unlock) — do that decision here, not at the call site.
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlocked

        let addStatus = client.add(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess { return }
        guard addStatus == errSecDuplicateItem else {
            throw StoreError.unhandledStatus(addStatus)
        }
        // Already exists (e.g. a token refresh) — update in place. Also
        // re-assert `kSecAttrAccessible`: `SecItemUpdate` does not implicitly
        // carry forward an accessibility-class change made by a newer app
        // version, so without this line an item created under the previous
        // `.afterFirstUnlock` default would stay on that looser class
        // forever. Passing it here means every existing signed-in user's
        // next ordinary token refresh silently migrates their stored item to
        // `.whenUnlocked` in place — no separate migration step, and no
        // window where an existing user's token becomes unreadable (the
        // value itself is untouched; only the accessibility class updates).
        let updateStatus = client.update(
            query(forWorkspace: workspaceId) as CFDictionary,
            [
                kSecValueData: data,
                kSecAttrAccessible: kSecAttrAccessibleWhenUnlocked,
            ] as CFDictionary
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
        let status = client.copyMatching(readQuery as CFDictionary, &result)
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
        let status = client.delete(query(forWorkspace: workspaceId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.unhandledStatus(status)
        }
    }
}
