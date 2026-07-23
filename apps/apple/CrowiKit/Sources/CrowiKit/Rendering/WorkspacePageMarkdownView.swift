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
///     attachment URLs (`/api/v2/attachments/<id>`) against the workspace
///     origin at the point swift-markdown-ui builds each image node's `URL`,
///     which `InlineText` needs (it has no other rebasing step). The block
///     path already rebases independently inside `WorkspaceImageLoader.fetch`,
///     so passing this does not change its behavior — confirmed the final
///     resolved URL is identical either way;
///   - `ImageAttributeBlockPreprocessor.strip(_:)` — removes RFC-0015 image
///     attribute blocks (`![alt](url){width=500px}`) BEFORE the wikilink/
///     mention rewrite and before the renderer ever sees the body, so they
///     never surface as literal garbled text next to the image. This is a
///     strip-only degrade (no attribute value is ever applied) that also
///     restores the paragraph to "image alone", which routes it through the
///     width-capped block image path instead of the inline one;
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
    let imageBaseURL: URL
    let onNavigateToWikiLink: (String) -> Void
    let onNavigateToMention: (String) -> Void
    /// An ordinary (non-wikilink, non-mention) workspace-relative Markdown
    /// link, e.g. `[text](/some/page)` — also routed in-app, since it is
    /// just as much "workspace content" as a wikilink; only a real
    /// absolute `http(s)` URL falls through to the system default (open
    /// externally).
    let onNavigateToRelativePath: (String) -> Void
    /// `feature-ios-image-viewer` — non-nil makes successfully-decoded BLOCK
    /// images tappable, presenting `ImageViewerView` fullscreen (original
    /// bytes via the configuration's resolver; canonical fallback). `nil`
    /// (the default) keeps this view exactly as before — the revision-
    /// history sheet stays viewer-less without touching its call site.
    let imageViewer: ImageViewerConfiguration?

    @State private var viewerItem: ImageViewerItem?

    public init(
        rawBody: String,
        imageLoader: any WorkspaceImageFetching,
        imageBaseURL: URL,
        onNavigateToWikiLink: @escaping (String) -> Void,
        onNavigateToMention: @escaping (String) -> Void,
        onNavigateToRelativePath: @escaping (String) -> Void,
        imageViewer: ImageViewerConfiguration? = nil
    ) {
        self.rawBody = rawBody
        self.imageLoader = imageLoader
        self.imageBaseURL = imageBaseURL
        self.onNavigateToWikiLink = onNavigateToWikiLink
        self.onNavigateToMention = onNavigateToMention
        self.onNavigateToRelativePath = onNavigateToRelativePath
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
        Markdown(WikiLinkMentionPreprocessor.preprocess(ImageAttributeBlockPreprocessor.strip(rawBody)), imageBaseURL: imageBaseURL)
            .markdownImageProvider(WorkspaceMarkdownImageProvider(loader: imageLoader, onImageTap: imageTapHandler))
            .markdownInlineImageProvider(WorkspaceMarkdownInlineImageProvider(loader: imageLoader))
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
                        guard SchemeAllowlist.isAllowed(externalURL) else {
                            // §6.2 — javascript:/data:/crowi-ios:///any other
                            // custom scheme: inert, never handed to the
                            // system.
                            return .discarded
                        }
                        guard externalURL.scheme != nil else {
                            // A workspace-relative real Markdown link — also
                            // in-app navigation, not a system open.
                            onNavigateToRelativePath(externalURL.relativeString)
                            return .handled
                        }
                        return .systemAction
                    }
                }
            )
    }
}
