import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// RFC-0016 §5.1 read-phase consumer — `feature-ios-phase1-read`'s "every
/// new per-workspace API call goes through `AuthenticatingMiddleware` +
/// `RefreshCoordinator`, never a bare unauthenticated `URLSession`" reuse
/// note. This is the ONE per-workspace authenticated-fetch primitive every
/// hand-written lenient decoder (`PageLenient`, `SearchLenient`, …) builds
/// on, composing:
///   - `AuthenticatingMiddleware` (Phase 1) — proactive + reactive
///     single-flight `401`→refresh→retry, and
///   - `OpenAPIURLSession.URLSessionTransport` — the SAME `ClientTransport`
///     swift-openapi-generator's own generated `Client` uses under the hood,
///
/// so the auth-injection contract is exercised exactly once at this one
/// seam, not re-implemented per screen.
///
/// Deliberately NOT built on the swift-openapi-generator's per-operation
/// generated `Client` methods: those decode the response through the
/// strict, generated `Output` type, which is precisely the seam
/// `AppInfoLenient`'s doc comment pins as wrong for *responses* (a host that
/// omits an optional field, or one running a newer/older Crowi version,
/// must degrade — not throw). Composing the middleware directly over
/// `ClientTransport` keeps the request/transport machinery (auth injection,
/// redirect following) while leaving response decoding entirely to each
/// screen's own hand-written `*Lenient` decoder, which reads the raw bytes
/// this type hands back.
public struct AuthenticatedAPIClient: Sendable {
    private let apiBaseURL: APIBaseURL
    private let middleware: AuthenticatingMiddleware
    private let transport: any ClientTransport
    private let maxResponseBytes: Int

    public init(
        apiBaseURL: APIBaseURL,
        middleware: AuthenticatingMiddleware,
        transport: any ClientTransport = URLSessionTransport(),
        maxResponseBytes: Int = 16 * 1024 * 1024
    ) {
        self.apiBaseURL = apiBaseURL
        self.middleware = middleware
        self.transport = transport
        self.maxResponseBytes = maxResponseBytes
    }

    /// `GET {apiBaseURL}/<path>?<query>` — returns the raw response bytes
    /// plus the HTTP status for the caller's own lenient decoder to
    /// interpret (some screens branch on a non-2xx status themselves, e.g.
    /// the §5.2 `search` capability's `503 { feature: 'search' }`), so this
    /// method never throws on a non-2xx response itself — only on a genuine
    /// transport failure (no network, DNS, etc).
    public func get(_ path: String, query: [URLQueryItem] = []) async throws -> (data: Data, status: Int) {
        let request = HTTPRequest(method: .get, scheme: nil, authority: nil, path: Self.encodedPathAndQuery(path: path, query: query))
        let (response, responseBody) = try await middleware.intercept(
            request, body: nil, baseURL: apiBaseURL.url, operationID: path
        ) { request, body, baseURL in
            try await transport.send(request, body: body, baseURL: baseURL, operationID: path)
        }
        guard let responseBody else {
            return (Data(), response.status.code)
        }
        let data = try await Data(collecting: responseBody, upTo: maxResponseBytes)
        return (data, response.status.code)
    }

    /// Builds `/<path>?<percent-encoded query>` — the exact shape
    /// `URLSessionTransport`'s own `HTTPRequest -> URLRequest` conversion
    /// expects (it reads `request.path` through `URLComponents(string:)`'s
    /// `percentEncodedPath`/`percentEncodedQuery`), so query values are
    /// percent-encoded here rather than string-concatenated raw.
    static func encodedPathAndQuery(path: String, query: [URLQueryItem]) -> String {
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard !query.isEmpty else { return normalizedPath }
        var components = URLComponents()
        components.queryItems = query
        return "\(normalizedPath)?\(components.percentEncodedQuery ?? "")"
    }
}
