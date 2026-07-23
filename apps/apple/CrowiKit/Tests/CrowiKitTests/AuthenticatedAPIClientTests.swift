import HTTPTypes
import OpenAPIRuntime
import XCTest

@testable import CrowiKit

/// RFC-0016 §5.1 — `AuthenticatedAPIClient` is the ONE per-workspace
/// authenticated-fetch primitive every hand-written `*Lenient` decoder is
/// built on (`feature-ios-phase1-read`'s reuse note: "phase-2 is its first
/// real consumer" of `AuthenticatingMiddleware`). These tests exercise it
/// directly (composing `AuthenticatingMiddleware` with a mock `ClientTransport`,
/// never `URLSessionTransport`) so a regression in the composition itself —
/// not just in a single screen's decoder — is caught here.
final class AuthenticatedAPIClientTests: XCTestCase {
    private struct MockTransport: ClientTransport {
        let handler: @Sendable (HTTPRequest, HTTPBody?, URL, String) async throws -> (HTTPResponse, HTTPBody?)

        func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
            try await handler(request, body, baseURL, operationID)
        }
    }

    private func makeClient(handler: @escaping @Sendable (HTTPRequest) -> (Int, Data)) -> AuthenticatedAPIClient {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
            URL(string: "https://wiki.example.com/api/v2/oauth/token")!
        }
        let transport = MockTransport { request, _, _, _ in
            let (status, data) = handler(request)
            return (HTTPResponse(status: .init(code: status)), HTTPBody(data))
        }
        return AuthenticatedAPIClient(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
            middleware: AuthenticatingMiddleware(coordinator: coordinator),
            transport: transport
        )
    }

    func testGetAttachesBearerAndReturnsTheRawBodyAndStatus() async throws {
        let recorder = CapturedRequestRecorder()
        let client = makeClient { request in
            recorder.capture(request)
            return (200, Data("""
                { "ok": true }
                """.utf8))
        }

        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "path", value: "/team/eng")])

        XCTAssertEqual(status, 200)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{ \"ok\": true }")
        XCTAssertEqual(recorder.authorization, "Bearer the-token")
        // `/` is a legal, non-percent-encoded character in a URL query
        // component (RFC 3986) — `URLComponents` correctly leaves it as-is.
        XCTAssertEqual(recorder.path, "/pages?path=/team/eng")
    }

    func testGetReturnsANon2xxStatusWithoutThrowing() async throws {
        let client = makeClient { _ in (503, Data("""
            { "error": { "code": "SERVICE_UNAVAILABLE" } }
            """.utf8)) }

        let (data, status) = try await client.get("search", query: [URLQueryItem(name: "q", value: "eng")])

        XCTAssertEqual(status, 503)
        XCTAssertFalse(data.isEmpty, "the caller (e.g. the search screen) needs the raw body even on a non-2xx status")
    }

    func testGetWithNoQueryBuildsABarePath() async throws {
        let recorder = CapturedRequestRecorder()
        let client = makeClient { request in
            recorder.capture(request)
            return (200, Data())
        }

        _ = try await client.get("me")

        XCTAssertEqual(recorder.path, "/me")
    }
}

/// A minimal, lock-protected capture for a request's `path`/`Authorization`
/// header, driven strictly sequentially by these tests (never concurrently)
/// — `@unchecked Sendable` for the same reason `AuthenticatingMiddlewareTests.Recorder` is.
private final class CapturedRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _path: String?
    private var _authorization: String?

    func capture(_ request: HTTPRequest) {
        lock.lock()
        defer { lock.unlock() }
        _path = request.path
        _authorization = request.headerFields[.authorization]
    }

    var path: String? {
        lock.lock()
        defer { lock.unlock() }
        return _path
    }

    var authorization: String? {
        lock.lock()
        defer { lock.unlock() }
        return _authorization
    }
}
