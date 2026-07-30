import Foundation
import OpenAPIURLSession
import SwiftData

/// RFC-0016 §3/§14 — a **workspace-bound handle**: everything a per-workspace
/// consumer needs (its stored credential, a refresh coordinator, an
/// authenticating transport middleware, its persistence container) scoped to
/// exactly the `Workspace` it was constructed with.
///
/// This is the structural half of the §14 per-workspace isolation invariant.
/// `WorkspaceTokenStoring` (one backing Keychain/in-memory store holding
/// every workspace's credential, keyed by id) and `WorkspaceStore` itself
/// (the root object that legitimately manages every workspace — the
/// switcher UI needs to list and address all of them) are both intentionally
/// multi-tenant. `WorkspaceContext` is the single-tenant view code should
/// hold once it only needs to operate within ONE workspace: its `workspace`
/// is a `let` fixed at `init`, none of its methods accept a differing
/// workspace id, and it has no mutating/retargeting API at all. Code that is
/// handed only a `WorkspaceContext` (rather than the whole `WorkspaceStore`)
/// therefore has no path — structural, not just conventional — to another
/// workspace's Keychain item, refresh coordinator, or on-disk store.
/// `PerWorkspaceIsolationTests` pins this boundary.
public struct WorkspaceContext: Sendable {
    public let workspace: Workspace

    private let tokenStore: any WorkspaceTokenStoring
    private let containerBaseDirectory: URL

    init(workspace: Workspace, tokenStore: any WorkspaceTokenStoring, containerBaseDirectory: URL) {
        self.workspace = workspace
        self.tokenStore = tokenStore
        self.containerBaseDirectory = containerBaseDirectory
    }

    public var id: String { workspace.id }
    public var apiBaseURL: APIBaseURL { workspace.apiBaseURL }

    /// Where this workspace's disk-backed image cache MUST live (§7.2) — a
    /// future disk-backed `WorkspaceImageLoader` cache (`feature-ios-phase1-read`)
    /// that writes anywhere else would not be purged on sign-out. `WorkspaceStore.signOut`
    /// purges it via `WorkspaceModelContainerFactory.deleteImagesCacheDirectory`
    /// as its own explicit teardown step (§14) — `testSignOutPurgesThatWorkspacesImagesCacheDirectory`
    /// pins this.
    public var imagesCacheDirectory: URL {
        WorkspaceModelContainerFactory.imagesCacheDirectory(workspaceId: workspace.id, baseDirectory: containerBaseDirectory)
    }

    /// The currently stored credential for THIS workspace, and only this
    /// one — there is no overload that accepts a different id.
    public func loadTokens() throws -> StoredTokenPair? {
        try tokenStore.load(forWorkspace: workspace.id)
    }

    /// A `RefreshCoordinator` wired to this workspace's own Keychain item
    /// and discovery-resolved `token_endpoint` (§4.1 step 0 — re-resolved on
    /// every call, never assumed equal to `apiBaseURL`).
    public func makeRefreshCoordinator(urlSession: URLSession = .shared) -> RefreshCoordinator {
        let origin = workspace.workspaceOrigin
        return RefreshCoordinator(workspaceId: workspace.id, tokenStore: tokenStore, urlSession: urlSession) {
            try await OAuthDiscoveryDocument.fetch(workspaceOrigin: origin.baseURL, urlSession: urlSession).tokenEndpoint
        }
    }

    /// An `AuthenticatingMiddleware` pre-wired to this workspace's own
    /// `RefreshCoordinator` — the seam a future per-workspace generated API
    /// `Client` (`feature-ios-phase1-read`) composes with, never a
    /// coordinator built for a different workspace.
    public func makeAuthenticatingMiddleware(urlSession: URLSession = .shared) -> AuthenticatingMiddleware {
        AuthenticatingMiddleware(coordinator: makeRefreshCoordinator(urlSession: urlSession))
    }

    /// This workspace's own `ModelContainer` (§7.1) — a distinct on-disk
    /// directory keyed by this workspace's id, never shared with another.
    public func makeModelContainer(models: [any PersistentModel.Type] = [], schemaVersion: Int = 1, confidential: Bool = false) throws
        -> ModelContainer
    {
        try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: workspace.id,
            models: models,
            schemaVersion: schemaVersion,
            baseDirectory: containerBaseDirectory,
            confidential: confidential
        )
    }

    /// Re-applies the §6.3/§7.2 rest-state protection to this workspace's
    /// SwiftData store DIRECTORY — call whenever `AppInfoCache.confidential`
    /// changes (`WorkspaceSession.refreshAppInfo`), mirroring the exact same
    /// call already made for the image cache (`WorkspaceImageDiskCache.
    /// applyConfidentialProtection`). `makeModelContainer`'s own
    /// `confidential` parameter only sets the INITIAL protection at
    /// construction time — a workspace that becomes confidential mid-session
    /// (or stops being one) needs this re-applied on the SAME already-open
    /// store directory too, not only on the next cold launch.
    public func applyConfidentialStorageProtection(_ confidential: Bool) {
        let directory = WorkspaceModelContainerFactory.storeDirectory(workspaceId: workspace.id, baseDirectory: containerBaseDirectory)
        WorkspaceModelContainerFactory.applyRestStateProtections(directory: directory, confidential: confidential)
    }

    /// `feature-ios-phase1-read` — the ONE refreshed `/app/info` cache for
    /// this workspace (§5.2): both the search-capability gate and the §6.3
    /// confidential banner read this SAME instance.
    public func makeAppInfoCache(urlSession: URLSession = .shared) -> AppInfoCache {
        AppInfoCache(apiBaseURL: workspace.apiBaseURL, urlSession: urlSession)
    }

    /// An `AuthenticatedAPIClient` pre-wired to this workspace's own
    /// `AuthenticatingMiddleware` (never a coordinator/middleware built for a
    /// different workspace) — the ONE per-workspace authenticated-fetch
    /// primitive every hand-written `*Lenient` decoder in
    /// `feature-ios-phase1-read` is built on. `urlSession` feeds BOTH the
    /// refresh coordinator AND the request transport itself — before
    /// `feature-ios-phase3` the transport silently stayed on
    /// `URLSession.shared` (`URLSessionTransport()`'s default), which was
    /// invisible in production (the parameter defaults to `.shared` anyway)
    /// but meant a test-injected mock session never saw the actual API
    /// requests, only the token refreshes.
    public func makeAPIClient(urlSession: URLSession = .shared) -> AuthenticatedAPIClient {
        AuthenticatedAPIClient(
            apiBaseURL: apiBaseURL,
            middleware: makeAuthenticatingMiddleware(urlSession: urlSession),
            transport: URLSessionTransport(configuration: .init(session: urlSession))
        )
    }

    /// This workspace's own `WorkspaceImageLoader` (§6.1) — reads the
    /// CURRENT Keychain-stored access token lazily and synchronously on
    /// every fetch (never captured once), so a token rotated by a JSON API
    /// call elsewhere in the app is picked up on the very next image fetch
    /// with no extra wiring.
    public func makeImageLoader(sessionConfiguration: URLSessionConfiguration = .ephemeral) -> WorkspaceImageLoader {
        WorkspaceImageLoader(
            workspaceOrigin: workspace.workspaceOrigin.baseURL,
            accessTokenProvider: { [tokenStore, workspaceId = workspace.id] in
                (try? tokenStore.load(forWorkspace: workspaceId))?.accessToken ?? ""
            },
            sessionConfiguration: sessionConfiguration
        )
    }

    /// This workspace's own `WorkspaceImageDiskCache` (§7.2) — wraps
    /// `makeImageLoader()` with this workspace's own on-disk cache directory
    /// (`imagesCacheDirectory`, purged on sign-out by
    /// `WorkspaceModelContainerFactory.deleteImagesCacheDirectory`) and this
    /// workspace's own `RefreshCoordinator` for the reactive-401 retry.
    public func makeImageCache(
        urlSession: URLSession = .shared,
        imageSessionConfiguration: URLSessionConfiguration = .ephemeral,
        confidential: Bool = false
    ) -> WorkspaceImageDiskCache {
        WorkspaceImageDiskCache(
            loader: makeImageLoader(sessionConfiguration: imageSessionConfiguration),
            coordinator: makeRefreshCoordinator(urlSession: urlSession),
            cacheDirectory: imagesCacheDirectory,
            confidential: confidential
        )
    }
}
