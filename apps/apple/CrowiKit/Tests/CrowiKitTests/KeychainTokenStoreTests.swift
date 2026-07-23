import XCTest
#if canImport(Security)
import Security
#endif

@testable import CrowiKit

/// RFC-0016 §4.3 — `KeychainTokenStore`: `kSecClassGenericPassword`,
/// `service = bundle id`, `account = workspace id`. Uses a disposable,
/// per-test-run `service` string so these tests never touch (or collide
/// with) a real app's stored credentials, and cleans up everything it wrote.
final class KeychainTokenStoreTests: XCTestCase {
    private var store: KeychainTokenStore!
    private var serviceName: String!
    private var writtenWorkspaceIds: [String] = []

    override func setUp() {
        super.setUp()
        serviceName = "wiki.crowi.ios.tests.\(UUID().uuidString)"
        store = KeychainTokenStore(service: serviceName)
        writtenWorkspaceIds = []
    }

    override func tearDown() {
        for id in writtenWorkspaceIds {
            try? store.delete(forWorkspace: id)
        }
        super.tearDown()
    }

    /// Some sandboxed CI environments deny raw Keychain access
    /// (`errSecMissingEntitlement` / `errSecInteractionNotAllowed`) even for
    /// a plain generic-password item with no access-group — this is an
    /// environment limitation, not a logic bug, so it self-skips rather than
    /// failing the whole suite (mirrors this file's siblings' "live spike"
    /// self-skip convention for environment-dependent behavior).
    private func skipIfKeychainUnavailable(_ error: Error) throws {
        if case KeychainTokenStore.StoreError.unhandledStatus(let status) = error,
            status == errSecMissingEntitlement || status == errSecInteractionNotAllowed || status == errSecNotAvailable
        {
            throw XCTSkip("Keychain unavailable in this environment (OSStatus \(status)) — skipping")
        }
    }

    /// `store.save`, wrapped in the same self-skip-on-environment-limitation
    /// handling every call site below otherwise repeated verbatim.
    private func saveOrSkip(_ tokens: StoredTokenPair, forWorkspace workspaceId: String) throws {
        do {
            try store.save(tokens, forWorkspace: workspaceId)
        } catch {
            try skipIfKeychainUnavailable(error)
            throw error
        }
    }

    private func loadOrSkip(forWorkspace workspaceId: String) throws -> StoredTokenPair? {
        do {
            return try store.load(forWorkspace: workspaceId)
        } catch {
            try skipIfKeychainUnavailable(error)
            throw error
        }
    }

    private func deleteOrSkip(forWorkspace workspaceId: String) throws {
        do {
            try store.delete(forWorkspace: workspaceId)
        } catch {
            try skipIfKeychainUnavailable(error)
            throw error
        }
    }

    func testSaveThenLoadRoundTrips() throws {
        let id = "workspace-\(UUID().uuidString)"
        writtenWorkspaceIds.append(id)
        let tokens = StoredTokenPair(accessToken: "at-1", refreshToken: "crowi_rt_1", expiresAt: Date().addingTimeInterval(3600))

        try saveOrSkip(tokens, forWorkspace: id)

        let loaded = try loadOrSkip(forWorkspace: id)
        XCTAssertEqual(loaded, tokens)
    }

    func testSaveTwiceUpdatesInPlaceRatherThanDuplicating() throws {
        let id = "workspace-\(UUID().uuidString)"
        writtenWorkspaceIds.append(id)
        let first = StoredTokenPair(accessToken: "at-1", refreshToken: "crowi_rt_1", expiresAt: Date())
        let second = StoredTokenPair(accessToken: "at-2", refreshToken: "crowi_rt_2", expiresAt: Date())

        try saveOrSkip(first, forWorkspace: id)
        try saveOrSkip(second, forWorkspace: id)

        XCTAssertEqual(try loadOrSkip(forWorkspace: id), second)
    }

    /// external review (ios-review) finding — `save`'s prior implementation
    /// only set `kSecAttrAccessible` on the `SecItemAdd` path, so an item
    /// created under a previous app version's looser accessibility class
    /// would never actually migrate: `SecItemUpdate` leaves any attribute it
    /// isn't explicitly given untouched. Seeds an item directly with the
    /// OLD `.afterFirstUnlock` class (bypassing `store.save` to simulate
    /// "already on disk from before this fix"), then exercises the real
    /// update path and reads the raw Keychain attributes back to confirm the
    /// class actually changed to `.whenUnlocked` in place — not just that
    /// the value round-trips.
    func testSaveMigratesAnExistingAfterFirstUnlockItemToWhenUnlocked() throws {
        let id = "workspace-\(UUID().uuidString)"
        writtenWorkspaceIds.append(id)
        let tokens = StoredTokenPair(accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date())
        guard let data = try? JSONEncoder().encode(tokens) else {
            return XCTFail("failed to encode fixture tokens")
        }

        var seedQuery: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: serviceName as String,
            kSecAttrAccount: id,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        #if os(macOS)
        seedQuery[kSecUseDataProtectionKeychain] = true
        #endif
        let seedStatus = SecItemAdd(seedQuery as CFDictionary, nil)
        guard seedStatus == errSecSuccess else {
            try skipIfKeychainUnavailable(KeychainTokenStore.StoreError.unhandledStatus(seedStatus))
            return XCTFail("failed to seed a legacy-accessibility item: OSStatus \(seedStatus)")
        }

        // Exercise the real `save` update path (this is a duplicate item, so
        // it takes the `SecItemUpdate` branch, not `SecItemAdd`).
        try saveOrSkip(tokens, forWorkspace: id)

        var readQuery: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: serviceName as String,
            kSecAttrAccount: id,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        #if os(macOS)
        readQuery[kSecUseDataProtectionKeychain] = true
        #endif
        var result: AnyObject?
        let readStatus = SecItemCopyMatching(readQuery as CFDictionary, &result)
        guard readStatus == errSecSuccess else {
            try skipIfKeychainUnavailable(KeychainTokenStore.StoreError.unhandledStatus(readStatus))
            return XCTFail("failed to read back the item's attributes: OSStatus \(readStatus)")
        }
        let attributes = result as? [CFString: Any]
        let accessible = attributes?[kSecAttrAccessible] as? String
        XCTAssertEqual(accessible, kSecAttrAccessibleWhenUnlocked as String, "save's update path must migrate the item onto the current accessibility class")

        // And the value itself must still round-trip untouched.
        XCTAssertEqual(try loadOrSkip(forWorkspace: id), tokens)
    }

    func testLoadForUnknownWorkspaceReturnsNil() throws {
        let loaded = try loadOrSkip(forWorkspace: "never-saved-\(UUID().uuidString)")
        XCTAssertNil(loaded)
    }

    func testDeleteRemovesOnlyItsOwnItem() throws {
        let idA = "workspace-a-\(UUID().uuidString)"
        let idB = "workspace-b-\(UUID().uuidString)"
        writtenWorkspaceIds.append(contentsOf: [idA, idB])
        let tokensA = StoredTokenPair(accessToken: "at-a", refreshToken: "rt-a", expiresAt: Date())
        let tokensB = StoredTokenPair(accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date())

        try saveOrSkip(tokensA, forWorkspace: idA)
        try saveOrSkip(tokensB, forWorkspace: idB)

        try deleteOrSkip(forWorkspace: idA)

        XCTAssertNil(try loadOrSkip(forWorkspace: idA))
        XCTAssertEqual(try loadOrSkip(forWorkspace: idB), tokensB)
    }

    func testDeleteOfNonExistentWorkspaceDoesNotThrow() throws {
        try deleteOrSkip(forWorkspace: "never-existed-\(UUID().uuidString)")
    }

    // MARK: - §14 CI-fixed invariant: no secret ever lands in UserDefaults

    /// The §10/§14 CI-fixed "no secret in `UserDefaults`" invariant,
    /// exercised directly through this suite's own `KeychainTokenStore` (not
    /// just through the `WorkspaceStore` facade in `WorkspaceStoreTests`)
    /// side-by-side with a real `WorkspaceIndexStore` — the two stores a
    /// production `WorkspaceStore.finishAdding` writes to together. Scans
    /// every key the `UserDefaults` suite ever wrote, not just the expected
    /// index key, so a future accidental `UserDefaults.standard.set(token,
    /// ...)` anywhere would still be caught here.
    func testTokenNeverLandsInUserDefaultsWhenSavedAlongsideTheWorkspaceIndex() throws {
        let id = "workspace-\(UUID().uuidString)"
        writtenWorkspaceIds.append(id)
        let secretAccessToken = "super-secret-access-token-\(UUID().uuidString)"
        let secretRefreshToken = "super-secret-refresh-token-\(UUID().uuidString)"
        let tokens = StoredTokenPair(accessToken: secretAccessToken, refreshToken: secretRefreshToken, expiresAt: Date())

        try saveOrSkip(tokens, forWorkspace: id)

        let defaultsSuiteName = "wiki.crowi.ios.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defer { defaults.removePersistentDomain(forName: defaultsSuiteName) }
        let indexStore = WorkspaceIndexStore(defaults: defaults, key: "workspaceIndex")
        indexStore.upsert(WorkspaceIndexEntry(id: id, workspaceOriginString: "https://a.example.com", displayTitle: "A"))

        let allValues = defaults.dictionaryRepresentation()
        XCTAssertFalse(allValues.isEmpty, "the index write itself must have landed in UserDefaults")
        for (_, value) in allValues {
            if let data = value as? Data {
                let text = String(data: data, encoding: .utf8) ?? ""
                XCTAssertFalse(text.contains(secretAccessToken), "access token leaked into UserDefaults")
                XCTAssertFalse(text.contains(secretRefreshToken), "refresh token leaked into UserDefaults")
            } else if let text = value as? String {
                XCTAssertFalse(text.contains(secretAccessToken), "access token leaked into UserDefaults")
                XCTAssertFalse(text.contains(secretRefreshToken), "refresh token leaked into UserDefaults")
            }
        }
    }
}
