import SwiftUI

/// feature-ios-visual-redesign Phase 1 — the SPACING half of the design
/// language, the counterpart to `CrowiTheme`'s color half.
///
/// The design (a 390×844 HTML/CSS iPhone frame) states every dimension in
/// CSS pixels. At 1x an iOS point IS a CSS pixel, so these constants carry
/// the design's numbers verbatim — but they are *base* values, not final
/// ones: the views below feed the ones that must track text size through
/// `@ScaledMetric`, so a row grows with Dynamic Type instead of trapping
/// larger text inside a fixed-height box. (`CrowiTheme` already owns the two
/// corner radii, `cardCornerRadius`/`controlCornerRadius`, and the hairline
/// width — they are colors' close relatives and were part of that contract
/// first; they are not duplicated here.)
public enum CrowiMetrics {
    // MARK: - Card

    /// The gutter between a card's edge and the screen's (design: `margin:0 16px`).
    public static let cardHorizontalMargin: CGFloat = 16
    /// Air under the last card so the final row does not sit flush against
    /// whatever is below it (design: the screen's own `padding:… 0 104px`).
    /// This is ONLY the breathing room: the floating tab bar's own share of
    /// those 104px is not added here but taken by the bar itself, as a
    /// `safeAreaInset` — a screen inside a tab is inset by the real bar
    /// height (which grows with Dynamic Type) instead of by a constant that
    /// would have to be kept in sync with it.
    public static let screenBottomPadding: CGFloat = 24

    // MARK: - Row

    /// Design: `padding:13px 15px`.
    public static let rowVerticalPadding: CGFloat = 13
    public static let rowHorizontalPadding: CGFloat = 15
    /// Design: `gap:13px` between a row's leading chip/avatar and its text.
    public static let rowContentSpacing: CGFloat = 13
    /// Design: `margin-top:3px` between a row's title, path and meta lines.
    public static let rowLineSpacing: CGFloat = 3
    /// The HIG minimum tap target. The design's 13px-padded row clears it at
    /// the default text size only because the two/three text lines inside it
    /// are tall enough; a single-line row (`Browse Pages`) would not, so
    /// `CrowiRow` enforces it explicitly.
    public static let minimumTapTarget: CGFloat = 44

    // MARK: - Leading chip / avatar

    /// Design: `width:34px;height:34px` for both the icon chip and the page
    /// row's avatar.
    public static let leadingChipSize: CGFloat = 34
    /// Design: `border-radius:9px` on the 34px chip. Applied as a RATIO of
    /// the (scaled) chip size at the call site so a chip enlarged by Dynamic
    /// Type keeps the same squircle-ness instead of turning into a rounded
    /// square.
    public static let leadingChipCornerRadiusRatio: CGFloat = 9 / 34

    // MARK: - Screen chrome

    /// Design: section headers and the large screen title are inset `20px`,
    /// i.e. 4pt further in than the cards they sit above.
    public static let screenHorizontalMargin: CGFloat = 20
    /// Design: `padding:16px 20px 8px` on a section header.
    public static let sectionHeaderTopPadding: CGFloat = 16
    public static let sectionHeaderBottomPadding: CGFloat = 8
    /// Design: `margin:10px 20px 2px` on the large screen title.
    public static let screenTitleTopPadding: CGFloat = 10
    public static let screenTitleBottomPadding: CGFloat = 2

    // MARK: - Search field

    /// Design: `padding:9px 12px;gap:8px` inside the `--muted` pill.
    public static let searchFieldVerticalPadding: CGFloat = 9
    public static let searchFieldHorizontalPadding: CGFloat = 12
    public static let searchFieldContentSpacing: CGFloat = 8

    // MARK: - Tab bar (the design's "Liquid Glass" variant)

    /// Design: the floating pill is inset `left:14px;right:14px`.
    public static let tabBarHorizontalInset: CGFloat = 14
    /// Design: `bottom:26px` — measured from the DEVICE edge, i.e. through
    /// the home-indicator strip the design draws at `bottom:8px`. iOS states
    /// that same clearance as the bottom safe area, which is where the bar is
    /// anchored instead (`safeAreaInset(edge:.bottom)`), so this is the gap
    /// ABOVE the safe area rather than above the glass. Keeping the literal
    /// 26 would either collide with the home indicator on a notched phone or
    /// sit flush against the screen edge on one without.
    public static let tabBarBottomInset: CGFloat = 8
    /// Design: `padding:7px 6px 8px` inside the pill.
    public static let tabBarInnerHorizontalPadding: CGFloat = 6
    public static let tabBarInnerTopPadding: CGFloat = 7
    public static let tabBarInnerBottomPadding: CGFloat = 8
    /// Design: `gap:3px` between a tab's glyph and its label.
    public static let tabBarItemSpacing: CGFloat = 3
    /// Design: a 26px stroked SVG. An SF Symbol at point size N has roughly
    /// N of cap height inside a taller box, so the same optical weight lands
    /// a couple of points lower than the CSS number.
    public static let tabBarGlyphSize: CGFloat = 24
    /// Design: the 40px circular "New" FAB (glass variant — the standard
    /// variant's 52px raised button is not the one this app ships).
    public static let tabBarCreateButtonSize: CGFloat = 40
}

/// The TYPE half of the design language.
///
/// Every entry is a **relative** text style (`Font.system(_ style:…)`), never
/// a fixed `Font.system(size:)` — a hard-coded 16pt that ignores the user's
/// Dynamic Type setting is an accessibility regression, and the design's
/// value is its hierarchy (hero / path / meta / header), not the exact pixel
/// height of each step. The comment on each line records the design's literal
/// size so a future reader can check the mapping rather than guess at it.
///
/// Deliberately NOT applied to `RenderedAstView` and the markdown body: that
/// type scale was tuned in RFC-0023 against real wiki content and is not part
/// of this design pass. Only the chrome AROUND a rendered body uses these.
public enum CrowiTypography {
    /// Design: 33px/800, `letter-spacing:-.02em`. iOS's `.largeTitle` is 34pt
    /// at the default size — the same step, and it scales.
    public static let screenTitle = Font.system(.largeTitle, design: .default, weight: .heavy)
    /// Design: 15px, `var(--muted-foreground)` — the line under the title.
    public static let screenSubtitle = Font.system(.subheadline)
    /// Design: 13px/600 uppercase, `letter-spacing:.04em`.
    public static let sectionHeader = Font.system(.footnote, design: .default, weight: .semibold)
    /// Design: 14px `var(--primary)` — a section header's trailing link.
    public static let sectionAction = Font.system(.subheadline)
    /// Design: 16px/600, `line-height:1.3`, single-line ellipsis.
    public static let rowTitle = Font.system(.headline, design: .default, weight: .semibold)
    /// Design: 12.5px MONOSPACE, `var(--muted-foreground)`.
    public static let rowPath = Font.system(.caption, design: .monospaced)
    /// Design: 12.5px, `var(--muted-foreground)` — "author · time".
    public static let rowMeta = Font.system(.caption)
    /// Design: 13.5px, `line-height:1.55` — a search hit's snippet.
    public static let snippet = Font.system(.footnote)
    /// Design: 16px — the search field's own input text.
    public static let searchInput = Font.system(.body)
    /// Design: 10.5px/500 — a tab's label under its glyph. `.caption2` is the
    /// smallest step in the scale, which is what a tab label is.
    public static let tabLabel = Font.system(.caption2, design: .default, weight: .medium)

    /// Design: `letter-spacing:-.02em` at 33px ≈ -0.66pt. Tracking is an
    /// absolute point value in SwiftUI (it does not scale with Dynamic Type),
    /// which is fine at this magnitude — it is an optical correction for the
    /// heavy weight, not part of the hierarchy.
    public static let screenTitleTracking: CGFloat = -0.66
    /// Design: `letter-spacing:.04em` at 13px ≈ 0.52pt — what makes the
    /// uppercase section header read as a label rather than as shouting.
    public static let sectionHeaderTracking: CGFloat = 0.52
}
