import MarkdownUI
import XCTest

@testable import CrowiKit

/// `feature-ios-phase3-notifications-extensions` — footnotes and PlantUML are
/// EXCLUDED from this phase and handed to RFC-0023 (client-agnostic
/// renderedAst): PlantUML has no client-fetchable render URL at all (the
/// plugin inlines server-fetched SVG/PNG into `html` nodes), and MarkdownUI
/// 2.4.1 has no footnote support nor an extension point to add one (forking
/// is banned). Until RFC-0023 delivers them as typed nodes, §6's
/// "plain text degrade until natively rendered" principle holds — this file
/// REGRESSION-PINS that degrade so a later change can't half-enable either
/// extension silently.
final class UnsupportedExtensionDegradeTests: XCTestCase {
    // MARK: - Footnotes

    private let footnoteFixture = "Body text with a footnote.[^1]\n\nMore prose.\n\n[^1]: The footnote definition."

    /// The reader's full raw-body preprocessing chain
    /// (`WorkspacePageMarkdownView.markdownContent` order: attribute
    /// strip-and-carry, then wikilink/mention rewrite) must pass footnote
    /// syntax through byte-identically — no preprocessor may half-consume it.
    func testFootnoteFixtureSurvivesThePreprocessingChainByteIdentically() {
        let processed = WikiLinkMentionPreprocessor.preprocess(ImageAttributeBlockPreprocessor.stripAndCarry(footnoteFixture))

        XCTAssertEqual(processed, footnoteFixture)
    }

    /// The renderer itself (cmark-gfm behind MarkdownUI, parsed with
    /// `CMARK_OPT_DEFAULT` — no footnotes option, and no `footnotes` entry
    /// in the attached GFM extension set) keeps `[^1]` as LITERAL text: the
    /// plain-text degrade, not a superscript reference or a rendered
    /// footnote section.
    func testFootnoteSyntaxDegradesToLiteralPlainText() {
        let content = MarkdownContent(footnoteFixture)

        XCTAssertTrue(content.renderPlainText().contains("[^1]"), "the reference must stay literal text")
        let html = content.renderHTML()
        XCTAssertTrue(html.contains("[^1]"), "no footnote transform may consume the marker")
        XCTAssertFalse(html.contains("<sup"), "a superscript reference would mean footnotes got (half-)enabled")
    }

    // MARK: - PlantUML

    private let plantUMLFixture = "```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```"

    /// Fenced `plantuml` blocks are CODE — both preprocessors must treat the
    /// fence as a protected span and pass it through untouched (`@startuml`
    /// contains a `@…` that must NOT be rewritten into a mention link, and
    /// an attribute-shaped `{…}` inside a fence must not be eaten).
    func testPlantUMLFixtureSurvivesThePreprocessingChainByteIdentically() {
        let processed = WikiLinkMentionPreprocessor.preprocess(ImageAttributeBlockPreprocessor.stripAndCarry(plantUMLFixture))

        XCTAssertEqual(processed, plantUMLFixture)
    }

    /// The renderer keeps the fence as a plain code block (the degrade the
    /// web shows only when the PlantUML plugin is off — natively it is the
    /// ONLY presentation until RFC-0023): the source text stays verbatim,
    /// tagged as a `plantuml` code block, never an image/diagram substitute.
    func testPlantUMLFenceDegradesToAPlainCodeBlock() {
        let content = MarkdownContent(plantUMLFixture)

        XCTAssertTrue(content.renderPlainText().contains("Alice -> Bob: hello"), "the diagram SOURCE must stay visible as text")
        let html = content.renderHTML()
        XCTAssertTrue(html.contains("<pre>"), "must remain a code block")
        XCTAssertTrue(html.contains("language-plantuml"), "the fence info string must survive (RFC-0023's corpus keys off it)")
        XCTAssertFalse(html.contains("<img"), "no diagram substitute may appear")
    }
}
