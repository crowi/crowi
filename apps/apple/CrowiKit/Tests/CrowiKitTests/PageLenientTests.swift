import HTTPTypes
import OpenAPIRuntime
import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2/§8 CI-fixed invariant — the lenient decoder tolerates
/// unknown/missing fields (degrade, never throw), and honors
/// `PageSchema.revision`'s `string | Revision` union (§8's
/// detail-GET-before-render rule).
final class PageLenientTests: XCTestCase {
    func testDetailResponseWithFullRevisionDecodesBody() throws {
        let json = """
        { "page": { "_id": "p1", "path": "/team/eng", "revision": { "_id": "r1", "body": "# Hello" }, "commentCount": 2 } }
        """
        let response = try GetPageResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.page.id, "p1")
        XCTAssertEqual(response.page.path, "/team/eng")
        XCTAssertEqual(response.page.revision?.body, "# Hello")
        XCTAssertFalse(response.page.needsDetailFetchForBody)
    }

    func testListRowWithBareStringRevisionHasNoBodyAndNeedsDetailFetch() throws {
        let json = """
        { "pages": [ { "_id": "p1", "path": "/team/eng", "revision": "r1" } ], "pager": { "prev": null, "next": null, "offset": 0 } }
        """
        let response = try ListPagesResponseLenient.decode(Data(json.utf8))

        let page = try XCTUnwrap(response.pages.first)
        XCTAssertEqual(page.revision?.id, "r1")
        XCTAssertNil(page.revision?.body)
        XCTAssertTrue(page.needsDetailFetchForBody, "a list row's bare-string revision must signal 'detail GET required' (§8)")
    }

    func testRowWithNoRevisionAtAllAlsoNeedsDetailFetch() throws {
        let json = """
        { "pages": [ { "_id": "p1", "path": "/no/revision" } ], "pager": { "prev": null, "next": null, "offset": 0 } }
        """
        let response = try ListPagesResponseLenient.decode(Data(json.utf8))

        let page = try XCTUnwrap(response.pages.first)
        XCTAssertNil(page.revision)
        XCTAssertTrue(page.needsDetailFetchForBody)
    }

    /// The lenient decoder degrade: unknown extra fields are ignored and
    /// missing optional fields become `nil`/defaults rather than throwing.
    func testUnknownAndMissingOptionalFieldsDegradeGracefully() throws {
        let json = """
        { "page": { "_id": "p1", "path": "/x", "revision": { "_id": "r1", "body": "hi" }, "somethingTheAppHasNeverHeardOf": { "nested": true } } }
        """
        let response = try GetPageResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.page.id, "p1")
        XCTAssertNil(response.page.status)
        XCTAssertNil(response.page.commentCount)
        XCTAssertNil(response.page.liker)
    }

    func testMissingPageKeyThrowsADistinctError() {
        let json = "{ \"notAPage\": true }"

        XCTAssertThrowsError(try GetPageResponseLenient.decode(Data(json.utf8))) { error in
            XCTAssertEqual(error as? PageLenientDecodeError, .missingPage)
        }
    }

    func testNonObjectResponseThrows() {
        XCTAssertThrowsError(try GetPageResponseLenient.decode(Data("[]".utf8))) { error in
            XCTAssertEqual(error as? PageLenientDecodeError, .notAnObject)
        }
    }

    func testListPageChildrenDecodesSegmentsWithDefaultsForMissingBooleans() throws {
        let json = """
        { "children": [ { "segment": "eng", "path": "/team/eng/" }, { "segment": "ops", "path": "/team/ops/", "isPage": true, "hasPortal": true, "count": 3 } ] }
        """
        let response = try ListPageChildrenResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.children.count, 2)
        XCTAssertEqual(response.children[0].isPage, false)
        XCTAssertEqual(response.children[0].hasPortal, false)
        XCTAssertEqual(response.children[1].count, 3)
    }

    func testLikerMembershipCanBeCheckedAgainstAUserId() throws {
        let json = """
        { "page": { "_id": "p1", "path": "/x", "revision": { "_id": "r1", "body": "hi" }, "liker": ["user-a", "user-b"] } }
        """
        let response = try GetPageResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.page.liker, ["user-a", "user-b"])
    }

    // MARK: - feature-ios-design-language: child-segment metadata (1)

    func testChildSegmentsDecodeLastUpdatedAtAndUpdater() throws {
        let json = """
        { "children": [ { "segment": "eng", "path": "/team/eng/", "isPage": false, "hasPortal": true, "count": 3, "lastUpdatedAt": "2026-07-20T10:00:00.000Z", "updater": { "_id": "u1", "username": "sotarok", "name": "Sotaro", "email": "s@example.com", "image": "/api/attachments/by-key/user/sotarok.png", "createdAt": "2026-01-01" } } ] }
        """
        let child = try XCTUnwrap(ListPageChildrenResponseLenient.decode(Data(json.utf8)).children.first)

        XCTAssertEqual(child.lastUpdatedAt, "2026-07-20T10:00:00.000Z")
        XCTAssertEqual(child.updaterName, "Sotaro")
        XCTAssertEqual(child.updaterImage, "/api/attachments/by-key/user/sotarok.png")
    }

    /// A pre-extension server (no `lastUpdatedAt`/`updater` at all) — the
    /// exact AC-(1) degrade: decode still succeeds, metadata is `nil`.
    func testChildSegmentsFromAPreExtensionServerDegradeToNilMetadata() throws {
        let json = """
        { "children": [ { "segment": "eng", "path": "/team/eng/", "isPage": true, "hasPortal": false, "count": 0 } ] }
        """
        let child = try XCTUnwrap(ListPageChildrenResponseLenient.decode(Data(json.utf8)).children.first)

        XCTAssertNil(child.lastUpdatedAt)
        XCTAssertNil(child.updaterName)
        XCTAssertNil(child.updaterImage)
    }

    /// `updater: null` (contract: unresolvable updater — deleted user /
    /// legacy row) keeps the timestamp and drops only the updater fields.
    func testChildSegmentsWithNullUpdaterKeepTimestampOnly() throws {
        let json = """
        { "children": [ { "segment": "eng", "path": "/team/eng/", "isPage": true, "hasPortal": false, "count": 0, "lastUpdatedAt": "2026-07-20T10:00:00.000Z", "updater": null } ] }
        """
        let child = try XCTUnwrap(ListPageChildrenResponseLenient.decode(Data(json.utf8)).children.first)

        XCTAssertEqual(child.lastUpdatedAt, "2026-07-20T10:00:00.000Z")
        XCTAssertNil(child.updaterName)
        XCTAssertNil(child.updaterImage)
    }

    /// An OLD `CachedPageChildren` JSON blob — persisted BEFORE the metadata
    /// fields existed — must keep decoding through the exact seam
    /// `CachedPageChildren.children` uses (`JSONDecoder`), with the new
    /// optionals falling to `nil` (synthesized `decodeIfPresent`). This is
    /// what makes a `WorkspaceReadCacheSchema.schemaVersion` bump (and the
    /// §7.3 drop-and-rebuild it would trigger) unnecessary.
    func testOldCachedChildrenBlobWithoutMetadataFieldsStillDecodes() throws {
        let oldBlob = """
        [ { "segment": "eng", "path": "/team/eng/", "isPage": false, "hasPortal": true, "count": 3 } ]
        """
        let children = try JSONDecoder().decode([PageChildSegmentLenient].self, from: Data(oldBlob.utf8))

        XCTAssertEqual(children.first?.segment, "eng")
        XCTAssertEqual(children.first?.count, 3)
        XCTAssertNil(children.first?.lastUpdatedAt)
        XCTAssertNil(children.first?.updaterName)
        XCTAssertNil(children.first?.updaterImage)
    }

    /// And the NEW shape round-trips through the same Codable seam, so a
    /// freshly-written blob re-reads its metadata intact.
    func testNewChildrenBlobRoundTripsMetadataThroughCodable() throws {
        let original = try ListPageChildrenResponseLenient.decode(Data("""
        { "children": [ { "segment": "eng", "path": "/team/eng/", "isPage": false, "hasPortal": true, "count": 3, "lastUpdatedAt": "2026-07-20T10:00:00.000Z", "updater": { "name": "Sotaro", "image": "/img.png" } } ] }
        """.utf8)).children
        let reread = try JSONDecoder().decode([PageChildSegmentLenient].self, from: JSONEncoder().encode(original))

        XCTAssertEqual(reread, original)
        XCTAssertEqual(reread.first?.updaterName, "Sotaro")
    }

    // MARK: - feature-ios-design-language: list-row lastUpdateUser (3)

    func testListRowDecodesLastUpdateUserNameAndImage() throws {
        let json = """
        { "pages": [ { "_id": "p1", "path": "/team/eng", "revision": "r1", "updatedAt": "2026-07-20T10:00:00.000Z", "lastUpdateUser": { "_id": "u1", "username": "sotarok", "name": "Sotaro", "email": "s@example.com", "image": "/api/attachments/by-key/user/sotarok.png", "createdAt": "2026-01-01" } } ], "pager": { "prev": null, "next": null, "offset": 0 } }
        """
        let page = try XCTUnwrap(ListPagesResponseLenient.decode(Data(json.utf8)).pages.first)

        XCTAssertEqual(page.lastUpdateUserName, "Sotaro")
        XCTAssertEqual(page.lastUpdateUserImage, "/api/attachments/by-key/user/sotarok.png")
    }

    /// `lastUpdateUser` is a `string | PageUser` union (like `revision`) — a
    /// bare id string, `null`, or a missing field all degrade to `nil`.
    func testListRowWithBareStringOrMissingLastUpdateUserDegradesToNil() throws {
        let json = """
        { "pages": [ { "_id": "p1", "path": "/a", "lastUpdateUser": "u1" }, { "_id": "p2", "path": "/b", "lastUpdateUser": null }, { "_id": "p3", "path": "/c" } ], "pager": { "prev": null, "next": null, "offset": 0 } }
        """
        let pages = try ListPagesResponseLenient.decode(Data(json.utf8)).pages

        XCTAssertEqual(pages.count, 3)
        for page in pages {
            XCTAssertNil(page.lastUpdateUserName)
            XCTAssertNil(page.lastUpdateUserImage)
        }
    }

    /// The recency home passes `limit:` — pin the query the wire actually
    /// carries (path + limit, and NO sort override: the server default is
    /// already `updatedAt` desc, the order the home wants).
    func testListFetchSendsPathAndLimitQuery() async throws {
        let recorder = RequestPathRecorder()
        let client = makeMockedClient { request in
            recorder.capture(request)
            return (200, Data("{ \"pages\": [], \"pager\": { \"prev\": null, \"next\": null, \"offset\": 0 } }".utf8))
        }

        _ = try await ListPagesResponseLenient.fetch(path: "/", limit: 20, using: client)

        XCTAssertEqual(recorder.path, "/pages/list?path=/&limit=20")
    }

    /// Omitting `limit` keeps the request exactly as before this feature.
    func testListFetchWithoutLimitSendsOnlyPath() async throws {
        let recorder = RequestPathRecorder()
        let client = makeMockedClient { request in
            recorder.capture(request)
            return (200, Data("{ \"pages\": [], \"pager\": { \"prev\": null, \"next\": null, \"offset\": 0 } }".utf8))
        }

        _ = try await ListPagesResponseLenient.fetch(path: "/team", using: client)

        XCTAssertEqual(recorder.path, "/pages/list?path=/team")
    }

    // MARK: - Mocked-transport helpers (the `AuthenticatedAPIClientTests` shape)

    private struct MockTransport: ClientTransport {
        let handler: @Sendable (HTTPRequest) -> (Int, Data)

        func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
            let (status, data) = handler(request)
            return (HTTPResponse(status: .init(code: status)), HTTPBody(data))
        }
    }

    private func makeMockedClient(handler: @escaping @Sendable (HTTPRequest) -> (Int, Data)) -> AuthenticatedAPIClient {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
            URL(string: "https://wiki.example.com/api/oauth/token")!
        }
        return AuthenticatedAPIClient(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
            middleware: AuthenticatingMiddleware(coordinator: coordinator),
            transport: MockTransport(handler: handler)
        )
    }
}

/// Sequentially-driven request-path capture (`AuthenticatedAPIClientTests.CapturedRequestRecorder`'s
/// shape) — `@unchecked Sendable` for the same reason as there.
private final class RequestPathRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _path: String?

    func capture(_ request: HTTPRequest) {
        lock.lock()
        defer { lock.unlock() }
        _path = request.path
    }

    var path: String? {
        lock.lock()
        defer { lock.unlock() }
        return _path
    }
}
