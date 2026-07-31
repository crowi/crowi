import CrowiKit
import SwiftUI

/// feature-ios-visual-redesign Phase 2 — the COMPACT (iPhone) shell: the
/// design's five-slot bottom bar over four independent navigation stacks.
///
/// ## Container structure (and why this one)
///
/// ```
/// WorkspaceTabsView
///  └ TabView(selection:)                     ← owns which tab is on screen
///     ├ NavigationStack(path: home)          ← exactly ONE container per tab
///     ├ NavigationStack(path: search)
///     ├ NavigationStack(path: notifications)
///     └ NavigationStack(path: profile)
/// ```
///
/// A real `TabView` rather than a hand-rolled `switch` over the selection:
/// only `TabView` keeps a non-visible tab's view state alive (a half-typed
/// search, a scrolled notifications list) while ALSO not building a tab until
/// it is first opened — a `ZStack` of all four would keep them alive by
/// running all four `.task`s at launch, and a bare `switch` would throw the
/// state away on every switch. Its own bar is hidden with
/// `.toolbar(.hidden, for: .tabBar)` applied to each tab's stack (the
/// modifier hides the bar of the tab view the modified content belongs to),
/// because the design's center slot is a create FAB, which no `TabView` bar
/// can express.
///
/// Nothing nests: the tab bar is a `safeAreaInset` OUTSIDE the stacks, and
/// each stack is top-level inside its tab — the failure `RootScene`'s doc
/// comment records (a `NavigationStack` inside a pushed destination pushes
/// once, pops itself, and desyncs the path binding) cannot occur here.
///
/// ## Why this view exists instead of more `@State` on `WorkspaceHomeView`
///
/// `WorkspaceHomeView` applies `.id(workspace.id)` to its content so a
/// workspace switch tears the whole read surface down. Tab selection and the
/// four paths therefore have to live BELOW that `.id` — held one level up
/// they would survive the switch and leave a tab pointing at the previous
/// workspace's pages.
struct WorkspaceTabsView: View {
    let session: WorkspaceSession
    let onShowSwitcher: () -> Void

    @State private var navigation = CrowiTabNavigation<ReadDestination>()
    @State private var createRequest: CreatePageRequest?
    /// Where to go once the create sheet has actually closed. Pushing onto a
    /// stack in the same turn as dismissing a sheet races the dismissal, so
    /// the destination waits for `onDismiss` instead.
    @State private var destinationAfterCreate: ReadDestination?

    var body: some View {
        TabView(selection: $navigation.selection) {
            ForEach(CrowiTab.allCases) { tab in
                stack(for: tab)
                    // Hidden, but still declared: the tab item is how a
                    // `TabView` page is identified, and leaving it off would
                    // make the tab unlabelled for anything that reads the
                    // structure (Simulator's accessibility inspector,
                    // future `Tab`-API migration) rather than saving work.
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // The design's `isTabbar: view !== 'page'`, as a safe-area inset
            // rather than an overlay: the inset both draws the bar and tells
            // every scroll view inside the tab how much room it takes, so the
            // last row of a list can be reached instead of sitting under the
            // glass. When the active tab has pushed something the inset
            // collapses to nothing and the pushed screen gets the full
            // height — the page's own bottom controls take over, exactly as
            // in the design.
            if navigation.isTabBarVisible {
                SessionTabBar(
                    session: session,
                    selection: navigation.selection,
                    onSelect: { navigation.selection = $0 },
                    onCreate: { createRequest = CreatePageRequest(originPath: "/") }
                )
            }
        }
        // The design renders create as a bottom sheet, not as a pushed
        // screen: it is an ACTION on the workspace, so it must not become
        // part of any tab's history (a created page would otherwise leave the
        // form sitting behind it in the stack).
        .sheet(item: $createRequest, onDismiss: openDestinationAfterCreate) { request in
            NavigationStack {
                PageCreateView(session: session, originPath: request.originPath) { destination in
                    destinationAfterCreate = destination
                    createRequest = nil
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        // A sheet has no back button; the form itself stays
                        // presentation-agnostic (it is still pushed into the
                        // detail column at regular width), so the dismissal
                        // belongs to the presenter.
                        Button("Cancel") { createRequest = nil }
                    }
                }
            }
        }
    }

    private func stack(for tab: CrowiTab) -> some View {
        NavigationStack(path: path(for: tab)) {
            root(for: tab)
                .navigationDestination(for: ReadDestination.self) { destination in
                    ReadDestinationView(destination: destination, session: session, onSelect: { open($0, in: tab) })
                }
        }
        .toolbar(.hidden, for: .tabBar)
    }

    @ViewBuilder
    private func root(for tab: CrowiTab) -> some View {
        switch tab {
        case .home:
            RecentlyUpdatedHomeView(
                session: session,
                onSelect: { open($0, in: .home) },
                onShowSwitcher: onShowSwitcher
            )
            .toolbar {
                // Everything else this toolbar used to carry is now a tab
                // (search / notifications / profile), the FAB (new page) or
                // the home's own subtitle (the workspace switcher).
                // "Recently viewed" has no slot in the design's bar and no
                // home section of its own, so it stays here.
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        open(.recentlyViewed, in: .home)
                    } label: {
                        Label("Recently Viewed", systemImage: "clock")
                    }
                }
            }
        case .search:
            SearchView(session: session, onSelectDestination: { open($0, in: .search) })
        case .notifications:
            NotificationsView(session: session, onSelectDestination: { open($0, in: .notifications) })
        case .profile:
            ProfileView(session: session, username: nil)
        }
    }

    /// Navigate WITHIN a named tab. Addressed to the tab that asked rather
    /// than to `navigation.selection`, so a result arriving after the user
    /// has already moved on lands in the stack it belongs to.
    private func open(_ destination: ReadDestination, in tab: CrowiTab) {
        if case .createPage(let originPath) = destination {
            // Create is modal everywhere in this shell — including
            // `PageTreeView`'s own "New Page" (seeded with the directory
            // being browsed), which keeps sending it as a destination. One
            // create surface, one presentation.
            createRequest = CreatePageRequest(originPath: originPath)
        } else {
            navigation[tab].append(destination)
        }
    }

    /// The new page opens in whatever tab the user created it from (normally
    /// Home) rather than forcing a jump to Home: the sheet was modal over
    /// that tab, so closing it leaves them where they already were, one
    /// screen deeper.
    private func openDestinationAfterCreate() {
        guard let destination = destinationAfterCreate else { return }
        destinationAfterCreate = nil
        navigation[navigation.selection].append(destination)
    }

    private func path(for tab: CrowiTab) -> Binding<[ReadDestination]> {
        Binding(
            get: { navigation[tab] },
            set: { navigation[tab] = $0 }
        )
    }
}

/// The create sheet's presentation state. Identity is per PRESENTATION, not
/// per origin path: tapping "New" twice from the same directory has to
/// re-present rather than be swallowed as "already showing that item".
private struct CreatePageRequest: Identifiable {
    let id = UUID()
    let originPath: String
}

/// The tab bar's live-data seam — the `SessionNotificationBell` precedent
/// (`WorkspaceHomeView`): `WorkspaceTabsView` holds the session as a plain
/// value so a notifications poll does not re-evaluate all four tabs, and
/// only this wrapper observes it, feeding the fresh unread count into the
/// Notifications slot's badge.
private struct SessionTabBar: View {
    @ObservedObject var session: WorkspaceSession
    let selection: CrowiTab
    let onSelect: (CrowiTab) -> Void
    let onCreate: () -> Void

    var body: some View {
        CrowiTabBar(
            selection: selection,
            unreadCount: session.unreadNotificationCount,
            onSelect: onSelect,
            onCreate: onCreate
        )
    }
}
