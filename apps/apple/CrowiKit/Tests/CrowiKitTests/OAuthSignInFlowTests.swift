import XCTest

@testable import CrowiKit

/// RFC-0016 §4.1 — the real sign-in flow that replaces the deleted Phase 0
/// `GateASpike.swift`: authorize-URL construction (AC-4's "scope 集合"
/// single source), callback parsing + state verification, and the
/// form-encoded token exchange (gate B's finding that the generated client
/// has no usable `Input` for `/oauth/token`).
final class OAuthSignInFlowTests: XCTestCase {
    private let discovery = OAuthDiscoveryDocument(
        issuer: URL(string: "https://wiki.example.com")!,
        authorizationEndpoint: URL(string: "https://wiki.example.com/oauth/authorize")!,
        tokenEndpoint: URL(string: "https://wiki.example.com/api/v2/oauth/token")!,
        revocationEndpoint: URL(string: "https://wiki.example.com/api/v2/oauth/revoke")!,
        deviceAuthorizationEndpoint: nil
    )

    // MARK: - makeAuthorizeURL

    func testAuthorizeURLCarriesTheSingleSourceScopeAndPKCEFields() {
        let url = OAuthSignInFlow.makeAuthorizeURL(discovery: discovery, codeChallenge: "the-challenge", state: "the-state")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        func value(_ name: String) -> String? {
            components.queryItems?.first(where: { $0.name == name })?.value
        }
        XCTAssertEqual(components.host, "wiki.example.com")
        XCTAssertEqual(components.path, "/oauth/authorize")
        XCTAssertEqual(value("response_type"), "code")
        XCTAssertEqual(value("client_id"), OAuthSignInFlow.clientID)
        XCTAssertEqual(value("redirect_uri"), OAuthSignInFlow.redirectURI)
        XCTAssertEqual(value("scope"), OAuthSignInFlow.requestedScope)
        XCTAssertEqual(value("state"), "the-state")
        XCTAssertEqual(value("code_challenge"), "the-challenge")
        XCTAssertEqual(value("code_challenge_method"), "S256")
    }

    /// AC-4 pin: every scope a Phase 1/1.5/2/3 endpoint needs is present, so
    /// the app never hits `403 INSUFFICIENT_SCOPE`.
    func testRequestedScopeCoversEveryPhaseScopeCategory() {
        let scopes = Set(OAuthSignInFlow.requestedScope.split(separator: " ").map(String.init))
        for expected in ["pages:read", "pages:write", "comments:read", "comments:write", "bookmarks:read", "bookmarks:write", "attachments:read", "notifications:read", "notifications:write", "profile:read"] {
            XCTAssertTrue(scopes.contains(expected), "missing scope: \(expected)")
        }
    }

    // MARK: - parseCallback

    func testParseCallbackExtractsCodeAndState() throws {
        let (code, state) = try OAuthSignInFlow.parseCallback(URL(string: "crowi-ios://callback?code=abc123&state=xyz")!)
        XCTAssertEqual(code, "abc123")
        XCTAssertEqual(state, "xyz")
    }

    func testParseCallbackThrowsWhenCodeMissing() {
        XCTAssertThrowsError(try OAuthSignInFlow.parseCallback(URL(string: "crowi-ios://callback?state=xyz")!)) { error in
            XCTAssertEqual(error as? OAuthSignInFlow.SignInError, .malformedCallback)
        }
    }

    // MARK: - signIn(discovery:presentSession:) — the full flow, mocked transport

    func testSignInSucceedsAndExchangesCodeForTokens() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url, self.discovery.tokenEndpoint)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
            let bodyString = String(data: self.bodyData(of: request), encoding: .utf8) ?? ""
            XCTAssertTrue(bodyString.contains("grant_type=authorization_code"))
            XCTAssertTrue(bodyString.contains("client_id=crowi-ios"))
            let responseBody = """
            { "access_token": "at-1", "refresh_token": "crowi_rt_1", "expires_in": 3600, "token_type": "Bearer", "scope": "pages:read" }
            """.data(using: .utf8)!
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, responseBody)
        }

        var capturedAuthorizeURL: URL?
        let tokens = try await OAuthSignInFlow.signIn(
            discovery: discovery,
            presentSession: { authorizeURL in
                capturedAuthorizeURL = authorizeURL
                let state = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)!
                    .queryItems!.first(where: { $0.name == "state" })!.value!
                return URL(string: "crowi-ios://callback?code=the-code&state=\(state)")!
            },
            urlSession: MockURLProtocol.makeSession()
        )

        XCTAssertNotNil(capturedAuthorizeURL)
        XCTAssertEqual(tokens.accessToken, "at-1")
        XCTAssertEqual(tokens.refreshToken, "crowi_rt_1")
        XCTAssertGreaterThan(tokens.expiresAt, Date())
    }

    func testSignInThrowsOnStateMismatch() async {
        let unusedURLSession = MockURLProtocol.makeSession()
        do {
            _ = try await OAuthSignInFlow.signIn(
                discovery: discovery,
                presentSession: { _ in URL(string: "crowi-ios://callback?code=the-code&state=wrong-state")! },
                urlSession: unusedURLSession
            )
            XCTFail("expected a state-mismatch error")
        } catch OAuthSignInFlow.SignInError.stateMismatch {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// `URLSession` sometimes moves a request's body into `httpBodyStream`
    /// by the time `URLProtocol.startLoading()` sees it (rather than
    /// leaving it in `httpBody`) — this reads whichever is populated so the
    /// assertion above is robust to either.
    private func bodyData(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
