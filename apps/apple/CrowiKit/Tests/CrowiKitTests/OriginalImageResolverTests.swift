import HTTPTypes
import OpenAPIRuntime
import XCTest

@testable import CrowiKit

/// `feature-ios-image-viewer` — `OriginalImageResolver` is the ONE place the
/// "body = display derivative / viewer = original" decision lives: canonical
/// embedded URL → `/meta` → rebased `originalUrl`, with EVERY failure mode
/// (legacy `/files/<id>`, external images, avatar `by-key`, `/meta` 404,
/// malformed/non-JSON body, transport failure, missing `originalUrl`,
/// off-origin `originalUrl`) collapsing to the canonical URL so the viewer
/// never renders worse than the body did.
final class OriginalImageResolverTests: XCTestCase {
    private let workspaceOrigin = WorkspaceOrigin(URL(string: "https://wiki.example.com")!)
    private let attachmentId = "665f1c2b8a9d3e4f5a6b7c8d"

    private struct MockTransport: ClientTransport {
        let handler: @Sendable (HTTPRequest) throws -> (Int, Data)

        func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
            let (status, data) = try handler(request)
            return (HTTPResponse(status: .init(code: status)), HTTPBody(data))
        }
    }

    private func makeResolver(handler: @escaping @Sendable (HTTPRequest) throws -> (Int, Data)) -> OriginalImageResolver {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
            URL(string: "https://wiki.example.com/api/v2/oauth/token")!
        }
        let client = AuthenticatedAPIClient(
            apiBaseURL: APIBaseURL(workspaceOrigin: workspaceOrigin),
            middleware: AuthenticatingMiddleware(coordinator: coordinator),
            transport: MockTransport(handler: handler)
        )
        return OriginalImageResolver(workspaceOrigin: workspaceOrigin, apiClient: client)
    }

    // MARK: - embeddedAttachmentID (the shape gate)

    func testExtractsTheIdFromTheExactCanonicalEmbeddedShape() {
        let url = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!
        XCTAssertEqual(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin), attachmentId)
    }

    /// The renderer normally hands this resolver an already-rebased absolute
    /// URL, but a workspace-relative one must judge identically (the same
    /// rebase rule `WorkspaceImageLoader.fetch` applies).
    func testExtractsTheIdFromAWorkspaceRelativeURL() {
        let url = URL(string: "/api/v2/attachments/\(attachmentId)")!
        XCTAssertEqual(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin), attachmentId)
    }

    func testRejectsAByKeyAvatarURL() {
        let url = URL(string: "https://wiki.example.com/api/v2/attachments/by-key/user/bob")!
        XCTAssertNil(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin))
    }

    func testRejectsAnAlreadySuffixedOriginalOrMetaURL() {
        for suffix in ["original", "meta"] {
            let url = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)/\(suffix)")!
            XCTAssertNil(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin), "\(suffix) must not re-resolve")
        }
    }

    /// OQ pin: a legacy `/files/<id>` embed carries no attachment id this
    /// resolver can ask `/meta` with — canonical fallback only, no redirect
    /// chasing.
    func testRejectsALegacyFilesURL() {
        let url = URL(string: "https://wiki.example.com/files/\(attachmentId)")!
        XCTAssertNil(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin))
    }

    func testRejectsACrossOriginAttachmentShapedURL() {
        let url = URL(string: "https://evil.example.net/api/v2/attachments/\(attachmentId)")!
        XCTAssertNil(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin))
    }

    /// Mirrors the server's own `isValidObjectId` gate — and structurally
    /// prevents anything but 24 hex chars from being re-embedded into the
    /// `/meta` request path.
    func testRejectsANonObjectIdSegment() {
        for bad in ["not-an-object-id", "665f1c2b8a9d3e4f5a6b7c", "665f1c2b8a9d3e4f5a6b7c8dZZ"] {
            let url = URL(string: "https://wiki.example.com/api/v2/attachments/\(bad)")!
            XCTAssertNil(OriginalImageResolver.embeddedAttachmentID(of: url, workspaceOrigin: workspaceOrigin), "\(bad) must be rejected")
        }
    }

    // MARK: - viewerImageURLString (resolution + fallback)

    func testResolvesTheOriginalURLRebasedAgainstTheWorkspaceOrigin() async {
        let resolver = makeResolver { _ in
            (200, Data("""
                { "_id": "665f1c2b8a9d3e4f5a6b7c8d", "originalUrl": "/api/v2/attachments/665f1c2b8a9d3e4f5a6b7c8d/original" }
                """.utf8))
        }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, "https://wiki.example.com/api/v2/attachments/\(attachmentId)/original")
    }

    func testFallsBackToCanonicalWhenMetaAnswers404() async {
        let resolver = makeResolver { _ in (404, Data("{}".utf8)) }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, canonical.absoluteString)
    }

    /// A `200` whose body is not JSON at all (an interposing proxy's HTML
    /// error page, a truncated response) — the decode throw must collapse to
    /// the canonical fallback, never break the viewer.
    func testFallsBackToCanonicalWhenMetaBodyIsMalformedJSON() async {
        let resolver = makeResolver { _ in (200, Data("<html><body>502 Bad Gateway</body></html>".utf8)) }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, canonical.absoluteString)
    }

    /// A genuine transport failure (offline, DNS, …) on the `/meta`
    /// round-trip degrades the same way: canonical fallback. (The canonical
    /// bytes are typically already in the disk cache from the body render,
    /// so offline viewing keeps working.)
    func testFallsBackToCanonicalWhenTheTransportFails() async {
        let resolver = makeResolver { _ in throw URLError(.notConnectedToInternet) }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, canonical.absoluteString)
    }

    /// A workspace predating the display-derivative contract may answer the
    /// meta shape without `originalUrl` — canonical IS the original there.
    func testFallsBackToCanonicalWhenMetaOmitsOriginalUrl() async {
        let resolver = makeResolver { _ in
            (200, Data("""
                { "_id": "665f1c2b8a9d3e4f5a6b7c8d", "url": "/api/v2/attachments/665f1c2b8a9d3e4f5a6b7c8d" }
                """.utf8))
        }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, canonical.absoluteString)
    }

    /// §6.1 — the viewer's fetch path must stay same-origin: an
    /// `originalUrl` that rebases onto another origin is never followed.
    func testFallsBackToCanonicalWhenOriginalUrlRebasesOffOrigin() async {
        let resolver = makeResolver { _ in
            (200, Data("""
                { "originalUrl": "https://evil.example.net/api/v2/attachments/665f1c2b8a9d3e4f5a6b7c8d/original" }
                """.utf8))
        }
        let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/\(attachmentId)")!

        let resolved = await resolver.viewerImageURLString(for: canonical)

        XCTAssertEqual(resolved, canonical.absoluteString)
    }

    /// An external (allowlisted) image or legacy `/files/<id>` embed is
    /// returned as-is WITHOUT any `/meta` round-trip — the transport must
    /// never even be touched.
    func testANonCanonicalURLFallsBackWithoutAnyNetworkCall() async {
        let counter = TransportHitCounter()
        let resolver = makeResolver { _ in
            counter.increment()
            return (200, Data("{}".utf8))
        }

        for urlString in ["https://external.example.org/pic.png", "https://wiki.example.com/files/\(attachmentId)"] {
            let canonical = URL(string: urlString)!
            let resolved = await resolver.viewerImageURLString(for: canonical)
            XCTAssertEqual(resolved, canonical.absoluteString)
        }
        XCTAssertEqual(counter.count, 0, "no /meta call may be issued for a non-canonical-embed URL")
    }
}

/// Lock-protected hit counter — `MockTransport.handler` is `@Sendable`.
private final class TransportHitCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0

    func increment() {
        lock.lock()
        _count += 1
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return _count
    }
}
