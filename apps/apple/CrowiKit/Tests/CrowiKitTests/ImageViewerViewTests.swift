import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// `feature-ios-image-viewer` — pins the viewer's testable invariants
/// without a SwiftUI host driving real gestures:
///   - `ImageViewerLoading` fetches the resolver's original URL through the
///     SAME `WorkspaceImageFetching` seam as the body render and falls back
///     to the canonical URL when the original fetch/decode fails (raster
///     decode only — bytes that don't decode are simply not shown);
///   - `ImageViewerZoomModel` — the pinch/pan/double-tap/swipe-dismiss
///     state transitions the gesture callbacks commit;
///   - `WorkspaceMarkdownImageTapPolicy` — tap is active ONLY for a decoded
///     image with a URL and a configured handler (inert images stay inert);
///   - the §6.3 confidential banner actually renders inside the viewer
///     content (a fullscreen cover draws ABOVE the chrome root's banner, so
///     re-application here is what keeps "always on top" true).
final class ImageViewerViewTests: XCTestCase {
    /// A real, valid 1x1 transparent PNG — decodable by `PlatformImage(data:)`.
    private static let onePixelPNGData = Data(
        base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!

    private static let canonical = URL(string: "https://wiki.example.com/api/v2/attachments/665f1c2b8a9d3e4f5a6b7c8d")!
    private static let originalURLString = "https://wiki.example.com/api/v2/attachments/665f1c2b8a9d3e4f5a6b7c8d/original"

    // MARK: - ImageViewerLoading (original + canonical fallback, one seam)

    func testLoadsTheOriginalURLThroughTheSharedFetchingSeam() async {
        let loader = RecordingLoader { urlString in
            guard urlString == Self.originalURLString else { throw StubFetchError() }
            return Self.onePixelPNGData
        }
        let resolver = StubResolver(resolved: Self.originalURLString)

        let image = await ImageViewerLoading.loadViewerImage(canonicalURL: Self.canonical, resolver: resolver, loader: loader)

        XCTAssertNotNil(image, "the viewer must display the original bytes")
        XCTAssertEqual(loader.fetched, [Self.originalURLString], "exactly one fetch, of the ORIGINAL URL, through the injected loader — never a second fetch path")
    }

    func testFallsBackToCanonicalWhenTheOriginalFetchFails() async {
        let loader = RecordingLoader { urlString in
            guard urlString == Self.canonical.absoluteString else { throw StubFetchError() }
            return Self.onePixelPNGData
        }
        let resolver = StubResolver(resolved: Self.originalURLString)

        let image = await ImageViewerLoading.loadViewerImage(canonicalURL: Self.canonical, resolver: resolver, loader: loader)

        XCTAssertNotNil(image, "an original that 404s/errors must not leave the viewer blank when the canonical still renders")
        XCTAssertEqual(loader.fetched, [Self.originalURLString, Self.canonical.absoluteString])
    }

    /// Raster-decode-only (§6.1/§14): original bytes that don't decode as a
    /// raster image (e.g. a non-image body) are treated exactly like a
    /// failed fetch — fall back to canonical, never hand the bytes to any
    /// other rendering context.
    func testFallsBackToCanonicalWhenTheOriginalBytesDoNotRasterDecode() async {
        let loader = RecordingLoader { urlString in
            urlString == Self.canonical.absoluteString ? Self.onePixelPNGData : Data("not an image".utf8)
        }
        let resolver = StubResolver(resolved: Self.originalURLString)

        let image = await ImageViewerLoading.loadViewerImage(canonicalURL: Self.canonical, resolver: resolver, loader: loader)

        XCTAssertNotNil(image)
        XCTAssertEqual(loader.fetched, [Self.originalURLString, Self.canonical.absoluteString])
    }

    /// When the resolver already fell back to the canonical URL (a legacy
    /// `/files/<id>`/external embed, or `/meta` failure) and that one fetch
    /// fails too, the SAME URL is never pointlessly fetched a second time.
    func testDoesNotDoubleFetchTheCanonicalWhenTheResolverAlreadyFellBack() async {
        let loader = RecordingLoader { _ in throw StubFetchError() }
        let resolver = StubResolver(resolved: Self.canonical.absoluteString)

        let image = await ImageViewerLoading.loadViewerImage(canonicalURL: Self.canonical, resolver: resolver, loader: loader)

        XCTAssertNil(image)
        XCTAssertEqual(loader.fetched, [Self.canonical.absoluteString])
    }

    // MARK: - ImageViewerZoomModel (gesture-commit transitions)

    func testMagnificationClampsBetweenMinAndMaxScale() {
        var zoom = ImageViewerZoomModel()

        zoom.endMagnification(factor: 100)
        XCTAssertEqual(zoom.steadyScale, ImageViewerZoomModel.maxScale)

        zoom.endMagnification(factor: 0.0001)
        XCTAssertEqual(zoom.steadyScale, ImageViewerZoomModel.minScale)
    }

    func testPinchingBackToFitRecentersTheImage() {
        var zoom = ImageViewerZoomModel()
        zoom.endMagnification(factor: 3)
        zoom.endPan(translation: CGSize(width: 40, height: -25))
        XCTAssertEqual(zoom.steadyOffset, CGSize(width: 40, height: -25))

        zoom.endMagnification(factor: 0.01)

        XCTAssertEqual(zoom.steadyScale, ImageViewerZoomModel.minScale)
        XCTAssertEqual(zoom.steadyOffset, .zero, "an unzoomed image must never be left stuck off-center")
    }

    func testDoubleTapTogglesBetweenFitAndTheFixedZoom() {
        var zoom = ImageViewerZoomModel()

        zoom.toggleDoubleTapZoom()
        XCTAssertEqual(zoom.steadyScale, ImageViewerZoomModel.doubleTapZoomScale)

        zoom.endPan(translation: CGSize(width: 10, height: 10))
        zoom.toggleDoubleTapZoom()
        XCTAssertEqual(zoom.steadyScale, ImageViewerZoomModel.minScale)
        XCTAssertEqual(zoom.steadyOffset, .zero)
    }

    func testPanAccumulatesAcrossGestures() {
        var zoom = ImageViewerZoomModel()
        zoom.endMagnification(factor: 2)

        zoom.endPan(translation: CGSize(width: 30, height: 5))
        zoom.endPan(translation: CGSize(width: -10, height: 15))

        XCTAssertEqual(zoom.steadyOffset, CGSize(width: 20, height: 20))
    }

    func testSwipeDismissRequiresBeingUnzoomedAndPastTheThreshold() {
        let past = CGSize(width: 0, height: ImageViewerZoomModel.dismissTranslationThreshold + 1)
        let short = CGSize(width: 0, height: ImageViewerZoomModel.dismissTranslationThreshold - 1)
        let upward = CGSize(width: 0, height: -300)

        XCTAssertTrue(ImageViewerZoomModel.shouldDismiss(onSwipeTranslation: past, isZoomedIn: false))
        XCTAssertFalse(ImageViewerZoomModel.shouldDismiss(onSwipeTranslation: short, isZoomedIn: false))
        XCTAssertFalse(ImageViewerZoomModel.shouldDismiss(onSwipeTranslation: upward, isZoomedIn: false))
        XCTAssertFalse(ImageViewerZoomModel.shouldDismiss(onSwipeTranslation: past, isZoomedIn: true), "while zoomed the same drag is a PAN — it must never dismiss")
    }

    // MARK: - Tap activation policy (inert images stay inert)

    func testTapIsEnabledOnlyForADecodedImageWithAURLAndAHandler() throws {
        let decoded = try XCTUnwrap(PlatformImage(data: Self.onePixelPNGData))
        let url = Self.canonical

        XCTAssertTrue(WorkspaceMarkdownImageTapPolicy.isTapEnabled(decodedImage: decoded, url: url, hasTapHandler: true))
        XCTAssertFalse(WorkspaceMarkdownImageTapPolicy.isTapEnabled(decodedImage: nil, url: url, hasTapHandler: true), "an inert/failed image (nothing decoded) must not be tappable")
        XCTAssertFalse(WorkspaceMarkdownImageTapPolicy.isTapEnabled(decodedImage: decoded, url: nil, hasTapHandler: true), "no URL — nothing to open a viewer for")
        XCTAssertFalse(WorkspaceMarkdownImageTapPolicy.isTapEnabled(decodedImage: decoded, url: url, hasTapHandler: false), "a screen that didn't opt into the viewer keeps images non-tappable")
    }

    /// The provider still conforms to swift-markdown-ui's `ImageProvider`
    /// with the tap seam attached — and the no-handler default keeps
    /// existing call sites source-compatible (compile-time check).
    func testProviderAcceptsTheOptionalTapHandler() {
        let loader = RecordingLoader { _ in throw StubFetchError() }
        _ = WorkspaceMarkdownImageProvider(loader: loader)
        _ = WorkspaceMarkdownImageProvider(loader: loader, onImageTap: { _, _ in })
    }

    // MARK: - Item identity

    func testViewerItemIsIdentifiedByItsCanonicalURL() {
        let item = ImageViewerItem(canonicalURL: Self.canonical, initialImage: nil)
        XCTAssertEqual(item.id, Self.canonical.absoluteString)
    }

    // MARK: - Confidential banner inside the cover

    /// Renders `ImageViewerView`'s actual body (loading state — `.task`
    /// never fires under `ImageRenderer`) with and without a confidential
    /// notice and proves exactly one thing: passing a notice changes what
    /// the viewer's own content paints — i.e. the banner is re-applied
    /// INSIDE the cover's content, not only on the chrome root underneath.
    /// (That a fullscreen cover draws above the chrome root's banner — the
    /// WHY of the re-application — is SwiftUI presentation-layer behavior a
    /// pixel diff cannot assert, and is deliberately not claimed here.)
    @MainActor
    func testConfidentialNoticeChangesWhatTheViewerActuallyRenders() throws {
        let loader = RecordingLoader { _ in throw StubFetchError() }
        let resolver = StubResolver(resolved: Self.canonical.absoluteString)
        let item = ImageViewerItem(canonicalURL: Self.canonical, initialImage: nil)

        let withNotice = try renderToPNGData(
            ImageViewerView(item: item, loader: loader, resolver: resolver, confidentialNotice: "Do not share")
        )
        let withoutNotice = try renderToPNGData(
            ImageViewerView(item: item, loader: loader, resolver: resolver, confidentialNotice: nil)
        )

        XCTAssertNotEqual(withNotice, withoutNotice, "the confidential banner must actually paint inside the viewer content")
    }

    @MainActor
    private func renderToPNGData(_ view: some View) throws -> Data {
        let renderer = ImageRenderer(content: view.frame(width: 300, height: 400))
        renderer.scale = 1
        #if canImport(AppKit)
        guard
            let nsImage = renderer.nsImage,
            let tiff = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else {
            throw RenderingUnavailable()
        }
        return png
        #else
        throw RenderingUnavailable()
        #endif
    }
}

/// Same reason as `SearchCapabilityToolbarButtonTests.RenderingUnavailable`:
/// the `#else` branch only exists so the iOS side of the pair type-checks —
/// `swift test` always runs the macOS side.
private struct RenderingUnavailable: Error {}

private struct StubFetchError: Error {}

/// A `ViewerImageURLResolving` stub returning a fixed resolution — the
/// resolver's own logic is covered by `OriginalImageResolverTests`; these
/// tests only need its two possible outcomes.
private struct StubResolver: ViewerImageURLResolving {
    let resolved: String

    func viewerImageURLString(for canonical: URL) async -> String { resolved }
}

/// A `WorkspaceImageFetching` stub recording every fetched URL string —
/// the assertion surface for "the viewer reuses the ONE image seam".
private final class RecordingLoader: WorkspaceImageFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var _fetched: [String] = []
    private let handler: @Sendable (String) throws -> Data

    init(handler: @escaping @Sendable (String) throws -> Data) {
        self.handler = handler
    }

    func fetch(_ urlString: String) async throws -> Data {
        lock.lock()
        _fetched.append(urlString)
        lock.unlock()
        return try handler(urlString)
    }

    var fetched: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _fetched
    }
}
