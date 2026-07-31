import Foundation
import SwiftUI

/// RFC-0023 Phase 4/5 — phrasing-content composition: a validated phrasing
/// node list → a sequence of pieces (attributed-text runs interleaved with
/// synchronously-typeset inline-math images, Phase 5) plus the
/// paragraph-level accessibility label the emoji a11y decoration and math
/// runs feed — pure and SwiftUI-host-free so every rule here is
/// unit-testable.
public struct RenderedAstInlineResult: Equatable {
    public enum Piece: Equatable {
        case attributed(AttributedString)
        /// A successfully typeset `inlineMath` run — composed into the
        /// surrounding `Text` as a baseline-aligned inline image. (A FAILED
        /// typeset never produces this piece: it degrades to a monospaced
        /// TeX chip inside an `.attributed` piece instead.)
        case math(RenderedAstInlineMathRun)
    }

    public var pieces: [Piece]
    /// Non-nil when at least one emoji run carried an `ariaLabel` or an
    /// inline-math image rendered — the paragraph then exposes this as its
    /// accessibility label (the emoji glyph / math image is replaced by its
    /// label / TeX source for assistive tech), mirroring the web's
    /// `role="img"` + `aria-label` span.
    public var accessibilityLabel: String?

    /// The concatenation of the attributed pieces — the pre-Phase-5 shape,
    /// still what every text-only rule asserts against.
    public var attributed: AttributedString {
        pieces.reduce(into: AttributedString()) { out, piece in
            if case .attributed(let run) = piece { out += run }
        }
    }

    /// The typeset inline-math runs, in order.
    public var mathRuns: [RenderedAstInlineMathRun] {
        pieces.compactMap { if case .math(let run) = $0 { return run } else { return nil } }
    }
}

/// One typeset `inlineMath` run (Phase 5).
public struct RenderedAstInlineMathRun: Equatable {
    public let tex: String
    public let image: PlatformImage
    /// Negative shift (the typeset line's descent) so the math baseline
    /// sits on the surrounding text's baseline.
    public let baselineOffset: CGFloat
}

/// How a `link` node coming out of the server pipeline should behave —
/// derived from `data.hProperties.className` (the stamps
/// `core/mentions.ts` / `core/wikilinks.ts` put on the wire; see
/// `golden-corpus/inline.json`) plus the URL shape.
public enum RenderedAstLinkKind: Equatable {
    /// `className == "mention"` — routes to `onNavigateToMention`.
    case mention(username: String)
    /// `className == "wikilink-broken"` (url is `#`) — rendered visibly
    /// broken, never navigable.
    case brokenWikiLink
    /// Everything else: a plain link (relative → in-app, absolute → system
    /// via `SchemeAllowlist`, `#fragment` → heading anchor).
    case standard(url: String)
}

/// How an `inlineCode` run is drawn — resolved by the hosting view, because
/// the right answer depends on the type it sits in.
///
/// ## Why there is no background box any more
///
/// A run's `backgroundColor` in an `AttributedString` fills the whole LINE BOX
/// (full ascent to full descent) and cannot be inset or padded. On a Crowi page
/// that is not an occasional accent: the content is Japanese prose carrying
/// several code spans per line (`packages/web`, `revision.renderedAst`, path
/// fragments), and a run of fills at line-box height against CJK glyphs — which
/// have no ascenders or descenders and therefore sit well inside that box —
/// turns a paragraph into horizontal stripes. Plain-Japanese paragraphs read
/// visibly calmer than code-dense ones on the same screen for no reason other
/// than this.
///
/// So body code is distinguished by TYPE instead of by fill: monospaced, and a
/// touch smaller than the text around it so it sits level with the CJK rather
/// than looming over it. It keeps the body's own colour on purpose — a
/// `mutedForeground` variant was rendered and rejected, because on this content
/// code IS the substance of the sentence and greying it out turned code-dense
/// paragraphs into washed-out holes in the page.
///
/// The fill is what made the rhythm uneven, and dropping it also fixes the
/// other half of the problem: a fill cannot look broken when a long token wraps
/// across a line end if there is no fill (a wrapped `crowi.config.json` in a
/// heading used to leave two separate half-boxes).
public enum RenderedAstInlineCodeStyle: Equatable {
    /// Inline code inside BODY text — explicitly sized at
    /// `CrowiBodyMetrics.inlineCodeSize`, so it sits level with the Japanese
    /// around it rather than a step above it.
    case body
    /// Inline code inside a HEADING — keeps the heading's own size. A
    /// body-sized run inside a 28pt title reads as a mistake, and at heading
    /// weight the monospace is already all the contrast it needs.
    case heading

    /// The explicit run font, or `nil` to inherit the surrounding text's size.
    /// The `.code` presentation intent makes the run monospaced either way.
    var font: Font? {
        switch self {
        case .body: return .system(size: CrowiBodyMetrics().inlineCodeSize, design: .monospaced)
        case .heading: return nil
        }
    }
}

public struct RenderedAstInlineRenderer {
    let definitions: [String: RenderedAstDefinition]
    /// The active color scheme, resolved by the hosting view — inline math
    /// rasterizes to a static image, so the glyph color must be picked
    /// before typesetting (`RenderedAstMathTypesetter.textColor`).
    let mathIsDark: Bool
    /// How `inlineCode` runs (and the `[…]` degrade chips, which are code-like
    /// by the same rule) are drawn.
    let codeStyle: RenderedAstInlineCodeStyle

    public init(
        definitions: [String: RenderedAstDefinition] = [:],
        mathIsDark: Bool = false,
        codeStyle: RenderedAstInlineCodeStyle = .body
    ) {
        self.definitions = definitions
        self.mathIsDark = mathIsDark
        self.codeStyle = codeStyle
    }

    // MARK: - link classification (pure)

    public static func classifyLink(url: String, classNames: [String]) -> RenderedAstLinkKind {
        if classNames.contains("wikilink-broken") { return .brokenWikiLink }
        if classNames.contains("mention"), let username = mentionUsername(fromURL: url) {
            return .mention(username: username)
        }
        return .standard(url: url)
    }

    /// `core/mentions.ts` stamps `url: "/user/<username>"`.
    static func mentionUsername(fromURL url: String) -> String? {
        let prefix = "/user/"
        guard url.hasPrefix(prefix) else { return nil }
        let username = String(url.dropFirst(prefix.count))
        guard !username.isEmpty, !username.contains("/") else { return nil }
        return username
    }

    /// A tappable URL for the `.link` run. Non-ASCII paths (CJK wikilink
    /// targets, CJK heading anchors) are percent-encoded here and decoded
    /// again by `RenderedAstView`'s `openURL` interceptor before the
    /// navigation closures see them.
    static func linkURL(for target: String) -> URL? {
        if let url = URL(string: target) { return url }
        var allowed = CharacterSet.urlPathAllowed
        allowed.formUnion(.urlQueryAllowed)
        allowed.formUnion(.urlFragmentAllowed)
        allowed.insert(charactersIn: "#?")
        guard let escaped = target.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: escaped)
    }

    // MARK: - rendering

    public func render(_ nodes: [RenderedAstNode]) -> RenderedAstInlineResult {
        var builder = Builder()
        appendNodes(nodes, style: Style(), into: &builder)
        builder.flushAttributed()
        return RenderedAstInlineResult(
            pieces: builder.pieces,
            accessibilityLabel: builder.needsAccessibilityLabel ? builder.labelParts.joined() : nil
        )
    }

    private struct Style {
        var intents: InlinePresentationIntent = []
        var linkURL: URL?
        var isBroken = false
        var isMention = false
    }

    private struct Builder {
        var pieces: [RenderedAstInlineResult.Piece] = []
        var attributed = AttributedString()
        var labelParts: [String] = []
        /// Set by emoji a11y decorations AND typeset math images — both
        /// replace visible content with something assistive tech cannot
        /// read directly.
        var needsAccessibilityLabel = false

        mutating func flushAttributed() {
            guard !attributed.characters.isEmpty else { return }
            pieces.append(.attributed(attributed))
            attributed = AttributedString()
        }

        mutating func appendMath(_ run: RenderedAstInlineMathRun) {
            flushAttributed()
            pieces.append(.math(run))
            labelParts.append(run.tex)
            needsAccessibilityLabel = true
        }
    }

    private func appendNodes(_ nodes: [RenderedAstNode], style: Style, into builder: inout Builder) {
        for node in nodes {
            appendNode(node, style: style, into: &builder)
        }
    }

    private func appendNode(_ node: RenderedAstNode, style: Style, into builder: inout Builder) {
        switch node.kind {
        case .text(let value):
            if let data = node.data, data.hName == "span", data.hPropertyString("role") == "img",
                let ariaLabel = data.hPropertyString("ariaLabel") {
                builder.needsAccessibilityLabel = true
                builder.labelParts.append(ariaLabel)
                appendRun(value, style: style, into: &builder, labelAlreadyRecorded: true)
            } else {
                appendRun(value, style: style, into: &builder)
            }
        case .lineBreak:
            appendRun("\n", style: style, into: &builder)
        case .inlineCode(let value):
            var codeStyle = style
            codeStyle.intents.insert(.code)
            appendRun(value, style: codeStyle, into: &builder)
        case .emphasis:
            var next = style
            next.intents.insert(.emphasized)
            appendNodes(node.children, style: next, into: &builder)
        case .strong:
            var next = style
            next.intents.insert(.stronglyEmphasized)
            appendNodes(node.children, style: next, into: &builder)
        case .delete:
            var next = style
            next.intents.insert(.strikethrough)
            appendNodes(node.children, style: next, into: &builder)
        case .link(let url, _):
            appendLink(url: url, classNames: node.data?.classNames ?? [], children: node.children, style: style, into: &builder)
        case .linkReference(let identifier, _, _):
            if let definition = definitions[identifier] {
                appendLink(url: definition.url, classNames: [], children: node.children, style: style, into: &builder)
            } else {
                appendNodes(node.children, style: style, into: &builder)
            }
        case .footnoteReference(let identifier, let label):
            var footnoteStyle = style
            footnoteStyle.intents.insert(.emphasized)
            var run = AttributedString("[\(label ?? identifier)]")
            run.font = .caption
            run.baselineOffset = 4
            applyDecorations(&run, style: footnoteStyle)
            builder.attributed += run
            builder.labelParts.append("[\(label ?? identifier)]")
        case .image(_, let alt, _):
            // Inside pure inline contexts (table cells, headings) an image
            // degrades to a visible alt chip — paragraphs route images to
            // the block image path before this renderer ever sees them.
            appendChip(alt.flatMap { $0.isEmpty ? nil : $0 } ?? "image", style: style, into: &builder)
        case .imageReference(_, _, _, let alt):
            appendChip(alt.flatMap { $0.isEmpty ? nil : $0 } ?? "image", style: style, into: &builder)
        case .html:
            appendChip(RenderedAstPlaceholderCopy.inlineUnavailable, style: style, into: &builder)
        case .inlineMath(let value, _):
            // Phase 5 — synchronous typesetting from the TeX source; failure
            // degrades to a monospaced chip OF THE TEX SOURCE (readable
            // content, never a generic "unavailable" and never a drop).
            if let rendering = RenderedAstMathTypesetter.typeset(tex: value, display: false, isDark: mathIsDark) {
                builder.appendMath(RenderedAstInlineMathRun(
                    tex: value,
                    image: rendering.image,
                    baselineOffset: -rendering.descent
                ))
            } else {
                appendChip(value, style: style, into: &builder)
            }
        case .crowiPlaceholder(let kind, let label, _):
            appendChip(RenderedAstPlaceholderCopy.placeholderLabel(kind: kind, serverLabel: label), style: style, into: &builder)
        case .crowiOpaque:
            appendChip(RenderedAstPlaceholderCopy.inlineUnavailable, style: style, into: &builder)
        default:
            // A non-phrasing kind can only appear here if the walker let it
            // through, which it never does — render its text content rather
            // than dropping it silently.
            appendNodes(node.children, style: style, into: &builder)
        }
    }

    private func appendLink(url: String, classNames: [String], children: [RenderedAstNode], style: Style, into builder: inout Builder) {
        var next = style
        switch Self.classifyLink(url: url, classNames: classNames) {
        case .mention(let username):
            // Reuses the raw-body path's private pseudo-scheme so ONE
            // `openURL` interceptor (`WikiLinkMentionPreprocessor.classify`)
            // serves both render paths.
            next.linkURL = Self.linkURL(for: "\(WikiLinkMentionPreprocessor.mentionScheme):\(username)")
            next.isMention = true
        case .brokenWikiLink:
            next.isBroken = true
            next.linkURL = nil
        case .standard(let target):
            next.linkURL = Self.linkURL(for: target)
        }
        appendNodes(children, style: next, into: &builder)
    }

    private func appendChip(_ text: String, style: Style, into builder: inout Builder) {
        var chipStyle = style
        chipStyle.intents.insert(.code)
        var run = AttributedString("[\(text)]")
        applyDecorations(&run, style: chipStyle)
        // A chip stands for content that could NOT be rendered (a placeholder,
        // an html fragment, a failed typeset) — unlike ordinary inline code it
        // has to be conspicuous, so it keeps its fill and its secondary colour
        // AFTER the code styling above.
        run.foregroundColor = .secondary
        run.backgroundColor = CrowiTheme.muted
        builder.attributed += run
        builder.labelParts.append(text)
    }

    private func appendRun(_ text: String, style: Style, into builder: inout Builder, labelAlreadyRecorded: Bool = false) {
        var run = AttributedString(text)
        applyDecorations(&run, style: style)
        builder.attributed += run
        if !labelAlreadyRecorded {
            builder.labelParts.append(text)
        }
    }

    private func applyDecorations(_ run: inout AttributedString, style: Style) {
        if !style.intents.isEmpty {
            run.inlinePresentationIntent = style.intents
        }
        if style.intents.contains(.code), let font = codeStyle.font {
            run.font = font
        }
        if let linkURL = style.linkURL {
            run.link = linkURL
            if style.isMention {
                run.foregroundColor = CrowiTheme.primary
            }
        }
        if style.isBroken {
            run.foregroundColor = .secondary
            run.underlineStyle = Text.LineStyle(pattern: .dot, color: nil)
        }
    }
}

// MARK: - shiki token composition (the `code` block's dual-theme text)

public enum RenderedAstShikiText {
    public enum Theme {
        case light, dark
    }

    /// Joins token lines into one monospaced `AttributedString`, colored per
    /// the active theme. Colors are theme styling (the corpus normalizes
    /// them away); structure/fontStyle are contract.
    public static func attributedString(lines: [[RenderedAstShikiToken]], theme: Theme) -> AttributedString {
        var out = AttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { out += AttributedString("\n") }
            for token in line {
                var run = AttributedString(token.content)
                let style = theme == .dark ? token.dark : token.light
                if let color = color(fromShikiHex: style.color) {
                    run.foregroundColor = color
                }
                if let flags = style.fontStyle, !flags.isEmpty {
                    var intents: InlinePresentationIntent = []
                    if flags.contains(.bold) { intents.insert(.stronglyEmphasized) }
                    if flags.contains(.italic) { intents.insert(.emphasized) }
                    if flags.contains(.strikethrough) { intents.insert(.strikethrough) }
                    if !intents.isEmpty { run.inlinePresentationIntent = intents }
                    if flags.contains(.underline) { run.underlineStyle = .single }
                }
                out += run
            }
        }
        return out
    }

    /// `#RGB` / `#RRGGBB` / `#RRGGBBAA` — anything else falls back to the
    /// default text color.
    static func color(fromShikiHex hex: String) -> Color? {
        guard hex.hasPrefix("#") else { return nil }
        var digits = String(hex.dropFirst())
        if digits.count == 3 {
            digits = digits.map { "\($0)\($0)" }.joined()
        }
        guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
        let hasAlpha = digits.count == 8
        let red = Double((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255.0
        let green = Double((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255.0
        let blue = Double((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255.0
        let alpha = hasAlpha ? Double(value & 0xFF) / 255.0 : 1.0
        return Color(red: red, green: green, blue: blue, opacity: alpha)
    }
}
