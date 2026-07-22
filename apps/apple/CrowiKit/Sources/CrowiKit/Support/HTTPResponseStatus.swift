import Foundation

/// Shared "was this a successful HTTP response" check for every raw
/// `URLSession` call site in CrowiKit that fetches an unauthenticated/lenient
/// endpoint and needs to branch on 2xx vs. everything else before decoding
/// the body (`AppInfoLenient.fetch`, `OAuthDiscoveryDocument.fetch`,
/// `OAuthTokenExchange.exchange`, `WorkspaceImageLoader.fetch`) — factored
/// out so the `200..<300` range and the "not even an `HTTPURLResponse`"
/// fallback are declared exactly once instead of once per call site.
extension URLResponse {
    /// `true` only for an `HTTPURLResponse` whose `statusCode` is in `200..<300`.
    var isSuccessfulHTTPResponse: Bool {
        (self as? HTTPURLResponse).map { 200..<300 ~= $0.statusCode } ?? false
    }

    /// The HTTP status code, or `-1` if this isn't an `HTTPURLResponse` at all
    /// (not expected in practice for an `http(s)://` request, but every call
    /// site needs a fallback when building its own error after a non-2xx
    /// response).
    var httpStatusCodeOrUnknown: Int {
        (self as? HTTPURLResponse)?.statusCode ?? -1
    }
}
