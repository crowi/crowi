import XCTest

@testable import CrowiKit

/// The examples in `feature-relative-wiki-link-resolution`, pinned.
final class WikiPathResolverTests: XCTestCase {
    private let source = "/X/logs/page"

    func testTheSpecsWorkedExamples() {
        // dir = /X/logs/
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "sibling"), "/X/logs/sibling")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "./sibling"), "/X/logs/sibling")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: ".."), "/X/")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "../.."), "/")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "../sibling"), "/X/sibling")
    }

    func testAPortalPageIsItsOwnDirectory() {
        // Taking the parent of `/X/logs/` would land a sibling a level too high.
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: "/X/logs/", ref: "sibling"), "/X/logs/sibling")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: "/X/logs/", ref: ".."), "/X/")
    }

    func testTheReportedLink() {
        // The link that sent the reader to "Couldn't load this page".
        XCTAssertEqual(
            WikiPathResolver.resolve(
                sourcePath: "/Weall/dev/memo/2026/08/18/weall-skill-family改善監査",
                ref: "./spec転記経路の2つの穴"
            ),
            "/Weall/dev/memo/2026/08/18/spec転記経路の2つの穴"
        )
    }

    func testAbsoluteRefsPassThrough() {
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "/abs/page"), "/abs/page")
    }

    func testClimbingPastTheRootStops() {
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "../../../../.."), "/")
    }

    func testExternalRefsAreLeftAlone() {
        for ref in ["https://example.com", "http://x", "//example.com", "mailto:a@b.c", "#anchor", ""] {
            XCTAssertTrue(WikiPathResolver.isExternalRef(ref), ref)
            XCTAssertNil(WikiPathResolver.resolve(sourcePath: source, ref: ref), ref)
        }
    }

    func testTheSchemeGrammarDoesNotSwallowAnOrdinaryPath() {
        // "contains a colon" would wrongly reject this.
        XCTAssertFalse(WikiPathResolver.isExternalRef("a/b:c"))
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "a/b:c"), "/X/logs/a/b:c")
    }

    func testAColonNamedPageNeedsTheExplicitPrefixTheSpecDocuments() {
        // Bare reads as a scheme and is external; `./` can never match the
        // grammar, so it resolves.
        XCTAssertNil(WikiPathResolver.resolve(sourcePath: source, ref: "Q1:plan"))
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "./Q1:plan"), "/X/logs/Q1:plan")
    }

    func testARefEndingInASlashIsADirectory() {
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "sub/"), "/X/logs/sub/")
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "sub"), "/X/logs/sub")
    }

    func testPlusStaysAPlus() {
        // Crowi paths are real-space; URL semantics would read `+` as a space.
        XCTAssertEqual(WikiPathResolver.resolve(sourcePath: source, ref: "./a+b"), "/X/logs/a+b")
    }
}
