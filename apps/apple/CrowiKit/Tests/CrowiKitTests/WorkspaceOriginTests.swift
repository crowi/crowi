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
