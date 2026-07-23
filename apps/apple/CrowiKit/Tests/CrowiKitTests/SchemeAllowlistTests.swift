import XCTest

@testable import CrowiKit

/// RFC-0016 §6.2 CI-fixed invariant — `javascript:`/`data:`/`crowi-ios://`
/// (and any other custom scheme) are inert; only `http(s)` and a
/// workspace-relative (scheme-less) reference are active.
final class SchemeAllowlistTests: XCTestCase {
    func testHTTPAndHTTPSAreAllowed() {
        XCTAssertTrue(SchemeAllowlist.isAllowed(URL(string: "http://example.com")!))
        XCTAssertTrue(SchemeAllowlist.isAllowed(URL(string: "https://example.com/a/b")!))
    }

    func testWorkspaceRelativeReferenceIsAllowed() {
        XCTAssertTrue(SchemeAllowlist.isAllowed(URL(string: "/some/page")!))
        XCTAssertTrue(SchemeAllowlist.isAllowed("/some/page"))
    }

    func testJavascriptSchemeIsInert() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "javascript:alert(1)")!))
    }

    func testDataSchemeIsInert() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "data:text/html,<script>alert(1)</script>")!))
    }

    /// Load-bearing: the app's OWN OAuth-callback scheme must be inerted by
    /// the exact same rule as any other custom scheme — a wiki body
    /// containing `[x](crowi-ios://callback?code=…)` must never be tappable.
    func testTheAppsOwnCrowiIOSSchemeIsInert() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "crowi-ios://callback?code=abc&state=xyz")!))
    }

    func testFileSchemeIsInert() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "file:///etc/passwd")!))
    }

    func testTelAndMailtoAreInertInV1() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "tel:+15551234567")!))
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "mailto:a@example.com")!))
    }

    func testAnyOtherCustomSchemeIsInert() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(URL(string: "some-other-app://deeplink")!))
    }

    func testUnparseableStringFailsClosed() {
        XCTAssertFalse(SchemeAllowlist.isAllowed(""))
    }
}
