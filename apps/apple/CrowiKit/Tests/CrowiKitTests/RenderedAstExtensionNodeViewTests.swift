import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import CrowiKit

/// RFC-0023 Phase 5 — the typed-extension-node rendering rules, asserted at
/// the pure seams (the `WorkspaceMarkdownImageLoading` stance: no SwiftUI
/// host inspection):
///
///   - `crowiDiagram`: pre-decode reservation geometry + the PNG and SVG
///     decode modes + the visible-failure phase;
///   - `math` / `inlineMath`: synchronous TeX typesetting + the monospaced
///     TeX-source degrade (never a silent drop) + the a11y label carrying
///     the TeX source;
///   - `crowiLinkCard`: display-field rules (url-only cards are first-class),
///     the image-slot allow-list gate, and the fixed-slot state machine;
///   - `crowiPlaceholder`: the 13-kind → 3-group mapping, server-label
///     priority, and reservation-variant honoring.
final class RenderedAstExtensionNodeViewTests: XCTestCase {
    /// A complete, valid 1×1 transparent PNG.
    private let onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    private let simpleSvg = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>"#

    private func svgPayload(width: Int = 20, height: Int = 10) -> RenderedAstImagePayload {
        RenderedAstImagePayload(
            mediaType: "image/svg+xml",
            base64: Data(simpleSvg.utf8).base64EncodedString(),
            width: width,
            height: height
        )
    }

    /// A real flat-fill PNG at arbitrary pixel dimensions (the shape the
    /// budget exists for: flat fills compress so well that a huge canvas
    /// still fits the ≤100KB payload validation).
    private func makePng(width: Int, height: Int) throws -> Data {
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    // MARK: - crowiDiagram: reservation geometry (pre-decode)

    /// The reservation is derived from the sidecar's intrinsic dimensions
    /// alone — available BEFORE any decode, which is what makes the
    /// image swap shift-free (Phase 5 AC 1).
    func testDiagramReservationUsesIntrinsicDimensions() {
        XCTAssertEqual(RenderedAstDiagramView.aspectRatio(of: svgPayload(width: 20, height: 10)), 2)
        XCTAssertEqual(RenderedAstDiagramView.aspectRatio(of: svgPayload(width: 300, height: 600)), 0.5)
    }

    // MARK: - crowiDiagram: decode modes

    func testDiagramSvgPayloadDecodesToAnImage() throws {
        guard case .image(let image) = RenderedAstDiagramView.decode(svgPayload()) else {
            return XCTFail("a valid SVG payload must decode to an image")
        }
        XCTAssertGreaterThan(image.size.width, 0)
        // The raster preserves the intrinsic aspect (2:1).
        XCTAssertEqual(image.size.width / image.size.height, 2, accuracy: 0.01)
    }

    func testDiagramPngPayloadDecodesToAnImage() {
        let payload = RenderedAstImagePayload(mediaType: "image/png", base64: onePixelPng, width: 1, height: 1)
        guard case .image = RenderedAstDiagramView.decode(payload) else {
            return XCTFail("a valid PNG payload must decode to an image")
        }
    }

    /// Rasterization failure is a VISIBLE placeholder phase — never a
    /// silent drop (wire-contract §5's visible-render rule).
    func testDiagramUndecodablePayloadsFailVisibly() {
        let notAnImage = Data("hello".utf8).base64EncodedString()
        let badPng = RenderedAstImagePayload(mediaType: "image/png", base64: notAnImage, width: 10, height: 10)
        guard case .failed = RenderedAstDiagramView.decode(badPng) else {
            return XCTFail("undecodable PNG bytes must fail into the placeholder phase")
        }
        let badSvg = RenderedAstImagePayload(mediaType: "image/svg+xml", base64: notAnImage, width: 10, height: 10)
        guard case .failed = RenderedAstDiagramView.decode(badSvg) else {
            return XCTFail("unparseable SVG bytes must fail into the placeholder phase")
        }
    }

    // MARK: - crowiDiagram: raster memory budget

    /// The raster budget's geometry: small diagrams oversample for Retina
    /// crispness; the sidecar's validated maximum (16384², a ≈1 GB RGBA
    /// bitmap at face value) never reaches a rasterizer un-shrunk, and the
    /// shrink preserves the aspect ratio the layout reservation uses.
    func testRasterBudgetCapsTheLongestPixelSide() {
        XCTAssertEqual(
            RenderedAstRasterBudget.boundedPixelSize(for: CGSize(width: 300, height: 200)),
            CGSize(width: 600, height: 400)
        )
        let capped = RenderedAstRasterBudget.boundedPixelSize(for: CGSize(width: 16384, height: 16384))
        XCTAssertEqual(max(capped.width, capped.height), RenderedAstRasterBudget.maxPixelSize)
        let wide = RenderedAstRasterBudget.boundedPixelSize(for: CGSize(width: 16384, height: 8192))
        XCTAssertEqual(wide.width, RenderedAstRasterBudget.maxPixelSize)
        XCTAssertEqual(wide.height, RenderedAstRasterBudget.maxPixelSize / 2)
    }

    /// The SVG seam rasterizes within the pixel budget at an explicit 1×
    /// scale (guarantee 3) — a max-dimension sidecar must come back as a
    /// bounded bitmap, not a screen-scale-multiplied giant. The cap is
    /// parameterized here so pinning the bound doesn't allocate the
    /// production-cap bitmap in every test run.
    func testSvgRasterizationHonorsThePixelBudget() throws {
        let image = try XCTUnwrap(
            RenderedAstSvgRenderer.rasterize(
                svgData: Data(simpleSvg.utf8),
                size: CGSize(width: 16384, height: 8192),
                maxPixelSize: 64
            )
        )
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 64)
        XCTAssertEqual(image.size.width / image.size.height, 2, accuracy: 0.05, "the shrink preserves the aspect ratio")
    }

    /// PNG decoding is bounded the same way (ImageIO's downsampling
    /// thumbnail path): over-budget intrinsic dimensions decode to a
    /// bounded bitmap, under-budget ones keep their intrinsic dimensions.
    func testPngDecodeHonorsThePixelBudget() throws {
        let pngData = try makePng(width: 256, height: 128)
        let bounded = try XCTUnwrap(RenderedAstDiagramView.decodePngBounded(pngData, maxPixelSize: 64))
        XCTAssertLessThanOrEqual(max(bounded.size.width, bounded.size.height), 64)
        XCTAssertEqual(bounded.size.width / bounded.size.height, 2, accuracy: 0.05, "the shrink preserves the aspect ratio")

        let full = try XCTUnwrap(RenderedAstDiagramView.decodePngBounded(pngData))
        XCTAssertEqual(full.size, CGSize(width: 256, height: 128))
    }

    // MARK: - math: synchronous typesetting + degrade

    func testMathTypesetsSynchronouslyFromTeX() throws {
        let display = try XCTUnwrap(RenderedAstMathTypesetter.typeset(tex: "E = mc^2", display: true, isDark: false))
        XCTAssertGreaterThan(display.image.size.width, 0)
        XCTAssertGreaterThan(display.image.size.height, 0)

        let inline = try XCTUnwrap(RenderedAstMathTypesetter.typeset(tex: "\\frac{a}{b}", display: false, isDark: true))
        XCTAssertGreaterThan(inline.image.size.width, 0)
        XCTAssertGreaterThanOrEqual(inline.descent, 0, "the layout info feeds the inline baseline alignment")
    }

    func testMathTypesettingFailureReturnsNil() {
        // An unterminated group is a parse error, not a crash.
        XCTAssertNil(RenderedAstMathTypesetter.typeset(tex: "\\frac{1}{", display: true, isDark: false))
    }

    /// A typeset `inlineMath` becomes a math piece; its TeX source feeds
    /// the paragraph accessibility label (an image carries no text).
    func testInlineMathRendersAsABaselineAlignedRun() {
        let result = RenderedAstInlineRenderer().render([
            RenderedAstNode(kind: .text(value: "mass-energy: ")),
            RenderedAstNode(kind: .inlineMath(value: "E = mc^2", meta: nil)),
        ])
        XCTAssertEqual(result.mathRuns.count, 1)
        XCTAssertEqual(result.mathRuns.first?.tex, "E = mc^2")
        XCTAssertLessThanOrEqual(result.mathRuns.first?.baselineOffset ?? 1, 0, "the run shifts DOWN by the descent")
        let label = result.accessibilityLabel
        XCTAssertNotNil(label)
        XCTAssertTrue(label?.contains("mass-energy: ") == true)
        XCTAssertTrue(label?.contains("E = mc^2") == true)
        XCTAssertEqual(String(result.attributed.characters), "mass-energy: ", "the math run itself is an image piece, not text")
    }

    /// Typesetting failure degrades to a monospaced chip OF THE TEX SOURCE
    /// — readable content, never the generic "unavailable" copy, never a
    /// drop (architectural pin).
    func testInlineMathFailureDegradesToTheTexSource() {
        let result = RenderedAstInlineRenderer().render([
            RenderedAstNode(kind: .inlineMath(value: "\\frac{1}{", meta: nil))
        ])
        XCTAssertTrue(result.mathRuns.isEmpty)
        XCTAssertTrue(String(result.attributed.characters).contains("\\frac{1}{"), "the TeX source must stay readable")
    }

    // MARK: - crowiLinkCard: display rules

    /// A url-only card (fetch failure and toggle-off — the same shape by
    /// contract, deliberately indistinguishable) renders first-class with
    /// the URL in the title slot.
    func testUrlOnlyCardUsesTheUrlAsItsTitle() {
        let payload = RenderedAstLinkCardPayload(url: "https://example.com/x")
        XCTAssertEqual(RenderedAstLinkCardView.displayTitle(for: payload), "https://example.com/x")
        XCTAssertNil(RenderedAstLinkCardView.footerText(for: payload))
        XCTAssertNil(RenderedAstLinkCardView.slotImageURL(for: payload))
    }

    func testStructuredCardDisplayFields() {
        let payload = RenderedAstLinkCardPayload(
            url: "https://example.com/article",
            title: "Example article",
            description: "An example page.",
            imageURL: "https://example.com/og.png",
            siteName: "Example",
            domain: "example.com"
        )
        XCTAssertEqual(RenderedAstLinkCardView.displayTitle(for: payload), "Example article")
        XCTAssertEqual(RenderedAstLinkCardView.footerText(for: payload), "Example · example.com")
        XCTAssertEqual(RenderedAstLinkCardView.slotImageURL(for: payload)?.absoluteString, "https://example.com/og.png")
    }

    /// The image slot goes through the ONE shared `SchemeAllowlist` (plus
    /// the card's absolute-URL requirement) — belt and suspenders over the
    /// decoder's own http(s)-only gate.
    func testCardImageSlotGatesUrlsThroughTheAllowlist() {
        func slotURL(_ imageURL: String?) -> URL? {
            RenderedAstLinkCardView.slotImageURL(for: RenderedAstLinkCardPayload(url: "https://example.com/", imageURL: imageURL))
        }
        XCTAssertNotNil(slotURL("https://example.com/og.png"))
        XCTAssertNotNil(slotURL("http://example.com/og.png"))
        XCTAssertNil(slotURL("javascript:alert(1)"))
        XCTAssertNil(slotURL("data:image/png;base64,AAAA"))
        XCTAssertNil(slotURL("/relative/og.png"), "an external OGP image has no workspace to rebase a relative URL against")
        XCTAssertNil(slotURL(nil))
    }

    /// The fixed slot is reserved in EVERY load state (Phase 5 AC 5): a
    /// failed load renders the image-less presentation (an empty slot with
    /// no visible content) but never removes the reservation, so a card's
    /// height cannot change when the request finishes.
    func testCardImageSlotStaysReservedInEveryLoadState() {
        XCTAssertEqual(RenderedAstLinkCardImageState.loading.slotPresentation, .pendingChrome)
        let onePixel = Data(base64Encoded: onePixelPng).flatMap(PlatformImage.init(data:))
        if let onePixel {
            XCTAssertEqual(RenderedAstLinkCardImageState.loaded(onePixel).slotPresentation, .image(onePixel))
        }
        XCTAssertEqual(
            RenderedAstLinkCardImageState.failed.slotPresentation,
            .empty,
            "failure empties the slot's content — it must not collapse the reservation"
        )
    }

    // MARK: - crowiPlaceholder: kind groups + reservation variants

    func testPlaceholderKindsMapToTheirGroups() {
        let renderErrors: [RenderedAstPlaceholderKind] = [
            .errorAuth, .errorRateLimit, .errorNotFound, .errorNetwork,
            .errorTimeout, .errorUnknown, .errorBlocked, .errorBusy,
        ]
        for kind in renderErrors {
            XCTAssertEqual(RenderedAstPlaceholderCopy.group(for: kind).fallbackLabel, RenderedAstPlaceholderCopy.renderFailed)
        }
        let sizeLimits: [RenderedAstPlaceholderKind] = [.sizeLimitEntry, .sizeLimitPage, .dispatchLimit]
        for kind in sizeLimits {
            XCTAssertEqual(RenderedAstPlaceholderCopy.group(for: kind).fallbackLabel, RenderedAstPlaceholderCopy.sizeLimited)
        }
        for kind in [RenderedAstPlaceholderKind.validationFailed, .envelopeInvalid] {
            XCTAssertEqual(RenderedAstPlaceholderCopy.group(for: kind).fallbackLabel, RenderedAstPlaceholderCopy.blockUnavailable)
        }
    }

    /// A non-empty server `label` wins (current behavior, unchanged); the
    /// group copy is the fallback for an empty one.
    func testServerLabelWinsOverGroupCopy() {
        XCTAssertEqual(
            RenderedAstPlaceholderCopy.placeholderLabel(kind: .errorTimeout, serverLabel: "Rendering timed out"),
            "Rendering timed out"
        )
        XCTAssertEqual(
            RenderedAstPlaceholderCopy.placeholderLabel(kind: .errorTimeout, serverLabel: ""),
            RenderedAstPlaceholderCopy.renderFailed
        )
        XCTAssertEqual(
            RenderedAstPlaceholderCopy.placeholderLabel(kind: .sizeLimitPage, serverLabel: ""),
            RenderedAstPlaceholderCopy.sizeLimited
        )
    }

    /// `fixed` reservations honor BOTH dimensions: the height always
    /// reserves (48pt block floor, 4096 server-clamp mirror) and a
    /// positive `widthPx` reserves the width too — `nil` means "no width
    /// declared, fill the column", so absent / non-positive declarations
    /// keep the full-width chip.
    func testFixedReservationHonorsWidthAndHeight() {
        let both = RenderedAstPlaceholderView.fixedReservationSize(widthPx: 320, heightPx: 180)
        XCTAssertEqual(both.maxWidth, 320)
        XCTAssertEqual(both.minHeight, 180)

        let heightOnly = RenderedAstPlaceholderView.fixedReservationSize(widthPx: nil, heightPx: 120)
        XCTAssertNil(heightOnly.maxWidth)
        XCTAssertEqual(heightOnly.minHeight, 120)

        let floored = RenderedAstPlaceholderView.fixedReservationSize(widthPx: 24, heightPx: 10)
        XCTAssertEqual(floored.maxWidth, 24)
        XCTAssertEqual(floored.minHeight, 48, "the 48pt block floor applies to the height")

        for bogusWidth in [0.0, -5.0] {
            let ignored = RenderedAstPlaceholderView.fixedReservationSize(widthPx: bogusWidth, heightPx: 60)
            XCTAssertNil(ignored.maxWidth, "a non-positive width declaration keeps the full-width chip")
            XCTAssertEqual(ignored.minHeight, 60)
        }

        let clamped = RenderedAstPlaceholderView.fixedReservationSize(widthPx: 10_000, heightPx: 10_000)
        XCTAssertEqual(clamped.maxWidth, 4096, "widths mirror the server's 4096 clamp")
        XCTAssertEqual(clamped.minHeight, 4096, "heights mirror the server's 4096 clamp")
    }

    func testCardReservationHeightsAreTiered() {
        let small = RenderedAstPlaceholderView.cardReservationHeight(size: "small")
        let medium = RenderedAstPlaceholderView.cardReservationHeight(size: "medium")
        let large = RenderedAstPlaceholderView.cardReservationHeight(size: "large")
        XCTAssertLessThan(small, medium)
        XCTAssertLessThan(medium, large)
        XCTAssertEqual(RenderedAstPlaceholderView.cardReservationHeight(size: "unknown"), medium, "unknown tiers take the middle height")
    }

    /// Inline placeholders use the same label rule (server label first,
    /// then group copy).
    func testInlinePlaceholderChipsUseTheKindGroupedLabel() {
        let labeled = RenderedAstInlineRenderer().render([
            RenderedAstNode(kind: .crowiPlaceholder(
                kind: .errorNetwork,
                label: "Diagram fetch failed",
                reservation: .fixed(widthPx: nil, heightPx: 48)
            ))
        ])
        XCTAssertTrue(String(labeled.attributed.characters).contains("Diagram fetch failed"))

        let unlabeled = RenderedAstInlineRenderer().render([
            RenderedAstNode(kind: .crowiPlaceholder(
                kind: .errorNetwork,
                label: "",
                reservation: .fixed(widthPx: nil, heightPx: 48)
            ))
        ])
        XCTAssertTrue(String(unlabeled.attributed.characters).contains(RenderedAstPlaceholderCopy.renderFailed))
    }
}
