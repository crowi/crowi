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
/// state away on every switch.
///
/// The bar is the system's own. The design's five-slot bar puts create in the
/// centre, which a `TabView` bar cannot express — tabs are destinations with
/// selection state, create is an action — so create is a floating button
/// beside the bar (`CrowiCreateButton`) and everything else the bar does is
/// the OS's.
///
/// Nothing nests: each stack is top-level inside its tab — the failure
/// `RootScene`'s doc comment records (a `NavigationStack` inside a pushed
/// destination pushes once, pops itself, and desyncs the path binding) cannot
/// occur here.
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
                tabContent(for: tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        .modifier(ScrollMinimizedTabBar())
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

    /// One tab's page. Only Notifications observes the session — its badge is
    /// the one thing in this shell that changes on a poll, and observing here
    /// instead of at the `TabView` keeps a poll tick from re-evaluating all
    /// four tabs (the `SessionNotificationBell` precedent).
    @ViewBuilder
    private func tabContent(for tab: CrowiTab) -> some View {
        if tab == .notifications {
            SessionBadgedTab(session: session) { stack(for: tab) }
        } else {
            stack(for: tab)
        }
    }

    private func stack(for tab: CrowiTab) -> some View {
        NavigationStack(path: path(for: tab)) {
            root(for: tab)
                // The design's floating create button, kept after the bar
                // itself went back to the system. A `safeAreaInset` rather
                // than an overlay: it RESERVES its own height inside this
                // screen, so the last row of a list can still be scrolled to
                // instead of sitting under the button. Applied to the tab's
                // ROOT, which is also what makes it disappear on a pushed
                // screen — the reader's own pill owns the bottom there.
                .safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) {
                    CrowiCreateButton {
                        createRequest = CreatePageRequest(originPath: "/")
                    }
                }
                // Applied to every tab's ROOT (not to the stack), so the
                // switcher is one tap away wherever the user is — and
                // disappears on a pushed screen, where the leading slot is
                // the back button's. Hanging it off Home alone, as the
                // subtitle control did, meant a workspace could not be
                // changed while reading notifications.
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        CrowiWorkspaceIconButton(
                            workspaceName: session.context.workspace.displayTitle,
                            action: onShowSwitcher
                        )
                    }
                }
                .navigationDestination(for: ReadDestination.self) { destination in
                    ReadDestinationView(destination: destination, session: session, onSelect: { open($0, in: tab) })
                }
        }
        // The design replaces the bar with the page's own bottom controls
        // (`isTabbar: view !== 'page'`), so it is hidden for as long as this
        // tab is anywhere but its root.
        //
        // Driven by the PATH rather than declared inside the destination: a
        // destination's toolbar preference only reaches the tab view once the
        // destination itself has settled, which on a pop is after the
        // transition — the bar then arrived late enough to shove the create
        // button up under a list that had already finished drawing. The path
        // changes when the pop starts, so the bar travels with it.
        .toolbar(navigation[tab].isEmpty ? .visible : .hidden, for: .tabBar)
    }

    @ViewBuilder
    private func root(for tab: CrowiTab) -> some View {
        switch tab {
        case .home:
            RecentlyUpdatedHomeView(
                session: session,
                onSelect: { open($0, in: .home) }
            )
            .toolbar {
                // Everything else this toolbar used to carry is now a tab
                // (search / notifications / profile), the FAB (new page) or
                // the leading workspace icon (the switcher). "Recently
                // viewed" has no slot in the design's bar and no home
                // section of its own, so it stays here.
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
/// Notifications tab's badge.
///
/// `.badge` is the system tab bar's own affordance — a hand-drawn dot on the
/// glyph, which the app used to carry, cannot be read by VoiceOver as a badge
/// and does not follow the platform's placement.
private struct SessionBadgedTab<Content: View>: View {
    @ObservedObject var session: WorkspaceSession
    @ViewBuilder let content: Content

    var body: some View {
        content.badge(session.unreadNotificationCount)
    }
}

/// The bar collapses into a pill while a list is scrolled down and comes back
/// on the way up — the system's own behavior, so the create button and the
/// scroll indicators move with it instead of around it.
///
/// Nothing to fall back to below iOS 26: the bar simply stays full height,
/// which is what every earlier release draws.
private struct ScrollMinimizedTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}
