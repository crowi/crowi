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
        httpStatusCodeOrUnknown.isSuccessfulHTTPStatus
    }

    /// The HTTP status code, or `-1` if this isn't an `HTTPURLResponse` at all
    /// (not expected in practice for an `http(s)://` request, but every call
    /// site needs a fallback when building its own error after a non-2xx
    /// response).
    var httpStatusCodeOrUnknown: Int {
        (self as? HTTPURLResponse)?.statusCode ?? -1
    }
}

/// `feature-ios-phase1-read` — `AuthenticatedAPIClient` (built on
/// `HTTPTypes.HTTPResponse`/`OpenAPIRuntime.ClientTransport`, not
/// `Foundation.URLResponse`) only ever has the bare status code by the time
/// its caller needs to branch on 2xx vs. everything else, so the shared
/// `200..<300` range lives here too rather than being re-declared per lenient
/// decoder call site.
extension Int {
    /// `true` when this is a 2xx HTTP status code.
    var isSuccessfulHTTPStatus: Bool {
        200..<300 ~= self
    }
}
