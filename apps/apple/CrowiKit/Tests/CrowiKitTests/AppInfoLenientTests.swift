import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2 / §3 add-flow step 2 — the exact scenario the strict
/// generated response type cannot survive: an old host that omits
/// `capabilities` must degrade to the static baseline, not throw.
final class AppInfoLenientTests: XCTestCase {
    func testFullResponseDecodesAsIs() throws {
        let data = """
        {
          "title": "Crowi DEV2",
          "confidential": null,
          "version": "2.0.0-alpha.7",
          "apiVersion": "v2",
          "capabilities": ["oauth", "pages", "search"],
          "canSelfRegister": false
        }
        """.data(using: .utf8)!
        let info = try AppInfoLenient.decode(data)
        XCTAssertEqual(info.title, "Crowi DEV2")
        XCTAssertNil(info.confidential)
        XCTAssertEqual(info.version, "2.0.0-alpha.7")
        XCTAssertEqual(info.capabilities, ["oauth", "pages", "search"])
        XCTAssertFalse(info.capabilitiesAreBaselineFallback)
    }

    /// The exact case a **strict** decode through the generated
    /// `Operations.get_sol_app_sol_info.Output` cannot handle: `capabilities`
    /// is a required, non-optional field there
    /// (confirmed empirically against the real generated `Types.swift`
    /// during this Phase 0 spike), so an old host's response would throw.
    func testMissingCapabilitiesDegradesToStaticBaseline() throws {
        let data = """
        {
          "title": "Old Crowi",
          "version": "1.9.0",
          "apiVersion": "v2"
        }
        """.data(using: .utf8)!
        let info = try AppInfoLenient.decode(data)
        XCTAssertEqual(info.capabilities, StaticCapabilities.baseline)
        XCTAssertTrue(info.capabilitiesAreBaselineFallback)
    }

    func testUnknownExtraFieldIsIgnored() throws {
        let data = """
        {
          "version": "2.1.0",
          "apiVersion": "v2",
          "capabilities": ["oauth"],
          "canSelfRegister": true,
          "aFieldThisBuildHasNeverHeardOf": { "nested": [1, 2, 3] }
        }
        """.data(using: .utf8)!
        XCTAssertNoThrow(try AppInfoLenient.decode(data))
    }

    func testConfidentialStringIsSurfaced() throws {
        let data = """
        {
          "confidential": "Internal use only — do not screenshot",
          "version": "2.1.0",
          "apiVersion": "v2",
          "capabilities": ["oauth"],
          "canSelfRegister": false
        }
        """.data(using: .utf8)!
        let info = try AppInfoLenient.decode(data)
        XCTAssertEqual(info.confidential, "Internal use only — do not screenshot")
    }

    func testNonObjectRootThrows() {
        let data = "[1, 2, 3]".data(using: .utf8)!
        XCTAssertThrowsError(try AppInfoLenient.decode(data)) { error in
            XCTAssertEqual(error as? AppInfoLenient.DecodeError, .notAnObject)
        }
    }

    // MARK: - looksLikeCrowiHost (§3 add-flow "non-Crowi host" rejection)

    func testLooksLikeCrowiHostIsTrueWhenVersionPresent() throws {
        let data = """
        { "version": "2.0.0", "apiVersion": "v2", "capabilities": ["oauth"] }
        """.data(using: .utf8)!
        XCTAssertTrue(try AppInfoLenient.decode(data).looksLikeCrowiHost)
    }

    /// The exact fixture `AddWorkspaceFlowTests` uses for "reject a
    /// non-Crowi host": a JSON object with no `version` key at all (unlike
    /// the missing-`capabilities` case above, which still degrades and
    /// succeeds).
    func testLooksLikeCrowiHostIsFalseWhenVersionMissing() throws {
        let data = """
        { "title": "Some Other JSON API", "capabilities": ["oauth"] }
        """.data(using: .utf8)!
        XCTAssertFalse(try AppInfoLenient.decode(data).looksLikeCrowiHost)
    }

    // MARK: - fetch(apiBaseURL:)

    func testFetchDecodesA200Response() async throws {
        let apiBaseURL = APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!))
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://wiki.example.com/api/app/info")
            let body = """
            { "version": "2.0.0", "apiVersion": "v2", "capabilities": ["oauth"] }
            """.data(using: .utf8)!
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        let info = try await AppInfoLenient.fetch(apiBaseURL: apiBaseURL, urlSession: MockURLProtocol.makeSession())
        XCTAssertEqual(info.version, "2.0.0")
    }

    func testFetchThrowsOnNon2xxStatus() async throws {
        let apiBaseURL = APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!))
        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, Data())
        }
        do {
            _ = try await AppInfoLenient.fetch(apiBaseURL: apiBaseURL, urlSession: MockURLProtocol.makeSession())
            XCTFail("expected fetch to throw on a 503")
        } catch AppInfoLenient.DecodeError.httpError(let status) {
            XCTAssertEqual(status, 503)
        }
    }

    /// Opportunistic live check against this Phase 0 session's actual local
    /// dev Crowi. Skips (never fails) when unreachable — see
    /// `OAuthDiscoveryDocumentTests`'s twin for the same rationale.
    func testLiveAppInfoAgainstLocalDevIfAvailable() async throws {
        let url = URL(string: "http://localhost:4301/api/app/info")!
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(from: url)
        } catch {
            throw XCTSkip("no local dev Crowi reachable at \(url) — skipping the live half of this spike (\(error))")
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw XCTSkip("local dev Crowi at \(url) did not return 200 — skipping")
        }
        let info = try AppInfoLenient.decode(data)
        XCTAssertNotNil(info.version)
        XCTAssertFalse(info.capabilities.isEmpty)
    }
}
