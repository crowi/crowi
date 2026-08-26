import XCTest

@testable import CrowiKit

/// RFC-0016 §3 step 1 / §14 — the CI-fixed HTTPS gate invariant: a
/// cleartext `http://example.com` origin is refused before any network call;
/// `http://localhost` (and the other narrow local/dev exemptions) is allowed.
final class HTTPSGateTests: XCTestCase {
    func testRejectsPlainHTTPPublicHost() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://example.com")!
        XCTAssertThrowsError(try AddWorkspaceFlow.assertHTTPSGate(origin)) { error in
            XCTAssertEqual(error as? AddWorkspaceFlow.AddWorkspaceError, .insecureOrigin(origin))
        }
    }

    func testAllowsPlainHTTPLocalhost() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://localhost")!
        XCTAssertNoThrow(try AddWorkspaceFlow.assertHTTPSGate(origin))
    }

    func testAllowsPlainHTTPLoopbackIP() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://127.0.0.1")!
        XCTAssertNoThrow(try AddWorkspaceFlow.assertHTTPSGate(origin))
    }

    func testAllowsPlainHTTPDotLocalHost() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://my-mac.local")!
        XCTAssertNoThrow(try AddWorkspaceFlow.assertHTTPSGate(origin))
    }

    func testAlwaysAllowsHTTPS() {
        let origin = WorkspaceOrigin.normalize(userInput: "https://example.com")!
        XCTAssertNoThrow(try AddWorkspaceFlow.assertHTTPSGate(origin))
    }

    func testRejectsPlainHTTPWithNonDefaultPortOnAPublicHost() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://wiki.example.com:8080")!
        XCTAssertThrowsError(try AddWorkspaceFlow.assertHTTPSGate(origin))
    }

    /// Developer Mode's per-host exemption — matched on host only, same
    /// granularity as the built-in `localhost`/`127.0.0.1`/`*.local` set.
    func testAllowsPlainHTTPOnAHostInTheAllowedSet() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://10.0.1.4:4304")!
        XCTAssertNoThrow(try AddWorkspaceFlow.assertHTTPSGate(origin, allowedInsecureHosts: ["10.0.1.4"]))
    }

    func testStillRejectsAHostNotInTheAllowedSet() {
        let origin = WorkspaceOrigin.normalize(userInput: "http://10.0.1.9:4304")!
        XCTAssertThrowsError(try AddWorkspaceFlow.assertHTTPSGate(origin, allowedInsecureHosts: ["10.0.1.4"]))
    }
}
