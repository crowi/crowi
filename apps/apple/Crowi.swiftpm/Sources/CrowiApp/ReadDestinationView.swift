import CrowiKit
import SwiftUI

/// The single `ReadDestination` → screen mapping, shared by the compact tab
/// shell (`WorkspaceTabsView`, one `NavigationStack` per tab) and the
/// regular-width `NavigationSplitView` detail column
/// (`WorkspaceHomeView`).
///
/// Extracted from `WorkspaceHomeView` when the compact shell moved out of it:
/// two shells resolving the same enum through two hand-kept-in-sync switches
/// is how an iPad-only (or iPhone-only) dead destination appears.
///
/// Nothing here introduces a navigation container. Every screen below is
/// either pushed into the calling tab's ONE `NavigationStack` or shown in the
/// split view's detail column — a `NavigationStack` nested inside a pushed
/// destination is the bug `RootScene`'s doc comment records.
struct ReadDestinationView: View {
    let destination: ReadDestination
    let session: WorkspaceSession
    let onSelect: (ReadDestination) -> Void

    var body: some View {
        switch destination {
        case .page(let path):
            PageReaderView(session: session, path: path, onSelectDestination: onSelect)
        case .pageById(let pageId):
            SharedPageLinkView(session: session, pageId: pageId, onSelectDestination: onSelect)
        case .search:
            SearchView(session: session, onSelectDestination: onSelect)
        case .revisionHistory(let pageId, let pagePath):
            RevisionHistoryView(session: session, pageId: pageId, pagePath: pagePath)
        case .profile(let username):
            // The gear needs somewhere to go. At regular width this screen IS
            // the detail column, so a destination replaces what is shown here
            // rather than pushing — which is the same seam every other row
            // uses, and without it the settings are unreachable on iPad.
            ProfileView(session: session, username: username, onSelectDestination: onSelect)
        case .recentlyViewed:
            RecentlyViewedView(session: session, onSelectDestination: onSelect)
        case .createPage(let originPath):
            // Regular width only: the compact shell intercepts `.createPage`
            // before it reaches a stack and presents it as a sheet instead
            // (see `WorkspaceTabsView.open(_:in:)`).
            PageCreateView(session: session, originPath: originPath, onSelectDestination: onSelect)
        case .notifications:
            NotificationsView(session: session, onSelectDestination: onSelect)
        case .pageTree(let path, let hasPortal):
            PageTreeView(session: session, path: path, hasPortal: hasPortal, onSelect: onSelect)
        case .settings:
            AppSettingsView()
        }
    }
}
