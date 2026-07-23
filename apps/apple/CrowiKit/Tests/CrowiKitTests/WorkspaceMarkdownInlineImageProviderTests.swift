import MarkdownUI
import XCTest

@testable import CrowiKit

/// The inline counterpart to `WorkspaceMarkdownImageProviderTests` — proves
/// `WorkspaceMarkdownInlineImageProvider` (the `\.inlineImageProvider`
/// environment key `InlineText` consumes for any image sharing a line with
/// other inline content, e.g. crowi's `![alt](url){width=500px}` attribute
/// markdown) reuses the exact same authenticated `WorkspaceImageLoader`
/// pipeline as the block path, rather than falling through to
/// swift-markdown-ui's unauthenticated `DefaultInlineImageProvider`.
final class WorkspaceMarkdownInlineImageProviderTests: XCTestCase {
    private let workspaceOrigin = URL(string: "https://wiki.example.com")!

    /// A real, valid 1x1 transparent PNG — decodable by `PlatformImage(data:)`,
    /// unlike a bare 4-byte magic-number stub.
    private static let onePixelPNGBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

    private func makeLoader(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> WorkspaceImageLoader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.requestHandler = handler
        return WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "the-token" }, sessionConfiguration: configuration)
    }

    func testImageWithReturnsADecodedImageForARealAttachment() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        // Must not throw — a successful fetch+decode returns an `Image`.
        _ = try await provider.image(with: workspaceOrigin.appendingPathComponent("api/v2/attachments/abc"), label: "alt text")
    }

    func testImageWithThrowsForNonImageBytes() async {
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/plain"])!, Data("not an image".utf8))
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        do {
            _ = try await provider.image(with: workspaceOrigin.appendingPathComponent("api/v2/attachments/broken"), label: "alt text")
            XCTFail("expected image(with:label:) to throw for undecodable bytes")
        } catch {
            // `InlineImageProvider`'s contract is `async throws` — this is
            // the only signal it has for "no image"; swift-markdown-ui's own
            // `InlineText` treats the failure as an empty inline image.
        }
    }

    func testImageWithThrowsForANonSuccessfulHTTPStatus() async {
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        do {
            _ = try await provider.image(with: workspaceOrigin.appendingPathComponent("api/v2/attachments/missing"), label: "alt text")
            XCTFail("expected image(with:label:) to throw for a 404")
        } catch {
            // Expected.
        }
    }

    /// The §6.1 same-origin-Bearer rule, reachable through the INLINE
    /// provider entry point specifically (not just via `WorkspaceImageLoader`
    /// or the block provider in isolation).
    func testImageWithAttachesAuthorizationForASameOriginAttachment() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        var capturedAuthorization: String?
        let loader = makeLoader { request in
            capturedAuthorization = request.value(forHTTPHeaderField: "Authorization")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        _ = try await provider.image(with: workspaceOrigin.appendingPathComponent("api/v2/attachments/abc"), label: "alt text")

        XCTAssertEqual(capturedAuthorization, "Bearer the-token")
    }

    /// The other half of §6.1: a cross-origin image URL embedded in a page
    /// body must never receive the workspace's Bearer token, through the
    /// inline path any more than the block one.
    func testImageWithDoesNotAttachAuthorizationForACrossOriginURL() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        var capturedAuthorization: String?
        let loader = makeLoader { request in
            capturedAuthorization = request.value(forHTTPHeaderField: "Authorization")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        _ = try await provider.image(with: URL(string: "https://attacker.example/x.png")!, label: "alt text")

        XCTAssertNil(capturedAuthorization)
    }

    /// The provider itself must conform to swift-markdown-ui's
    /// `InlineImageProvider` — a compile-time check (a non-conforming type
    /// fails to build this file) plus a construction smoke test.
    func testProviderConformsToInlineImageProvider() {
        let loader = WorkspaceImageLoader(workspaceOrigin: workspaceOrigin, accessTokenProvider: { "t" })
        func acceptsInlineImageProvider(_ provider: some InlineImageProvider) -> Bool { true }
        XCTAssertTrue(acceptsInlineImageProvider(WorkspaceMarkdownInlineImageProvider(loader: loader)))
    }
}
