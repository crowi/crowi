import Foundation
import SwiftMath
import SwiftUI

#if canImport(UIKit)
import UIKit
typealias PlatformColor = UIColor
#elseif canImport(AppKit)
import AppKit
typealias PlatformColor = NSColor
#endif

/// RFC-0023 Phase 5 — synchronous native TeX typesetting for the `math` /
/// `inlineMath` nodes (the TeX source the `crowiMath` sidecar restored,
/// parent spec design judgment 9). SwiftMath composes entirely on the
/// calling thread from bundled fonts — no network, no async — which is
/// exactly the shape the revised SSR contract permits on the client.
///
/// Failure contract (architectural pin): typesetting failure (an
/// unsupported TeX command, a malformed group) NEVER silently drops the
/// node — the caller degrades to a monospaced rendering of the TeX source
/// itself, so the reader can still read the content, and the TeX source is
/// always the accessibility label (an image of glyphs carries no text).
public struct RenderedAstMathRendering {
    public let image: PlatformImage
    /// The typeset line's descent below the baseline, in points — inline
    /// runs shift the image down by this much so the math baseline sits on
    /// the surrounding text's baseline.
    public let descent: CGFloat
}

public enum RenderedAstMathTypesetter {
    /// The block (`math`, display style) font size — matches the reading
    /// body scale the surrounding `RenderedAstView` text uses.
    public static let displayFontSize: CGFloat = 19
    /// The inline (`inlineMath`) font size — matches SwiftUI `.body`.
    public static let inlineFontSize: CGFloat = 17

    /// Synchronously typeset `tex`. Returns `nil` when SwiftMath cannot
    /// parse/lay out the source — the caller MUST show the TeX source
    /// visibly instead (never drop, never crash).
    public static func typeset(tex: String, display: Bool, isDark: Bool) -> RenderedAstMathRendering? {
        var mathImage = MathImage(
            latex: tex,
            fontSize: display ? displayFontSize : inlineFontSize,
            textColor: textColor(isDark: isDark),
            labelMode: display ? .display : .text,
            textAlignment: .left
        )
        let (error, image, layout) = mathImage.asImage()
        guard error == nil, let image else { return nil }
        return RenderedAstMathRendering(image: image, descent: layout?.descent ?? 0)
    }

    /// The rendered glyph color per color scheme. The raster is a static
    /// image, so the active scheme is resolved BEFORE typesetting (the
    /// views re-typeset when `\.colorScheme` flips) — mirroring how the
    /// shiki `code` path picks one of its two baked themes.
    static func textColor(isDark: Bool) -> PlatformColor {
        isDark ? .white : .black
    }
}

/// The block `math` node — display-style, centered (web parity with
/// KaTeX's `.katex-display`). Degrades to a monospaced TeX box.
struct RenderedAstMathBlockView: View {
    let tex: String

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let rendering = RenderedAstMathTypesetter.typeset(tex: tex, display: true, isDark: colorScheme == .dark) {
            // Cap at the intrinsic typeset width (never upscale), shrink
            // aspect-preserved into narrower columns, center like the web's
            // `.katex-display`.
            Image(platformImage: rendering.image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: rendering.image.size.width)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityLabel(Text(tex))
        } else {
            // Visible degrade: the TeX source in a monospaced box — the
            // reader can still read (and copy) the content.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(tex)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
            .accessibilityLabel(Text(tex))
        }
    }
}
