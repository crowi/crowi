import XCTest

@testable import CrowiKit

final class WorkspaceLinkRouterTests: XCTestCase {
    private let origin = URL(string: "https://wiki.almoha.net")!

    private func link(_ string: String) -> WorkspaceInternalLink? {
        WorkspaceLinkRouter.internalLink(for: URL(string: string)!, workspaceOrigin: origin)
    }

    func testAbsoluteLinkToTheWorkspaceIsAPagePath() {
        XCTAssertEqual(link("https://wiki.almoha.net/Survey/2026/07/23/report"), .pagePath("/Survey/2026/07/23/report"))
    }

    func testAShareURLIsAPageId() {
        XCTAssertEqual(link("https://wiki.almoha.net/6a7567cb7fb9c4c95f9b3603"), .pageId("6a7567cb7fb9c4c95f9b3603"))
    }

    func testAnotherSiteIsNotInternal() {
        XCTAssertNil(link("https://example.com/6a7567cb7fb9c4c95f9b3603"))
        XCTAssertNil(link("https://wiki.almoha.net.evil.example/page"))
        XCTAssertNil(link("http://wiki.almoha.net/page"))
    }

    func testHostCaseAndDefaultPortAreTheSameOrigin() {
        XCTAssertEqual(link("https://WIKI.ALMOHA.NET/page"), .pagePath("/page"))
        XCTAssertEqual(link("https://wiki.almoha.net:443/page"), .pagePath("/page"))
    }

    func testANonDefaultPortIsADifferentOrigin() {
        XCTAssertNil(link("https://wiki.almoha.net:8443/page"))
    }

    func testAPercentEncodedPathArrivesDecoded() {
        XCTAssertEqual(
            link("https://wiki.almoha.net/Survey/%E5%89%8A%E9%99%A4%E4%BE%9D%E9%A0%BC"),
            .pagePath("/Survey/削除依頼")
        )
    }

    func testTheOriginItselfIsItsTopPage() {
        XCTAssertEqual(link("https://wiki.almoha.net/"), .pagePath("/"))
    }

    func testOnlyASingleSegmentOfExactlyTwentyFourHexIsAnId() {
        // A real page can sit at a top-level path; only the ObjectId shape
        // is claimed.
        XCTAssertEqual(WorkspaceLinkRouter.internalLink(forPath: "/releases"), .pagePath("/releases"))
        XCTAssertEqual(
            WorkspaceLinkRouter.internalLink(forPath: "/6a7567cb7fb9c4c95f9b360"),
            .pagePath("/6a7567cb7fb9c4c95f9b360")
        )
        XCTAssertEqual(
            WorkspaceLinkRouter.internalLink(forPath: "/notes/6a7567cb7fb9c4c95f9b3603"),
            .pagePath("/notes/6a7567cb7fb9c4c95f9b3603")
        )
        XCTAssertEqual(
            WorkspaceLinkRouter.internalLink(forPath: "/6a7567cb7fb9c4c95f9b360g"),
            .pagePath("/6a7567cb7fb9c4c95f9b360g")
        )
    }
}
