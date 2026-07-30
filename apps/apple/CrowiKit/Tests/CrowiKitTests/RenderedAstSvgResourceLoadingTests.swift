import Foundation
import XCTest

@testable import CrowiKit

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// RFC-0023 Phase 5 AC 3 — the regression pin for the SVG renderer's
/// external-resource isolation (the client half of the double defense; the
/// server half is the `allowSafeHref: false` re-sanitisation of the sidecar
/// SVG).
///
/// The selected library (SwiftDraw, wrapped exclusively by
/// `RenderedAstSvgRenderer`) resolves `<image href>` only from `data:` URIs
/// and `<use>` only against in-document ids — structurally, there is no
/// fetch path in its static rasterizer. This suite pins that EMPIRICALLY: a
/// `URLProtocol` spy is registered across the whole URL loading system, an
/// SVG stuffed with external references is rasterized (and force-drawn),
/// and the spy must have observed ZERO requests. A library upgrade that
/// grows a fetch path turns into a red test here, not a silent
/// exfiltration/tracking channel.
final class RenderedAstSvgResourceLoadingTests: XCTestCase {
    override func setUp() {
        super.setUp()
        SpyURLProtocol.reset()
        URLProtocol.registerClass(SpyURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(SpyURLProtocol.self)
        super.tearDown()
    }

    private func forceDraw(_ image: PlatformImage) {
        #if canImport(UIKit)
        _ = UIGraphicsImageRenderer(size: image.size).image { _ in
            image.draw(at: .zero)
        }
        #elseif canImport(AppKit)
        // NSImage defers its drawing handler — forcing a bitmap
        // representation executes the actual draw commands.
        _ = image.tiffRepresentation
        #endif
    }

    /// A short run-loop drain so any (illegitimate) asynchronous fetch the
    /// library might schedule would surface before the assertion.
    private func drainRunLoop() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }

    func testExternalResourceReferencesNeverTouchTheNetwork() {
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20" width="40" height="20">
          <defs><rect id="local" width="10" height="10" /></defs>
          <image href="https://external.invalid/exfil.png" width="10" height="10" />
          <image xlink:href="https://external.invalid/exfil-xlink.png" x="10" width="10" height="10" />
          <use href="https://external.invalid/defs.svg#remote" />
          <use xlink:href="#local" x="20" />
          <rect x="30" width="10" height="20" />
        </svg>
        """

        _ = RenderedAstSvgRenderer.rasterize(svgData: Data(svg.utf8), size: CGSize(width: 40, height: 20))
            .map(forceDraw)
        drainRunLoop()

        XCTAssertEqual(
            SpyURLProtocol.observedRequests, [],
            "rasterizing an SVG with external <image>/<use> references must never touch the URL loading system"
        )
    }

    /// The nominal path: a self-contained SVG rasterizes synchronously (the
    /// image is fully formed on return — no callback, no await) to the
    /// requested point size, still with zero network involvement.
    func testSelfContainedSvgRasterizesSynchronouslyWithoutNetwork() throws {
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="teal"/></svg>"#

        let image = try XCTUnwrap(
            RenderedAstSvgRenderer.rasterize(svgData: Data(svg.utf8), size: CGSize(width: 20, height: 10))
        )
        forceDraw(image)
        drainRunLoop()

        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertGreaterThan(image.size.height, 0)
        // Aspect is preserved through the sized rasterization (2:1).
        XCTAssertEqual(image.size.width / image.size.height, 2, accuracy: 0.01)
        XCTAssertEqual(SpyURLProtocol.observedRequests, [])
    }

    /// A data-URI embedded image is the ONE `<image>` form the library
    /// decodes — entirely offline (this is why diagrams with embedded
    /// rasters still render).
    func testDataUriImagesDecodeWithoutNetwork() {
        let pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
          <image href="data:image/png;base64,\(pixel)" width="10" height="10" />
        </svg>
        """

        _ = RenderedAstSvgRenderer.rasterize(svgData: Data(svg.utf8), size: CGSize(width: 10, height: 10))
            .map(forceDraw)
        drainRunLoop()

        XCTAssertEqual(SpyURLProtocol.observedRequests, [])
    }

    /// Malformed bytes return `nil` (→ the caller's visible placeholder),
    /// never a crash and never a fetch.
    func testMalformedSvgReturnsNil() {
        XCTAssertNil(RenderedAstSvgRenderer.rasterize(svgData: Data("not an svg at all".utf8), size: CGSize(width: 10, height: 10)))
        XCTAssertNil(RenderedAstSvgRenderer.rasterize(svgData: Data("<svg".utf8), size: CGSize(width: 10, height: 10)))
        drainRunLoop()
        XCTAssertEqual(SpyURLProtocol.observedRequests, [])
    }
}

/// Records every non-file URL the URL loading system is asked to load while
/// registered — `canInit` observes and rejects the load, so a hit both
/// fails the assertion AND never actually reaches the network.
final class SpyURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var _observed: [String] = []

    static var observedRequests: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _observed
    }

    static func reset() {
        lock.lock()
        _observed = []
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        if let url = request.url, url.scheme != "file" {
            lock.lock()
            _observed.append(url.absoluteString)
            lock.unlock()
        }
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
}
