import Foundation

@testable import CrowiKit

/// A hermetic, in-memory `WorkspaceTokenStoring` double shared by every test
/// file that needs to exercise `WorkspaceStore`/`RefreshCoordinator`/
/// `AuthenticatingMiddleware` logic WITHOUT touching the real Keychain
/// (`KeychainTokenStoreTests` is the one file that tests the real
/// `KeychainTokenStore` directly).
///
/// `WorkspaceTokenStoring` is a **synchronous** protocol (mirroring
/// `KeychainTokenStore`'s genuinely-synchronous Security-framework calls, safe
/// from any thread without actor-hopping) — this double is a plain
/// lock-protected class rather than an `actor`, so its methods can satisfy
/// the synchronous protocol directly with no async bridging (which would
/// risk deadlocking Swift's cooperative thread pool under
/// `RefreshCoordinatorSingleFlightTests`' many-concurrent-callers scenario).
final class InMemoryTokenStore: WorkspaceTokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: StoredTokenPair]

    init(seed: [String: StoredTokenPair] = [:]) {
        storage = seed
    }

    func load(forWorkspace workspaceId: String) throws -> StoredTokenPair? {
        lock.lock()
        defer { lock.unlock() }
        return storage[workspaceId]
    }

    func save(_ tokens: StoredTokenPair, forWorkspace workspaceId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[workspaceId] = tokens
    }

    func delete(forWorkspace workspaceId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: workspaceId)
    }
}
