import CrowiKit
import SwiftUI

/// RFC-0016 §9 read-surface adaptive shell for ONE active workspace: a
/// `NavigationSplitView` (recency-first home sidebar + reader/search/history/
/// profile detail) on iPad/regular width, collapsing to the design's tab bar
/// over four independent stacks (`WorkspaceTabsView`) on iPhone/compact
/// width. This is a DIFFERENT navigation level from `RootScene`'s own outer
/// workspace-switcher split (§3 — which workspace); `RootScene` still owns
/// ALL size-class branching for THAT level, this view owns it for the read
/// surface within one already-active workspace, per its own doc comment note
/// that a later phase would populate this "currently-empty" slot.
///
/// Also where the §6.3 confidential banner is applied — ONCE, at this
/// workspace's chrome root — and where `AppInfoCache` is refreshed on
/// workspace activation (`.task`) and app foreground (`scenePhase`), per §5.2.
struct WorkspaceHomeView: View {
    let workspace: Workspace
    /// Opens the modal workspace switcher (`RootScene` owns the sheet) —
    /// the home cannot be PUSHED from a switcher stack, so the switcher
    /// comes to it instead (see `RootScene`'s doc comment for why).
    ///
    /// The affordance that calls this is the leading navigation-bar icon
    /// (`CrowiWorkspaceIconButton`) — on the sidebar here, and on every tab
    /// root in the compact shell. It briefly lived on the Home screen's
    /// workspace subtitle, which put it out of reach from every other tab.
    let onShowSwitcher: () -> Void

    @StateObject private var holder: WorkspaceSessionHolder
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedDestination: ReadDestination?

    /// The session is built HERE, from `context`, and never re-pointed —
    /// which is only correct because the caller gives this view a per-
    /// workspace identity (`RootScene`'s `.id(workspace.id)`). A `@StateObject`
    /// evaluates its initial value exactly ONCE per view identity: re-running
    /// this `init` with another workspace's context discards the new holder
    /// and keeps the old one. Without that `.id`, switching workspaces
    /// therefore keeps serving the FIRST workspace's session — which is the
    /// bug this comment exists to stop coming back (found on device,
    /// 2026-08-07).
    init(workspace: Workspace, context: WorkspaceContext, onShowSwitcher: @escaping () -> Void) {
        self.workspace = workspace
        self.onShowSwitcher = onShowSwitcher
        _holder = StateObject(wrappedValue: WorkspaceSessionHolder(context: context))
    }

    var body: some View {
        Group {
            if let session = holder.session {
                content(session: session)
                    .confidentialBanner(session.confidential)
                    .task { await session.activated() }
                    // §11 — the foreground notifications poll loop lives in a
                    // `.task` of THIS view so it is structurally cancelled
                    // the moment the workspace tears down (`RootScene`'s
                    // `.id(workspace.id)` forces exactly that on every
                    // switch): a non-active workspace's poller can never keep
                    // running (§14).
                    .task { await session.runNotificationsPolling() }
                    .onChange(of: scenePhase) { _, newPhase in
                        switch newPhase {
                        case .active:
                            Task { await session.foregrounded() }
                        case .background:
                            // §11 — no notification polling while
                            // backgrounded; `.inactive` (app switcher swipe,
                            // system alert) is transient and left alone.
                            Task { await session.backgrounded() }
                        default:
                            break
                        }
                    }
            } else {
                ContentUnavailableView("Couldn't open this workspace", systemImage: "exclamationmark.triangle")
            }
        }
    }

    // feature-ios-design-language (3): the root content of BOTH size-class
    // shells is the recency-first home (`RecentlyUpdatedHomeView`) — the page
    // tree is one entry point inside it, pushed the same way `PageTreeView`
    // already pushes its own sub-trees.
    //
    // feature-ios-visual-redesign Phase 2: compact width is now the design's
    // tab bar (`WorkspaceTabsView` — four stacks, one per tab). Regular width
    // keeps the split view unchanged: an iPad has room for a persistent
    // sidebar, which IS its "tab bar", and a phone's floating pill on top of
    // it would be two navigation models at once.
    @ViewBuilder
    private func content(session: WorkspaceSession) -> some View {
        if horizontalSizeClass == .compact {
            WorkspaceTabsView(session: session, onShowSwitcher: onShowSwitcher)
        } else {
            NavigationSplitView {
                RecentlyUpdatedHomeView(
                    session: session,
                    onSelect: { selectedDestination = $0 }
                )
                .toolbar { toolbarItems(session: session, onSelect: { selectedDestination = $0 }) }
            } detail: {
                // NOTE: deliberately not `if let selectedDestination` — that
                // shorthand shadows the `@State` property name with a local
                // `let` for the rest of this block, which would make the
                // `onSelect` closure below assign to the (immutable) shadow
                // instead of the real `@State` var.
                if let destination = selectedDestination {
                    ReadDestinationView(destination: destination, session: session, onSelect: { selectedDestination = $0 })
                } else {
                    ContentUnavailableView("Select a page", systemImage: "doc.text")
                }
            }
        }
    }

    /// Regular width only — the sidebar's actions. (The compact shell's
    /// equivalents are the tab bar's slots; its Home toolbar keeps only
    /// "Recently Viewed".) The leading slot is the workspace switcher in BOTH
    /// size classes — here on the sidebar, and on every tab root in
    /// `WorkspaceTabsView` — since the sidebar is this shell's "always
    /// visible" surface exactly as the tab bar is the other's.
    @ToolbarContentBuilder
    private func toolbarItems(session: WorkspaceSession, onSelect: @escaping (ReadDestination) -> Void) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            CrowiWorkspaceIconButton(
                workspaceName: session.context.workspace.displayTitle,
                action: onShowSwitcher
            )
        }
        ToolbarItemGroup(placement: .primaryAction) {
            // §5.2 capability gate: `SearchCapabilityToolbarButton` (CrowiKit)
            // IS the search toolbar entry point, not a re-derived
            // `if session.capabilities.contains("search")` inline — it is
            // hidden the moment the refreshed capability set lacks it, and
            // re-shown live as soon as a later refresh reports it again
            // (`WorkspaceSession.capabilities` is `@Published`, so this
            // toolbar re-renders on every refresh with no extra wiring).
            // `SearchCapabilityToolbarButtonTests` renders/inspects this
            // exact type directly, since this App target cannot be imported
            // into CrowiKit's test target.
            SearchCapabilityToolbarButton(capabilities: session.capabilities) {
                onSelect(.search)
            }
            // §11 — the notifications bell + unread badge.
            // `NotificationBellToolbarButton` (CrowiKit) IS the rendered
            // entry point (the `SearchCapabilityToolbarButton` precedent);
            // the wrapper below observes the session so the badge
            // re-renders on every poll.
            SessionNotificationBell(session: session) {
                onSelect(.notifications)
            }
            // feature-ios-phase2-write — create from the home starts at the
            // root; `PageTreeView` carries its own New Page action seeded
            // with the directory being browsed.
            Button {
                onSelect(.createPage(originPath: "/"))
            } label: {
                Label("New Page", systemImage: "square.and.pencil")
            }
            Button {
                onSelect(.recentlyViewed)
            } label: {
                Label("Recently Viewed", systemImage: "clock")
            }
            Button {
                onSelect(.profile(username: nil))
            } label: {
                Label("Profile", systemImage: "person.crop.circle")
            }
        }
    }
}

/// The bell's live-badge seam: `WorkspaceHomeView` itself holds the session
/// only through its holder (whose publisher fires when the session is
/// REPLACED, not when the session's own `@Published` values change), so this
/// wrapper `@ObservedObject`-observes the session and feeds the fresh
/// `unreadNotificationCount` into the CrowiKit-testable
/// `NotificationBellToolbarButton` on every poll tick.
private struct SessionNotificationBell: View {
    @ObservedObject var session: WorkspaceSession
    let onOpen: () -> Void

    var body: some View {
        NotificationBellToolbarButton(unreadCount: session.unreadNotificationCount, action: onOpen)
    }
}

/// Bridges `WorkspaceSession`'s throwing initializer (`ModelContainer`
/// creation can fail) into a plain `@StateObject`-friendly optional —
/// constructed once per `WorkspaceHomeView.init` from the (non-environment)
/// `WorkspaceContext` parameter, never from a bare `Workspace` value.
@MainActor
private final class WorkspaceSessionHolder: ObservableObject {
    @Published private(set) var session: WorkspaceSession?

    init(context: WorkspaceContext) {
        session = try? WorkspaceSession(context: context, models: WorkspaceReadCacheSchema.models, schemaVersion: WorkspaceReadCacheSchema.schemaVersion)
    }
}
