import Foundation
import ImageIO
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// RFC-0023 Phase 5 — native rendering for `crowiDiagram` nodes (Mermaid /
/// PlantUML, SVG or PNG payload).
///
/// Layout contract (parent spec Phase 5 AC 1): the block's area is reserved
/// **before** any decode happens, from the sidecar's intrinsic dimensions
/// (`width`/`height`, server-derived from the SVG viewBox / PNG IHDR and
/// validated to `1...16384` on decode) — an aspect-ratio box capped at the
/// intrinsic width. Decoding then swaps the finished image into that same
/// box, so the swap can never shift layout.
///
/// Memory contract: the intrinsic dimensions drive LAYOUT only. The raster
/// actually materialized in memory goes through `RenderedAstRasterBudget`
/// (both decode modes), because a payload that passes every §10 validation
/// can still declare 16384×16384 — decoding that at face value allocates
/// a ≈1 GB RGBA backing store (× display-scale² for a rasterizer that
/// follows the screen scale) and gets the app jetsammed.
///
/// Failure contract: an undecodable payload (corrupt PNG bytes, an SVG the
/// renderer cannot parse) renders a VISIBLE placeholder — never a silent
/// drop (wire-contract §5's visible-render rule). The §10 deep validation
/// (canonical base64, decoded ≤100KB, PNG signature) already ran in the
/// strict decoder, so payloads reaching this view are structurally sound;
/// this is the last-resort raster boundary.
struct RenderedAstDiagramView: View {
    let alt: String
    let image: RenderedAstImagePayload

    @State private var phase: RenderedAstDiagramPhase = .reserved

    var body: some View {
        reservedBox
            .task { decodeIfNeeded() }
    }

    /// The pre-decode reservation: intrinsic aspect ratio, capped at the
    /// intrinsic width (the same "never upscale, aspect-fit into narrower
    /// columns" rule `ImageDisplayAttributes`' block path applies). The
    /// budget-bounded raster is always drawn `scaledToFit` into this box,
    /// so downsampling a huge diagram never changes its layout.
    ///
    /// EVERY phase renders inside this same geometry — including `.failed`.
    /// The reservation is a promise to the layout, not to the happy path:
    /// a decode failure swaps the CONTENT of the box for the visible
    /// placeholder but never collapses the box itself, so the failure path
    /// causes no layout shift either (the same rule the server's error
    /// placeholders follow by carrying reservation dimensions,
    /// `cache/reservation.ts`).
    private var reservedBox: some View {
        Group {
            switch phase {
            case .image(let decoded):
                Image(platformImage: decoded)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel(Text(alt))
            case .failed:
                // The placeholder carries its own failure copy for
                // accessibility — the alt text would misdescribe a box
                // that is showing an error, not the diagram.
                RenderedAstPlaceholderView(label: RenderedAstPlaceholderCopy.diagramFailed)
            case .reserved:
                Color.primary.opacity(0.03)
                    .accessibilityLabel(Text(alt))
            }
        }
        .aspectRatio(Self.aspectRatio(of: image), contentMode: .fit)
        .frame(maxWidth: CGFloat(image.width))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func decodeIfNeeded() {
        guard case .reserved = phase else { return }
        phase = Self.decode(image)
    }

    static func aspectRatio(of payload: RenderedAstImagePayload) -> CGFloat {
        CGFloat(payload.width) / CGFloat(payload.height)
    }

    /// The pure decode step (free-standing for tests, the
    /// `WorkspaceMarkdownImageLoading` precedent): base64 → raster image.
    /// PNG decodes through the bounded ImageIO path below; SVG goes through
    /// the ONE `RenderedAstSvgRenderer` seam (never the library directly),
    /// which applies the same raster budget.
    static func decode(_ payload: RenderedAstImagePayload) -> RenderedAstDiagramPhase {
        guard let data = Data(base64Encoded: payload.base64) else { return .failed }
        let size = CGSize(width: payload.width, height: payload.height)
        let decoded: PlatformImage?
        if payload.mediaType == "image/svg+xml" {
            decoded = RenderedAstSvgRenderer.rasterize(svgData: data, size: size)
        } else {
            decoded = Self.decodePngBounded(data)
        }
        guard let decoded else { return .failed }
        return .image(decoded)
    }

    /// Bounded PNG decode — ImageIO's downsample-while-decoding thumbnail
    /// path, which never materializes a bitmap whose longest side exceeds
    /// `maxPixelSize` even though a ≤100KB PNG payload (flat fills compress
    /// extremely well) can legitimately declare 16384×16384. `maxPixelSize`
    /// is parameterized for tests only; production always uses the shared
    /// budget. Returns `nil` for bytes ImageIO cannot decode — the caller
    /// falls into the visible-placeholder phase.
    static func decodePngBounded(
        _ data: Data,
        maxPixelSize: CGFloat = RenderedAstRasterBudget.maxPixelSize
    ) -> PlatformImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let thumbnailOptions =
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ] as [CFString: Any]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary)
        else { return nil }
        #if canImport(UIKit)
        return UIImage(cgImage: cgImage)
        #else
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        #endif
    }
}

enum RenderedAstDiagramPhase {
    case reserved
    case image(PlatformImage)
    case failed
}

/// The shared raster-memory budget for diagram payloads (both decode
/// modes). Sidecar dimensions are only validated to `1...16384` — big
/// enough that a face-value raster is a multi-GB allocation — so every
/// bitmap this feature materializes fits this budget: the longest side
/// never exceeds `maxPixelSize` (4096² RGBA ≈ 64 MB worst case), while
/// layout keeps using the intrinsic dimensions untouched.
enum RenderedAstRasterBudget {
    /// Longest allowed raster side, in pixels.
    static let maxPixelSize: CGFloat = 4096
    /// Oversampling applied when the budget allows it, so small diagrams
    /// stay crisp on Retina displays despite the explicit 1× raster scale
    /// (a deterministic constant — never the screen scale, which is what
    /// multiplies a huge raster into a jetsam).
    static let preferredScale: CGFloat = 2

    /// Aspect-preserving pixel target for an intrinsic point size:
    /// `size × preferredScale`, then shrunk so the longest side fits
    /// `maxPixelSize` (never enlarged beyond the oversampled size).
    static func boundedPixelSize(
        for size: CGSize,
        maxPixelSize: CGFloat = Self.maxPixelSize
    ) -> CGSize {
        let scaled = CGSize(width: size.width * preferredScale, height: size.height * preferredScale)
        let longest = max(scaled.width, scaled.height)
        guard longest > maxPixelSize else { return scaled }
        let shrink = maxPixelSize / longest
        return CGSize(
            width: max(1, (scaled.width * shrink).rounded()),
            height: max(1, (scaled.height * shrink).rounded())
        )
    }
}
