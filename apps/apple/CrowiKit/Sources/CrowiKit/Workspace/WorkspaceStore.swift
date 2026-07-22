import Combine
import Foundation

/// RFC-0016 §3 — one workspace: `{ id, workspaceOrigin, displayTitle }`.
/// `apiBaseURL` is always DERIVED from `workspaceOrigin` (never stored
/// separately — a single source, matching `APIBaseURL`'s "no raw-URL
/// passthrough" rule).
public struct Workspace: Identifiable, Equatable, Sendable {
    public let id: String
    public let workspaceOrigin: WorkspaceOrigin
    public let displayTitle: String

    public init(id: String, workspaceOrigin: WorkspaceOrigin, displayTitle: String) {
        self.id = id
        self.workspaceOrigin = workspaceOrigin
        self.displayTitle = displayTitle
    }

    public var apiBaseURL: APIBaseURL {
        APIBaseURL(workspaceOrigin: workspaceOrigin)
    }
}

/// RFC-0016 §3 — the observable multi-workspace root: the ordered workspace
/// list + `activeWorkspaceId`, wrapping `WorkspaceIndexStore` (non-secret
/// index) + a `WorkspaceTokenStoring` (Keychain in production) +
/// `WorkspaceModelContainerFactory` (per-workspace SwiftData store).
///
/// This type is deliberately **multi-tenant**: the switcher UI needs to
/// list, add, switch between, and independently sign out of every
/// workspace, so `WorkspaceStore` itself is the one place an arbitrary
/// `Workspace`/id is legitimately in scope. `context(for:)` is where the
/// STRUCTURAL per-workspace isolation lives (§14): it hands out a
/// `WorkspaceContext` bound to exactly one workspace, with no method to
/// retarget it — that is the type any code that should only ever operate
/// within one workspace should hold, never `WorkspaceStore` itself
/// (`PerWorkspaceIsolationTests` pins this boundary).
@MainActor
public final class WorkspaceStore: ObservableObject {
    @Published public private(set) var workspaces: [Workspace] = []
    @Published public private(set) var activeWorkspaceId: String?

    private let indexStore: WorkspaceIndexStore
    private let tokenStore: any WorkspaceTokenStoring
    /// Overridden only by tests — production always uses
    /// `WorkspaceModelContainerFactory.defaultBaseDirectory()`.
    private let containerBaseDirectory: URL

    /// The only entry point the App target (or any code outside this
    /// module) can use — there is no parameter through which it could pass
    /// a custom `WorkspaceTokenStoring` conformer, because that type is
    /// module-internal (§14). Production always ends up on the real
    /// `KeychainTokenStore` via the designated initializer below.
    public convenience init(
        indexStore: WorkspaceIndexStore = WorkspaceIndexStore(),
        containerBaseDirectory: URL = WorkspaceModelContainerFactory.defaultBaseDirectory()
    ) {
        self.init(
            indexStore: indexStore,
            tokenStore: KeychainTokenStore(service: Bundle.main.bundleIdentifier ?? "wiki.crowi.ios"),
            containerBaseDirectory: containerBaseDirectory
        )
    }

    /// Not `public` — the `tokenStore` seam exists only so
    /// `@testable import CrowiKit` tests can inject `InMemoryTokenStore`
    /// doubles. External code (the App target) can only reach the
    /// convenience initializer above, which always wires up the real
    /// Keychain — this is what makes AC-6's per-workspace isolation
    /// structural rather than conventional: there is no public constructor
    /// through which a `WorkspaceStore` (or the raw store it wraps) could
    /// ever be backed by anything else.
    init(
        indexStore: WorkspaceIndexStore = WorkspaceIndexStore(),
        tokenStore: any WorkspaceTokenStoring,
        containerBaseDirectory: URL = WorkspaceModelContainerFactory.defaultBaseDirectory()
    ) {
        self.indexStore = indexStore
        self.tokenStore = tokenStore
        self.containerBaseDirectory = containerBaseDirectory
        self.workspaces = indexStore.loadAll().compactMap { entry in
            guard let origin = entry.workspaceOrigin else { return nil }
            return Workspace(id: entry.id, workspaceOrigin: origin, displayTitle: entry.displayTitle)
        }
        self.activeWorkspaceId = workspaces.first?.id
    }

    /// The **workspace-bound handle** (§14) for `workspace.id`: its own
    /// `RefreshCoordinator`, `AuthenticatingMiddleware`, and `ModelContainer`
    /// — never another workspace's, and not retargetable after construction
    /// (`WorkspaceContext`'s own doc comment). This is the type to hand to
    /// any code that should only ever operate within one workspace; reserve
    /// `WorkspaceStore` itself (this type) for cross-workspace operations
    /// (add/switch/sign-out/list), which is the only place a `Workspace`
    /// value for an arbitrary workspace is legitimately in scope.
    ///
    /// **Canonicalizes against this store**: only `workspace.id` is trusted
    /// from the argument — the `Workspace` value actually used to build the
    /// context is always the one THIS store currently holds for that id,
    /// looked up fresh from `workspaces`, never the caller-supplied value's
    /// own `workspaceOrigin`/`displayTitle`. `Workspace` is a public,
    /// freely-constructible struct, so without this a caller could combine
    /// workspace B's id with workspace A's `workspaceOrigin` and get back a
    /// context that loads B's Keychain credential (`tokenStore.load(forWorkspace:
    /// workspace.id)`) but sends it to A's `apiBaseURL` — a cross-workspace
    /// credential leak. Returns `nil` if `workspace.id` is not (or no longer)
    /// one of `workspaces` (e.g. it was just signed out concurrently).
    public func context(for workspace: Workspace) -> WorkspaceContext? {
        guard let canonical = workspaces.first(where: { $0.id == workspace.id }) else { return nil }
        return WorkspaceContext(workspace: canonical, tokenStore: tokenStore, containerBaseDirectory: containerBaseDirectory)
    }

    /// Persists a freshly onboarded workspace (index entry + Keychain item)
    /// and appends it to `workspaces`, making it active if it is the first
    /// one added.
    @discardableResult
    public func finishAdding(_ onboarded: AddWorkspaceFlow.Onboarded, id: String = UUID().uuidString) throws -> Workspace {
        try tokenStore.save(onboarded.tokens, forWorkspace: id)
        indexStore.upsert(
            WorkspaceIndexEntry(
                id: id,
                workspaceOriginString: onboarded.workspaceOrigin.baseURL.absoluteString,
                displayTitle: onboarded.displayTitle
            )
        )
        let workspace = Workspace(id: id, workspaceOrigin: onboarded.workspaceOrigin, displayTitle: onboarded.displayTitle)
        workspaces.append(workspace)
        if activeWorkspaceId == nil {
            activeWorkspaceId = id
        }
        return workspace
    }

    /// Switching is LOCAL and instant (§3): no network round-trip, no
    /// server call — just repointing `activeWorkspaceId`.
    public func switchTo(_ id: String) {
        guard workspaces.contains(where: { $0.id == id }) else { return }
        activeWorkspaceId = id
    }

    /// §3/§4.2/§14 independent sign-out: server-side revoke + Keychain
    /// purge (`SignOutFlow`) + index removal + that workspace's on-disk
    /// SwiftData store (§7.2). Every OTHER workspace is completely
    /// untouched — no shared state is ever read or written here beyond
    /// `id`'s own rows.
    public func signOut(_ id: String, urlSession: URLSession = .shared) async {
        guard let workspace = workspaces.first(where: { $0.id == id }) else { return }

        let revocationEndpoint = try? await OAuthDiscoveryDocument.fetch(workspaceOrigin: workspace.workspaceOrigin.baseURL, urlSession: urlSession)
            .revocationEndpoint
        if let revocationEndpoint {
            await SignOutFlow.signOut(workspaceId: id, tokenStore: tokenStore, revocationEndpoint: revocationEndpoint, urlSession: urlSession)
        } else {
            // Discovery itself failed (host unreachable) — still purge the
            // local credential; the CLI's `revokeToken` precedent treats a
            // failed revoke as non-fatal too (best-effort).
            try? tokenStore.delete(forWorkspace: id)
        }
        indexStore.remove(id: id)
        // Four explicit teardown steps for this ONE workspace (§3/§7.2/§14):
        // server-side revoke + Keychain purge already happened above
        // (`SignOutFlow`/the fallback `tokenStore.delete`); the image cache
        // and the ModelContainer's on-disk store are purged as their own
        // separate calls here (the latter also removes the former, since
        // `imagesCacheDirectory` is nested inside it, but both are named
        // explicitly so sign-out's contract stays legible at the call site).
        WorkspaceModelContainerFactory.deleteImagesCacheDirectory(workspaceId: id, baseDirectory: containerBaseDirectory)
        WorkspaceModelContainerFactory.deleteWorkspaceDirectory(workspaceId: id, baseDirectory: containerBaseDirectory)

        workspaces.removeAll { $0.id == id }
        if activeWorkspaceId == id {
            activeWorkspaceId = workspaces.first?.id
        }
    }
}
