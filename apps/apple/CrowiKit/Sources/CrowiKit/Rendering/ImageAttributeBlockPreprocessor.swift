import Foundation

/// `docs/rfcs/0015-image-display-attributes.md` §5/§6.2 defines a Pandoc-style
/// image attribute block — `![alt](url){width=60% align=center}` — that the
/// web renderer's core transform parses server-side and turns into actual
/// layout (`data-crowi-image-*` props / a `<figure>` wrapper). Native
/// rendering has no equivalent transform yet: this type is a **strip-only**
/// degrade, not an implementation of RFC-0015. It never reads or honors the
/// attribute VALUES — no width/height/align/float is ever applied — that
/// remains a future phase's job.
///
/// Left unhandled, cmark-gfm (the parser swift-markdown-ui uses) parses
/// `![alt](url){width=500px}` as an image inline node immediately followed by
/// a literal text node holding `{width=500px}`, which swift-markdown-ui then
/// renders as visible garbled text right next to the image
/// (`WorkspaceMarkdownInlineImageProvider`'s doc comment walks through the
/// underlying parse-shape mechanics). This preprocessor removes ONLY the
/// immediately-adjacent `{...}` block, turning the source back into a plain
/// `![alt](url)` before it ever reaches swift-markdown-ui — the display
/// degrades to "image renders, attributes silently dropped" instead of
/// "image renders, followed by garbled literal braces".
///
/// Stripping this way also has a structural side effect that happens to fix a
/// SECOND, independent bug: swift-markdown-ui picks its image-rendering
/// environment key (`\.imageProvider` vs `\.inlineImageProvider`) based on
/// whether the containing paragraph is JUST the image or an image sharing a
/// line with other inline content. An attribute block is exactly "other
/// inline content" — removing it, when it was the paragraph's only such
/// content, lets a previously-inline attributed image fall back to the block
/// image path (`WorkspaceMarkdownImageProvider`), which is the path that
/// enforces a hard width cap.
public enum ImageAttributeBlockPreprocessor {
    /// A fenced code block, tilde code block, or inline code span — content
    /// matched here is passed through completely untouched. This mirrors
    /// only the CODE half of `WikiLinkMentionPreprocessor.protectedSpanRegex`'s
    /// exclusion technique (cursor-based skip over protected regions), not
    /// its link/image half: that preprocessor treats an entire
    /// `![alt](url)` as an opaque protected span because it must never touch
    /// mention-like text inside a link/image's own label or destination. This
    /// type's whole job is the opposite — to look at what immediately follows
    /// an image — so it must NOT treat the image as opaque.
    private static let protectedCodeRegex = try! NSRegularExpression(
        pattern: "```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]+`"
    )

    /// `![alt](url)` immediately followed by RFC-0015 §5's permitted gap —
    /// zero or more ASCII spaces/tabs, OR one soft line break plus
    /// spaces/tabs — then a `{...}` block. The block content is bounded to
    /// 1024 chars and excludes `{`/`}`/newline, so the regex either finds a
    /// closing `}` within that bound or does not match at all — never a
    /// catastrophic backtracking scan (mirrors RFC-0015 §6.2's bounded-scanner
    /// requirement). Requiring the `{` to be immediately adjacent (only
    /// whitespace/one soft break in between) also means more-than-one blank
    /// line, or any non-whitespace text, before `{` naturally fails to match
    /// at all — per §5, that text is left alone.
    private static let imageWithAttrsRegex = try! NSRegularExpression(
        pattern: "(!\\[[^\\[\\]\\n]*\\]\\([^()\\n]*\\))((?:[ \\t]*\\n)?[ \\t]*)(\\{[^{}\\n]{0,1024}\\})"
    )

    /// RFC-0015 §5's four recognized keys.
    private static let recognizedKeys: Set<Substring> = ["width", "height", "align", "float"]

    /// Strip every immediately-adjacent RFC-0015 attribute block from `body`,
    /// outside of code spans/blocks. The image itself, and everything else in
    /// the document — including a `{...}` block that isn't attribute-shaped,
    /// or one that doesn't immediately follow an image — is left
    /// byte-for-byte unchanged.
    public static func strip(_ body: String) -> String {
        let nsBody = body as NSString
        let fullRange = NSRange(location: 0, length: nsBody.length)
        var result = ""
        var cursor = 0
        for match in protectedCodeRegex.matches(in: body, range: fullRange) {
            if match.range.location > cursor {
                result += stripProse(nsBody.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            }
            result += nsBody.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        if cursor < nsBody.length {
            result += stripProse(nsBody.substring(with: NSRange(location: cursor, length: nsBody.length - cursor)))
        }
        return result
    }

    private static func stripProse(_ text: String) -> String {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        var result = ""
        var cursor = 0
        for match in imageWithAttrsRegex.matches(in: text, range: fullRange) {
            guard match.numberOfRanges > 3 else { continue }
            let attrsContent = nsText.substring(with: match.range(at: 3))
            guard looksLikeAttributeBlock(attrsContent) else { continue }

            if match.range.location > cursor {
                result += nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            }
            // Keep the image (group 1); drop the whitespace gap (group 2)
            // and the attribute block (group 3) entirely.
            result += nsText.substring(with: match.range(at: 1))
            cursor = match.range.location + match.range.length
        }
        if cursor < nsText.length {
            result += nsText.substring(with: NSRange(location: cursor, length: nsText.length - cursor))
        }
        return result
    }

    /// `attrsContent` includes the surrounding `{`/`}`. This is a syntactic
    /// SHAPE check only, not a value re-validation (e.g. width's `%`/`px`
    /// unit/range rules from RFC-0015 §5/§9 are NOT enforced here — applying
    /// attribute values is out of scope for this strip-only preprocessor).
    /// Every whitespace-separated token must look like `key=value`, and at
    /// least one key must be one of the four RFC-0015 keys — this keeps
    /// braces that merely happen to sit right after an image, but aren't
    /// attribute-shaped at all, from being silently eaten. Unrecognized keys
    /// alongside a recognized one are tolerated (RFC-0015 §5: "unknown keys
    /// are ignored rather than treated as parse errors").
    private static func looksLikeAttributeBlock(_ attrsContent: String) -> Bool {
        let interior = attrsContent.dropFirst().dropLast()
        let tokens = interior.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard !tokens.isEmpty else { return false }

        var sawRecognizedKey = false
        for token in tokens {
            guard let equalsIndex = token.firstIndex(of: "="), equalsIndex > token.startIndex else { return false }
            let key = token[token.startIndex..<equalsIndex]
            let value = token[token.index(after: equalsIndex)...]
            guard !value.isEmpty else { return false }
            if recognizedKeys.contains(key) {
                sawRecognizedKey = true
            }
        }
        return sawRecognizedKey
    }
}
