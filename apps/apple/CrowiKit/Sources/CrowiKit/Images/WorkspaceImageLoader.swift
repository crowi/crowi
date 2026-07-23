import Foundation

/// RFC-0016 §6.1 / Phase 0 gate C — the per-workspace image loader.
///
/// Guards two `attachment-stream.ts`-shaped auth-gated URL forms
/// (`/api/v2/attachments/<id>` embedded images, grant-checked; and
/// `/api/v2/attachments/by-key/<key>` avatars, Bearer + prefix only) with
/// the §6.1 "hard rule": `Authorization: Bearer <token>` is attached **only**
/// when the (post-rebase) request origin exactly equals the workspace's
/// origin, and on a redirect the header is **stripped when the target
/// origin differs** and **preserved when it doesn't** — the same-origin
/// legacy `GET /files/<id>` → `/api/v2/attachments/<id>` 302 hop
/// (`attachment-stream.ts:250-252`) must keep working, while an
/// attacker-controlled absolute external image URL in an unsanitized page
/// body must never receive the workspace's Bearer.
///
/// This is the concrete seam gate C asked to prove exists: `URLSession`'s
/// per-task delegate (`urlSession(_:task:willPerformHTTPRedirection:...)`)
/// gives exactly the per-hop, origin-keyed decision point §6.1 requires —
/// confirmed both here (mocked, deterministic, CI-safe — see
/// `WorkspaceImageLoaderTests`) and, opportunistically, against a **real**
/// running local dev Crowi + a real attachment (AC-4; see that test file's
/// `testLiveRealAttachmentThroughFilesRedirect`).
public final class WorkspaceImageLoader: NSObject, Sendable {
    private let workspaceOrigin: WorkspaceOrigin
    private let accessTokenProvider: @Sendable () -> String
    private let session: URLSession

    /// - Parameters:
    ///   - workspaceOrigin: the active workspace's origin (scheme+host+port,
    ///     §3) — the Bearer-attach / redirect-strip decision boundary.
    ///   - accessTokenProvider: reads the *current* access token lazily
    ///     (never captured once — a refreshed token must be picked up
    ///     without re-constructing the loader).
    ///   - sessionConfiguration: override only for tests.
    public init(
        workspaceOrigin: URL,
        accessTokenProvider: @escaping @Sendable () -> String,
        sessionConfiguration: URLSessionConfiguration = .ephemeral
    ) {
        self.workspaceOrigin = WorkspaceOrigin(workspaceOrigin)
        self.accessTokenProvider = accessTokenProvider
        // No session-level delegate: `fetch(_:)` passes a fresh
        // `RedirectStripDelegate` per call via `session.data(for:delegate:)`
        // (the per-task delegate override), so the session itself stays
        // delegate-less and trivially `Sendable`.
        self.session = URLSession(configuration: sessionConfiguration)
        super.init()
    }

    public enum LoaderError: Error, Equatable {
        case httpError(status: Int)
        /// The rebased URL's scheme is not on §6.2's `SchemeAllowlist` (e.g.
        /// a page body containing an `<img src="crowi-ios://...">` or
        /// `javascript:`) — rejected here, at the SAME shared allowlist the
        /// `openURL` link interceptor consumes, so a custom scheme is
        /// inerted for images exactly as it is for taps, never a second,
        /// drifted check.
        case disallowedScheme
    }

    /// Rebase `relativeOrAbsolute` against `workspaceOrigin` (§6.1 step 1),
    /// fetch it with the same-origin-Bearer + redirect-strip rule applied,
    /// and return the raw response bytes (raster-decode-only, §6.1's
    /// SVG-DOM-never-executes rule: the caller hands these bytes to a raster
    /// image decoder, never a web/SVG-DOM context).
    public func fetch(_ relativeOrAbsolute: String) async throws -> Data {
        guard let resolved = URL(string: relativeOrAbsolute, relativeTo: workspaceOrigin.baseURL) else {
            throw URLError(.badURL)
        }
        // §6.2 — the SAME shared allowlist `WorkspacePageMarkdownView`'s
        // `openURL` interceptor consumes: an image whose (rebased) URL
        // carries a custom scheme (`crowi-ios://`, `javascript:`, …) is
        // rejected here, before any network I/O, rather than left to fail
        // implicitly (a non-`http(s)` URL handed to `URLSession` would
        // simply error out anyway, but that is an accident of `URLSession`'s
        // own behavior, not an explicit, testable guarantee).
        guard SchemeAllowlist.isAllowed(resolved) else {
            throw LoaderError.disallowedScheme
        }
        var request = URLRequest(url: resolved)
        if WorkspaceOrigin(resolved) == workspaceOrigin {
            request.setValue("Bearer \(accessTokenProvider())", forHTTPHeaderField: "Authorization")
        }
        let delegate = RedirectStripDelegate(workspaceOrigin: workspaceOrigin, accessTokenProvider: accessTokenProvider)
        let (data, response) = try await session.data(for: request, delegate: delegate)
        guard response.isSuccessfulHTTPResponse else {
            throw LoaderError.httpError(status: response.httpStatusCodeOrUnknown)
        }
        return data
    }
}

/// The `URLSessionTaskDelegate` that implements the §6.1 per-hop rule.
/// Isolated as its own type (rather than inline in `WorkspaceImageLoader`)
/// so `WorkspaceImageLoaderTests` can exercise it directly against
/// synthetic redirect chains without a real network round-trip.
final class RedirectStripDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let workspaceOrigin: WorkspaceOrigin
    private let accessTokenProvider: @Sendable () -> String

    init(workspaceOrigin: WorkspaceOrigin, accessTokenProvider: @escaping @Sendable () -> String) {
        self.workspaceOrigin = workspaceOrigin
        self.accessTokenProvider = accessTokenProvider
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let newURL = request.url else {
            completionHandler(request)
            return
        }
        var next = request
        if WorkspaceOrigin(newURL) == workspaceOrigin {
            // Same-origin redirect (e.g. the legacy `/files/<id>` →
            // `/api/v2/attachments/<id>` compat hop): PRESERVE the Bearer.
            next.setValue("Bearer \(accessTokenProvider())", forHTTPHeaderField: "Authorization")
        } else {
            // Origin changed: STRIP it — the token-exfiltration guard.
            next.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(next)
    }
}
