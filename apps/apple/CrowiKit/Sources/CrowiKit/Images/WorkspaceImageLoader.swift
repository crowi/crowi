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
    private let workspaceOrigin: URLOrigin
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
        self.workspaceOrigin = URLOrigin(workspaceOrigin)
        self.accessTokenProvider = accessTokenProvider
        // No session-level delegate: `fetch(_:)` passes a fresh
        // `RedirectStripDelegate` per call via `session.data(for:delegate:)`
        // (the per-task delegate override), so the session itself stays
        // delegate-less and trivially `Sendable`.
        self.session = URLSession(configuration: sessionConfiguration)
        super.init()
    }

    public enum LoaderError: Error {
        case httpError(status: Int)
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
        var request = URLRequest(url: resolved)
        if URLOrigin(resolved) == workspaceOrigin {
            request.setValue("Bearer \(accessTokenProvider())", forHTTPHeaderField: "Authorization")
        }
        let delegate = RedirectStripDelegate(workspaceOrigin: workspaceOrigin, accessTokenProvider: accessTokenProvider)
        let (data, response) = try await session.data(for: request, delegate: delegate)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw LoaderError.httpError(status: status)
        }
        return data
    }
}

/// The `URLSessionTaskDelegate` that implements the §6.1 per-hop rule.
/// Isolated as its own type (rather than inline in `WorkspaceImageLoader`)
/// so `WorkspaceImageLoaderTests` can exercise it directly against
/// synthetic redirect chains without a real network round-trip.
final class RedirectStripDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let workspaceOrigin: URLOrigin
    private let accessTokenProvider: @Sendable () -> String

    init(workspaceOrigin: URLOrigin, accessTokenProvider: @escaping @Sendable () -> String) {
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
        if URLOrigin(newURL) == workspaceOrigin {
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

/// `scheme://host:port` equality, ignoring path/query/fragment — the exact
/// comparison §6.1 specifies ("the resolved URL origin **exactly equals**
/// the active workspace's base-URL origin"). `URL`'s own `==` compares the
/// whole string, which is both too strict (a trailing slash difference)
/// and too loose (it doesn't normalize a default port), so this is a
/// dedicated, minimal value type rather than reusing `URL` equality.
public struct URLOrigin: Equatable, Sendable {
    let scheme: String
    let host: String
    /// Normalized: `nil` port is treated as the scheme's default so
    /// `https://host` and `https://host:443` compare equal.
    let port: Int

    init(_ url: URL) {
        self.scheme = (url.scheme ?? "").lowercased()
        self.host = (url.host ?? "").lowercased()
        self.port = url.port ?? URLOrigin.defaultPort(forScheme: scheme)
    }

    /// The `baseURL` other resolvers rebase relative paths against —
    /// `scheme://host:port` with no path, matching `workspaceOrigin` (§3).
    var baseURL: URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if port != URLOrigin.defaultPort(forScheme: scheme) {
            components.port = port
        }
        // swiftlint:disable:next force_unwrapping — scheme+host is always a valid URL.
        return components.url!
    }

    private static func defaultPort(forScheme scheme: String) -> Int {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return 0
        }
    }
}
