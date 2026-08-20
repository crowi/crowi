import MarkdownUI
import SwiftUI

/// RFC-0016 §6/§6.2/§15 — composes `Markdown(body)` (gate C's selected
/// renderer) with:
///   - `WorkspaceMarkdownImageProvider` / `WorkspaceMarkdownInlineImageProvider`
///     — the proven §6.1 same-origin-Bearer + redirect-strip authenticated
///     image loader seam (Phase 0/1, reused verbatim), wired to BOTH of
///     swift-markdown-ui's image environment keys. Which key a given image
///     node uses depends on cmark-gfm's parse shape, not on anything this
///     view controls: an image alone on its own paragraph line renders via
///     `\.imageProvider` (`ImageView`), but an image sharing a line with any
///     other inline content — including crowi's own image-attribute markdown
///     `![alt](url){width=500px}`, which cmark-gfm parses as an image inline
///     node followed by a literal text node — renders via
///     `\.inlineImageProvider` (`InlineText`) instead. Wiring only the first
///     (as Phase 0 gate C did) leaves every attribute-annotated image, and
///     any other image not alone on its line, falling through to
///     swift-markdown-ui's unauthenticated `DefaultInlineImageProvider`;
///   - `imageBaseURL:` on `Markdown(...)` — resolves crowi's relative
///     attachment URLs (`/api/attachments/<id>`) against the workspace
///     origin at the point swift-markdown-ui builds each image node's `URL`,
///     which `InlineText` needs (it has no other rebasing step). The block
///     path already rebases independently inside `WorkspaceImageLoader.fetch`,
///     so passing this does not change its behavior — confirmed the final
///     resolved URL is identical either way;
///   - `ImageAttributeBlockPreprocessor.stripAndCarry(_:)` — removes RFC-0015
///     image attribute blocks (`![alt](url){width=500px}`) BEFORE the
///     wikilink/mention rewrite and before the renderer ever sees the body,
///     so they never surface as literal garbled text next to the image —
///     AND (`feature-ios-phase3-notifications-extensions`) carries the
///     server-identically-validated width/align/float values to both image
///     providers via the `#crowi-image-attrs:` URL-fragment side-channel
///     (`ImageDisplayAttributes`), which each provider detaches before the
///     URL reaches the fetch/cache/allowlist layers. The strip also restores
///     the paragraph to "image alone", which routes it through the
///     width-capped block image path (where the attributes actually apply)
///     instead of the inline one;
///   - `NestedListDepthClampPreprocessor.clamp(_:)` — FIRST in the chain:
///     re-indents list items nested beyond depth 4 to depth-4 siblings,
///     because MarkdownUI's nested-list layout explodes ~×15 per level
///     (measured: depth 5 → 15s, 6+ → a permanent main-thread wedge) and
///     this raw-body path runs on every cache re-open (`CachedPage` pins
///     `renderedAst: nil`) and as the fallback. See the type's doc comment;
///     the AST path needs no clamp (it renders lists flat);
///   - `WikiLinkMentionPreprocessor.preprocess(_:)` — rewrites raw
///     `[[wikilinks]]` / `@mentions` into ordinary CommonMark links against
///     private pseudo-schemes BEFORE the renderer ever sees the body (§6 —
///     native rendering never consumes `renderedAst`);
///   - an `.environment(\.openURL, ...)` interceptor — the renderer's
///     already-exposed link-tap seam (`Markdown.swift`'s own doc comment) —
///     that resolves those pseudo-scheme links to in-app navigation and
///     applies `SchemeAllowlist` (§6.2) to everything else, so
///     `javascript:`/`data:`/`crowi-ios://`/any other custom scheme is
///     inerted at this ONE shared entry point rather than a second, drifted
///     allowlist check;
///   - (`feature-ios-image-viewer`, opt-in via `imageViewer:`) a tap handler
///     on successfully-decoded block images + the `ImageViewerView`
///     presentation state — this view is the ONE composition point that
///     already owns both image providers, so the tap wiring and the
///     fullscreen cover live here rather than being re-plumbed per screen.
public struct WorkspacePageMarkdownView: View {
    let rawBody: String
    let imageLoader: any WorkspaceImageFetching
    /// The active workspace's origin (scheme+host+port, §3) — passed through
    /// to `Markdown(...)`'s `imageBaseURL:` so relative image URLs resolve
    /// the same way for both the block and inline image paths.
    let workspaceOrigin: URL
    let onNavigateToWikiLink: (String) -> Void
    let onNavigateToMention: (String) -> Void
    /// An ordinary (non-wikilink, non-mention) workspace-relative Markdown
    /// link, e.g. `[text](/some/page)` — also routed in-app, since it is
    /// just as much "workspace content" as a wikilink. An absolute URL to
    /// the workspace's own origin arrives here too (`WorkspaceLinkRouter`);
    /// only a link to somewhere else falls through to the system.
    let onNavigateToRelativePath: (String) -> Void
    /// Absent where the host cannot resolve a share URL's id; such a link
    /// then goes to the browser rather than nowhere.
    var onNavigateToPageId: ((String) -> Void)?
    /// Where an EXTERNAL link goes. Absent means the system browser, which
    /// leaves the app — and coming back can mean coming back to a process iOS
    /// terminated meanwhile, with the reading position gone. A host that can
    /// present a browser itself sets this.
    var onOpenExternalURL: ((URL) -> Void)?
    /// An attachment reference (`/api/attachments/<id>`). Checked before a
    /// link is treated as a page, since an attachment path is same-origin and
    /// would otherwise send the reader looking for a page by that name.
    var onOpenAttachment: ((String) -> Void)?
    /// `feature-ios-image-viewer` — non-nil makes successfully-decoded BLOCK
    /// images tappable, presenting `ImageViewerView` fullscreen (original
    /// bytes via the configuration's resolver; canonical fallback). `nil`
    /// (the default) keeps this view exactly as before — the revision-
    /// history sheet stays viewer-less without touching its call site.
    let imageViewer: ImageViewerConfiguration?

    @State private var viewerItem: ImageViewerItem?

    /// The measured markdown-column width the INLINE image path resolves
    /// `width=<n>%` against (review round 1 — see
    /// `InlineImageContainerWidthReference`). `@State` keeps the reference
    /// stable across re-renders; measurement writes go through a plain
    /// property on the class, so they never re-invalidate this view.
    @State private var inlineImageContainerWidth = InlineImageContainerWidthReference()

    public init(
        rawBody: String,
        imageLoader: any WorkspaceImageFetching,
        workspaceOrigin: URL,
        onNavigateToWikiLink: @escaping (String) -> Void,
        onNavigateToMention: @escaping (String) -> Void,
        onNavigateToRelativePath: @escaping (String) -> Void,
        onNavigateToPageId: ((String) -> Void)? = nil,
        onOpenExternalURL: ((URL) -> Void)? = nil,
        onOpenAttachment: ((String) -> Void)? = nil,
        imageViewer: ImageViewerConfiguration? = nil
    ) {
        self.rawBody = rawBody
        self.imageLoader = imageLoader
        self.workspaceOrigin = workspaceOrigin
        self.onNavigateToWikiLink = onNavigateToWikiLink
        self.onNavigateToMention = onNavigateToMention
        self.onNavigateToRelativePath = onNavigateToRelativePath
        self.onNavigateToPageId = onNavigateToPageId
        self.onOpenExternalURL = onOpenExternalURL
        self.onOpenAttachment = onOpenAttachment
        self.imageViewer = imageViewer
    }

    public var body: some View {
        markdownContent
            // `fullScreenCover` is iOS-only; CrowiKit also builds for macOS
            // (where `swift test` runs), so the mac side degrades to a plain
            // sheet — same content, same dismiss wiring.
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

    @ViewBuilder
    private func viewerContent(_ item: ImageViewerItem) -> some View {
        // `viewerItem` can only ever be set through the tap handler below,
        // which exists only when `imageViewer != nil` — this `if let` is a
        // structural restatement, not a reachable "viewer off" branch.
        if let imageViewer {
            ImageViewerView(
                item: item,
                // The SAME fetching seam (disk cache → §6.1 loader) the body
                // render used — the viewer never grows a second image path.
                loader: imageLoader,
                resolver: imageViewer.resolver,
                confidentialNotice: imageViewer.confidentialNotice
            )
        }
    }

    /// `nil` when the viewer is not configured — the block image provider
    /// then attaches no tap gesture at all (`WorkspaceMarkdownImageTapPolicy`),
    /// rather than a gesture that silently does nothing.
    private var imageTapHandler: ((URL, PlatformImage) -> Void)? {
        guard imageViewer != nil else { return nil }
        return { url, image in
            viewerItem = ImageViewerItem(canonicalURL: url, initialImage: image)
        }
    }

    private var markdownContent: some View {
        Markdown(
            WikiLinkMentionPreprocessor.preprocess(
                ImageAttributeBlockPreprocessor.stripAndCarry(
                    NestedListDepthClampPreprocessor.clamp(rawBody))),
            imageBaseURL: workspaceOrigin
        )
            // Crowi renders a single newline as a line break — that is a CORE
            // pipeline default, not an opt-in plugin: RFC-0002 Phase 5 promoted
            // `remark-breaks` out of `@crowi/plugin-renderer-crowi-legacy` into
            // the core pipeline (`packages/api/src/renderer/pipeline.ts`)
            // because GitHub/GitLab/Slack all behave that way and CommonMark's
            // bare soft break surprises authors more than it helps.
            //
            // MarkdownUI defaults to `.space` (CommonMark's other blessed
            // choice — the spec explicitly permits either, and offers this very
            // knob), so without this the app silently disagreed with the web on
            // plain paragraph text, not just on Crowi extensions.
            .markdownSoftBreakMode(.lineBreak)
            .markdownTheme(Self.crowiTheme)
            .markdownImageProvider(WorkspaceMarkdownImageProvider(loader: imageLoader, onImageTap: imageTapHandler))
            .markdownInlineImageProvider(WorkspaceMarkdownInlineImageProvider(loader: imageLoader, containerWidth: inlineImageContainerWidth))
            // Measures the rendered markdown column's width for the inline
            // image path's `%` resolution — a background `GeometryReader` is
            // size-transparent (it adopts this view's size, never proposes
            // one), so the measurement cannot feed back into layout.
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { inlineImageContainerWidth.width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, newWidth in
                            inlineImageContainerWidth.width = newWidth
                        }
                }
            )
            .environment(
                \.openURL,
                OpenURLAction { url in
                    switch WikiLinkMentionPreprocessor.classify(url) {
                    case .wikiLinkTarget(let target):
                        onNavigateToWikiLink(target)
                        return .handled
                    case .mentionUsername(let username):
                        onNavigateToMention(username)
                        return .handled
                    case .external(let externalURL):
                        if let onOpenAttachment, let id = WorkspaceLinkRouter.attachmentId(in: externalURL.absoluteString) {
                            onOpenAttachment(id)
                            return .handled
                        }
                        guard SchemeAllowlist.isAllowed(externalURL) else {
                            // §6.2 — javascript:/data:/crowi-ios:///any other
                            // custom scheme: inert, never handed to the
                            // system.
                            return .discarded
                        }
                        guard externalURL.scheme != nil else {
                            // A workspace-relative real Markdown link — also
                            // in-app navigation, not a system open.
                            let path = externalURL.relativeString
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
                            if let onOpenExternalURL {
                            onOpenExternalURL(externalURL)
                            return .handled
                        }
                        return .systemAction
                        }
                    }
                }
            )
    }

    /// MarkdownUI's `.basic` theme with ONE thing changed: the leading and the
    /// block gaps, taken from `CrowiBodyMetrics` so this path — the cache-paint
    /// / old-server fallback — reads like the AST path a live fetch takes,
    /// rather than dropping back to `.basic`'s 0.15em on the same page.
    ///
    /// The two overridden block styles are `.basic`'s own, verbatim except for
    /// the spacing numbers: nothing else about the fallback's look is being
    /// redesigned here.
    private static var crowiTheme: Theme {
        Theme.basic
            .paragraph { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(CrowiTypography.bodyLineSpacingRatio))
                    .markdownMargin(top: .zero, bottom: .em(CrowiTypography.bodyBlockSpacingRatio))
            }
            .listItem { configuration in
                // `.basic` gives a list item no margin at all, which under the
                // new leading leaves bullets packed tighter than the lines
                // inside one of them.
                configuration.label
                    .markdownMargin(top: .em(CrowiTypography.bodyRelatedItemSpacingRatio), bottom: .zero)
            }
            .tableCell { configuration in
                configuration.label
                    .markdownTextStyle {
                        if configuration.row == 0 {
                            FontWeight(.semibold)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(CrowiTypography.bodyLineSpacingRatio))
                    .relativePadding(.horizontal, length: .em(0.72))
                    .relativePadding(.vertical, length: .em(CrowiTypography.bodyRelatedItemSpacingRatio / 2))
            }
    }
}
