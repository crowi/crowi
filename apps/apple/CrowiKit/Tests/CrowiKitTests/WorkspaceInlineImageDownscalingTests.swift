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
}
