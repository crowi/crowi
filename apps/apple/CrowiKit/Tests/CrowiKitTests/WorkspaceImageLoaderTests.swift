import XCTest

@testable import CrowiKit

/// Phase 0 gate C — the §6.1 same-origin-Bearer + redirect-strip rule.
/// Split into two layers: the redirect-hop decision (`RedirectStripDelegate`,
/// tested directly against synthetic requests/responses — deterministic, no
/// network) and the initial-request decision (`fetch(_:)`'s same-origin
/// gate, tested via a `URLProtocol` stub). Both run unconditionally in
/// `swift test` / CI. AC-4 itself (a real authenticated attachment from
/// local dev, through the real `/files/<id>` → `/api/attachments/<id>`
/// compat redirect) was proven live once against this loader during Phase 0
/// — see `feature-ios-phase0-gates.md`'s "Gate 判定" section for that
/// evidence; it is not re-run as a permanently environment-gated test here
/// because `swift test` must be unconditionally green (no skips) on every
/// invocation, including CI, where no such live target ever exists.
final class WorkspaceImageLoaderTests: XCTestCase {
    private let workspaceOrigin = URL(string: "https://wiki.example.com")!

    // MARK: - Redirect-hop decision (RedirectStripDelegate)

    private func makeTask() -> URLSessionTask {
        // A `URLSessionTask` the delegate callback signature requires but
        // never inspects — constructed via a throwaway session, never resumed.
        URLSession(configuration: .ephemeral).dataTask(with: URL(string: "https://placeholder.invalid")!)
    }

    /// Drives `delegate.urlSession(_:task:willPerformHTTPRedirection:...)`'s
    /// completion-handler callback to completion and returns the request it
    /// passed — shared by the three redirect-hop tests below, which differ
    /// only in the response/newRequest they feed in and the assertion after.
    private func redirectDecision(_ delegate: RedirectStripDelegate, response: HTTPURLResponse, newRequest: URLRequest) -> URLRequest? {
        let expectation = expectation(description: "redirect decision")
        var redirected: URLRequest?
        delegate.urlSession(.shared, task: makeTask(), willPerformHTTPRedirection: response, newRequest: newRequest) { request in
            redirected = request
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1)
        return redirected
    }

    func testPreservesAuthorizationOnSameOriginRedirect() {
        let delegate = RedirectStripDelegate(workspaceOrigin: WorkspaceOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
        // The exact real-world case: legacy `/files/<id>` (server root) →
        // `/api/attachments/<id>`, both under wiki.example.com.
        let response = HTTPURLResponse(url: workspaceOrigin.appendingPathComponent("files/abc"), statusCode: 302, httpVersion: nil, headerFields: nil)!
        let newRequest = URLRequest(url: workspaceOrigin.appendingPathComponent("api/attachments/abc"))

        let redirected = redirectDecision(delegate, response: response, newRequest: newRequest)

        XCTAssertEqual(redirected?.value(forHTTPHeaderField: "Authorization"), "Bearer the-token")
    }

    func testStripsAuthorizationOnCrossOriginRedirect() {
        let delegate = RedirectStripDelegate(workspaceOrigin: WorkspaceOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
        let response = HTTPURLResponse(url: workspaceOrigin.appendingPathComponent("files/abc"), statusCode: 302, httpVersion: nil, headerFields: nil)!
        // The off-origin-exfiltration case §6.1 exists to prevent.
        var newRequest = URLRequest(url: URL(string: "https://attacker.example/steal")!)
        newRequest.setValue("Bearer should-not-survive", forHTTPHeaderField: "Authorization")

        let redirected = redirectDecision(delegate, response: response, newRequest: newRequest)

        XCTAssertNil(redirected?.value(forHTTPHeaderField: "Authorization"))
    }

    func testDifferentPortIsCrossOrigin() {
        let delegate = RedirectStripDelegate(workspaceOrigin: WorkspaceOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
        let response = HTTPURLResponse(url: workspaceOrigin, statusCode: 302, httpVersion: nil, headerFields: nil)!
        let newRequest = URLRequest(url: URL(string: "https://wiki.example.com:8443/x")!)

        let redirected = redirectDecision(delegate, response: response, newRequest: newRequest)

        XCTAssertNil(redirected?.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - Initial-request decision (fetch(_:)'s same-origin gate)

    func testAttachesAuthorizationForSameOriginRelativePath() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer the-token")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, Data([0x89, 0x50, 0x4E, 0x47]))
        }
        let loader = makeLoaderWithMockTransport()
        _ = try await loader.fetch("/api/attachments/abc")
    }

    func testDoesNotAttachAuthorizationForCrossOriginAbsoluteURL() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, Data([0x89, 0x50, 0x4E, 0x47]))
        }
        let loader = makeLoaderWithMockTransport()
        _ = try await loader.fetch("https://attacker.example/x.png")
    }

    // MARK: - §6.2 scheme allowlist (shared with the openURL interceptor)

    /// The exact §6.2 belt-and-suspenders case: a page body's `<img>` (or
    /// `![alt](…)`) pointing at the app's own `crowi-ios://` OAuth-callback
    /// scheme, or any other custom scheme, must never even reach the
    /// network — rejected at the SAME `SchemeAllowlist` the link interceptor
    /// consumes, not merely left to fail as an accident of `URLSession`'s
    /// own unknown-scheme handling.
    func testDisallowedCustomSchemeThrowsBeforeAnyNetworkRequest() async {
        let recorder = RequestRecorder()
        MockURLProtocol.requestHandler = { request in
            recorder.record(request)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }
        let loader = makeLoaderWithMockTransport()

        await XCTAssertThrowsErrorAsync(try await loader.fetch("crowi-ios://callback?code=abc")) { error in
            XCTAssertEqual(error as? WorkspaceImageLoader.LoaderError, .disallowedScheme)
        }
        XCTAssertTrue(recorder.requests.isEmpty, "a disallowed scheme must never reach the network layer")
    }

    func testJavascriptSchemeIsAlsoDisallowed() async {
        let loader = makeLoaderWithMockTransport()

        await XCTAssertThrowsErrorAsync(try await loader.fetch("javascript:alert(1)")) { error in
            XCTAssertEqual(error as? WorkspaceImageLoader.LoaderError, .disallowedScheme)
        }
    }

    private func makeLoaderWithMockTransport() -> WorkspaceImageLoader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "the-token" }, sessionConfiguration: configuration)
    }
}

/// A minimal request-recording `URLProtocol` stub — no real network I/O.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

extension MockURLProtocol {
    /// The `URLSessionConfiguration.ephemeral` + `protocolClasses` wiring
    /// every test that drives a request through this stub otherwise repeats
    /// verbatim — factored out so it is declared exactly once.
    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// A session pre-wired to answer the token endpoint with a canned
    /// successful refresh response (`access_token: "refreshed-token"`,
    /// `refresh_token: "crowi_rt_next"`, `expires_in: 3600`), paired with the
    /// `RequestRecorder` capturing every request it actually served —
    /// `AuthenticatingMiddlewareTests` and `RefreshCoordinatorSingleFlightTests`
    /// both need exactly this fixture (the AC-5 "token endpoint received
    /// exactly N submissions" assertion), so it is declared once here rather
    /// than duplicated per file.
    static func makeRefreshingSession() -> (URLSession, RequestRecorder) {
        let recorder = RequestRecorder()
        requestHandler = { request in
            recorder.record(request)
            let body = """
            { "access_token": "refreshed-token", "refresh_token": "crowi_rt_next", "expires_in": 3600 }
            """.data(using: .utf8)!
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        return (makeSession(), recorder)
    }
}
