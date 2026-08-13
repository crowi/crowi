import CrowiKit
import SwiftUI

/// What a workspace shows when the app can no longer read its credential
/// (`WorkspaceSession.needsSignIn`).
///
/// Without it the app looks broken rather than signed out: every screen
/// fails its own fetch and reports its own wording ("Couldn't load recently
/// updated pages."), while the workspace list — which lives in
/// `UserDefaults`, not the Keychain — still shows every workspace as if it
/// were fine. The state has a cause and a remedy, and this screen is where
/// they are said out loud.
///
/// Signing in writes the new credential over the unreadable one for the SAME
/// workspace, so nothing else about it changes: no removing and re-adding,
/// no lost read cache.
struct WorkspaceSignInAgainView: View {
    @ObservedObject var session: WorkspaceSession

    @State private var isSigningIn = false
    @State private var errorMessage: String?

    var body: some View {
        ContentUnavailableView {
            Label("Sign in again", systemImage: "person.badge.key")
        } description: {
            Text("\(session.context.workspace.displayTitle) needs you to sign in again before it can load anything.")
        } actions: {
            VStack(spacing: 12) {
                if isSigningIn {
                    ProgressView()
                } else {
                    Button("Sign In") { signIn() }
                        .buttonStyle(.borderedProminent)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.destructive)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .background(CrowiTheme.background)
    }

    private func signIn() {
        errorMessage = nil
        isSigningIn = true
        Task { @MainActor in
            defer { isSigningIn = false }
            do {
                let runner = ASWebAuthenticationSessionRunner()
                let pair = try await OAuthSignInFlow.signIn(
                    workspaceOrigin: session.context.workspace.workspaceOrigin,
                    presentSession: { authorizeURL in try await runner.run(authorizeURL: authorizeURL) }
                )
                try await session.signedIn(with: pair)
            } catch {
                // Backing out of the sheet is not a failure — say nothing.
                errorMessage = ASWebAuthenticationSessionRunner.isUserCancellation(error)
                    ? nil
                    : "Sign-in failed. \(error.localizedDescription)"
            }
        }
    }
}
