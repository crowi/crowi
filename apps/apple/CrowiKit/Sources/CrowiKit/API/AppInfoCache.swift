import Foundation

/// RFC-0016 §5.2 — the ONE refreshed per-workspace `/app/info` cache: both
/// the `search` capability gate and the §6.3 confidential banner read this
/// SAME cache, never two independent fetch paths for the same data (a
/// frozen/duplicated cache is exactly the staleness bug §5.2 calls out —
/// `confidential` is operator-set at runtime and `search` is appended only
/// while a search driver is active, so both can change on the host at any
/// time after the workspace was added).
///
/// Refresh policy (§5.2, exact): a fetch is forced on workspace
/// **activation** (`activated()`) and on app **foreground**
/// (`foregrounded()`); any other read (`current()`) is served from the
/// cache if it is within the **10-minute TTL**, otherwise it also forces a
/// fetch. Concurrent callers (the search gate and the banner can both read
/// at the same instant right after a workspace switch) are single-flighted
/// onto the SAME in-flight fetch `Task` — the same actor-based coalescing
/// pattern `RefreshCoordinator` (Phase 1) established for token refresh,
/// chosen here for consistency (OQ, `feature-ios-phase1-read` openQuestions)
/// even though nothing here is security-sensitive the way token rotation is.
public actor AppInfoCache {
    private let apiBaseURL: APIBaseURL
    private let urlSession: URLSession
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date

    /// The most recently fetched value, or `nil` before the very first
    /// successful fetch. Callers that need a synchronous, always-available
    /// answer (the capability gate, the banner) should treat "not yet
    /// fetched" the same as "no capabilities / not confidential" — the
    /// conservative default that hides gated UI rather than showing it
    /// before the host is even confirmed reachable.
    public private(set) var latest: AppInfoLenient?
    private var lastFetchedAt: Date?
    private var inFlight: Task<AppInfoLenient, Error>?

    public init(
        apiBaseURL: APIBaseURL,
        urlSession: URLSession = .shared,
        ttl: TimeInterval = 600,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.apiBaseURL = apiBaseURL
        self.urlSession = urlSession
        self.ttl = ttl
        self.now = now
    }

    /// The capabilities from the last fetch, or `[]` if none has completed
    /// yet — the conservative "nothing confirmed" default (never
    /// `StaticCapabilities.baseline`, which would incorrectly imply a
    /// confirmed-old-host degrade rather than "unknown").
    public var capabilities: [String] { latest?.capabilities ?? [] }

    /// The last-fetched `confidential` notice, or `nil` before any fetch —
    /// the same conservative default (no banner until the host is
    /// confirmed), consistent with `capabilities` above.
    public var confidential: String? { latest?.confidential ?? nil }

    /// Call on workspace activation (§5.2) — always forces a fetch,
    /// regardless of TTL, since a just-activated workspace's cache may be
    /// empty or stale from before the app was last foregrounded.
    @discardableResult
    public func activated() async throws -> AppInfoLenient {
        try await refresh(force: true)
    }

    /// Call on app foreground (§5.2) — same as activation: always forces a
    /// fetch so a workspace that became confidential (or gained/lost
    /// `search`) while the app was backgrounded is reflected within this one
    /// refresh, not up to 10 minutes later.
    @discardableResult
    public func foregrounded() async throws -> AppInfoLenient {
        try await refresh(force: true)
    }

    /// Any other read: serves the cached value if it is still within the
    /// 10-minute TTL, otherwise also forces a fetch. This is what a screen
    /// should call right before rendering the capability-gated UI / banner
    /// if it wants the freshest-allowed answer without unconditionally
    /// hitting the network (`activated()`/`foregrounded()` already cover the
    /// two moments that must always hit the network).
    @discardableResult
    public func current() async throws -> AppInfoLenient {
        try await refresh(force: false)
    }

    private func refresh(force: Bool) async throws -> AppInfoLenient {
        if !force, let latest, let lastFetchedAt, now().timeIntervalSince(lastFetchedAt) < ttl {
            return latest
        }
        if let inFlight {
            return try await inFlight.value
        }
        let task = Task { try await self.performFetch() }
        inFlight = task
        defer { inFlight = nil }
        let value = try await task.value
        latest = value
        lastFetchedAt = now()
        return value
    }

    /// Isolated to the actor (unlike a bare closure capturing stored
    /// properties directly) so `Task { try await self.performFetch() }`
    /// above never needs to reason about capturing actor-isolated state
    /// from outside actor isolation — the same shape `RefreshCoordinator`
    /// (Phase 1) uses for its own in-flight `Task`.
    private func performFetch() async throws -> AppInfoLenient {
        try await AppInfoLenient.fetch(apiBaseURL: apiBaseURL, urlSession: urlSession)
    }
}
