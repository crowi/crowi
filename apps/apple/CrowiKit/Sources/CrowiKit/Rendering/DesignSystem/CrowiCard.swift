import SwiftUI

/// feature-ios-visual-redesign Phase 1 — the design's grouped-content
/// container: `background:var(--card)`, `.5px solid var(--border)`,
/// `border-radius:16px`, `overflow:hidden`, `margin:0 16px`.
///
/// Replaces SwiftUI's `List`/`Section` chrome on every screen the design
/// covers. `List` is not styled into this shape: its grouped background,
/// separator insets and row insets are all system-owned, and fighting each
/// of them back is more code (and more version-fragile) than owning the
/// container outright. The screens therefore host a `ScrollView` +
/// `LazyVStack` and put their rows inside one of these.
///
/// `overflow:hidden` is `clipShape`, and the outline is `strokeBorder`
/// (INSIDE the shape) rather than `stroke` (centered on the path, i.e. half
/// of it clipped away) — a hairline drawn the other way loses half its
/// already-sub-pixel width and disappears on some scales.
public struct CrowiCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CrowiTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: CrowiTheme.cardCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CrowiTheme.cardCornerRadius, style: .continuous)
                .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
        }
        .padding(.horizontal, CrowiMetrics.cardHorizontalMargin)
    }
}

/// One hairline between two card rows.
///
/// The design writes `border-top:.5px solid var(--border)` on EVERY row
/// including the first, and relies on the card's `overflow:hidden` to clip
/// the first one away against the rounded corner. That is a CSS trick, not
/// the intent: the intent is separators BETWEEN rows. `CrowiCardRows`
/// reproduces the visual result directly by emitting this view between
/// consecutive rows and never before the first — which is also what keeps a
/// single-row card (the home's "Browse Pages") from growing a stray line.
public struct CrowiRowSeparator: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(CrowiTheme.border)
            .frame(height: CrowiTheme.hairline)
            .accessibilityHidden(true)
    }
}

/// A `CrowiCard` filled from a collection, with a `CrowiRowSeparator`
/// interleaved between consecutive rows.
///
/// The separator gate compares each element's identity against the FIRST
/// element's rather than tracking an index: `ForEach` already requires the
/// id to be unique, so "is this the first row" is exactly "does my id equal
/// the head's", and it stays correct when the collection is re-assigned
/// mid-scroll (a refresh replacing the array) where a captured index would
/// not.
public struct CrowiCardRows<Data: RandomAccessCollection, ID: Hashable, RowContent: View>: View {
    private let data: Data
    private let id: KeyPath<Data.Element, ID>
    private let row: (Data.Element) -> RowContent

    public init(_ data: Data, id: KeyPath<Data.Element, ID>, @ViewBuilder row: @escaping (Data.Element) -> RowContent) {
        self.data = data
        self.id = id
        self.row = row
    }

    public var body: some View {
        CrowiCard {
            ForEach(data, id: id) { element in
                if let head = data.first, head[keyPath: id] != element[keyPath: id] {
                    CrowiRowSeparator()
                }
                row(element)
            }
        }
    }
}

extension CrowiCardRows where Data.Element: Identifiable, ID == Data.Element.ID {
    public init(_ data: Data, @ViewBuilder row: @escaping (Data.Element) -> RowContent) {
        self.init(data, id: \.id, row: row)
    }
}
