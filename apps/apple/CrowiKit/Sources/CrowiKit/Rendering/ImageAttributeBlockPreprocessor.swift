import Foundation

/// `docs/rfcs/0015-image-display-attributes.md` §5/§6.2 defines a Pandoc-style
/// image attribute block — `![alt](url){width=60% align=center}` — that the
/// web renderer's core transform parses server-side and turns into actual
/// layout (`data-crowi-image-*` props / a `<figure>` wrapper).
///
/// Native rendering consumes the block in two steps, both here:
///   1. **Strip** — remove the immediately-adjacent `{...}` block so it never
///      reaches swift-markdown-ui as literal garbled text (the original,
///      Phase-2 behavior: left unhandled, cmark-gfm parses
///      `![alt](url){width=500px}` as an image inline node followed by a
///      literal text node holding `{width=500px}`).
///   2. **Carry** (`feature-ios-phase3-notifications-extensions` — the
///      "future phase" the strip-only version's doc comment deferred to) —
///      parse the block through `ImageDisplayAttributes.parse` (the
///      server-identical DROP validation) and, when anything valid survives,
///      rewrite the image's destination to carry it in the
///      `#crowi-image-attrs:` fragment side-channel both image providers
///      detach and apply (`ImageDisplayAttributes.extract(from:)`).
///
/// `stripAndCarry(_:)` is what `WorkspacePageMarkdownView` calls; `strip(_:)`
/// remains the carry-less variant (identical block *removal* semantics —
/// callers that must never see the side-channel). Either way, a block whose
/// every value fails validation is still STRIPPED (shape-gated by
/// `looksLikeAttributeBlock`) — only the *application* is skipped, mirroring
/// the phase pin "値が invalid でも block の strip 自体は従来どおり行う".
///
/// Stripping also has a structural side effect that fixes a SECOND,
/// independent bug: swift-markdown-ui picks its image-rendering environment
/// key (`\.imageProvider` vs `\.inlineImageProvider`) based on whether the
/// containing paragraph is JUST the image or an image sharing a line with
/// other inline content. An attribute block is exactly "other inline
/// content" — removing it, when it was the paragraph's only such content,
/// lets a previously-inline attributed image fall back to the block image
/// path (`WorkspaceMarkdownImageProvider`), which is the path that enforces
/// a hard width cap — and, since this phase, the path that applies
/// width/align/float.
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

    /// `![alt](destination)` immediately followed by RFC-0015 §5's permitted
    /// gap — zero or more ASCII spaces/tabs, OR one soft line break plus
    /// spaces/tabs — then a `{...}` block. The block content is bounded to
    /// 1024 chars and excludes `{`/`}`/newline, so the regex either finds a
    /// closing `}` within that bound or does not match at all — never a
    /// catastrophic backtracking scan (mirrors RFC-0015 §6.2's bounded-scanner
    /// requirement). Requiring the `{` to be immediately adjacent (only
    /// whitespace/one soft break in between) also means more-than-one blank
    /// line, or any non-whitespace text, before `{` naturally fails to match
    /// at all — per §5, that text is left alone.
    ///
    /// The image is captured in three pieces (`![alt](` / destination / `)`)
    /// so the carry step can rewrite ONLY the destination; `strip` re-joins
    /// them verbatim.
    private static let imageWithAttrsRegex = try! NSRegularExpression(
        pattern: "(!\\[[^\\[\\]\\n]*\\]\\()([^()\\n]*)(\\))((?:[ \\t]*\\n)?[ \\t]*)(\\{[^{}\\n]{0,1024}\\})"
    )

    /// RFC-0015 §5's four recognized keys. Matched case-INsensitively — the
    /// server's `parseAttrBody` lowercases every key before its allowlist
    /// switch (`image-attrs.ts` — `key.toLowerCase()`), so `{WIDTH=60%}` is
    /// exactly as much an attribute block as `{width=60%}`;
    /// `ImageDisplayAttributes.parse` lowercases identically on the
    /// value-application side. (Values stay case-sensitive there, like the
    /// server's `Set.has` — but that is a parse concern, not a shape one.)
    private static let recognizedKeys: Set<String> = ["width", "height", "align", "float"]

    /// Strip every immediately-adjacent RFC-0015 attribute block from `body`,
    /// outside of code spans/blocks, WITHOUT carrying any value — the image
    /// itself, and everything else in the document — including a `{...}`
    /// block that isn't attribute-shaped, or one that doesn't immediately
    /// follow an image — is left byte-for-byte unchanged.
    public static func strip(_ body: String) -> String {
        process(body, carry: false)
    }

    /// `strip` plus the RFC-0015 value carry: each stripped block is parsed
    /// through the server-identical DROP validation and, when at least one
    /// valid value survives, the image destination gains the
    /// `#crowi-image-attrs:` side-channel fragment
    /// (`ImageDisplayAttributes.fragmentValue`) for the image providers to
    /// detach and apply. Destinations where a fragment cannot be attached
    /// safely (already carrying a `#`, `<angle-bracket>` form, empty) still
    /// get the block stripped — the attributes just go unapplied.
    public static func stripAndCarry(_ body: String) -> String {
        process(body, carry: true)
    }

    private static func process(_ body: String, carry: Bool) -> String {
        let nsBody = body as NSString
        let fullRange = NSRange(location: 0, length: nsBody.length)
        var result = ""
        var cursor = 0
        for match in protectedCodeRegex.matches(in: body, range: fullRange) {
            if match.range.location > cursor {
                result += processProse(nsBody.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), carry: carry)
            }
            result += nsBody.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        if cursor < nsBody.length {
            result += processProse(nsBody.substring(with: NSRange(location: cursor, length: nsBody.length - cursor)), carry: carry)
        }
        return result
    }

    private static func processProse(_ text: String, carry: Bool) -> String {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        var result = ""
        var cursor = 0
        for match in imageWithAttrsRegex.matches(in: text, range: fullRange) {
            guard match.numberOfRanges > 5 else { continue }
            let attrsContent = nsText.substring(with: match.range(at: 5))
            guard looksLikeAttributeBlock(attrsContent) else { continue }

            if match.range.location > cursor {
                result += nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            }
            // Keep the image (groups 1-3, with the destination possibly
            // rewritten to carry the validated values); drop the whitespace
            // gap (group 4) and the attribute block (group 5) entirely.
            var destination = nsText.substring(with: match.range(at: 2))
            if carry {
                let interior = String(attrsContent.dropFirst().dropLast())
                let attrs = ImageDisplayAttributes.parse(attributeBlockInterior: interior)
                if let fragment = attrs.fragmentValue, let carried = carriedDestination(destination, fragment: fragment) {
                    destination = carried
                }
            }
            result += nsText.substring(with: match.range(at: 1)) + destination + nsText.substring(with: match.range(at: 3))
            cursor = match.range.location + match.range.length
        }
        if cursor < nsText.length {
            result += nsText.substring(with: NSRange(location: cursor, length: nsText.length - cursor))
        }
        return result
    }

    /// Appends the side-channel fragment to the URL half of a CommonMark
    /// image destination, or returns `nil` when it cannot be done safely
    /// (attributes then simply go unapplied — the strip already happened):
    ///   - a destination already containing `#` is never touched, preserving
    ///     the byte-identity invariant (the providers only ever REMOVE the
    ///     exact marker fragment they find, so a URL that already had a
    ///     fragment must not gain a second one);
    ///   - `<angle-bracket>` destinations and empty destinations are skipped
    ///     (rare enough that supporting them isn't worth the parsing risk);
    ///   - a `url "title"` destination gets the fragment on the URL token,
    ///     before the title.
    private static func carriedDestination(_ destination: String, fragment: String) -> String? {
        guard !destination.isEmpty, !destination.hasPrefix("<") else { return nil }
        let urlEnd = destination.firstIndex(where: { $0 == " " || $0 == "\t" }) ?? destination.endIndex
        let urlPart = destination[..<urlEnd]
        guard !urlPart.isEmpty, !urlPart.contains("#") else { return nil }
        return urlPart + "#" + fragment + destination[urlEnd...]
    }

    /// `attrsContent` includes the surrounding `{`/`}`. This is a syntactic
    /// SHAPE check only, deciding whether the block is image metadata at all
    /// (and therefore stripped) — value validation (width's `%`/`px`
    /// unit/range DROP rules from RFC-0015 §5/§9) happens separately in
    /// `ImageDisplayAttributes.parse`, deciding only what gets APPLIED.
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
            // Lowercased BEFORE the recognized-key check (review round 1):
            // checking the raw substring made `{WIDTH=60%}` fail the shape
            // gate — neither stripped nor carried — while
            // `ImageDisplayAttributes.parse` (and the server) accepted it.
            let key = token[token.startIndex..<equalsIndex].lowercased()
            let value = token[token.index(after: equalsIndex)...]
            guard !value.isEmpty else { return false }
            if recognizedKeys.contains(key) {
                sawRecognizedKey = true
            }
        }
        return sawRecognizedKey
    }
}
