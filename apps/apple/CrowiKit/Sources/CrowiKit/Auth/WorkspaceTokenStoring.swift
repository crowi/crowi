import Foundation

/// RFC-0016 §3/§4.2 — the OAuth credential persisted per workspace:
/// `{ accessToken, refreshToken, expiresAt }`, where `expiresAt` is computed
/// by the app at token-receipt time (`receipt instant + expires_in`) — the
/// server never sends an absolute expiry. This is the ONLY place a token
/// lives; it is Keychain-only in production (`KeychainTokenStore`) and
/// **never** serialized into `WorkspaceIndexEntry`/`UserDefaults` (§14 — the
/// CI-fixed "no secret in UserDefaults" invariant).
public struct StoredTokenPair: Codable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

/// A per-workspace credential store keyed by `workspaceId`. `KeychainTokenStore`
/// is the production conformance (`kSecClassGenericPassword`, §4.3); tests use
/// an in-memory double so `RefreshCoordinator`/`AuthenticatingMiddleware` unit
/// tests never touch the real Keychain.
///
/// **Deliberately not `public`** (§14): this is the one seam that can load/
/// save/delete an ARBITRARY workspace's credential by id, so it is scoped to
/// module-internal (visible to `@testable import CrowiKit` tests, invisible
/// to the App target). `WorkspaceContext` is the only public, per-workspace
/// view onto a conformer, and `WorkspaceStore`'s public initializer never
/// accepts one from outside the module (see its internal-only designated
/// initializer) — so external code has no way to even construct a
/// `WorkspaceTokenStoring` conformer that could bypass `context(for:)`'s
/// canonicalization, closing the bypass class `PerWorkspaceIsolationTests`
/// pins structurally rather than just by convention. Verified directly (not
/// just by reading the source): a plain `import CrowiKit` compilation unit
/// (the same import kind the App target uses, as opposed to
/// `@testable import`) fails with "no type named 'WorkspaceTokenStoring'/
/// 'KeychainTokenStore' in module 'CrowiKit'" for both this protocol and its
/// production conformance — there is no public path to either from outside
/// this module.
protocol WorkspaceTokenStoring: Sendable {
    func load(forWorkspace workspaceId: String) throws -> StoredTokenPair?
    func save(_ tokens: StoredTokenPair, forWorkspace workspaceId: String) throws
    func delete(forWorkspace workspaceId: String) throws
}
