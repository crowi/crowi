import CrowiKit
import SwiftUI

/// RFC-0016 §9 read-surface adaptive shell for ONE active workspace: a
/// `NavigationSplitView` (recency-first home sidebar + reader/search/history/
/// profile detail) on iPad/regular width, collapsing to a `NavigationStack`
/// (home first, push everything else) on iPhone/compact width. This is a
/// DIFFERENT navigation level from `RootScene`'s own outer workspace-switcher
/// split (§3 — which workspace); `RootScene` still owns ALL size-class
/// branching for THAT level, this view owns it for the read surface within
/// one already-active workspace, per its own doc comment note that a later
/// phase would populate this "currently-empty" slot.
///
/// Also where the §6.3 confidential banner is applied — ONCE, at this
/// workspace's chrome root — and where `AppInfoCache` is refreshed on
/// workspace activation (`.task`) and app foreground (`scenePhase`), per §5.2.
struct WorkspaceHomeView: View {
    let workspace: Workspace
    /// Opens the modal workspace switcher (`RootScene` owns the sheet) —
    /// the home cannot be PUSHED from a switcher stack, so the switcher
    /// comes to it instead (see `RootScene`'s doc comment for why).
    let onShowSwitcher: () -> Void

    @StateObject private var holder: WorkspaceSessionHolder
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var compactPath = NavigationPath()
    @State private var selectedDestination: ReadDestination?

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
                    .onChange(of: scenePhase) { _, newPhase in
                        guard newPhase == .active else { return }
                        Task { await session.foregrounded() }
                    }
            } else {
                ContentUnavailableView("Couldn't open this workspace", systemImage: "exclamationmark.triangle")
            }
        }
        // Forces a full state teardown/rebuild on workspace switch (§3 —
        // switching re-points every dependency at the newly active
        // workspace, never reuses stale SwiftUI state from the previous one).
        .id(workspace.id)
    }

    // feature-ios-design-language (3): the root content of BOTH size-class
    // shells is the recency-first home (`RecentlyUpdatedHomeView`) — the page
    // tree is one entry point inside it, pushed the same way `PageTreeView`
    // already pushes its own sub-trees. The stack/split shell, toolbar, and
    // switcher-sheet wiring are unchanged.
    @ViewBuilder
    private func content(session: WorkspaceSession) -> some View {
        if horizontalSizeClass == .compact {
            NavigationStack(path: $compactPath) {
                RecentlyUpdatedHomeView(session: session, onSelect: { compactPath.append($0) })
                    .toolbar { toolbarItems(session: session, onSelect: { compactPath.append($0) }) }
                    .navigationDestination(for: ReadDestination.self) { destination in
                        destinationView(destination, session: session, onSelect: { compactPath.append($0) })
                    }
            }
        } else {
            NavigationSplitView {
                RecentlyUpdatedHomeView(session: session, onSelect: { selectedDestination = $0 })
                    .toolbar { toolbarItems(session: session, onSelect: { selectedDestination = $0 }) }
            } detail: {
                // NOTE: deliberately not `if let selectedDestination` — that
                // shorthand shadows the `@State` property name with a local
                // `let` for the rest of this block, which would make the
                // `onSelect` closure below assign to the (immutable) shadow
                // instead of the real `@State` var.
                if let destination = selectedDestination {
                    destinationView(destination, session: session, onSelect: { selectedDestination = $0 })
                } else {
                    ContentUnavailableView("Select a page", systemImage: "doc.text")
                }
            }
        }
    }

    @ViewBuilder
    private func destinationView(
        _ destination: ReadDestination,
        session: WorkspaceSession,
        onSelect: @escaping (ReadDestination) -> Void
    ) -> some View {
        switch destination {
        case .page(let path):
            PageReaderView(session: session, path: path, onSelectDestination: onSelect)
        case .search:
            SearchView(session: session, onSelectDestination: onSelect)
        case .revisionHistory(let pageId, let pagePath):
            RevisionHistoryView(session: session, pageId: pageId, pagePath: pagePath)
        case .profile(let username):
            ProfileView(session: session, username: username)
        case .recentlyViewed:
            RecentlyViewedView(session: session, onSelectDestination: onSelect)
        }
    }

    @ToolbarContentBuilder
    private func toolbarItems(session: WorkspaceSession, onSelect: @escaping (ReadDestination) -> Void) -> some ToolbarContent {
        // Leading, before the read actions: the way OUT of this workspace.
        // `.navigation` places it top-leading on iOS and in the leading
        // toolbar area on macOS; the tree root has no back button to
        // collide with (this toolbar is attached to the stack/sidebar root).
        ToolbarItem(placement: .navigation) {
            Button {
                onShowSwitcher()
            } label: {
                Label("Workspaces", systemImage: "square.grid.2x2")
            }
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
