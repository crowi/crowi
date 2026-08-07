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
    // MARK: - Create is an action, not a tab

    /// Create has no `CrowiTab` case, so the selection type literally cannot
    /// represent "the New tab" — no tab switch, no restored selection and no
    /// deep link can leave the app sitting on a create screen as if it were a
    /// destination. This survived the bar going back to the system: the
    /// button moved out of the bar, the invariant did not move at all.
    func testCreateIsNotReachableAsATabIdentity() {
        XCTAssertEqual(CrowiTab.allCases.count, 4)
        XCTAssertFalse(CrowiTab.allCases.map(\.id).contains("create"))
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

    // MARK: - Tap targets

    /// The create button is the one piece of bar chrome the app still draws,
    /// so it is the one that still needs its floor asserted — the system's
    /// tab bar brings its own.
    func testTheCreateButtonClearsThe44ptMinimumTapTarget() throws {
        for size in [DynamicTypeSize.xSmall, .large] {
            let rendered = try renderedSize(
                CrowiCreateButton(action: {}).dynamicTypeSize(size),
                width: 390
            )
            let buttonHeight = rendered.height - CrowiMetrics.createButtonBottomInset

            XCTAssertGreaterThanOrEqual(
                buttonHeight,
                CrowiMetrics.minimumTapTarget,
                "the create button fell under the 44pt tap target at \(size)"
            )
        }
    }

    /// The workspace switcher is a control too, and the one most at risk of
    /// being left under the floor: its mark is a 28pt disc in a navigation
    /// bar, which gives a custom item only the room its content asks for.
    func testTheWorkspaceSwitcherClearsThe44ptMinimumTapTarget() throws {
        let size = try renderedSize(
            CrowiWorkspaceIconButton(workspaceName: "Almoha Wiki", action: {})
                .dynamicTypeSize(.xSmall),
            width: 350
        )

        XCTAssertGreaterThanOrEqual(size.height, CrowiMetrics.minimumTapTarget)
    }

    /// The mark itself must carry the workspace's identity: two different
    /// workspaces cannot paint the same icon, or the one control that says
    /// which workspace you are in says nothing.
    func testTheWorkspaceIconPaintsTheWorkspacesOwnInitials() throws {
        let almoha = try renderToPNGData(CrowiWorkspaceIconButton(workspaceName: "Almoha Wiki", action: {}))
        let crowi = try renderToPNGData(CrowiWorkspaceIconButton(workspaceName: "Crowi Dev", action: {}))

        XCTAssertNotEqual(almoha, crowi, "two workspaces must not share one mark")
    }

    /// A workspace whose title is empty (or whitespace-only) has no initial
    /// to draw — it falls back to a glyph rather than painting a blank disc
    /// the user cannot tell from a loading state.
    func testAnUntitledWorkspaceStillPaintsAMark() throws {
        let untitled = try renderToPNGData(CrowiWorkspaceIconButton(workspaceName: "   ", action: {}))
        let empty = try renderToPNGData(Color.clear.frame(width: 44, height: 44))

        XCTAssertNotEqual(untitled, empty, "an untitled workspace must still paint something")
    }

    // MARK: - Helpers

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
