import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// RFC-0016 §11 — `NotificationBellToolbarButton` IS the production bell
/// `WorkspaceHomeView` places in its toolbar (via the `@ObservedObject`
/// session wrapper that feeds it `session.unreadNotificationCount`), so
/// pinning THIS type's render output pins the badge the user actually sees —
/// the `SearchCapabilityToolbarButton` precedent, applied to the spec's
/// "badge 表示が unreadCount に追随する" CI-fixed test, including the
/// post-mark-read decrement back to no badge at all.
@MainActor
final class NotificationBellToolbarButtonTests: XCTestCase {
    func testBadgeTextFollowsTheUnreadCountWithTheWebsNinetyNinePlusCap() {
        XCTAssertNil(NotificationBellToolbarButton(unreadCount: 0, action: {}).badgeText, "zero unread renders no badge at all")
        XCTAssertEqual(NotificationBellToolbarButton(unreadCount: 1, action: {}).badgeText, "1")
        XCTAssertEqual(NotificationBellToolbarButton(unreadCount: 99, action: {}).badgeText, "99")
        XCTAssertEqual(NotificationBellToolbarButton(unreadCount: 100, action: {}).badgeText, "99+", "the web bell's badgeLabel cap (notification-bell.tsx)")
    }

    /// Actually renders `body` (not merely reading `badgeText`) and proves
    /// the rasterized output differs between "unread" and "none" — the badge
    /// is painted, not just computed.
    func testRenderedOutputDiffersBetweenUnreadAndZero() throws {
        let withBadge = try renderToPNGData(NotificationBellToolbarButton(unreadCount: 3, action: {}))
        let withoutBadge = try renderToPNGData(NotificationBellToolbarButton(unreadCount: 0, action: {}))

        XCTAssertNotEqual(withBadge, withoutBadge, "an unread count must change what the bell actually renders")
        XCTAssertGreaterThan(withBadge.count, withoutBadge.count, "the badged render must contain strictly more painted content than the plain bell")
    }

    /// The badge-decrement sequence at the render level: 2 unread → 0 (after
    /// mark-all-read / opening) → 2 again. The 1st and 3rd renders must each
    /// carry substantially more painted content than the badge-less 2nd —
    /// the same magnitude comparison `SearchCapabilityToolbarButtonTests`
    /// uses (two independent renders of identical SwiftUI content can differ
    /// by a handful of anti-aliasing bytes, so exact equality between the
    /// two badged renders is deliberately not asserted).
    func testRenderedBadgeDecrementsToNothingAndComesBack() throws {
        let firstBadged = try renderToPNGData(NotificationBellToolbarButton(unreadCount: 2, action: {}))
        let cleared = try renderToPNGData(NotificationBellToolbarButton(unreadCount: 0, action: {}))
        let secondBadged = try renderToPNGData(NotificationBellToolbarButton(unreadCount: 2, action: {}))

        XCTAssertGreaterThan(firstBadged.count, cleared.count, "the badged bell must render more content than the cleared one")
        XCTAssertGreaterThan(secondBadged.count, cleared.count, "re-badging after a clear must not be a stuck transition")
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

/// Same shape as `SearchCapabilityToolbarButtonTests`' — `swift test` only
/// runs the macOS half of CrowiKit's platform pair; the `#else` branch
/// exists purely to type-check.
private struct RenderingUnavailable: Error {}
