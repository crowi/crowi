import CrowiKit
import SwiftUI

/// RFC-0016 §3 — the empty workspace home: Phase 1's own scope ends at
/// "workspace added, signed in, home shown" (feature-ios-phase1-read builds
/// the real read surface — page tree, search, recently-viewed — on top of
/// this screen).
struct EmptyWorkspaceHomeView: View {
    let workspace: Workspace

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "server.rack")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(workspace.displayTitle)
                .font(.title2)
                .bold()
            Text(workspace.workspaceOrigin.host)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Signed in. Reading and editing pages arrive in a later phase.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding()
        .navigationTitle(workspace.displayTitle)
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
