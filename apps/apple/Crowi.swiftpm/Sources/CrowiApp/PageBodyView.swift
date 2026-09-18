import CrowiKit
import SwiftUI

/// RFC-0023 Phase 4 — the shared page-body render, the SAME branch for every
/// detail-fetched body (`PageReaderView`, `PageTreeView`'s portal section,
/// a past revision in `RevisionHistoryView`). An RFC-0020 HTML artifact is
/// decided first and never reaches either Markdown path: its body is HTML
/// that only runs inside the server's sandbox (`ArtifactBodyView`). For
/// everything else:
///   - the server returned a v1 envelope (`X-Crowi-Ast-Version: 1` was
///     declared by the detail GET and the RESPONSE independently proved
///     to be typed) → native AST rendering (`RenderedAstView`);
///   - anything else — no `renderedAst`, a bare `Root` from an old
///     server, an unsupported version, or an envelope that failed the
///     decode limits — → the existing raw-body MarkdownUI path,
///     unchanged. Cache-painted pages always take the raw-body path
///     (the AST is online-only, wire-contract design §16).
///
/// Both paths take one closure bundle, derived here from the single
/// `ReadDestination` navigation seam, and one `ImageViewerConfiguration`
/// (feature-ios-image-viewer — tapping a body image opens the fullscreen
/// zoom viewer, which fetches the ORIGINAL bytes (resolved via
/// `/attachments/<id>/meta`, canonical fallback) through the same
/// per-workspace image cache the body render used; the body embed itself
/// stays on the canonical display derivative).
struct PageBodyView: View {
    let session: WorkspaceSession
    /// Required at every call site rather than defaulted: a forgotten one
    /// would render an artifact's HTML source as Markdown.
    let contentType: PageContentType
    /// What an artifact's delivery URL is minted for. Unused for Markdown.
    let pageId: String
    let revisionId: String?
    /// The detail response's decode outcome — anything but `.envelope`
    /// (including `nil`, the cache-painted case) renders the raw body.
    let renderedAst: RenderedAstDecodeOutcome?
    let rawBody: String
    /// The path of the page this body belongs to. A relative link means
    /// nothing without it — the browser resolves one against the document's
    /// own URL, and a native reader has no such thing to fall back on.
    let sourcePath: String
    let onSelectDestination: (ReadDestination) -> Void
    /// Set only where the host owns a scroll container that registers the
    /// rendered-AST heading anchors (the reader); when absent, in-page
    /// `#fragment` links stay inert.
    var onNavigateToFragment: ((String) -> Void)?

    @EnvironmentObject private var settings: AppSettings
    @State private var externalLink: ExternalLink?
    @State private var attachment: PreviewedAttachment?

    var body: some View {
        let viewer = ImageViewerConfiguration(
            resolver: OriginalImageResolver(
                workspaceOrigin: session.context.workspace.workspaceOrigin,
                apiClient: session.apiClient
            ),
            confidentialNotice: session.confidential
        )
        Group {
            if contentType == .artifact {
                ArtifactBodyView(session: session, pageId: pageId, revisionId: revisionId)
            } else if case .envelope(let document)? = renderedAst {
                RenderedAstView(
                    document: document,
                    imageLoader: session.imageCache,
                    workspaceOrigin: session.context.workspace.workspaceOrigin.baseURL,
                    onNavigateToWikiLink: { target in onSelectDestination(.page(path: target)) },
                    onNavigateToMention: { username in onSelectDestination(.profile(username: username)) },
                    onNavigateToRelativePath: openRelative,
                    onNavigateToPageId: { pageId in onSelectDestination(.pageById(pageId)) },
                    onNavigateToFragment: onNavigateToFragment,
                    onOpenExternalURL: openExternally,
                    onOpenAttachment: { attachment = PreviewedAttachment(id: $0) },
                    imageViewer: viewer
                )
            } else {
                WorkspacePageMarkdownView(
                    rawBody: rawBody,
                    imageLoader: session.imageCache,
                    workspaceOrigin: session.context.workspace.workspaceOrigin.baseURL,
                    onNavigateToWikiLink: { target in onSelectDestination(.page(path: target)) },
                    onNavigateToMention: { username in onSelectDestination(.profile(username: username)) },
                    onNavigateToRelativePath: openRelative,
                    onNavigateToPageId: { pageId in onSelectDestination(.pageById(pageId)) },
                    onOpenExternalURL: openExternally,
                    onOpenAttachment: { attachment = PreviewedAttachment(id: $0) },
                    imageViewer: viewer
                )
            }
        }
        .sheet(item: $attachment) { attachment in
            AttachmentPreviewView(session: session, attachmentId: attachment.id)
        }
        .sheet(item: $externalLink) { link in
            SafariView(url: link.url)
                .ignoresSafeArea()
        }
    }

    /// Resolve first, THEN classify: a bare relative ref is a sibling of this
    /// page, so a 24-hex NAME must not be mistaken for a share URL's id — only
    /// an absolute single-segment path is that.
    private func openRelative(_ target: String) {
        guard let resolved = WikiPathResolver.resolve(sourcePath: sourcePath, ref: target) else { return }
        switch WikiPathResolver.isExternalRef(target) ? nil : WorkspaceLinkRouter.internalLink(forPath: resolved) {
        case .pageId(let id): onSelectDestination(.pageById(id))
        default: onSelectDestination(.page(path: resolved))
        }
    }

    /// `nil` hands the link to the system browser (`.systemAction`); a closure
    /// keeps it here. Resolved per render so flipping the setting takes effect
    /// on the next tap, with nothing to reload.
    private var openExternally: ((URL) -> Void)? {
        settings.opensLinksInApp ? { externalLink = ExternalLink(url: $0) } : nil
    }
}
