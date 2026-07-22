import MarkdownUI
import XCTest

@testable import CrowiKit

/// AC-4 follow-up (reviewer NEEDS_WORK, 1st review round): proves the
/// selected gate C renderer (swift-markdown-ui) is actually wired to
/// `WorkspaceImageLoader`, not just that the loader alone is secure.
/// `WorkspaceMarkdownImageLoading.loadImage` is the exact function
/// `WorkspaceMarkdownImageView` (the `ImageProvider`'s `Body`) calls from its
/// `.task`, so exercising it here is exercising the real integration path, a
/// SwiftUI host is only needed to actually paint pixels on screen.
final class WorkspaceMarkdownImageProviderTests: XCTestCase {
    private let workspaceOrigin = URL(string: "https://wiki.example.com")!

    /// A real, valid 1x1 transparent PNG — decodable by `PlatformImage(data:)`,
    /// unlike a bare 4-byte magic-number stub (this test asserts an actual
    /// successful raster decode, not just "bytes arrived").
    private static let onePixelPNGBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

    private func makeLoader(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> WorkspaceImageLoader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.requestHandler = handler
        return WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "the-token" }, sessionConfiguration: configuration)
    }

    func testLoadImageDecodesARealAttachmentFetchedThroughTheLoader() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }

        let image = await WorkspaceMarkdownImageLoading.loadImage(
            url: workspaceOrigin.appendingPathComponent("api/v2/attachments/abc"),
            using: loader
        )

        let decoded = try XCTUnwrap(image, "swift-markdown-ui's ImageProvider must receive a decoded image from bytes fetched via WorkspaceImageLoader")
        #if canImport(UIKit)
        XCTAssertEqual(decoded.size, CGSize(width: 1, height: 1))
        #elseif canImport(AppKit)
        XCTAssertEqual(decoded.size.width, 1)
        XCTAssertEqual(decoded.size.height, 1)
        #endif
    }

    func testLoadImageStillAttachesAuthorizationAtTheImageProviderEntryPoint() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        var capturedAuthorization: String?
        let loader = makeLoader { request in
            capturedAuthorization = request.value(forHTTPHeaderField: "Authorization")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }

        _ = await WorkspaceMarkdownImageLoading.loadImage(
            url: workspaceOrigin.appendingPathComponent("api/v2/attachments/abc"),
            using: loader
        )

        // The §6.1 guard gate C exists to prove — reachable through the
        // renderer integration, not only via WorkspaceImageLoader in isolation.
        XCTAssertEqual(capturedAuthorization, "Bearer the-token")
    }

    func testLoadImageReturnsNilForNonImageBytes() async {
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/plain"])!, Data("not an image".utf8))
        }

        let image = await WorkspaceMarkdownImageLoading.loadImage(
            url: workspaceOrigin.appendingPathComponent("api/v2/attachments/broken"),
            using: loader
        )

        XCTAssertNil(image)
    }

    func testLoadImageReturnsNilForNilURL() async {
        let loader = makeLoader { request in
            XCTFail("must not fetch when url is nil")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }

        let image = await WorkspaceMarkdownImageLoading.loadImage(url: nil, using: loader)

        XCTAssertNil(image)
    }

    /// The provider itself must conform to swift-markdown-ui's `ImageProvider`
    /// — a compile-time check (a non-conforming type fails to build this
    /// file) plus a construction smoke test.
    func testProviderConformsToImageProvider() {
        let loader = WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "t" })
        func acceptsImageProvider(_ provider: some ImageProvider) -> Bool { true }
        XCTAssertTrue(acceptsImageProvider(WorkspaceMarkdownImageProvider(loader: loader)))
    }

    // Renderer-integration proof against a REAL local dev Crowi + real
    // attachment (AC-4) was run live once through this exact
    // `WorkspaceMarkdownImageLoading.loadImage` entry point during Phase 1's
    // rework — see `feature-ios-phase0-gates.md`'s "Gate 判定" section for
    // that evidence. It is not kept as a permanently environment-gated test
    // here: `swift test` must be unconditionally green (no skips) on every
    // invocation, including CI, where no such live target ever exists — the
    // mocked tests above already exercise this exact function end-to-end.
}
