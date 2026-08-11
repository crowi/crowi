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
///   - an absolute URL to the workspace's OWN origin is the same link as the
///     relative one (`WorkspaceLinkRouter`) and stays in the app — a share
///     URL's page id through `onNavigateToPageId`, anything else as a path;
///   - every other absolute URL passes §6.2's `SchemeAllowlist` before
///     reaching the system (`mailto:`/custom schemes stay inert — OQ-9 pin).
///
/// `rendererVersion` is deliberately NOWHERE in this file (nor in the
/// decoder): it is diagnostics-only and never a rendering switch.
public struct RenderedAstView: View {
    let document: RenderedAstDocument
    let onNavigateToWikiLink: (String) -> Void
    let onNavigateToMention: (String) -> Void
    let onNavigateToRelativePath: (String) -> Void
    /// Absent where the host cannot resolve a share URL's id; such a link
    /// then goes to the browser rather than nowhere.
    let onNavigateToPageId: ((String) -> Void)?
    let onNavigateToFragment: ((String) -> Void)?
    let imageViewer: ImageViewerConfiguration?
    private let imageLoader: any WorkspaceImageFetching
    private let workspaceOrigin: URL
    private let definitions: [String: RenderedAstDefinition]

    @State private var viewerItem: ImageViewerItem?

    public init(
        document: RenderedAstDocument,
        imageLoader: any WorkspaceImageFetching,
        workspaceOrigin: URL,
        onNavigateToWikiLink: @escaping (String) -> Void,
        onNavigateToMention: @escaping (String) -> Void,
        onNavigateToRelativePath: @escaping (String) -> Void,
        onNavigateToPageId: ((String) -> Void)? = nil,
        onNavigateToFragment: ((String) -> Void)? = nil,
        imageViewer: ImageViewerConfiguration? = nil
    ) {
        self.document = document
        self.imageLoader = imageLoader
        self.workspaceOrigin = workspaceOrigin
        self.onNavigateToWikiLink = onNavigateToWikiLink
        self.onNavigateToMention = onNavigateToMention
        self.onNavigateToRelativePath = onNavigateToRelativePath
        self.onNavigateToPageId = onNavigateToPageId
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
            // Set ONCE, at the root: `lineSpacing` is an environment value, so
            // every `Text` in the body — paragraphs, headings, list rows, table
            // cells, blockquotes — inherits the same leading, and the ONE place
            // that opts out (`RenderedAstCodeBlockView`) says so explicitly.
            .lineSpacing(CrowiBodyMetrics().lineSpacing)
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
            imageBaseURL: workspaceOrigin,
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
                let path = raw.removingPercentEncoding ?? raw
                if case .pageId(let id) = WorkspaceLinkRouter.internalLink(forPath: path), let onNavigateToPageId {
                    onNavigateToPageId(id)
                    return .handled
                }
                onNavigateToRelativePath(path)
                return .handled
            }
            switch WorkspaceLinkRouter.internalLink(for: externalURL, workspaceOrigin: workspaceOrigin) {
            case .pagePath(let path):
                onNavigateToRelativePath(path)
                return .handled
            case .pageId(let id):
                guard let onNavigateToPageId else { return .systemAction }
                onNavigateToPageId(id)
                return .handled
            case nil:
                return .systemAction
            }
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
        VStack(alignment: .leading, spacing: CrowiBodyMetrics().blockSpacing) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                RenderedAstBlockView(node: node, context: context)
            }
        }
    }
}

struct RenderedAstBlockView: View {
    let node: RenderedAstNode
    let context: RenderedAstRenderContext

    private var metrics: CrowiBodyMetrics { CrowiBodyMetrics() }

    var body: some View {
        switch node.kind {
        case .paragraph:
            RenderedAstParagraphView(children: node.children, context: context)
        case .heading(let depth):
            headingView(depth: depth)
        case .blockquote:
            if let alert = RenderedAstAlert.detect(children: node.children) {
                RenderedAstAlertView(variant: alert.variant, content: alert.content, context: context)
            } else {
                HStack(alignment: .top, spacing: metrics.blockquoteGutter) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.secondary.opacity(0.4))
                        .frame(width: 3)
                    RenderedAstBlockSequence(nodes: node.children, context: context)
                }
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
        case .crowiFrontmatter(let entries):
            RenderedAstFrontmatterView(entries: entries)
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
        case .math(let value, _):
            // Phase 5 — synchronous native TeX typesetting (degrades to a
            // visible monospaced TeX box, never a drop).
            RenderedAstMathBlockView(tex: value)
        case .crowiDiagram(_, _, let alt, let image):
            // Phase 5 — area reserved from the intrinsic dimensions BEFORE
            // the payload decodes (no layout shift on swap-in).
            RenderedAstDiagramView(alt: alt, image: image)
        case .crowiLinkCard(let payload):
            // Phase 5 — structured OGP card (url-only cards are first-class
            // by contract: fetch failure and toggle-off are the same shape).
            RenderedAstLinkCardView(payload: payload)
        case .crowiPlaceholder(let kind, let label, let reservation):
            RenderedAstPlaceholderView(kind: kind, serverLabel: label, reservation: reservation)
        case .crowiOpaque:
            RenderedAstPlaceholderView(label: RenderedAstPlaceholderCopy.blockUnavailable)
        default:
            // Phrasing kinds never appear at block level (the walker's
            // content-model tracking guarantees it) — but if one ever did,
            // render it as a one-node paragraph instead of dropping it.
            RenderedAstParagraphView(children: [node], context: context)
        }
    }

    @ViewBuilder
    private func headingView(depth: Int) -> some View {
        let text = RenderedAstInlineTextView(
            nodes: node.children,
            context: context,
            // Inline code in a heading keeps the HEADING's size and drops the
            // chip fill: at 22–28pt the body's fill is a slab, and the heading
            // weight plus monospace is already all the contrast it needs.
            codeStyle: .heading
        )
        .font(Self.headingFont(depth: depth))
        .padding(.top, metrics.headingTopPadding(depth: depth))
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
        VStack(alignment: .leading, spacing: CrowiBodyMetrics().paragraphSegmentSpacing) {
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
    /// How `inlineCode` runs are drawn here — body text and headings want
    /// different answers (see `RenderedAstInlineCodeStyle`).
    var codeStyle: RenderedAstInlineCodeStyle = .body

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let result = RenderedAstInlineRenderer(
            definitions: context.definitions,
            mathIsDark: colorScheme == .dark,
            codeStyle: codeStyle
        ).render(nodes)
        if let label = result.accessibilityLabel {
            Self.composedText(result)
                .accessibilityLabel(Text(label))
        } else {
            Self.composedText(result)
        }
    }

    /// Concatenates the pieces into ONE `Text`: attributed runs plus
    /// baseline-aligned inline-math images (Phase 5) — keeping line
    /// wrapping/selection semantics of a single text run.
    static func composedText(_ result: RenderedAstInlineResult) -> Text {
        result.pieces.reduce(Text(verbatim: "")) { composed, piece in
            switch piece {
            case .attributed(let run):
                return composed + Text(run)
            case .math(let run):
                return composed + Text(Image(platformImage: run.image)).baselineOffset(run.baselineOffset)
            }
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

/// Renders a `list` subtree FLAT: `RenderedAstListFlattener` pre-order-walks
/// the `list`/`listItem` tree into linear rows, and every row is one shallow
/// `HStack(marker, blocks)` with depth-indexed leading padding.
///
/// DO NOT reintroduce per-level view recursion here (the pre-flattener
/// renderer nested one `HStack(marker, RenderedAstBlockSequence)` per list
/// level): SwiftUI's StackLayout sizing explodes ~×15 per nesting level
/// (measured: depth 3 → 140ms, 4 → 906ms, 5 → 15.0s, 6+ → >25s), so a real
/// page with 8-level bullets wedged the main thread forever on first paint.
/// `DeepListLayoutWallTimeTests` pins this with a wall-time bound.
struct RenderedAstListView: View {
    let ordered: Bool
    let start: Int?
    let items: [RenderedAstNode]
    let context: RenderedAstRenderContext

    /// Leading indent per nesting depth — visually equivalent to the old
    /// marker-column offset (~marker width + 8pt spacing).
    private static let indentPerDepth: CGFloat = 20
    /// The decoder admits up to ~31 list levels (`maxTreeDepth` 64 / 2 nodes
    /// per level); cap the visual indent so pathological depth can't squeeze
    /// the content column to nothing on a phone width.
    private static let maxIndent: CGFloat = 240

    var body: some View {
        let rows = RenderedAstListFlattener.flatten(ordered: ordered, start: start, items: items)
        let metrics = CrowiBodyMetrics()
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                rowView(row)
                    // The flattener is pure and emits its gaps in points at the
                    // DEFAULT text size (its rules are asserted as exact
                    // values); Dynamic Type is applied here, so a list keeps
                    // the same rhythm as the paragraphs around it at every size.
                    .padding(.top, CGFloat(row.topSpacing) * metrics.dynamicTypeScale)
                    .padding(.leading, min(CGFloat(row.depth) * Self.indentPerDepth, Self.maxIndent))
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: RenderedAstListFlattener.Row) -> some View {
        if let marker = row.marker {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                markerView(marker)
                    .foregroundStyle(.secondary)
                    // A continuation chunk (item content AFTER its nested
                    // sub-list) reserves the marker column invisibly so it
                    // aligns with the item's first-row content.
                    .opacity(row.markerHidden ? 0 : 1)
                    .accessibilityHidden(row.markerHidden)
                RenderedAstBlockSequence(nodes: row.blocks, context: context)
            }
        } else {
            // A degraded (crowiOpaque) child — visible, never dropped.
            RenderedAstBlockSequence(nodes: row.blocks, context: context)
        }
    }

    @ViewBuilder
    private func markerView(_ marker: RenderedAstListFlattener.Marker) -> some View {
        switch marker {
        case .task(let checked):
            // Task-list item: checked is true/false; a PLAIN item in the
            // same list arrives as null (three-valued contract,
            // `golden-corpus/core-blocks.json`).
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .accessibilityLabel(checked ? "completed" : "not completed")
        case .ordered(let number):
            Text("\(number).")
                .monospacedDigit()
        case .bullet:
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
        // Indicators ON (and flashed on appear) — a listing whose longest line
        // runs past the screen edge otherwise looks TRUNCATED rather than
        // scrollable, with nothing on screen saying there is more to the right.
        ScrollView(.horizontal) {
            Text(attributed)
                .font(.system(.callout, design: .monospaced))
                // Code opts OUT of the body's Japanese leading: monospaced
                // Latin has real ascenders and descenders, and at 0.5em a
                // listing stops reading as one block.
                .lineSpacing(CrowiBodyMetrics().codeBlockLineSpacing)
                .textSelection(.enabled)
                .padding(10)
        }
        .scrollIndicatorsFlash(onAppear: true)
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

    private var metrics: CrowiBodyMetrics { CrowiBodyMetrics() }

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.paragraphSegmentSpacing) {
            expandButton
            // A table wider than the phone was already scrollable, but with the
            // indicators suppressed it just looked CUT OFF at the second
            // column. Showing them — and flashing them as the table scrolls
            // into view — is what says "there is more to the right".
            ScrollView(.horizontal) {
                grid
            }
            .scrollIndicatorsFlash(onAppear: true)
            // Degraded non-row children stay visible (never silently dropped).
            ForEach(Array(degradedChildren.enumerated()), id: \.offset) { _, child in
                RenderedAstBlockView(node: child, context: context)
            }
        }
        .sheet(isPresented: $isExpanded) { expanded }
    }

    private var grid: some View {
        Grid(
            alignment: .topLeading,
            horizontalSpacing: metrics.tableColumnSpacing,
            // Has to clear the line gap inside a cell, or a wrapped
            // cell reads as two rows.
            verticalSpacing: metrics.tableRowSpacing
        ) {
            ForEach(Array(tableRows.enumerated()), id: \.offset) { rowIndex, row in
                GridRow {
                    ForEach(Array(row.children.enumerated()), id: \.offset) { columnIndex, cell in
                        cellView(cell, columnIndex: columnIndex, isHeader: rowIndex == 0)
                    }
                }
                // A rule under EVERY row but the last, the way the web draws
                // one (`tbody > tr` bottom borders): a header rule alone left
                // the body reading as two columns of paragraphs, which is
                // also what made the cut-off right edge look like wrapped
                // text rather than a table continuing off-screen. Heavier
                // under the header, same as there.
                if rowIndex < tableRows.count - 1 {
                    Divider().overlay(Color.primary.opacity(rowIndex == 0 ? 0.18 : 0.1))
                }
            }
        }
    }

    /// Reading a wide table by dragging a phone-width window across it is the
    /// worst way to read it. The web has the same escape hatch on the same
    /// element, and here it also doubles as the thing that SAYS "table" —
    /// visible before any scrolling happens, unlike a scroll indicator.
    private var expandButton: some View {
        Button {
            isExpanded = true
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CrowiTheme.mutedForeground)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(CrowiTheme.muted)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityLabel("Expand table")
    }

    private var expanded: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                grid
                    .padding(metrics.paragraphSegmentSpacing)
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isExpanded = false }
                }
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
