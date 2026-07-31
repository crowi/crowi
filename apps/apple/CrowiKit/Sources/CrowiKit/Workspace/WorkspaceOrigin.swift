import Foundation

/// RFC-0016 §3 — `scheme://host:port` only, the **display** identity of a
/// workspace, the subject of the HTTPS gate, and the base every relative URL
/// (attachment images, avatars, `/files/<id>`) is rebased against (§6.1).
///
/// Relocated here (Phase 1) from `Images/WorkspaceImageLoader.swift`, where it
/// was defined as `URLOrigin` during the Phase 0 gate C spike — this is now
/// the **single canonical origin newtype** the whole app shares (§3's "two
/// distinct newtypes" requirement); nothing else should define a second
/// scheme+host+port comparison type. `WorkspaceImageLoader` imports this one.
///
/// `scheme://host:port` equality, ignoring path/query/fragment — the exact
/// comparison §6.1 specifies ("the resolved URL origin **exactly equals**
/// the active workspace's base-URL origin"). `URL`'s own `==` compares the
/// whole string, which is both too strict (a trailing slash difference) and
/// too loose (it doesn't normalize a default port), so this is a dedicated,
/// minimal value type rather than reusing `URL` equality.
public struct WorkspaceOrigin: Equatable, Sendable, Hashable {
    public let scheme: String
    public let host: String
    /// Normalized: `nil` port is treated as the scheme's default so
    /// `https://host` and `https://host:443` compare equal.
    public let port: Int

    public init(_ url: URL) {
        self.scheme = (url.scheme ?? "").lowercased()
        self.host = (url.host ?? "").lowercased()
        self.port = url.port ?? WorkspaceOrigin.defaultPort(forScheme: scheme)
    }

    /// The `baseURL` other resolvers rebase relative paths against —
    /// `scheme://host:port` with no path, matching `workspaceOrigin` (§3).
    public var baseURL: URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if port != WorkspaceOrigin.defaultPort(forScheme: scheme) {
            components.port = port
        }
        // swiftlint:disable:next force_unwrapping — scheme+host is always a valid URL.
        return components.url!
    }

    /// The BROWSER url of a wiki page on this workspace — what the reader's
    /// Share and Copy Link actions hand out (feature-ios-visual-redesign
    /// Phase 3). Not an API url: `<origin>/<page path>` is what the web app
    /// serves and what a colleague receiving the link expects to open.
    ///
    /// Built through `URLComponents` so the path is percent-encoded on the way
    /// out, which is not optional in this product: Crowi paths are routinely
    /// non-ASCII (`/user/sotarok/日報/2026/05/23`), and pasting a raw one into
    /// `URL(string:)` yields `nil`.
    public func pageURL(forPath path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if port != WorkspaceOrigin.defaultPort(forScheme: scheme) {
            components.port = port
        }
        components.path = path.hasPrefix("/") ? path : "/" + path
        return components.url
    }

    /// Is this origin's scheme `https`? The §14 / §3 HTTPS gate reads this.
    public var isHTTPS: Bool {
        scheme == "https"
    }

    /// `true` for the narrow local/dev exemption §3/§14 allow cleartext
    /// `http` on: `localhost`, `127.0.0.1`, or any `*.local` host. Anything
    /// else on `http` is rejected by the add-workspace HTTPS gate.
    public var isExemptLocalHost: Bool {
        host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local")
    }

    private static func defaultPort(forScheme scheme: String) -> Int {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return 0
        }
    }
}

extension WorkspaceOrigin {
    /// Normalize free-form user input (§3 add-flow step 1) into a
    /// `WorkspaceOrigin`. A scheme-less input (`wiki.example.com`) defaults to
    /// `https`; an explicit `http://`/`https://` is preserved as typed so the
    /// HTTPS gate downstream can judge it. Returns `nil` for input that
    /// cannot be parsed as a URL with a host at all (e.g. empty string).
    public static func normalize(userInput raw: String) -> WorkspaceOrigin? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate), url.host != nil else { return nil }
        return WorkspaceOrigin(url)
    }
}
