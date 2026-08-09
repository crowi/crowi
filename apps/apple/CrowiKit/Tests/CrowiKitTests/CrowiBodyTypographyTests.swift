import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// The rendered page body's vertical rhythm.
///
/// The point sizes themselves are judgement and nothing here asserts one — a
/// test that pins `lineSpacing == 9.35` would only restate the constant and
/// would turn red the next time somebody looks at a real page and decides it
/// wants more air. What IS pinned is the set of RELATIONSHIPS that decide
/// whether a page can be read at all:
///
///   - a block break must read as a bigger break than a line break;
///   - a list item break must sit between the two, so bullets neither run
///     together nor drift apart into separate paragraphs;
///   - and both must hold at every text size, not only at 17pt.
///
/// Those are asserted twice over. `CrowiBodyMetrics` is a pure function of one
/// resolved type size, so the size-independence half is asserted directly
/// across the range iOS resolves for `.body` (14pt at xSmall … 53pt at AX5) —
/// which is also the only way to reach those sizes from a macOS test host,
/// where `dynamicTypeSize` has nothing to move. The other half is MEASURED off
/// the real SwiftUI render, because what a reader sees is a rendered height,
/// not a constant.
@MainActor
final class CrowiBodyTypographyTests: XCTestCase {
    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    /// `.body` as iOS resolves it from xSmall through AX5, plus macOS's 13pt.
    private static let representativeBodyPointSizes: [CGFloat] = [13, 14, 17, 23, 28, 40, 53]

    // MARK: - The rhythm, as pure relationships

    func testBlockGapOutReadsLineGapAtEveryTextSize() {
        for size in Self.representativeBodyPointSizes {
            let metrics = CrowiBodyMetrics(bodyPointSize: size)

            XCTAssertGreaterThan(
                metrics.blockSpacing,
                metrics.lineSpacing,
                "at \(size)pt a paragraph break is no wider than a line break — blocks stop reading as blocks"
            )
            // Merely "greater" is not enough to SEE: both gaps are drawn on top
            // of the font's own line height, which compresses the perceived
            // difference. A block gap that is not roughly twice the line gap
            // reads as one more line, not as a new paragraph.
            XCTAssertGreaterThanOrEqual(
                metrics.blockSpacing / metrics.lineSpacing,
                2,
                "at \(size)pt the block gap is only \(metrics.blockSpacing / metrics.lineSpacing)× the line gap"
            )
        }
    }

    func testListItemGapSitsBetweenTheLineGapAndTheBlockGapAtEveryTextSize() {
        for size in Self.representativeBodyPointSizes {
            let metrics = CrowiBodyMetrics(bodyPointSize: size)

            XCTAssertGreaterThan(
                metrics.listItemSpacing,
                metrics.lineSpacing,
                "at \(size)pt list items are packed tighter than the lines inside one item"
            )
            XCTAssertLessThan(
                metrics.listItemSpacing,
                metrics.blockSpacing,
                "at \(size)pt a list falls apart into separate paragraphs instead of reading as one list"
            )
        }
    }

    /// The same middle tier, for the two other places it is used: a wrapped
    /// table cell must not read as two rows, and the halves of a split
    /// paragraph must stay one paragraph.
    func testTableRowAndParagraphSegmentGapsShareTheListItemTier() {
        for size in Self.representativeBodyPointSizes {
            let metrics = CrowiBodyMetrics(bodyPointSize: size)

            XCTAssertGreaterThan(metrics.tableRowSpacing, metrics.lineSpacing, "at \(size)pt a wrapped cell reads as two rows")
            XCTAssertLessThan(metrics.tableRowSpacing, metrics.blockSpacing, "at \(size)pt table rows read as separate blocks")
            XCTAssertGreaterThan(metrics.paragraphSegmentSpacing, metrics.lineSpacing, "at \(size)pt a paragraph's image is glued to its text")
            XCTAssertLessThan(metrics.paragraphSegmentSpacing, metrics.blockSpacing, "at \(size)pt a paragraph's image reads as its own block")
        }
    }

    /// Code opts OUT of the body's Japanese leading (there is no CJK in a
    /// fenced block, and at 0.55em a listing stops reading as one unit), and
    /// inline code is set a step smaller than the text it sits in.
    func testCodeIsSetTighterAndSmallerThanTheProseAroundIt() {
        for size in Self.representativeBodyPointSizes {
            let metrics = CrowiBodyMetrics(bodyPointSize: size)

            XCTAssertLessThan(metrics.codeBlockLineSpacing, metrics.lineSpacing, "at \(size)pt a code block is as airy as Japanese prose")
            XCTAssertGreaterThan(metrics.codeBlockLineSpacing, 0, "at \(size)pt code-block lines have no leading at all")
            XCTAssertLessThan(metrics.inlineCodeSize, size, "at \(size)pt inline code is not smaller than the text around it")
            XCTAssertGreaterThan(metrics.inlineCodeSize, size * 0.85, "at \(size)pt inline code has shrunk into a footnote")
        }
    }

    /// A section opening needs a bigger break before it than a subsection, and
    /// both need more than the block gap already gives.
    func testHeadingsTakeMoreAirTheHigherTheyAre() {
        for size in Self.representativeBodyPointSizes {
            let metrics = CrowiBodyMetrics(bodyPointSize: size)

            XCTAssertGreaterThan(metrics.headingTopPadding(depth: 1), metrics.headingTopPadding(depth: 3), "\(size)pt")
            XCTAssertEqual(metrics.headingTopPadding(depth: 1), metrics.headingTopPadding(depth: 2), accuracy: 0.001, "h1/h2 are the same tier (\(size)pt)")
            XCTAssertEqual(metrics.headingTopPadding(depth: 3), metrics.headingTopPadding(depth: 6), accuracy: 0.001, "h3+ are the same tier (\(size)pt)")
            XCTAssertGreaterThan(metrics.headingTopPadding(depth: 6), 0, "\(size)pt")
        }
    }

    /// Nothing in the rhythm may shrink as text grows — the failure mode of the
    /// spacing this replaced, which was fixed points against a scaling font.
    func testEveryGapGrowsWithTheTextSize() {
        let sizes = Self.representativeBodyPointSizes.sorted()
        for (smaller, larger) in zip(sizes, sizes.dropFirst()) {
            let small = CrowiBodyMetrics(bodyPointSize: smaller)
            let large = CrowiBodyMetrics(bodyPointSize: larger)

            XCTAssertGreaterThan(large.lineSpacing, small.lineSpacing, "\(smaller)pt → \(larger)pt")
            XCTAssertGreaterThan(large.blockSpacing, small.blockSpacing, "\(smaller)pt → \(larger)pt")
            XCTAssertGreaterThan(large.listItemSpacing, small.listItemSpacing, "\(smaller)pt → \(larger)pt")
            XCTAssertGreaterThan(large.dynamicTypeScale, small.dynamicTypeScale, "\(smaller)pt → \(larger)pt")
        }
    }

    /// The list flattener is pure and emits points, so its two gaps are stated
    /// at the default text size — but they have to be the SAME two tiers the
    /// paragraphs around the list use, or a list is spaced by one rule and its
    /// surroundings by another.
    func testFlattenerGapsAreTheMetricsTiersAtTheDefaultTextSize() {
        let metrics = CrowiBodyMetrics(bodyPointSize: CrowiBodyMetrics.defaultBodyPointSize)

        XCTAssertGreaterThan(RenderedAstListFlattener.interItemSpacing, Double(metrics.lineSpacing))
        XCTAssertLessThan(RenderedAstListFlattener.interItemSpacing, RenderedAstListFlattener.intraItemSpacing)
        XCTAssertEqual(
            RenderedAstListFlattener.intraItemSpacing,
            Double(metrics.blockSpacing),
            accuracy: 0.001,
            "blocks inside a list item must be spaced like blocks anywhere else"
        )
    }

    // MARK: - Inline code: distinguished by type, never by a fill

    /// The striping fix. A run's `backgroundColor` fills the whole line box and
    /// cannot be padded, so on Japanese prose carrying several code spans per
    /// line it turned paragraphs into horizontal stripes — and split into two
    /// half-boxes whenever a long token wrapped. No inline-code run may carry
    /// one.
    func testInlineCodeCarriesNoBackgroundFillInEitherContext() {
        for style in [RenderedAstInlineCodeStyle.body, .heading] {
            let result = RenderedAstInlineRenderer(codeStyle: style).render([
                RenderedAstNode(kind: .text(value: "設定は ")),
                RenderedAstNode(kind: .inlineCode(value: "crowi.config.json")),
                RenderedAstNode(kind: .text(value: " です")),
            ])

            for run in result.attributed.runs {
                XCTAssertNil(run.backgroundColor, "an inline-code run painted a fill (\(style))")
            }
        }
    }

    /// Body code is set explicitly, a step smaller than the prose; heading code
    /// inherits the heading's own size (a body-sized run inside a 28pt title
    /// reads as a mistake). Both stay monospaced via the `.code` intent.
    func testBodyCodeIsExplicitlySizedAndHeadingCodeInheritsTheHeadingSize() {
        let node = RenderedAstNode(kind: .inlineCode(value: "plugins"))

        let bodyRuns = RenderedAstInlineRenderer(codeStyle: .body).render([node]).attributed.runs
        let headingRuns = RenderedAstInlineRenderer(codeStyle: .heading).render([node]).attributed.runs

        XCTAssertEqual(bodyRuns.count, 1)
        XCTAssertEqual(headingRuns.count, 1)
        XCTAssertEqual(bodyRuns.first?.inlinePresentationIntent, .code)
        XCTAssertEqual(headingRuns.first?.inlinePresentationIntent, .code)
        XCTAssertEqual(
            bodyRuns.first?.font,
            .system(size: CrowiBodyMetrics().inlineCodeSize, design: .monospaced),
            "body code must be sized to sit level with the Japanese around it"
        )
        XCTAssertNil(headingRuns.first?.font, "heading code must keep the heading's own size")
    }

    /// The degrade chips are the ONE thing that keeps a fill: `[unavailable]`
    /// stands for content that could not be rendered and has to be noticed,
    /// which is the opposite of the requirement above.
    func testDegradeChipsKeepTheirFill() {
        let result = RenderedAstInlineRenderer().render([
            RenderedAstNode(kind: .html(value: "<iframe>"))
        ])

        XCTAssertTrue(
            result.attributed.runs.contains { $0.backgroundColor != nil },
            "a degrade chip must stay conspicuous"
        )
    }

    // MARK: - The rhythm, as rendered

    /// The rule the whole change exists for, measured off the real render
    /// rather than off the constants: two one-line paragraphs must be TALLER
    /// than one paragraph of the same two lines. The difference is exactly
    /// (block gap − line gap), so a renderer that stopped setting `lineSpacing`
    /// — or went back to a flat block spacing close to it — collapses it.
    ///
    /// Both documents are built with an explicit `break` rather than by letting
    /// text wrap, so the line count is fixed and the measurement does not
    /// depend on the host's font metrics.
    func testTwoParagraphsRenderTallerThanTheSameTwoLinesInOneParagraph() throws {
        let oneParagraphTwoLines = try renderedHeight(of: RenderedAstDocument(children: [
            paragraph([text("あ"), RenderedAstNode(kind: .lineBreak), text("い")])
        ]))
        let twoParagraphs = try renderedHeight(of: RenderedAstDocument(children: [
            paragraph([text("あ")]),
            paragraph([text("い")]),
        ]))

        XCTAssertGreaterThan(
            twoParagraphs,
            oneParagraphTwoLines,
            "a paragraph break renders no taller than a line break — paragraphs run together"
        )
        let metrics = CrowiBodyMetrics()
        XCTAssertEqual(
            twoParagraphs - oneParagraphTwoLines,
            metrics.blockSpacing - metrics.lineSpacing,
            accuracy: 1,
            "the rendered difference is not the block/line gap difference — something else is padding the blocks"
        )
    }

    /// The list half of the same rule: two items must be further apart than two
    /// lines of one item, and closer than two paragraphs. This is what the
    /// flattener's old flat 6pt broke once the paragraphs around it got real
    /// leading.
    func testListItemsSitBetweenLineSpacingAndParagraphSpacingWhenRendered() throws {
        let oneItemTwoLines = try renderedHeight(of: RenderedAstDocument(children: [
            list([item([paragraph([text("あ"), RenderedAstNode(kind: .lineBreak), text("い")])])])
        ]))
        let twoItems = try renderedHeight(of: RenderedAstDocument(children: [
            list([item([paragraph([text("あ")])]), item([paragraph([text("い")])])])
        ]))
        let twoParagraphs = try renderedHeight(of: RenderedAstDocument(children: [
            paragraph([text("あ")]),
            paragraph([text("い")]),
        ]))

        XCTAssertGreaterThan(twoItems, oneItemTwoLines, "sibling list items are packed tighter than the lines inside one item")
        XCTAssertLessThan(twoItems, twoParagraphs, "sibling list items are spread as far apart as paragraphs")
    }

    // MARK: - Helpers

    private func paragraph(_ children: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .paragraph, children: children)
    }

    private func text(_ value: String) -> RenderedAstNode {
        RenderedAstNode(kind: .text(value: value))
    }

    private func item(_ children: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .listItem(checked: nil, spread: nil), children: children)
    }

    private func list(_ items: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .list(ordered: false, start: nil, spread: nil), children: items)
    }

    /// The measured height SwiftUI gives the rendered document at a phone
    /// width — the `ImageRenderer` seam the rest of this suite measures
    /// through (`CrowiDesignSystemTests.renderedSize`).
    private func renderedHeight(of document: RenderedAstDocument) throws -> CGFloat {
        #if canImport(AppKit)
        let view = RenderedAstView(
            document: document,
            imageLoader: StubImageFetcher(),
            workspaceOrigin: URL(string: "https://example.com")!,
            onNavigateToWikiLink: { _ in },
            onNavigateToMention: { _ in },
            onNavigateToRelativePath: { _ in }
        )
        let renderer = ImageRenderer(content: view.frame(width: 358, alignment: .leading))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw BodyTypographyRenderingUnavailable() }
        return nsImage.size.height
        #else
        throw BodyTypographyRenderingUnavailable()
        #endif
    }
}

/// Only exists so the `#else` branch above (an iOS `ImageRenderer` host, which
/// `swift test` never takes — it runs the macOS side of CrowiKit) type-checks.
private struct BodyTypographyRenderingUnavailable: Error {}
