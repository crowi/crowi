import AuthenticationServices
import Foundation

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The production `presentSession` closure target for
/// `OAuthSignInFlow.signIn` — wraps `ASWebAuthenticationSession` (ephemeral,
/// §14: no shared cookies with Safari) with the `crowi-ios` custom-scheme
/// callback capture (§4.1). Mirrors the deleted Phase 0 `GateASpike.swift`'s
/// session-handling shape exactly; the only difference is this type has no
/// UI state of its own (no `@Published status`) — it is a pure `authorizeURL
/// -> callbackURL` async function, reusable by `AddWorkspaceFlow`.
///
/// Lives in CrowiKit (not the App target) per §9's "100% shared across
/// platforms" rule for auth: only the presentation anchor differs by
/// platform (`UIWindow` vs. `NSWindow`), isolated behind the `#if
/// canImport(UIKit)/AppKit` boundary below.
/// `@unchecked Sendable`: this type is `@MainActor`-isolated (all its mutable
/// state is only ever touched on the main actor), but it needs to be
/// capturable inside the `@Sendable presentSession` closure
/// `OAuthSignInFlow.signIn`/`AddWorkspaceFlow.addWorkspace` accept — every
/// actual access still goes through an `await`-ed, MainActor-isolated method
/// call, so the isolation guarantee is real even though the compiler can't
/// prove it structurally here.
@MainActor
public final class ASWebAuthenticationSessionRunner: NSObject, @unchecked Sendable {
    override public init() {
        super.init()
    }

    // Held for the session's lifetime so ARC doesn't tear it down mid-flow.
    private var activeSession: ASWebAuthenticationSession?

    /// Presents `authorizeURL` in an ephemeral ASWAS and resolves with the
    /// `crowi-ios://callback…` URL ASWAS captures (or throws — including a
    /// user cancellation, surfaced as ASWAS's own
    /// `ASWebAuthenticationSessionError.canceledLogin`).
    public func run(authorizeURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizeURL,
                callbackURLScheme: OAuthSignInFlow.callbackURLScheme
            ) { [weak self] url, error in
                Task { @MainActor in
                    self?.activeSession = nil
                }
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.activeSession = session
            session.start()
        }
    }
}

extension ASWebAuthenticationSessionRunner: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        let windowScenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return windowScenes.filter { $0.activationState == .foregroundActive }.compactMap(\.keyWindow).first
            ?? windowScenes.compactMap(\.keyWindow).first
            ?? ASPresentationAnchor()
        #elseif canImport(AppKit)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }
}
