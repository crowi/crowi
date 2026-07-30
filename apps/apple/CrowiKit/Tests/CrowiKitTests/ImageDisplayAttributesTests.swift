import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// RFC-0015 (`feature-ios-phase3-notifications-extensions`) — pins that the
/// Swift validation is byte-for-byte the server's DROP rule
/// (`core/image-attrs.ts:142-150` / `parseAttrBody`), including the spec's
/// boundary sextet (1% / 100% / 101% drop / 1px / 4096px / 4097px drop),
/// the URL-fragment carry round-trip with its byte-identity invariant, and
/// the block-path APPLICATION at the actual SwiftUI render level.
@MainActor
final class ImageDisplayAttributesTests: XCTestCase {
    private func parse(_ interior: String) -> ImageDisplayAttributes {
        ImageDisplayAttributes.parse(attributeBlockInterior: interior)
    }

    // MARK: - The boundary sextet (validation — closed intervals, DROP not clamp)

    func testWidthBoundarySextetMatchesTheServerRule() {
        XCTAssertEqual(parse("width=1%").width?.raw, "1%", "1% is inside the closed interval")
        XCTAssertEqual(parse("width=100%").width?.raw, "100%", "100% is inside the closed interval")
        XCTAssertNil(parse("width=101%").width, "101% is out of range — DROPPED, never clamped to 100%")
        XCTAssertEqual(parse("width=1px").width?.raw, "1px", "1px is inside the closed interval")
        XCTAssertEqual(parse("width=4096px").width?.raw, "4096px", "4096px is inside the closed interval")
        XCTAssertNil(parse("width=4097px").width, "4097px is out of range — DROPPED, never clamped to 4096px")
    }

    func testSubOneAndZeroValuesDrop() {
        XCTAssertNil(parse("width=0%").width)
        XCTAssertNil(parse("width=0px").width)
        XCTAssertNil(parse("width=0.5%").width, "the lower bound is 1, closed — 0.5 is outside")
    }

    func testDecimalValuesInsideTheRangeValidate() {
        XCTAssertEqual(parse("width=12.5%").width?.raw, "12.5%")
        XCTAssertEqual(parse("width=12.5%").width?.number, 12.5)
        XCTAssertEqual(parse("width=99.5px").width?.unit, .pixels)
    }

    func testUnitlessAndMalformedSizesDrop() {
        XCTAssertNil(parse("width=60").width, "unit-less values are dropped (SIZE_RE requires % or px)")
        XCTAssertNil(parse("width=60em").width)
        XCTAssertNil(parse("width=-5px").width)
        XCTAssertNil(parse("width=px").width)
        XCTAssertNil(parse("width=６０%").width, "full-width digits must not validate — JS \\d is ASCII-only")
    }

    func testHeightUsesTheSameSizeRule() {
        XCTAssertEqual(parse("height=4096px").height?.raw, "4096px")
        XCTAssertNil(parse("height=4097px").height)
        XCTAssertEqual(parse("height=100%").height?.raw, "100%")
        XCTAssertNil(parse("height=101%").height)
    }

    // MARK: - align / float allowlists (value case-sensitive, key case-insensitive)

    func testAlignAllowlistMatchesTheServer() {
        XCTAssertEqual(parse("align=left").align, .left)
        XCTAssertEqual(parse("align=center").align, .center)
        XCTAssertEqual(parse("align=right").align, .right)
        XCTAssertNil(parse("align=middle").align)
        XCTAssertNil(parse("align=Left").align, "values are compared case-sensitively (the server's Set.has)")
    }

    func testFloatAllowlistMatchesTheServer() {
        XCTAssertEqual(parse("float=left").float, .left)
        XCTAssertEqual(parse("float=right").float, .right)
        XCTAssertNil(parse("float=center").float)
    }

    func testKeysAreLowercasedBeforeMatchingLikeTheServer() {
        XCTAssertEqual(parse("WIDTH=60%").width?.raw, "60%")
        XCTAssertEqual(parse("Align=center").align, .center)
    }

    // MARK: - Unknown keys / malformed tokens / last-valid-wins

    func testUnknownKeysAndMalformedTokensAreIgnored() {
        let attrs = parse("foo=bar width=60% =broken novalue= just-a-word")
        XCTAssertEqual(attrs.width?.raw, "60%")
        XCTAssertNil(attrs.height)
        XCTAssertNil(attrs.align)
        XCTAssertNil(attrs.float)
    }

    func testLastValidOccurrenceWinsAndAnInvalidRepeatDoesNotClearAnEarlierValidOne() {
        XCTAssertEqual(parse("width=30% width=60%").width?.raw, "60%", "last VALID wins")
        XCTAssertEqual(parse("width=60% width=101%").width?.raw, "60%", "an invalid repeat must not clear the earlier valid value")
    }

    func testEmptyInteriorParsesToEmptyAttributes() {
        XCTAssertTrue(parse("").isEmpty)
        XCTAssertTrue(parse("foo=bar").isEmpty)
    }

    // MARK: - Fragment carry round-trip + byte-identity invariant

    func testFragmentValueRoundTripsThroughParseFragmentPayload() {
        let attrs = parse("width=12.5% height=300px align=center float=right")
        let fragment = attrs.fragmentValue!
        XCTAssertEqual(fragment, "crowi-image-attrs:width=12.5pct;height=300px;align=center;float=right")

        let payload = String(fragment.dropFirst(ImageDisplayAttributes.fragmentMarker.count))
        XCTAssertEqual(ImageDisplayAttributes.parseFragmentPayload(payload), attrs)
    }

    func testFragmentValueIsNilWhenNothingValidSurvived() {
        XCTAssertNil(parse("width=101% foo=bar").fragmentValue)
    }

    func testExtractDetachesTheCarriedFragmentAndYieldsTheByteIdenticalPreCarryURL() throws {
        let carried = try XCTUnwrap(URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=60pct;align=center"))

        let extraction = ImageDisplayAttributes.extract(from: carried)

        XCTAssertEqual(extraction.url.absoluteString, "https://wiki.example.com/api/v2/attachments/abc", "the detached URL — what reaches fetch/allowlist/cache — must be byte-identical to the pre-carry one")
        XCTAssertEqual(extraction.attributes?.width?.raw, "60%")
        XCTAssertEqual(extraction.attributes?.align, .center)
    }

    func testExtractLeavesAURLWithoutTheMarkerCompletelyUntouched() throws {
        let plain = try XCTUnwrap(URL(string: "https://wiki.example.com/api/v2/attachments/abc"))
        let ordinaryFragment = try XCTUnwrap(URL(string: "https://example.com/page#section-2"))

        XCTAssertEqual(ImageDisplayAttributes.extract(from: plain).url, plain)
        XCTAssertNil(ImageDisplayAttributes.extract(from: plain).attributes)
        XCTAssertEqual(ImageDisplayAttributes.extract(from: ordinaryFragment).url, ordinaryFragment, "an author's own #fragment is not ours to strip")
        XCTAssertNil(ImageDisplayAttributes.extract(from: ordinaryFragment).attributes)
    }

    /// A page author can hand-write the side-channel fragment — `extract`
    /// re-validates through the SAME DROP rules, so a forged out-of-range
    /// value drops exactly like `{width=99999px}` would (the RFC-0023 §11
    /// client-side re-validation stance).
    func testExtractRevalidatesForgedFragmentValuesWithTheDropRule() throws {
        let forged = try XCTUnwrap(URL(string: "https://wiki.example.com/api/v2/attachments/abc#crowi-image-attrs:width=99999px;align=center"))

        let extraction = ImageDisplayAttributes.extract(from: forged)

        XCTAssertNil(extraction.attributes?.width, "a forged out-of-range width must DROP on re-validation")
        XCTAssertEqual(extraction.attributes?.align, .center)
        XCTAssertEqual(extraction.url.absoluteString, "https://wiki.example.com/api/v2/attachments/abc", "the marker fragment is detached even when its payload was junk")
    }

    // MARK: - Block-path sizing policy (pure rule)

    func testResolvedBlockWidthBoundarySextetAgainstAWideContainer() {
        // 8192 wide so the px cases are distinguishable from the container cap.
        func resolved(_ interior: String) -> CGFloat? {
            ImageDisplayAttributeSizing.resolvedBlockWidth(width: parse(interior).width, containerWidth: 8192)
        }

        XCTAssertEqual(resolved("width=1%"), 81.92)
        XCTAssertEqual(resolved("width=100%"), 8192)
        XCTAssertNil(resolved("width=101%"), "dropped at validation — no explicit width reaches the layout")
        XCTAssertEqual(resolved("width=1px"), 1)
        XCTAssertEqual(resolved("width=4096px"), 4096)
        XCTAssertNil(resolved("width=4097px"), "dropped at validation — no explicit width reaches the layout")
    }

    func testResolvedBlockWidthComposesPixelsWithTheContainerCapBySmallerWins() {
        let width = parse("width=500px").width
        XCTAssertEqual(ImageDisplayAttributeSizing.resolvedBlockWidth(width: width, containerWidth: 320), 320, "a 500px request in a 320pt column takes the smaller of the two — the existing hard cap composition")
        XCTAssertEqual(ImageDisplayAttributeSizing.resolvedBlockWidth(width: width, containerWidth: 1000), 500)
    }

    func testResolvedBlockWidthWithoutAWidthKeepsThePrePhaseBehavior() {
        XCTAssertNil(ImageDisplayAttributeSizing.resolvedBlockWidth(width: nil, containerWidth: 320))
    }

    // MARK: - Alignment mapping (align / float → frame placement)

    func testBlockFrameAlignmentMapsAlignAndGivesFloatPrecedence() {
        XCTAssertEqual(parse("align=left").blockFrameAlignment, .leading)
        XCTAssertEqual(parse("align=center").blockFrameAlignment, .center)
        XCTAssertEqual(parse("align=right").blockFrameAlignment, .trailing)
        XCTAssertEqual(parse("float=left").blockFrameAlignment, .leading)
        XCTAssertEqual(parse("float=right").blockFrameAlignment, .trailing)
        XCTAssertEqual(parse("align=center float=right").blockFrameAlignment, .trailing, "float takes the element out of flow — it wins over align, like CSS")
        XCTAssertNil(parse("width=60%").blockFrameAlignment, "no placement attribute keeps the pre-phase default (.center at the call site)")
    }

    // MARK: - Application render fixtures (the sextet at the actual SwiftUI layer)

    /// Renders a greedy (`Color`) subject through `AttributeSizedLayout` —
    /// the exact layout `ImageDisplayAttributedBlockFrame` sizes the decoded
    /// image with — under a fixed width proposal, and reads the rasterized
    /// output's pixel width: the applied width IS the painted width.
    private func renderedWidth(_ interior: String?, proposedWidth: CGFloat) throws -> CGFloat {
        let width = interior.map { parse($0).width } ?? nil
        let view = AttributeSizedLayout(width: width) { Color.red }
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        renderer.proposedSize = ProposedViewSize(width: proposedWidth, height: 10)
        #if canImport(AppKit)
        let image = try XCTUnwrap(renderer.nsImage)
        return image.size.width
        #else
        throw RenderingUnavailable()
        #endif
    }

    func testAppliedRenderWidthFollowsTheBoundarySextet() throws {
        // Percent boundaries against a 200pt column.
        XCTAssertEqual(try renderedWidth("width=1%", proposedWidth: 200), 2, "1% of the 200pt column")
        XCTAssertEqual(try renderedWidth("width=100%", proposedWidth: 200), 200)
        XCTAssertEqual(try renderedWidth("width=101%", proposedWidth: 200), 200, "dropped — renders exactly like no width (full column), NOT clamped to 100%… which would also be 200 here, hence the px cases below carry the drop-vs-clamp distinction")

        // Pixel boundaries against a 5000pt column (wide enough that
        // 4096px-applied and dropped-full-width are distinguishable).
        XCTAssertEqual(try renderedWidth("width=1px", proposedWidth: 5000), 1)
        XCTAssertEqual(try renderedWidth("width=4096px", proposedWidth: 5000), 4096)
        XCTAssertEqual(try renderedWidth("width=4097px", proposedWidth: 5000), 5000, "dropped — renders at the full column, NOT clamped to 4096")
    }

    func testAppliedRenderWidthWithoutAttributesMatchesThePrePhaseFullWidth() throws {
        XCTAssertEqual(try renderedWidth(nil, proposedWidth: 200), 200)
    }

    /// The full `ImageDisplayAttributedBlockFrame` (sizing + alignment
    /// placement): a fixed-size subject placed leading vs trailing must
    /// paint differently inside the same full-width frame.
    func testAlignmentPlacementChangesTheRenderedOutput() throws {
        func framePNG(_ interior: String) throws -> Data {
            let view = ImageDisplayAttributedBlockFrame(attributes: parse(interior)) {
                Color.red.frame(width: 40, height: 20)
            }
            let renderer = ImageRenderer(content: view.frame(width: 200, height: 20))
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

        let left = try framePNG("align=left")
        let center = try framePNG("align=center")
        let right = try framePNG("align=right")
        let floatedRight = try framePNG("float=right")

        XCTAssertNotEqual(left, right, "leading vs trailing placement must paint differently")
        XCTAssertNotEqual(left, center)
        XCTAssertNotEqual(center, right)
        XCTAssertNotEqual(floatedRight, left, "float=right places against the trailing edge, away from the leading render")
    }
}

private struct RenderingUnavailable: Error {}
