import Foundation

/// Flattens a `list` subtree into a linear sequence of rows — the layout
/// model `RenderedAstListView` renders.
///
/// WHY FLAT: the original renderer nested one
/// `HStack(marker, RenderedAstBlockSequence)` per list level, so a depth-N
/// list built N-deep stack recursion. SwiftUI's StackLayout sizing explodes
/// ~×15 per nesting level (measured on a real page: depth 3 → 140ms,
/// 4 → 906ms, 5 → 15.0s, 6+ → >25s — a permanent main-thread wedge on
/// first paint), while the decoder's DoS gate admits trees up to
/// `RenderedAstWireContract.maxTreeDepth` (64) levels. Flat row emission
/// keeps the stack nesting CONSTANT regardless of list depth: every row is
/// one shallow `HStack`, and depth becomes leading padding.
/// `DeepListLayoutWallTimeTests` pins the wall-time bound.
///
/// This type is deliberately PURE (tree in → `[Row]` out, no SwiftUI): the
/// flattening decisions — marker selection, per-level ordered counters,
/// chunking of non-list blocks, spacing — are all testable without layout
/// (`RenderedAstListFlattenerTests`).
///
/// Fidelity contract (each preserved from the recursive renderer):
///   - unordered items keep the `•` glyph; ordered items number
///     `(start ?? 1) + index` per level, where `index` counts EVERY child of
///     the list node — including degraded non-`listItem` children — exactly
///     like the previous `ForEach`-offset arithmetic;
///   - GFM task items (`checked` non-nil) keep their checkbox marker, taking
///     priority over ordered numbering (three-valued contract:
///     `golden-corpus/core-blocks.json`);
///   - non-list block children of a `listItem` (paragraphs, code,
///     blockquotes, …) stay in that item's rows at the item's indentation;
///     chunks separated by a nested list become continuation rows that
///     reserve — but hide — the marker column so content stays aligned;
///   - the recursive layout ignored `spread` and used two spacings — one
///     between sibling items, one between the blocks inside one item;
///     `Row.topSpacing` still emits exactly those two gaps, now taken from
///     `CrowiBodyMetrics` so a list is spaced by the same rules as the
///     paragraphs around it;
///   - degraded non-`listItem` children of a list render marker-less at the
///     list's own level — visible, never dropped.
public enum RenderedAstListFlattener {
    /// The gap between two SIBLING items — `CrowiBodyMetrics.listItemSpacing`,
    /// which sits between the paragraph's line gap and its block gap. The flat
    /// 6pt this replaces was tuned against the renderer's old (SwiftUI
    /// default, i.e. ~0) leading and ended up TIGHTER than a single line gap,
    /// which is why list items read as more cramped than the paragraphs
    /// around them.
    public static var interItemSpacing: Double { Double(defaultMetrics.listItemSpacing) }
    /// `RenderedAstBlockSequence`'s block spacing — the gap between blocks
    /// that belonged to the same item (and to its nested sub-list).
    public static var intraItemSpacing: Double { Double(defaultMetrics.blockSpacing) }

    /// Emitted in points at the DEFAULT text size; `RenderedAstListView`
    /// applies Dynamic Type (`CrowiBodyMetrics.dynamicTypeScale`). Keeping the
    /// flattener on fixed numbers is what lets its spacing rules be asserted
    /// as exact values without a view host.
    private static var defaultMetrics: CrowiBodyMetrics {
        CrowiBodyMetrics(bodyPointSize: CrowiBodyMetrics.defaultBodyPointSize)
    }

    public enum Marker: Equatable, Sendable {
        case bullet
        case ordered(number: Int)
        case task(checked: Bool)
    }

    public struct Row: Equatable, Sendable {
        /// 0-based list nesting depth — the view multiplies this into
        /// leading padding.
        public var depth: Int
        /// `nil` → no marker column at all (a degraded non-`listItem` child
        /// of the list, rendered at the list's own level).
        public var marker: Marker?
        /// `true` → the marker reserves its width but renders invisibly: a
        /// continuation chunk of an item AFTER its nested sub-list, kept
        /// aligned with the item's first-row content.
        public var markerHidden: Bool
        /// The row's non-list block content, rendered as one
        /// `RenderedAstBlockSequence`. Empty only for the synthetic marker
        /// row of an item whose first child is a nested list.
        public var blocks: [RenderedAstNode]
        /// The vertical gap ABOVE this row (mirrors the recursive layout's
        /// 6/12 spacings; 0 for the first row of the whole list).
        public var topSpacing: Double

        public init(depth: Int, marker: Marker?, markerHidden: Bool, blocks: [RenderedAstNode], topSpacing: Double) {
            self.depth = depth
            self.marker = marker
            self.markerHidden = markerHidden
            self.blocks = blocks
            self.topSpacing = topSpacing
        }
    }

    /// Pre-order walk of a top-level `list` node's children.
    public static func flatten(ordered: Bool, start: Int?, items: [RenderedAstNode]) -> [Row] {
        var rows: [Row] = []
        appendList(ordered: ordered, start: start, items: items, depth: 0, firstItemTopSpacing: 0, rows: &rows)
        return rows
    }

    private static func appendList(
        ordered: Bool,
        start: Int?,
        items: [RenderedAstNode],
        depth: Int,
        firstItemTopSpacing: Double,
        rows: inout [Row]
    ) {
        for (index, item) in items.enumerated() {
            let itemTopSpacing = index == 0 ? firstItemTopSpacing : interItemSpacing
            guard case .listItem(let checked, _) = item.kind else {
                // A degraded (crowiOpaque) child — visible, never dropped;
                // marker-less at the list's own level, like the recursive
                // renderer's bare `RenderedAstBlockView`.
                rows.append(Row(depth: depth, marker: nil, markerHidden: false, blocks: [item], topSpacing: itemTopSpacing))
                continue
            }
            let marker: Marker
            if let checked {
                marker = .task(checked: checked)
            } else if ordered {
                marker = .ordered(number: (start ?? 1) + index)
            } else {
                marker = .bullet
            }
            appendItem(children: item.children, marker: marker, depth: depth, itemTopSpacing: itemTopSpacing, rows: &rows)
        }
    }

    private static func appendItem(
        children: [RenderedAstNode],
        marker: Marker,
        depth: Int,
        itemTopSpacing: Double,
        rows: inout [Row]
    ) {
        var pendingChunk: [RenderedAstNode] = []
        var emittedItemRow = false

        func flushChunk() {
            rows.append(Row(
                depth: depth,
                marker: marker,
                // Only the item's FIRST row shows the marker; later chunks
                // reserve the same width invisibly.
                markerHidden: emittedItemRow,
                blocks: pendingChunk,
                topSpacing: emittedItemRow ? intraItemSpacing : itemTopSpacing
            ))
            emittedItemRow = true
            pendingChunk = []
        }

        for child in children {
            if case .list(let ordered, let start, _) = child.kind {
                // Make sure the item's marker row exists before its sub-list
                // (an item whose first child is a list still shows a marker).
                if !pendingChunk.isEmpty || !emittedItemRow {
                    flushChunk()
                }
                appendList(
                    ordered: ordered ?? false,
                    start: start,
                    items: child.children,
                    depth: depth + 1,
                    firstItemTopSpacing: intraItemSpacing,
                    rows: &rows
                )
            } else {
                pendingChunk.append(child)
            }
        }
        if !pendingChunk.isEmpty || !emittedItemRow {
            flushChunk()
        }
    }
}
