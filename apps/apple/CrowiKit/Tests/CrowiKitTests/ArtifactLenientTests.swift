import Foundation
import SwiftData
import XCTest

@testable import CrowiKit

/// RFC-0020 HTML artifact pages: which pages the reader must hand to the
/// sandboxed web view instead of the Markdown renderer, how the signed
/// delivery URL is minted, and what that web view may navigate to.
final class ArtifactLenientTests: XCTestCase {
    private func detailJSON(pageContentType: String? = nil, revisionContentType: String? = nil) -> Data {
        let pageField = pageContentType.map { #", "contentType": "\#($0)""# } ?? ""
        let revisionField = revisionContentType.map { #", "contentType": "\#($0)""# } ?? ""
        return Data("""
            { "page": { "_id": "p1", "path": "/reports/q3", "revision": { "_id": "r1", "body": "<!doctype html><html></html>"\(revisionField) }\(pageField) } }
            """.utf8)
    }

    // MARK: - Which pages are artifacts

    func testArtifactRevisionIsDisplayedAsAnArtifact() throws {
        let page = try GetPageResponseLenient.decode(detailJSON(pageContentType: "artifact", revisionContentType: "artifact")).page

        XCTAssertEqual(page.displayedContentType, .artifact)
    }

    /// A server that predates RFC-0020 sends neither field.
    func testMissingContentTypeIsMarkdown() throws {
        let page = try GetPageResponseLenient.decode(detailJSON()).page

        XCTAssertNil(page.contentType)
        XCTAssertNil(page.revision?.contentType)
        XCTAssertEqual(page.displayedContentType, .markdown)
    }

    /// The page-level field is only a hint copied from the current revision;
    /// the revision a reader is actually shown decides.
    func testRevisionContentTypeWinsOverThePageHint() throws {
        let page = try GetPageResponseLenient.decode(detailJSON(pageContentType: "artifact", revisionContentType: "markdown")).page

        XCTAssertEqual(page.displayedContentType, .markdown)
    }

    /// A list row carries a bare revision id, so the hint is all there is.
    func testListRowFallsBackToThePageHint() throws {
        let json = """
            { "pages": [ { "_id": "p1", "path": "/reports/q3", "revision": "r1", "contentType": "artifact" } ], "pager": { "prev": null, "next": null, "offset": 0 } }
            """
        let page = try XCTUnwrap(ListPagesResponseLenient.decode(Data(json.utf8)).pages.first)

        XCTAssertNil(page.revision?.contentType)
        XCTAssertEqual(page.displayedContentType, .artifact)
    }

    func testUnrecognizedContentTypeIsMarkdown() throws {
        let page = try GetPageResponseLenient.decode(detailJSON(revisionContentType: "slides")).page

        XCTAssertEqual(page.displayedContentType, .markdown)
    }

    func testSingleRevisionReadCarriesItsContentType() throws {
        let json = """
            { "revision": { "_id": "r0", "body": "<!doctype html><html></html>", "contentType": "artifact" } }
            """
        let revision = try GetRevisionResponseLenient.decode(Data(json.utf8)).revision

        XCTAssertEqual(revision.contentType, .artifact)
    }

    // MARK: - Tree rows

    func testChildSegmentMarksAnArtifactLeafPage() throws {
        let json = """
            { "children": [
              { "segment": "q3", "path": "/reports/q3/", "isPage": true, "hasPortal": false, "count": 0, "contentType": "artifact" },
              { "segment": "q2", "path": "/reports/q2/", "isPage": true, "hasPortal": false, "count": 0, "contentType": "markdown" },
              { "segment": "old", "path": "/reports/old/", "isPage": false, "hasPortal": false, "count": 2, "contentType": "artifact" }
            ] }
            """
        let children = try ListPageChildrenResponseLenient.decode(Data(json.utf8)).children

        XCTAssertEqual(children.map(\.isArtifactPage), [true, false, false], "only a segment that IS a page can be an artifact page")
    }

    /// A `CachedPageChildren` blob written before the field existed.
    func testOldCachedChildrenBlobWithoutContentTypeStillDecodes() throws {
        let oldBlob = """
            [ { "segment": "q3", "path": "/reports/q3/", "isPage": true, "hasPortal": false, "count": 0 } ]
            """
        let children = try JSONDecoder().decode([PageChildSegmentLenient].self, from: Data(oldBlob.utf8))

        XCTAssertNil(children.first?.contentType)
        XCTAssertEqual(children.first?.isArtifactPage, false)
    }

    // MARK: - Read cache

    @MainActor
    func testCachedPageRoundTripKeepsTheArtifactKind() throws {
        let container = try ModelContainer(for: CachedPage.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let context = ModelContext(container)

        CachedPage.upsert(from: try GetPageResponseLenient.decode(detailJSON(pageContentType: "artifact", revisionContentType: "artifact")).page, in: context)
        let repainted = try XCTUnwrap(CachedPage.cached(path: "/reports/q3", in: context)).asPageLenient

        XCTAssertEqual(repainted.displayedContentType, .artifact, "a cold paint must not render the HTML source as Markdown")
    }

    /// A list row upserted after the detail read carries no revision kind;
    /// that must not erase the kind the detail read stored.
    @MainActor
    func testUpsertWithoutAnyKindKeepsTheStoredKind() throws {
        let container = try ModelContainer(for: CachedPage.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let context = ModelContext(container)

        CachedPage.upsert(from: try GetPageResponseLenient.decode(detailJSON(revisionContentType: "artifact")).page, in: context)
        CachedPage.upsert(from: PageLenient(id: "p1", path: "/reports/q3", revision: nil, status: nil, commentCount: nil, likerCount: nil, seenUsersCount: nil, updatedAt: nil, liker: nil), in: context)

        XCTAssertEqual(CachedPage.cached(pageId: "p1", in: context)?.asPageLenient.displayedContentType, .artifact)
    }

    // MARK: - Minting the delivery URL

    func testMintPostsTheDisplayedRevisionAndReturnsTheURL() async throws {
        let recorder = WireRecorder()
        let body = Data(#"{ "url": "https://artifacts.example.com/api/artifact/p1/r1?t=tok", "expiresAt": "2026-09-18T00:01:00.000Z" }"#.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, body) }

        let outcome = try await ArtifactURLMint.mint(pageId: "p1", revisionId: "r1", using: client)

        XCTAssertEqual(outcome, .ready(URL(string: "https://artifacts.example.com/api/artifact/p1/r1?t=tok")!))
        XCTAssertEqual(recorder.requests.count, 1)
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/pages/p1/artifact-url")
        XCTAssertEqual(request.jsonObject?["revisionId"] as? String, "r1")
    }

    /// The server's request schema is strict, so an absent revision must be
    /// an absent key, not `null`.
    func testMintWithoutARevisionSendsAnEmptyObject() async throws {
        let recorder = WireRecorder()
        let body = Data(#"{ "url": "https://artifacts.example.com/api/artifact/p1/r1?t=tok" }"#.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, body) }

        _ = try await ArtifactURLMint.mint(pageId: "p1", revisionId: nil, using: client)

        XCTAssertEqual(recorder.requests.first?.jsonObject?.isEmpty, true)
    }

    func testDeliveryNotConfiguredIsItsOwnOutcome() {
        let body = Data(#"{ "error": { "code": "ARTIFACT_URL_UNAVAILABLE", "reason": "ARTIFACT_DELIVERY_NOT_CONFIGURED", "message": "x" } }"#.utf8)

        XCTAssertEqual(ArtifactURLMint.outcome(status: 422, data: body), .deliveryDisabled)
    }

    func testNotAnArtifactIsItsOwnOutcome() {
        let body = Data(#"{ "error": { "code": "ARTIFACT_URL_UNAVAILABLE", "reason": "NOT_AN_ARTIFACT", "message": "x" } }"#.utf8)

        XCTAssertEqual(ArtifactURLMint.outcome(status: 400, data: body), .notAnArtifact)
    }

    func testOtherFailuresKeepTheirStatus() {
        XCTAssertEqual(ArtifactURLMint.outcome(status: 404, data: Data(#"{ "error": { "code": "PAGE_NOT_FOUND" } }"#.utf8)), .failed(status: 404))
        XCTAssertEqual(ArtifactURLMint.outcome(status: 500, data: Data()), .failed(status: 500))
    }

    /// Only an http(s) URL is something the web view should be pointed at.
    func testSuccessWithoutAUsableURLIsAFailure() {
        XCTAssertEqual(ArtifactURLMint.outcome(status: 200, data: Data("{}".utf8)), .failed(status: 200))
        XCTAssertEqual(ArtifactURLMint.outcome(status: 200, data: Data(#"{ "url": "javascript:alert(1)" }"#.utf8)), .failed(status: 200))
        XCTAssertEqual(ArtifactURLMint.outcome(status: 200, data: Data(#"{ "url": "/api/artifact/p1/r1?t=tok" }"#.utf8)), .failed(status: 200))
    }

    // MARK: - What the web view may navigate to

    private let delivery = URL(string: "https://artifacts.example.com/api/artifact/p1/r1?t=tok")!

    func testTheDeliveredDocumentLoads() {
        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: delivery, deliveryURL: delivery, isMainFrame: true, isLinkActivation: false), .allow)
    }

    func testAFragmentJumpInsideTheDocumentIsAllowed() {
        let anchor = URL(string: "https://artifacts.example.com/api/artifact/p1/r1?t=tok#summary")!

        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: anchor, deliveryURL: delivery, isMainFrame: true, isLinkActivation: true), .allow)
    }

    func testWebKitsNormalizationOfTheSameURLIsStillTheSameDocument() {
        let normalized = URL(string: "https://ARTIFACTS.example.com:443/api/artifact/p1/r1?t=tok")!

        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: normalized, deliveryURL: delivery, isMainFrame: true, isLinkActivation: false), .allow)
    }

    func testATappedLinkOpensOutsideTheArtifact() {
        let external = URL(string: "https://example.org/docs")!

        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: external, deliveryURL: delivery, isMainFrame: true, isLinkActivation: true), .openExternally(external))
    }

    /// The document must not replace itself with anything else — not from
    /// script, not with another token, not with another revision.
    func testTheDocumentCannotNavigateItselfAway() {
        let elsewhere = [
            URL(string: "https://example.org/phish")!,
            URL(string: "https://artifacts.example.com/api/artifact/p1/r0?t=other")!,
            URL(string: "https://artifacts.example.com/api/artifact/p1/r1?t=tok2")!,
        ]
        for url in elsewhere {
            XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: url, deliveryURL: delivery, isMainFrame: true, isLinkActivation: false), .cancel, url.absoluteString)
        }
    }

    func testNonWebSchemesAreNeverFollowed() {
        for raw in ["javascript:alert(1)", "data:text/html,hi", "tel:123", "mailto:a@example.com"] {
            let url = URL(string: raw)!
            XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: url, deliveryURL: delivery, isMainFrame: true, isLinkActivation: true), .cancel, raw)
        }
    }

    func testSubframesNeverLoadTheDocument() {
        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: delivery, deliveryURL: delivery, isMainFrame: false, isLinkActivation: false), .cancel)
    }

    func testSchemeDowngradeIsNotTheSameDocument() {
        let downgraded = URL(string: "http://artifacts.example.com/api/artifact/p1/r1?t=tok")!

        XCTAssertEqual(ArtifactNavigationPolicy.decide(requestURL: downgraded, deliveryURL: delivery, isMainFrame: true, isLinkActivation: false), .cancel)
    }
}
