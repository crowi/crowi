import Foundation

/// RFC-0016 §4.1 step 0 / Phase 0 gate A — RFC 8414 discovery document.
///
/// Decoded **leniently** (§5.2's rule applies here too, not just `/app/info`):
/// only the fields the app actually uses are required; everything else is
/// ignored. Reuse target: `packages/api/src/hono/handlers/oauth.ts:385-404`
/// is the server's discovery handler — `authorization_endpoint` is a
/// **web-origin** page (`${issuer}/oauth/authorize`, no `/api`) while
/// `token_endpoint` is under `/api` (`${issuer}/api/oauth/token`).
/// They are same-origin only "in the default deployment" (oauth.ts comment),
/// so the app MUST resolve both from this document and MUST NOT hardcode
/// `apiBaseURL + "/oauth/..."` — mirroring
/// `packages/cli/src/lib/oauth.ts:227-236`'s discovery-driven resolution
/// (the CLI is the closest existing precedent; ASWAS replaces only its
/// loopback-listener transport, §4.1).
public struct OAuthDiscoveryDocument: Sendable, Equatable {
    public let issuer: URL
    public let authorizationEndpoint: URL
    public let tokenEndpoint: URL
    /// RFC 7009 revocation endpoint — resolved from discovery, same as
    /// `tokenEndpoint`, and for the same reason: `SignOutFlow` (§3/§4.2/§14)
    /// MUST NOT hardcode `apiBaseURL + "/oauth/revoke"` either. The server
    /// always emits this field (`oauth.ts` discovery handler), so it is
    /// required here, mirroring `tokenEndpoint`'s requiredness.
    public let revocationEndpoint: URL
    public let deviceAuthorizationEndpoint: URL?

    public init(issuer: URL, authorizationEndpoint: URL, tokenEndpoint: URL, revocationEndpoint: URL, deviceAuthorizationEndpoint: URL?) {
        self.issuer = issuer
        self.authorizationEndpoint = authorizationEndpoint
        self.tokenEndpoint = tokenEndpoint
        self.revocationEndpoint = revocationEndpoint
        self.deviceAuthorizationEndpoint = deviceAuthorizationEndpoint
    }

    public enum DecodeError: Error, Equatable {
        /// A required field was missing or not a string, or not a valid URL.
        case malformed(field: String)
    }

    /// Lenient decode from the raw discovery JSON body. Never throws on an
    /// unknown extra field (e.g. `scopes_supported`, `code_challenge_methods_supported`)
    /// — those are simply not modeled here because v1 doesn't read them.
    public static func decode(_ data: Data) throws -> OAuthDiscoveryDocument {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodeError.malformed(field: "<root>")
        }
        func url(_ key: String) throws -> URL {
            guard let raw = object[key] as? String, let url = URL(string: raw) else {
                throw DecodeError.malformed(field: key)
            }
            return url
        }
        let issuer = try url("issuer")
        let authorize = try url("authorization_endpoint")
        let token = try url("token_endpoint")
        let revoke = try url("revocation_endpoint")
        // Optional: an older host predating device-grant advertisement
        // should not fail the whole decode (lenient-decode policy, §5.2).
        let device = (object["device_authorization_endpoint"] as? String).flatMap(URL.init(string:))
        return OAuthDiscoveryDocument(
            issuer: issuer,
            authorizationEndpoint: authorize,
            tokenEndpoint: token,
            revocationEndpoint: revoke,
            deviceAuthorizationEndpoint: device
        )
    }

    /// Fetch + decode `GET {workspaceOrigin}/.well-known/oauth-authorization-server`.
    public static func fetch(workspaceOrigin: URL, urlSession: URLSession = .shared) async throws -> OAuthDiscoveryDocument {
        let url = workspaceOrigin.appendingPathComponent(".well-known/oauth-authorization-server")
        let (data, response) = try await urlSession.data(from: url)
        guard response.isSuccessfulHTTPResponse else {
            throw DecodeError.malformed(field: "<http-status>")
        }
        return try decode(data)
    }
}
