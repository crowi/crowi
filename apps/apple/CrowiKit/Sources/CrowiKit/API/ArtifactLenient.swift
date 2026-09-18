import Foundation

/// RFC-0020 — what a Revision's body IS: Markdown source, or a single
/// self-contained HTML document (an "artifact") that only ever runs inside
/// the server's sandbox. Distinct from the storage representation
/// (`snapshot | incremental`).
///
/// Anything but the literal `"artifact"` — including a missing field from a
/// server that predates RFC-0020 — reads as Markdown, which is both the
/// server's own normalization for legacy rows and the web's rule
/// (`contentType === 'artifact'`).
public enum PageContentType: String, Sendable, Equatable {
    case markdown
    case artifact

    /// `nil` when the field is absent, so a caller can tell "the server said
    /// markdown" apart from "the server said nothing" and fall back to a
    /// less authoritative source (the page-level hint).
    static func decode(_ value: Any?) -> PageContentType? {
        guard let raw = value as? String else { return nil }
        return raw == PageContentType.artifact.rawValue ? .artifact : .markdown
    }
}

/// `POST /pages/{id}/artifact-url` — mints the short-lived signed URL the
/// artifact's HTML is served from, on the delivery origin, with the
/// server's sandboxing `Content-Security-Policy` attached to the response.
///
/// That header is the whole security boundary, which is why the app only
/// ever loads an artifact through this URL and never hands the body it
/// already holds to a web view: a CSP cannot travel inside the document
/// (the server rejects `<meta http-equiv>` at write time), so a locally
/// loaded copy would run the author's scripts unsandboxed.
public enum ArtifactURLMint {
    public enum Outcome: Sendable, Equatable {
        /// The URL expires quickly (seconds, not minutes), so mint right
        /// before loading and never keep it for later.
        case ready(URL)
        /// The server has no artifact delivery configured (422) — nothing
        /// the reader can retry their way out of.
        case deliveryDisabled
        /// The revision is not an artifact after all (400) — the page
        /// changed kind between the detail read and the mint.
        case notAnArtifact
        case failed(status: Int)
    }

    private struct Request: Encodable, Sendable {
        let revisionId: String?
    }

    /// A transport failure (offline) is thrown as the underlying error, not
    /// folded into `Outcome`, so the reader can say "only while online".
    public static func mint(pageId: String, revisionId: String?, using client: AuthenticatedAPIClient) async throws -> Outcome {
        let (data, status) = try await client.post("pages/\(pageId)/artifact-url", json: Request(revisionId: revisionId))
        return outcome(status: status, data: data)
    }

    static func outcome(status: Int, data: Data) -> Outcome {
        guard status.isSuccessfulHTTPStatus else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let error = object?["error"] as? [String: Any]
            if error?["code"] as? String == "ARTIFACT_URL_UNAVAILABLE" {
                switch error?["reason"] as? String {
                case "ARTIFACT_DELIVERY_NOT_CONFIGURED": return .deliveryDisabled
                case "NOT_AN_ARTIFACT": return .notAnArtifact
                default: break
                }
            }
            return .failed(status: status)
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let raw = object["url"] as? String,
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            url.host != nil
        else {
            return .failed(status: status)
        }
        return .ready(url)
    }
}

/// What the artifact web view may navigate to. The web keeps an artifact
/// in place with a `frame-src` CSP on the document that frames it; a native
/// web view has no such outer document, so this decision is that pin.
public enum ArtifactNavigationPolicy {
    public enum Decision: Sendable, Equatable {
        case allow
        case cancel
        /// A link the reader tapped, handed to the app's own link handling
        /// instead of replacing the artifact.
        case openExternally(URL)
    }

    /// - Parameters:
    ///   - deliveryURL: the minted URL the view was asked to show.
    ///   - isMainFrame: `false` for a subframe or a new-window target.
    ///   - isLinkActivation: the reader tapped a link (as opposed to the
    ///     document navigating itself from script, a form, or a redirect).
    public static func decide(requestURL: URL?, deliveryURL: URL, isMainFrame: Bool, isLinkActivation: Bool) -> Decision {
        guard let requestURL else { return .cancel }
        // A `#fragment` jump inside the artifact is still the same document.
        if isMainFrame, sameResource(requestURL, deliveryURL) {
            return .allow
        }
        if isLinkActivation, let scheme = requestURL.scheme?.lowercased(), scheme == "https" || scheme == "http" {
            return .openExternally(requestURL)
        }
        return .cancel
    }

    /// Compared field by field rather than as whole URLs: WebKit hands back
    /// its own normalization of the loaded URL (lowercased host, a default
    /// port dropped), which must still count as the document it was given.
    private static func sameResource(_ lhs: URL, _ rhs: URL) -> Bool {
        guard let left = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
            let right = URLComponents(url: rhs, resolvingAgainstBaseURL: false),
            let scheme = left.scheme?.lowercased(),
            scheme == right.scheme?.lowercased()
        else { return false }
        let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
        return left.host?.lowercased() == right.host?.lowercased()
            && (left.port ?? defaultPort) == (right.port ?? defaultPort)
            && left.percentEncodedPath == right.percentEncodedPath
            && left.percentEncodedQuery == right.percentEncodedQuery
    }
}
