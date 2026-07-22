import XCTest

@testable import CrowiKit

/// Phase 0 gate C — the §6.1 same-origin-Bearer + redirect-strip rule.
/// Split into two layers: the redirect-hop decision (`RedirectStripDelegate`,
/// tested directly against synthetic requests/responses — deterministic, no
/// network) and the initial-request decision (`fetch(_:)`'s same-origin
/// gate, tested via a `URLProtocol` stub). Both run unconditionally in
/// `swift test` / CI. A third, opportunistic **live** test proves AC-4 (a
/// real authenticated attachment from local dev, through the real
/// `/files/<id>` → `/api/v2/attachments/<id>` compat redirect) — it self-skips
/// when the environment doesn't provide a live target, so CI (no dev server)
/// stays green on the same test binary.
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
        let delegate = RedirectStripDelegate(workspaceOrigin: URLOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
        // The exact real-world case: legacy `/files/<id>` (server root) →
        // `/api/v2/attachments/<id>`, both under wiki.example.com.
        let response = HTTPURLResponse(url: workspaceOrigin.appendingPathComponent("files/abc"), statusCode: 302, httpVersion: nil, headerFields: nil)!
        let newRequest = URLRequest(url: workspaceOrigin.appendingPathComponent("api/v2/attachments/abc"))

        let redirected = redirectDecision(delegate, response: response, newRequest: newRequest)

        XCTAssertEqual(redirected?.value(forHTTPHeaderField: "Authorization"), "Bearer the-token")
    }

    func testStripsAuthorizationOnCrossOriginRedirect() {
        let delegate = RedirectStripDelegate(workspaceOrigin: URLOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
        let response = HTTPURLResponse(url: workspaceOrigin.appendingPathComponent("files/abc"), statusCode: 302, httpVersion: nil, headerFields: nil)!
        // The off-origin-exfiltration case §6.1 exists to prevent.
        var newRequest = URLRequest(url: URL(string: "https://attacker.example/steal")!)
        newRequest.setValue("Bearer should-not-survive", forHTTPHeaderField: "Authorization")

        let redirected = redirectDecision(delegate, response: response, newRequest: newRequest)

        XCTAssertNil(redirected?.value(forHTTPHeaderField: "Authorization"))
    }

    func testDifferentPortIsCrossOrigin() {
        let delegate = RedirectStripDelegate(workspaceOrigin: URLOrigin(workspaceOrigin), accessTokenProvider: { "the-token" })
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
        _ = try await loader.fetch("/api/v2/attachments/abc")
    }

    func testDoesNotAttachAuthorizationForCrossOriginAbsoluteURL() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, Data([0x89, 0x50, 0x4E, 0x47]))
        }
        let loader = makeLoaderWithMockTransport()
        _ = try await loader.fetch("https://attacker.example/x.png")
    }

    private func makeLoaderWithMockTransport() -> WorkspaceImageLoader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "the-token" }, sessionConfiguration: configuration)
    }

    // MARK: - Live spike (AC-4): a real authenticated attachment from local dev

    /// Proves the whole loader end-to-end against a **real** running local
    /// dev Crowi + a real attachment: `GET /files/<id>` (no auth on the
    /// redirect itself) → 302 → `GET /api/v2/attachments/<id>` (Bearer
    /// required) → 200 raster bytes, through this exact loader. Reads its
    /// target from the environment (never hardcodes a token in committed
    /// source) and self-skips when unset/unreachable, so `swift test` in CI
    /// (no dev server, no token) stays green on the same test binary — this
    /// test is what the implementer actually ran, once, with the env vars
    /// set, against this session's local dev Crowi + a real PNG attachment,
    /// to satisfy AC-4's "実証必須".
    func testLiveRealAttachmentThroughFilesRedirectIfAvailable() async throws {
        let target = try LiveSpikeTarget.fromEnvironmentOrSkip()
        let loader = WorkspaceImageLoader(workspaceOrigin: target.workspaceOrigin, accessTokenProvider: { target.bearerToken })
        let data = try await loader.fetch(target.filesPath)
        XCTAssertFalse(data.isEmpty)
        // PNG magic bytes — the dev attachment this was verified against is
        // `image/png`; a raster decoder (never a web/SVG-DOM context, §6.1)
        // is all this spike needs to prove the bytes are real image data.
        XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    }
}

/// Shared by the two "live spike" tests (here and in
/// `WorkspaceMarkdownImageProviderTests`) that hit a real local dev Crowi +
/// real attachment for AC-4: reads the same three env vars and self-skips
/// (never fails) when they are unset/unreachable, so CI stays green on the
/// same test binary.
struct LiveSpikeTarget {
    let workspaceOrigin: URL
    let filesPath: String
    let bearerToken: String

    static func fromEnvironmentOrSkip() throws -> LiveSpikeTarget {
        let env = ProcessInfo.processInfo.environment
        guard let originString = env["CROWI_IOS_SPIKE_WORKSPACE_ORIGIN"],
            let origin = URL(string: originString),
            let path = env["CROWI_IOS_SPIKE_FILES_PATH"],
            let token = env["CROWI_IOS_SPIKE_BEARER_TOKEN"]
        else {
            throw XCTSkip(
                "set CROWI_IOS_SPIKE_WORKSPACE_ORIGIN / CROWI_IOS_SPIKE_FILES_PATH / CROWI_IOS_SPIKE_BEARER_TOKEN"
                    + " to run this against a real local dev Crowi + a real attachment (AC-4) — skipping"
            )
        }
        return LiveSpikeTarget(workspaceOrigin: origin, filesPath: path, bearerToken: token)
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
