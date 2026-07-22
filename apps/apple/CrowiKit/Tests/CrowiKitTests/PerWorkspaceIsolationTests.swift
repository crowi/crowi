import XCTest

@testable import CrowiKit

/// RFC-0016 §3/§7.1/§14 — the CI-fixed per-workspace isolation invariant:
/// workspace A's Keychain reference, `apiBaseURL`, and on-disk store
/// directory are structurally unobtainable from workspace B's id. Every
/// `WorkspaceTokenStoring`/`WorkspaceModelContainerFactory` call takes an
/// explicit `workspaceId` — there is no ambient "current workspace" a caller
/// could accidentally read through, so this is pinned by construction, not
/// merely by "the values happen to differ today".
@MainActor
final class PerWorkspaceIsolationTests: XCTestCase {
    /// A hermetic `WorkspaceStore` — fresh `UserDefaults` suite + temp
    /// container directory per call — shared by every test below that needs
    /// a real store rather than a bare `WorkspaceTokenStoring` double.
    private func makeStore(tokenStore: any WorkspaceTokenStoring = InMemoryTokenStore()) -> WorkspaceStore {
        WorkspaceStore(
            indexStore: WorkspaceIndexStore(defaults: UserDefaults(suiteName: "wiki.crowi.ios.tests.\(UUID().uuidString)")!, key: "index"),
            tokenStore: tokenStore,
            containerBaseDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        )
    }

    /// Onboards the two fixture workspaces (`a.example.com` / `b.example.com`)
    /// every cross-workspace test below needs, each with its own token pair.
    @discardableResult
    private func addWorkspacesAAndB(to store: WorkspaceStore) throws -> (a: Workspace, b: Workspace) {
        let workspaceA = try store.finishAdding(
            AddWorkspaceFlow.Onboarded(
                workspaceOrigin: WorkspaceOrigin(URL(string: "https://a.example.com")!),
                displayTitle: "A",
                tokens: StoredTokenPair(accessToken: "at-a", refreshToken: "rt-a", expiresAt: Date().addingTimeInterval(3600))
            )
        )
        let workspaceB = try store.finishAdding(
            AddWorkspaceFlow.Onboarded(
                workspaceOrigin: WorkspaceOrigin(URL(string: "https://b.example.com")!),
                displayTitle: "B",
                tokens: StoredTokenPair(accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date().addingTimeInterval(3600))
            )
        )
        return (workspaceA, workspaceB)
    }

    func testKeychainReferenceRequiresTheExactWorkspaceId() throws {
        let tokenStore = InMemoryTokenStore()
        let tokensA = StoredTokenPair(accessToken: "at-a", refreshToken: "rt-a", expiresAt: Date())
        let tokensB = StoredTokenPair(accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date())
        try tokenStore.save(tokensA, forWorkspace: "workspace-a")
        try tokenStore.save(tokensB, forWorkspace: "workspace-b")

        // Asking for A's id NEVER returns B's tokens (and vice versa) — the
        // only "context" that selects a workspace's credential is the id
        // string itself, passed explicitly at every call site.
        XCTAssertEqual(try tokenStore.load(forWorkspace: "workspace-a"), tokensA)
        XCTAssertEqual(try tokenStore.load(forWorkspace: "workspace-b"), tokensB)
        XCTAssertNotEqual(try tokenStore.load(forWorkspace: "workspace-a"), try tokenStore.load(forWorkspace: "workspace-b"))
    }

    func testDeletingOneWorkspacesTokenNeverAffectsAnother() throws {
        let tokenStore = InMemoryTokenStore()
        let tokensA = StoredTokenPair(accessToken: "at-a", refreshToken: "rt-a", expiresAt: Date())
        let tokensB = StoredTokenPair(accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date())
        try tokenStore.save(tokensA, forWorkspace: "workspace-a")
        try tokenStore.save(tokensB, forWorkspace: "workspace-b")

        try tokenStore.delete(forWorkspace: "workspace-a")

        XCTAssertNil(try tokenStore.load(forWorkspace: "workspace-a"))
        XCTAssertEqual(try tokenStore.load(forWorkspace: "workspace-b"), tokensB)
    }

    func testAPIBaseURLIsDerivedSolelyFromItsOwnWorkspaceOrigin() {
        let workspaceA = Workspace(id: "a", workspaceOrigin: WorkspaceOrigin(URL(string: "https://a.example.com")!), displayTitle: "A")
        let workspaceB = Workspace(id: "b", workspaceOrigin: WorkspaceOrigin(URL(string: "https://b.example.com")!), displayTitle: "B")

        XCTAssertNotEqual(workspaceA.apiBaseURL, workspaceB.apiBaseURL)
        XCTAssertEqual(workspaceA.apiBaseURL.url.host, "a.example.com")
        XCTAssertEqual(workspaceB.apiBaseURL.url.host, "b.example.com")
    }

    /// `WorkspaceModelContainerFactory.storeDirectory` never collapses two
    /// different workspace ids onto the same path — the physical isolation
    /// §7.1 promises (a stale page cached for A can never surface under B).
    func testStoreDirectoriesAreDistinctPerWorkspace() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directoryA = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "workspace-a", baseDirectory: base)
        let directoryB = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "workspace-b", baseDirectory: base)

        XCTAssertNotEqual(directoryA, directoryB)
        XCTAssertFalse(directoryA.path.hasPrefix(directoryB.path))
        XCTAssertFalse(directoryB.path.hasPrefix(directoryA.path))
    }

    /// `WorkspaceStore.signOut` on one workspace must not touch another's
    /// Keychain item or in-memory list entry.
    func testSignOutOfOneWorkspaceLeavesAnotherFullyIntact() async throws {
        let tokenStore = InMemoryTokenStore()
        let store = makeStore(tokenStore: tokenStore)
        let (workspaceA, workspaceB) = try addWorkspacesAAndB(to: store)

        // Hermetic discovery + revoke — never hits the real network for
        // these fake origins.
        MockURLProtocol.requestHandler = { request in
            let path = request.url?.path ?? ""
            let body: Data
            if path.contains(".well-known/oauth-authorization-server") {
                body = """
                {
                  "issuer": "https://a.example.com",
                  "authorization_endpoint": "https://a.example.com/oauth/authorize",
                  "token_endpoint": "https://a.example.com/api/v2/oauth/token",
                  "revocation_endpoint": "https://a.example.com/api/v2/oauth/revoke"
                }
                """.data(using: .utf8)!
            } else {
                body = Data("{}".utf8)
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        await store.signOut(workspaceA.id, urlSession: MockURLProtocol.makeSession())

        XCTAssertNil(try tokenStore.load(forWorkspace: workspaceA.id))
        XCTAssertEqual(try tokenStore.load(forWorkspace: workspaceB.id)?.accessToken, "at-b")
        XCTAssertEqual(store.workspaces.map(\.id), [workspaceB.id])
        XCTAssertEqual(store.activeWorkspaceId, workspaceB.id)
    }

    /// `WorkspaceContext` is the STRUCTURAL half of this invariant (see its
    /// own doc comment): once built for one workspace, there is no method
    /// on it that accepts a differing workspace id, so code that is handed
    /// only a `WorkspaceContext` (rather than the whole `WorkspaceStore` +
    /// an arbitrary `Workspace` value) has no path to another workspace's
    /// credential, refresh coordinator, or on-disk store — contrast with the
    /// raw `WorkspaceTokenStoring` surface the tests above exercise, which
    /// still trusts every caller to pass the right id string every time.
    func testWorkspaceContextOnlyEverSeesItsOwnWorkspacesCredential() throws {
        let store = makeStore()
        let (workspaceA, workspaceB) = try addWorkspacesAAndB(to: store)

        let contextA = try XCTUnwrap(store.context(for: workspaceA))
        let contextB = try XCTUnwrap(store.context(for: workspaceB))

        XCTAssertEqual(contextA.id, workspaceA.id)
        XCTAssertEqual(try contextA.loadTokens()?.accessToken, "at-a")
        XCTAssertEqual(try contextB.loadTokens()?.accessToken, "at-b")
        XCTAssertNotEqual(try contextA.loadTokens(), try contextB.loadTokens())
        XCTAssertEqual(contextA.apiBaseURL.url.host, "a.example.com")
        XCTAssertEqual(contextB.apiBaseURL.url.host, "b.example.com")
    }

    /// The exact attack `context(for:)`'s doc comment describes: `Workspace`
    /// is a public, freely-constructible struct, so a caller (buggy or
    /// malicious) could hand in workspace B's id combined with workspace A's
    /// `workspaceOrigin`. `WorkspaceStore` must canonicalize against its own
    /// state — the resulting context must be B's in every respect (B's
    /// Keychain credential AND B's `apiBaseURL`), never a hybrid that would
    /// send B's credential to A's API.
    func testContextCanonicalizesAgainstTheStoreEvenWhenGivenASpoofedOrigin() throws {
        let store = makeStore()
        let (workspaceA, workspaceB) = try addWorkspacesAAndB(to: store)

        // B's id, A's origin — never legitimately constructible via
        // `WorkspaceStore` itself, but nothing stops a caller from building
        // one directly since `Workspace`'s memberwise `init` is public.
        let spoofed = Workspace(id: workspaceB.id, workspaceOrigin: workspaceA.workspaceOrigin, displayTitle: "spoofed")

        let context = try XCTUnwrap(store.context(for: spoofed))

        XCTAssertEqual(context.apiBaseURL.url.host, "b.example.com", "must use B's own origin, never the spoofed A origin")
        XCTAssertEqual(try context.loadTokens()?.accessToken, "at-b", "must load B's own credential")
        XCTAssertNotEqual(context.apiBaseURL, workspaceA.apiBaseURL)
    }

    /// An id that is not (or no longer) in the store — e.g. concurrently
    /// signed out — must fail closed (`nil`), not fall back to whatever the
    /// caller-supplied `Workspace` value says.
    func testContextReturnsNilForAnUnknownWorkspaceId() throws {
        let store = makeStore()
        let unknown = Workspace(id: "not-a-real-workspace", workspaceOrigin: WorkspaceOrigin(URL(string: "https://a.example.com")!), displayTitle: "?")

        XCTAssertNil(store.context(for: unknown))
    }
}
