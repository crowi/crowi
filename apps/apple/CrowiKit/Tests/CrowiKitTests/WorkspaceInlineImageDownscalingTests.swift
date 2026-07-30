import XCTest

@testable import CrowiKit

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// `WorkspaceMarkdownInlineImageProvider`'s bitmap-level backstop: an image
/// embedded via `Text(image:)` renders at native bitmap size with no
/// SwiftUI frame/aspectRatio able to constrain it afterwards, so the only
/// remaining lever is the decoded bitmap's own pixel size. These tests
/// exercise `WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(_:)`
/// directly, without a SwiftUI host.
final class WorkspaceInlineImageDownscalingTests: XCTestCase {
    private func makeImage(size: CGSize) -> PlatformImage {
        #if canImport(UIKit)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            UIColor.red.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        #elseif canImport(AppKit)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.red.setFill()
        CGRect(origin: .zero, size: size).fill()
        image.unlockFocus()
        return image
        #endif
    }

    func testAnOversizedLandscapeImageIsDownscaledToTheMaxLongEdge() {
        let original = makeImage(size: CGSize(width: 4000, height: 2000))

        let result = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(original, maxDimension: 1024)

        XCTAssertEqual(result.size.width, 1024, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 512, accuracy: 0.5)
    }

    func testAnOversizedPortraitImageIsDownscaledPreservingAspectRatio() {
        let original = makeImage(size: CGSize(width: 1000, height: 4000))

        let result = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(original, maxDimension: 1024)

        XCTAssertEqual(result.size.height, 1024, accuracy: 0.5)
        XCTAssertEqual(result.size.width, 256, accuracy: 0.5)
    }

    /// A small image (e.g. an inline emoji-sized icon) must never be
    /// upscaled or otherwise altered.
    func testAnImageAlreadyWithinTheBoundIsReturnedUnchanged() {
        let original = makeImage(size: CGSize(width: 200, height: 100))

        let result = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(original, maxDimension: 1024)

        XCTAssertEqual(result.size.width, 200, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 100, accuracy: 0.5)
    }

    /// An image exactly at the bound is left as-is (boundary case: `>`, not
    /// `>=`, triggers the resize).
    func testAnImageExactlyAtTheMaxDimensionIsUnchanged() {
        let original = makeImage(size: CGSize(width: 1024, height: 1024))

        let result = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(original, maxDimension: 1024)

        XCTAssertEqual(result.size.width, 1024, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 1024, accuracy: 0.5)
    }

    func testTheDefaultMaxDimensionIsUsedWhenNoneIsSpecified() {
        let original = makeImage(size: CGSize(width: 5000, height: 5000))

        let result = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(original)

        XCTAssertEqual(result.size.width, WorkspaceInlineImageDownscaling.defaultMaxDimension, accuracy: 0.5)
        XCTAssertEqual(result.size.height, WorkspaceInlineImageDownscaling.defaultMaxDimension, accuracy: 0.5)
    }

    // MARK: - RFC-0015 inline width application (feature-ios-phase3)

    private func width(_ value: String) -> ImageDisplayAttributes.Size? {
        ImageDisplayAttributes.Size.validated(value)
    }

    func testAPixelWidthResizesTheBitmapPreservingAspectRatio() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("100px"), to: original)

        XCTAssertEqual(result.size.width, 100, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 50, accuracy: 0.5)
    }

    /// CSS `width` scales both ways — a validated px width larger than the
    /// bitmap upscales it (unlike the safety downscaler, which never does).
    func testAPixelWidthUpscalesASmallBitmapLikeCSSWould() {
        let original = makeImage(size: CGSize(width: 50, height: 25))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("200px"), to: original)

        XCTAssertEqual(result.size.width, 200, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 100, accuracy: 0.5)
    }

    /// "Smaller wins" composition with the inline safety cap: a huge (but
    /// validated — 4096 is inside the closed interval) px width is capped at
    /// `defaultMaxDimension`, never honored past it.
    func testAPixelWidthComposesWithTheInlineCapBySmallerWins() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("4096px"), to: original)

        XCTAssertEqual(result.size.width, WorkspaceInlineImageDownscaling.defaultMaxDimension, accuracy: 0.5)
    }

    /// review round 1 — a `%` width resolves against the MEASURED container
    /// width (`InlineImageContainerWidthReference`, fed by
    /// `WorkspacePageMarkdownView`), the same reference box the web's CSS
    /// `width: <n>%` and the block path's `AttributeSizedLayout` use.
    func testAPercentWidthResolvesAgainstTheContainerWidth() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("50%"), to: original, containerWidth: 300)

        XCTAssertEqual(result.size.width, 150, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 75, accuracy: 0.5)
    }

    /// `100%` (the closed interval's upper bound) fills the container
    /// exactly — and, like px, `%` scales both ways (a 100pt bitmap grows to
    /// a 300pt column).
    func testAHundredPercentWidthFillsTheContainerUpscalingIfNeeded() {
        let original = makeImage(size: CGSize(width: 100, height: 50))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("100%"), to: original, containerWidth: 300)

        XCTAssertEqual(result.size.width, 300, accuracy: 0.5)
        XCTAssertEqual(result.size.height, 150, accuracy: 0.5)
    }

    /// Degrade, never guess: without a usable container measurement (`nil`,
    /// or a not-yet-laid-out zero) the bitmap passes through untouched.
    func testAPercentWidthWithoutAMeasuredContainerLeavesTheBitmapUntouched() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        XCTAssertEqual(
            WorkspaceInlineImageDownscaling.applyingInlineWidth(width("50%"), to: original).size.width, 400, accuracy: 0.5)
        XCTAssertEqual(
            WorkspaceInlineImageDownscaling.applyingInlineWidth(width("50%"), to: original, containerWidth: 0).size.width,
            400, accuracy: 0.5)
    }

    /// "Smaller wins" holds for `%` too: 100% of a container wider than the
    /// inline safety cap still stops at `defaultMaxDimension`.
    func testAPercentWidthComposesWithTheInlineCapBySmallerWins() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(width("100%"), to: original, containerWidth: 2000)

        XCTAssertEqual(result.size.width, WorkspaceInlineImageDownscaling.defaultMaxDimension, accuracy: 0.5)
    }

    func testNoWidthAttributeLeavesTheInlineBitmapUntouched() {
        let original = makeImage(size: CGSize(width: 400, height: 200))

        let result = WorkspaceInlineImageDownscaling.applyingInlineWidth(nil, to: original)

        XCTAssertEqual(result.size.width, 400, accuracy: 0.5)
    }
}
