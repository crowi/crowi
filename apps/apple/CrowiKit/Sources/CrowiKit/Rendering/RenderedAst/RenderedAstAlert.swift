import SwiftUI

/// GitHub Alerts (`> [!NOTE]` and its four siblings), drawn as callouts.
///
/// ## Why this reads a marker instead of a node type
///
/// The server has a typed `crowiAlert` node, but it is deliberately NOT in
/// the v1 closed union: a declared-v1 client receives an ordinary
/// `blockquote` with the author's marker still in place. That projection
/// exists so a client which knows nothing about alerts renders exactly what
/// it rendered before them — the marker as literal text — instead of losing
/// the whole quote to an opaque placeholder.
///
/// The consequence for a client that DOES want callouts is that the variant
/// arrives as text, so it is recognised here rather than read off a field.
/// The five markers are a closed set and the shape the transform emits is
/// fixed, which is what makes recognising it safe rather than a guess.
///
/// Mirrors the web's `withoutMarker` exactly, including its refusals: the
/// marker must be a paragraph's first child, and must be followed by the
/// line break that terminated it. Anything else is a shape the transform
/// never produces, so nothing is decorated — a hand-written `[!NOTE]` butted
/// against other text stays the quote the author wrote.
public enum RenderedAstAlertVariant: String, CaseIterable, Equatable, Sendable {
    case note, tip, important, warning, caution

    var marker: String { "[!\(rawValue)]" }

    /// The web's `ALERT_PRESENTATIONS`.
    var label: String {
        switch self {
        case .note: return "Note"
        case .tip: return "Tip"
        case .important: return "Important"
        case .warning: return "Warning"
        case .caution: return "Caution"
        }
    }

    /// SF Symbol counterparts of the web's lucide icons.
    var systemImage: String {
        switch self {
        case .note: return "info.circle"
        case .tip: return "lightbulb"
        case .important: return "exclamationmark.circle"
        case .warning: return "exclamationmark.triangle"
        case .caution: return "exclamationmark.octagon"
        }
    }

    /// The accent bar. Never used for the title: two of the five are not
    /// contrast-safe as text in the light theme, which is why the web keeps
    /// separate `--crowi-alert-*-foreground` tokens.
    var accent: Color {
        switch self {
        case .note: return CrowiTheme.primary
        case .tip: return CrowiTheme.success
        case .important: return CrowiTheme.important
        case .warning: return CrowiTheme.warning
        case .caution: return CrowiTheme.danger
        }
    }

    var titleColor: Color {
        switch self {
        case .note: return CrowiTheme.primary
        case .tip: return CrowiTheme.alertTipForeground
        case .important: return CrowiTheme.important
        case .warning: return CrowiTheme.alertWarningForeground
        case .caution: return CrowiTheme.danger
        }
    }
}

public enum RenderedAstAlert {
    /// The variant and the content with the marker removed, or `nil` when
    /// these children are an ordinary quote.
    public static func detect(children: [RenderedAstNode]) -> (variant: RenderedAstAlertVariant, content: [RenderedAstNode])? {
        guard let paragraph = children.first, case .paragraph = paragraph.kind,
              let marker = paragraph.children.first, case .text(let value) = marker.kind,
              let variant = RenderedAstAlertVariant.allCases.first(where: { $0.marker == value.lowercased() })
        else { return nil }

        let afterMarker = paragraph.children.dropFirst()
        // Marker alone in its paragraph — the body starts in a later block.
        if afterMarker.isEmpty { return (variant, Array(children.dropFirst())) }
        // The transform only ever emits the marker followed by the break the
        // line ending became. Anything else, decorate nothing.
        guard let separator = afterMarker.first, case .lineBreak = separator.kind else { return nil }
        let body = Array(afterMarker.dropFirst())
        if body.isEmpty { return (variant, Array(children.dropFirst())) }
        return (variant, [RenderedAstNode(kind: .paragraph, data: paragraph.data, children: body)] + children.dropFirst())
    }
}

/// Unboxed, as the web draws it: the accent bar alone marks the region. A
/// filled card would pull more attention than a note deserves, and would
/// fight the frontmatter panel above it for the reader's eye.
struct RenderedAstAlertView: View {
    let variant: RenderedAstAlertVariant
    let content: [RenderedAstNode]
    let context: RenderedAstRenderContext

    private var metrics: CrowiBodyMetrics { CrowiBodyMetrics() }

    var body: some View {
        HStack(alignment: .top, spacing: metrics.blockquoteGutter) {
            Rectangle()
                .fill(variant.accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: metrics.paragraphSegmentSpacing) {
                Label(variant.label, systemImage: variant.systemImage)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(variant.titleColor)
                // The body keeps ordinary prose styling — links and inline
                // formatting inside must look like they do anywhere else.
                RenderedAstBlockSequence(nodes: content, context: context)
            }
        }
    }
}
