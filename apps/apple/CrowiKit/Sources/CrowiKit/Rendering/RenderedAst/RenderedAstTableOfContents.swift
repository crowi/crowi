import Foundation

/// One entry of a page's table of contents — a heading the renderer actually
/// drew, with the anchor it registered for it (if any).
public struct RenderedAstHeading: Equatable, Sendable, Identifiable {
    /// The wire `heading.depth` (1…6 by contract — `RenderedAstEnvelopeDecoder`
    /// rejects anything else, so this is only ever clamped defensively).
    public let level: Int
    /// 0-based indentation step, normalized against the SHALLOWEST heading in
    /// the document (a page whose headings start at `##` reads flush left, not
    /// permanently indented) and capped at `maximumIndentLevel` so an `h1` →
    /// `h5` jump does not push the label off the sheet.
    public let indentLevel: Int
    /// The heading's phrasing content, flattened to plain text.
    public let title: String
    /// The **server-issued** `data.hProperties.id`, i.e. exactly what
    /// `RenderedAstBlockView.headingView` registers as
    /// `RenderedAstView.anchorID(_:)`. `nil` when the heading carries no id —
    /// the renderer then registers NO anchor for it, so nothing can scroll to
    /// it and the TOC must not pretend otherwise. Never client-slugged
    /// (RFC-0023 Phase 4: the ids come from the server or they do not exist).
    public let anchor: String?
    /// Pre-order position — the identity `ForEach` uses, since two headings
    /// may legitimately share a title AND (on a broken server) an id.
    public let id: Int

    public init(level: Int, indentLevel: Int, title: String, anchor: String?, id: Int) {
        self.level = level
        self.indentLevel = indentLevel
        self.title = title
        self.anchor = anchor
        self.id = id
    }

    /// Whether tapping this entry can scroll anywhere.
    public var isNavigable: Bool { anchor != nil }
}

/// feature-ios-visual-redesign Phase 3 — the page reader's table of contents,
/// extracted from a decoded `renderedAst` v1 envelope.
///
/// Deliberately PURE (document in → `[RenderedAstHeading]` out, no SwiftUI),
/// the `RenderedAstListFlattener` stance: every rule below — which nodes count
/// as headings, how their text is flattened, which of them can be jumped to,
/// how nesting is normalized — is unit-testable without layout
/// (`RenderedAstTableOfContentsTests`).
///
/// Two invariants this type exists to hold:
///
///   1. **It never invents an anchor.** The only anchor a heading can have is
///      its `data.hProperties.id`, which is what the renderer registers. There
///      is no client-side slugger here and there must never be one: the web
///      and the server agree on ids that a re-derived slug would silently
///      diverge from (RFC-0023 Phase 4).
///   2. **It walks the whole tree, not just the root's children.** A heading
///      inside a blockquote or a list item is still rendered by
///      `RenderedAstBlockView` — and therefore still carries its anchor — so
///      leaving it out of the TOC would hide a destination the reader can
///      actually reach.
///
/// On the raw-body fallback path there is no AST at all, so
/// `headings(in: RenderedAstDecodeOutcome?)` returns `[]` and the reader's TOC
/// control is ABSENT rather than present-and-empty.
public enum RenderedAstTableOfContents {
    /// The deepest indentation step the sheet will draw. Beyond this the rail
    /// stops moving right; the outline is a jump list, not a tree view.
    public static let maximumIndentLevel = 3

    /// The TOC of a detail response's decode outcome — `[]` for every
    /// non-envelope case (missing / bare `Root` / unsupported version /
    /// invalid envelope), which is exactly the set of cases that render
    /// through `WorkspacePageMarkdownView` instead and have no anchors.
    public static func headings(in outcome: RenderedAstDecodeOutcome?) -> [RenderedAstHeading] {
        guard case .envelope(let document)? = outcome else { return [] }
        return headings(in: document)
    }

    public static func headings(in document: RenderedAstDocument) -> [RenderedAstHeading] {
        let found = collect(document.children)
        guard let shallowest = found.map(\.level).min() else { return [] }
        return found.enumerated().map { index, heading in
            RenderedAstHeading(
                level: heading.level,
                indentLevel: min(max(heading.level - shallowest, 0), maximumIndentLevel),
                title: heading.title,
                anchor: heading.anchor,
                id: index
            )
        }
    }

    // MARK: - Walk

    private struct FoundHeading {
        let level: Int
        let title: String
        let anchor: String?
    }

    /// Pre-order depth-first walk. Iterative with an explicit stack rather
    /// than recursive: the decoder admits trees up to
    /// `RenderedAstWireContract.maxTreeDepth` (64) levels, and this walk has
    /// no reason to spend stack frames on them.
    private static func collect(_ children: [RenderedAstNode]) -> [FoundHeading] {
        var found: [FoundHeading] = []
        var stack = Array(children.reversed())
        while let node = stack.popLast() {
            guard case .heading(let depth) = node.kind else {
                stack.append(contentsOf: node.children.reversed())
                continue
            }
            // A heading's children are phrasing content — nothing below it can
            // be another heading, so the subtree is consumed here.
            let title = plainText(of: node.children)
            guard !title.isEmpty else {
                // A heading with no text at all (an image-only heading with no
                // alt) would render as a blank row that says nothing and,
                // tapped, jumps somewhere unnamed. Dropped rather than shown.
                continue
            }
            found.append(
                FoundHeading(
                    level: min(max(depth, 1), 6),
                    title: title,
                    anchor: anchor(of: node)
                )
            )
        }
        return found
    }

    /// The heading's registered anchor. An EMPTY id is treated as absent: the
    /// renderer would register `anchorID("")`, which no `#fragment` link can
    /// name and which would make the row a dead tap.
    private static func anchor(of node: RenderedAstNode) -> String? {
        guard let id = node.data?.hPropertyString("id"), !id.isEmpty else { return nil }
        return id
    }

    // MARK: - Plain text

    /// Flattens phrasing content to the label a TOC row shows.
    ///
    /// Deliberately NOT `RenderedAstInlineRenderer`: that one produces styled
    /// `AttributedString`s and rasterizes inline math against a colour scheme,
    /// which a one-line jump-list label neither needs nor can be tested
    /// without. The text VALUES it would carry are the same ones taken here.
    public static func plainText(of nodes: [RenderedAstNode]) -> String {
        var out = ""
        append(nodes, into: &out)
        return collapsingWhitespace(out)
    }

    private static func append(_ nodes: [RenderedAstNode], into out: inout String) {
        for node in nodes {
            switch node.kind {
            case .text(let value), .inlineCode(let value):
                out += value
            case .math(let value, _), .inlineMath(let value, _):
                // The TeX source, which is what the body's own degraded math
                // chip shows too — better than dropping the run silently.
                out += value
            case .image(_, let alt, _):
                if let alt { out += alt }
            case .lineBreak:
                out += " "
            case .crowiDiagram(_, _, let alt, _):
                out += alt
            default:
                append(node.children, into: &out)
            }
        }
    }

    /// Runs of whitespace (including the newlines a `break` or a hard-wrapped
    /// heading contributes) collapse to one space, and the result is trimmed —
    /// a TOC row is a single line.
    private static func collapsingWhitespace(_ text: String) -> String {
        text
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}
