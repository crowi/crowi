import Foundation
import HTTPTypes
import SwiftData
import XCTest

@testable import CrowiKit

/// RFC-0023 Phase 4 — the fallback matrix at the RESPONSE-DECODE seam
/// (`GetPageResponseLenient` → `PageRevisionLenient.renderedAst`), the
/// `X-Crowi-Ast-Version` wire declaration, and the online-only `CachedPage`
/// AST policy (wire-contract design §16).
final class RenderedAstFallbackTests: XCTestCase {
    private func pageJSON(revisionExtra: String = "") -> Data {
        Data(
            """
            {
              "page": {
                "_id": "p1",
                "path": "/wiki/setup",
                "status": "published",
                "revision": {
                  "_id": "r1",
                  "body": "# Setup",
                  "createdAt": "2026-07-30T00:00:00.000Z"\(revisionExtra)
                }
              }
            }
            """.utf8
        )
    }

    private let envelopeJSON = """
        ,
        "renderedAst": {
          "astVersion": 1,
          "root": {
            "type": "root",
            "children": [
              { "type": "heading", "depth": 1, "data": { "hProperties": { "id": "setup" } },
                "children": [ { "type": "text", "value": "Setup" } ] }
            ]
          }
        }
        """

    private let bareRootJSON = """
        ,
        "renderedAst": {
          "type": "root",
          "children": [ { "type": "heading", "depth": 1, "children": [ { "type": "text", "value": "Setup" } ] } ]
        }
        """

    // MARK: - the decode-side fallback matrix

    /// New API × new iOS: the envelope decodes and the typed path is primary.
    func testEnvelopeResponseDecodesIntoTheTypedPath() throws {
        let response = try GetPageResponseLenient.decode(pageJSON(revisionExtra: envelopeJSON))
        guard case .envelope(let document)? = response.page.revision?.renderedAst else {
            return XCTFail("expected the typed envelope path")
        }
        XCTAssertEqual(document.children.first?.kind, .heading(depth: 1))
        XCTAssertEqual(document.children.first?.data?.hPropertyString("id"), "setup", "the server-issued anchor id must survive")
        // The raw body stays available regardless — it IS the fallback.
        XCTAssertEqual(response.page.revision?.body, "# Setup")
    }

    /// Old API × new iOS: the app sent the header, the old server ignored it
    /// and returned the stored bare `Root` — raw-body fallback, decided from
    /// the RESPONSE shape alone (design doc §9 belt-and-suspenders).
    func testBareRootResponseFallsBackToTheRawBody() throws {
        let response = try GetPageResponseLenient.decode(pageJSON(revisionExtra: bareRootJSON))
        XCTAssertEqual(response.page.revision?.renderedAst, .fallbackToRawBody(.noAstVersion))
        XCTAssertEqual(response.page.revision?.body, "# Setup")
    }

    /// No `renderedAst` at all (empty body, never-rendered revision).
    func testAbsentRenderedAstReadsAsNilOutcome() throws {
        let response = try GetPageResponseLenient.decode(pageJSON())
        XCTAssertNil(response.page.revision?.renderedAst)
    }

    /// A declared-but-unsupported future version falls back too.
    func testUnsupportedAstVersionFallsBack() throws {
        let futureJSON = """
            ,
            "renderedAst": { "astVersion": 2, "root": { "type": "root", "children": [] } }
            """
        let response = try GetPageResponseLenient.decode(pageJSON(revisionExtra: futureJSON))
        XCTAssertEqual(response.page.revision?.renderedAst, .fallbackToRawBody(.unsupportedVersion(2)))
    }

    /// `rendererVersion` in the response is diagnostics only: adding it (or
    /// changing it) changes nothing about the decoded revision.
    func testRendererVersionIsNeverPartOfTheRenderingDecision() throws {
        let with = try GetPageResponseLenient.decode(pageJSON(revisionExtra: envelopeJSON + ", \"rendererVersion\": \"99.0.0\""))
        let without = try GetPageResponseLenient.decode(pageJSON(revisionExtra: envelopeJSON))
        XCTAssertEqual(with.page.revision, without.page.revision)
    }

    /// A list/portal row carrying only a bare revision-id string keeps
    /// decoding (no `renderedAst` to interpret).
    func testBareRevisionIdRowsStillDecode() {
        let revision = PageRevisionLenient.decode("r1")
        XCTAssertEqual(revision?.id, "r1")
        XCTAssertNil(revision?.renderedAst)
    }

    // MARK: - the wire declaration

    /// The page detail GET declares `X-Crowi-Ast-Version: 1` on the wire —
    /// asserted at the transport layer (the `RecordedWireRequest` stance:
    /// facts about the wire, not an in-process flag).
    func testPageDetailFetchDeclaresTheAstVersionHeader() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            (200, self.pageJSON(revisionExtra: self.envelopeJSON))
        }
        _ = try await GetPageResponseLenient.fetch(path: "/wiki/setup", using: client)
        _ = try await GetPageResponseLenient.fetch(pageId: "p1", using: client)

        let headerName = try XCTUnwrap(astVersionHeaderFieldName)
        XCTAssertEqual(recorder.requests.count, 2)
        for request in recorder.requests {
            XCTAssertEqual(request.headerFields[headerName], "1", "the detail GET must declare the typed-AST capability")
        }
    }

    /// Revision history stays body-only through Phase 4 (design §16): its
    /// fetches do NOT declare the header — promoting history to the typed
    /// path is an explicit Phase 5 revisit.
    func testRevisionHistoryFetchesDoNotDeclareTheHeader() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in
            (200, Data(#"{ "revision": { "_id": "r1", "body": "old" } }"#.utf8))
        }
        _ = try? await GetRevisionResponseLenient.fetch(revisionId: "r1", using: client)

        let headerName = try XCTUnwrap(astVersionHeaderFieldName)
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertNil(recorder.requests[0].headerFields[headerName])
    }

    private var astVersionHeaderFieldName: HTTPField.Name? {
        HTTPField.Name(RenderedAstWireContract.headerName)
    }

    // MARK: - CachedPage: the AST is online-only (design §16)

    /// Persisting an AST snapshot would pin a possibly-still-`renderPending`
    /// render on offline readers (the same `revisionId` can legitimately
    /// return a different AST on every read), so the read cache stores the
    /// BODY only — a cache-painted page always renders through the raw-body
    /// path, and `WorkspaceReadCacheSchema.schemaVersion` stays untouched.
    @MainActor
    func testCachedPageRoundTripDropsTheAstAndKeepsTheBody() throws {
        let container = try ModelContainer(
            for: CachedPage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)

        let response = try GetPageResponseLenient.decode(pageJSON(revisionExtra: envelopeJSON))
        guard case .envelope? = response.page.revision?.renderedAst else {
            return XCTFail("fixture must carry a decoded envelope")
        }
        CachedPage.upsert(from: response.page, in: context)

        let cached = try XCTUnwrap(CachedPage.cached(path: "/wiki/setup", in: context))
        let repainted = cached.asPageLenient
        XCTAssertEqual(repainted.revision?.body, "# Setup", "the raw body IS the offline representation")
        XCTAssertNil(repainted.revision?.renderedAst, "the AST must never round-trip through the read cache (§16)")
    }

    /// The schema-version pin itself: Phase 4 must NOT have bumped the read
    /// cache schema (nothing new is persisted).
    func testReadCacheSchemaVersionIsUntouchedByPhase4() {
        XCTAssertEqual(WorkspaceReadCacheSchema.schemaVersion, 2, "Phase 4 persists nothing new — a bump means the §16 policy was violated")
    }
}
