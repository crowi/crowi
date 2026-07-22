import AuthenticationServices
import CrowiKit
import UIKit

/// RFC-0016 Phase 0 gate A — throwaway spike proving the ASWAS end-to-end
/// flow now that feature-ios-companion-server has landed on main (this
/// worktree's redirect-uri validator now accepts `crowi-ios://callback` for
/// the trusted first-party `crowi-ios` client). NOT the Phase 1
/// implementation — no WorkspaceStore, no persisted session, hardcoded
/// origin. Exists only to produce evidence for feature-ios-phase0-gates.md's
/// Gate A judgement, then gets deleted.
enum GateASpikeConfig {
    /// This worktree's `pnpm dev` proxy origin (RFC-0016 dev convention:
    /// anchor+3 — see CLAUDE.md "Parallel worktree dev ports"). Real app
    /// code (Phase 1) takes the origin from user input, never a constant.
    static let workspaceOrigin = URL(string: "http://localhost:4323")!
    static let clientID = "crowi-ios"
    static let redirectURI = "crowi-ios://callback"
    static let scope = "profile:read"
}

enum GateASpikeError: Error, CustomStringConvertible {
    case malformedCallback
    case stateMismatch
    case tokenExchangeFailed(status: Int, body: String)
    case malformedTokenResponse

    var description: String {
        switch self {
        case .malformedCallback: return "callback URL missing code/state"
        case .stateMismatch: return "state mismatch (possible CSRF)"
        case .tokenExchangeFailed(let status, let body): return "token exchange failed (\(status)): \(body)"
        case .malformedTokenResponse: return "token response missing access_token"
        }
    }
}

@MainActor
final class GateASpikeRunner: NSObject, ObservableObject {
    @Published var status = "idle"

    func run() {
        status = "discovering endpoints…"
        Task {
            do {
                let token = try await performFlow()
                status = "✅ token acquired (\(token.prefix(12))…)"
            } catch {
                status = "❌ \(error)"
            }
        }
    }

    private func performFlow() async throws -> String {
        let discovery = try await OAuthDiscoveryDocument.fetch(workspaceOrigin: GateASpikeConfig.workspaceOrigin)
        let (verifier, challenge) = PKCE.generate()
        let state = UUID().uuidString

        var components = URLComponents(url: discovery.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: GateASpikeConfig.clientID),
            URLQueryItem(name: "redirect_uri", value: GateASpikeConfig.redirectURI),
            URLQueryItem(name: "scope", value: GateASpikeConfig.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        let authorizeURL = components.url!

        status = "waiting for sign-in…"
        let callbackURL = try await startSession(authorizeURL: authorizeURL)

        guard let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
            let returnedState = callbackComponents.queryItems?.first(where: { $0.name == "state" })?.value,
            let code = callbackComponents.queryItems?.first(where: { $0.name == "code" })?.value
        else {
            throw GateASpikeError.malformedCallback
        }
        guard returnedState == state else {
            throw GateASpikeError.stateMismatch
        }

        status = "exchanging code for token…"
        return try await exchangeToken(code: code, verifier: verifier, tokenEndpoint: discovery.tokenEndpoint)
    }

    private func startSession(authorizeURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizeURL,
                callbackURLScheme: "crowi-ios"
            ) { url, error in
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
            // Held for the session's lifetime so ARC doesn't tear it down
            // mid-flow; this spike only ever runs one session at a time.
            self.activeSession = session
            session.start()
        }
    }

    private func exchangeToken(code: String, verifier: String, tokenEndpoint: URL) async throws -> String {
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let form: [(String, String)] = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", GateASpikeConfig.redirectURI),
            ("client_id", GateASpikeConfig.clientID),
        ]
        request.httpBody = form
            .map { key, value in "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value)" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GateASpikeError.tokenExchangeFailed(status: status, body: String(data: data, encoding: .utf8) ?? "<binary>")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let accessToken = json["access_token"] as? String
        else {
            throw GateASpikeError.malformedTokenResponse
        }
        return accessToken
    }

    private var activeSession: ASWebAuthenticationSession?
}

extension GateASpikeRunner: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}
