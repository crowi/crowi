import CrowiKit
import SwiftUI

/// RFC-0016 §9 (revised during Phase 2 interactive verification) — the root
/// scene shows the ACTIVE workspace's home directly and presents the
/// Slack-style workspace switcher as a modal sheet, instead of pushing the
/// home into a root-level `NavigationStack` / hosting it in a root-level
/// `NavigationSplitView` detail.
///
/// WHY the original push design was replaced: `WorkspaceHomeView` owns its
/// own `NavigationStack` (compact) / `NavigationSplitView` (regular) for the
/// read surface (§9), and SwiftUI does not support nesting either inside a
/// pushed destination of another `NavigationStack` — the push renders once,
/// is popped immediately, and the pop is NOT written back to the path
/// binding, leaving the path desynced so every subsequent tap is a no-op
/// (reproduced live in the iOS Simulator during Phase 2 verification; see
/// the addendum in feature-ios-phase1-workspace-auth.md). Making the
/// switcher modal removes the outer navigation container entirely, so the
/// home's own stack/split-view is always top-level and legal on both size
/// classes.
struct RootScene: View {
    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @State private var isPresentingSwitcher = false

    var body: some View {
        Group {
            if let workspace = activeWorkspace, let context = workspaceStore.context(for: workspace) {
                WorkspaceHomeView(workspace: workspace, context: context) {
                    isPresentingSwitcher = true
                }
                // Gives the home a per-workspace IDENTITY, which is what
                // makes a switch actually switch. `WorkspaceHomeView` builds
                // its session in a `@StateObject`, and SwiftUI evaluates a
                // `@StateObject`'s initial value once per identity — with
                // this `if` branch as the only identity, a re-render with the
                // next workspace's context kept the FIRST workspace's session
                // and the app went on showing workspace #1 forever (found on
                // device, 2026-08-07).
                //
                // It has to live HERE, at the call site. The same modifier
                // applied inside the home's own `body` — where it used to be
                // — resets the CONTENT's state but cannot re-create the view
                // that owns the `@StateObject`, so it looked right and fixed
                // nothing.
                .id(workspace.id)
            } else {
                // First launch / every workspace signed out: the switcher
                // (with its add-workspace flow) IS the root until a
                // workspace exists to show a home for.
                NavigationStack {
                    WorkspaceSwitcherView { workspace in
                        workspaceStore.switchTo(workspace.id)
                    }
                }
            }
        }
        .sheet(isPresented: $isPresentingSwitcher) {
            NavigationStack {
                WorkspaceSwitcherView { workspace in
                    workspaceStore.switchTo(workspace.id)
                    isPresentingSwitcher = false
                }
            }
        }
        .onChange(of: workspaceStore.workspaces.isEmpty) { _, isEmpty in
            // Signing the last workspace out from inside the sheet: the
            // root below it is now the switcher itself, so the modal copy
            // is redundant — dismiss it.
            if isEmpty { isPresentingSwitcher = false }
        }
    }

    private var activeWorkspace: Workspace? {
        workspaceStore.workspaces.first(where: { $0.id == workspaceStore.activeWorkspaceId })
    }
}
