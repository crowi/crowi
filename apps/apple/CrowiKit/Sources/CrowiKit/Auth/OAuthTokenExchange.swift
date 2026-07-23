import Foundation

/// RFC-0016 §4.1 step 3 / §5.1 gate B finding — the hand-written
/// `POST {token_endpoint}` request/response shape shared by
/// `OAuthSignInFlow` (initial `authorization_code` exchange) and
/// `RefreshCoordinator` (`refresh_token` exchange). Gate B established that
/// the swift-openapi-generator `Operations.post_sol_oauth_sol_token.Input`
/// has no body property at all (`GeneratedClientSmoke.tokenInputHasNoBody`),
/// so both call sites issue a hand-written, form-encoded `URLRequest` here —
/// the same shape `packages/cli/src/lib/oauth.ts`'s `postToken`/`formBody`
/// already uses server-side-compatibly.
enum OAuthTokenExchange {
    enum ExchangeError: Error, Equatable {
        case httpError(status: Int, body: String)
        case malformedResponse
    }

    /// `application/x-www-form-urlencoded`, RFC 6749 §4.1.3 / §6.
    static func formEncode(_ fields: [(String, String)]) -> Data {
        fields
            .map { key, value in "\(formPercentEncode(key))=\(formPercentEncode(value))" }
            .joined(separator: "&")
            .data(using: .utf8) ?? Data()
    }

    /// Percent-encodes a single `application/x-www-form-urlencoded` key or
    /// value. `CharacterSet.urlQueryAllowed` is intentionally NOT used here:
    /// it leaves form delimiters such as `+`, `&`, and `=` unescaped, which
    /// would corrupt OAuth codes/tokens if a server ever returned a
    /// non-base64url token containing those characters. Keep the allowed set
    /// to RFC 3986 unreserved characters only.
    private static func formPercentEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: formAllowedCharacters) ?? value
    }

    private static let formAllowedCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// POST `fields` (form-encoded) to `endpoint` and decode the RFC 6749
    /// §5.1 success response `{ access_token, refresh_token, expires_in, … }`
    /// into a `StoredTokenPair`, with `expiresAt` computed as
    /// `(receipt instant) + expires_in` (§4.2 — the server sends only the
    /// relative `expires_in`).
    static func exchange(fields: [(String, String)], at endpoint: URL, urlSession: URLSession) async throws -> StoredTokenPair {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = formEncode(fields)

        let (data, response) = try await urlSession.data(for: request)
        let receiptInstant = Date()
        guard response.isSuccessfulHTTPResponse else {
            throw ExchangeError.httpError(status: response.httpStatusCodeOrUnknown, body: String(data: data, encoding: .utf8) ?? "<binary>")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let accessToken = json["access_token"] as? String,
            let refreshToken = json["refresh_token"] as? String,
            let expiresIn = json["expires_in"] as? Double
        else {
            throw ExchangeError.malformedResponse
        }
        return StoredTokenPair(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: receiptInstant.addingTimeInterval(expiresIn)
        )
    }
}
