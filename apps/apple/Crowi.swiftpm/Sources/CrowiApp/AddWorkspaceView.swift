import CrowiKit
import SwiftUI

/// RFC-0016 §3 add-flow UI: URL input → `AddWorkspaceFlow.addWorkspace`
/// (HTTPS gate → lenient `/app/info` probe → minimum-version gate → ASWAS
/// sign-in, §4.1) → persisted via `WorkspaceStore.finishAdding`.
struct AddWorkspaceView: View {
    @EnvironmentObject private var workspaceStore: WorkspaceStore
    @Environment(\.dismiss) private var dismiss

    /// Called with the newly onboarded workspace right before this view
    /// dismisses itself. `WorkspaceSwitcherView` passes its own
    /// `onSelectWorkspace` here — the size-class-specific "navigate to this
    /// workspace's home" behavior `RootScene` already defines for tapping an
    /// EXISTING row applies identically to a just-added one, so a
    /// successful add must not leave the user back at the switcher.
    let onFinishAdding: (Workspace) -> Void

    @State private var hostText = ""
    @State private var isAdding = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("wiki.example.com", text: $hostText)
                        .autocorrectionDisabled()
                        #if canImport(UIKit)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .disabled(isAdding)
                } header: {
                    Text("Workspace URL")
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add Workspace")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isAdding)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isAdding {
                        ProgressView()
                    } else {
                        Button("Add") { addWorkspace() }
                            .disabled(hostText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func addWorkspace() {
        errorMessage = nil
        isAdding = true
        let input = hostText
        Task { @MainActor in
            do {
                let sessionRunner = ASWebAuthenticationSessionRunner()
                let onboarded = try await AddWorkspaceFlow.addWorkspace(
                    userInput: input,
                    presentSession: { authorizeURL in try await sessionRunner.run(authorizeURL: authorizeURL) }
                )
                let workspace = try workspaceStore.finishAdding(onboarded)
                isAdding = false
                onFinishAdding(workspace)
                dismiss()
            } catch {
                isAdding = false
                // Backing out of the sheet is not a failure — say nothing.
                errorMessage = ASWebAuthenticationSessionRunner.isUserCancellation(error) ? nil : Self.describe(error)
            }
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case AddWorkspaceFlow.AddWorkspaceError.invalidURL:
            return "Enter a valid URL."
        case AddWorkspaceFlow.AddWorkspaceError.insecureOrigin:
            return "This host must use HTTPS (only localhost/127.0.0.1/*.local may use http)."
        case AddWorkspaceFlow.AddWorkspaceError.notACrowiHost:
            return "This does not look like a Crowi instance."
        case AddWorkspaceFlow.AddWorkspaceError.hostUnreachable:
            return "Could not reach this host."
        case AddWorkspaceFlow.AddWorkspaceError.tooOld(let hostVersion, let floor):
            return "This Crowi (\(hostVersion)) is too old for the app — upgrade to \(floor)+."
        case AddWorkspaceFlow.AddWorkspaceError.unparseableVersion:
            return "Could not determine this host's Crowi version."
        default:
            // Never Apple's own words: they name a framework the reader has
            // no relationship with. A recognisable transport failure gets a
            // sentence; anything else says only what is certain.
            return NetworkFailureMessage.message(for: error) ?? "Sign-in failed. Try again."
        }
    }
}
