import HTTPTypes
import OpenAPIRuntime
import XCTest

@testable import CrowiKit

/// `feature-ios-image-viewer` — `AttachmentMetaLenient` is the tolerant
/// decode of `GET /attachments/{id}/meta` the original-image resolver reads
/// `originalUrl` from. Same lenient-decoder contract every other
/// `*Lenient` type pins: optionals-first, degrade on missing fields, and
/// fetch through `AuthenticatedAPIClient` (Bearer attached — an attachment's
/// meta is grant-checked server-side) rather than any bare `URLSession`.
final class AttachmentMetaLenientTests: XCTestCase {
    private struct MockTransport: ClientTransport {
        let handler: @Sendable (HTTPRequest) throws -> (Int, Data)

        func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
            let (status, data) = try handler(request)
            return (HTTPResponse(status: .init(code: status)), HTTPBody(data))
        }
    }

    private func makeClient(handler: @escaping @Sendable (HTTPRequest) throws -> (Int, Data)) -> AuthenticatedAPIClient {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
            URL(string: "https://wiki.example.com/api/oauth/token")!
        }
        return AuthenticatedAPIClient(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
            middleware: AuthenticatingMiddleware(coordinator: coordinator),
            transport: MockTransport(handler: handler)
        )
    }

    // MARK: - decode

    func testDecodeReadsIdUrlAndOriginalUrl() throws {
        let data = Data("""
            {
              "_id": "665f1c2b8a9d3e4f5a6b7c8d",
              "page": "abc",
              "fileName": "x.png",
              "url": "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d",
              "originalUrl": "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d/original"
            }
            """.utf8)

        let meta = try AttachmentMetaLenient.decode(data)

        XCTAssertEqual(meta.id, "665f1c2b8a9d3e4f5a6b7c8d")
        XCTAssertEqual(meta.url, "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d")
        XCTAssertEqual(meta.originalUrl, "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d/original")
    }

    /// A host predating the display-derivative contract (or any host that
    /// simply omits the field) degrades to `nil` — never a throw. This is
    /// the exact signal `OriginalImageResolver` turns into the canonical
    /// fallback.
    func testDecodeDegradesAMissingOriginalUrlToNil() throws {
        let data = Data("""
            { "_id": "665f1c2b8a9d3e4f5a6b7c8d", "url": "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d" }
            """.utf8)

        let meta = try AttachmentMetaLenient.decode(data)

        XCTAssertNil(meta.originalUrl)
        XCTAssertEqual(meta.url, "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d")
    }

    func testDecodeThrowsForANonObjectBody() {
        XCTAssertThrowsError(try AttachmentMetaLenient.decode(Data("[1, 2, 3]".utf8))) { error in
            XCTAssertEqual(error as? AttachmentMetaLenient.DecodeError, .notAnObject)
        }
    }

    /// Bytes that are not JSON at all (a truncated body, an HTML error page
    /// a proxy interposed, …) must throw — the signal `OriginalImageResolver`
    /// degrades to the canonical fallback — never crash or mis-decode.
    func testDecodeThrowsForMalformedJSON() {
        for malformed in ["{ \"originalUrl\": ", "<html><body>502 Bad Gateway</body></html>", ""] {
            XCTAssertThrowsError(try AttachmentMetaLenient.decode(Data(malformed.utf8)), "\(malformed) must throw")
        }
    }

    // MARK: - fetch

    func testFetchHitsTheMetaPathWithABearerAndDecodes() async throws {
        let recorder = MetaRequestRecorder()
        let client = makeClient { request in
            recorder.capture(request)
            return (200, Data("""
                { "_id": "665f1c2b8a9d3e4f5a6b7c8d", "originalUrl": "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d/original" }
                """.utf8))
        }

        let meta = try await AttachmentMetaLenient.fetch(attachmentId: "665f1c2b8a9d3e4f5a6b7c8d", using: client)

        XCTAssertEqual(recorder.path, "/attachments/665f1c2b8a9d3e4f5a6b7c8d/meta")
        XCTAssertEqual(recorder.authorization, "Bearer the-token", "the meta endpoint is grant-checked — the fetch must ride the authenticated primitive")
        XCTAssertEqual(meta.originalUrl, "/api/attachments/665f1c2b8a9d3e4f5a6b7c8d/original")
    }

    /// A pre-display-contract Crowi has no `/meta` route at all — its `404`
    /// must surface as a typed error (which the resolver degrades to the
    /// canonical fallback), never a decode attempt over the error body.
    func testFetchThrowsHttpErrorForANon2xxStatus() async {
        let client = makeClient { _ in (404, Data("""
            { "error": { "code": "ATTACHMENT_NOT_FOUND", "message": "Attachment not found" } }
            """.utf8)) }

        do {
            _ = try await AttachmentMetaLenient.fetch(attachmentId: "665f1c2b8a9d3e4f5a6b7c8d", using: client)
            XCTFail("a 404 must throw")
        } catch {
            XCTAssertEqual(error as? AttachmentMetaLenient.DecodeError, .httpError(status: 404))
        }
    }

    /// A `200` whose body is not JSON (an interposing proxy's HTML error
    /// page, a truncated response) throws out of the decode step — same
    /// degrade-to-fallback signal as the `404`.
    func testFetchThrowsWhenA2xxBodyIsMalformedJSON() async {
        let client = makeClient { _ in (200, Data("<html>not json</html>".utf8)) }

        do {
            _ = try await AttachmentMetaLenient.fetch(attachmentId: "665f1c2b8a9d3e4f5a6b7c8d", using: client)
            XCTFail("a malformed body must throw")
        } catch {
            // JSONSerialization's own error — the exact type is not part of
            // the contract, only that fetch throws instead of fabricating a
            // meta value.
        }
    }

    /// A genuine transport failure (no network, DNS, …) propagates out of
    /// `fetch` as-is — never swallowed into a half-decoded value.
    func testFetchPropagatesATransportError() async {
        let client = makeClient { _ in throw URLError(.notConnectedToInternet) }

        do {
            _ = try await AttachmentMetaLenient.fetch(attachmentId: "665f1c2b8a9d3e4f5a6b7c8d", using: client)
            XCTFail("a transport error must throw")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
        }
    }
}

/// Same lock-protected capture shape as `AuthenticatedAPIClientTests`'s
/// recorder — driven strictly sequentially by these tests.
private final class MetaRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _path: String?
    private var _authorization: String?

    func capture(_ request: HTTPRequest) {
        lock.lock()
        defer { lock.unlock() }
        _path = request.path
        _authorization = request.headerFields[.authorization]
    }

    var path: String? {
        lock.lock()
        defer { lock.unlock() }
        return _path
    }

    var authorization: String? {
        lock.lock()
        defer { lock.unlock() }
        return _authorization
    }
}
