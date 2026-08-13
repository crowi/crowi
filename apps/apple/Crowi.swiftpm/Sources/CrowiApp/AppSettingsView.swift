import CrowiKit
import SwiftUI

/// The app's own settings — everything that belongs to this install rather
/// than to a wiki.
///
/// A Crowi account's settings live on its server and are edited there. What
/// is left over is the state this app keeps on the device, and until now none
/// of it was reachable: the workspace list could be added to but never pruned,
/// and the caches could only be cleared by deleting the app. Both are the
/// first thing to try when a workspace misbehaves, which is exactly when the
/// reader is least able to reinstall.
struct AppSettingsView: View {
    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @EnvironmentObject private var settings: AppSettings

    @State private var signingOut: String?
    @State private var clearedWorkspaceId: String?

    var body: some View {
        List {
            Section("Workspaces") {
                ForEach(workspaceStore.workspaces, id: \.id) { workspace in
                    row(for: workspace)
                }
            }

            Section {
                Toggle("Developer Mode", isOn: $settings.isDeveloperModeEnabled)
            } header: {
                Text("Diagnostics")
            } footer: {
                Text("Shows the raw failure behind an error message. Useful in a bug report; not meant for everyday reading.")
            }

            Section("About") {
                LabeledContent("Version", value: Self.versionText)
            }
        }
        .navigationTitle("Settings")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder
    private func row(for workspace: Workspace) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(workspace.displayTitle)
                .font(CrowiTypography.rowTitle)
            Text(workspace.workspaceOrigin.baseURL.absoluteString)
                .font(CrowiTypography.rowMeta)
                .foregroundStyle(CrowiTheme.mutedForeground)
            HStack(spacing: 16) {
                Button("Clear Cache") { clearCache(workspace) }
                    .buttonStyle(.borderless)
                if signingOut == workspace.id {
                    ProgressView()
                } else {
                    // Sign-out is the destructive one: it revokes server-side,
                    // purges the credential and drops the workspace entirely.
                    Button("Sign Out", role: .destructive) { signOut(workspace) }
                        .buttonStyle(.borderless)
                }
            }
            .font(CrowiTypography.rowMeta)
            if clearedWorkspaceId == workspace.id {
                Text("Cache cleared. Pages reload on next open.")
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
            }
        }
        .padding(.vertical, 4)
    }

    /// Drops what can be fetched again, and only that — the credential and the
    /// workspace itself survive, which is what separates this from signing
    /// out. The caches rebuild on the next read.
    private func clearCache(_ workspace: Workspace) {
        WorkspaceModelContainerFactory.deleteImagesCacheDirectory(workspaceId: workspace.id)
        WorkspaceModelContainerFactory.deleteWorkspaceDirectory(workspaceId: workspace.id)
        clearedWorkspaceId = workspace.id
    }

    private func signOut(_ workspace: Workspace) {
        signingOut = workspace.id
        Task {
            await workspaceStore.signOut(workspace.id)
            signingOut = nil
        }
    }

    private static var versionText: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }
}
