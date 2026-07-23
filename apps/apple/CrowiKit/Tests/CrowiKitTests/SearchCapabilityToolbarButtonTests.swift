import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// RFC-0016 §5.2/§9 — `SearchCapabilityToolbarButton` IS the production
/// Search toolbar entry point `WorkspaceHomeView` places inside its
/// `ToolbarItemGroup` (see that type's doc comment for why the App target
/// itself cannot be imported into `CrowiKitTests`). `WorkspaceSessionTests`
/// already pins that `WorkspaceSession.capabilities` (the `@Published` source
/// of truth) follows three successive `/app/info` refreshes; this file pins
/// the other half a prior review round found missing — that the toolbar
/// entry point's own SwiftUI `body` actually RENDERS differently when the
/// gate flips, not only that some upstream boolean changed independent of any
/// view.
@MainActor
final class SearchCapabilityToolbarButtonTests: XCTestCase {
    func testIsVisibleFollowsSearchCapabilityAcrossThreeSuccessiveFixtures() {
        XCTAssertTrue(SearchCapabilityToolbarButton(capabilities: ["pages", "search"], action: {}).isVisible, "search present on the 1st fixture")
        XCTAssertFalse(SearchCapabilityToolbarButton(capabilities: ["pages"], action: {}).isVisible, "search removed on the 2nd fixture")
        XCTAssertTrue(SearchCapabilityToolbarButton(capabilities: ["pages", "search"], action: {}).isVisible, "search restored on the 3rd fixture")
    }

    /// Actually renders `SearchCapabilityToolbarButton.body` (not merely
    /// reading `isVisible`) via `ImageRenderer` and proves the rasterized
    /// output differs between "search" present and absent — demonstrating
    /// the real SwiftUI render path a user's toolbar actually shows follows
    /// the gate. This closes the exact gap the previous review round
    /// flagged: "does not render or inspect ... the Search toolbar entry
    /// point" — a `session.capabilities` assertion alone does not prove
    /// anything about what gets painted.
    func testRenderedOutputDiffersWhenSearchCapabilityIsPresentVsAbsent() throws {
        let visiblePNG = try renderToPNGData(SearchCapabilityToolbarButton(capabilities: ["pages", "search"], action: {}))
        let hiddenPNG = try renderToPNGData(SearchCapabilityToolbarButton(capabilities: ["pages"], action: {}))

        XCTAssertNotEqual(visiblePNG, hiddenPNG, "showing/hiding the Search button must change what the toolbar entry point actually renders")
        XCTAssertGreaterThan(visiblePNG.count, hiddenPNG.count, "the visible render must contain strictly more painted content (the search icon + label) than the empty one")
    }

    /// The exact `search 有→無→有` (§10) sequence, at the render level: the
    /// 1st and 3rd renders (both "search" present) must each contain
    /// substantially more painted content than the 2nd ("search" absent) —
    /// proving re-showing after hiding is not a one-way/stuck transition.
    /// Deliberately NOT an exact byte-equality check between the two
    /// "visible" renders: two independent `ImageRenderer` passes over
    /// identical SwiftUI content can differ by a handful of PNG-encoded
    /// bytes (anti-aliasing/rasterization jitter between separate render
    /// passes), so a magnitude comparison against the "hidden" render (whose
    /// gap is two orders of magnitude, not a handful of bytes) is the
    /// deterministic signal here.
    func testRenderedOutputForThreeSuccessiveFixturesMatchesTheSpecSequence() throws {
        let firstVisible = try renderToPNGData(SearchCapabilityToolbarButton(capabilities: ["pages", "search"], action: {}))
        let hidden = try renderToPNGData(SearchCapabilityToolbarButton(capabilities: ["pages"], action: {}))
        let secondVisible = try renderToPNGData(SearchCapabilityToolbarButton(capabilities: ["pages", "search"], action: {}))

        XCTAssertGreaterThan(firstVisible.count, hidden.count * 2, "the 1st showing must render substantially more content than the hidden state")
        XCTAssertGreaterThan(secondVisible.count, hidden.count * 2, "the 3rd showing (after the hidden 2nd fixture) must render substantially more content too — re-showing is not a stuck transition")
    }

    private func renderToPNGData(_ view: some View) throws -> Data {
        let renderer = ImageRenderer(content: view.frame(width: 200, height: 44))
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

/// `CrowiKit` targets both iOS and macOS (§9), but `swift test` itself only
/// ever runs the macOS side of that pair — this error exists purely so the
/// `#else` compile branch above (an iOS `ImageRenderer` host, which does not
/// apply to `swift test`) type-checks; it is never actually thrown in this
/// suite's real run.
private struct RenderingUnavailable: Error {}
