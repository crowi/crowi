import XCTest

@testable import CrowiKit

/// The MarkdownUI-path guardrail: list nesting beyond depth 4 re-indents to
/// depth-4 siblings before `Markdown(...)` ever sees the body (MarkdownUI's
/// nested-list layout explodes ~×15 per level — see the preprocessor's doc
/// comment). Everything at depth ≤ 4, and everything that is not a
/// list-item line, must pass through byte-identically.
final class NestedListDepthClampPreprocessorTests: XCTestCase {
    private func clamp(_ body: String) -> String {
        NestedListDepthClampPreprocessor.clamp(body)
    }

    /// Bullet lines at `level` levels of 2-space indentation.
    private func bulletDoc(depth: Int) -> String {
        (0..<depth).map { level in
            String(repeating: "  ", count: level) + "- level \(level + 1)"
        }.joined(separator: "\n")
    }

    // MARK: - depth ≤ 4 untouched

    func testDepthUpToFourPassesThroughByteIdentically() {
        for depth in 1...4 {
            let body = bulletDoc(depth: depth)
            XCTAssertEqual(clamp(body), body, "depth \(depth) must not be rewritten")
        }
    }

    func testProseHeadingsAndBlankLinesPassThroughByteIdentically() {
        let body = """
        # Heading

        Plain paragraph with - a dash mid-sentence.

        - one
          - two

        Trailing paragraph.
        """
        XCTAssertEqual(clamp(body), body)
    }

    // MARK: - deep nesting clamps to depth 4

    func testDepthSixReindentsToDepthFourWithContentIntact() {
        let clamped = clamp(bulletDoc(depth: 6))
        XCTAssertEqual(
            clamped,
            """
            - level 1
              - level 2
                - level 3
                  - level 4
                  - level 5
                  - level 6
            """,
            "levels 5 and 6 become depth-4 siblings; every line's content survives"
        )
    }

    func testAllDeeperLevelsCollapseToDepthFourSiblingsInDocumentOrder() {
        // The real failing page's shape: 8 levels, two items per level.
        var lines: [String] = []
        func emit(level: Int) {
            guard level < 8 else { return }
            for index in 0..<2 {
                lines.append(String(repeating: "  ", count: level) + "- 項目\(level)-\(index)")
                emit(level: level + 1)
            }
        }
        emit(level: 0)
        let clamped = clamp(lines.joined(separator: "\n"))

        let clampedLines = clamped.split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertEqual(clampedLines.count, lines.count, "no line is dropped or added")
        for (original, rewritten) in zip(lines, clampedLines) {
            XCTAssertEqual(
                original.drop(while: { $0 == " " }),
                rewritten.drop(while: { $0 == " " }),
                "content is preserved verbatim — only indentation may change"
            )
            let indent = rewritten.prefix(while: { $0 == " " }).count
            XCTAssertLessThanOrEqual(indent / 2, 3, "no line may sit deeper than depth 4")
        }
    }

    func testOrderedMarkersClampToo() {
        let body = """
        1. one
           1. two
              1. three
                 1. four
                    1. five
        """
        XCTAssertEqual(
            clamp(body),
            """
            1. one
               1. two
                  1. three
                     1. four
                     1. five
            """
        )
    }

    func testTabIndentationCountsAsFourColumnTabStops() {
        let body = "- a\n\t- b\n\t\t- c\n\t\t\t- d\n\t\t\t\t- e"
        let clamped = clamp(body)
        let lines = clamped.split(separator: "\n").map(String.init)
        XCTAssertEqual(Array(lines[0...3]), ["- a", "\t- b", "\t\t- c", "\t\t\t- d"], "depth ≤ 4 lines stay untouched, tabs and all")
        XCTAssertEqual(lines[4], String(repeating: " ", count: 12) + "- e", "the depth-5 item re-seats at the depth-4 column")
    }

    // MARK: - continuation content under a clamped item

    func testContinuationLinesUnderAClampedItemShiftWithIt() {
        let body = """
        - one
          - two
            - three
              - four
                - five
                  continuation of five
        """
        XCTAssertEqual(
            clamp(body),
            """
            - one
              - two
                - three
                  - four
                  - five
                    continuation of five
            """,
            "the continuation stays attached to its item instead of becoming indented code"
        )
    }

    // MARK: - code stays code

    func testFencedCodeContainingListLikeLinesIsUntouched() {
        let body = """
        - one
          - two
            - three
              - four

        ```text
                    - not a list, just code
                        - still code
        ```

        - back to depth 1
        """
        XCTAssertEqual(clamp(body), body)
    }

    func testTildeFenceIsRespectedAndBacktickCloserDoesNotCloseIt() {
        let body = """
        ~~~
                  - inside tilde fence
        ```
                  - still inside (backticks do not close a tilde fence)
        ~~~
        """
        XCTAssertEqual(clamp(body), body)
    }

    func testIndentedCodeBlockOutsideAnyListIsUntouched() {
        let body = """
        A paragraph.

            - this is an indented CODE block, not a list

        The end.
        """
        XCTAssertEqual(clamp(body), body)
    }

    // MARK: - list-context reset

    func testAFlushLeftParagraphResetsTheDepthAccounting() {
        let body = """
        - one
          - two
            - three
              - four

        Interrupting paragraph.

        - a fresh list
          - depth two again
            - depth three
              - depth four
        """
        XCTAssertEqual(clamp(body), body, "the second list starts back at depth 1 — nothing to clamp")
    }
}
