import CrowiKit
import SwiftUI

/// RFC-0016 §3/§9 — the Slack-style workspace switcher: ordered list, tap to
/// switch (instant, LOCAL — §3, no network round-trip), swipe to sign out
/// (server-side revoke + local purge, §3/§4.2/§14), toolbar button to add a
/// new workspace.
struct WorkspaceSwitcherView: View {
    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @State private var isPresentingAddWorkspace = false
    @State private var pendingSignOutId: String?

    /// Called when the user taps a row — `RootScene` decides what "select"
    /// means per size class (just switch on iPad; switch + push on iPhone).
    let onSelectWorkspace: (Workspace) -> Void

    var body: some View {
        List {
            ForEach(workspaceStore.workspaces) { workspace in
                Button {
                    onSelectWorkspace(workspace)
                } label: {
                    row(for: workspace)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        pendingSignOutId = workspace.id
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
        }
        .overlay {
            if workspaceStore.workspaces.isEmpty {
                ContentUnavailableView(
                    "No workspaces yet",
                    systemImage: "server.rack",
                    description: Text("Add a Crowi workspace to get started.")
                )
            }
        }
        .navigationTitle("Workspaces")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    isPresentingAddWorkspace = true
                } label: {
                    Label("Add Workspace", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $isPresentingAddWorkspace) {
            // A just-added workspace is navigated to exactly like tapping an
            // existing row (`onSelectWorkspace`) — `RootScene` already
            // decides what "select" means per size class.
            AddWorkspaceView(onFinishAdding: onSelectWorkspace)
        }
        .confirmationDialog(
            "Sign out of this workspace?",
            isPresented: Binding(get: { pendingSignOutId != nil }, set: { if !$0 { pendingSignOutId = nil } }),
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) {
                if let id = pendingSignOutId {
                    Task { @MainActor in
                        await workspaceStore.signOut(id)
                    }
                }
                pendingSignOutId = nil
            }
            Button("Cancel", role: .cancel) {
                pendingSignOutId = nil
            }
        }
    }

    private func row(for workspace: Workspace) -> some View {
        HStack {
            VStack(alignment: .leading) {
                Text(workspace.displayTitle)
                    .font(.headline)
                Text(workspace.workspaceOrigin.host)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if workspace.id == workspaceStore.activeWorkspaceId {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
            }
        }
        .contentShape(Rectangle())
    }
}
