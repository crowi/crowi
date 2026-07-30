import Foundation

/// `feature-ios-image-viewer` — the seam `ImageViewerView` resolves its
/// fetch URL through. Abstracted as a protocol (the same shape as
/// `WorkspaceImageFetching`) so tests can drive the viewer's loading
/// pipeline with a stub resolver, without a real `/meta` round-trip.
public protocol ViewerImageURLResolving: Sendable {
    /// The URL string the viewer should fetch for `canonical` — either the
    /// same-origin explicit-original URL, or `canonical` itself (the
    /// fallback; the viewer then shows exactly what the body showed).
    func viewerImageURLString(for canonical: URL) async -> String
}

/// Resolves a tapped body image's canonical embedded URL to the URL the
/// fullscreen viewer should fetch, concentrating the ONE "body = display
/// derivative / viewer = original" decision in one place.
///
/// `feature-image-derivative-optimization` made the canonical attachment URL
/// (`/api/attachments/<id>`) serve a display derivative, with the
/// original bytes behind an explicit `${url}/original` path
/// (`AttachmentMetaSchema.originalUrl`). The page body deliberately keeps
/// embedding the canonical URL (bandwidth — this resolver never rewrites
/// the body's own image path), but a pinch-zoom viewer wants the original.
/// A body embed carries no attachment response object, only the URL — so
/// this resolver recognizes the canonical embedded shape, asks
/// `GET /attachments/<id>/meta` (tolerantly decoded via
/// `AttachmentMetaLenient`), and rebases the returned relative `originalUrl`
/// against the workspace origin.
///
/// EVERY other case falls back to the canonical URL itself, so the viewer
/// never renders worse than the body did:
///   - legacy `/files/<id>` embeds — no attachment id to ask `/meta` with
///     (the id only materializes after the server's 302); pinned decision:
///     fallback only, no redirect chasing;
///   - external allowlisted images and avatar `by-key/<key>` URLs — no
///     original derivative story at all;
///   - a `/meta` `404`/non-2xx/non-decodable body or a missing
///     `originalUrl` — a workspace predating the display contract, where
///     canonical IS the original;
///   - an `originalUrl` that rebases off the workspace origin — never
///     followed (the workspace's Bearer-gated fetch path must stay
///     same-origin, §6.1).
///
/// The RESULT is always fetched by the caller through the same
/// `WorkspaceImageFetching` seam (disk cache → §6.1 loader) as every other
/// image — this type never fetches image bytes itself, and the `/original`
/// URL is naturally its own disk-cache entry (the cache is URL-keyed).
public struct OriginalImageResolver: ViewerImageURLResolving {
    private let workspaceOrigin: WorkspaceOrigin
    private let apiClient: AuthenticatedAPIClient

    public init(workspaceOrigin: WorkspaceOrigin, apiClient: AuthenticatedAPIClient) {
        self.workspaceOrigin = workspaceOrigin
        self.apiClient = apiClient
    }

    public func viewerImageURLString(for canonical: URL) async -> String {
        let fallback = canonical.absoluteString
        guard let attachmentId = Self.embeddedAttachmentID(of: canonical, workspaceOrigin: workspaceOrigin) else {
            return fallback
        }
        guard
            let meta = try? await AttachmentMetaLenient.fetch(attachmentId: attachmentId, using: apiClient),
            let originalUrl = meta.originalUrl,
            let rebased = URL(string: originalUrl, relativeTo: workspaceOrigin.baseURL),
            WorkspaceOrigin(rebased) == workspaceOrigin
        else {
            return fallback
        }
        return rebased.absoluteString
    }

    /// Extracts the attachment id ONLY from the exact canonical embedded
    /// shape: `<workspace origin>/api/attachments/<24-hex ObjectId>` —
    /// nothing else. Not `by-key/<key>` (one extra path segment), not an
    /// already-suffixed `/meta`/`/original` (ditto), not legacy
    /// `/files/<id>`, never a cross-origin URL. The 24-hex-character check
    /// mirrors the server's own `isValidObjectId` gate and doubles as
    /// path-injection protection when the id is re-embedded into the
    /// `/meta` request path.
    static func embeddedAttachmentID(of url: URL, workspaceOrigin: WorkspaceOrigin) -> String? {
        // Rebase the same way `WorkspaceImageLoader.fetch` does, so a
        // workspace-relative embed and its absolute form judge identically.
        guard let resolved = URL(string: url.absoluteString, relativeTo: workspaceOrigin.baseURL) else { return nil }
        guard WorkspaceOrigin(resolved) == workspaceOrigin else { return nil }
        let components = resolved.absoluteURL.pathComponents
        guard components.count == 4, components[1] == "api", components[2] == "attachments" else {
            return nil
        }
        let id = components[3]
        guard id.count == 24, id.allSatisfy(\.isHexDigit) else { return nil }
        return id
    }
}
