import SwiftUI

/// feature-ios-visual-redesign Phase 1 — one row inside a `CrowiCard`:
/// `display:flex;gap:13px;align-items:center;padding:13px 15px`, an optional
/// leading chip/avatar, and the design's trailing chevron.
///
/// Padding is deliberately NOT `@ScaledMetric`-scaled while the text inside
/// is: growing both at once turns a row into most of a screen at accessibility
/// sizes. What IS pinned is the 44pt minimum — the design's 13px-padded row
/// clears it only because its two/three text lines happen to be tall enough,
/// and a SINGLE-line row (the home's "Browse Pages") would land at ~40pt
/// without this floor.
public struct CrowiRow<Leading: View, Content: View>: View {
    private let showsChevron: Bool
    private let leading: Leading
    private let content: Content

    public init(
        showsChevron: Bool = true,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder content: () -> Content
    ) {
        self.showsChevron = showsChevron
        self.leading = leading()
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: CrowiMetrics.rowContentSpacing) {
            leading
            content
                .frame(maxWidth: .infinity, alignment: .leading)
            if showsChevron {
                CrowiRowChevron()
            }
        }
        .padding(.horizontal, CrowiMetrics.rowHorizontalPadding)
        .padding(.vertical, CrowiMetrics.rowVerticalPadding)
        .frame(minHeight: CrowiMetrics.minimumTapTarget)
        // Rows are `Button`/`NavigationLink` labels: without this the tap
        // target collapses onto the painted glyphs instead of spanning the
        // row (including the padding a 44pt floor just bought).
        .contentShape(Rectangle())
    }
}

extension CrowiRow where Leading == EmptyView {
    /// A row with no leading chip/avatar — a search hit, a bare list entry.
    /// `EmptyView` contributes no subview to the `HStack`, so this does not
    /// leave a phantom `gap:13px` at the leading edge.
    public init(showsChevron: Bool = true, @ViewBuilder content: () -> Content) {
        self.init(showsChevron: showsChevron, leading: { EmptyView() }, content: content)
    }
}

/// The design's trailing affordance: a 17px chevron stroked in
/// `var(--border)` at `stroke-width:2.4`.
///
/// An SF Symbol rather than a hand-drawn `Path`: it inherits the platform's
/// optical alignment and mirrors itself in right-to-left layouts, which a
/// literal transcription of the SVG would not. `border` (not
/// `mutedForeground`) is the design's stroke — the chevron is chrome, and
/// pushing it into text contrast would make every row shout.
public struct CrowiRowChevron: View {
    @ScaledMetric(relativeTo: .headline) private var glyphSize: CGFloat = 13

    public init() {}

    public var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: glyphSize, weight: .bold))
            .foregroundStyle(CrowiTheme.border)
            // The row's own label already says where it goes; VoiceOver
            // announcing "chevron" after it is pure noise.
            .accessibilityHidden(true)
    }
}

/// The design's leading icon chip: `34×34`, `border-radius:9px`,
/// `background:var(--muted)`, a centered `var(--muted-foreground)` glyph.
///
/// Scales with Dynamic Type (it sits beside text and would look increasingly
/// stunted next to it otherwise), and the corner radius is re-derived from
/// the scaled size so an enlarged chip stays the same squircle rather than
/// flattening into a rounded square.
public struct CrowiRowChip: View {
    /// What sits inside the chip: a system symbol, or the drawn artifact
    /// mark (`CrowiArtifactGlyph` — no system symbol has that shape).
    public enum Glyph: Sendable, Equatable {
        case systemImage(String)
        case artifact
    }

    private let glyph: Glyph
    @ScaledMetric(relativeTo: .headline) private var size: CGFloat = CrowiMetrics.leadingChipSize

    public init(systemImage: String) {
        self.glyph = .systemImage(systemImage)
    }

    public init(glyph: Glyph) {
        self.glyph = glyph
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: size * CrowiMetrics.leadingChipCornerRadiusRatio, style: .continuous)
            .fill(CrowiTheme.muted)
            .frame(width: size, height: size)
            .overlay {
                // Design: a 17px glyph inside the 34px chip.
                Group {
                    switch glyph {
                    case .systemImage(let name):
                        Image(systemName: name)
                            .font(.system(size: size * 0.5, weight: .medium))
                    case .artifact:
                        CrowiArtifactGlyph(size: size * 0.5)
                    }
                }
                .foregroundStyle(CrowiTheme.mutedForeground)
            }
            .accessibilityHidden(true)
    }
}
