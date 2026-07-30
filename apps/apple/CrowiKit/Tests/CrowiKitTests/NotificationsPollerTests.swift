import Foundation
import XCTest

@testable import CrowiKit

/// RFC-0016 §11 — the CI-fixed poll invariants: immediate first poll +
/// per-interval polls (deterministically clocked, never wall-time),
/// suspend/resume around backgrounding, structural stop on task cancellation
/// (the §14 per-workspace isolation invariant applied to polling), and the
/// badge-decrement round-trips (mark-all-read + single open) against a
/// stateful wire fixture.
final class NotificationsPollerTests: XCTestCase {
    // MARK: - Deterministic clock

    /// Replaces the poller's sleep: every loop cycle parks on `sleep()`
    /// until the test releases exactly one cycle via `tick()` — a gated
    /// clock, so no assertion ever races wall time.
    private actor TickClock {
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private(set) var sleepCallCount = 0

        func sleep() async {
            sleepCallCount += 1
            await withCheckedContinuation { waiters.append($0) }
        }

        /// Releases ONE parked cycle, waiting (cooperatively) until the loop
        /// has actually parked — ticking into thin air would strand the loop
        /// forever.
        func tick() async {
            while waiters.isEmpty {
                await Task.yield()
            }
            waiters.removeFirst().resume()
        }
    }

    /// Reported unread counts, in order — `@MainActor` because the poller's
    /// report callback is (it assigns a `@Published` property in production).
    @MainActor
    private final class CountLog {
        private(set) var counts: [Int] = []
        func append(_ count: Int) { counts.append(count) }
    }

    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line,
        condition: @escaping () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    private func makePoller(
        recorder: WireRecorder,
        clock: TickClock,
        handler: @escaping @Sendable (RecordedWireRequest) async throws -> (Int, Data)
    ) -> NotificationsPoller {
        NotificationsPoller(
            client: makeWireRecordedClient(recorder: recorder, handler: handler),
            interval: NotificationsPoller.defaultInterval,
            sleep: { _ in await clock.sleep() }
        )
    }

    private static func countBody(_ count: Int) -> Data {
        try! JSONSerialization.data(withJSONObject: ["count": count])
    }

    // MARK: - The fixed-interval loop

    func testRunPollsImmediatelyAndThenOncePerInterval() async {
        let recorder = WireRecorder()
        let clock = TickClock()
        let responses = AtomicCounter()
        let poller = makePoller(recorder: recorder, clock: clock) { _ in
            // 3 unread on the first poll, 5 on the second.
            (200, Self.countBody(responses.increment() == 1 ? 3 : 5))
        }
        let log = await CountLog()

        let runTask = Task { await poller.run { count in log.append(count) } }

        await waitUntil("the immediate first poll") { await log.counts == [3] }
        await clock.tick()
        await waitUntil("the second, interval-driven poll") { await log.counts == [3, 5] }

        let requests = recorder.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.path == "/notifications/status" && $0.method == .get })
        let latest = await poller.latestUnreadCount
        XCTAssertEqual(latest, 5)

        runTask.cancel()
        await clock.tick()
        await runTask.value
    }

    func testAFailedPollReportsNothingAndTheLoopRetriesNextInterval() async {
        let recorder = WireRecorder()
        let clock = TickClock()
        let responses = AtomicCounter()
        let poller = makePoller(recorder: recorder, clock: clock) { _ in
            // First poll answers 500; the next succeeds.
            responses.increment() == 1 ? (500, Data()) : (200, Self.countBody(2))
        }
        let log = await CountLog()

        let runTask = Task { await poller.run { count in log.append(count) } }

        await waitUntil("the failed first poll to hit the wire") { recorder.requests.count == 1 }
        let countsAfterFailure = await log.counts
        XCTAssertEqual(countsAfterFailure, [], "a failed poll must not report — the badge keeps its last known value")

        await clock.tick()
        await waitUntil("the retry to report") { await log.counts == [2] }

        runTask.cancel()
        await clock.tick()
        await runTask.value
    }

    // MARK: - Background suspend / foreground resume

    func testSuspendStopsWireRequestsUntilResume() async {
        let recorder = WireRecorder()
        let clock = TickClock()
        let poller = makePoller(recorder: recorder, clock: clock) { _ in (200, Self.countBody(1)) }
        let log = await CountLog()

        let runTask = Task { await poller.run { count in log.append(count) } }
        await waitUntil("the immediate first poll") { await log.counts.count == 1 }

        await poller.suspend()
        await clock.tick()
        // The loop proves it has completed a full suspended cycle by parking
        // on sleep AGAIN (sleepCallCount reaches 2) — deterministic, no
        // arbitrary settle delay.
        await waitUntil("a full suspended cycle") { await clock.sleepCallCount >= 2 }
        XCTAssertEqual(recorder.requests.count, 1, "a suspended (backgrounded) poller must not touch the network")

        await poller.resume()
        await clock.tick()
        await waitUntil("the post-resume poll") { await log.counts.count == 2 }
        XCTAssertEqual(recorder.requests.count, 2)

        runTask.cancel()
        await clock.tick()
        await runTask.value
    }

    // MARK: - §14: cancellation stops a switched-away workspace's poller

    func testCancellingTheRunTaskStopsAllPolling() async {
        let recorder = WireRecorder()
        let clock = TickClock()
        let poller = makePoller(recorder: recorder, clock: clock) { _ in (200, Self.countBody(1)) }
        let log = await CountLog()

        let runTask = Task { await poller.run { count in log.append(count) } }
        await waitUntil("the immediate first poll") { await log.counts.count == 1 }

        runTask.cancel()
        await clock.tick()
        await runTask.value

        XCTAssertEqual(recorder.requests.count, 1, "after cancellation (workspace switch/sign-out tears down the home's .task) no further poll may fire")
        let countsAfterCancel = await log.counts
        XCTAssertEqual(countsAfterCancel.count, 1)
    }

    // MARK: - Coalescing (the AppInfoCache pattern)

    func testConcurrentPollOnceCallsCoalesceOntoOneWireRequest() async throws {
        let recorder = WireRecorder()
        let gate = Gate()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            await gate.wait()
            return (200, Self.countBody(4))
        }
        let poller = NotificationsPoller(client: client, sleep: { _ in })

        async let first = poller.pollOnce()
        async let second = poller.pollOnce()
        // Let both callers reach the actor before opening the response gate.
        await waitUntil("the coalesced request to hit the wire") { recorder.requests.count == 1 }
        await gate.open()

        let counts = try await (first, second)
        XCTAssertEqual(counts.0, 4)
        XCTAssertEqual(counts.1, 4)
        XCTAssertEqual(recorder.requests.count, 1, "concurrent status polls must coalesce onto the same in-flight request")
    }

    // MARK: - Badge decrement round-trips (mark-all-read + single open)

    /// A minimal stateful "server": unread count starts at 3; mark-all-read
    /// zeroes it; opening one UNREAD notification decrements it.
    private final class NotificationServerState: @unchecked Sendable {
        private let lock = NSLock()
        private var unread: Int

        init(unread: Int) { self.unread = unread }

        var currentUnread: Int {
            lock.lock()
            defer { lock.unlock() }
            return unread
        }

        func markAllRead() {
            lock.lock()
            unread = 0
            lock.unlock()
        }

        func openOne() {
            lock.lock()
            unread = max(0, unread - 1)
            lock.unlock()
        }
    }

    private func makeStatefulClient(recorder: WireRecorder, state: NotificationServerState) -> AuthenticatedAPIClient {
        makeWireRecordedClient(recorder: recorder) { request in
            switch (request.method, request.path ?? "") {
            case (.get, "/notifications/status"):
                return (200, Self.countBody(state.currentUnread))
            case (.post, "/notifications/read"):
                state.markAllRead()
                return (200, try! JSONSerialization.data(withJSONObject: ["ok": true]))
            case (.post, let path) where path.hasSuffix("/open"):
                state.openOne()
                return (200, try! JSONSerialization.data(withJSONObject: ["notification": ["_id": "n1", "status": "OPENED"]]))
            default:
                return (404, Data())
            }
        }
    }

    func testMarkAllReadThenPollReportsZero() async throws {
        let recorder = WireRecorder()
        let state = NotificationServerState(unread: 3)
        let client = makeStatefulClient(recorder: recorder, state: state)
        let poller = NotificationsPoller(client: client, sleep: { _ in })

        let before = try await poller.pollOnce()
        XCTAssertEqual(before, 3)

        try await NotificationsAPI.markAllRead(using: client)

        let after = try await poller.pollOnce()
        XCTAssertEqual(after, 0, "mark-all-read (UNREAD→UNOPENED in bulk) must zero the badge on the very next poll")
        let latest = await poller.latestUnreadCount
        XCTAssertEqual(latest, 0)
    }

    func testOpeningOneUnreadNotificationDecrementsTheBadgeOnTheNextPoll() async throws {
        let recorder = WireRecorder()
        let state = NotificationServerState(unread: 2)
        let client = makeStatefulClient(recorder: recorder, state: state)
        let poller = NotificationsPoller(client: client, sleep: { _ in })

        let before = try await poller.pollOnce()
        XCTAssertEqual(before, 2)

        _ = try await NotificationsAPI.open(id: "n1", using: client)

        let after = try await poller.pollOnce()
        XCTAssertEqual(after, 1, "opening one UNREAD notification must decrement the badge by exactly one")
    }
}

/// A lock-protected counter for scripting "Nth response differs" handlers —
/// the handler closure is `@Sendable`, so a plain captured `var` won't do.
private final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    /// Returns the value AFTER incrementing (1 on the first call).
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}
