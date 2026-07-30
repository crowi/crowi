import MarkdownUI
import SwiftUI
import XCTest

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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

    /// `feature-ios-phase3` byte-identity invariant, pinned at the WIRE
    /// through the inline entry point: a URL carrying the RFC-0015
    /// `#crowi-image-attrs:` side-channel must reach the transport with the
    /// fragment already detached — the request URL is byte-identical to the
    /// pre-carry one (same fetch, same allowlist decision, same cache key).
    func testImageWithDetachesTheAttributeFragmentBeforeTheWire() async throws {
        let pngData = try XCTUnwrap(Data(base64Encoded: Self.onePixelPNGBase64))
        var capturedURL: URL?
        let loader = makeLoader { request in
            capturedURL = request.url
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        let carried = URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=100px")!
        _ = try await provider.image(with: carried, label: "alt text")

        XCTAssertEqual(capturedURL?.absoluteString, "https://wiki.example.com/api/v2/attachments/abc")
    }

    // MARK: - RFC-0015 width application, rendered through the provider

    /// A deterministic PNG at exactly `width`×`height` PIXELS with no DPI
    /// scaling games, so the decoded `PlatformImage.size` (points) is the
    /// same number — the fixture the two rendered-width tests below resize.
    private func makePNGData(width: Int, height: Int) throws -> Data {
        #if canImport(AppKit)
        let rep = try XCTUnwrap(
            NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: width,
                pixelsHigh: height,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
            ))
        return try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        #else
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.pngData { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        #endif
    }

    /// Renders the `Image` the provider returned — the exact value
    /// swift-markdown-ui would embed into `Text` — and reports its pixel
    /// size at scale 1 (= its intrinsic point size).
    @MainActor
    private func renderedSize(of image: Image) throws -> CGSize {
        let renderer = ImageRenderer(content: image)
        renderer.scale = 1
        let cgImage = try XCTUnwrap(renderer.cgImage)
        return CGSize(width: cgImage.width, height: cgImage.height)
    }

    /// review round 1 — the REQUIRED native inline `%` application, pinned
    /// at the provider's own rendered output: a genuinely inline image
    /// carrying `width=50pct` resolves against the container width
    /// `WorkspacePageMarkdownView` measures (here 300pt), so the rendered
    /// bitmap comes out 150×75 — not its native 400×200.
    @MainActor
    func testImageWithAppliesAPercentWidthAgainstTheMeasuredContainerWidth() async throws {
        let pngData = try makePNGData(width: 400, height: 200)
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let containerWidth = InlineImageContainerWidthReference()
        containerWidth.width = 300
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader, containerWidth: containerWidth)

        let carried = URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=50pct")!
        let image = try await provider.image(with: carried, label: "alt text")

        let rendered = try renderedSize(of: image)
        XCTAssertEqual(rendered.width, 150, accuracy: 1.5)
        XCTAssertEqual(rendered.height, 75, accuracy: 1.5)
    }

    /// The same rendered pin for `px` (the pre-rework inline application),
    /// proving the container reference did not disturb it.
    @MainActor
    func testImageWithAppliesAPixelWidthToTheRenderedBitmap() async throws {
        let pngData = try makePNGData(width: 400, height: 200)
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let containerWidth = InlineImageContainerWidthReference()
        containerWidth.width = 300
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader, containerWidth: containerWidth)

        let carried = URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=100px")!
        let image = try await provider.image(with: carried, label: "alt text")

        let rendered = try renderedSize(of: image)
        XCTAssertEqual(rendered.width, 100, accuracy: 1.5)
        XCTAssertEqual(rendered.height, 50, accuracy: 1.5)
    }

    /// Degrade, never guess, visible at the rendered output too: a `%` width
    /// with NO measured container leaves the bitmap at its native size.
    @MainActor
    func testImageWithLeavesAPercentWidthUnappliedWithoutAMeasuredContainer() async throws {
        let pngData = try makePNGData(width: 400, height: 200)
        let loader = makeLoader { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, pngData)
        }
        let provider = WorkspaceMarkdownInlineImageProvider(loader: loader)

        let carried = URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=50pct")!
        let image = try await provider.image(with: carried, label: "alt text")

        let rendered = try renderedSize(of: image)
        XCTAssertEqual(rendered.width, 400, accuracy: 1.5)
    }
}
