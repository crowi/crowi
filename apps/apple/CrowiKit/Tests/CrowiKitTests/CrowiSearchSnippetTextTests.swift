import SwiftUI
import XCTest

@testable import CrowiKit

/// feature-ios-visual-redesign Phase 1 — the styling half of the search
/// snippet. `SearchLenientTests` pins WHICH runs are hits; this pins that the
/// styling lands on exactly those runs, and that turning the untrusted
/// snippet into an `AttributedString` still never carries markup through.
final class CrowiSearchSnippetTextTests: XCTestCase {
    private func runs(_ raw: String) -> [(text: String, isHighlighted: Bool)] {
        CrowiSearchSnippetText.attributedSnippet(raw).runs.map { run in
            (
                text: String(CrowiSearchSnippetText.attributedSnippet(raw)[run.range].characters),
                isHighlighted: run.backgroundColor != nil
            )
        }
    }

    /// The highlight attributes land on the hit run and on nothing else.
    func testOnlyTheHitRunCarriesTheHighlightAttributes() {
        let attributed = CrowiSearchSnippetText.attributedSnippet("the <mark>eng</mark> team")
        var highlightedText = ""
        var plainText = ""
        for run in attributed.runs {
            let text = String(attributed[run.range].characters)
            if run.backgroundColor != nil {
                XCTAssertEqual(run.backgroundColor, CrowiTheme.searchHighlight)
                XCTAssertEqual(run.foregroundColor, CrowiTheme.searchHighlightForeground)
                XCTAssertEqual(run.inlinePresentationIntent, .stronglyEmphasized, "the design's font-weight:600 on the mark")
                highlightedText += text
            } else {
                XCTAssertNil(run.foregroundColor, "a non-hit run must inherit the snippet's muted colour, not pin its own")
                plainText += text
            }
        }

        XCTAssertEqual(highlightedText, "eng")
        XCTAssertEqual(plainText, "the  team")
    }

    /// A snippet with no hits (a path-only match, or a driver that supplies
    /// no highlight) styles nothing — it must not fall back to highlighting
    /// the whole line.
    func testASnippetWithoutHitsCarriesNoHighlightAtAll() {
        for run in CrowiSearchSnippetText.attributedSnippet("no tags here").runs {
            XCTAssertNil(run.backgroundColor)
        }
        XCTAssertTrue(CrowiSearchSnippetText.attributedSnippet("").characters.isEmpty)
    }

    /// The rendered characters are exactly the stripped snippet — the same
    /// text a plain `Text(plainSnippet(...))` would have shown, with the
    /// styling as the only difference. This is what says the highlight is
    /// presentational: no tag survives into anything a renderer sees.
    func testRenderedCharactersAreExactlyThePlainSnippet() {
        let cases = [
            "the <mark>eng</mark> team",
            "<mark>a</mark><mark>b</mark>",
            "<script>alert(1)</script><mark>hit</mark>",
            "</mark>orphan",
            "no tags here",
            "",
        ]
        for raw in cases {
            XCTAssertEqual(
                String(CrowiSearchSnippetText.attributedSnippet(raw).characters),
                SearchHitLenient.plainSnippet(raw),
                "attributed snippet text diverged from the stripped one for \(raw.debugDescription)"
            )
        }
    }

    /// Every hit run the segmenter reports gets styled — none is dropped on
    /// the way into the `AttributedString`.
    func testEveryHighlightedSegmentSurvivesIntoAStyledRun() {
        let raw = "<mark>a</mark> x <mark>b</mark> y <mark>c</mark>"
        let expected = SearchHitLenient.snippetSegments(raw).filter(\.isHighlighted).map(\.text)

        let actual = runs(raw).filter(\.isHighlighted).map(\.text)

        XCTAssertEqual(actual, expected)
        XCTAssertEqual(expected, ["a", "b", "c"], "guard against the fixture silently losing its hits")
    }
}
