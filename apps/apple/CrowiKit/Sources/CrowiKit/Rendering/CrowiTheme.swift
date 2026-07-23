import SwiftUI

/// Crowi's brand tokens, mirrored from the web theme
/// (`packages/web/src/app/globals.css` — the `--crowi-*` custom properties).
/// Values are duplicated by hand, not generated: the web tokens change rarely
/// and a build-time bridge across the pnpm/SwiftPM island boundary (§10)
/// would cost far more than it saves. Update BOTH places when the palette
/// shifts.
public enum CrowiTheme {
    /// `--crowi-primary: #43676b` — the muted teal that identifies Crowi.
    /// Applied once as the root `.tint(_:)` in `CrowiApp`, so every
    /// interactive element (links, buttons, SF Symbol accents, selection
    /// checkmarks) inherits it instead of iOS's default blue — the single
    /// cheapest step away from the stock file-browser look while staying
    /// fully native.
    public static let primary = Color(red: 0x43 / 255.0, green: 0x67 / 255.0, blue: 0x6B / 255.0)
}
