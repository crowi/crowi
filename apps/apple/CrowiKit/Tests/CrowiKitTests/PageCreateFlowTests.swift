import Foundation
import XCTest

@testable import CrowiKit

/// `feature-ios-phase2-write` §10 — the create 4-branch state machine.
/// Error fixtures are the LITERAL bodies `handlers/page.ts`'s `createPage`
/// emits (`pageBadRequestBody` / `pageTwinExistsBody` / `INVALID_GRANT_BODY`),
/// so a server wire-shape drift breaks these tests.
final class PageCreateFlowTests: XCTestCase {
    // MARK: - Fixtures (verbatim server bodies)

    private let pageExistsBody = Data("""
        { "error": { "code": "PAGE_EXISTS", "message": "Page exists" } }
        """.utf8)

    private let twinExistsBody = Data(
        """
        { "error": { "code": "PAGE_TWIN_EXISTS", "message": "A page with the opposite trailing slash already exists at /team/eng/. Portalize it instead." } }
        """.utf8)

    private let nonExistentUserPageBody = Data("""
        { "error": { "code": "NON_EXISTENT_USER_PAGE", "message": "Cannot create non existent user page." } }
        """.utf8)

    private let invalidGrantBody = Data(
        """
        { "error": { "code": "INVALID_GRANT", "message": "grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)" } }
        """.utf8)

    private let createFailedBody = Data("""
        { "error": { "code": "PAGE_CREATE_FAILED", "message": "Failed to create page." } }
        """.utf8)

    private let pageNotFoundBody = Data("""
        { "error": { "code": "PAGE_NOT_FOUND", "message": "Page not found" } }
        """.utf8)

    private func pageDetailBody(id: String = "p1", path: String = "/team/eng/weekly", revisionId: String = "rev-1") -> Data {
        Data("""
            { "page": { "_id": "\(id)", "path": "\(path)", "revision": { "_id": "\(revisionId)", "body": "# hello", "createdAt": "2026-07-24T00:00:00Z" } } }
            """.utf8)
    }

    // MARK: - Success

    func testCreateSuccessDecodesTheCreatedPageAndSendsPathBodyGrant() async throws {
        let recorder = WireRecorder()
        let detailBody = pageDetailBody()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, detailBody) }

        let outcome = try await PageCreateFlow(client: client).create(path: "/team/eng/weekly", body: "# hello", grant: .restricted)

        guard case .created(let page) = outcome else {
            return XCTFail("expected .created, got \(outcome)")
        }
        XCTAssertEqual(page.id, "p1")
        XCTAssertEqual(recorder.requests.count, 1, "create is exactly one POST — no probes, no retries")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/pages")
        XCTAssertEqual(request.contentType, "application/json")
        XCTAssertEqual(request.authorization, "Bearer the-token", "writes ride the same AuthenticatingMiddleware path as reads")
        let json = try XCTUnwrap(request.jsonObject)
        XCTAssertEqual(json["path"] as? String, "/team/eng/weekly")
        XCTAssertEqual(json["body"] as? String, "# hello")
        XCTAssertEqual(json["grant"] as? Int, 2)
    }

    func testNilGrantOmitsTheFieldEntirely() async throws {
        let recorder = WireRecorder()
        let detailBody = pageDetailBody()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, detailBody) }

        _ = try await PageCreateFlow(client: client).create(path: "/team/eng/weekly", body: "x", grant: nil)

        let json = try XCTUnwrap(recorder.requests.first?.jsonObject)
        XCTAssertFalse(json.keys.contains("grant"), "nil grant means 'server default' — the key must be absent, not null")
    }

    // MARK: - PAGE_EXISTS (grant-collapse-aware)

    func testPageExistsWithOpenableExistingPageOffersOpen() async throws {
        let recorder = WireRecorder()
        let errorBody = pageExistsBody
        let detailBody = pageDetailBody(id: "existing-1")
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .post ? (400, errorBody) : (200, detailBody)
        }

        let outcome = try await PageCreateFlow(client: client).create(path: "/team/eng/weekly", body: "x", grant: nil)

        guard case .pageExists(let existing) = outcome else {
            return XCTFail("expected .pageExists, got \(outcome)")
        }
        XCTAssertEqual(existing.id, "existing-1")
        // The follow-up open is a GET on the attempted path.
        XCTAssertEqual(recorder.requests.count, 2)
        XCTAssertEqual(recorder.requests[1].method, .get)
        XCTAssertEqual(recorder.requests[1].path, "/pages?path=/team/eng/weekly")
    }

    func testPageExistsWithDeniedFollowUpOpenDegradesToPathTaken() async throws {
        // The server deliberately collapses not-granted pages into
        // PAGE_EXISTS (`page.ts` — "a stricter-grant race we must not
        // leak"); the follow-up open then 404s and the UX must degrade to
        // "path taken", never promising openability.
        let recorder = WireRecorder()
        let errorBody = pageExistsBody
        let notFound = pageNotFoundBody
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .post ? (400, errorBody) : (404, notFound)
        }

        let outcome = try await PageCreateFlow(client: client).create(path: "/secret/page", body: "x", grant: nil)

        XCTAssertEqual(outcome, .pathTaken)
    }

    func testPageExistsFollowUpTransportFailurePropagatesForManualRetry() async {
        // §7.4 fail-fast: `.pathTaken` is reserved for the server actually
        // ANSWERING the follow-up open with an HTTP denial/not-found. Going
        // offline between the POST and the follow-up GET must instead
        // propagate the `URLError` so the UI keeps the form state and offers
        // manual retry — never silently absorb connectivity loss into a UX
        // state.
        let recorder = WireRecorder()
        let errorBody = pageExistsBody
        let client = makeWireRecordedClient(recorder: recorder) { request in
            guard request.method == .post else { throw URLError(.notConnectedToInternet) }
            return (400, errorBody)
        }

        do {
            _ = try await PageCreateFlow(client: client).create(path: "/team/eng/weekly", body: "x", grant: nil)
            XCTFail("expected the follow-up transport URLError to propagate, not a .pathTaken degrade")
        } catch {
            XCTAssertTrue(error is URLError, "expected URLError, got \(error)")
        }
        // The POST and the attempted follow-up GET both hit the wire.
        XCTAssertEqual(recorder.requests.count, 2)
        XCTAssertEqual(recorder.requests[1].method, .get)
    }

    // MARK: - PAGE_TWIN_EXISTS

    func testTwinExistsDerivesTheTwinPathBySlashToggleNotMessageParsing() async throws {
        let recorder = WireRecorder()
        let errorBody = twinExistsBody
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, errorBody) }

        // Attempting the slashless side → the twin is the slashed side.
        let outcome = try await PageCreateFlow(client: client).create(path: "/team/eng", body: "x", grant: nil)

        XCTAssertEqual(outcome, .twinExists(twinPath: "/team/eng/"))

        // And the other direction: attempting the slashed side derives the
        // slashless twin — proof it is a client-side toggle of the ATTEMPTED
        // path, not a parse of the response message (which here names
        // `/team/eng/` either way).
        let reverseOutcome = try await PageCreateFlow(client: client).create(path: "/team/eng/", body: "x", grant: nil)

        XCTAssertEqual(reverseOutcome, .twinExists(twinPath: "/team/eng"))
    }

    // MARK: - NON_EXISTENT_USER_PAGE

    func testNonExistentUserPageGetsItsOwnState() async throws {
        let recorder = WireRecorder()
        let errorBody = nonExistentUserPageBody
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, errorBody) }

        let outcome = try await PageCreateFlow(client: client).create(path: "/user/ghost/memo", body: "x", grant: nil)

        XCTAssertEqual(outcome, .nonExistentUserPage)
    }

    // MARK: - INVALID_GRANT (defensive fallback)

    func testInvalidGrantRetriesExactlyOnceWithTheDefaultGrant() async throws {
        let recorder = WireRecorder()
        let errorBody = invalidGrantBody
        let detailBody = pageDetailBody()
        let client = makeWireRecordedClient(recorder: recorder) { request in
            guard let json = request.jsonObject else { return (400, errorBody) }
            return json.keys.contains("grant") ? (400, errorBody) : (200, detailBody)
        }

        let outcome = try await PageCreateFlow(client: client).create(path: "/team/eng/weekly", body: "x", grant: .ownerOnly)

        guard case .created = outcome else {
            return XCTFail("expected .created after the default-grant retry, got \(outcome)")
        }
        let posts = recorder.requests.filter { $0.method == .post }
        XCTAssertEqual(posts.count, 2, "exactly one retry")
        XCTAssertEqual(posts[0].jsonObject?["grant"] as? Int, 4)
        XCTAssertFalse(posts[1].jsonObject?.keys.contains("grant") ?? true, "the retry falls back to the server default by omitting grant")
    }

    func testInvalidGrantOnTheRetryItselfDegradesToCreateFailed() async throws {
        let recorder = WireRecorder()
        let errorBody = invalidGrantBody
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, errorBody) }

        let outcome = try await PageCreateFlow(client: client).create(path: "/p", body: "x", grant: .publicPage)

        guard case .createFailed = outcome else {
            return XCTFail("expected .createFailed, got \(outcome)")
        }
        XCTAssertEqual(recorder.requests.count, 2, "never more than one retry")
    }

    // MARK: - Residual / unknown codes

    func testResidualCreateFailedCarriesTheServerMessage() async throws {
        let recorder = WireRecorder()
        let errorBody = createFailedBody
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, errorBody) }

        let outcome = try await PageCreateFlow(client: client).create(path: "/p", body: "x", grant: nil)

        XCTAssertEqual(outcome, .createFailed(message: "Failed to create page."))
    }

    func testUnknownCodeAndUndecodableBodyDegradeToCreateFailed() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (400, Data("not json".utf8)) }

        let outcome = try await PageCreateFlow(client: client).create(path: "/p", body: "x", grant: nil)

        XCTAssertEqual(outcome, .createFailed(message: nil))
    }

    // MARK: - §7.4 offline fail-fast

    func testTransportFailureThrowsForManualRetry() async {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in throw URLError(.notConnectedToInternet) }

        do {
            _ = try await PageCreateFlow(client: client).create(path: "/p", body: "x", grant: nil)
            XCTFail("expected the URLError to propagate (no queue, no silent retry)")
        } catch {
            XCTAssertTrue(error is URLError)
        }
    }

    // MARK: - Path normalization helpers

    func testNormalizedPathEnsuresALeadingSlash() {
        XCTAssertEqual(PageCreateFlow.normalizedPath("  /team/eng "), "/team/eng")
        XCTAssertEqual(PageCreateFlow.normalizedPath("team/eng"), "/team/eng")
    }
}
