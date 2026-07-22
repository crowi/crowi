import Foundation

/// RFC-0016 §3/§4.2/§14 — independent sign-out: server-side revoke
/// (`POST {revocation_endpoint}`, RFC 7009) + delete exactly that
/// workspace's Keychain item. Never touches another workspace (§4.3) — the
/// caller (`WorkspaceStore.signOut`) is responsible for the higher-level
/// teardown: index entry removal + that workspace's image cache
/// (`WorkspaceModelContainerFactory.deleteImagesCacheDirectory`) + its
/// on-disk ModelContainer store (`deleteWorkspaceDirectory`) — four
/// explicit steps, each its own call at that call site, unaffected by
/// whether this revoke call itself succeeded.
enum SignOutFlow {
    /// Best-effort, like the CLI's `revokeToken` (`packages/cli/src/lib/oauth.ts`)
    /// and matching the server's own RFC 7009 semantics (`revokeRoute` always
    /// returns 200, even for an unknown/already-revoked token) — sign-out
    /// **always** completes the local purge regardless of whether the
    /// network call succeeded, so a lost connection never blocks a user from
    /// removing a workspace from their device.
    /// Not `public` — `tokenStore: any WorkspaceTokenStoring` is
    /// module-internal (§14); the only legitimate caller is
    /// `WorkspaceStore.signOut(_:)`, which already holds the store.
    static func signOut(
        workspaceId: String,
        tokenStore: any WorkspaceTokenStoring,
        revocationEndpoint: URL,
        clientID: String = OAuthSignInFlow.clientID,
        urlSession: URLSession = .shared
    ) async {
        let stored = try? tokenStore.load(forWorkspace: workspaceId)
        if let refreshToken = stored?.refreshToken {
            await revoke(token: refreshToken, at: revocationEndpoint, clientID: clientID, urlSession: urlSession)
        }
        try? tokenStore.delete(forWorkspace: workspaceId)
    }

    private static func revoke(token: String, at endpoint: URL, clientID: String, urlSession: URLSession) async {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = OAuthTokenExchange.formEncode([("token", token), ("client_id", clientID)])
        _ = try? await urlSession.data(for: request)
    }
}
