import XCTest

@testable import CrowiKit

/// RFC-0016 §3 — `WorkspaceStore`'s add/switch/sign-out orchestration, plus
/// the §14 CI-fixed "no secret in UserDefaults" invariant:
/// `WorkspaceIndexEntry` (what `WorkspaceStore` writes to `UserDefaults` via
/// `WorkspaceIndexStore`) structurally has no token field, which this file
/// proves by scanning the raw `UserDefaults` bytes after a real add.
@MainActor
final class WorkspaceStoreTests: XCTestCase {
    private var defaultsSuiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaultsSuiteName = "wiki.crowi.ios.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: defaultsSuiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        super.tearDown()
    }

    private func makeStore(tokenStore: any WorkspaceTokenStoring = InMemoryTokenStore()) -> WorkspaceStore {
        WorkspaceStore(
            indexStore: WorkspaceIndexStore(defaults: defaults, key: "workspaceIndex"),
            tokenStore: tokenStore,
            containerBaseDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        )
    }

    private func onboarded(originString: String, title: String, accessToken: String) -> AddWorkspaceFlow.Onboarded {
        AddWorkspaceFlow.Onboarded(
            workspaceOrigin: WorkspaceOrigin(URL(string: originString)!),
            displayTitle: title,
            tokens: StoredTokenPair(accessToken: accessToken, refreshToken: "rt-\(accessToken)", expiresAt: Date().addingTimeInterval(3600))
        )
    }

    func testFinishAddingFirstWorkspaceMakesItActive() throws {
        let store = makeStore()
        let workspace = try store.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))

        XCTAssertEqual(store.workspaces.map(\.id), [workspace.id])
        XCTAssertEqual(store.activeWorkspaceId, workspace.id)
    }

    func testFinishAddingSecondWorkspaceDoesNotChangeActive() throws {
        let store = makeStore()
        let first = try store.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))
        _ = try store.finishAdding(onboarded(originString: "https://b.example.com", title: "B", accessToken: "at-b"))

        XCTAssertEqual(store.activeWorkspaceId, first.id)
        XCTAssertEqual(store.workspaces.count, 2)
    }

    func testSwitchToChangesActiveWorkspace() throws {
        let store = makeStore()
        let first = try store.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))
        let second = try store.finishAdding(onboarded(originString: "https://b.example.com", title: "B", accessToken: "at-b"))

        store.switchTo(second.id)
        XCTAssertEqual(store.activeWorkspaceId, second.id)

        // Switching is local-only — no persisted-index side effect beyond
        // `activeWorkspaceId` itself changing.
        store.switchTo(first.id)
        XCTAssertEqual(store.activeWorkspaceId, first.id)
    }

    func testSwitchToUnknownIdIsANoOp() throws {
        let store = makeStore()
        let first = try store.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))

        store.switchTo("does-not-exist")

        XCTAssertEqual(store.activeWorkspaceId, first.id)
    }

    func testWorkspacesArePersistedAcrossStoreInstances() throws {
        let indexStore = WorkspaceIndexStore(defaults: defaults, key: "workspaceIndex")
        let tokenStore = InMemoryTokenStore()
        let firstStore = WorkspaceStore(
            indexStore: indexStore,
            tokenStore: tokenStore,
            containerBaseDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        )
        let workspace = try firstStore.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))

        let secondStore = WorkspaceStore(
            indexStore: indexStore,
            tokenStore: tokenStore,
            containerBaseDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        )

        XCTAssertEqual(secondStore.workspaces.map(\.id), [workspace.id])
        XCTAssertEqual(secondStore.activeWorkspaceId, workspace.id)
    }

    // MARK: - §3/§7.2/§14 sign-out purges the workspace's image cache too

    /// Sign-out's teardown contract is revoke + Keychain + ModelContainer +
    /// image cache (spec §3/§7.2/§14 — "画像 cache 削除" called out as its own
    /// part, not merely implied by nesting). This seeds a fixture file at
    /// exactly the location `WorkspaceContext.imagesCacheDirectory` resolves
    /// to (the same path a future disk-backed image cache would write real
    /// cached attachments under) and proves `WorkspaceStore.signOut` — the
    /// real, public sign-out entry point, not the factory function in
    /// isolation — actually removes it.
    func testSignOutPurgesThatWorkspacesImagesCacheDirectory() async throws {
        let store = makeStore()
        let workspace = try store.finishAdding(onboarded(originString: "https://a.example.com", title: "A", accessToken: "at-a"))
        let context = try XCTUnwrap(store.context(for: workspace))
        try FileManager.default.createDirectory(at: context.imagesCacheDirectory, withIntermediateDirectories: true)
        let cachedImage = context.imagesCacheDirectory.appendingPathComponent("cached-attachment.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: cachedImage)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cachedImage.path))

        MockURLProtocol.requestHandler = { request in
            let path = request.url?.path ?? ""
            let body: Data
            if path.contains(".well-known/oauth-authorization-server") {
                body = """
                {
                  "issuer": "https://a.example.com",
                  "authorization_endpoint": "https://a.example.com/oauth/authorize",
                  "token_endpoint": "https://a.example.com/api/oauth/token",
                  "revocation_endpoint": "https://a.example.com/api/oauth/revoke"
                }
                """.data(using: .utf8)!
            } else {
                body = Data("{}".utf8)
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        await store.signOut(workspace.id, urlSession: MockURLProtocol.makeSession())

        XCTAssertFalse(FileManager.default.fileExists(atPath: cachedImage.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: context.imagesCacheDirectory.path))
    }

    // MARK: - §14 CI-fixed invariant: no secret ever lands in UserDefaults

    func testUserDefaultsNeverContainsTheAccessOrRefreshTokenStrings() throws {
        let store = makeStore()
        let secretAccessToken = "super-secret-access-token-\(UUID().uuidString)"
        let secretRefreshToken = "super-secret-refresh-token-\(UUID().uuidString)"
        _ = try store.finishAdding(
            AddWorkspaceFlow.Onboarded(
                workspaceOrigin: WorkspaceOrigin(URL(string: "https://a.example.com")!),
                displayTitle: "A",
                tokens: StoredTokenPair(accessToken: secretAccessToken, refreshToken: secretRefreshToken, expiresAt: Date())
            )
        )

        // Scan EVERY key this suite ever wrote — not just the one key the
        // index is expected to live under — so a future accidental
        // `UserDefaults.standard.set(token, ...)` elsewhere would still be
        // caught by this test.
        let allValues = defaults.dictionaryRepresentation()
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
