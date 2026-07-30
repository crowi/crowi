import XCTest

@testable import CrowiKit

/// Phase 0 gate B — proves the generated client (swift-openapi-generator
/// against the real, in-tree `packages/api-contract/openapi.json`) is
/// buildable and produces usable `Input`/path values for the spec's three
/// representative operations.
final class GeneratedClientSmokeTests: XCTestCase {
    func testClientConstructsAgainstApiBaseURL() {
        // §3's load-bearing distinction: `apiBaseURL`, NOT bare
        // `workspaceOrigin` — the spec's `servers` entry already carries
        // `/api` while operation paths are bare.
        let apiBaseURL = URL(string: "https://wiki.example.com/api")!
        _ = GeneratedClientSmoke.makeClient(apiBaseURL: apiBaseURL)
        // No throw / no crash constructing the client is the assertion —
        // there is nothing else observable at construction time.
    }

    func testAppInfoInputIsTrivial() {
        // GET /app/info takes no query/path params — Input is essentially
        // just headers, confirming this operation's generated shape is
        // immediately usable with no per-call configuration.
        _ = GeneratedClientSmoke.appInfoInput()
    }

    func testPagesInputCarriesThePathQueryParam() {
        let input = GeneratedClientSmoke.pagesInput(path: "/onboarding")
        XCTAssertEqual(input.query.path, "/onboarding")
        XCTAssertNil(input.query.page_id)
        XCTAssertNil(input.query.revision_id)
    }

    /// Phase 0 finding (documented on `GeneratedClientSmoke.tokenInputHasNoBody`):
    /// `POST /oauth/token`'s generated `Input` has no body property at all,
    /// because the server contract intentionally declares no request body
    /// (it hand-parses form-urlencoded OR JSON). This is asserted here so a
    /// future swift-openapi-generator upgrade that changes this shape is
    /// caught, at which point gate A's token-exchange code (hand-written
    /// `URLRequest`, not this generated client) should be revisited.
    func testTokenInputHasNoBodyGapIsStillPresent() {
        XCTAssertTrue(GeneratedClientSmoke.tokenInputHasNoBody())
    }
}
