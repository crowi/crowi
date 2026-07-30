import XCTest
#if canImport(Security)
import Security
#endif

@testable import CrowiKit

/// An in-memory emulation of the generic-password `SecItem*` semantics
/// `KeychainTokenStore` relies on, plugged in at the `KeychainItemClient`
/// seam. The emulated contract (checked against the documented Security
/// framework behavior the store's error handling is written for):
///   - `add` — `errSecDuplicateItem` when the (service, account) pair
///     already exists, otherwise stores value + accessibility class and
///     returns `errSecSuccess`;
///   - `update` — `errSecItemNotFound` when the query matches nothing;
///     applies `kSecValueData`/`kSecAttrAccessible` from the update
///     dictionary and leaves every attribute it isn't given untouched (the
///     exact `SecItemUpdate` property the accessibility-migration test
///     exists to pin);
///   - `copyMatching` — `errSecItemNotFound` for a missing item; returns the
///     stored data under `kSecReturnData`, or the attribute dictionary
///     (including `kSecAttrAccessible`) under `kSecReturnAttributes`;
///   - `delete` — removes the matched item, `errSecItemNotFound` otherwise
///     (which the store deliberately tolerates).
final class InMemoryKeychain: @unchecked Sendable {
    private struct ItemKey: Hashable {
        let service: String
        let account: String
    }

    private struct Item {
        var data: Data
        var accessible: String?
    }

    private let lock = NSLock()
    private var items: [ItemKey: Item] = [:]

    /// Total stored items — lets tests assert "update never duplicated".
    var itemCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }

    /// Seeds an item directly, bypassing `KeychainTokenStore.save` — the
    /// deterministic counterpart of the migration test's former raw
    /// `SecItemAdd` seeding ("already on disk from before this fix").
    func seed(service: String, account: String, data: Data, accessible: String) {
        lock.lock()
        defer { lock.unlock() }
        items[ItemKey(service: service, account: account)] = Item(data: data, accessible: accessible)
    }

    /// The stored `kSecAttrAccessible` value for one item, for asserting the
    /// migration actually changed the class in place.
    func accessible(service: String, account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return items[ItemKey(service: service, account: account)]?.accessible
    }

    var client: KeychainItemClient {
        KeychainItemClient(
            add: { [self] attributes, _ in
                guard let dictionary = dictionary(from: attributes), let key = itemKey(from: dictionary) else {
                    return errSecParam
                }
                guard let data = dictionary[kSecValueData as String] as? Data else { return errSecParam }
                lock.lock()
                defer { lock.unlock() }
                guard items[key] == nil else { return errSecDuplicateItem }
                items[key] = Item(data: data, accessible: dictionary[kSecAttrAccessible as String] as? String)
                return errSecSuccess
            },
            update: { [self] query, attributesToUpdate in
                guard let queryDictionary = dictionary(from: query), let key = itemKey(from: queryDictionary),
                    let updates = dictionary(from: attributesToUpdate)
                else { return errSecParam }
                lock.lock()
                defer { lock.unlock() }
                guard var item = items[key] else { return errSecItemNotFound }
                if let data = updates[kSecValueData as String] as? Data {
                    item.data = data
                }
                if let accessible = updates[kSecAttrAccessible as String] as? String {
                    item.accessible = accessible
                }
                items[key] = item
                return errSecSuccess
            },
            copyMatching: { [self] query, result in
                guard let queryDictionary = dictionary(from: query), let key = itemKey(from: queryDictionary) else {
                    return errSecParam
                }
                lock.lock()
                defer { lock.unlock() }
                guard let item = items[key] else { return errSecItemNotFound }
                if queryDictionary[kSecReturnData as String] as? Bool == true {
                    result?.pointee = item.data as CFData
                } else if queryDictionary[kSecReturnAttributes as String] as? Bool == true {
                    var attributes: [String: Any] = [:]
                    if let accessible = item.accessible {
                        attributes[kSecAttrAccessible as String] = accessible
                    }
                    result?.pointee = attributes as CFDictionary
                }
                return errSecSuccess
            },
            delete: { [self] query in
                guard let queryDictionary = dictionary(from: query), let key = itemKey(from: queryDictionary) else {
                    return errSecParam
                }
                lock.lock()
                defer { lock.unlock() }
                return items.removeValue(forKey: key) == nil ? errSecItemNotFound : errSecSuccess
            }
        )
    }

    private func dictionary(from cfDictionary: CFDictionary) -> [String: Any]? {
        (cfDictionary as NSDictionary) as? [String: Any]
    }

    private func itemKey(from dictionary: [String: Any]) -> ItemKey? {
        guard
            let service = dictionary[kSecAttrService as String] as? String,
            let account = dictionary[kSecAttrAccount as String] as? String
        else { return nil }
        return ItemKey(service: service, account: account)
    }
}

/// RFC-0016 §4.3 — `KeychainTokenStore`: `kSecClassGenericPassword`,
/// `service = bundle id`, `account = workspace id`.
///
/// Runs against `InMemoryKeychain` at the `KeychainItemClient` seam, NOT the
/// real keychain (`feature-ios-phase3` review round 1): `swift test`'s
/// unsigned macOS process cannot use the data-protection keychain at all
/// (`errSecMissingEntitlement`, OSStatus -34018), so the previous
/// real-keychain version of this suite self-skipped in every environment the
/// objective gate actually runs in — 6 permanent skips that tested nothing.
/// The emulation keeps every store-level behavior (add-then-update on
/// duplicate, in-place accessibility migration, per-workspace isolation,
/// not-found tolerance) deterministically exercised on each run; the live
/// `SecItem*` functions remain the compiled-in production default
/// (`KeychainItemClient.live`), exercised on-device.
final class KeychainTokenStoreTests: XCTestCase {
    private var keychain: InMemoryKeychain!
    private var store: KeychainTokenStore!
    private var serviceName: String!

    override func setUp() {
        super.setUp()
        keychain = InMemoryKeychain()
        serviceName = "wiki.crowi.ios.tests.\(UUID().uuidString)"
        store = KeychainTokenStore(service: serviceName, client: keychain.client)
    }

    func testSaveThenLoadRoundTrips() throws {
        let id = "workspace-\(UUID().uuidString)"
        let tokens = StoredTokenPair(accessToken: "at-1", refreshToken: "crowi_rt_1", expiresAt: Date().addingTimeInterval(3600))

        try store.save(tokens, forWorkspace: id)

        XCTAssertEqual(try store.load(forWorkspace: id), tokens)
    }

    func testSaveTwiceUpdatesInPlaceRatherThanDuplicating() throws {
        let id = "workspace-\(UUID().uuidString)"
        let first = StoredTokenPair(accessToken: "at-1", refreshToken: "crowi_rt_1", expiresAt: Date())
        let second = StoredTokenPair(accessToken: "at-2", refreshToken: "crowi_rt_2", expiresAt: Date())

        try store.save(first, forWorkspace: id)
        try store.save(second, forWorkspace: id)

        XCTAssertEqual(try store.load(forWorkspace: id), second)
        XCTAssertEqual(keychain.itemCount, 1, "the second save must take the SecItemUpdate branch, never add a second item")
    }

    /// external review (ios-review) finding — `save`'s prior implementation
    /// only set `kSecAttrAccessible` on the `SecItemAdd` path, so an item
    /// created under a previous app version's looser accessibility class
    /// would never actually migrate: `SecItemUpdate` leaves any attribute it
    /// isn't explicitly given untouched (a property `InMemoryKeychain`
    /// deliberately reproduces). Seeds an item directly with the OLD
    /// `.afterFirstUnlock` class (bypassing `store.save` to simulate
    /// "already on disk from before this fix"), then exercises the real
    /// update path and reads the attributes back through the same
    /// `copyMatching` query shape the real API uses — confirming the class
    /// actually changed to `.whenUnlocked` in place, not just that the value
    /// round-trips.
    func testSaveMigratesAnExistingAfterFirstUnlockItemToWhenUnlocked() throws {
        let id = "workspace-\(UUID().uuidString)"
        let tokens = StoredTokenPair(accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date())
        let data = try XCTUnwrap(try? JSONEncoder().encode(tokens))
        keychain.seed(service: serviceName, account: id, data: data, accessible: kSecAttrAccessibleAfterFirstUnlock as String)

        // Exercise the real `save` update path (this is a duplicate item, so
        // it takes the update branch, not the add one).
        try store.save(tokens, forWorkspace: id)

        // Read the attributes back through the client, the same
        // `kSecReturnAttributes` query the real Security API serves.
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
        XCTAssertEqual(keychain.client.copyMatching(readQuery as CFDictionary, &result), errSecSuccess)
        let attributes = result as? [String: Any]
        XCTAssertEqual(
            attributes?[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleWhenUnlocked as String,
            "save's update path must migrate the item onto the current accessibility class"
        )
        XCTAssertEqual(
            keychain.accessible(service: serviceName, account: id),
            kSecAttrAccessibleWhenUnlocked as String
        )

        // And the value itself must still round-trip untouched.
        XCTAssertEqual(try store.load(forWorkspace: id), tokens)
    }

    func testLoadForUnknownWorkspaceReturnsNil() throws {
        XCTAssertNil(try store.load(forWorkspace: "never-saved-\(UUID().uuidString)"))
    }

    func testDeleteRemovesOnlyItsOwnItem() throws {
        let idA = "workspace-a-\(UUID().uuidString)"
        let idB = "workspace-b-\(UUID().uuidString)"
        let tokensA = StoredTokenPair(accessToken: "at-a", refreshToken: "rt-a", expiresAt: Date())
        let tokensB = StoredTokenPair(accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date())

        try store.save(tokensA, forWorkspace: idA)
        try store.save(tokensB, forWorkspace: idB)

        try store.delete(forWorkspace: idA)

        XCTAssertNil(try store.load(forWorkspace: idA))
        XCTAssertEqual(try store.load(forWorkspace: idB), tokensB)
    }

    func testDeleteOfNonExistentWorkspaceDoesNotThrow() throws {
        try store.delete(forWorkspace: "never-existed-\(UUID().uuidString)")
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
        let secretAccessToken = "super-secret-access-token-\(UUID().uuidString)"
        let secretRefreshToken = "super-secret-refresh-token-\(UUID().uuidString)"
        let tokens = StoredTokenPair(accessToken: secretAccessToken, refreshToken: secretRefreshToken, expiresAt: Date())

        try store.save(tokens, forWorkspace: id)

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
