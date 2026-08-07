import Foundation

/// The four TABS of the bottom bar. "New" is deliberately absent: it is an
/// ACTION that opens a sheet, not a destination, so no selection state can
/// ever land on it. It is drawn as a floating button beside the bar
/// (`CrowiCreateButton`) — which is also why the bar itself can be the
/// system's.
public enum CrowiTab: String, CaseIterable, Identifiable, Hashable, Sendable {
    case home
    case search
    case notifications
    case profile

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .home: return "Home"
        case .search: return "Search"
        case .notifications: return "Notifications"
        case .profile: return "Profile"
        }
    }

    /// The design's stroked SVG per tab, as its nearest SF Symbol — the
    /// `CrowiRowChevron` reasoning (a symbol inherits the platform's optical
    /// alignment and RTL mirroring; a transcribed `Path` does not).
    public var systemImage: String {
        switch self {
        case .home: return "house"
        case .search: return "magnifyingglass"
        case .notifications: return "bell"
        case .profile: return "person.crop.circle"
        }
    }
}

/// The tab bar's selection + per-tab navigation state, as a value.
///
/// Generic over the destination so it can live in CrowiKit (where the tests
/// run) while the App target's own `ReadDestination` stays where it is —
/// the `SearchCapabilityToolbarButton` split, applied to state instead of to
/// a view.
///
/// Each tab owns its OWN path, which is what "switching tabs remembers where
/// you were" means on iOS; nothing here merges them, and a push is always
/// addressed to a named tab rather than to "the current one", so a push that
/// resolves while a different tab is on screen cannot land in the wrong
/// stack.
public struct CrowiTabNavigation<Destination: Hashable> {
    public var selection: CrowiTab
    private var paths: [CrowiTab: [Destination]] = [:]

    public init(selection: CrowiTab = .home) {
        self.selection = selection
    }

    /// One tab's navigation path. Absent = at its root.
    public subscript(tab: CrowiTab) -> [Destination] {
        get { paths[tab] ?? [] }
        set { paths[tab] = newValue }
    }

    /// The design's own tab-bar state is `isTabbar: view !== 'page'` — the
    /// bar is replaced by the page's bottom controls while a page is open.
    /// Generalized to "the active tab has pushed something", which covers
    /// the design's page case and every other pushed screen (a revision
    /// history, a profile, the tree) the same way iOS itself does.
    ///
    /// It reads the ACTIVE tab only: another tab sitting deep in its own
    /// stack must not hide the bar on the one being looked at.
    public var isTabBarVisible: Bool {
        self[selection].isEmpty
    }
}
