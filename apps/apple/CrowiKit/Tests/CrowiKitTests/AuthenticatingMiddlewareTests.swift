import HTTPTypes
import OpenAPIRuntime
import XCTest

@testable import CrowiKit

/// RFC-0016 §5.1 — `AuthenticatingMiddleware`: attaches
/// `Authorization: Bearer <accessToken>` to every request, and on a live
/// `401` forces a REACTIVE refresh (via `RefreshCoordinator`) then retries
/// exactly once with the newly-refreshed token.
final class AuthenticatingMiddlewareTests: XCTestCase {
    /// Records every `next(...)` invocation's Authorization header —
    /// `@unchecked Sendable` because this test drives the middleware
    /// strictly sequentially (no concurrent `next` calls), so the lack of a
    /// provable data-race-free capture is acceptable here.
    private final class Recorder: @unchecked Sendable {
        var authorizationHeaders: [String?] = []
    }

    private func makeRequest() -> HTTPRequest {
        HTTPRequest(method: .get, scheme: "https", authority: "wiki.example.com", path: "/api/v2/pages")
    }

    func testAttachesBearerTokenToTheRequest() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "original-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let (urlSession, requestRecorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: urlSession) {
            URL(string: "https://wiki.example.com/api/v2/oauth/token")!
        }
        let middleware = AuthenticatingMiddleware(coordinator: coordinator)
        let recorder = Recorder()

        let (response, _) = try await middleware.intercept(makeRequest(), body: nil, baseURL: URL(string: "https://wiki.example.com/api/v2")!, operationID: "listPages") { request, body, baseURL in
            recorder.authorizationHeaders.append(request.headerFields[.authorization])
            return (HTTPResponse(status: .ok), nil)
        }

        XCTAssertEqual(response.status.code, 200)
        XCTAssertEqual(recorder.authorizationHeaders, ["Bearer original-token"])
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 0, "a still-fresh token must not trigger a proactive refresh")
        XCTAssertEqual(requestRecorder.requests.count, 0, "a still-fresh token must never hit the token endpoint")
    }

    func testRetriesExactlyOnceAfterA401WithARefreshedToken() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "original-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let (urlSession, requestRecorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: urlSession) {
            URL(string: "https://wiki.example.com/api/v2/oauth/token")!
        }
        let middleware = AuthenticatingMiddleware(coordinator: coordinator)
        let recorder = Recorder()

        let (response, _) = try await middleware.intercept(makeRequest(), body: nil, baseURL: URL(string: "https://wiki.example.com/api/v2")!, operationID: "listPages") { request, body, baseURL in
            let header = request.headerFields[.authorization]
            recorder.authorizationHeaders.append(header)
            if header == "Bearer original-token" {
                return (HTTPResponse(status: .unauthorized), nil)
            }
            return (HTTPResponse(status: .ok), nil)
        }

        XCTAssertEqual(response.status.code, 200)
        XCTAssertEqual(recorder.authorizationHeaders, ["Bearer original-token", "Bearer refreshed-token"])
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 1, "the reactive backstop refreshes exactly once, not on every retry")
        XCTAssertEqual(requestRecorder.requests.count, 1, "the token endpoint must receive exactly one refresh submission over the wire")
    }

    /// Reproduces the delayed-401 race directly through
    /// `AuthenticatingMiddleware` (not just the coordinator in isolation, as
    /// the two above do): two concurrent requests both carry the SAME
    /// still-locally-fresh access token, both eventually receive a live
    /// `401`, but the SECOND caller's `401` is only handled AFTER the FIRST
    /// caller's entire `401 -> refresh -> retry` cycle has already
    /// completed (`secondCallerGate` pins this ordering deterministically).
    /// Before the fix, the second caller's reactive backstop would refresh
    /// again with the by-then-already-rotated refresh token — exactly the
    /// double-presentation that trips the server's `revokeChain`
    /// reuse-detection and kills the whole workspace.
    func testDelayed401FromASecondConcurrentRequestDoesNotDoubleRefresh() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "original-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let (urlSession, requestRecorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: urlSession) {
            URL(string: "https://wiki.example.com/api/v2/oauth/token")!
        }
        let middleware = AuthenticatingMiddleware(coordinator: coordinator)
        let secondCallerGate = Gate()

        async let first: (HTTPResponse, HTTPBody?) = middleware.intercept(
            makeRequest(), body: nil, baseURL: URL(string: "https://wiki.example.com/api/v2")!, operationID: "listPages"
        ) { request, _, _ in
            let header = request.headerFields[.authorization]
            if header == "Bearer original-token" {
                return (HTTPResponse(status: .unauthorized), nil)
            }
            // The first caller's retry has now succeeded with the
            // refreshed token — only now may the second caller's (delayed)
            // 401 be handled.
            await secondCallerGate.open()
            return (HTTPResponse(status: .ok), nil)
        }

        async let second: (HTTPResponse, HTTPBody?) = middleware.intercept(
            makeRequest(), body: nil, baseURL: URL(string: "https://wiki.example.com/api/v2")!, operationID: "listPages"
        ) { request, _, _ in
            let header = request.headerFields[.authorization]
            if header == "Bearer original-token" {
                await secondCallerGate.wait()
                return (HTTPResponse(status: .unauthorized), nil)
            }
            return (HTTPResponse(status: .ok), nil)
        }

        let (firstResponse, _) = try await first
        let (secondResponse, _) = try await second

        XCTAssertEqual(firstResponse.status.code, 200)
        XCTAssertEqual(secondResponse.status.code, 200)
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 1, "the delayed second 401 must reuse the already-refreshed token, not refresh again")
        XCTAssertEqual(requestRecorder.requests.count, 1, "the token endpoint must receive exactly one refresh submission over the wire, even with a delayed second 401")
    }
}
