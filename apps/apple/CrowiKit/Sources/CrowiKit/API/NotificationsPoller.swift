import Foundation

/// RFC-0016 §11 v1 — the **foreground fixed-interval REST poll** behind the
/// unread-notifications badge. Deliberately polling, not WebSocket: the RFC
/// pins the WS "refetch nudge" as an optional stretch whose 60-second-TTL
/// token demands a re-mint loop — an implementation without that loop dies
/// silently after a minute, so v1 stays on polling (the sub-spec's explicit
/// recommendation) rather than shipping half of the WS path.
///
/// Actor + single-in-flight coalescing per the `AppInfoCache` pattern
/// (`RefreshCoordinator` lineage). Lifecycle rides `WorkspaceSession`
/// (§5.2-adjacent): the poll LOOP runs inside the workspace home's `.task`
/// (structured — cancelled the moment the view tears down, so a
/// switched-away workspace's poller cannot keep running: the §14
/// per-workspace isolation invariant, pinned by
/// `NotificationsPollerTests.testCancellingTheRunTaskStopsAllPolling`);
/// backgrounding SUSPENDS it (`suspend()`, no network while backgrounded)
/// and foregrounding resumes + immediately re-polls
/// (`WorkspaceSession.foregrounded()`).
public actor NotificationsPoller {
    /// The web's old pre-WebSocket `useUnreadCount` polling interval (30s) —
    /// the precedent the sub-spec names for "fixed interval, exact value is
    /// an implementation judgment".
    public static let defaultInterval: TimeInterval = 30

    private let client: AuthenticatedAPIClient
    private let interval: TimeInterval
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private var isSuspended = false
    private var inFlight: Task<Int, Error>?

    /// The most recently fetched unread count, `nil` before the first
    /// successful poll — same "unknown, not yet confirmed" stance as
    /// `AppInfoCache.latest` (the badge hides rather than showing a 0 it
    /// never verified).
    public private(set) var latestUnreadCount: Int?

    /// - Parameter sleep: injectable ONLY for the deterministic poll-cycle
    ///   tests (`NotificationsPollerTests` gates each cycle on a tick
    ///   instead of wall-clock time); production callers always take the
    ///   `Task.sleep` default, which also makes loop cancellation prompt
    ///   (`Task.sleep` throws on cancellation).
    public init(
        client: AuthenticatedAPIClient,
        interval: TimeInterval = NotificationsPoller.defaultInterval,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    ) {
        self.client = client
        self.interval = interval
        self.sleep = sleep
    }

    /// The fixed-interval loop: polls immediately, then once per interval,
    /// reporting each successful count to `onUnreadCount` (a `@MainActor`
    /// closure so `WorkspaceSession` can assign its `@Published` badge
    /// property directly). A failed poll (offline, 5xx) skips the report
    /// and simply tries again next interval — the badge keeps its last
    /// known value rather than flickering to an unverified state. Runs until
    /// the surrounding task is cancelled.
    public func run(onUnreadCount: @escaping @MainActor @Sendable (Int) -> Void) async {
        while !Task.isCancelled {
            if !isSuspended, let count = try? await pollOnce() {
                await onUnreadCount(count)
            }
            try? await sleep(interval)
        }
    }

    /// App went to background — stop generating network requests. The loop
    /// keeps its (cheap, request-free) cadence so `resume()` needs no
    /// restart plumbing; on iOS the process is suspended shortly anyway.
    public func suspend() { isSuspended = true }

    /// App came back to foreground. The caller
    /// (`WorkspaceSession.foregrounded()`) follows up with an immediate
    /// `pollOnce()` so a badge change that happened while backgrounded shows
    /// within this one refresh, not up to an interval later.
    public func resume() { isSuspended = false }

    /// One `GET /notifications/status`, single-flighted: concurrent callers
    /// (the loop tick racing a foreground nudge or a post-write refresh)
    /// coalesce onto the same request — the `AppInfoCache.refresh` shape.
    /// Works regardless of `suspend()` (an explicit nudge is always allowed).
    @discardableResult
    public func pollOnce() async throws -> Int {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await self.performFetch() }
        inFlight = task
        defer { inFlight = nil }
        let count = try await task.value
        latestUnreadCount = count
        return count
    }

    /// Isolated to the actor for the same `Task { self.performFetch() }`
    /// capture reason `AppInfoCache.performFetch` documents.
    private func performFetch() async throws -> Int {
        try await NotificationsAPI.fetchUnreadCount(using: client)
    }
}
