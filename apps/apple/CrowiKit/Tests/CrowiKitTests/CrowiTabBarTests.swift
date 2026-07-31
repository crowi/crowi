import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// feature-ios-visual-redesign Phase 2 — the tab-bar information
/// architecture, pinned the way the rest of this suite pins UI: pure rules
/// asserted directly, layout MEASURED off the real SwiftUI render
/// (`CrowiDesignSystemTests`' `ImageRenderer` seam). There is no view-tree or
/// snapshot infrastructure here and this does not add one; nothing below
/// asserts that a colour equals itself.
@MainActor
final class CrowiTabBarTests: XCTestCase {
    // MARK: - Slots: create is an action, not a tab

    /// The design's five slots, in its order. The center one is
    /// `.create` — an ACTION — which is why it has no `CrowiTab` case: the
    /// selection type literally cannot represent "the New tab", so no tab
    /// switch, no restored selection and no deep link can ever leave the app
    /// sitting on a create screen as if it were a destination.
    func testTheBarHasFiveSlotsWithCreateAsTheNonTabCenterOne() {
        XCTAssertEqual(
            CrowiTabBarSlot.allSlots,
            [.tab(.home), .tab(.search), .create, .tab(.notifications), .tab(.profile)]
        )
        XCTAssertEqual(CrowiTabBarSlot.allSlots.count, 5)
        XCTAssertEqual(CrowiTabBarSlot.allSlots[2], .create, "the create action is the CENTER slot (the design's FAB)")

        let tabSlots = CrowiTabBarSlot.allSlots.filter { if case .tab = $0 { return true } else { return false } }
        XCTAssertEqual(tabSlots.count, 4, "exactly one of the five slots is not a tab")
        XCTAssertEqual(
            tabSlots.map(\.id).sorted(),
            CrowiTab.allCases.map(\.id).sorted(),
            "every tab appears in the bar exactly once, and the bar shows no tab that does not exist"
        )
        XCTAssertFalse(
            CrowiTab.allCases.map(\.id).contains(CrowiTabBarSlot.create.id),
            "create must not be reachable as a tab identity"
        )
    }

    // MARK: - Visibility: the design's `isTabbar: view !== 'page'`

    /// The bar is showing at a tab's root and gone the moment that tab has
    /// pushed anything — the design hides it while a page is open and lets
    /// the page's own bottom controls take over.
    func testTheBarIsHiddenExactlyWhenTheActiveTabHasPushedSomething() {
        var navigation = CrowiTabNavigation<String>()
        XCTAssertTrue(navigation.isTabBarVisible, "a tab at its root shows the bar")

        navigation[.home] = ["/page"]
        XCTAssertFalse(navigation.isTabBarVisible, "one pushed screen is enough to hide the bar")

        navigation[.home] = ["/page", "/page/history"]
        XCTAssertFalse(navigation.isTabBarVisible, "deeper stays hidden")

        navigation[.home] = []
        XCTAssertTrue(navigation.isTabBarVisible, "popping back to the root brings it back")
    }

    /// Visibility follows the ACTIVE tab only. A tab left deep in its own
    /// stack must not suppress the bar on the tab being looked at — which is
    /// the bug a single shared "navigation depth" would produce.
    func testTheBarFollowsTheActiveTabNotTheDeepestOne() {
        var navigation = CrowiTabNavigation<String>()
        navigation[.home] = ["/page"]
        XCTAssertFalse(navigation.isTabBarVisible)

        navigation.selection = .search
        XCTAssertTrue(navigation.isTabBarVisible, "Search is at its root, so the bar is back even though Home is deep")

        navigation.selection = .home
        XCTAssertFalse(navigation.isTabBarVisible, "returning to Home returns to Home's own state")
    }

    // MARK: - Per-tab navigation independence

    /// Each tab keeps its own stack: switching away and back restores where
    /// you were, and pushing in one tab never touches another's.
    func testEachTabKeepsItsOwnPathAcrossSwitches() {
        var navigation = CrowiTabNavigation<String>()

        navigation[.home] = ["/home-page"]
        navigation.selection = .notifications
        navigation[.notifications] = ["/from-a-notification"]

        XCTAssertEqual(navigation[.home], ["/home-page"], "Home kept its stack while Notifications was on screen")
        XCTAssertEqual(navigation[.notifications], ["/from-a-notification"])
        XCTAssertEqual(navigation[.search], [], "an untouched tab is at its root")
        XCTAssertEqual(navigation[.profile], [])

        navigation.selection = .home
        XCTAssertEqual(navigation[.home], ["/home-page"], "switching back restores Home's stack rather than resetting it")
        XCTAssertEqual(navigation[.notifications], ["/from-a-notification"], "…and does not clear the tab left behind")
    }

    /// Popping one tab to its root leaves every other tab's stack alone —
    /// the same independence in the other direction.
    func testPoppingOneTabLeavesTheOthersAlone() {
        var navigation = CrowiTabNavigation<String>()
        navigation[.home] = ["/a", "/b"]
        navigation[.search] = ["/hit"]

        navigation[.home] = []

        XCTAssertEqual(navigation[.home], [])
        XCTAssertEqual(navigation[.search], ["/hit"])
    }

    /// A fresh shell opens on Home with nothing pushed anywhere — the state a
    /// workspace switch has to be able to rebuild to (`WorkspaceHomeView`'s
    /// `.id(workspace.id)` teardown), so it is asserted rather than assumed.
    func testANewNavigationStateStartsOnHomeWithEveryTabAtItsRoot() {
        let navigation = CrowiTabNavigation<String>()

        XCTAssertEqual(navigation.selection, .home)
        for tab in CrowiTab.allCases {
            XCTAssertEqual(navigation[tab], [], "\(tab.title) must start at its root")
        }
        XCTAssertTrue(navigation.isTabBarVisible)
    }

    // MARK: - Badge

    /// The tab bar's Notifications slot and the regular-width toolbar bell
    /// paint the SAME badge from the SAME rule — including the web's `99+`
    /// cap and "no badge at all" at zero.
    func testTheTabBarBadgeIsTheSameRuleAsTheToolbarBells() {
        for count in [0, 1, 3, 99, 100, 1000] {
            XCTAssertEqual(
                CrowiUnreadBadge.text(for: count),
                NotificationBellToolbarButton(unreadCount: count, action: {}).badgeText,
                "the two entry points disagreed at \(count) unread"
            )
        }
        XCTAssertNil(CrowiUnreadBadge.text(for: 0))
        XCTAssertEqual(CrowiUnreadBadge.text(for: 100), "99+")
    }

    /// …and it is actually PAINTED in the bar, not merely computed: an
    /// unread count must change what the bar renders.
    func testTheBarRendersMoreContentWhenThereAreUnreadNotifications() throws {
        let badged = try renderToPNGData(bar(selection: .home, unreadCount: 4))
        let clear = try renderToPNGData(bar(selection: .home, unreadCount: 0))

        XCTAssertNotEqual(badged, clear, "an unread count must change what the tab bar paints")
        XCTAssertGreaterThan(badged.count, clear.count, "the badged bar must carry strictly more painted content")
    }

    /// The selected slot is drawn differently from the unselected ones (the
    /// design's `chrome(active)`) — measured, so a future refactor that drops
    /// the selection styling turns red.
    func testTheSelectedTabIsPaintedDifferentlyFromAnUnselectedOne() throws {
        let onHome = try renderToPNGData(bar(selection: .home, unreadCount: 0))
        let onProfile = try renderToPNGData(bar(selection: .profile, unreadCount: 0))

        XCTAssertNotEqual(onHome, onProfile, "which tab is selected must be visible in the render")
    }

    // MARK: - Tap targets

    /// Every slot in the bar is a control, so every slot clears 44pt — at the
    /// default text size and at the smallest one, where the design's 7/8px
    /// padding around a 24pt glyph plus a 10.5px label lands well under it
    /// and the explicit floor is the only thing holding the bar open.
    func testEveryTabBarSlotClearsThe44ptMinimumTapTarget() throws {
        for size in [DynamicTypeSize.xSmall, .large] {
            let height = try renderedSize(bar(selection: .home, unreadCount: 0).dynamicTypeSize(size), width: 390).height
            let barHeight = height - CrowiMetrics.tabBarBottomInset

            XCTAssertGreaterThanOrEqual(
                barHeight,
                CrowiMetrics.minimumTapTarget,
                "the bar itself fell under the 44pt tap target at \(size)"
            )
        }
    }

    /// The workspace switcher is a control too, and the one most at risk of
    /// being left as a caption: it is a 15px subtitle line by design.
    func testTheWorkspaceSwitcherClearsThe44ptMinimumTapTarget() throws {
        let height = try renderedSize(
            CrowiWorkspaceSwitcherButton(workspaceName: "Almoha Wiki", action: {})
                .dynamicTypeSize(.xSmall),
            width: 350
        ).height

        XCTAssertGreaterThanOrEqual(height, CrowiMetrics.minimumTapTarget)
    }

    // MARK: - Helpers

    private func bar(selection: CrowiTab, unreadCount: Int) -> some View {
        CrowiTabBar(selection: selection, unreadCount: unreadCount, onSelect: { _ in }, onCreate: {})
    }

    private func renderedSize(_ view: some View, width: CGFloat) throws -> CGSize {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw TabBarRenderingUnavailable() }
        return nsImage.size
        #else
        throw TabBarRenderingUnavailable()
        #endif
    }

    private func renderToPNGData(_ view: some View) throws -> Data {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: 390))
        renderer.scale = 1
        guard
            let nsImage = renderer.nsImage,
            let tiff = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else {
            throw TabBarRenderingUnavailable()
        }
        return png
        #else
        throw TabBarRenderingUnavailable()
        #endif
    }
}

/// Only exists so the `#else` branches above (an iOS `ImageRenderer` host,
/// which `swift test` never takes — it runs the macOS side of CrowiKit)
/// type-check.
private struct TabBarRenderingUnavailable: Error {}
