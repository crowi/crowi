import Foundation

/// RFC-0016 §6/§15 — rewrites raw `[[target]]` / `[[target|display]]` /
/// `@username` occurrences in a page's raw `revision.body` into ordinary
/// CommonMark links against two private pseudo-schemes, BEFORE handing the
/// body to swift-markdown-ui. Native rendering never consumes the server's
/// `renderedAst` (§6), so this is the app's own from-scratch mirror of the
/// two server-side transforms — mirroring their regexes byte-for-byte is
/// what keeps behavior consistent with the web app without reading its AST:
///   - `WIKILINK_RE` — `packages/api/src/renderer/core/wikilinks.ts:31`
///   - `MENTION_RE` — `packages/api/src/renderer/core/mentions.ts:24`
///
/// The exact rewriting mechanism (private pseudo-scheme + `openURL`
/// interception) is an implementer judgment call the spec leaves open,
/// under two hard constraints this type honors: never consume `renderedAst`,
/// and never fork swift-markdown-ui (the rewrite happens on the raw string,
/// before it ever reaches the renderer — `WorkspacePageMarkdownView` composes
/// the renderer's already-exposed `\.openURL` seam to resolve the result,
/// gate C's Phase 0 finding).
public enum WikiLinkMentionPreprocessor {
    /// Never a real network scheme — inerted by `SchemeAllowlist` like any
    /// other custom scheme UNLESS intercepted first by
    /// `WorkspacePageMarkdownView`'s `openURL` handler.
    public static let wikiLinkScheme = "crowi-wikilink"
    public static let mentionScheme = "crowi-mention"

    /// What a resolved pseudo-scheme (or ordinary) URL should do —
    /// `WorkspacePageMarkdownView`'s `openURL` interceptor classifies every
    /// tapped link through this single entry point.
    public enum InterceptedLink: Equatable {
        /// A `[[…]]` wikilink whose target started with `/` (the only
        /// navigable shape, mirroring `isValidTarget`, `wikilinks.ts:119-122`).
        case wikiLinkTarget(String)
        /// An `@username` mention — always navigable (existence is never
        /// checked client-side, §6/§15).
        case mentionUsername(String)
        /// Anything else — an ordinary link the caller must still run
        /// through `SchemeAllowlist` itself.
        case external(URL)
    }

    public static func classify(_ url: URL) -> InterceptedLink {
        if let target = wikiLinkTarget(from: url) {
            return .wikiLinkTarget(target)
        }
        if let username = mentionUsername(from: url) {
            return .mentionUsername(username)
        }
        return .external(url)
    }

    // MARK: - Rewriting

    /// Mirrors `WIKILINK_RE` byte-for-byte: `[[` + 1-256 chars excluding
    /// `[`, `]`, newline + `]]`.
    private static let wikiLinkRegex = try! NSRegularExpression(pattern: "\\[\\[([^\\[\\]\\n]{1,256})\\]\\]")

    /// Mirrors `MENTION_RE` byte-for-byte: `(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,64})`.
    private static let mentionRegex = try! NSRegularExpression(pattern: "(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,64})")

    /// A fenced code block (```` ``` ```` / `~~~`, non-greedy to the next
    /// matching triple), an inline `` `code` `` span, OR an existing
    /// CommonMark inline link/image (`[label](destination)` /
    /// `![alt](destination)`) — content matched here is passed through
    /// completely untouched. The code-span half mirrors the server
    /// transforms' `code`/`inlineCode` AST-node skip (`wikilinks.ts:37`,
    /// `mentions.ts:30`); the link/image half mirrors `mentions.ts`'s
    /// `insideLink` skip (`walk(node, isLinkNow)`, `mentions.ts:29-33`) —
    /// server-side, a `link` node's `url`/label text is never re-scanned by
    /// `MENTION_RE`, so e.g. `[the repo](https://github.com/@bob/crowi)`
    /// must never have its destination's `@bob` rewritten into a second,
    /// illegally-nested link (which would corrupt the ORIGINAL link's
    /// syntax, not merely leave a mention un-linked). Operating on the raw
    /// string rather than a parsed AST means there is no real "inside a
    /// link" boundary to check here, so both the label and the destination
    /// of an already-written link are treated as one protected span — a
    /// lightweight heuristic (no nested parens/brackets support), not a full
    /// CommonMark block parser, adequate for a read-only native renderer.
    private static let protectedSpanRegex = try! NSRegularExpression(
        pattern: "```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]+`|!?\\[[^\\[\\]\\n]*\\]\\([^()\\n]*\\)"
    )

    /// Rewrite every wikilink/mention occurrence in `body` OUTSIDE a
    /// protected code span into a CommonMark link against the pseudo-schemes
    /// above.
    public static func preprocess(_ body: String) -> String {
        let nsBody = body as NSString
        let fullRange = NSRange(location: 0, length: nsBody.length)
        var result = ""
        var cursor = 0
        for match in protectedSpanRegex.matches(in: body, range: fullRange) {
            if match.range.location > cursor {
                result += transformProse(nsBody.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            }
            result += nsBody.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        if cursor < nsBody.length {
            result += transformProse(nsBody.substring(with: NSRange(location: cursor, length: nsBody.length - cursor)))
        }
        return result
    }

    private static func transformProse(_ text: String) -> String {
        replaceMentions(in: replaceWikiLinks(in: text))
    }

    private static func replaceWikiLinks(in text: String) -> String {
        let nsText = text as NSString
        var result = ""
        var cursor = 0
        for match in wikiLinkRegex.matches(in: text, range: NSRange(location: 0, length: nsText.length)) {
            guard match.numberOfRanges > 1 else { continue }
            if match.range.location > cursor {
                result += nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            }
            let raw = nsText.substring(with: match.range(at: 1))
            let fallback = nsText.substring(with: match.range)
            result += markdownLink(forWikiLinkRaw: raw, fallback: fallback)
            cursor = match.range.location + match.range.length
        }
        if cursor < nsText.length {
            result += nsText.substring(with: NSRange(location: cursor, length: nsText.length - cursor))
        }
        return result
    }

    /// Mirrors `parseWikiLink` (`wikilinks.ts:84-95`): split on the first
    /// `|` into `target`/`displayText`, both trimmed.
    private static func markdownLink(forWikiLinkRaw raw: String, fallback: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let target: String
        let display: String
        if let pipeIndex = trimmed.firstIndex(of: "|") {
            target = String(trimmed[trimmed.startIndex..<pipeIndex]).trimmingCharacters(in: .whitespaces)
            display = String(trimmed[trimmed.index(after: pipeIndex)...]).trimmingCharacters(in: .whitespaces)
        } else {
            target = trimmed
            display = trimmed
        }
        // Mirrors `isValidTarget` (`wikilinks.ts:119-122`): only an
        // absolute-path target is navigable. Anything else (a bare page
        // name, an external URL, `javascript:`, …) is left completely
        // untouched (the original `[[…]]` text, brackets included) — never
        // turned into a link at all. This is stricter than the web's dimmed
        // `wikilink-broken` `#`-href link, which native has no "visually
        // distinct but inert" equivalent for, and introduces no new
        // interpretation risk versus leaving the raw text alone.
        guard target.hasPrefix("/"), let encodedTarget = target.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            return fallback
        }
        return "[\(escapeLinkText(display))](\(wikiLinkScheme):\(encodedTarget))"
    }

    private static func replaceMentions(in text: String) -> String {
        let nsText = text as NSString
        var result = ""
        var cursor = 0
        for match in mentionRegex.matches(in: text, range: NSRange(location: 0, length: nsText.length)) {
            guard match.numberOfRanges > 2 else { continue }
            if match.range.location > cursor {
                result += nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            }
            let prefixRange = match.range(at: 1)
            if prefixRange.length > 0 {
                result += nsText.substring(with: prefixRange)
            }
            let username = nsText.substring(with: match.range(at: 2))
            result += "[@\(username)](\(mentionScheme):\(username))"
            cursor = match.range.location + match.range.length
        }
        if cursor < nsText.length {
            result += nsText.substring(with: NSRange(location: cursor, length: nsText.length - cursor))
        }
        return result
    }

    /// `]`/`[`/`\` would otherwise break `[display](url)` CommonMark link
    /// syntax — escape them in the display text we generate.
    private static func escapeLinkText(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    // MARK: - Decoding (the `openURL` interception side)

    private static func wikiLinkTarget(from url: URL) -> String? {
        let prefix = "\(wikiLinkScheme):"
        guard url.absoluteString.hasPrefix(prefix) else { return nil }
        let encoded = String(url.absoluteString.dropFirst(prefix.count))
        return encoded.removingPercentEncoding
    }

    private static func mentionUsername(from url: URL) -> String? {
        let prefix = "\(mentionScheme):"
        guard url.absoluteString.hasPrefix(prefix) else { return nil }
        return String(url.absoluteString.dropFirst(prefix.count)).removingPercentEncoding
    }
}
