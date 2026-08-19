import Foundation

/// Resolves a relative link target against the page that contains it.
///
/// A browser does this for the web for free — `./sibling` in an `<a href>`
/// resolves against the document's own URL. A native reader has no document
/// URL, so a relative target arrived here as if it were absolute and the
/// reader asked the server for a page called `./sibling`.
///
/// A Swift port of the shared `resolveWikiPath` / `isExternalRef` contract
/// (`feature-relative-wiki-link-resolution`), including the parts that look
/// arbitrary until the reason is stated. Markdown links are the client's half
/// of that spec; wiki links (`[[./x]]`) are resolved server-side and arrive
/// already absolute.
///
/// Everything is string work on slash-separated segments. Deliberately NOT
/// `URL` or percent-decoding: Crowi paths are real-space and `+` means a
/// literal plus, which URL semantics would read as a space.
public enum WikiPathResolver {
    /// Whether `ref` points outside the wiki and must be left to the system.
    ///
    /// Scheme detection follows RFC-3986's grammar rather than "contains a
    /// colon", which would wrongly reject the perfectly ordinary path
    /// `a/b:c`.
    ///
    /// Consequence worth knowing: a BARE ref whose first segment matches the
    /// grammar — `mailto:x`, but equally a page named `Q1:plan` — reads as
    /// external. Such a page is still reachable by writing `./Q1:plan`, which
    /// starts with a dot and so can never match.
    public static func isExternalRef(_ ref: String) -> Bool {
        if ref.isEmpty { return true }
        if ref.hasPrefix("#") { return true }
        if ref.hasPrefix("//") { return true }
        return ref.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil
    }

    /// The absolute page path `ref` names when written on `sourcePath`, or
    /// `nil` when `ref` leaves the wiki.
    public static func resolve(sourcePath: String, ref: String) -> String? {
        if isExternalRef(ref) { return nil }
        if ref.hasPrefix("/") { return ref }

        var stack = directorySegments(of: sourcePath)
        let refSegments = ref.components(separatedBy: "/")
        for segment in refSegments {
            switch segment {
            case ".", "":
                continue
            case "..":
                // Climbing past the root stays at the root rather than
                // producing a path with nowhere to be.
                if !stack.isEmpty { stack.removeLast() }
            default:
                stack.append(segment)
            }
        }

        // A ref ENDING in `.`, `..` or a slash names a directory, and in Crowi
        // a directory is a portal page — whose stored path carries the
        // trailing slash. A ref ending in an ordinary segment names a leaf.
        let endsAtDirectory = refSegments.last.map { $0 == "." || $0 == ".." || $0.isEmpty } ?? true
        let joined = "/" + stack.joined(separator: "/")
        if endsAtDirectory {
            return joined.hasSuffix("/") ? joined : joined + "/"
        }
        return joined
    }

    /// The directory `sourcePath` sits in.
    ///
    /// A portal page's own path ends in a slash and IS its directory; taking
    /// the parent of `/X/logs/` would land a sibling reference one level too
    /// high.
    private static func directorySegments(of sourcePath: String) -> [String] {
        let segments = sourcePath.components(separatedBy: "/").filter { !$0.isEmpty }
        if sourcePath.hasSuffix("/") { return segments }
        return segments.isEmpty ? [] : Array(segments.dropLast())
    }
}
