import Foundation

/// A link in a page body that belongs to this app rather than to the browser.
public enum WorkspaceInternalLink: Equatable, Sendable {
    case pagePath(String)
    /// Crowi's "copy link" writes the page's id, not its path, so most links
    /// pasted between pages arrive in this shape.
    case pageId(String)
}

/// Which links in a page body the app opens itself.
///
/// Mirrors the web's own `toInternalHref`: a link written as a FULL URL to
/// the workspace's origin is the same link as the relative one — the address
/// bar is where people copy links from — and following it into Safari drops
/// the reader, the session and the back stack for a page the app can show.
public enum WorkspaceLinkRouter {
    /// `nil` when the URL belongs to some other site.
    public static func internalLink(for url: URL, workspaceOrigin: URL) -> WorkspaceInternalLink? {
        guard isSameOrigin(url, as: workspaceOrigin) else { return nil }
        let path = url.path
        guard path.hasPrefix("/") else { return nil }
        return internalLink(forPath: path)
    }

    /// The destination for a link that is already workspace-relative.
    public static func internalLink(forPath path: String) -> WorkspaceInternalLink {
        let segments = path.split(separator: "/", omittingEmptySubsequences: true)
        if segments.count == 1, isObjectId(String(segments[0])) {
            return .pageId(String(segments[0]))
        }
        return .pagePath(path)
    }

    /// A 24-character hex string — a Mongo `ObjectId`, which is the only
    /// thing a single-segment path can be that is not a top-level page (the
    /// web's `isObjectId`, same rule).
    static func isObjectId(_ value: String) -> Bool {
        value.count == 24 && value.allSatisfy(\.isHexDigit)
    }

    /// Scheme, host and port, with the default port filled in — `https://a.b`
    /// and `https://a.b:443` are one origin, and a host differing only in
    /// case is the same host.
    static func isSameOrigin(_ url: URL, as origin: URL) -> Bool {
        guard let lhs = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let rhs = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let lhsScheme = lhs.scheme?.lowercased(),
              let rhsScheme = rhs.scheme?.lowercased(),
              let lhsHost = lhs.host?.lowercased(),
              let rhsHost = rhs.host?.lowercased()
        else { return false }
        return lhsScheme == rhsScheme && lhsHost == rhsHost && port(of: lhs) == port(of: rhs)
    }

    private static func port(of components: URLComponents) -> Int? {
        if let port = components.port { return port }
        switch components.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }
}
