import SwiftUI

/// A document's YAML frontmatter, drawn as the metadata it is rather than as
/// the prose the parser used to mistake it for.
///
/// Before the server started sending it as its own node, a frontmatter block
/// reached the reader as a rule, a paragraph and a list — and its values were
/// read as Markdown, so `*draft*` in a value arrived in italics. Every entry
/// here is literal text: the server scanned the block, it never parsed it.
///
/// Matches the web's `.crowi-frontmatter` — a muted panel with a primary
/// leading edge, monospaced, keys and values in two columns with a rule
/// between rows.
struct RenderedAstFrontmatterView: View {
    let entries: [RenderedAstFrontmatterEntry]

    private var metrics: CrowiBodyMetrics { CrowiBodyMetrics() }

    var body: some View {
        HStack(spacing: 0) {
            // The design's `border-left: 3px solid var(--primary)`.
            Rectangle()
                .fill(CrowiTheme.primary)
                .frame(width: 3)
            Grid(alignment: .topLeading, horizontalSpacing: metrics.tableColumnSpacing, verticalSpacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                    if index > 0 {
                        Divider().overlay(CrowiTheme.border)
                    }
                    GridRow {
                        Text(entry.key)
                            .font(.system(.footnote, design: .monospaced).weight(.bold))
                            .foregroundStyle(CrowiTheme.mutedForeground)
                            .gridColumnAlignment(.leading)
                        Text(entry.value)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(CrowiTheme.foreground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 8)
                }
            }
            .padding(.horizontal, 12)
        }
        .background(CrowiTheme.muted)
        .clipShape(RoundedRectangle(cornerRadius: CrowiTheme.cardCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CrowiTheme.cardCornerRadius, style: .continuous)
                .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
        }
    }
}
