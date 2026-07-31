import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Crowi's semantic color tokens, mirrored from the "Crowi iOS app design"
/// Claude Design project's design system (`_ds_bundle.css`).
///
/// The source of truth is a set of `oklch()` values on a single hue (192 —
/// Crowi's teal), with a complete light and dark pair for every role. They are
/// converted to sRGB and duplicated here by hand rather than generated: the
/// palette changes rarely, and a build-time bridge across the pnpm/SwiftPM
/// island boundary (§10) would cost far more than it saves. Update BOTH places
/// when the palette shifts.
///
/// Note on `primary`: the design system's light primary converts to `#3E615F`,
/// a hair darker and less blue than the legacy `--crowi-primary: #43676b` this
/// file used to carry alone. The design system's value wins because it is not a
/// standalone brand color — `muted`, `accent`, `border` and `ring` are all
/// derived from the same hue and chroma family, so pinning `primary` back to
/// the old hex would leave it subtly out of step with everything around it.
///
/// Every token is an ADAPTIVE color: it resolves against the rendering
/// context's light/dark trait, so call sites never branch on `colorScheme`
/// themselves. That is what keeps dark mode a property of the palette rather
/// than something each view has to remember.
public enum CrowiTheme {
    // MARK: - Brand / interactive

    /// The teal that identifies Crowi. Applied once as the root `.tint(_:)` in
    /// `CrowiApp`, so links, buttons, SF Symbol accents and selection
    /// checkmarks all inherit it instead of iOS's default blue.
    public static let primary = adaptive(light: (0.2442, 0.3795, 0.3730), dark: (0.2175, 0.7301, 0.7146))
    /// Content drawn ON `primary` (a filled button's label, the FAB's glyph).
    public static let primaryForeground = adaptive(light: (0.9803, 0.9803, 0.9803), dark: (0.0329, 0.0575, 0.0561))
    /// Focus/selection ring. Same hue as `primary`, lightened in dark mode so
    /// it stays visible against `background` rather than merging into it.
    public static let ring = adaptive(light: (0.2442, 0.3795, 0.3730), dark: (0.3048, 0.4829, 0.4745))

    // MARK: - Surfaces

    /// The page canvas behind everything.
    public static let background = adaptive(light: (1, 1, 1), dark: (0.0260, 0.0491, 0.0478))
    /// Grouped-content surface — the rounded card that list rows sit inside.
    /// Identical to `background` in light mode (the card is separated by its
    /// border, not by fill) and *lighter* than it in dark mode, which is the
    /// usual dark-UI inversion: elevation reads as lightness, not as shadow.
    public static let card = adaptive(light: (1, 1, 1), dark: (0.0548, 0.0951, 0.0931))
    /// Sheets and popovers. Tracks `card`.
    public static let popover = adaptive(light: (1, 1, 1), dark: (0.0548, 0.0951, 0.0931))
    /// Recessed fill: search fields, icon chips, segmented backgrounds.
    public static let muted = adaptive(light: (0.9470, 0.9653, 0.9640), dark: (0.0995, 0.1412, 0.1389))
    /// Tinted fill for selected/active states — `muted` with the brand hue
    /// pushed up.
    public static let accent = adaptive(light: (0.8545, 0.9095, 0.9058), dark: (0.1203, 0.1958, 0.1920))

    // MARK: - Content

    /// Primary text.
    public static let foreground = adaptive(light: (0.0861, 0.0861, 0.0861), dark: (0.9345, 0.9345, 0.9345))
    /// Text on `card`. Tracks `foreground`.
    public static let cardForeground = adaptive(light: (0.0861, 0.0861, 0.0861), dark: (0.9345, 0.9345, 0.9345))
    /// Secondary text: paths, timestamps, section headers, placeholder copy.
    public static let mutedForeground = adaptive(light: (0.3338, 0.3338, 0.3338), dark: (0.6205, 0.6205, 0.6205))
    /// Text on `accent`.
    public static let accentForeground = adaptive(light: (0.1155, 0.1908, 0.1871), dark: (0.9345, 0.9345, 0.9345))
    /// Destructive actions and error states.
    public static let destructive = adaptive(light: (0.7304, 0.1668, 0.1811), dark: (0.8725, 0.2322, 0.2404))

    // MARK: - Lines

    /// Hairline separators and card outlines. Drawn at `hairline` width, NOT
    /// at 1pt — the design specifies .5px, and on a 2x/3x screen a true
    /// hairline is what keeps a dense list from looking ruled.
    public static let border = adaptive(light: (0.8174, 0.8534, 0.8509), dark: (0.1339, 0.1927, 0.1895))

    // MARK: - Search highlight

    /// The fill behind a matched term inside a search snippet — the design's
    /// `<mark>` treatment (`oklch(0.86 0.13 184)`), the ONE color in the
    /// design that is not already a named role in the design system's token
    /// set. Added here rather than inlined at the call site so the light/dark
    /// pair lives with every other adaptive color.
    ///
    /// The dark value is NOT in the exported design (its `<mark>` rule is a
    /// single light-mode inline style). It is derived on the same hue —
    /// `oklch(0.48 0.07 184)` — with the lightness inverted, the same
    /// elevation-reads-as-lightness inversion `card` makes against
    /// `background`: a highlight has to be *lighter* than its surroundings in
    /// light mode and *darker*-but-more-saturated in dark mode to read as a
    /// highlight rather than as a hole.
    public static let searchHighlight = adaptive(light: (0.3292, 0.9275, 0.8568), dark: (0.1455, 0.4173, 0.3842))
    /// Text drawn ON `searchHighlight` — the design's `oklch(0.3 0.06 192)`
    /// in light mode (whose red channel is outside sRGB and clamps to 0,
    /// exactly as a browser's gamut mapping would land it), and
    /// `oklch(0.95 0.03 192)` in dark. Both keep a matched term legible
    /// against the fill above without borrowing `foreground`, which would
    /// disappear into the light fill.
    public static let searchHighlightForeground = adaptive(light: (0, 0.2153, 0.2098), dark: (0.8496, 0.9622, 0.9551))

    // MARK: - Metrics

    /// Corner radius for cards and grouped containers (design: 16px).
    public static let cardCornerRadius: CGFloat = 16
    /// Corner radius for inset controls — search fields, chips (design: 12px).
    public static let controlCornerRadius: CGFloat = 12
    /// One device pixel. `border` is stroked at this width so a separator
    /// reads as a line rather than as a bar.
    public static var hairline: CGFloat {
        #if canImport(UIKit)
        return 1 / max(UIScreen.main.scale, 1)
        #else
        return 0.5
        #endif
    }

    // MARK: - Construction

    /// Build a light/dark adaptive `Color` from two sRGB triples.
    ///
    /// Resolution happens per render against the ambient trait collection, so
    /// a single static token serves both appearances — no `@Environment`
    /// plumbing and no duplicate token names at the call site.
    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        #if canImport(UIKit)
        return Color(
            UIColor { traits in
                let c = traits.userInterfaceStyle == .dark ? dark : light
                return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
            }
        )
        #elseif canImport(AppKit)
        return Color(
            NSColor(name: nil) { appearance in
                let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                let c = isDark ? dark : light
                return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
            }
        )
        #else
        return Color(red: light.0, green: light.1, blue: light.2)
        #endif
    }
}
