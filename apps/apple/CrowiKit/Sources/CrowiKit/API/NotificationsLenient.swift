import Foundation

/// RFC-0016 §11 (`feature-ios-phase3-notifications-extensions`) — lenient
/// decode of the four notification endpoints, all riding the ONE
/// per-workspace `AuthenticatedAPIClient` (never a second client or a bare
/// `URLSession` path):
///
///   GET  /notifications            — paginated list (newest first)
///   GET  /notifications/status     — unread count (= UNREAD rows) for the badge
///   POST /notifications/read       — mark-all-read: UNREAD → UNOPENED in bulk
///                                    (the badge zeroes; rows keep their
///                                    unopened highlight — web parity)
///   POST /notifications/{id}/open  — open ONE notification (status → OPENED),
///                                    the tap path
///
/// Wire truth: `packages/api/src/hono/handlers/notification.ts` +
/// `packages/api-contract/src/schemas/notification.ts`. Degrade rules
/// (the phase pin): a row missing its `target` degrades to a NON-NAVIGABLE
/// row; a row carrying an action this build doesn't know degrades only its
/// MESSAGE to the generic verb (navigation stays available while the target
/// is intact — the row is a page reference either way). A row is never
/// dropped from the list (`_id` alone is required, as the row identity every
/// other `*Lenient` decoder also insists on).
public enum NotificationsLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

/// One entry of `NotificationSchema.actionUsers` (`UserPublicSchema[]`) —
/// only what the row UI renders.
public struct NotificationActionUserLenient: Sendable, Equatable {
    public let username: String?
    public let name: String?
    /// Same-origin, Bearer-gated avatar path — displayed through the
    /// workspace's `WorkspaceImageFetching` conformer (`WorkspaceAvatarView`),
    /// never a bare unauthenticated image view (§6.1).
    public let image: String?

    /// Mirror of the web's `firstUser.name || firstUser.username`
    /// (`notification-format.ts`) — JS `||` treats an empty string as
    /// absent, hence the explicit `isEmpty` checks.
    public var displayName: String? {
        if let name, !name.isEmpty { return name }
        if let username, !username.isEmpty { return username }
        return nil
    }

    static func decode(_ object: [String: Any]) -> NotificationActionUserLenient {
        NotificationActionUserLenient(
            username: object["username"] as? String,
            name: object["name"] as? String,
            image: object["image"] as? String
        )
    }
}

public struct NotificationLenient: Sendable, Equatable, Identifiable {
    public var id: String { notificationId }
    public let notificationId: String
    /// The RAW action string (`COMMENT`/`LIKE`/`MENTION`/`UPDATE` today) —
    /// kept raw rather than an enum so a future server action degrades to a
    /// generic row instead of dropping it.
    public let action: String?
    /// `UNREAD`/`UNOPENED`/`OPENED` — raw for the same reason.
    public let status: String?
    /// `target.path` (`PageRefSchema`) — `nil` when the target is missing or
    /// degenerate (the handler emits `path: ''` for an unpopulated target),
    /// which makes the row non-navigable but still listed.
    public let targetPath: String?
    public let actionUsers: [NotificationActionUserLenient]
    public let createdAt: String?

    public init(
        notificationId: String,
        action: String?,
        status: String?,
        targetPath: String?,
        actionUsers: [NotificationActionUserLenient],
        createdAt: String?
    ) {
        self.notificationId = notificationId
        self.action = action
        self.status = status
        self.targetPath = targetPath
        self.actionUsers = actionUsers
        self.createdAt = createdAt
    }

    static func decode(_ object: [String: Any]) -> NotificationLenient? {
        guard let notificationId = object["_id"] as? String else { return nil }
        let target = object["target"] as? [String: Any]
        let rawPath = target?["path"] as? String
        let rawUsers = object["actionUsers"] as? [[String: Any]] ?? []
        return NotificationLenient(
            notificationId: notificationId,
            action: object["action"] as? String,
            status: object["status"] as? String,
            targetPath: (rawPath?.isEmpty == false) ? rawPath : nil,
            actionUsers: rawUsers.map(NotificationActionUserLenient.decode),
            createdAt: object["createdAt"] as? String
        )
    }

    /// Whether tapping this row can navigate anywhere — the phase's
    /// "target 欠落 → 非遷移 row" degrade gate. Navigability is solely about
    /// the target: an unknown ACTION degrades only the message wording
    /// (`messageText`'s generic verb), never navigation — pinned by
    /// `testRowWithAnUnknownActionIsKeptWithTheGenericMessage`.
    public var isNavigable: Bool { targetPath != nil }

    /// Mirror of the web's `isUnopenedNotification` — the row highlight/dot.
    /// UNREAD: never seen in any list; UNOPENED: seen (mark-all-read) but
    /// not opened. An unknown/missing status shows no highlight, same as the
    /// web's exact-match check.
    public var isUnopened: Bool { status == "UNREAD" || status == "UNOPENED" }

    /// A copy with `status` already OPENED — the list's optimistic row
    /// update when a tap fires the open POST (single-shot loose write, the
    /// `EngagementActions` discipline: navigation proceeds even if the POST
    /// fails, so the row reflects the intent immediately).
    public func opened() -> NotificationLenient {
        NotificationLenient(
            notificationId: notificationId,
            action: action,
            status: "OPENED",
            targetPath: targetPath,
            actionUsers: actionUsers,
            createdAt: createdAt
        )
    }

    /// WHO — "Bob", "Bob and 2 more", or "Someone" when the server sent no
    /// action users at all. Set in bold on its own, ahead of the verb, by the
    /// design's row.
    public var actorText: String {
        let user = actionUsers.first?.displayName ?? "Someone"
        return actionUsers.count > 1 ? "\(user) and \(actionUsers.count - 1) more" : user
    }

    /// WHAT — the web's `buildNotificationMessage` verbs, in this app's
    /// (currently English-only) UI voice. An action this build doesn't know
    /// gets the generic verb; the vocabulary is exactly the server's four
    /// types, never the richer set the design mocks.
    public var actionText: String {
        switch action {
        case "COMMENT": return "commented on"
        case "LIKE": return "liked"
        case "MENTION": return "mentioned you on"
        case "UPDATE": return "updated"
        default: return "acted on"
        }
    }

    /// WHERE — the page's short name (`PageRowTitleLabel.displayName`, the
    /// web's `pageDisplayName(target.path) || target.path`), or "a page" when
    /// the target is missing.
    public var pageText: String {
        guard let targetPath else { return "a page" }
        let display = PageRowTitleLabel.displayName(for: targetPath)
        return display.isEmpty ? targetPath : display
    }

    /// The three parts as ONE sentence — the pre-design row's whole content,
    /// kept because the design's three-part row is a VISUAL hierarchy and
    /// VoiceOver still needs the sentence. Composed from the parts above so
    /// the spoken row can never drift from the drawn one.
    public var messageText: String {
        let page = targetPath == nil ? pageText : "“\(pageText)”"
        return "\(actorText) \(actionText) \(page)"
    }
}

public struct ListNotificationsResponseLenient: Sendable, Equatable {
    public let notifications: [NotificationLenient]
    /// `pager.next` — the offset of the next page, `nil` on the last page
    /// (the handler over-fetches by +1 to derive it). `prev` exists on the
    /// wire but the load-more UI never walks backwards, so it isn't decoded.
    public let nextOffset: Int?

    public static func decode(_ data: Data) throws -> ListNotificationsResponseLenient {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NotificationsLenientDecodeError.notAnObject
        }
        let rawNotifications = object["notifications"] as? [[String: Any]] ?? []
        let pager = object["pager"] as? [String: Any]
        return ListNotificationsResponseLenient(
            notifications: rawNotifications.compactMap(NotificationLenient.decode),
            nextOffset: pager?["next"] as? Int
        )
    }
}

/// The notifications screen's subtitle line — the design's
/// "{{ unreadLabel }} · swipe a row to mark read".
///
/// In CrowiKit rather than in the screen so the wording (and its plural) can
/// be asserted; the App target's manifest imports `AppleProductTypes`, which
/// the bare `swift` CLI running the tests cannot parse.
public enum NotificationsSummary {
    /// - Parameter unopenedCount: rows still showing a dot — deliberately the
    ///   UNOPENED count the list itself paints, not the badge's UNREAD count,
    ///   which mark-all-read zeroes while the dots stay.
    public static func subtitle(unopenedCount: Int) -> String {
        guard unopenedCount > 0 else {
            // The swipe hint goes with it: there is nothing left to swipe.
            return "You're all caught up"
        }
        let unit = unopenedCount == 1 ? "notification" : "notifications"
        return "\(unopenedCount) unread \(unit) · swipe a row to mark read"
    }
}

public struct NotificationsStatusLenient: Sendable, Equatable {
    public let count: Int

    /// `count` missing/undecodable THROWS rather than degrading — a badge
    /// count has no safe fallback (degrading to `0` would silently clear a
    /// real unread badge, the exact opposite of lenient).
    public static func decode(_ data: Data) throws -> NotificationsStatusLenient {
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let count = object["count"] as? Int
        else {
            throw NotificationsLenientDecodeError.notAnObject
        }
        return NotificationsStatusLenient(count: count)
    }
}

/// The `AuthenticatedAPIClient` fetch/post helpers, gathered under one
/// namespace since the poller, the badge and the list screen mix all four
/// calls.
public enum NotificationsAPI {
    private struct EmptyJSONBody: Encodable {}

    public static func fetchList(limit: Int = 20, offset: Int = 0, using client: AuthenticatedAPIClient) async throws
        -> ListNotificationsResponseLenient
    {
        let (data, status) = try await client.get(
            "notifications",
            query: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "offset", value: String(offset)),
            ]
        )
        guard status.isSuccessfulHTTPStatus else { throw NotificationsLenientDecodeError.httpError(status: status) }
        return try ListNotificationsResponseLenient.decode(data)
    }

    public static func fetchUnreadCount(using client: AuthenticatedAPIClient) async throws -> Int {
        let (data, status) = try await client.get("notifications/status")
        guard status.isSuccessfulHTTPStatus else { throw NotificationsLenientDecodeError.httpError(status: status) }
        return try NotificationsStatusLenient.decode(data).count
    }

    /// `POST /notifications/read` — bulk UNREAD → UNOPENED. The `{ ok: true }`
    /// body carries nothing beyond the status, so a 2xx IS the success
    /// signal.
    public static func markAllRead(using client: AuthenticatedAPIClient) async throws {
        let (_, status) = try await client.post("notifications/read", json: EmptyJSONBody())
        guard status.isSuccessfulHTTPStatus else { throw NotificationsLenientDecodeError.httpError(status: status) }
    }

    /// `POST /notifications/{id}/open` — the tap path (status → OPENED).
    /// Returns the server's echoed, updated notification, or `nil` when the
    /// 2xx body couldn't be decoded (tolerated — the caller's optimistic row
    /// update already happened; this is a single-shot loose write with no
    /// conflict model). Non-2xx throws, which callers absorb (`try?`) since
    /// navigation must proceed regardless.
    @discardableResult
    public static func open(id: String, using client: AuthenticatedAPIClient) async throws -> NotificationLenient? {
        let (data, status) = try await client.post("notifications/\(id)/open", json: EmptyJSONBody())
        guard status.isSuccessfulHTTPStatus else { throw NotificationsLenientDecodeError.httpError(status: status) }
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let notification = object["notification"] as? [String: Any]
        else { return nil }
        return NotificationLenient.decode(notification)
    }
}
