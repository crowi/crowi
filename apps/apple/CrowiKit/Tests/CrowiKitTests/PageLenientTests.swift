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
}
