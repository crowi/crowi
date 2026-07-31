import XCTest

@testable import CrowiKit

/// RFC-0016 §3 — `WorkspaceOrigin` (the relocated/renamed Phase 0 `URLOrigin`)
/// and `APIBaseURL`, the two distinct newtypes §3 requires. `WorkspaceImageLoaderTests`
/// already covers the origin-equality behavior these two types share with
/// the Phase 0 spike; this file covers the Phase 1 additions: user-input
/// normalization and the `apiBaseURL = workspaceOrigin + "/api"` derivation.
final class WorkspaceOriginTests: XCTestCase {
    func testNormalizeAddsHTTPSSchemeWhenNoneGiven() {
        let origin = WorkspaceOrigin.normalize(userInput: "wiki.example.com")
        XCTAssertEqual(origin?.scheme, "https")
        XCTAssertEqual(origin?.host, "wiki.example.com")
    }

    func testNormalizePreservesExplicitScheme() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://localhost:4301")
        XCTAssertEqual(origin?.scheme, "http")
        XCTAssertEqual(origin?.host, "localhost")
        XCTAssertEqual(origin?.port, 4301)
    }

    func testNormalizeTrimsWhitespace() {
        let origin = WorkspaceOrigin.normalize(userInput: "  wiki.example.com  ")
        XCTAssertEqual(origin?.host, "wiki.example.com")
    }

    func testNormalizeRejectsEmptyInput() {
        XCTAssertNil(WorkspaceOrigin.normalize(userInput: "   "))
    }

    func testNormalizeRejectsInputWithNoHost() {
        XCTAssertNil(WorkspaceOrigin.normalize(userInput: "https://"))
    }

    func testIsExemptLocalHost() {
        XCTAssertTrue(WorkspaceOrigin(URL(string: "http://localhost")!).isExemptLocalHost)
        XCTAssertTrue(WorkspaceOrigin(URL(string: "http://127.0.0.1")!).isExemptLocalHost)
        XCTAssertTrue(WorkspaceOrigin(URL(string: "http://my-mac.local")!).isExemptLocalHost)
        XCTAssertFalse(WorkspaceOrigin(URL(string: "http://example.com")!).isExemptLocalHost)
    }

    // MARK: - Page (browser) URLs — Share / Copy Link

    /// The reader's Share and Copy Link hand out the page's BROWSER url —
    /// `<origin>/<path>`, not an `/api/v2` one.
    func testPageURLIsTheBrowserURLForThePath() {
        let origin = WorkspaceOrigin(URL(string: "https://wiki.example.com")!)
        XCTAssertEqual(
            origin.pageURL(forPath: "/crowi/rfc/0023")?.absoluteString,
            "https://wiki.example.com/crowi/rfc/0023"
        )
    }

    /// Crowi paths are routinely non-ASCII. Pasting one straight into
    /// `URL(string:)` returns `nil`, which would silently mean no share sheet
    /// at all on exactly the pages this product is full of.
    func testPageURLPercentEncodesANonASCIIPath() {
        let origin = WorkspaceOrigin(URL(string: "https://wiki.example.com")!)
        let url = origin.pageURL(forPath: "/user/sotarok/日報/2026/05/23")

        XCTAssertEqual(url?.absoluteString, "https://wiki.example.com/user/sotarok/%E6%97%A5%E5%A0%B1/2026/05/23")
        XCTAssertNotNil(url)
    }

    /// A non-default port belongs in the shared link (a dev/self-hosted
    /// workspace on `:4301` is otherwise unreachable), and a path arriving
    /// without its leading slash still resolves against the origin root
    /// rather than being dropped.
    func testPageURLKeepsANonDefaultPortAndTolerAtesAMissingLeadingSlash() {
        let origin = WorkspaceOrigin(URL(string: "http://localhost:4301")!)
        XCTAssertEqual(origin.pageURL(forPath: "notes/today")?.absoluteString, "http://localhost:4301/notes/today")
    }

    // MARK: - APIBaseURL

    func testAPIBaseURLAppendsAPIV2ToOrigin() {
        let origin = WorkspaceOrigin(URL(string: "https://wiki.example.com")!)
        let apiBaseURL = APIBaseURL(workspaceOrigin: origin)
        XCTAssertEqual(apiBaseURL.url.absoluteString, "https://wiki.example.com/api")
    }

    func testAPIBaseURLAppendingBuildsFullPath() {
        let origin = WorkspaceOrigin(URL(string: "https://wiki.example.com")!)
        let apiBaseURL = APIBaseURL(workspaceOrigin: origin)
        XCTAssertEqual(apiBaseURL.appending("app/info").absoluteString, "https://wiki.example.com/api/app/info")
    }

    func testAPIBaseURLDropsNonDefaultPortOnlyWhenPresent() {
        let origin = WorkspaceOrigin(URL(string: "http://localhost:4301")!)
        let apiBaseURL = APIBaseURL(workspaceOrigin: origin)
        XCTAssertEqual(apiBaseURL.url.absoluteString, "http://localhost:4301/api")
    }
}
