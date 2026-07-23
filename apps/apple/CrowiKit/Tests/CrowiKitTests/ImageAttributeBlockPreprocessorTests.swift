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
}
