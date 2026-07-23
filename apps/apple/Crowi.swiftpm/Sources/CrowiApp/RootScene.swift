import CrowiKit
import SwiftUI

/// RFC-0016 §9 — the adaptive root shell: `NavigationSplitView` (sidebar =
/// workspace switcher, detail = the active workspace's home) on iPad /
/// regular-width, collapsing to a `NavigationStack` (switcher first, push to
/// home on selection) on iPhone / compact width. **All** platform/size-class
/// branching lives HERE and nowhere else — the §9 architecture rule applied
/// from day one, even though Phase 1's own home screen is empty.
struct RootScene: View {
    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var compactPath: [String] = []

    var body: some View {
        if horizontalSizeClass == .compact {
            NavigationStack(path: $compactPath) {
                WorkspaceSwitcherView { workspace in
                    workspaceStore.switchTo(workspace.id)
                    compactPath = [workspace.id]
                }
                .navigationDestination(for: String.self) { workspaceId in
                    if let workspace = workspaceStore.workspaces.first(where: { $0.id == workspaceId }),
                        let context = workspaceStore.context(for: workspace)
                    {
                        WorkspaceHomeView(workspace: workspace, context: context)
                    }
                }
            }
        } else {
            NavigationSplitView {
                WorkspaceSwitcherView { workspace in
                    workspaceStore.switchTo(workspace.id)
                }
            } detail: {
                if let workspace = activeWorkspace, let context = workspaceStore.context(for: workspace) {
                    WorkspaceHomeView(workspace: workspace, context: context)
                } else {
                    ContentUnavailableView("No workspace selected", systemImage: "server.rack")
                }
            }
        }
    }

    private var activeWorkspace: Workspace? {
        workspaceStore.workspaces.first(where: { $0.id == workspaceStore.activeWorkspaceId })
    }
}
