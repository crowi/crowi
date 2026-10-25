import CrowiKit
import SwiftUI

/// What a workspace shows when it has no usable credential
/// (`WorkspaceSession.needsSignIn`): the server refused the sign-in, or the
/// app can no longer read it from the Keychain.
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
/// no lost read cache. Signing out is offered beside it for a workspace the
/// reader no longer means to use.
struct WorkspaceSignInAgainView: View {
    @ObservedObject var session: WorkspaceSession

    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @State private var isSigningIn = false
    @State private var isConfirmingSignOut = false
    @State private var failure: DisplayableFailure?

    var body: some View {
        ContentUnavailableView {
            Label("Sign in again", systemImage: "person.badge.key")
        } description: {
            Text("Your sign-in to \(session.context.workspace.displayTitle) is no longer valid. Sign in again to keep using it.")
        } actions: {
            VStack(spacing: 12) {
                if isSigningIn {
                    ProgressView()
                } else {
                    Button("Sign In") { signIn() }
                        .buttonStyle(.borderedProminent)
                    Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
                }
                if let failure {
                    FailureText(failure: failure)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .background(CrowiTheme.background)
        .confirmationDialog(
            "Sign out of this workspace?",
            isPresented: $isConfirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) {
                let id = session.context.id
                Task { @MainActor in await workspaceStore.signOut(id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It is removed from this device along with its cached pages.")
        }
    }

    private func signIn() {
        failure = nil
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
                failure = ASWebAuthenticationSessionRunner.isUserCancellation(error)
                    ? nil
                    : DisplayableFailure(
                        message: NetworkFailureMessage.message(for: error) ?? "Sign-in failed. Try again.",
                        error: error
                    )
            }
        }
    }
}
