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
    ///
    /// - Parameter headers: extra request headers (RFC-0023's
    ///   `X-Crowi-Ast-Version` content-negotiation declaration is the one
    ///   consumer today). A key `HTTPField.Name` rejects is skipped rather
    ///   than failing the request.
    public func get(_ path: String, query: [URLQueryItem] = [], headers: [String: String] = [:]) async throws -> (data: Data, status: Int) {
        var request = HTTPRequest(method: .get, scheme: nil, authority: nil, path: Self.encodedPathAndQuery(path: path, query: query))
        for (key, value) in headers {
            guard let name = HTTPField.Name(key) else { continue }
            request.headerFields[name] = value
        }
        return try await perform(request, body: nil)
    }

    /// `POST {apiBaseURL}/<path>` with a JSON body — `feature-ios-phase2-write`'s
    /// bounded-write extension of this SAME primitive (never a second client
    /// or a bare-`URLSession` write path): the request rides the identical
    /// `AuthenticatingMiddleware` + `ClientTransport` composition `get` uses,
    /// so proactive/reactive single-flight refresh applies to writes with no
    /// extra wiring. Same non-throwing-on-non-2xx contract as `get` — the
    /// write flows (`PageCreateFlow` / `PageEditSession` / `EngagementActions`)
    /// each branch on the status + the shared `{ error: { code, message } }`
    /// envelope (`APIErrorEnvelopeLenient`) themselves.
    public func post(_ path: String, json: some Encodable & Sendable) async throws -> (data: Data, status: Int) {
        try await send(method: .post, path: path, json: json)
    }

    /// `PUT {apiBaseURL}/<path>` with a JSON body — see `post`.
    public func put(_ path: String, json: some Encodable & Sendable) async throws -> (data: Data, status: Int) {
        try await send(method: .put, path: path, json: json)
    }

    /// `DELETE {apiBaseURL}/<path>` with a JSON body (the server's
    /// `DELETE /bookmarks` / `DELETE /comments` take their target as a JSON
    /// body, not a query) — see `post`.
    public func delete(_ path: String, json: some Encodable & Sendable) async throws -> (data: Data, status: Int) {
        try await send(method: .delete, path: path, json: json)
    }

    private func send(method: HTTPRequest.Method, path: String, json: some Encodable & Sendable) async throws -> (data: Data, status: Int) {
        var request = HTTPRequest(method: method, scheme: nil, authority: nil, path: Self.encodedPathAndQuery(path: path, query: []))
        request.headerFields[.contentType] = "application/json"
        // `HTTPBody(Data)` is a fully-buffered, REPLAYABLE body
        // (`iterationBehavior: .multiple`) — required here because
        // `AuthenticatingMiddleware` re-sends the same body once after a
        // reactive `401` refresh; a single-shot streaming body would fail
        // that retry.
        let body = HTTPBody(try JSONEncoder().encode(json))
        return try await perform(request, body: body)
    }

    private func perform(_ request: HTTPRequest, body: HTTPBody?) async throws -> (data: Data, status: Int) {
        let operationID = request.path ?? ""
        let (response, responseBody) = try await middleware.intercept(
            request, body: body, baseURL: apiBaseURL.url, operationID: operationID
        ) { request, body, baseURL in
            try await transport.send(request, body: body, baseURL: baseURL, operationID: operationID)
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
