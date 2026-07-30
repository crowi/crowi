import CoreGraphics
import Foundation
import SwiftDraw

/// RFC-0023 Phase 5 — the ONE chokepoint wrapping the selected SVG library
/// (SwiftDraw). Nothing else in CrowiKit may import SwiftDraw: this seam is
/// what lets `RenderedAstSvgResourceLoadingTests` pin the library-level
/// guarantees once, for every current and future call site.
///
/// The three guarantees this seam owns (parent spec §8 / design doc §10):
///
///   1. **Synchronous rasterization.** `rasterize` parses and draws on the
///      calling thread and returns a finished raster image — no callbacks,
///      no async, no run-loop dependency. (The revised SSR contract permits
///      synchronous native composition; anything async would reintroduce
///      the layout-shift class the reservation design removes.)
///   2. **No external resource loading.** SwiftDraw resolves `<image href>`
///      exclusively from `data:` URIs (`URL.decodedData` — a remote http(s)
///      href fails decoding and the element is skipped via `try?`), `<use>`
///      only against in-document ids, and `@font-face src` again only from
///      `data:` URIs. There is no URLSession / file fetch anywhere in the
///      static rasterize path. This is the CLIENT half of the double
///      defense — the server already re-sanitized the sidecar SVG with
///      `allowSafeHref: false` — and it is pinned empirically by
///      `RenderedAstSvgResourceLoadingTests` (a URLProtocol spy observing
///      zero requests), so a library upgrade that grows a fetch path turns
///      into a red test, not a silent exfiltration channel.
///   3. **Bounded raster memory.** The raster target goes through
///      `RenderedAstRasterBudget` and is drawn at an explicit 1× scale —
///      never SwiftDraw's screen-scale default. Sidecar dimensions are
///      only validated to `1...16384`, and 16384² at a 3× screen scale is
///      a multi-GB backing store; the budget caps the longest raster side
///      instead, and the caller's reservation box (which keeps the
///      intrinsic dimensions) scale-fits the smaller raster back up.
public enum RenderedAstSvgRenderer {
    /// Synchronously rasterize SVG bytes into a platform image sized for
    /// `size` points (the sidecar's intrinsic dimensions), with the raster
    /// itself bounded by `RenderedAstRasterBudget`. Returns `nil` when the
    /// bytes do not parse as a well-formed SVG document — the caller
    /// renders a VISIBLE placeholder, never a silent drop.
    public static func rasterize(svgData: Data, size: CGSize) -> PlatformImage? {
        rasterize(svgData: svgData, size: size, maxPixelSize: RenderedAstRasterBudget.maxPixelSize)
    }

    /// `maxPixelSize` is parameterized for tests only (pinning the budget
    /// without allocating a production-cap bitmap); production always goes
    /// through the public overload above.
    static func rasterize(svgData: Data, size: CGSize, maxPixelSize: CGFloat) -> PlatformImage? {
        guard let svg = SVG(data: svgData) else { return nil }
        let pixelSize = RenderedAstRasterBudget.boundedPixelSize(for: size, maxPixelSize: maxPixelSize)
        return svg.sized(pixelSize).rasterize(scale: 1)
    }
}
