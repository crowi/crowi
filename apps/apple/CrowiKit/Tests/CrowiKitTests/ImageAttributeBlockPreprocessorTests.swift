import XCTest

@testable import CrowiKit

/// `docs/rfcs/0015-image-display-attributes.md` §5/§6.2 — proves
/// `ImageAttributeBlockPreprocessor.strip(_:)` removes ONLY an
/// immediately-adjacent RFC-0015 attribute block, never the image itself,
/// never a `{...}` unrelated to any image, and never anything inside a code
/// span/block.
final class ImageAttributeBlockPreprocessorTests: XCTestCase {
    // MARK: - The reported bug: literal `{width=500px}` after an image

    func testAttributeBlockImmediatelyAfterAnImageIsStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![alt](url){width=500px}")

        XCTAssertEqual(result, "![alt](url)")
    }

    func testAttributeBlockWithMultipleKeysIsStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![Screenshot](/api/v2/attachments/def){width=320px float=right}")

        XCTAssertEqual(result, "![Screenshot](/api/v2/attachments/def)")
    }

    /// RFC-0015 §5 also permits a single space (or more) before `{`.
    func testAttributeBlockSeparatedByASpaceIsStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![alt](url) {width=60% align=center}")

        XCTAssertEqual(result, "![alt](url)")
    }

    /// RFC-0015 §5's exact second example: one soft line break plus spaces
    /// before `{`.
    func testAttributeBlockOnTheLineAfterTheImageIsStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![Alt text](/files/a.png)\n{width=60% align=center}")

        XCTAssertEqual(result, "![Alt text](/files/a.png)")
    }

    /// RFC-0015 §5: unknown keys are ignored, not treated as parse errors —
    /// as long as at least one recognized key is present, the whole block is
    /// still an attribute block and gets stripped.
    func testAttributeBlockWithAnUnrecognizedKeyAlongsideARecognizedOneIsStillStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![alt](url){width=500px foo=bar}")

        XCTAssertEqual(result, "![alt](url)")
    }

    /// review round 1 (`feature-ios-phase3`) — keys are matched
    /// case-INsensitively, like the server (`parseAttrBody` lowercases every
    /// key before its allowlist switch): the previous raw-substring check
    /// left `{WIDTH=60%}` neither stripped nor carried, even though
    /// `ImageDisplayAttributes.parse` accepted it.
    func testUppercaseRecognizedKeyIsStripped() {
        let result = ImageAttributeBlockPreprocessor.strip("![alt](url){WIDTH=60%}")

        XCTAssertEqual(result, "![alt](url)")
    }

    /// Only the whitespace gap + the block itself are consumed — trailing
    /// content after the closing `}` must survive untouched.
    func testTrailingTextAfterTheAttributeBlockIsPreserved() {
        let result = ImageAttributeBlockPreprocessor.strip("![a](/x.png){width=60%} trailing text")

        XCTAssertEqual(result, "![a](/x.png) trailing text")
    }

    func testMultipleAttributedImagesInOneDocumentAreAllStripped() {
        let raw = "![one](a.png){width=1px}\n\nsome text\n\n![two](b.png){align=center}"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, "![one](a.png)\n\nsome text\n\n![two](b.png)")
    }

    // MARK: - Must NOT touch code

    func testAttributeBlockInsideAFencedCodeBlockIsUntouched() {
        let raw = "before\n```\n![alt](url){width=500px}\n```\nafter"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    func testAttributeBlockInsideInlineCodeIsUntouched() {
        let raw = "Use `![alt](url){width=500px}` as an example."
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    // MARK: - Must NOT touch unrelated braces

    /// Braces with no preceding image at all must never be touched.
    func testBracesUnrelatedToAnyImageAreUntouched() {
        let raw = "Some text {not an attribute} more text."
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    /// A `{...}` immediately after an image, but whose content is not
    /// `key=value`-shaped at all, is not attribute syntax and must survive —
    /// this is what keeps the preprocessor from eating arbitrary braces that
    /// merely happen to sit next to an image.
    func testNonAttributeShapedBracesAfterAnImageAreUntouched() {
        let raw = "![alt](url){just some prose}"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    /// A `{...}` after an image whose only keys are unrecognized must also
    /// survive (RFC-0015 §6.2: at least one recognized attribute is required
    /// for the block to be treated as image metadata at all).
    func testAttributeBlockWithOnlyUnrecognizedKeysIsUntouched() {
        let raw = "![alt](url){foo=bar baz=qux}"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    /// More than one blank line between the image and `{...}` is outside
    /// RFC-0015 §5's permitted gap (at most one soft break) — must be left
    /// alone.
    func testAttributeBlockSeparatedByMoreThanOneLineBreakIsUntouched() {
        let raw = "![alt](url)\n\n{width=60%}"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    // MARK: - Must NOT touch plain images

    func testPlainImageWithoutAttributesIsUnchanged() {
        let raw = "![alt](https://example.com/a.png)"
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    func testDocumentWithNoImagesAtAllIsUnchanged() {
        let raw = "Just some ordinary prose with {braces} and no images."
        let result = ImageAttributeBlockPreprocessor.strip(raw)

        XCTAssertEqual(result, raw)
    }

    // MARK: - stripAndCarry (feature-ios-phase3 — the RFC-0015 value carry)

    func testStripAndCarryRewritesTheDestinationWithTheValidatedFragment() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/api/v2/attachments/abc){width=500px}")

        XCTAssertEqual(result, "![alt](/api/v2/attachments/abc#crowi-image-attrs:width=500px)")
    }

    func testStripAndCarryCarriesEveryValidKeyInCanonicalOrder() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![a](/x.png){float=right width=60% align=center}")

        XCTAssertEqual(result, "![a](/x.png#crowi-image-attrs:width=60pct;align=center;float=right)")
    }

    /// The phase pin "値が invalid でも block の strip 自体は従来どおり行う":
    /// a recognized-key block whose every VALUE fails the DROP validation is
    /// still stripped — only the carry (application) is skipped.
    func testStripAndCarryStillStripsWhenEveryValueIsInvalidButCarriesNothing() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/x.png){width=101%}")

        XCTAssertEqual(result, "![alt](/x.png)")
    }

    func testStripAndCarryDropsOnlyTheInvalidValueWhenAnotherSurvives() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/x.png){width=101% align=center}")

        XCTAssertEqual(result, "![alt](/x.png#crowi-image-attrs:align=center)")
    }

    /// review round 1, end to end through the carry: an uppercase key is
    /// recognized (shape gate), parsed (lowercased key) AND carried — the
    /// fragment always spells the canonical lowercase key.
    func testUppercaseRecognizedKeyIsStrippedAndCarried() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![x](/x.png){WIDTH=60%}")

        XCTAssertEqual(result, "![x](/x.png#crowi-image-attrs:width=60pct)")
    }

    /// VALUE case stays significant even though key case is not (server
    /// parity: `align`'s allowlist is a case-sensitive `Set.has`): the
    /// uppercase key parses, the uppercase value drops.
    func testUppercaseValueStillDropsWhileTheUppercaseKeyParses() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![x](/x.png){WIDTH=60% align=CENTER}")

        XCTAssertEqual(result, "![x](/x.png#crowi-image-attrs:width=60pct)")
    }

    /// Byte-identity guard: a destination that already carries a `#` must
    /// never gain a second fragment — the block is stripped, the attributes
    /// simply go unapplied.
    func testStripAndCarryNeverTouchesADestinationThatAlreadyHasAFragment() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/x.png#anchor){width=50%}")

        XCTAssertEqual(result, "![alt](/x.png#anchor)")
    }

    func testStripAndCarryPutsTheFragmentOnTheURLTokenBeforeATitle() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/x.png \"a title\"){width=50%}")

        XCTAssertEqual(result, "![alt](/x.png#crowi-image-attrs:width=50pct \"a title\")")
    }

    func testStripAndCarrySkipsAngleBracketDestinationsButStillStrips() {
        let result = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](</x y.png>){width=50%}")

        XCTAssertEqual(result, "![alt](</x y.png>)")
    }

    func testStripAndCarryInsideAFencedCodeBlockIsUntouched() {
        let raw = "```\n![alt](url){width=500px}\n```"

        XCTAssertEqual(ImageAttributeBlockPreprocessor.stripAndCarry(raw), raw)
    }

    func testStripAndCarryLeavesNonAttributeBracesUntouched() {
        let raw = "![alt](url){just some prose}"

        XCTAssertEqual(ImageAttributeBlockPreprocessor.stripAndCarry(raw), raw)
    }

    /// `strip` (the carry-less variant) must keep removing the block WITHOUT
    /// ever emitting the side-channel.
    func testPlainStripNeverEmitsTheFragmentSideChannel() {
        let result = ImageAttributeBlockPreprocessor.strip("![alt](/x.png){width=50%}")

        XCTAssertEqual(result, "![alt](/x.png)")
    }

    /// The carried destination must survive `WikiLinkMentionPreprocessor`
    /// (which runs AFTER this preprocessor in `WorkspacePageMarkdownView`)
    /// untouched — the image span is one of its protected regions.
    func testCarriedDestinationSurvivesTheWikiLinkMentionPass() {
        let carried = ImageAttributeBlockPreprocessor.stripAndCarry("![alt](/x.png){width=50% align=right}")

        XCTAssertEqual(WikiLinkMentionPreprocessor.preprocess(carried), carried)
    }
}
