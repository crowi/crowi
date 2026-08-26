import XCTest

@testable import CrowiKit

/// RFC-0021 — the merged page-history timeline decoder. One test per row
/// kind, plus the degrade paths that matter once this is a mixed-kind feed
/// rather than a single homogeneous list: a pending content row, an unknown
/// event kind, and pagination.
final class PageHistoryLenientTests: XCTestCase {
    func testDecodesAContentRevisionRow() throws {
        let json = """
        { "entries": [ { "type": "content_revision", "id": "e1", "sequence": 3, "occurredAt": "2026-01-01T00:00:00.000Z",
          "actor": { "name": "Sotaro", "username": "sotarok" }, "revisionId": "r1", "editVia": "web" } ],
          "nextCursor": null, "tracking": { "state": "untracked" } }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        guard case .contentRevision(let row) = try XCTUnwrap(response.entries.first) else {
            return XCTFail("expected a content_revision row")
        }
        XCTAssertEqual(row.revisionId, "r1")
        XCTAssertEqual(row.displayName, "Sotaro")
        XCTAssertFalse(row.isAPIEdit)
        XCTAssertFalse(row.pending)
    }

    /// `savedBy ?? actor`, applied to the WHOLE user — a row carrying both
    /// must not print one person's name beside the other's avatar. This is
    /// the web's own rule (`page-history.tsx`: `entry.savedBy ?? entry.actor`),
    /// made once at the wire boundary so the row cannot re-derive it
    /// differently.
    func testAContentRowShowsSavedByAsOneWholePersonNotAMixOfTwo() throws {
        let json = """
        { "entries": [ { "type": "content_revision", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "revisionId": "r1",
          "actor": { "username": "old", "name": "Old Author", "image": "/old.png" },
          "savedBy": { "username": "sotarok", "name": "Sotaro", "image": "/new.png" } } ] }
        """
        guard case .contentRevision(let row) = try XCTUnwrap(try PageHistoryResponseLenient.decode(Data(json.utf8)).entries.first) else {
            return XCTFail("expected a content_revision row")
        }

        XCTAssertEqual(row.displayName, "Sotaro")
        XCTAssertEqual(row.actorUsername, "sotarok")
        XCTAssertEqual(row.actorImage, "/new.png", "the avatar must come from the same person as the name")
    }

    /// No `savedBy` at all (a v1.x revision, or the collab saver was never
    /// recorded) — the row falls back to `actor` whole.
    func testAContentRowWithoutSavedByFallsBackToTheActor() throws {
        let json = """
        { "entries": [ { "type": "content_revision", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "revisionId": "r1",
          "actor": { "username": "old", "name": "Old Author", "image": "/old.png" } } ] }
        """
        guard case .contentRevision(let row) = try XCTUnwrap(try PageHistoryResponseLenient.decode(Data(json.utf8)).entries.first) else {
            return XCTFail("expected a content_revision row")
        }

        XCTAssertEqual(row.displayName, "Old Author")
        XCTAssertEqual(row.actorImage, "/old.png")
    }

    /// Still in the page's outbox — no durable revision yet. Must decode
    /// (never dropped), but callers are expected to exclude it from
    /// tap-to-view and compare selection.
    func testAPendingContentRevisionRowDecodes() throws {
        let json = """
        { "entries": [ { "type": "content_revision", "id": "e1", "sequence": null, "occurredAt": "2026-01-01T00:00:00.000Z",
          "actor": null, "revisionId": "r1", "pending": true } ] }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        guard case .contentRevision(let row) = try XCTUnwrap(response.entries.first) else {
            return XCTFail("expected a content_revision row")
        }
        XCTAssertTrue(row.pending)
    }

    func testDecodesAPageRenamedEvent() throws {
        let json = """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "actor": { "name": "Sotaro" },
          "kind": "page_renamed", "operationId": "op1", "subtree": true,
          "payload": { "fromPath": "/old", "toPath": "/new", "redirectCreated": true } } ] }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        guard case .event(let row) = try XCTUnwrap(response.entries.first) else {
            return XCTFail("expected a page_event row")
        }
        XCTAssertEqual(row.kind, "page_renamed")
        XCTAssertTrue(row.subtree)
        XCTAssertEqual(row.fromPath, "/old")
        XCTAssertEqual(row.toPath, "/new")
        XCTAssertEqual(row.redirectCreated, true)

        let detail = try XCTUnwrap(PageHistoryEventMessage.detail(for: row))
        guard case .text(let text, let showsRedirectBadge) = detail else {
            return XCTFail("expected a text detail")
        }
        XCTAssertEqual(text, "/old → /new")
        XCTAssertTrue(showsRedirectBadge)
    }

    func testDecodesAVisibilityChangedEvent() throws {
        let json = """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "actor": null,
          "kind": "visibility_changed", "payload": { "fromGrant": 1, "toGrant": 2 } } ] }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        guard case .event(let row) = try XCTUnwrap(response.entries.first) else {
            return XCTFail("expected a page_event row")
        }
        let detail = try XCTUnwrap(PageHistoryEventMessage.detail(for: row))
        guard case .visibility(let fromLabel, let toLabel) = detail else {
            return XCTFail("expected a visibility detail")
        }
        XCTAssertEqual(fromLabel, "Public")
        XCTAssertEqual(toLabel, "Restricted")
    }

    func testDecodesPageTrashedAndRestoredEvents() throws {
        let trashed = try PageHistoryEventRowLenient.self.decodeFirst(fromEntries: """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z",
          "kind": "page_trashed", "payload": { "fromPath": "/x", "toPath": "/trash/x" } } ] }
        """)
        XCTAssertEqual(PageHistoryEventMessage.message(for: trashed.kind), "moved this page to trash")

        let restored = try PageHistoryEventRowLenient.self.decodeFirst(fromEntries: """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z",
          "kind": "page_restored", "payload": { "fromPath": "/trash/x", "toPath": "/x" } } ] }
        """)
        XCTAssertEqual(PageHistoryEventMessage.message(for: restored.kind), "restored this page")
    }

    func testDecodesPageCreatedAndDraftPublishedEventsWithNoDetail() throws {
        let created = try PageHistoryEventRowLenient.self.decodeFirst(fromEntries: """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "kind": "page_created", "payload": {} } ] }
        """)
        XCTAssertNil(PageHistoryEventMessage.detail(for: created))

        let published = try PageHistoryEventRowLenient.self.decodeFirst(fromEntries: """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "kind": "draft_published", "payload": {} } ] }
        """)
        XCTAssertNil(PageHistoryEventMessage.detail(for: published))
    }

    /// A kind this build has never heard of — a server ahead of the app —
    /// still decodes as a row (never dropped from the timeline) and gets a
    /// generic message rather than crashing on an unrecognized case.
    func testAnUnknownEventKindDegradesToAGenericRowRatherThanBeingDropped() throws {
        let row = try PageHistoryEventRowLenient.self.decodeFirst(fromEntries: """
        { "entries": [ { "type": "page_event", "id": "e1", "occurredAt": "2026-01-01T00:00:00.000Z", "kind": "page_teleported", "payload": {} } ] }
        """)
        XCTAssertEqual(row.kind, "page_teleported")
        XCTAssertEqual(PageHistoryEventMessage.message(for: row.kind), "changed this page")
        XCTAssertNil(PageHistoryEventMessage.detail(for: row))
    }

    /// A row of neither known `type` is dropped rather than throwing —
    /// same "skip a malformed row" stance `GetBacklinksResponseLenient`
    /// already takes.
    func testARowOfAnUnknownTypeIsSkippedRatherThanThrowing() throws {
        let json = """
        { "entries": [ { "type": "something_else", "id": "e1" } ] }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))
        XCTAssertTrue(response.entries.isEmpty)
    }

    func testDecodesTheNextCursorForPagination() throws {
        let json = """
        { "entries": [], "nextCursor": "opaque-cursor-1", "tracking": { "state": "ready", "trackingStartedAt": "2026-01-01T00:00:00.000Z" } }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.nextCursor, "opaque-cursor-1")
    }

    func testAnAbsentNextCursorMeansTheTimelineIsExhausted() throws {
        let json = """
        { "entries": [] }
        """
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))

        XCTAssertNil(response.nextCursor)
    }

    /// The internal cache round-trip (`CachedRevisionSummary`) — a mixed
    /// array of both row kinds must survive an encode/decode cycle intact.
    func testEntriesRoundTripThroughCodableForTheOfflineCache() throws {
        let content = PageHistoryContentRowLenient(
            id: "e1", sequence: 1, occurredAt: "2026-01-01T00:00:00.000Z",
            actorName: "Sotaro", actorUsername: "sotarok", actorImage: nil,
            revisionId: "r1", editVia: "web", pending: false
        )
        let event = PageHistoryEventRowLenient(
            id: "e2", sequence: nil, occurredAt: "2026-01-02T00:00:00.000Z",
            actorName: nil, actorUsername: nil, actorImage: nil,
            kind: "page_created", operationId: nil, subtree: false, pending: false,
            fromPath: nil, toPath: nil, redirectCreated: nil, fromGrant: nil, toGrant: nil
        )
        let entries: [PageHistoryEntryLenient] = [.contentRevision(content), .event(event)]

        let data = try JSONEncoder().encode(entries)
        let decoded = try JSONDecoder().decode([PageHistoryEntryLenient].self, from: data)

        XCTAssertEqual(decoded, entries)
    }
}

private struct UnexpectedEntryCase: Error {}

extension PageHistoryEventRowLenient {
    /// Test helper: decode the first entry of a one-entry timeline JSON
    /// string and unwrap it as an event row, or fail loudly.
    fileprivate static func decodeFirst(fromEntries json: String) throws -> PageHistoryEventRowLenient {
        let response = try PageHistoryResponseLenient.decode(Data(json.utf8))
        guard case .event(let row) = try XCTUnwrap(response.entries.first) else {
            XCTFail("expected a page_event row")
            throw UnexpectedEntryCase()
        }
        return row
    }
}
