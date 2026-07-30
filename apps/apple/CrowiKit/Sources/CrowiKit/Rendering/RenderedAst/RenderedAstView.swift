import SwiftUI

/// RFC-0023 Phase 4 — the native renderer for a decoded `renderedAst` v1
/// envelope: the PRIMARY page-body path (`PageReaderView` / `PageTreeView`'s
/// portal section) when the server returned a typed envelope;
/// `WorkspacePageMarkdownView` (raw-body MarkdownUI) remains the fallback
/// and keeps the exact same composition surface — this view deliberately
/// takes the SAME closure bundle (`onNavigateToWikiLink` /
/// `onNavigateToMention` / `onNavigateToRelativePath`), the same
/// `WorkspaceImageFetching` seam (§6.1 same-origin Bearer + redirect strip)
/// and the same `ImageViewerConfiguration` opt-in, so the two paths are
/// drop-in interchangeable at every call site.
///
/// Navigation rules (task architecture notes):
///   - mention links (`className == "mention"`) → `onNavigateToMention`;
///   - broken wikilinks (`className == "wikilink-broken"`) → rendered
///     visibly broken, inert;
///   - ordinary wikilinks arrive as PLAIN relative links (empty `data`,
///     `golden-corpus/inline.json`) and route — like every other relative
///     URL — through `onNavigateToRelativePath`;
///   - `#fragment` links → `onNavigateToFragment` (heading anchors — every
///     heading carries `.id(RenderedAstView.anchorID(...))` from its
///     server-issued `data.hProperties.id`);
///   - absolute URLs pass §6.2's `SchemeAllowlist` before reaching the
///     system (`mailto:`/custom schemes stay inert — OQ-9 pin).
///
/// `rendererVersion` is deliberately NOWHERE in this file (nor in the
/// decoder): it is diagnostics-only and never a rendering switch.
public struct RenderedAstView: View {
    let document: RenderedAstDocument
    let onNavigateToWikiLink: (String) -> Void
    let onNavigateToMention: (String) -> Void
    let onNavigateToRelativePath: (String) -> Void
    let onNavigateToFragment: ((String) -> Void)?
    let imageViewer: ImageViewerConfiguration?
    private let imageLoader: any WorkspaceImageFetching
    private let imageBaseURL: URL
    private let definitions: [String: RenderedAstDefinition]

    @State private var viewerItem: ImageViewerItem?

    public init(
        document: RenderedAstDocument,
        imageLoader: any WorkspaceImageFetching,
        imageBaseURL: URL,
        onNavigateToWikiLink: @escaping (String) -> Void,
        onNavigateToMention: @escaping (String) -> Void,
        onNavigateToRelativePath: @escaping (String) -> Void,
        onNavigateToFragment: ((String) -> Void)? = nil,
        imageViewer: ImageViewerConfiguration? = nil
    ) {
        self.document = document
        self.imageLoader = imageLoader
        self.imageBaseURL = imageBaseURL
        self.onNavigateToWikiLink = onNavigateToWikiLink
        self.onNavigateToMention = onNavigateToMention
        self.onNavigateToRelativePath = onNavigateToRelativePath
        self.onNavigateToFragment = onNavigateToFragment
        self.imageViewer = imageViewer
        self.definitions = document.definitions
    }

    /// The `ScrollViewReader` id a heading anchor registers under —
    /// namespaced so page content can never collide with other view ids.
    public static func anchorID(_ fragment: String) -> String {
        "crowi-ast-anchor:\(fragment)"
    }

    public var body: some View {
        RenderedAstBlockSequence(nodes: document.children, context: renderContext)
            .environment(\.openURL, OpenURLAction { url in handleLink(url) })
            // Same viewer presentation split as `WorkspacePageMarkdownView`:
            // CrowiKit also builds for macOS (where `swift test` runs).
            #if os(iOS)
            .fullScreenCover(item: $viewerItem) { item in
                viewerContent(item)
            }
            #else
            .sheet(item: $viewerItem) { item in
                viewerContent(item)
            }
            #endif
    }

    private var renderContext: RenderedAstRenderContext {
        RenderedAstRenderContext(
            imageLoader: imageLoader,
            imageBaseURL: imageBaseURL,
            definitions: definitions,
            onImageTap: imageTapHandler
        )
    }

    private var imageTapHandler: ((URL, PlatformImage) -> Void)? {
        guard imageViewer != nil else { return nil }
        return { url, image in
            viewerItem = ImageViewerItem(canonicalURL: url, initialImage: image)
        }
    }

    @ViewBuilder
    private func viewerContent(_ item: ImageViewerItem) -> some View {
        if let imageViewer {
            ImageViewerView(
                item: item,
                loader: imageLoader,
                resolver: imageViewer.resolver,
                confidentialNotice: imageViewer.confidentialNotice
            )
        }
    }

    private func handleLink(_ url: URL) -> OpenURLAction.Result {
        switch WikiLinkMentionPreprocessor.classify(url) {
        case .wikiLinkTarget(let target):
            onNavigateToWikiLink(target)
            return .handled
        case .mentionUsername(let username):
            onNavigateToMention(username)
            return .handled
        case .external(let externalURL):
            guard SchemeAllowlist.isAllowed(externalURL) else {
                // §6.2 — javascript:/data:/mailto:/custom schemes: inert.
                return .discarded
            }
            guard externalURL.scheme != nil else {
                let raw = externalURL.relativeString
                if raw.hasPrefix("#") {
                    let encoded = String(raw.dropFirst())
                    let fragment = encoded.removingPercentEncoding ?? encoded
                    if let onNavigateToFragment {
                        onNavigateToFragment(fragment)
                        return .handled
                    }
                    return .discarded
                }
                onNavigateToRelativePath(raw.removingPercentEncoding ?? raw)
                return .handled
            }
            return .systemAction
        }
    }
}

// MARK: - shared render context

struct RenderedAstRenderContext {
    let imageLoader: any WorkspaceImageFetching
    let imageBaseURL: URL
    let definitions: [String: RenderedAstDefinition]
    let onImageTap: ((URL, PlatformImage) -> Void)?
}

// MARK: - block sequence + block dispatch

struct RenderedAstBlockSequence: View {
    let nodes: [RenderedAstNode]
    let context: RenderedAstRenderContext

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                RenderedAstBlockView(node: node, context: context)
            }
        }
    }
}

struct RenderedAstBlockView: View {
    let node: RenderedAstNode
    let context: RenderedAstRenderContext

    var body: some View {
        switch node.kind {
        case .paragraph:
            RenderedAstParagraphView(children: node.children, context: context)
        case .heading(let depth):
            headingView(depth: depth)
        case .blockquote:
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                RenderedAstBlockSequence(nodes: node.children, context: context)
            }
        case .list(let ordered, let start, _):
            RenderedAstListView(ordered: ordered ?? false, start: start, items: node.children, context: context)
        case .thematicBreak:
            Divider()
        case .code(let value, _, _):
            RenderedAstCodeBlockView(value: value, tokens: node.data?.tokens)
        case .table(let align):
            RenderedAstTableView(align: align, rows: node.children, context: context)
        case .crowiFigure:
            RenderedAstFigureView(node: node, context: context)
        case .footnoteDefinition(let identifier, let label):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("[\(label ?? identifier)]:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                RenderedAstBlockSequence(nodes: node.children, context: context)
            }
        case .definition:
            // Definitions are reference metadata, never rendered (web parity:
            // `mdast-util-to-hast` emits nothing for them either).
            EmptyView()
        case .html:
            // Parent spec §4: html is a single, uniform rule — always a
            // visible placeholder, whether author- or plugin-produced.
            RenderedAstPlaceholderView(label: RenderedAstPlaceholderCopy.htmlBlock)
        case .math, .crowiDiagram, .crowiLinkCard:
            // Typed extension nodes: decoded strictly (they are union
            // members) but rendered as generic placeholders until Phase 5
            // promotes them to native views.
            RenderedAstPlaceholderView(label: RenderedAstPlaceholderCopy.blockUnavailable)
        case .crowiPlaceholder(_, let label, let reservation):
            RenderedAstPlaceholderView(label: label, heightHint: reservationHeight(reservation))
        case .crowiOpaque:
            RenderedAstPlaceholderView(label: RenderedAstPlaceholderCopy.blockUnavailable)
        default:
            // Phrasing kinds never appear at block level (the walker's
            // content-model tracking guarantees it) — but if one ever did,
            // render it as a one-node paragraph instead of dropping it.
            RenderedAstParagraphView(children: [node], context: context)
        }
    }

    private func reservationHeight(_ reservation: RenderedAstReservation) -> CGFloat? {
        if case .fixed(_, let heightPx) = reservation { return CGFloat(heightPx) }
        return nil
    }

    @ViewBuilder
    private func headingView(depth: Int) -> some View {
        let text = RenderedAstInlineTextView(nodes: node.children, context: context)
            .font(Self.headingFont(depth: depth))
            .padding(.top, depth <= 2 ? 8 : 4)
        if let anchor = node.data?.hPropertyString("id") {
            text.id(RenderedAstView.anchorID(anchor))
        } else {
            text
        }
    }

    static func headingFont(depth: Int) -> Font {
        switch depth {
        case 1: return .title.bold()
        case 2: return .title2.bold()
        case 3: return .title3.bold()
        case 4: return .headline
        default: return .subheadline.bold()
        }
    }
}

// MARK: - paragraph (inline runs + block-routed images)

struct RenderedAstParagraphView: View {
    let children: [RenderedAstNode]
    let context: RenderedAstRenderContext

    enum Segment: Equatable {
        case inline([RenderedAstNode])
        case image(url: String, alt: String?, attributes: ImageDisplayAttributes?)
    }

    /// Splits phrasing content at image boundaries: text runs render as one
    /// `Text`, images render through the authenticated BLOCK image path
    /// (the §6.1 loader + width-capped frame). `imageReference`s resolve
    /// against the document's definitions first.
    static func segments(of children: [RenderedAstNode], definitions: [String: RenderedAstDefinition]) -> [Segment] {
        var out: [Segment] = []
        var inlineRun: [RenderedAstNode] = []
        func flush() {
            let meaningful = inlineRun.contains { node in
                if case .text(let value) = node.kind { return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                if case .lineBreak = node.kind { return false }
                return true
            }
            if meaningful { out.append(.inline(inlineRun)) }
            inlineRun = []
        }
        for child in children {
            switch child.kind {
            case .image(let url, let alt, _):
                flush()
                out.append(.image(url: url, alt: alt, attributes: RenderedAstFigureView.displayAttributes(figureData: nil, imageData: child.data)))
            case .imageReference(let identifier, _, _, let alt):
                if let definition = definitions[identifier] {
                    flush()
                    out.append(.image(url: definition.url, alt: alt, attributes: nil))
                } else {
                    inlineRun.append(child)
                }
            default:
                inlineRun.append(child)
            }
        }
        flush()
        return out
    }

    var body: some View {
        let segments = Self.segments(of: children, definitions: context.definitions)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .inline(let nodes):
                    RenderedAstInlineTextView(nodes: nodes, context: context)
                case .image(let url, let alt, let attributes):
                    RenderedAstImageView(urlString: url, alt: alt, attributes: attributes, context: context)
                }
            }
        }
    }
}

struct RenderedAstInlineTextView: View {
    let nodes: [RenderedAstNode]
    let context: RenderedAstRenderContext

    var body: some View {
        let result = RenderedAstInlineRenderer(definitions: context.definitions).render(nodes)
        if let label = result.accessibilityLabel {
            Text(result.attributed)
                .accessibilityLabel(Text(label))
        } else {
            Text(result.attributed)
        }
    }
}

// MARK: - authenticated image (block path)

struct RenderedAstImageView: View {
    let urlString: String
    let alt: String?
    let attributes: ImageDisplayAttributes?
    let context: RenderedAstRenderContext

    var body: some View {
        // Reuses the MarkdownUI path's proven block image view: §6.1
        // authenticated fetch, RFC-0015 attribute frame, viewer tap wiring.
        WorkspaceMarkdownImageView(
            url: resolvedURL,
            attributes: attributes,
            loader: context.imageLoader,
            onImageTap: context.onImageTap
        )
        .accessibilityLabel(alt ?? "")
    }

    /// Relative URLs rebase against the workspace origin (the same
    /// resolution `Markdown(imageBaseURL:)` performed for the raw-body
    /// path, so disk-cache keys stay identical); §6.2 gates the scheme
    /// BEFORE any fetch (the loader checks again — belt and suspenders).
    private var resolvedURL: URL? {
        guard let resolved = URL(string: urlString, relativeTo: context.imageBaseURL)?.absoluteURL else { return nil }
        guard SchemeAllowlist.isAllowed(resolved) else { return nil }
        return resolved
    }
}

// MARK: - crowiFigure (RFC-0015 image display attributes)

struct RenderedAstFigureView: View {
    let node: RenderedAstNode
    let context: RenderedAstRenderContext

    var body: some View {
        if let image = node.children.first(where: { if case .image = $0.kind { return true } else { return false } }),
            case .image(let url, let alt, _) = image.kind {
            RenderedAstImageView(
                urlString: url,
                alt: alt,
                attributes: Self.displayAttributes(figureData: node.data, imageData: image.data),
                context: context
            )
        } else {
            RenderedAstParagraphView(children: node.children, context: context)
        }
    }

    /// `data-crowi-image-*` is an untrusted transport (parent spec §11 /
    /// RFC-0023 §11): every value is RE-validated here through the SAME
    /// closed-interval DROP rules the server and web use
    /// (`ImageDisplayAttributes.Size.validated` — `%` 1..100 / `px` 1..4096,
    /// out-of-range DROPPED, never clamped). `align`/`float` live on the
    /// figure's `hProperties`, `width`/`height` on the inner image's.
    static func displayAttributes(figureData: RenderedAstNodeData?, imageData: RenderedAstNodeData?) -> ImageDisplayAttributes? {
        var attributes = ImageDisplayAttributes()
        if let width = imageData?.hPropertyString("data-crowi-image-width") {
            attributes.width = ImageDisplayAttributes.Size.validated(width)
        }
        if let height = imageData?.hPropertyString("data-crowi-image-height") {
            attributes.height = ImageDisplayAttributes.Size.validated(height)
        }
        if let align = figureData?.hPropertyString("data-crowi-image-align") {
            attributes.align = ImageDisplayAttributes.BlockAlignment(rawValue: align)
        }
        if let float = figureData?.hPropertyString("data-crowi-image-float") {
            attributes.float = ImageDisplayAttributes.FloatSide(rawValue: float)
        }
        return attributes.isEmpty ? nil : attributes
    }
}

// MARK: - list

struct RenderedAstListView: View {
    let ordered: Bool
    let start: Int?
    let items: [RenderedAstNode]
    let context: RenderedAstRenderContext

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if case .listItem(let checked, _) = item.kind {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(index: index, checked: checked)
                            .foregroundStyle(.secondary)
                        RenderedAstBlockSequence(nodes: item.children, context: context)
                    }
                } else {
                    // A degraded (crowiOpaque) child — visible, never dropped.
                    RenderedAstBlockView(node: item, context: context)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, checked: Bool?) -> some View {
        if let checked {
            // Task-list item: checked is true/false; a PLAIN item in the
            // same list arrives as null (three-valued contract,
            // `golden-corpus/core-blocks.json`).
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .accessibilityLabel(checked ? "completed" : "not completed")
        } else if ordered {
            Text("\((start ?? 1) + index).")
                .monospacedDigit()
        } else {
            Text("•")
        }
    }
}

// MARK: - code block

struct RenderedAstCodeBlockView: View {
    let value: String
    let tokens: [[RenderedAstShikiToken]]?

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(attributed)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }

    /// Sidecar-missing degrade (renderPending, unknown lang, lang-less
    /// fence): plain monospaced text of `code.value` — the tokens, when
    /// present, carry BOTH themes and the active `colorScheme` picks one.
    private var attributed: AttributedString {
        guard let tokens else { return AttributedString(value) }
        return RenderedAstShikiText.attributedString(lines: tokens, theme: colorScheme == .dark ? .dark : .light)
    }
}

// MARK: - table

struct RenderedAstTableView: View {
    let align: [RenderedAstNode.TableAlignment?]?
    let rows: [RenderedAstNode]
    let context: RenderedAstRenderContext

    private var tableRows: [RenderedAstNode] {
        rows.filter { if case .tableRow = $0.kind { return true } else { return false } }
    }

    private var degradedChildren: [RenderedAstNode] {
        rows.filter { if case .tableRow = $0.kind { return false } else { return true } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 6) {
                    ForEach(Array(tableRows.enumerated()), id: \.offset) { rowIndex, row in
                        GridRow {
                            ForEach(Array(row.children.enumerated()), id: \.offset) { columnIndex, cell in
                                cellView(cell, columnIndex: columnIndex, isHeader: rowIndex == 0)
                            }
                        }
                        if rowIndex == 0 {
                            Divider()
                        }
                    }
                }
            }
            // Degraded non-row children stay visible (never silently dropped).
            ForEach(Array(degradedChildren.enumerated()), id: \.offset) { _, child in
                RenderedAstBlockView(node: child, context: context)
            }
        }
    }

    @ViewBuilder
    private func cellView(_ cell: RenderedAstNode, columnIndex: Int, isHeader: Bool) -> some View {
        RenderedAstInlineTextView(nodes: cell.children, context: context)
            .fontWeight(isHeader ? .semibold : .regular)
            .gridColumnAlignment(horizontalAlignment(forColumn: columnIndex))
    }

    /// GFM `table.align` — null entries mean "unmarked column" (default
    /// leading), and are part of the contract, not an absence to clean up.
    private func horizontalAlignment(forColumn index: Int) -> HorizontalAlignment {
        guard let align, index < align.count, let alignment = align[index] else { return .leading }
        switch alignment {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }
}
