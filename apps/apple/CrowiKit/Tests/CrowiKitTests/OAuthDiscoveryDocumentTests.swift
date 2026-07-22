import XCTest

@testable import CrowiKit

/// Fixture mirrors the real shape returned by
/// `packages/api/src/hono/handlers/oauth.ts`'s `discoveryRoute` handler
/// (`:385-404`): `authorization_endpoint` is a web-origin page (no
/// `/api/v2`), `token_endpoint` / `device_authorization_endpoint` are under
/// `/api/v2` — same-origin only "in the default deployment", per that
/// handler's own comment. This spike models both live at
/// `http://localhost:4301` (this Phase 0 session's actual local dev host,
/// confirmed live via `curl http://localhost:4301/.well-known/oauth-authorization-server`),
/// so the fixture is representative, not invented.
final class OAuthDiscoveryDocumentTests: XCTestCase {
    private let fixture = """
    {
      "issuer": "http://localhost:4301",
      "authorization_endpoint": "http://localhost:4301/oauth/authorize",
      "token_endpoint": "http://localhost:4301/api/v2/oauth/token",
      "revocation_endpoint": "http://localhost:4301/api/v2/oauth/revoke",
      "device_authorization_endpoint": "http://localhost:4301/api/v2/oauth/device/authorize",
      "scopes_supported": ["pages:read", "pages:write"],
      "response_types_supported": ["code"],
      "grant_types_supported": ["authorization_code", "refresh_token"],
      "code_challenge_methods_supported": ["S256"],
      "token_endpoint_auth_methods_supported": ["none"]
    }
    """.data(using: .utf8)!

    func testDecodesAuthorizeAndTokenEndpointsSeparately() throws {
        let doc = try OAuthDiscoveryDocument.decode(fixture)
        // §4.1 step 0's load-bearing invariant: these must NOT be derived by
        // string-concatenating `apiBaseURL + "/oauth/..."` — they can differ,
        // and this spike's app-side model treats them as fully independent
        // fields resolved only from the discovery document.
        XCTAssertEqual(doc.authorizationEndpoint, URL(string: "http://localhost:4301/oauth/authorize"))
        XCTAssertEqual(doc.tokenEndpoint, URL(string: "http://localhost:4301/api/v2/oauth/token"))
        XCTAssertEqual(doc.revocationEndpoint, URL(string: "http://localhost:4301/api/v2/oauth/revoke"))
        XCTAssertEqual(doc.deviceAuthorizationEndpoint, URL(string: "http://localhost:4301/api/v2/oauth/device/authorize"))
    }

    func testIgnoresUnknownExtraFields() throws {
        // scopes_supported / response_types_supported / etc. are present in
        // the fixture and NOT modeled by OAuthDiscoveryDocument at all —
        // decoding must not fail because of them (lenient-decode policy).
        XCTAssertNoThrow(try OAuthDiscoveryDocument.decode(fixture))
    }

    func testMissingDeviceAuthorizationEndpointDoesNotFailTheWholeDecode() throws {
        let withoutDevice = """
        {
          "issuer": "http://localhost:4301",
          "authorization_endpoint": "http://localhost:4301/oauth/authorize",
          "token_endpoint": "http://localhost:4301/api/v2/oauth/token",
          "revocation_endpoint": "http://localhost:4301/api/v2/oauth/revoke"
        }
        """.data(using: .utf8)!
        let doc = try OAuthDiscoveryDocument.decode(withoutDevice)
        XCTAssertNil(doc.deviceAuthorizationEndpoint)
        XCTAssertEqual(doc.tokenEndpoint, URL(string: "http://localhost:4301/api/v2/oauth/token"))
    }

    func testMissingRequiredFieldThrows() {
        let malformed = """
        { "issuer": "http://localhost:4301" }
        """.data(using: .utf8)!
        XCTAssertThrowsError(try OAuthDiscoveryDocument.decode(malformed)) { error in
            XCTAssertEqual(error as? OAuthDiscoveryDocument.DecodeError, .malformed(field: "authorization_endpoint"))
        }
    }

    /// `revocation_endpoint` is resolved from discovery too (§4.2/§14's
    /// SignOutFlow reuse target) — a response missing it fails the same way
    /// a missing `token_endpoint` would, since `SignOutFlow` has no
    /// hardcoded `apiBaseURL + "/oauth/revoke"` fallback to fall back to.
    func testMissingRevocationEndpointThrows() {
        let withoutRevoke = """
        {
          "issuer": "http://localhost:4301",
          "authorization_endpoint": "http://localhost:4301/oauth/authorize",
          "token_endpoint": "http://localhost:4301/api/v2/oauth/token"
        }
        """.data(using: .utf8)!
        XCTAssertThrowsError(try OAuthDiscoveryDocument.decode(withoutRevoke)) { error in
            XCTAssertEqual(error as? OAuthDiscoveryDocument.DecodeError, .malformed(field: "revocation_endpoint"))
        }
    }

    /// Opportunistic live check against this Phase 0 session's actual local
    /// dev Crowi (confirmed running on :4301 while this spike was written —
    /// `curl http://localhost:4301/api/v2/app/info` returned a 200). Skips
    /// itself (rather than failing) when nothing is listening, so `swift
    /// test` in CI (no dev server) stays green — the mocked tests above are
    /// what CI actually gates on.
    func testLiveDiscoveryAgainstLocalDevIfAvailable() async throws {
        let workspaceOrigin = URL(string: "http://localhost:4301")!
        do {
            let doc = try await OAuthDiscoveryDocument.fetch(workspaceOrigin: workspaceOrigin)
            XCTAssertEqual(doc.authorizationEndpoint.path, "/oauth/authorize")
            XCTAssertEqual(doc.tokenEndpoint.path, "/api/v2/oauth/token")
        } catch {
            throw XCTSkip("no local dev Crowi reachable at \(workspaceOrigin) — skipping the live half of this spike (\(error))")
        }
    }
}
