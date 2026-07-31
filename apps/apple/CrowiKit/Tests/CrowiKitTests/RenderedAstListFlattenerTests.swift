import XCTest

@testable import CrowiKit

/// The PURE flattening seam behind `RenderedAstListView` — tree in →
/// `[Row]` out, asserted without any SwiftUI layout. The companion
/// `DeepListLayoutWallTimeTests` pins the reason the flattener exists (flat
/// rows keep deep-list layout bounded); this suite pins WHAT it emits:
/// markers, per-level ordered counters, task checkboxes, non-list block
/// placement, spacing, and degraded-child visibility.
final class RenderedAstListFlattenerTests: XCTestCase {
    // MARK: - builders

    private func text(_ value: String) -> RenderedAstNode {
        RenderedAstNode(kind: .text(value: value))
    }

    private func paragraph(_ value: String) -> RenderedAstNode {
        RenderedAstNode(kind: .paragraph, children: [text(value)])
    }

    private func item(checked: Bool? = nil, _ children: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .listItem(checked: checked, spread: nil), children: children)
    }

    private func list(ordered: Bool? = false, start: Int? = nil, _ items: [RenderedAstNode]) -> RenderedAstNode {
        RenderedAstNode(kind: .list(ordered: ordered, start: start, spread: nil), children: items)
    }

    private func flatten(_ listNode: RenderedAstNode) throws -> [RenderedAstListFlattener.Row] {
        guard case .list(let ordered, let start, _) = listNode.kind else {
            XCTFail("not a list node")
            throw CocoaError(.featureUnsupported)
        }
        return RenderedAstListFlattener.flatten(ordered: ordered ?? false, start: start, items: listNode.children)
    }

    // MARK: - depth-8 synthetic tree (the real failing page's shape)

    /// The wall-time suite's depth-8 builder (2 items per level, each with a
    /// paragraph + sub-list) flattens to exactly one row per item, at the
    /// true 0–7 depths, all bulleted, none hidden.
    func testDepth8SyntheticTreeFlattensToOneRowPerItem() throws {
        let deep = DeepListLayoutWallTimeTests.deepListNode(level: 0, maxDepth: 8)
        let rows = try flatten(deep)

        // 2 items/level, both recursing: 2 + 4 + … + 2^8 = 2^9 - 2.
        XCTAssertEqual(rows.count, 510)
        XCTAssertEqual(Set(rows.map(\.depth)), Set(0...7), "every nesting level 0–7 must appear")
        XCTAssertEqual(rows.map(\.depth).max(), 7)
        for row in rows {
            XCTAssertEqual(row.marker, .bullet)
            XCTAssertFalse(row.markerHidden)
            XCTAssertEqual(row.blocks.count, 1, "each item's paragraph stays in its own row")
        }
        // Pre-order: the first rows walk straight down the first chain.
        XCTAssertEqual(rows.prefix(8).map(\.depth), Array(0...7))
    }

    // MARK: - ordered numbering

    func testOrderedNumberingHonorsStartAndKeepsPerLevelCounters() throws {
        let nested = list(ordered: true, [
            item([paragraph("inner one")]),
            item([paragraph("inner two")]),
        ])
        let outer = list(ordered: true, start: 3, [
            item([paragraph("outer three"), nested]),
            item([paragraph("outer four")]),
        ])
        let rows = try flatten(outer)

        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows[0].marker, .ordered(number: 3), "the outer list honors its start offset")
        XCTAssertEqual(rows[1].marker, .ordered(number: 1), "the nested list keeps its OWN counter")
        XCTAssertEqual(rows[2].marker, .ordered(number: 2))
        XCTAssertEqual(rows[3].marker, .ordered(number: 4), "the outer counter resumes after the nested list")
        XCTAssertEqual(rows.map(\.depth), [0, 1, 1, 0])
    }

    /// Numbering counts EVERY list child — including degraded non-listItem
    /// ones — matching the previous renderer's `(start ?? 1) + index`
    /// enumerate-offset arithmetic.
    func testOrderedNumberingCountsDegradedChildren() throws {
        let degraded = RenderedAstNode(kind: .crowiOpaque(reason: .invalidShape, originalType: nil))
        let rows = try flatten(list(ordered: true, [
            item([paragraph("one")]),
            degraded,
            item([paragraph("three")]),
        ]))
        XCTAssertEqual(rows[0].marker, .ordered(number: 1))
        XCTAssertNil(rows[1].marker)
        XCTAssertEqual(rows[2].marker, .ordered(number: 3), "the degraded child still consumed an index")
    }

    // MARK: - task checkboxes

    func testTaskItemsKeepTheirCheckboxesEvenInOrderedLists() throws {
        let rows = try flatten(list(ordered: true, [
            item(checked: true, [paragraph("done")]),
            item(checked: false, [paragraph("todo")]),
            item([paragraph("plain")]),
        ]))
        XCTAssertEqual(rows[0].marker, .task(checked: true), "checked wins over ordered numbering")
        XCTAssertEqual(rows[1].marker, .task(checked: false))
        XCTAssertEqual(rows[2].marker, .ordered(number: 3), "the plain (checked: null) item numbers by its index")
    }

    // MARK: - non-list block children placement

    /// Consecutive non-list blocks (paragraph + code) stay in ONE row at the
    /// item's indentation, next to the visible marker.
    func testMultipleNonListBlocksShareTheItemsRow() throws {
        let code = RenderedAstNode(kind: .code(value: "let x = 1", lang: "swift", meta: nil))
        let quote = RenderedAstNode(kind: .blockquote, children: [paragraph("quoted")])
        let rows = try flatten(list([item([paragraph("intro"), code, quote])]))

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].depth, 0)
        XCTAssertEqual(rows[0].marker, .bullet)
        XCTAssertFalse(rows[0].markerHidden)
        XCTAssertEqual(rows[0].blocks.map(\.typeName), ["paragraph", "code", "blockquote"])
    }

    /// Blocks AFTER a nested sub-list become a continuation row: same depth,
    /// marker column reserved but hidden, document order preserved.
    func testBlocksAfterANestedListBecomeAHiddenMarkerContinuationRow() throws {
        let rows = try flatten(list([
            item([
                paragraph("before"),
                list([item([paragraph("nested")])]),
                paragraph("after"),
            ])
        ]))

        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].blocks.first?.kind, .paragraph)
        XCTAssertEqual(rows[0].markerHidden, false)
        XCTAssertEqual(rows[1].depth, 1)
        XCTAssertEqual(rows[2].depth, 0, "the continuation returns to the item's depth")
        XCTAssertEqual(rows[2].marker, .bullet)
        XCTAssertTrue(rows[2].markerHidden, "the continuation reserves the marker column invisibly")
        guard case .text(let value)? = rows[2].blocks.first?.children.first?.kind else {
            return XCTFail("continuation row lost its paragraph")
        }
        XCTAssertEqual(value, "after")
    }

    /// An item whose FIRST child is a nested list still shows its marker
    /// (a synthetic empty-content marker row precedes the nested rows).
    func testItemStartingWithANestedListStillShowsItsMarker() throws {
        let rows = try flatten(list([
            item([list([item([paragraph("only nested content")])])])
        ]))
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].marker, .bullet)
        XCTAssertFalse(rows[0].markerHidden)
        XCTAssertTrue(rows[0].blocks.isEmpty)
        XCTAssertEqual(rows[1].depth, 1)
    }

    // MARK: - spacing (the recursive layout's exact 6/12 gaps)

    func testTopSpacingMirrorsTheRecursiveLayout() throws {
        let rows = try flatten(list([
            item([
                paragraph("first"),
                list([
                    item([paragraph("nested first")]),
                    item([paragraph("nested second")]),
                ]),
                paragraph("continuation"),
            ]),
            item([paragraph("second sibling")]),
        ]))

        XCTAssertEqual(rows.map(\.topSpacing), [
            0,   // the whole list's first row
            RenderedAstListFlattener.intraItemSpacing,  // nested list starts as a block WITHIN the item
            RenderedAstListFlattener.interItemSpacing,  // nested sibling
            RenderedAstListFlattener.intraItemSpacing,  // continuation chunk of the item
            RenderedAstListFlattener.interItemSpacing,  // next top-level sibling
        ])
    }

    // MARK: - degraded children

    func testDegradedListChildBecomesAVisibleMarkerlessRow() throws {
        let degraded = RenderedAstNode(kind: .crowiOpaque(reason: .unknownType, originalType: "mystery"))
        let rows = try flatten(list([item([paragraph("real")]), degraded]))

        XCTAssertEqual(rows.count, 2)
        XCTAssertNil(rows[1].marker, "degraded children render without a marker column")
        XCTAssertFalse(rows[1].markerHidden)
        XCTAssertEqual(rows[1].blocks.map(\.typeName), ["crowiOpaque"], "visible, never dropped")
        XCTAssertEqual(rows[1].depth, 0)
    }
}
