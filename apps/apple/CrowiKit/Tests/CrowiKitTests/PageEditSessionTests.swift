import Foundation
import XCTest

@testable import CrowiKit

/// `feature-ios-phase2-write` §10 — the two CI-fixed quick-edit invariants:
///
///   1. **`revision_id`-required**: a `revision_id`-less `PUT /pages` is
///      unconstructible. Pinned at the type level (`PageEditSession` is the
///      sole PUT construction path; its private body struct's `revisionId`
///      is non-optional) and re-verified here at the WIRE level (every
///      recorded PUT carries `revision_id`), plus the constructor refuses
///      any detail response that cannot seed a lock.
///   2. **Conflict state machine**: stale `revision_id` fixture →
///      `PAGE_REVISION_ERROR` (HTTP 409) → current-revision re-fetch →
///      abort/discard by default, re-apply only as the explicit alternative.
final class PageEditSessionTests: XCTestCase {
    // MARK: - Fixtures

    /// `pageRevisionConflictBody()` (`handlers/page.ts`), verbatim.
    private let conflictBody = Data("""
        { "error": { "code": "PAGE_REVISION_ERROR", "message": "Revision error." } }
        """.utf8)

    private func detailData(id: String = "p1", path: String = "/team/eng", revisionId: String, body: String) -> Data {
        Data("""
            { "page": { "_id": "\(id)", "path": "\(path)", "revision": { "_id": "\(revisionId)", "body": "\(body)", "createdAt": "2026-07-24T00:00:00Z" } } }
            """.utf8)
    }

    private func detailResponse(revisionId: String = "rev-1", body: String = "seed body") throws -> GetPageResponseLenient {
        try GetPageResponseLenient.decode(detailData(revisionId: revisionId, body: body))
    }

    // MARK: - Invariant 1: unconstructible without a full detail revision

    @MainActor
    func testUnconstructibleFromABareStringRevisionOrMissingBody() throws {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (200, Data()) }

        // A list/children/portal row's revision is a bare id string — no
        // `body`, never a valid lock base (§8).
        let bareStringRevision = try GetPageResponseLenient.decode(Data("""
            { "page": { "_id": "p1", "path": "/team/eng", "revision": "rev-1" } }
            """.utf8))
        XCTAssertNil(PageEditSession(detail: bareStringRevision, client: client))

        // No revision at all.
        let noRevision = try GetPageResponseLenient.decode(Data("""
            { "page": { "_id": "p1", "path": "/team/eng" } }
            """.utf8))
        XCTAssertNil(PageEditSession(detail: noRevision, client: client))

        // The real detail shape seeds fine.
        let full = try detailResponse()
        let session = try XCTUnwrap(PageEditSession(detail: full, client: client))
        XCTAssertEqual(session.baseRevisionId, "rev-1")
        XCTAssertEqual(session.seedBody, "seed body")
        XCTAssertEqual(session.state, .editing)
    }

    // MARK: - Invariant 1 (wire): save always carries revision_id, never grant

    @MainActor
    func testSaveSendsTheBaseRevisionIdAndOmitsGrant() async throws {
        let recorder = WireRecorder()
        let savedDetail = detailData(revisionId: "rev-2", body: "edited body")
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, savedDetail) }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        let outcome = try await session.save(body: "edited body")

        guard case .saved(let page) = outcome else {
            return XCTFail("expected .saved, got \(outcome)")
        }
        XCTAssertEqual(page.revision?.id, "rev-2")
        XCTAssertEqual(session.state, .saved(page))

        XCTAssertEqual(recorder.requests.count, 1)
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .put)
        XCTAssertEqual(request.path, "/pages")
        XCTAssertEqual(request.contentType, "application/json")
        XCTAssertEqual(request.authorization, "Bearer the-token")
        let json = try XCTUnwrap(request.jsonObject)
        XCTAssertEqual(json["page_id"] as? String, "p1")
        XCTAssertEqual(json["body"] as? String, "edited body")
        XCTAssertEqual(json["revision_id"] as? String, "rev-1", "the lock base — the server only checks revision_id WHEN PRESENT, so the client must always send it")
        XCTAssertFalse(json.keys.contains("grant"), "omitting grant preserves the page's current grant; sending it is the (out-of-scope) grant-change path")
    }

    // MARK: - Invariant 2: the stale-revision conflict state machine

    @MainActor
    func testStaleRevisionConflictRefetchesTheCurrentRevisionAndDefaultsToAbort() async throws {
        let recorder = WireRecorder()
        let conflict = conflictBody
        let latestDetail = detailData(revisionId: "rev-9", body: "someone else's newer body")
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .put ? (409, conflict) : (200, latestDetail)
        }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        let outcome = try await session.save(body: "my edited body")

        // 409 → conflict, with the CURRENT revision re-fetched.
        guard case .conflict(let latest) = outcome else {
            return XCTFail("expected .conflict, got \(outcome)")
        }
        XCTAssertEqual(latest?.revision?.id, "rev-9")
        XCTAssertEqual(session.state, .conflict(latest: latest))
        XCTAssertEqual(recorder.requests.map(\.method), [.put, .get], "exactly one PUT then the re-fetch — never a second, silent PUT")
        XCTAssertEqual(recorder.requests[1].path, "/pages?page_id=p1")

        // A save over an unresolved conflict must refuse (no silent retry
        // path exists).
        let blocked = try await session.save(body: "my edited body")
        XCTAssertEqual(blocked, .failed(message: nil))
        XCTAssertEqual(recorder.requests.count, 2, "the refused save must not touch the wire")

        // Abort is the DEFAULT resolution: terminal, nothing written. It must
        // still hand back the OTHER person's revision — discarding chose
        // their version, so the reader has to end up showing THEIR body
        // instead of the pre-edit one it painted before the sheet opened.
        let adopted = session.discardConflict()
        XCTAssertEqual(adopted?.revision?.id, "rev-9")
        XCTAssertEqual(adopted?.revision?.body, "someone else's newer body")
        XCTAssertEqual(session.state, .discarded)
        XCTAssertEqual(recorder.requests.count, 2, "adopting their revision must reuse the conflict re-fetch, never spend another GET")
        XCTAssertNil(session.discardConflict(), "terminal: a second discard has no conflict left to resolve")
    }

    @MainActor
    func testReapplySwapsTheLockBaseToTheRefetchedRevisionForAnExplicitSecondSave() async throws {
        let recorder = WireRecorder()
        let conflict = conflictBody
        let latestDetail = detailData(revisionId: "rev-9", body: "their body")
        let savedDetail = detailData(revisionId: "rev-10", body: "my edited body")
        let client = makeWireRecordedClient(recorder: recorder) { request in
            if request.method == .put {
                // First PUT (base rev-1) conflicts; the re-applied PUT
                // (base rev-9) succeeds.
                return request.jsonObject?["revision_id"] as? String == "rev-9" ? (200, savedDetail) : (409, conflict)
            }
            return (200, latestDetail)
        }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        _ = try await session.save(body: "my edited body")
        XCTAssertTrue(session.reapplyOnLatest())
        XCTAssertEqual(session.baseRevisionId, "rev-9", "re-apply swaps the lock base to the re-fetched revision")
        XCTAssertEqual(session.state, .editing, "the user's text stays in the editor for an EXPLICIT second save")

        let outcome = try await session.save(body: "my edited body")

        guard case .saved = outcome else {
            return XCTFail("expected .saved after re-apply, got \(outcome)")
        }
        let puts = recorder.requests.filter { $0.method == .put }
        XCTAssertEqual(puts.count, 2)
        XCTAssertEqual(puts[1].jsonObject?["revision_id"] as? String, "rev-9")
        // The §10 invariant at the wire: EVERY PUT this session ever built
        // carried a revision_id.
        for put in puts {
            XCTAssertNotNil(put.jsonObject?["revision_id"])
        }
    }

    @MainActor
    func testConflictWithAnsweredButUnusableRefetchStillConflictsAndCannotReapply() async throws {
        let recorder = WireRecorder()
        let conflict = conflictBody
        // The re-fetch is ANSWERED by the server (an HTTP-level failure —
        // e.g. the grant tightened concurrently, or a 5xx) — unlike a
        // transport failure (the test below), this degrades to a
        // discard-only conflict instead of throwing.
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .put ? (409, conflict) : (500, Data())
        }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        let outcome = try await session.save(body: "x")

        XCTAssertEqual(outcome, .conflict(latest: nil))
        XCTAssertFalse(session.reapplyOnLatest(), "no usable latest revision — discard is the only resolution")
        XCTAssertEqual(session.state, .conflict(latest: nil))
        XCTAssertNil(session.discardConflict(), "the re-fetch was unusable, so there is no newer revision for the reader to adopt")
        XCTAssertEqual(session.state, .discarded)
    }

    @MainActor
    func testConflictRefetchTransportFailureThrowsForManualRetryInsteadOfConflicting() async throws {
        let recorder = WireRecorder()
        let conflict = conflictBody
        let latestDetail = detailData(revisionId: "rev-9", body: "their body")
        // Every PUT conflicts. The FIRST conflict re-fetch dies at the
        // transport layer (offline/DNS — §7.4); the retried save's re-fetch
        // is back online. (The recorder records before the handler runs, so
        // "first GET" is observable from inside the handler.)
        let client = makeWireRecordedClient(recorder: recorder) { request in
            if request.method == .put { return (409, conflict) }
            if recorder.requests.filter({ $0.method == .get }).count == 1 {
                throw URLError(.notConnectedToInternet)
            }
            return (200, latestDetail)
        }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        // Losing connectivity during the re-fetch must NOT be absorbed into
        // a (discard-only) `.conflict(latest: nil)` — it throws, with the
        // session back at `.editing` for a manual save retry.
        do {
            _ = try await session.save(body: "my edited body")
            XCTFail("expected the re-fetch URLError to propagate (§7.4 fail-fast), not a .conflict absorb")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        XCTAssertEqual(session.state, .editing, "back to .editing so the user can retry the save manually")
        XCTAssertEqual(recorder.requests.map(\.method), [.put, .get])

        // The manual retry replays the whole attempt: PUT → 409 again → the
        // re-fetch now succeeds → the real conflict UX (re-apply available).
        let outcome = try await session.save(body: "my edited body")

        guard case .conflict(let latest) = outcome else {
            return XCTFail("expected .conflict on the retried save, got \(outcome)")
        }
        XCTAssertEqual(latest?.revision?.id, "rev-9")
        XCTAssertEqual(recorder.requests.map(\.method), [.put, .get, .put, .get])
    }

    // MARK: - Non-conflict failures

    @MainActor
    func testNonConflictHTTPFailureReturnsToEditingWithTheServerMessage() async throws {
        let recorder = WireRecorder()
        let errorBody = Data("""
            { "error": { "code": "PAGE_UPDATE_FAILED", "message": "Failed to update page" } }
            """.utf8)
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, errorBody) }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        let outcome = try await session.save(body: "x")

        XCTAssertEqual(outcome, .failed(message: "Failed to update page"))
        XCTAssertEqual(session.state, .editing, "a plain failure keeps the editor open for a manual retry")
    }

    @MainActor
    func testTransportFailureThrowsAndReturnsToEditing() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in throw URLError(.notConnectedToInternet) }
        let session = try XCTUnwrap(PageEditSession(detail: detailResponse(), client: client))

        do {
            _ = try await session.save(body: "x")
            XCTFail("expected the URLError to propagate (§7.4 fail-fast)")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        XCTAssertEqual(session.state, .editing)
    }
}
