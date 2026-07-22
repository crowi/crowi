import Foundation
import HTTPTypes
import OpenAPIRuntime

/// RFC-0016 §5.1 — the per-workspace **auth-injecting transport wrapper**
/// the generated `Client` is composed with (as a `ClientMiddleware`, layered
/// on top of `URLSessionTransport` rather than reimplementing HTTP
/// transport): every request gets `Authorization: Bearer <accessToken>`
/// attached, using `RefreshCoordinator.ensureFreshAccessToken()` for the
/// PROACTIVE check, and — on a live `401` — the REACTIVE backstop
/// (`RefreshCoordinator.refreshedAccessToken()`) followed by exactly one
/// retry. Both paths fold onto the same `RefreshCoordinator` actor, so this
/// middleware itself never double-refreshes; it just calls the coordinator,
/// which is where the single-flight guarantee (§4.2/OQ-3) actually lives.
///
/// `feature-ios-phase1-read`'s "transport wrapper (auth spec で実装済み)"
/// reuse note refers to this type: Phase 1 has no read UI yet, but the
/// wrapper itself is a complete, testable deliverable of this phase.
public final class AuthenticatingMiddleware: ClientMiddleware, Sendable {
    private let coordinator: RefreshCoordinator

    public init(coordinator: RefreshCoordinator) {
        self.coordinator = coordinator
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let proactiveToken = try await coordinator.ensureFreshAccessToken()
        let (response, responseBody) = try await next(authorized(request, token: proactiveToken), body, baseURL)

        guard response.status.code == 401 else {
            return (response, responseBody)
        }

        // REACTIVE backstop (§5.1): the proactive check said the token was
        // still fresh, but the server disagreed (clock skew, or a
        // server-side revoke) — force a refresh (coalesced with any other
        // in-flight refresh via the same actor) and retry exactly once.
        // Passing `proactiveToken` as the rejected token lets the
        // coordinator detect the delayed-401 race: if a concurrent request's
        // refresh already replaced the stored token by the time this call
        // runs, it returns that token directly instead of refreshing again.
        let reactiveToken = try await coordinator.refreshedAccessToken(rejecting: proactiveToken)
        return try await next(authorized(request, token: reactiveToken), body, baseURL)
    }

    private func authorized(_ request: HTTPRequest, token: String) -> HTTPRequest {
        var authed = request
        authed.headerFields[.authorization] = "Bearer \(token)"
        return authed
    }
}
