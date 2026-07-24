import Foundation

/// A minimal open-once ordering primitive for deterministic concurrency
/// tests: callers park on `wait()` until someone calls `open()` (opening is
/// permanent — later waiters pass straight through). Pins request orderings
/// (`AuthenticatingMiddlewareTests`) and holds a mock response "in flight"
/// (`EngagementActionsTests`' duplicate-tap tests) without resorting to a
/// flaky `Task.sleep`-based race.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
