import Foundation
import Observation

/// RFC-0016 §8 / `feature-ios-phase2-write` — the single-shot engagement
/// writes: like/unlike, seen, watch, bookmark, comment post. These have NO
/// conflict model (unlike quick-edit) — every call either succeeds or
/// throws, and the optimistic-UI + revert-on-failure discipline lives in
/// `PageEngagementModel` below (matching the web's `use-like` /
/// `use-bookmark` / `use-watch` hooks). A non-2xx response throws
/// `WriteRequestError` (the shared envelope decode); a transport failure
/// propagates as the raw `URLError` (§7.4 fail-fast, manual retry).
///
/// Colocated with the corresponding read fetches' decode models
/// (`GetPageResponseLenient` for like/unlike's `{ page }` echo,
/// `CommentLenient` for the posted comment) so the wire models stay
/// single-sourced.
public struct EngagementActions: Sendable {
    private let client: AuthenticatedAPIClient

    public init(client: AuthenticatedAPIClient) {
        self.client = client
    }

    private struct PageIdBody: Encodable {
        let pageId: String

        enum CodingKeys: String, CodingKey {
            case pageId = "page_id"
        }
    }

    private struct WatchBody: Encodable {
        let pageId: String
        let watching: Bool

        enum CodingKeys: String, CodingKey {
            case pageId = "page_id"
            case watching
        }
    }

    /// The `POST /comments` body (`AddCommentRequestSchema`): `page_id` +
    /// `revision_id` (both required server-side) + the plain `comment`
    /// text. Deliberately NO `comment_position` property exists — RFC-0018
    /// comment anchors are a web-only feature and the app must never send
    /// anchor fields (spec pin).
    private struct CommentBody: Encodable {
        let pageId: String
        let revisionId: String
        let comment: String

        enum CodingKeys: String, CodingKey {
            case pageId = "page_id"
            case revisionId = "revision_id"
            case comment
        }
    }

    /// `POST /pages/like` — returns the echoed `{ page }` (updated liker
    /// list/count) so the caller can settle its optimistic state on the
    /// server's authoritative numbers.
    @discardableResult
    public func like(pageId: String) async throws -> PageLenient {
        try await pageEcho(post: "pages/like", pageId: pageId)
    }

    /// `POST /pages/unlike` — see `like`.
    @discardableResult
    public func unlike(pageId: String) async throws -> PageLenient {
        try await pageEcho(post: "pages/unlike", pageId: pageId)
    }

    /// `POST /pages/seen` — idempotent server-side (`addToSet`), so the
    /// reader marks a page seen on every successful open, exactly like the
    /// web viewer, with no "already seen" bookkeeping. Returns the echoed
    /// `seenUsersCount` (`nil` if the success body couldn't be decoded) so
    /// the caller can settle its optimistic count on the server's
    /// authoritative number, mirroring `like`/`unlike`'s page echo.
    @discardableResult
    public func markSeen(pageId: String) async throws -> Int? {
        let data = try Self.successData(await client.post("pages/seen", json: PageIdBody(pageId: pageId)))
        return Self.decodeSeenUsersCount(data)
    }

    /// `GET /pages/watch` → `{ watching }` — the initial toggle state
    /// (colocated with `setWatching` so the tiny response decode is
    /// declared once).
    public func watchStatus(pageId: String) async throws -> Bool {
        let data = try Self.successData(await client.get("pages/watch", query: [URLQueryItem(name: "page_id", value: pageId)]))
        return Self.decodeWatching(data) ?? false
    }

    /// `PUT /pages/watch` `{ page_id, watching }` → `{ watching }`.
    @discardableResult
    public func setWatching(pageId: String, watching: Bool) async throws -> Bool {
        let data = try Self.successData(await client.put("pages/watch", json: WatchBody(pageId: pageId, watching: watching)))
        return Self.decodeWatching(data) ?? watching
    }

    /// `POST /bookmarks` `{ page_id }`. `addBookmarkRoute`
    /// (`packages/api/src/hono/handlers/bookmark.ts`) INTENTIONALLY answers
    /// `200 { bookmark: null }` instead of 404 when the page disappeared or
    /// the grant was revoked between page-view and the bookmark click
    /// (legacy-compat: the UI never surfaces a 404 there). A 2xx status
    /// alone is therefore not proof a bookmark was actually created — decode
    /// the body and throw `BookmarkNotCreated` on a `null`/missing
    /// `bookmark` so the caller's optimistic revert path (`toggleBookmark`)
    /// fires instead of leaving a "bookmarked" UI state for something that
    /// never happened server-side.
    public func addBookmark(pageId: String) async throws {
        let data = try Self.successData(await client.post("bookmarks", json: PageIdBody(pageId: pageId)))
        guard Self.decodeBookmarkIsNonNull(data) else {
            throw BookmarkNotCreated()
        }
    }

    /// `DELETE /bookmarks` `{ page_id }`.
    public func removeBookmark(pageId: String) async throws {
        _ = try Self.successData(await client.delete("bookmarks", json: PageIdBody(pageId: pageId)))
    }

    /// `POST /comments` — returns the created comment (lenient: `nil` if
    /// the success body couldn't be decoded; the caller's refresh through
    /// the existing comments fetch is the source of truth either way).
    @discardableResult
    public func postComment(pageId: String, revisionId: String, comment: String) async throws -> CommentLenient? {
        let data = try Self.successData(await client.post("comments", json: CommentBody(pageId: pageId, revisionId: revisionId, comment: comment)))
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let commentObject = object["comment"] as? [String: Any]
        else {
            return nil
        }
        return CommentLenient.decode(commentObject)
    }

    private func pageEcho(post path: String, pageId: String) async throws -> PageLenient {
        let data = try Self.successData(await client.post(path, json: PageIdBody(pageId: pageId)))
        return try GetPageResponseLenient.decode(data).page
    }

    /// The one place the doc comment's contract lives: a non-2xx response
    /// throws the decoded `WriteRequestError`; a 2xx passes its body through.
    private static func successData(_ response: (data: Data, status: Int)) throws -> Data {
        guard response.status.isSuccessfulHTTPStatus else {
            throw WriteRequestError.from(status: response.status, data: response.data)
        }
        return response.data
    }

    private static func decodeWatching(_ data: Data) -> Bool? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return object["watching"] as? Bool
    }

    /// `true` only when the body decodes AND carries a non-null `bookmark`.
    /// An undecodable body degrades to `false` (fail-closed) rather than
    /// the usual lenient-decode "assume the happy path" — this is a WRITE
    /// confirmation, not a read render, so failing to positively confirm a
    /// created bookmark must never be read as success.
    private static func decodeBookmarkIsNonNull(_ data: Data) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let bookmarkValue = object["bookmark"]
        else {
            return false
        }
        return !(bookmarkValue is NSNull)
    }

    private static func decodeSeenUsersCount(_ data: Data) -> Int? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return object["seenUsersCount"] as? Int
    }
}

/// Thrown by `addBookmark` when the server's 2xx body carries `{ bookmark: null }`
/// (see the doc comment on `addBookmark` for why the server does this on
/// purpose). Distinct from `WriteRequestError` because the HTTP layer saw a
/// 2xx — this is a body-level "didn't actually happen", not a status-level
/// failure.
public struct BookmarkNotCreated: Error, Sendable, Equatable {
    public init() {}
}

/// The optimistic-toggle state machine `PageReaderView`'s engagement bar
/// drives: flip the UI immediately, call the single-shot write, settle on
/// the server echo on success, REVERT on any failure (the web hooks'
/// `onError` rollback, §8's "楽観更新 + 失敗時 revert で可"). Each toggle
/// is additionally guarded against DUPLICATE in-flight calls: a rapid
/// double-tap must never race a like against an unlike whose response
/// order would diverge the client and server state, so a toggle called
/// while its own write is still in flight is a no-op (and the UI disables
/// the button off the exposed `isToggling*` flags — distinct toggles stay
/// independent since they touch disjoint state on disjoint endpoints).
/// Lives in CrowiKit (not the App target) so the revert behavior is
/// directly testable from `CrowiKitTests` (`EngagementActionsTests`) — the
/// App target cannot be imported there.
@Observable
@MainActor
public final class PageEngagementModel {
    public private(set) var likedByMe: Bool
    public private(set) var likerCount: Int
    public private(set) var isBookmarked: Bool
    public private(set) var isWatching: Bool
    /// The `POST /pages/seen` mark-seen count, settled by
    /// `applySeenMarkResult` once `PageReaderView.load()`'s concurrent
    /// mark-seen call resolves. Initialized to the page's pre-mark count
    /// (the detail `GET` this view already ran) so a `nil` settle result
    /// leaves it unchanged rather than showing a phantom bump.
    public private(set) var seenUsersCount: Int
    /// Set on a failed toggle (after the revert) so the UI can surface a
    /// transient notice; cleared by the next successful one.
    public private(set) var lastActionFailed = false
    /// Per-toggle in-flight guards (set synchronously before the first
    /// suspension point — `@MainActor` makes the guard-then-set atomic
    /// against any second tap).
    public private(set) var isTogglingLike = false
    public private(set) var isTogglingBookmark = false
    public private(set) var isTogglingWatch = false

    private let pageId: String
    private let actions: EngagementActions

    public init(pageId: String, likedByMe: Bool, likerCount: Int, isBookmarked: Bool, isWatching: Bool, seenUsersCount: Int, actions: EngagementActions) {
        self.pageId = pageId
        self.likedByMe = likedByMe
        self.likerCount = likerCount
        self.isBookmarked = isBookmarked
        self.isWatching = isWatching
        self.seenUsersCount = seenUsersCount
        self.actions = actions
    }

    /// Applies the outcome of `PageReaderView.load()`'s concurrent
    /// `actions.markSeen(pageId:)` call once it resolves. `nil` (the
    /// request threw — `try?` at the call site turns that into `nil`, it
    /// is not swallowed further here) leaves `seenUsersCount` at its
    /// pre-mark value: this view never applies an optimistic bump before
    /// the call settles, so a failed mark simply stays "not (yet) counted"
    /// rather than silently being treated as success. A non-nil count
    /// settles on the server's authoritative value (mirrors `toggleLike`'s
    /// page-echo settle). Ruling: spec `feature-ios-phase2-write.md:27`
    /// classifies seen as a toggle (楽観更新 + 失敗時 revert で可) — §7.4's
    /// fail-fast + manual retry is for create/edit, not this best-effort
    /// read-side ping, so no error UI/retry is added here.
    public func applySeenMarkResult(_ count: Int?) {
        guard let count else { return }
        seenUsersCount = count
    }

    public func toggleLike() async {
        guard !isTogglingLike else { return }
        isTogglingLike = true
        defer { isTogglingLike = false }
        let wasLiked = likedByMe
        let previousCount = likerCount
        likedByMe = !wasLiked
        likerCount = max(0, previousCount + (wasLiked ? -1 : 1))
        do {
            let page = try await (wasLiked ? actions.unlike(pageId: pageId) : actions.like(pageId: pageId))
            // Settle on the server's authoritative count (another user may
            // have (un)liked concurrently).
            likerCount = page.likerCount ?? likerCount
            lastActionFailed = false
        } catch {
            likedByMe = wasLiked
            likerCount = previousCount
            lastActionFailed = true
        }
    }

    public func toggleBookmark() async {
        guard !isTogglingBookmark else { return }
        isTogglingBookmark = true
        defer { isTogglingBookmark = false }
        let wasBookmarked = isBookmarked
        isBookmarked = !wasBookmarked
        do {
            if wasBookmarked {
                try await actions.removeBookmark(pageId: pageId)
            } else {
                try await actions.addBookmark(pageId: pageId)
            }
            lastActionFailed = false
        } catch {
            isBookmarked = wasBookmarked
            lastActionFailed = true
        }
    }

    public func toggleWatch() async {
        guard !isTogglingWatch else { return }
        isTogglingWatch = true
        defer { isTogglingWatch = false }
        let wasWatching = isWatching
        isWatching = !wasWatching
        do {
            isWatching = try await actions.setWatching(pageId: pageId, watching: !wasWatching)
            lastActionFailed = false
        } catch {
            isWatching = wasWatching
            lastActionFailed = true
        }
    }
}
