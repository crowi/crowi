import XCTest

@testable import CrowiKit

/// The v1 projection hands alerts over as ordinary blockquotes with the
/// author's marker intact, so the variant is recognised from that text.
/// These pin the recognition — and, just as importantly, the refusals: the
/// shapes the transform never emits must stay the quote the author wrote.
final class RenderedAstAlertTests: XCTestCase {
    private func text(_ value: String) -> RenderedAstNode {
        RenderedAstNode(kind: .text(value: value))
    }

    private func paragraph(_ children: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .paragraph, children: children)
    }

    private var lineBreak: RenderedAstNode { RenderedAstNode(kind: .lineBreak) }

    func testEveryVariantIsRecognised() {
        for variant in RenderedAstAlertVariant.allCases {
            let children = [paragraph([text("[!\(variant.rawValue.uppercased())]"), lineBreak, text("body")])]
            let detected = RenderedAstAlert.detect(children: children)
            XCTAssertEqual(detected?.variant, variant)
            XCTAssertEqual(detected?.content.count, 1)
            XCTAssertEqual(detected?.content.first?.children.map(\.kind), [.text(value: "body")], "the marker is dropped, the body kept")
        }
    }

    func testTheMarkersSpellingIsFoldedLikeTheWebFoldsIt() {
        for spelling in ["[!note]", "[!Note]", "[!NOTE]"] {
            let children = [paragraph([text(spelling), lineBreak, text("body")])]
            XCTAssertEqual(RenderedAstAlert.detect(children: children)?.variant, .note, spelling)
        }
    }

    func testAMarkerAloneInItsParagraphDropsThatParagraph() {
        let children = [
            paragraph([text("[!TIP]")]),
            paragraph([text("body in a later block")]),
        ]
        let detected = RenderedAstAlert.detect(children: children)
        XCTAssertEqual(detected?.variant, .tip)
        XCTAssertEqual(detected?.content.count, 1)
        XCTAssertEqual(detected?.content.first?.children.map(\.kind), [.text(value: "body in a later block")])
    }

    func testAMarkerButtedAgainstOtherContentDecoratesNothing() {
        // No `break` after the marker — a shape the transform never produces,
        // so this is an author who typed `[!NOTE]` mid-sentence.
        let children = [paragraph([text("[!NOTE]"), text(" and more")])]
        XCTAssertNil(RenderedAstAlert.detect(children: children))
    }

    func testAnOrdinaryQuoteIsLeftAlone() {
        XCTAssertNil(RenderedAstAlert.detect(children: [paragraph([text("just a quote")])]))
        XCTAssertNil(RenderedAstAlert.detect(children: [paragraph([text("[!UNKNOWN]"), lineBreak, text("x")])]))
        XCTAssertNil(RenderedAstAlert.detect(children: []))
        // A marker that is not the paragraph's FIRST child is body text.
        XCTAssertNil(RenderedAstAlert.detect(children: [paragraph([text("see "), text("[!NOTE]")])]))
        // Only a paragraph can carry the marker.
        XCTAssertNil(RenderedAstAlert.detect(children: [
            RenderedAstNode(kind: .heading(depth: 2), children: [text("[!NOTE]"), lineBreak, text("x")])
        ]))
    }

    func testTheParagraphsOwnDataSurvivesTheStrip() {
        // The editor preview's scroll-sync anchor rides on `data`; rebuilding
        // the paragraph must not drop it.
        let data = RenderedAstNodeData(hProperties: ["data-source-line": .string("12")])
        let children = [RenderedAstNode(kind: .paragraph, data: data, children: [text("[!WARNING]"), lineBreak, text("body")])]
        XCTAssertEqual(RenderedAstAlert.detect(children: children)?.content.first?.data, data)
    }

    func testEveryVariantHasItsOwnPresentation() {
        let labels = Set(RenderedAstAlertVariant.allCases.map(\.label))
        let symbols = Set(RenderedAstAlertVariant.allCases.map(\.systemImage))
        XCTAssertEqual(labels.count, RenderedAstAlertVariant.allCases.count)
        XCTAssertEqual(symbols.count, RenderedAstAlertVariant.allCases.count)
    }
}
