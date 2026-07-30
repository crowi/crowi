import XCTest

@testable import CrowiKit

/// RFC-0016 §3 add-flow — the CI-fixed "lenient probe" invariants: a
/// capabilities-missing fixture degrades to the static baseline and the
/// add succeeds; a version-missing fixture is rejected as non-Crowi. Plus
/// the minimum-version gate's `tooOld` refusal and the HTTPS gate's
/// short-circuit (never probes an insecure origin at all).
final class AddWorkspaceFlowTests: XCTestCase {
    private static let neverCalledPresentSession: @Sendable (URL) async throws -> URL = { _ in
        XCTFail("presentSession should not be reached")
        throw URLError(.unknown)
    }

    func testCapabilitiesMissingFixtureDegradesAndAddSucceeds() async throws {
        let fixture = """
        { "title": "Old Crowi", "version": "9.9.9" }
        """.data(using: .utf8)!

        let onboarded = try await AddWorkspaceFlow.addWorkspace(
            userInput: "https://wiki.example.com",
            probe: { _ in try AppInfoLenient.decode(fixture) },
            presentSession: { authorizeURL in
                let state = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)!
                    .queryItems!.first(where: { $0.name == "state" })!.value!
                return URL(string: "crowi-ios://callback?code=the-code&state=\(state)")!
            },
            floor: "2.0.0",
            urlSession: Self.mockTokenExchangeSession()
        )

        XCTAssertEqual(onboarded.workspaceOrigin.host, "wiki.example.com")
        XCTAssertEqual(onboarded.displayTitle, "Old Crowi")
        XCTAssertEqual(onboarded.tokens.accessToken, "at-1")
    }

    func testVersionMissingFixtureIsRejectedAsNonCrowi() async {
        let fixture = """
        { "title": "Some Other JSON API", "capabilities": ["oauth"] }
        """.data(using: .utf8)!

        do {
            _ = try await AddWorkspaceFlow.addWorkspace(
                userInput: "https://not-a-crowi.example.com",
                probe: { _ in try AppInfoLenient.decode(fixture) },
                presentSession: Self.neverCalledPresentSession
            )
            XCTFail("expected notACrowiHost")
        } catch AddWorkspaceFlow.AddWorkspaceError.notACrowiHost {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testHostBelowTheFloorIsRefused() async {
        let fixture = """
        { "version": "1.0.0", "capabilities": ["oauth"] }
        """.data(using: .utf8)!

        do {
            _ = try await AddWorkspaceFlow.addWorkspace(
                userInput: "https://ancient.example.com",
                probe: { _ in try AppInfoLenient.decode(fixture) },
                presentSession: Self.neverCalledPresentSession,
                floor: "2.0.0"
            )
            XCTFail("expected tooOld")
        } catch AddWorkspaceFlow.AddWorkspaceError.tooOld(let hostVersion, let floor) {
            XCTAssertEqual(hostVersion, "1.0.0")
            XCTAssertEqual(floor, "2.0.0")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// The HTTPS gate must short-circuit BEFORE the probe — a plain-`http`
    /// public host is refused without ever calling `probe`.
    func testInsecureOriginNeverReachesTheProbe() async {
        do {
            _ = try await AddWorkspaceFlow.addWorkspace(
                userInput: "http://example.com",
                probe: { _ in
                    XCTFail("probe should not be reached for an insecure origin")
                    throw URLError(.unknown)
                },
                presentSession: Self.neverCalledPresentSession
            )
            XCTFail("expected insecureOrigin")
        } catch AddWorkspaceFlow.AddWorkspaceError.insecureOrigin {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testUnreachableHostSurfacesAsHostUnreachable() async {
        do {
            _ = try await AddWorkspaceFlow.addWorkspace(
                userInput: "https://wiki.example.com",
                probe: { _ in throw URLError(.cannotConnectToHost) },
                presentSession: Self.neverCalledPresentSession
            )
            XCTFail("expected hostUnreachable")
        } catch AddWorkspaceFlow.AddWorkspaceError.hostUnreachable {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testInvalidURLInputIsRejected() async {
        do {
            _ = try await AddWorkspaceFlow.addWorkspace(userInput: "   ", presentSession: Self.neverCalledPresentSession)
            XCTFail("expected invalidURL")
        } catch AddWorkspaceFlow.AddWorkspaceError.invalidURL {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// `addWorkspace`'s sign-in step fetches BOTH the discovery document AND
    /// the token endpoint through the same injected `urlSession` — this
    /// fixture branches on path so both legs get a shape-appropriate
    /// response.
    private static func mockTokenExchangeSession() -> URLSession {
        MockURLProtocol.requestHandler = { request in
            let path = request.url?.path ?? ""
            let body: Data
            if path.contains(".well-known/oauth-authorization-server") {
                body = """
                {
                  "issuer": "https://wiki.example.com",
                  "authorization_endpoint": "https://wiki.example.com/oauth/authorize",
                  "token_endpoint": "https://wiki.example.com/api/oauth/token",
                  "revocation_endpoint": "https://wiki.example.com/api/oauth/revoke"
                }
                """.data(using: .utf8)!
            } else {
                body = """
                { "access_token": "at-1", "refresh_token": "crowi_rt_1", "expires_in": 3600 }
                """.data(using: .utf8)!
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        return MockURLProtocol.makeSession()
    }
}
