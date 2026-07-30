import Foundation
import XCTest

@testable import CrowiKit

/// RFC-0016 §11 — fixture round-trips for the four notification endpoints
/// (list / unread count / mark-all-read / open), pinned at the WIRE through
/// `WireRecordingTransport` (the `feature-ios-phase2-write` harness), plus
/// the phase's degrade rules: a row with a missing/degenerate target or an
/// unknown action stays LISTED but non-navigable — never dropped.
final class NotificationsLenientTests: XCTestCase {
    // MARK: - Fixtures (wire truth: hono/handlers/notification.ts + schemas/notification.ts)

    private func notificationJSON(
        id: String = "n1",
        action: Any = "COMMENT",
        status: String = "UNREAD",
        target: Any? = ["_id": "p1", "path": "/team/handbook", "status": "published"],
        actionUsers: [[String: Any]]? = [["_id": "u2", "username": "bob", "name": "Bob", "email": "b@example.com"]],
        createdAt: String = "2026-07-30T01:02:03.000Z"
    ) -> [String: Any] {
        var object: [String: Any] = [
            "_id": id,
            "user": "u1",
            "targetModel": "Page",
            "action": action,
            "status": status,
            "createdAt": createdAt,
        ]
        if let target { object["target"] = target }
        if let actionUsers { object["actionUsers"] = actionUsers }
        return object
    }

    private func listJSON(_ notifications: [[String: Any]], next: Any = NSNull(), offset: Int = 0) -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "notifications": notifications,
            "pager": ["prev": NSNull(), "next": next, "offset": offset],
        ])
    }

    // MARK: - List round-trip

    func testFetchListDecodesRowsAndPagerAndHitsTheRightWireShape() async throws {
        let recorder = WireRecorder()
        let body = listJSON(
            [
                notificationJSON(id: "n1", action: "COMMENT", status: "UNREAD"),
                notificationJSON(id: "n2", action: "UPDATE", status: "OPENED"),
            ],
            next: 20
        )
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, body) }

        let response = try await NotificationsAPI.fetchList(limit: 20, offset: 0, using: client)

        XCTAssertEqual(response.notifications.map(\.notificationId), ["n1", "n2"])
        XCTAssertEqual(response.notifications[0].targetPath, "/team/handbook")
        XCTAssertEqual(response.notifications[0].actionUsers.first?.displayName, "Bob")
        XCTAssertEqual(response.nextOffset, 20)

        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .get)
        XCTAssertEqual(request.path, "/notifications?limit=20&offset=0")
        XCTAssertNotNil(request.authorization, "the list must ride the authenticated client, never a bare fetch")
    }

    func testFetchListNilsTheNextOffsetOnTheLastPage() async throws {
        let body = listJSON([notificationJSON()], next: NSNull())
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (200, body) }

        let response = try await NotificationsAPI.fetchList(using: client)

        XCTAssertNil(response.nextOffset)
    }

    func testFetchListThrowsOnANonSuccessStatus() async {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (500, Data()) }

        do {
            _ = try await NotificationsAPI.fetchList(using: client)
            XCTFail("expected httpError")
        } catch {
            XCTAssertEqual(error as? NotificationsLenientDecodeError, .httpError(status: 500))
        }
    }

    // MARK: - Degrade rules (the phase pin: degrade the ROW, never drop it)

    func testRowWithAMissingTargetIsKeptButNonNavigable() throws {
        let response = try ListNotificationsResponseLenient.decode(
            listJSON([notificationJSON(id: "n1", target: nil)])
        )

        let row = try XCTUnwrap(response.notifications.first)
        XCTAssertEqual(row.notificationId, "n1")
        XCTAssertNil(row.targetPath)
        XCTAssertFalse(row.isNavigable)
        XCTAssertEqual(row.messageText, "Bob commented on a page")
    }

    func testRowWithTheHandlersDegenerateEmptyPathTargetIsKeptButNonNavigable() throws {
        // notification.ts emits `{ _id, path: '', status: null }` when the
        // target document could not be populated.
        let response = try ListNotificationsResponseLenient.decode(
            listJSON([notificationJSON(id: "n1", target: ["_id": "p1", "path": "", "status": NSNull()])])
        )

        let row = try XCTUnwrap(response.notifications.first)
        XCTAssertFalse(row.isNavigable)
    }

    func testRowWithAnUnknownActionIsKeptWithTheGenericMessage() throws {
        let response = try ListNotificationsResponseLenient.decode(
            listJSON([notificationJSON(id: "n1", action: "FROBNICATE")])
        )

        let row = try XCTUnwrap(response.notifications.first)
        XCTAssertEqual(row.action, "FROBNICATE")
        XCTAssertTrue(row.isNavigable, "an unknown action alone must not disable navigation — the target is intact")
        XCTAssertEqual(row.messageText, "Bob acted on “handbook”")
    }

    func testRowWithoutActionUsersDegradesToSomeone() throws {
        let response = try ListNotificationsResponseLenient.decode(
            listJSON([notificationJSON(id: "n1", actionUsers: nil)])
        )

        let row = try XCTUnwrap(response.notifications.first)
        XCTAssertEqual(row.actionUsers, [])
        XCTAssertEqual(row.messageText, "Someone commented on “handbook”")
    }

    func testRowWithoutAnIdIsDropped() throws {
        var idless = notificationJSON()
        idless.removeValue(forKey: "_id")
        let response = try ListNotificationsResponseLenient.decode(listJSON([idless, notificationJSON(id: "n2")]))

        XCTAssertEqual(response.notifications.map(\.notificationId), ["n2"], "a row with no identity can never be opened — the one hard requirement, like every other *Lenient decoder")
    }

    // MARK: - Message text (the 4 wired actions, web template parity)

    func testMessageTextCoversAllFourWiredActions() {
        func row(_ action: String, users: [[String: Any]]? = nil) -> NotificationLenient {
            NotificationLenient.decode(notificationJSON(action: action, actionUsers: users ?? [["username": "bob", "name": "Bob"]]))!
        }

        XCTAssertEqual(row("COMMENT").messageText, "Bob commented on “handbook”")
        XCTAssertEqual(row("LIKE").messageText, "Bob liked “handbook”")
        XCTAssertEqual(row("MENTION").messageText, "Bob mentioned you on “handbook”")
        XCTAssertEqual(row("UPDATE").messageText, "Bob updated “handbook”")
    }

    func testMessageTextCountsAdditionalActionUsersLikeTheWebTemplates() {
        let row = NotificationLenient.decode(
            notificationJSON(actionUsers: [["name": "Bob"], ["name": "Carol"], ["name": "Dave"]])
        )!

        XCTAssertEqual(row.messageText, "Bob and 2 more commented on “handbook”")
    }

    func testMessageTextUsesThePageShortNameWithTheDateRunRule() {
        let row = NotificationLenient.decode(
            notificationJSON(target: ["_id": "p1", "path": "/user/foo/日報/2026/05/23", "status": "published"])
        )!

        // `PageRowTitleLabel.displayName` — the same trailing-date-run rule
        // the web's `pageDisplayName` applies inside its bell rows.
        XCTAssertEqual(row.messageText, "Bob commented on “2026/05/23”")
    }

    func testDisplayNameFallsBackThroughEmptyNameToUsernameLikeTheWebsOrOperator() {
        XCTAssertEqual(NotificationActionUserLenient(username: "bob", name: "", image: nil).displayName, "bob")
        XCTAssertEqual(NotificationActionUserLenient(username: "bob", name: "Bob", image: nil).displayName, "Bob")
        XCTAssertNil(NotificationActionUserLenient(username: nil, name: nil, image: nil).displayName)
    }

    // MARK: - Unopened semantics + optimistic open copy

    func testIsUnopenedMirrorsTheWebsExactStatusSet() {
        func row(_ status: String) -> NotificationLenient {
            NotificationLenient.decode(notificationJSON(status: status))!
        }

        XCTAssertTrue(row("UNREAD").isUnopened)
        XCTAssertTrue(row("UNOPENED").isUnopened)
        XCTAssertFalse(row("OPENED").isUnopened)
        XCTAssertFalse(row("SOMETHING_ELSE").isUnopened, "an unknown status shows no highlight — the web's exact-match check")
    }

    func testOpenedCopyOnlyChangesTheStatus() {
        let row = NotificationLenient.decode(notificationJSON(status: "UNREAD"))!
        let opened = row.opened()

        XCTAssertEqual(opened.status, "OPENED")
        XCTAssertFalse(opened.isUnopened)
        XCTAssertEqual(opened.notificationId, row.notificationId)
        XCTAssertEqual(opened.targetPath, row.targetPath)
        XCTAssertEqual(opened.actionUsers, row.actionUsers)
        XCTAssertEqual(opened.createdAt, row.createdAt)
    }

    // MARK: - Unread count

    func testFetchUnreadCountDecodesTheCount() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            (200, try! JSONSerialization.data(withJSONObject: ["count": 7]))
        }

        let count = try await NotificationsAPI.fetchUnreadCount(using: client)

        XCTAssertEqual(count, 7)
        XCTAssertEqual(recorder.requests.first?.path, "/notifications/status")
        XCTAssertEqual(recorder.requests.first?.method, .get)
    }

    func testFetchUnreadCountThrowsWhenTheCountIsMissingInsteadOfDegradingToZero() async {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in
            (200, try! JSONSerialization.data(withJSONObject: ["ok": true]))
        }

        do {
            _ = try await NotificationsAPI.fetchUnreadCount(using: client)
            XCTFail("a missing count has no safe fallback — degrading to 0 would clear a real badge")
        } catch {
            XCTAssertEqual(error as? NotificationsLenientDecodeError, .notAnObject)
        }
    }

    // MARK: - Mark-all-read

    func testMarkAllReadPostsAnEmptyJSONBodyToTheReadPath() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            (200, try! JSONSerialization.data(withJSONObject: ["ok": true]))
        }

        try await NotificationsAPI.markAllRead(using: client)

        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/notifications/read")
        XCTAssertEqual(request.jsonObject?.isEmpty, true, "the endpoint takes no parameters — an empty JSON object, never absent (legacy body-parser parity)")
    }

    func testMarkAllReadThrowsOnANonSuccessStatus() async {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (500, Data()) }

        do {
            try await NotificationsAPI.markAllRead(using: client)
            XCTFail("expected httpError")
        } catch {
            XCTAssertEqual(error as? NotificationsLenientDecodeError, .httpError(status: 500))
        }
    }

    // MARK: - Open

    func testOpenPostsToTheIdPathAndDecodesTheEchoedNotification() async throws {
        let recorder = WireRecorder()
        let echoedBody = try JSONSerialization.data(withJSONObject: ["notification": notificationJSON(id: "n42", status: "OPENED")])
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, echoedBody) }

        let opened = try await NotificationsAPI.open(id: "n42", using: client)

        XCTAssertEqual(recorder.requests.first?.method, .post)
        XCTAssertEqual(recorder.requests.first?.path, "/notifications/n42/open")
        XCTAssertEqual(opened?.status, "OPENED")
    }

    func testOpenToleratesAnUndecodableSuccessBody() async throws {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (200, Data("not json".utf8)) }

        let opened = try await NotificationsAPI.open(id: "n1", using: client)

        XCTAssertNil(opened, "a 2xx with an undecodable echo is still a success — the optimistic row update already happened")
    }

    func testOpenThrowsOnTheHandlersNotFoundStatus() async {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in
            (404, try! JSONSerialization.data(withJSONObject: ["error": ["code": "NOTIFICATION_NOT_FOUND", "message": "Notification not found"]]))
        }

        do {
            _ = try await NotificationsAPI.open(id: "missing", using: client)
            XCTFail("expected httpError")
        } catch {
            XCTAssertEqual(error as? NotificationsLenientDecodeError, .httpError(status: 404))
        }
    }
}
