import Foundation

/// RFC-0016 §4.2/§5.1/OQ-3 — the per-workspace **single-flight** refresh
/// coordinator. One instance per active workspace (its Keychain item and
/// discovery-resolved `token_endpoint` are workspace-specific, so a single
/// shared coordinator would blur the §3/§14 workspace isolation).
///
/// Both the PROACTIVE path (`ensureFreshAccessToken()`, called before a
/// request when the cached token is close to `expiresAt`) and the REACTIVE
/// path (`refreshedAccessToken()`, called after a live `401` — the
/// clock-skew / server-side-revocation backstop) fold onto the same
/// internal in-flight `Task`, so **concurrent callers never each present the
/// same (rotating, reuse-detected) refresh token** — a double-presentation
/// would trip the server's `revokeChain` and kill the whole workspace
/// (`packages/api/src/hono/handlers/oauth.ts`'s `refresh_token` grant
/// branch). This mirrors `packages/web/src/lib/api-client.ts`'s
/// `acquireRefreshedToken` capture-local-before-check single-flight promise,
/// but is an `actor` (not a bare module-level variable) specifically because
/// CrowiKit code runs under real, multi-`Task` concurrency — unlike the
/// web's single-threaded JS guard, an actor is required to make the
/// check-then-set atomic (RFC-0016 architecturalNotes / OQ-3 resolved to
/// `actor`, not a bare `Task`).
public actor RefreshCoordinator {
    private let workspaceId: String
    private let tokenStore: any WorkspaceTokenStoring
    private let clientID: String
    private let tokenEndpointProvider: @Sendable () async throws -> URL
    private let urlSession: URLSession
    /// How long before `expiresAt` a PROACTIVE refresh is triggered.
    private let proactiveRefreshWindow: TimeInterval

    private var inFlight: Task<StoredTokenPair, Error>?

    /// Test-observable counter: incremented exactly once per REAL
    /// token-endpoint POST (never for a caller that coalesced onto an
    /// existing in-flight refresh) — `RefreshCoordinatorSingleFlightTests`
    /// asserts this equals `1` after N concurrent callers.
    public private(set) var refreshInvocationCount = 0

    /// Not `public` — `tokenStore: any WorkspaceTokenStoring` is a
    /// module-internal type (§14); this coordinator is only ever legitimately
    /// constructed by `WorkspaceContext.makeRefreshCoordinator()`, or a test
    /// via `@testable import CrowiKit`. `RefreshCoordinator` the TYPE stays
    /// `public` (the App target holds and calls `ensureFreshAccessToken()`
    /// on the instance `WorkspaceContext` hands it) — only its construction
    /// is bottled up.
    init(
        workspaceId: String,
        tokenStore: any WorkspaceTokenStoring,
        clientID: String = OAuthSignInFlow.clientID,
        urlSession: URLSession = .shared,
        proactiveRefreshWindow: TimeInterval = 60,
        tokenEndpointProvider: @escaping @Sendable () async throws -> URL
    ) {
        self.workspaceId = workspaceId
        self.tokenStore = tokenStore
        self.clientID = clientID
        self.urlSession = urlSession
        self.proactiveRefreshWindow = proactiveRefreshWindow
        self.tokenEndpointProvider = tokenEndpointProvider
    }

    public enum RefreshError: Error, Equatable {
        case noStoredRefreshToken
    }

    /// Returns a currently-valid access token: the cached one if it is not
    /// within `proactiveRefreshWindow` of `expiresAt`, otherwise a freshly
    /// refreshed one (coalesced with any other in-flight refresh).
    public func ensureFreshAccessToken() async throws -> String {
        guard let stored = try tokenStore.load(forWorkspace: workspaceId) else {
            throw RefreshError.noStoredRefreshToken
        }
        if stored.expiresAt.timeIntervalSinceNow > proactiveRefreshWindow {
            return stored.accessToken
        }
        return try await refreshedAccessToken()
    }

    /// The REACTIVE `401` backstop: performs (or joins) a refresh and
    /// returns the resulting access token, regardless of what the cached
    /// `expiresAt` says — clock skew or a server-side revoke can invalidate
    /// a token that looks locally unexpired.
    ///
    /// - Parameter rejectedAccessToken: the access token the caller's own
    ///   request was rejected with (`AuthenticatingMiddleware` always passes
    ///   this). This closes the **delayed-401 race**: two concurrent
    ///   requests can both carry the same now-stale token and both receive
    ///   `401`, but their responses arrive at different times. If, by the
    ///   time this call runs, a concurrent refresh has ALREADY replaced the
    ///   stored token (the first 401's refresh completed before the second
    ///   401 was even handled), the stored access token no longer equals
    ///   `rejectedAccessToken` — so this returns the current stored token
    ///   directly instead of presenting the refresh token a second time,
    ///   which would trip the server's `revokeChain` reuse-detection and
    ///   kill the whole workspace. Passing `nil` (the proactive path's
    ///   internal use) always forces a real refresh, since there is no
    ///   "rejected" token to compare against.
    @discardableResult
    public func refreshedAccessToken(rejecting rejectedAccessToken: String? = nil) async throws -> String {
        if let inFlight {
            return try await inFlight.value.accessToken
        }
        if let rejectedAccessToken,
            let stored = try tokenStore.load(forWorkspace: workspaceId),
            stored.accessToken != rejectedAccessToken
        {
            // Someone else's refresh already replaced the token since this
            // caller's request was sent — no need (and it would be unsafe)
            // to refresh again.
            return stored.accessToken
        }
        return try await refresh().accessToken
    }

    /// Only ever called with `inFlight == nil` — both callers
    /// (`refreshedAccessToken(rejecting:)` and, transitively,
    /// `ensureFreshAccessToken()`) already check `inFlight` themselves
    /// before reaching here, with no `await` in between (`tokenStore.load`
    /// is synchronous), so there is no actor-reentrancy window in which a
    /// second caller could get here first.
    private func refresh() async throws -> StoredTokenPair {
        let task = Task { try await performRefresh() }
        inFlight = task
        do {
            let result = try await task.value
            inFlight = nil
            return result
        } catch {
            inFlight = nil
            throw error
        }
    }

    private func performRefresh() async throws -> StoredTokenPair {
        refreshInvocationCount += 1
        guard let stored = try tokenStore.load(forWorkspace: workspaceId) else {
            throw RefreshError.noStoredRefreshToken
        }
        let tokenEndpoint = try await tokenEndpointProvider()
        let pair = try await OAuthTokenExchange.exchange(
            fields: [
                ("grant_type", "refresh_token"),
                ("refresh_token", stored.refreshToken),
                ("client_id", clientID),
            ],
            at: tokenEndpoint,
            urlSession: urlSession
        )
        try tokenStore.save(pair, forWorkspace: workspaceId)
        return pair
    }
}
