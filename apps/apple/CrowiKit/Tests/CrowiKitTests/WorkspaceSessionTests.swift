import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2 — `WorkspaceSession.capabilities` (`@Published`) is the
/// EXACT property `WorkspaceHomeView`'s toolbar reads
/// (`session.capabilities.contains("search")`) to show/hide the search entry
/// point. `AppInfoCacheTests` already pins `AppInfoCache`'s own internal
/// cache-value behavior; this file pins that the same live-toggling reaches
/// the published property a SwiftUI view actually observes, which is what
/// the spec's "capability gate: search 有→無→有 fixture で UI が追随" CI-fixed
/// test requires — a decoder-level or cache-level assertion alone does not
/// demonstrate the UI's own entry point follows.
@MainActor
final class WorkspaceSessionTests: XCTestCase {
    private func appInfoJSON(capabilities: [String], confidential: String? = nil) -> Data {
        var object: [String: Any] = ["title": "Crowi", "version": "2.0.0", "apiVersion": "v2", "capabilities": capabilities]
        if let confidential { object["confidential"] = confidential }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    /// Builds a real `WorkspaceSession` (real `WorkspaceContext`/`ModelContainer`,
    /// mocked transport only) whose `/app/info` fetches are served, in order,
    /// from `appInfoBodies` — one body per successive `activated()`/
    /// `foregrounded()` call, mirroring `WorkspaceContext`'s exact factory
    /// pattern (`makeAppInfoCache`/`makeAPIClient`/`makeImageCache`) rather
    /// than constructing any of these ad hoc. Also returns the workspace id
    /// + `containerBaseDirectory` used, so a caller can independently locate
    /// `WorkspaceModelContainerFactory.storeDirectory` on disk (needed by
    /// `testActivatedEscalatesTheModelContainerStoreDirectoryProtectionWhenConfidential`).
    private func makeSession(appInfoBodies: [Data]) throws -> (session: WorkspaceSession, workspaceId: String, containerBaseDirectory: URL) {
        let containerBaseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = WorkspaceStore(
            indexStore: WorkspaceIndexStore(defaults: UserDefaults(suiteName: "wiki.crowi.ios.tests.\(UUID().uuidString)")!, key: "index"),
            tokenStore: InMemoryTokenStore(),
            containerBaseDirectory: containerBaseDirectory
        )
        let workspace = try store.finishAdding(
            AddWorkspaceFlow.Onboarded(
                workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!),
                displayTitle: "wiki",
                tokens: StoredTokenPair(accessToken: "at", refreshToken: "rt", expiresAt: Date().addingTimeInterval(3600))
            )
        )
        let context = try XCTUnwrap(store.context(for: workspace))

        installAppInfoOnlyHandler(appInfoBodies: appInfoBodies)

        let session = try WorkspaceSession(
            context: context,
            models: [],
            schemaVersion: 1,
            urlSession: MockURLProtocol.makeSession()
        )
        return (session, workspace.id, containerBaseDirectory)
    }

    /// Serves the sequenced app-info fixtures ONLY to `/app/info`:
    /// `foregrounded()` also nudges the notifications poller
    /// (`GET /notifications/status`) since feature-ios-phase3, and that
    /// request must not consume an app-info body. The 404 is absorbed by
    /// the poller's `try?` (badge keeps its last value).
    private func installAppInfoOnlyHandler(appInfoBodies: [Data]) {
        let responses = SequencedResponseBodies(bodies: appInfoBodies)
        MockURLProtocol.requestHandler = { request in
            guard request.url?.path.hasSuffix("/app/info") == true else {
                return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, responses.next())
        }
    }

    /// The exact scenario the spec's CI-fixed capability-gate test names:
    /// `search` present → absent → present across three successive refreshes
    /// must be visible on `session.capabilities` itself (what the toolbar's
    /// `if session.capabilities.contains("search")` conditional re-renders
    /// against on every `@Published` change), not only on `AppInfoCache`'s
    /// own internal cached value.
    func testSearchCapabilityGateFollowsThreeSuccessiveRefreshesOnThePublishedProperty() async throws {
        let (session, _, _) = try makeSession(appInfoBodies: [
            appInfoJSON(capabilities: ["pages", "search"]),
            appInfoJSON(capabilities: ["pages"]),
            appInfoJSON(capabilities: ["pages", "search"]),
        ])

        await session.activated()
        XCTAssertTrue(session.capabilities.contains("search"), "search present on the 1st refresh")

        await session.foregrounded()
        XCTAssertFalse(session.capabilities.contains("search"), "search removed on the 2nd refresh — the UI's own gate must hide it immediately")

        await session.foregrounded()
        XCTAssertTrue(session.capabilities.contains("search"), "search restored on the 3rd refresh — the UI's own gate must re-show it immediately")
    }

    func testConfidentialPublishedPropertyReflectsTheLatestRefresh() async throws {
        let (session, _, _) = try makeSession(appInfoBodies: [
            appInfoJSON(capabilities: ["pages"], confidential: "INTERNAL USE ONLY"),
            appInfoJSON(capabilities: ["pages"], confidential: nil),
        ])

        await session.activated()
        XCTAssertEqual(session.confidential, "INTERNAL USE ONLY")

        await session.foregrounded()
        XCTAssertNil(session.confidential, "de-confidential must clear the published property within the very next refresh")
    }

    /// A prior review round found `WorkspaceSession.refreshAppInfo` escalated
    /// ONLY the image cache's rest-state protection and never called
    /// `context.applyConfidentialStorageProtection` — leaving an
    /// already-open SwiftData workspace store at its construction-time
    /// baseline even after the workspace was detected as confidential.
    /// `WorkspaceModelContainerFactoryTests` already pins that
    /// `WorkspaceContext.applyConfidentialStorageProtection` itself targets
    /// the right directory in isolation; this test pins the wiring
    /// `WorkspaceSession.activated()`/`foregrounded()` must exercise it
    /// through. Since `NSFileProtection`'s actual value is iOS-only (`#if os(iOS)`,
    /// absent from the macOS SDK this suite runs on) and `isExcludedFromBackup`
    /// is already `true` from construction regardless of `confidential`
    /// (so simply re-reading it after `activated()` would pass even with the
    /// call missing), this test first resets the flag to `false` directly on
    /// disk — simulating "the protection call never reached this directory"
    /// — so that only `refreshAppInfo` actually re-applying the protection
    /// can flip it back to `true`.
    func testActivatedEscalatesTheModelContainerStoreDirectoryProtectionWhenConfidential() async throws {
        let (session, workspaceId, containerBaseDirectory) = try makeSession(appInfoBodies: [
            appInfoJSON(capabilities: ["pages"], confidential: "INTERNAL USE ONLY")
        ])

        var storeDirectory = WorkspaceModelContainerFactory.storeDirectory(workspaceId: workspaceId, baseDirectory: containerBaseDirectory)
        var resetValues = URLResourceValues()
        resetValues.isExcludedFromBackup = false
        try storeDirectory.setResourceValues(resetValues)
        let baseline = try storeDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(baseline.isExcludedFromBackup, false, "the reset must actually take effect, or this test would pass vacuously")

        await session.activated()

        let after = try storeDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(
            after.isExcludedFromBackup,
            true,
            "activated() on a confidential workspace must re-apply the SwiftData store directory's rest-state protection, not only the image cache's"
        )
    }

    // MARK: - feature-ios-phase3: the unread badge on the session (§11)

    /// A stateful notification "server" the badge tests route by path:
    /// `/app/info` keeps answering a fixed fixture (so `foregrounded()`'s
    /// app-info half keeps working), `/notifications/status` answers the
    /// current unread count, and the two write endpoints mutate it.
    private final class NotificationRoutes: @unchecked Sendable {
        private let lock = NSLock()
        private var unread: Int
        private let appInfoBody: Data

        init(unread: Int, appInfoBody: Data) {
            self.unread = unread
            self.appInfoBody = appInfoBody
        }

        func install() {
            MockURLProtocol.requestHandler = { [self] request in
                let path = request.url?.path ?? ""
                let body: Data
                if path.hasSuffix("/app/info") {
                    body = appInfoBody
                } else if path.hasSuffix("/notifications/status") {
                    lock.lock()
                    body = try! JSONSerialization.data(withJSONObject: ["count": unread])
                    lock.unlock()
                } else if path.hasSuffix("/notifications/read"), request.httpMethod == "POST" {
                    lock.lock()
                    unread = 0
                    lock.unlock()
                    body = try! JSONSerialization.data(withJSONObject: ["ok": true])
                } else if path.hasSuffix("/open"), request.httpMethod == "POST" {
                    lock.lock()
                    unread = max(0, unread - 1)
                    lock.unlock()
                    body = try! JSONSerialization.data(withJSONObject: ["notification": ["_id": "n1", "status": "OPENED"]])
                } else {
                    return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
                }
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
            }
        }
    }

    /// `unreadNotificationCount` is the EXACT `@Published` property the
    /// toolbar bell renders (`NotificationBellToolbarButton` via the session
    /// wrapper) — this pins that the poll nudge in `foregrounded()` and the
    /// two write helpers actually move it, badge-decrement included.
    func testUnreadNotificationBadgeFollowsForegroundNudgeAndMarkAllRead() async throws {
        let (session, _, _) = try makeSession(appInfoBodies: [appInfoJSON(capabilities: ["pages"])])
        NotificationRoutes(unread: 3, appInfoBody: appInfoJSON(capabilities: ["pages"])).install()

        XCTAssertEqual(session.unreadNotificationCount, 0, "badge hidden until the first successful poll")

        await session.foregrounded()
        XCTAssertEqual(session.unreadNotificationCount, 3, "foregrounding must immediately re-poll the badge")

        let acknowledged = await session.markAllNotificationsRead()
        XCTAssertTrue(acknowledged)
        XCTAssertEqual(session.unreadNotificationCount, 0, "mark-all-read must zero the badge on its follow-up poll")
    }

    func testOpeningANotificationDecrementsThePublishedBadge() async throws {
        let (session, _, _) = try makeSession(appInfoBodies: [appInfoJSON(capabilities: ["pages"])])
        NotificationRoutes(unread: 2, appInfoBody: appInfoJSON(capabilities: ["pages"])).install()

        await session.refreshUnreadNotificationCount()
        XCTAssertEqual(session.unreadNotificationCount, 2)

        await session.openNotification(id: "n1")
        XCTAssertEqual(session.unreadNotificationCount, 1, "opening one UNREAD notification must decrement the badge by exactly one")
    }

    func testAFailedBadgePollKeepsTheLastKnownValue() async throws {
        let (session, _, _) = try makeSession(appInfoBodies: [appInfoJSON(capabilities: ["pages"])])
        NotificationRoutes(unread: 4, appInfoBody: appInfoJSON(capabilities: ["pages"])).install()

        await session.refreshUnreadNotificationCount()
        XCTAssertEqual(session.unreadNotificationCount, 4)

        // Back to the default handler shape: everything non-app-info 404s.
        installAppInfoOnlyHandler(appInfoBodies: [appInfoJSON(capabilities: ["pages"])])

        await session.foregrounded()
        XCTAssertEqual(session.unreadNotificationCount, 4, "a failed status poll must keep the last known badge, never flicker to 0")
    }
}

/// Serves `bodies` in order, one per call, clamping to the last body once
/// exhausted — lets a single mocked `URLSession` answer several successive
/// `/app/info` refreshes with different fixture payloads. Lock-protected:
/// `URLProtocol.startLoading()` can run on a different queue per call.
private final class SequencedResponseBodies: @unchecked Sendable {
    private let lock = NSLock()
    private let bodies: [Data]
    private var index = 0

    init(bodies: [Data]) {
        self.bodies = bodies
    }

    func next() -> Data {
        lock.lock()
        defer { lock.unlock() }
        let body = bodies[min(index, bodies.count - 1)]
        index += 1
        return body
    }
}
