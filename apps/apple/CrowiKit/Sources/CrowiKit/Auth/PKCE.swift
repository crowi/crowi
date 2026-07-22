import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

/// RFC-0016 §4.1 / Phase 0 gate A — PKCE (RFC 7636) S256 code-verifier /
/// code-challenge generation, byte-for-byte compatible with the server's
/// verification (`packages/api/src/util/pkce.ts:verifyPkceS256`):
///
///     computed = base64url(sha256(codeVerifier))
///     compare(computed, codeChallenge)   // constant-time on the server
///
/// The server has no client-side PKCE code of its own to mirror bit-for-bit
/// (it only verifies), so the closest existing precedent is the CLI's
/// `packages/cli/src/lib/oauth.ts` `generateVerifier` / `challengeS256` pair
/// (same 32-random-bytes verifier + base64url(sha256(verifier)) challenge),
/// which this type matches.
public enum PKCE {
    /// A fresh (verifier, challenge) pair. `codeVerifier` is 43 base64url
    /// characters (32 random bytes), within RFC 7636's 43–128 range.
    public static func generate() -> (codeVerifier: String, codeChallenge: String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(result == errSecSuccess, "SecRandomCopyBytes failed")
        let verifier = base64URLEncode(Data(bytes))
        return (verifier, challenge(forVerifier: verifier))
    }

    /// `base64url(sha256(codeVerifier))` — recomputable independently of
    /// `generate()` so a test can assert it matches a fixed vector.
    public static func challenge(forVerifier codeVerifier: String) -> String {
        let digest = SHA256.hash(data: Data(codeVerifier.utf8))
        return base64URLEncode(Data(digest))
    }

    /// RFC 4648 §5 base64url, no padding — matches the server's
    /// `Buffer#toString('base64url')` and the CLI's hand-rolled equivalent.
    private static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
