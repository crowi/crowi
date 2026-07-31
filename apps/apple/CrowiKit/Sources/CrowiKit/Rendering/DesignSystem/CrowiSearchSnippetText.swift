import SwiftUI

/// feature-ios-visual-redesign Phase 1 — a search hit's snippet with the
/// matched terms highlighted, the design's
/// `<mark style="background:oklch(.86 .13 184);color:oklch(.3 .06 192);font-weight:600">`.
///
/// The hit positions are real data, not invented: the search driver wraps
/// them in `<mark>` and `SearchHitLenient.snippetSegments(_:)` segments them
/// into plain runs. Nothing here parses or renders markup — the runs are
/// `String`s placed into an `AttributedString`, so the untrusted snippet
/// never reaches anything that could interpret it.
///
/// The design's `border-radius:3px;padding:0 3px` on the mark has no
/// `AttributedString` equivalent (run backgrounds are rectangular and
/// tight); the fill, the contrasting foreground and the weight bump all
/// carry over, which is what makes the hit findable at a glance.
public struct CrowiSearchSnippetText: View {
    private let rawSnippet: String
    private let lineLimit: Int?

    public init(rawSnippet: String, lineLimit: Int? = 3) {
        self.rawSnippet = rawSnippet
        self.lineLimit = lineLimit
    }

    /// The snippet as styled runs. `static` so it is exercised directly by
    /// tests and reusable by any future snippet surface without duplicating
    /// the highlight styling.
    public static func attributedSnippet(_ rawSnippet: String) -> AttributedString {
        var result = AttributedString()
        for segment in SearchHitLenient.snippetSegments(rawSnippet) {
            var run = AttributedString(segment.text)
            if segment.isHighlighted {
                run.backgroundColor = CrowiTheme.searchHighlight
                run.foregroundColor = CrowiTheme.searchHighlightForeground
                // The design's `font-weight:600` — expressed as an intent
                // rather than a concrete `Font` so the run inherits the
                // Dynamic Type size of the surrounding text instead of
                // pinning itself to a fixed one.
                run.inlinePresentationIntent = .stronglyEmphasized
            }
            result.append(run)
        }
        return result
    }

    public var body: some View {
        Text(Self.attributedSnippet(rawSnippet))
            .font(CrowiTypography.snippet)
            .foregroundStyle(CrowiTheme.mutedForeground)
            .lineLimit(lineLimit)
            .lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
