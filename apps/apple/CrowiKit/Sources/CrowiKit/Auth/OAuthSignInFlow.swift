import Foundation

/// RFC-0016 §4.1 — the real ASWAS + PKCE + discovery + token-exchange
/// Authorization-Code flow, **replacing** the throwaway Phase 0
/// `GateASpike.swift` (deleted in this same change). Mirrors that spike's
/// exact wire shape (discovery → PKCE → ASWAS with
/// `callbackURLScheme = "crowi-ios"` → state check → form-encoded token
/// POST) but is parameterized on `workspaceOrigin` and an injectable session
/// presenter (instead of a hardcoded dev origin + a `@Published` status
/// string), and returns a `StoredTokenPair` for `WorkspaceStore`/`AddWorkspaceFlow`
/// to persist.
public enum OAuthSignInFlow {
    /// **AC-4 pin — the single source of the app's OAuth scope set.**
    /// Requested up front at authorize time (RFC-0016 §4.1) so the app never
    /// hits `403 INSUFFICIENT_SCOPE` on any endpoint Phase 1(.5)/2/3 calls:
    /// every scope guarding an endpoint this app will ever call, audited
    /// from `applyScope(...)` call sites in
    /// `packages/api/src/hono/handlers/{page,comment,bookmark,attachment-stream,
    /// notification,user,me,search,backlink,autocomplete,revision,draft}.ts`
    /// (`pages:read/write`, `comments:read/write`, `bookmarks:read/write`,
    /// `attachments:read`, `notifications:read/write`, `profile:read`).
    /// **Nothing else in the app re-declares this string.**
    public static let requestedScope =
        "pages:read pages:write comments:read comments:write bookmarks:read bookmarks:write attachments:read notifications:read notifications:write profile:read"

    /// The seeded, trusted, first-party public client
    /// (`packages/api/src/util/oauth-client-seed.ts:34,45`).
    public static let clientID = "crowi-ios"
    /// The client's single registered redirect URI (§4.4), claimed via
    /// `Crowi.swiftpm/Support/AdditionalInfo.plist`'s `CFBundleURLTypes`.
    public static let redirectURI = "crowi-ios://callback"
    /// `callbackURLScheme` ASWAS matches `redirectURI`'s scheme against.
    public static let callbackURLScheme = "crowi-ios"

    public enum SignInError: Error, Equatable {
        case malformedCallback
        case stateMismatch
    }

    /// Runs the full flow starting from a bare `workspaceOrigin`: resolves
    /// discovery (§4.1 step 0 — never assumed equal to `apiBaseURL`), then
    /// delegates to the `discovery:`-taking overload below.
    ///
    /// - Parameter presentSession: presents `authorizeURL` in an ASWAS
    ///   (`callbackURLScheme = "crowi-ios"`) and returns the resulting
    ///   callback URL, or throws on cancel/failure. Production callers use
    ///   `ASWebAuthenticationSessionRunner.run`; tests inject a stub that
    ///   returns a synthetic callback URL with no real webview.
    public static func signIn(
        workspaceOrigin: WorkspaceOrigin,
        presentSession: @Sendable (_ authorizeURL: URL) async throws -> URL,
        urlSession: URLSession = .shared
    ) async throws -> StoredTokenPair {
        let discovery = try await OAuthDiscoveryDocument.fetch(workspaceOrigin: workspaceOrigin.baseURL, urlSession: urlSession)
        return try await signIn(discovery: discovery, presentSession: presentSession, urlSession: urlSession)
    }

    /// Same flow, given an already-resolved discovery document — kept as a
    /// separate overload so tests can supply a fixed discovery fixture
    /// directly, without standing up a mock `.well-known` endpoint.
    public static func signIn(
        discovery: OAuthDiscoveryDocument,
        presentSession: @Sendable (_ authorizeURL: URL) async throws -> URL,
        urlSession: URLSession = .shared
    ) async throws -> StoredTokenPair {
        let (verifier, challenge) = PKCE.generate()
        let state = UUID().uuidString
        let authorizeURL = makeAuthorizeURL(discovery: discovery, codeChallenge: challenge, state: state)

        let callbackURL = try await presentSession(authorizeURL)
        let (code, returnedState) = try parseCallback(callbackURL)
        guard returnedState == state else {
            throw SignInError.stateMismatch
        }

        return try await OAuthTokenExchange.exchange(
            fields: [
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirectURI),
                ("client_id", clientID),
            ],
            at: discovery.tokenEndpoint,
            urlSession: urlSession
        )
    }

    /// Exposed at package-internal visibility (not `private`) so
    /// `OAuthSignInFlowTests` can assert the exact query items sent, without
    /// needing to drive a full `signIn(...)` call (which would require a
    /// working `presentSession` stub too).
    static func makeAuthorizeURL(discovery: OAuthDiscoveryDocument, codeChallenge: String, state: String) -> URL {
        var components = URLComponents(url: discovery.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: requestedScope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        // swiftlint:disable:next force_unwrapping — discovery.authorizationEndpoint is already a valid URL.
        return components.url!
    }

    static func parseCallback(_ url: URL) throws -> (code: String, state: String?) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let code = components.queryItems?.first(where: { $0.name == "code" })?.value
        else {
            throw SignInError.malformedCallback
        }
        let state = components.queryItems?.first(where: { $0.name == "state" })?.value
        return (code, state)
    }
}
