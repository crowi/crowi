import XCTest

@testable import CrowiKit

/// RFC-0016 §5.1 — `AuthenticatedAPIClient` is the ONE per-workspace
/// authenticated-fetch primitive every hand-written `*Lenient` decoder is
/// built on (`feature-ios-phase1-read`'s reuse note: "phase-2 is its first
/// real consumer" of `AuthenticatingMiddleware`). These tests exercise it
/// directly (composing `AuthenticatingMiddleware` with a mock `ClientTransport`,
/// never `URLSessionTransport`) so a regression in the composition itself —
/// not just in a single screen's decoder — is caught here.
final class AuthenticatedAPIClientTests: XCTestCase {
    func testGetAttachesBearerAndReturnsTheRawBodyAndStatus() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data("""
            { "ok": true }
            """.utf8)) }

        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "path", value: "/team/eng")])

        XCTAssertEqual(status, 200)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{ \"ok\": true }")
        XCTAssertEqual(recorder.requests.first?.authorization, "Bearer the-token")
        // `/` is a legal, non-percent-encoded character in a URL query
        // component (RFC 3986) — `URLComponents` correctly leaves it as-is.
        XCTAssertEqual(recorder.requests.first?.path, "/pages?path=/team/eng")
    }

    func testGetReturnsANon2xxStatusWithoutThrowing() async throws {
        let client = makeWireRecordedClient(recorder: WireRecorder()) { _ in (503, Data("""
            { "error": { "code": "SERVICE_UNAVAILABLE" } }
            """.utf8)) }

        let (data, status) = try await client.get("search", query: [URLQueryItem(name: "q", value: "eng")])

        XCTAssertEqual(status, 503)
        XCTAssertFalse(data.isEmpty, "the caller (e.g. the search screen) needs the raw body even on a non-2xx status")
    }

    func testGetWithNoQueryBuildsABarePath() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data()) }

        _ = try await client.get("me")

        XCTAssertEqual(recorder.requests.first?.path, "/me")
    }

    // MARK: - JSON-body writes (`feature-ios-phase2-write`)

    private struct ProbeBody: Encodable {
        let pageId: String

        enum CodingKeys: String, CodingKey {
            case pageId = "page_id"
        }
    }

    func testPostSendsAJSONBodyWithContentTypeAndBearerOnTheSameMiddlewarePath() async throws {
        let recorder = WireRecorder()
        let client = makeWireRecordedClient(recorder: recorder) { _ in (200, Data("{ \"ok\": true }".utf8)) }

        let (data, status) = try await client.post("pages/like", json: ProbeBody(pageId: "p1"))

        XCTAssertEqual(status, 200)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{ \"ok\": true }")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/pages/like")
        XCTAssertEqual(request.contentType, "application/json")
        XCTAssertEqual(request.authorization, "Bearer the-token", "writes get the identical AuthenticatingMiddleware auth injection as reads")
        XCTAssertEqual(request.jsonObject?["page_id"] as? String, "p1")
    }

    func testPutAndDeleteRideTheSameCompositionAndReturnNon2xxWithoutThrowing() async throws {
        let recorder = WireRecorder()
        let errorBody = Data("{ \"error\": { \"code\": \"PAGE_REVISION_ERROR\", \"message\": \"Revision error.\" } }".utf8)
        let client = makeWireRecordedClient(recorder: recorder) { request in
            request.method == .put ? (409, errorBody) : (200, Data("{ \"ok\": true }".utf8))
        }

        let (putData, putStatus) = try await client.put("pages", json: ProbeBody(pageId: "p1"))
        let (_, deleteStatus) = try await client.delete("bookmarks", json: ProbeBody(pageId: "p1"))

        XCTAssertEqual(putStatus, 409, "non-2xx statuses are RETURNED (the write flows branch on them), never thrown")
        XCTAssertFalse(putData.isEmpty, "the caller needs the raw error envelope bytes")
        XCTAssertEqual(deleteStatus, 200)
        XCTAssertEqual(recorder.requests.map(\.method), [.put, .delete])
        for request in recorder.requests {
            XCTAssertEqual(request.authorization, "Bearer the-token")
            XCTAssertEqual(request.contentType, "application/json")
        }
    }
}
