import Foundation

/// Which wiki page, if any, a link inside an HTML artifact opens.
///
/// An artifact may link to wiki pages by path (`guide`, `../guide`,
/// `/team/guide`, with an optional `#fragment`), and nothing else. The rules
/// here are the server's and the web's own (the shared resolver in
/// `@crowi/api-contract`'s `artifact-link` / `artifact-navigation`), so a
/// link opens the same page on every client and a link the web refuses is
/// refused here too:
///
/// - The href must be a well-formed page reference: no scheme, no query, no
///   `//`, no backslash or control characters, every `%` a valid escape, and
///   each segment percent-decoded exactly once.
/// - A relative link resolves from the directory of the page holding the
///   artifact — `guide` from `/team/artifact` is `/team/guide` — never from
///   the artifact's own delivery URL.
/// - The result must be an ordinary wiki page: reserved system routes, the
///   bare-id redirector, user tabs and edit / raw addresses are refused,
///   because opening them on the artifact's behalf is not what a page link
///   means.
///
/// The fragment is parsed (it must be well-formed) but not returned: a page
/// opened in the reader starts at its top, as a Markdown link's does.
public enum ArtifactPageLink {
    /// The page path `rawHref` opens from the artifact on `sourcePagePath`,
    /// or `nil` when it is not a safe wiki page link.
    public static func resolve(sourcePagePath: String, rawHref: String) -> String? {
        guard isCanonicalPagePath(sourcePagePath),
            let link = parse(rawHref),
            let pagePath = resolvePath(link, sourcePagePath: sourcePagePath),
            classify(pagePath) == .page,
            safeHrefLength(pagePath: pagePath, fragment: link.fragment) <= maxLength
        else { return nil }
        return pagePath
    }

    static let maxLength = 4096

    // MARK: - Parsing

    struct ParsedLink: Equatable {
        let absolute: Bool
        /// Percent-decoded exactly once; `+` left as is, `.` / `..` kept.
        let segments: [String]
        let trailingSlash: Bool
        let fragment: String?
    }

    static func parse(_ rawHref: String) -> ParsedLink? {
        let length = rawHref.utf16.count
        guard length >= 1, length <= maxLength else { return nil }
        guard rawHref == rawHref.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        guard !rawHref.contains("\\"), !hasControlCharacter(rawHref) else { return nil }

        let rawPath: Substring
        let rawFragment: Substring?
        if let hash = rawHref.firstIndex(of: "#") {
            rawPath = rawHref[..<hash]
            rawFragment = rawHref[rawHref.index(after: hash)...]
        } else {
            rawPath = rawHref[...]
            rawFragment = nil
        }

        guard !rawPath.isEmpty, !rawPath.contains("//") else { return nil }

        let absolute = rawPath.hasPrefix("/")
        let trailingSlash = rawPath.hasSuffix("/")
        var rawSegments = rawPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if absolute { rawSegments.removeFirst() }
        if trailingSlash, !rawSegments.isEmpty { rawSegments.removeLast() }

        // `section:1` reads as a URL scheme; `./section:1` is how a page name with a colon is written.
        if !absolute, let first = rawSegments.first, looksLikeScheme(first) { return nil }
        guard !rawPath.contains("?") else { return nil }

        var segments: [String] = []
        for rawSegment in rawSegments {
            guard !rawSegment.isEmpty, let decoded = decodeOnce(rawSegment) else { return nil }
            guard !decoded.contains(where: { "/\\?#".contains($0) }), !hasControlCharacter(decoded) else { return nil }
            segments.append(decoded)
        }

        var fragment: String?
        if let rawFragment {
            guard !rawFragment.isEmpty, !rawFragment.contains("#"), let decoded = decodeOnce(String(rawFragment)) else { return nil }
            guard !decoded.contains("\\"), !decoded.contains("%"), !hasControlCharacter(decoded) else { return nil }
            fragment = decoded
        }

        return ParsedLink(absolute: absolute, segments: segments, trailingSlash: trailingSlash, fragment: fragment)
    }

    /// C0, DEL and C1 control characters.
    private static func hasControlCharacter(_ value: String) -> Bool {
        value.unicodeScalars.contains { $0.value <= 0x1F || (0x7F...0x9F).contains($0.value) }
    }

    private static func looksLikeScheme(_ segment: String) -> Bool {
        guard let colon = segment.firstIndex(of: ":") else { return false }
        let scheme = segment[..<colon]
        guard let first = scheme.unicodeScalars.first, isASCIILetter(first) else { return false }
        return scheme.unicodeScalars.allSatisfy { isASCIILetter($0) || ("0"..."9").contains($0) || "+.-".unicodeScalars.contains($0) }
    }

    private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
    }

    /// Decodes each run of `%HH` escapes exactly once. `nil` for a `%` that
    /// does not start a valid escape, or a run that is not valid UTF-8
    /// (overlong forms and encoded surrogates included).
    static func decodeOnce(_ raw: String) -> String? {
        let utf8 = Array(raw.utf8)
        var output: [UInt8] = []
        output.reserveCapacity(utf8.count)
        var run: [UInt8] = []
        var index = 0

        func flushRun() -> Bool {
            guard !run.isEmpty else { return true }
            let decoded = String(decoding: run, as: UTF8.self)
            // A lossy decode means the bytes were not valid UTF-8.
            guard Array(decoded.utf8) == run else { return false }
            output.append(contentsOf: run)
            run.removeAll(keepingCapacity: true)
            return true
        }

        while index < utf8.count {
            let byte = utf8[index]
            if byte == UInt8(ascii: "%") {
                guard index + 2 < utf8.count,
                    let high = hexValue(utf8[index + 1]), let low = hexValue(utf8[index + 2])
                else { return nil }
                run.append(high << 4 | low)
                index += 3
            } else {
                guard flushRun() else { return nil }
                output.append(byte)
                index += 1
            }
        }
        guard flushRun() else { return nil }
        return String(decoding: output, as: UTF8.self)
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
        default: nil
        }
    }

    // MARK: - Resolving

    /// Applies `.` / `..` against the source page's directory (absolute links
    /// need no base). `nil` for a relative link without a canonical base, or
    /// one that climbs above the root. `+` in a segment reads as a space, as
    /// it does everywhere a page path appears in a URL.
    static func resolvePath(_ link: ParsedLink, sourcePagePath: String?) -> String? {
        var stack: [String] = []
        if !link.absolute {
            guard let sourcePagePath, isCanonicalPagePath(sourcePagePath) else { return nil }
            stack = pageDirname(sourcePagePath).split(separator: "/").map(String.init)
        }
        for segment in link.segments {
            switch segment {
            case ".":
                continue
            case "..":
                guard stack.popLast() != nil else { return nil }
            default:
                stack.append(segment.replacingOccurrences(of: "+", with: " "))
            }
        }
        let keepsTrailingSlash = link.trailingSlash || link.segments.last == "." || link.segments.last == ".."
        return stack.isEmpty ? "/" : "/" + stack.joined(separator: "/") + (keepsTrailingSlash ? "/" : "")
    }

    /// `/crowi/rfc/0001` → `/crowi/rfc/`, `/foo/bar/` → `/foo/`, `/foo` → `/`.
    static func pageDirname(_ path: String) -> String {
        var trimmed = Substring(path)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        guard let slash = trimmed.lastIndex(of: "/"), slash != trimmed.startIndex else { return "/" }
        return String(trimmed[..<slash]) + "/"
    }

    // MARK: - Classifying

    enum Classification: Equatable {
        case page
        case reservedRoute
        case invalidPath
    }

    /// Whether `pagePath` has the shape of a stored page path: absolute,
    /// decoded (real spaces, no literal `+`), and nothing that would change
    /// meaning inside a URL.
    static func isCanonicalPagePath(_ pagePath: String) -> Bool {
        let length = pagePath.utf16.count
        guard length > 0, length <= maxLength else { return false }
        guard pagePath.hasPrefix("/"), !pagePath.contains("//"), !hasControlCharacter(pagePath) else { return false }
        guard !pagePath.contains(where: { "\\?#+".contains($0) }) else { return false }
        return !pagePath.split(separator: "/").contains { segment in segment.allSatisfy { $0 == "." } }
    }

    private static let reservedTopLevelNames: Set<String> = ["installer", "register", "login", "logout", "admin", "me", "files", "trash", "paste", "comments", "api"]
    private static let appRouteFirstSegments: Set<String> = ["activate", "confirm-email", "forgot-password", "reset-password", "invite", "oauth"]
    private static let backendOrStaticFirstSegments: Set<String> = ["collab", "presence", "notifications", "socket.io", "logo", "images", "favicon.ico"]
    private static let userTabNames = ["bookmarks", "comments", "activities", "pages", "recent-create", "recent-edit"]
    private static let whitespaceAroundSlash = try! NSRegularExpression(pattern: "\\s+/\\s+")

    static func classify(_ pagePath: String) -> Classification {
        guard isCanonicalPagePath(pagePath) else { return .invalidPath }
        let lower = asciiLowercased(pagePath)
        let segments = lower.split(separator: "/").map(String.init)
        guard let first = segments.first else { return .page }

        if reservedTopLevelNames.contains(first) { return .reservedRoute }
        if appRouteFirstSegments.contains(first) || backendOrStaticFirstSegments.contains(first) { return .reservedRoute }
        if first.hasPrefix("_") || first.hasPrefix(".") || first == "-" { return .reservedRoute }

        if first == "user" {
            if segments.count == 1 { return .reservedRoute }
            if segments.count >= 3, userTabNames.contains(where: { segments[2].hasPrefix($0) }) { return .reservedRoute }
        }

        // The id redirector opens whatever page has that id, so a bare id is never a page link.
        if segments.count == 1, isObjectId(first) { return .reservedRoute }

        if lower.contains(where: { "^$*".contains($0) }) { return .reservedRoute }
        if whitespaceAroundSlash.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) != nil { return .reservedRoute }
        var withoutTrailingSlash = Substring(lower)
        while withoutTrailingSlash.hasSuffix("/") { withoutTrailingSlash = withoutTrailingSlash.dropLast() }
        if withoutTrailingSlash.hasSuffix("/edit") || withoutTrailingSlash.hasSuffix(".md") { return .reservedRoute }
        return .page
    }

    private static func asciiLowercased(_ value: String) -> String {
        String(String.UnicodeScalarView(value.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 }))
    }

    private static func isObjectId(_ value: String) -> Bool {
        value.utf8.count == 24 && value.utf8.allSatisfy { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }
    }

    // MARK: - Length bound

    /// The length of the href the web would build for this target. The web
    /// refuses a target whose href exceeds the link limit even when the
    /// written link was short (percent-encoding multiplies non-ASCII), so the
    /// same bound applies here.
    static func safeHrefLength(pagePath: String, fragment: String?) -> Int {
        let path = pagePath
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { encodeURIComponent(String($0)).replacingOccurrences(of: "%20", with: " ") }
            .joined(separator: "/")
            .replacingOccurrences(of: " ", with: "+")
        let fragmentPart = fragment.map { "#" + encodeURIComponent($0) } ?? ""
        return (path + fragmentPart).utf16.count
    }

    private static let uriComponentUnreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    private static func encodeURIComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: uriComponentUnreserved) ?? value
    }
}
