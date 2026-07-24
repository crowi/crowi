import Foundation
import XCTest

@testable import CrowiKit

/// `feature-ios-phase2-write` — the single-shot engagement writes: exact
/// wire shapes (method / path / JSON body, exactly-once via `WireRecorder`)
/// plus `PageEngagementModel`'s optimistic-toggle + revert-on-failure
/// discipline (the web hooks' rollback behavior, testable here because the
/// model lives in CrowiKit, not the App target).
final class EngagementActionsTests: XCTestCase {
    private func pageEchoBody(likerCount: Int) -> Data {
        Data("""
            { "page": { "_id": "p1", "path": "/team/eng", "likerCount": \(likerCount), "revision": "rev-1" } }
            """.utf8)
    }

    // MARK: - Wire shapes

    func testLikePostsThePageIdAndDecodesTheEchoedPage() async throws {
        let recorder = WireRecorder()
        let echo = pageEchoBody(likerCount: 3)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, echo) }

        let page = try await EngagementActions(client: client).like(pageId: "p1")

        XCTAssertEqual(page.likerCount, 3)
        XCTAssertEqual(recorder.requests.count, 1, "exactly one wire request per toggle")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/pages/like")
        XCTAssertEqual(request.contentType, "application/json")
        XCTAssertEqual(request.authorization, "Bearer the-token")
        XCTAssertEqual(request.jsonObject?["page_id"] as? String, "p1")
    }

    func testUnlikePostsToTheUnlikePath() async throws {
        let recorder = WireRecorder()
        let echo = pageEchoBody(likerCount: 0)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, echo) }

        _ = try await EngagementActions(client: client).unlike(pageId: "p1")

        XCTAssertEqual(recorder.requests.first?.path, "/pages/unlike")
    }

    func testMarkSeenPostsThePageIdOnceAndDecodesTheEchoedCount() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data("{ \"seenUsersCount\": 5 }".utf8)) }

        let count = try await EngagementActions(client: client).markSeen(pageId: "p1")

        XCTAssertEqual(count, 5)
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(recorder.requests.first?.method, .post)
        XCTAssertEqual(recorder.requests.first?.path, "/pages/seen")
        XCTAssertEqual(recorder.requests.first?.jsonObject?["page_id"] as? String, "p1")
    }

    func testMarkSeenThrowsTheDecodedWriteRequestErrorOnFailure() async {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (500, Data()) }

        do {
            _ = try await EngagementActions(client: client).markSeen(pageId: "p1")
            XCTFail("expected WriteRequestError")
        } catch let error as WriteRequestError {
            XCTAssertEqual(error.status, 500)
        } catch {
            XCTFail("expected WriteRequestError, got \(error)")
        }
    }

    func testWatchStatusGetsAndSetWatchingPutsTheWatchEndpoint() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { request in
            (200, Data("{ \"watching\": \(request.method == .put) }".utf8))
        }
        let actions = EngagementActions(client: client)

        let initial = try await actions.watchStatus(pageId: "p1")
        let updated = try await actions.setWatching(pageId: "p1", watching: true)

        XCTAssertFalse(initial)
        XCTAssertTrue(updated)
        XCTAssertEqual(recorder.requests.map(\.method), [.get, .put])
        XCTAssertEqual(recorder.requests[0].path, "/pages/watch?page_id=p1")
        XCTAssertEqual(recorder.requests[1].path, "/pages/watch")
        XCTAssertEqual(recorder.requests[1].jsonObject?["page_id"] as? String, "p1")
        XCTAssertEqual(recorder.requests[1].jsonObject?["watching"] as? Bool, true)
    }

    func testBookmarkAddPostsAndRemoveDeletesWithTheJSONBody() async throws {
        let recorder = WireRecorder()
        // `addBookmark` requires a non-null `bookmark` in the POST response
        // to consider the write successful (see `testAddBookmarkThrows...`
        // below) — `removeBookmark`'s contract is always `{ ok: true }`.
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .post
                ? (200, Data("{ \"bookmark\": { \"_id\": \"b1\" } }".utf8))
                : (200, Data("{ \"ok\": true }".utf8))
        }
        let actions = EngagementActions(client: client)

        try await actions.addBookmark(pageId: "p1")
        try await actions.removeBookmark(pageId: "p1")

        XCTAssertEqual(recorder.requests.map(\.method), [.post, .delete])
        XCTAssertEqual(recorder.requests.map(\.path), ["/bookmarks", "/bookmarks"])
        for request in recorder.requests {
            XCTAssertEqual(request.jsonObject?["page_id"] as? String, "p1")
        }
    }

    /// `bookmark.ts`'s `addBookmarkRoute` intentionally answers
    /// `200 { bookmark: null }` (not 404) when the page disappeared or the
    /// grant was revoked between page-view and the bookmark click. A 2xx
    /// status alone must not be read as success.
    func testAddBookmarkThrowsWhenServerRespondsBookmarkNull() async {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data("{ \"bookmark\": null }".utf8)) }

        do {
            try await EngagementActions(client: client).addBookmark(pageId: "p1")
            XCTFail("expected BookmarkNotCreated")
        } catch is BookmarkNotCreated {
            // expected
        } catch {
            XCTFail("expected BookmarkNotCreated, got \(error)")
        }
    }

    @MainActor
    func testToggleBookmarkRevertsWhenAddBookmarkRespondsBookmarkNull() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data("{ \"bookmark\": null }".utf8)) }
        let model = PageEngagementModel(
            pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 0,
            actions: EngagementActions(client: client))

        await model.toggleBookmark()

        XCTAssertFalse(model.isBookmarked, "a 200 {bookmark: null} must revert the optimistic bookmark, not stick")
        XCTAssertTrue(model.lastActionFailed)
        XCTAssertEqual(recorder.requests.map(\.path), ["/bookmarks"])
    }

    func testPostCommentSendsPlainBodyOnlyAndNeverAnAnchorField() async throws {
        let recorder = WireRecorder()
        let responseBody = Data(
            """
            { "comment": { "_id": "c1", "comment": "nice page", "creator": { "username": "bob", "name": "Bob" }, "createdAt": "2026-07-24T00:00:00Z" }, "newlyWatching": true }
            """.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, responseBody) }

        let comment = try await EngagementActions(client: client).postComment(pageId: "p1", revisionId: "rev-1", comment: "nice page")

        XCTAssertEqual(comment?.commentId, "c1")
        XCTAssertEqual(comment?.creatorUsername, "bob")
        XCTAssertEqual(recorder.requests.count, 1)
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/comments")
        let json = try XCTUnwrap(request.jsonObject)
        XCTAssertEqual(json["page_id"] as? String, "p1")
        XCTAssertEqual(json["revision_id"] as? String, "rev-1")
        XCTAssertEqual(json["comment"] as? String, "nice page")
        // RFC-0018 anchors are web-only — the app must never send anchor
        // fields, and the body struct has no such property to begin with.
        XCTAssertEqual(Set(json.keys), ["page_id", "revision_id", "comment"])
    }

    func testNon2xxThrowsTheDecodedWriteRequestError() async {
        let recorder = WireRecorder()
        let errorBody = Data("""
            { "error": { "code": "PAGE_NOT_FOUND", "message": "Page not found" } }
            """.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (404, errorBody) }

        do {
            _ = try await EngagementActions(client: client).like(pageId: "p1")
            XCTFail("expected WriteRequestError")
        } catch let error as WriteRequestError {
            XCTAssertEqual(error, WriteRequestError(status: 404, code: "PAGE_NOT_FOUND", message: "Page not found"))
        } catch {
            XCTFail("expected WriteRequestError, got \(error)")
        }
    }

    // MARK: - PageEngagementModel: optimistic toggle + revert on failure

    @MainActor
    func testToggleLikeSettlesOnTheServerCountOnSuccess() async throws {
        let recorder = WireRecorder()
        let echo = pageEchoBody(likerCount: 8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, echo) }
        let model = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 4, isBookmarked: false, isWatching: false, seenUsersCount: 0, actions: EngagementActions(client: client))

        await model.toggleLike()

        XCTAssertTrue(model.likedByMe)
        XCTAssertEqual(model.likerCount, 8, "settles on the echoed page's authoritative count")
        XCTAssertFalse(model.lastActionFailed)
        XCTAssertEqual(recorder.requests.map(\.path), ["/pages/like"])
    }

    @MainActor
    func testToggleLikeRevertsBothFlagAndCountOnFailure() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (500, Data()) }
        let model = PageEngagementModel(pageId: "p1", likedByMe: true, likerCount: 4, isBookmarked: false, isWatching: false, seenUsersCount: 0, actions: EngagementActions(client: client))

        await model.toggleLike()

        XCTAssertTrue(model.likedByMe, "reverted to the pre-toggle state")
        XCTAssertEqual(model.likerCount, 4)
        XCTAssertTrue(model.lastActionFailed)
        XCTAssertEqual(recorder.requests.map(\.path), ["/pages/unlike"], "a liked page toggles via unlike")
    }

    @MainActor
    func testToggleBookmarkRevertsOnFailure() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (500, Data()) }
        let model = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 0, actions: EngagementActions(client: client))

        await model.toggleBookmark()

        XCTAssertFalse(model.isBookmarked)
        XCTAssertTrue(model.lastActionFailed)
    }

    // MARK: - PageEngagementModel: duplicate taps while a toggle is in flight

    // A shared `Gate` parks the mock transport's response until the test
    // releases it — the deterministic "request in flight" point the
    // duplicate-tap tests need (a second tap is only meaningfully "rapid"
    // while the first one's write has reached the wire but not answered).

    /// Runs the double-tap's SECOND tap and asserts it no-ops (no second
    /// wire request) — expressed as "the tap finished before any new
    /// request appeared" rather than a bare await, so a broken guard fails
    /// this assertion cleanly instead of deadlocking the test on the latch.
    @MainActor
    private func assertDuplicateTapNoOps(
        _ tap: @escaping @MainActor () async -> Void,
        recorder: WireRecorder,
        requestsSoFar: Int,
        _ message: String
    ) async -> Task<Void, Never> {
        final class Done { var value = false }
        let done = Done()
        let secondTap = Task { @MainActor in
            await tap()
            done.value = true
        }
        while !done.value && recorder.requests.count == requestsSoFar { await Task.yield() }
        XCTAssertEqual(recorder.requests.count, requestsSoFar, message)
        XCTAssertTrue(done.value, "the duplicate tap must return immediately as a no-op")
        return secondTap
    }

    @MainActor
    func testRapidDoubleTapLikeSendsExactlyOneRequest() async throws {
        let recorder = WireRecorder()
        let latch = Gate()
        let echo = pageEchoBody(likerCount: 1)
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            await latch.wait()
            return (200, echo)
        }
        let model = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 0, actions: EngagementActions(client: client))

        let firstTap = Task { await model.toggleLike() }
        // Deterministic in-flight point: the first tap's request has REACHED
        // the transport (recorded) and is parked on the latch, so the guard
        // flag cannot reset until the latch opens.
        while recorder.requests.isEmpty { await Task.yield() }
        XCTAssertTrue(model.isTogglingLike, "the UI disables the button off this flag")

        // The double-tap's second tap: without the in-flight guard this
        // would race a parallel `unlike` (the optimistic state already
        // flipped) whose response order diverges client and server.
        let secondTap = await assertDuplicateTapNoOps(
            { await model.toggleLike() }, recorder: recorder, requestsSoFar: 1,
            "the second tap must no-op, never a parallel like/unlike")

        await latch.open()
        await firstTap.value
        await secondTap.value

        XCTAssertFalse(model.isTogglingLike)
        XCTAssertTrue(model.likedByMe)
        XCTAssertEqual(model.likerCount, 1)
        XCTAssertEqual(recorder.requests.map(\.path), ["/pages/like"], "exactly one wire request for the whole double-tap")
    }

    @MainActor
    func testBookmarkAndWatchDoubleTapsAlsoNoOpWhileTheirOwnWriteIsInFlight() async throws {
        let recorder = WireRecorder()
        let latch = Gate()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            await latch.wait()
            return (200, Data("{ \"watching\": true, \"ok\": true, \"bookmark\": { \"_id\": \"b1\" } }".utf8))
        }
        let model = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 0, actions: EngagementActions(client: client))

        let bookmarkTap = Task { await model.toggleBookmark() }
        while recorder.requests.isEmpty { await Task.yield() }
        XCTAssertTrue(model.isTogglingBookmark)
        let duplicateBookmarkTap = await assertDuplicateTapNoOps(
            { await model.toggleBookmark() }, recorder: recorder, requestsSoFar: 1,
            "the duplicate bookmark tap must no-op")

        // A DIFFERENT toggle stays independent (disjoint state, disjoint
        // endpoint) — watch proceeds while bookmark is still in flight…
        let watchTap = Task { await model.toggleWatch() }
        while recorder.requests.count < 2 { await Task.yield() }
        XCTAssertTrue(model.isTogglingWatch)
        // …but its OWN duplicate tap no-ops too.
        let duplicateWatchTap = await assertDuplicateTapNoOps(
            { await model.toggleWatch() }, recorder: recorder, requestsSoFar: 2,
            "the duplicate watch tap must no-op")

        await latch.open()
        await bookmarkTap.value
        await watchTap.value
        await duplicateBookmarkTap.value
        await duplicateWatchTap.value

        XCTAssertFalse(model.isTogglingBookmark)
        XCTAssertFalse(model.isTogglingWatch)
        XCTAssertTrue(model.isBookmarked)
        XCTAssertTrue(model.isWatching)
        XCTAssertEqual(recorder.requests.map(\.path), ["/bookmarks", "/pages/watch"])
    }

    @MainActor
    func testToggleWatchRevertsOnFailureAndSettlesOnTheEchoOnSuccess() async throws {
        let failingRecorder = WireRecorder()
        let failingClient = makeWireRecordedClient(recorder: failingRecorder) { _ in (500, Data()) }
        let failing = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: true, seenUsersCount: 0, actions: EngagementActions(client: failingClient))

        await failing.toggleWatch()

        XCTAssertTrue(failing.isWatching, "reverted")
        XCTAssertTrue(failing.lastActionFailed)

        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { request in
            (200, Data("{ \"watching\": \(request.jsonObject?["watching"] as? Bool ?? false) }".utf8))
        }
        let model = PageEngagementModel(pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: true, seenUsersCount: 0, actions: EngagementActions(client: client))

        await model.toggleWatch()

        XCTAssertFalse(model.isWatching)
        XCTAssertEqual(recorder.requests.first?.jsonObject?["watching"] as? Bool, false)
    }

    // MARK: - PageEngagementModel: markSeen settle (no stale "seen" state on failure)

    /// `PageReaderView.load()` never applies an optimistic bump before the
    /// mark-seen call settles, so a `nil` result (the request threw) must
    /// leave `seenUsersCount` exactly where it started — the "not (yet)
    /// counted" state, never silently treated as success. Ruling: spec
    /// `feature-ios-phase2-write.md:27`'s toggle semantics.
    @MainActor
    func testApplySeenMarkResultLeavesTheCountUnchangedOnFailure() {
        let model = PageEngagementModel(
            pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 4,
            actions: EngagementActions(client: makeWireRecordedClient(recorder: WireRecorder()) { _ in (500, Data()) }))

        model.applySeenMarkResult(nil)

        XCTAssertEqual(model.seenUsersCount, 4, "no stale/phantom seen count on a failed mark")
    }

    @MainActor
    func testApplySeenMarkResultSettlesOnTheServerCountOnSuccess() {
        let model = PageEngagementModel(
            pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 4,
            actions: EngagementActions(client: makeWireRecordedClient(recorder: WireRecorder()) { _ in (200, Data()) }))

        model.applySeenMarkResult(5)

        XCTAssertEqual(model.seenUsersCount, 5)
    }

    @MainActor
    func testLoadWiresMarkSeenThroughEngagementAndRevertsOnFailure() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (500, Data()) }
        let model = PageEngagementModel(
            pageId: "p1", likedByMe: false, likerCount: 0, isBookmarked: false, isWatching: false, seenUsersCount: 2,
            actions: EngagementActions(client: client))

        // Mirrors `PageReaderView.load()`'s call-site pattern exactly: a
        // thrown error is turned into `nil` via `try?`, then applied.
        let result: Int? = try? await EngagementActions(client: client).markSeen(pageId: "p1")
        model.applySeenMarkResult(result)

        XCTAssertEqual(model.seenUsersCount, 2, "a failed mark-seen leaves the pre-mark count in place")
    }
}
