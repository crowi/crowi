import XCTest

@testable import CrowiKit

/// RFC-0016 §6/§15 — mirrors `WIKILINK_RE`/`MENTION_RE`
/// (`packages/api/src/renderer/core/{wikilinks,mentions}.ts`) byte-for-byte,
/// rewriting raw `[[target]]`/`[[target|display]]`/`@username` into ordinary
/// CommonMark links against the private pseudo-schemes, resolvable back via
/// `classify(_:)`.
final class WikiLinkMentionPreprocessorTests: XCTestCase {
    // MARK: - Wikilinks

    func testBareAbsolutePathWikiLinkBecomesATappableLink() {
        let result = WikiLinkMentionPreprocessor.preprocess("See [[/team/eng]] for details.")

        XCTAssertTrue(result.contains("(crowi-wikilink:"), "must produce a link against the private pseudo-scheme")
        let target = extractSingleWikiLinkTarget(from: result)
        XCTAssertEqual(target, "/team/eng")
    }

    func testPipeAliasedWikiLinkUsesTheDisplayTextAndTheTargetBeforeThePipe() {
        let result = WikiLinkMentionPreprocessor.preprocess("[[/team/eng|Engineering]]")

        XCTAssertTrue(result.contains("[Engineering]("), "display text is the alias, not the raw target")
        XCTAssertEqual(extractSingleWikiLinkTarget(from: result), "/team/eng")
    }

    func testNonAbsoluteWikiLinkTargetIsLeftAsPlainUntouchedText() {
        let raw = "[[Bare Page Name]]"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        // Mirrors `isValidTarget` (wikilinks.ts) — a non-`/`-prefixed target
        // is never turned into a link at all (native has no "dimmed but
        // still a link" equivalent, unlike the web's `#`-href affordance).
        XCTAssertEqual(result, raw)
        XCTAssertFalse(result.contains("crowi-wikilink:"))
    }

    func testExternalURLWikiLinkTargetIsLeftAsPlainUntouchedText() {
        let raw = "[[https://attacker.example/x]]"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    func testWikiLinkInsideAFencedCodeBlockIsUntouched() {
        let raw = "before\n```\n[[/should/not/convert]]\n```\nafter"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    func testWikiLinkInsideInlineCodeIsUntouched() {
        let raw = "Use `[[/should/not/convert]]` in your body."
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    func testClassifyRoundTripsAWikiLinkTargetContainingSpecialCharacters() {
        let result = WikiLinkMentionPreprocessor.preprocess("[[/team/eng & ops]]")
        let target = extractSingleWikiLinkTarget(from: result)
        XCTAssertEqual(target, "/team/eng & ops")
    }

    // MARK: - Mentions

    func testMentionAtStartOfStringBecomesATappableLink() {
        let result = WikiLinkMentionPreprocessor.preprocess("@sotarok please review")

        XCTAssertTrue(result.hasPrefix("[@sotarok](crowi-mention:sotarok)"))
    }

    func testMentionAfterANonWordCharacterIsRecognized() {
        let result = WikiLinkMentionPreprocessor.preprocess("cc @sotarok thanks")

        XCTAssertTrue(result.contains("[@sotarok](crowi-mention:sotarok)"))
        XCTAssertTrue(result.hasPrefix("cc "), "the preceding space must be preserved as plain text")
    }

    /// Mirrors `MENTION_RE`'s `(^|[^A-Za-z0-9_])` boundary: an `@` glued to a
    /// preceding word character (e.g. an email-shaped `me@example.com`) must
    /// NOT be treated as a mention.
    func testMentionGluedToAPrecedingWordCharacterIsNotAMention() {
        let result = WikiLinkMentionPreprocessor.preprocess("me@example.com")

        XCTAssertEqual(result, "me@example.com")
        XCTAssertFalse(result.contains("crowi-mention:"))
    }

    func testMentionInsideAFencedCodeBlockIsUntouched() {
        let raw = "before\n```\n@notamention\n```\nafter"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    func testMultipleMentionsInOneLineAreAllRewritten() {
        let result = WikiLinkMentionPreprocessor.preprocess("@alice and @bob-2 should look.")

        XCTAssertTrue(result.contains("[@alice](crowi-mention:alice)"))
        XCTAssertTrue(result.contains("[@bob-2](crowi-mention:bob-2)"))
    }

    /// Mirrors `mentions.ts`'s `insideLink` skip: an `@`-shaped path segment
    /// inside an EXISTING link's own destination (a very common GitHub-style
    /// URL) must never be rewritten into a nested mention link — doing so
    /// would corrupt the original link's own syntax, not merely leave a
    /// mention un-linked.
    func testMentionInsideAnExistingMarkdownLinksDestinationIsUntouched() {
        let raw = "See [the repo](https://github.com/@sotarok/crowi) for details."
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw, "an @ inside an existing link's destination must never be rewritten into a nested mention link")
    }

    /// Same skip, the label half: an `@mention`-shaped substring inside an
    /// existing link's own display text must not be re-wrapped into a
    /// nested link either.
    func testMentionInsideAnExistingMarkdownLinksLabelIsUntouched() {
        let raw = "[@sotarok's team page](/team/eng)"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    /// A mention OUTSIDE any existing link, on the very same line as one
    /// whose destination happens to contain an `@`, must still be rewritten
    /// — the protection is scoped to the link span itself, not the whole
    /// line/document.
    func testMentionOutsideAnExistingLinkIsStillRewrittenWhileTheLinksOwnDestinationIsPreserved() {
        let raw = "@alice, check [the repo](https://github.com/@bob/crowi)."
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertTrue(result.contains("[@alice](crowi-mention:alice)"))
        XCTAssertTrue(result.contains("(https://github.com/@bob/crowi)"), "the existing link's own destination must be preserved verbatim")
        XCTAssertFalse(result.contains("crowi-mention:bob"))
    }

    /// A `[[wikilink]]`-shaped substring inside an existing link's
    /// destination must likewise pass through untouched (the destination is
    /// never text-node content server-side either).
    func testWikiLinkPatternInsideAnExistingMarkdownLinksDestinationIsUntouched() {
        let raw = "[reference](https://example.com/path?ref=[[not/a/wikilink]])"
        let result = WikiLinkMentionPreprocessor.preprocess(raw)

        XCTAssertEqual(result, raw)
    }

    // MARK: - classify(_:)

    func testClassifyResolvesAWikiLinkPseudoSchemeURL() {
        let url = URL(string: "crowi-wikilink:%2Fteam%2Feng")!

        XCTAssertEqual(WikiLinkMentionPreprocessor.classify(url), .wikiLinkTarget("/team/eng"))
    }

    func testClassifyResolvesAMentionPseudoSchemeURL() {
        let url = URL(string: "crowi-mention:sotarok")!

        XCTAssertEqual(WikiLinkMentionPreprocessor.classify(url), .mentionUsername("sotarok"))
    }

    func testClassifyTreatsAnOrdinaryURLAsExternal() {
        let url = URL(string: "https://example.com")!

        XCTAssertEqual(WikiLinkMentionPreprocessor.classify(url), .external(url))
    }

    // MARK: - Helpers

    private func extractSingleWikiLinkTarget(from markdown: String) -> String? {
        guard let range = markdown.range(of: "crowi-wikilink:") else { return nil }
        let afterScheme = markdown[range.upperBound...]
        let encodedTarget = afterScheme.prefix { $0 != ")" }
        return String(encodedTarget).removingPercentEncoding
    }
}
