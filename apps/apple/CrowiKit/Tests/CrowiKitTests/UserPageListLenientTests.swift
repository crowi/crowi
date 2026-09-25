import Foundation
import XCTest

@testable import CrowiKit

/// The profile's two page lists: pages a user bookmarked, and pages they
/// created.
final class UserPageListLenientTests: XCTestCase {
    func testBookmarksUnwrapTheirPages() throws {
        let json = """
            { "bookmarks": [
                { "_id": "b1", "page": { "_id": "p1", "path": "/a" }, "user": "u1", "createdAt": "2026-09-01T00:00:00.000Z" },
                { "_id": "b2", "page": { "_id": "p2", "path": "/b" }, "user": "u1", "createdAt": "2026-09-02T00:00:00.000Z" }
              ], "pager": { "prev": null, "next": 30, "offset": 0 }, "total": 45 }
            """
        let response = try UserPageListResponseLenient.decode(Data(json.utf8), kind: .bookmarks)

        XCTAssertEqual(response.pages.map(\.path), ["/a", "/b"])
        XCTAssertEqual(response.total, 45)
        XCTAssertEqual(response.nextOffset, 30)
    }

    /// A bookmark whose page is gone carries no page object; it is skipped,
    /// not decoded into a blank row.
    func testABookmarkWithoutAPageIsSkipped() throws {
        let json = """
            { "bookmarks": [ { "_id": "b1", "page": null, "user": "u1", "createdAt": "x" }, { "_id": "b2", "page": { "_id": "p2", "path": "/b" } } ],
              "pager": { "prev": null, "next": null, "offset": 0 }, "total": 2 }
            """
        let response = try UserPageListResponseLenient.decode(Data(json.utf8), kind: .bookmarks)

        XCTAssertEqual(response.pages.map(\.id), ["p2"])
    }

    func testCreatedPagesDecodeTheirRows() throws {
        let json = """
            { "pages": [ { "_id": "p1", "path": "/user/sotarok/memo", "contentType": "artifact" } ],
              "pager": { "prev": null, "next": null, "offset": 0 }, "total": 1 }
            """
        let response = try UserPageListResponseLenient.decode(Data(json.utf8), kind: .created)

        XCTAssertEqual(response.pages.map(\.path), ["/user/sotarok/memo"])
        XCTAssertEqual(response.pages.first?.displayedContentType, .artifact)
        XCTAssertNil(response.nextOffset, "the last slice ends the list")
    }

    func testFetchAsksForTheKindsEndpointWithItsPage() async throws {
        let recorder = WireRecorder()
        let body = Data(#"{ "pages": [], "pager": { "prev": null, "next": null, "offset": 30 }, "total": 30 }"#.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, body) }

        _ = try await UserPageListResponseLenient.fetch(username: "sotarok", kind: .created, limit: 30, offset: 30, using: client)
        _ = try await UserPageListResponseLenient.fetch(username: "sotarok", kind: .bookmarks, limit: 30, offset: 0, using: client)

        let requests = recorder.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].method, .get)
        XCTAssertEqual(requests[0].path, "/user/sotarok/pages?limit=30&offset=30")
        XCTAssertEqual(requests[1].path, "/user/sotarok/bookmarks?limit=30&offset=0")
    }

    func testAnUnknownUserIsA404() async {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (404, Data(#"{ "error": { "code": "USER_NOT_FOUND" } }"#.utf8)) }

        do {
            _ = try await UserPageListResponseLenient.fetch(username: "ghost", kind: .bookmarks, limit: 30, offset: 0, using: client)
            XCTFail("expected a 404")
        } catch {
            XCTAssertEqual(error as? ProfileLenientDecodeError, .httpError(status: 404))
        }
    }
}
