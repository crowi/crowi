import CrowiKit
import SwiftUI

/// RFC-0023 Phase 4 — the shared page-body render, the SAME two-path branch
/// for every detail-fetched body (`PageReaderView`, `PageTreeView`'s portal
/// section):
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
    /// The detail response's decode outcome — anything but `.envelope`
    /// (including `nil`, the cache-painted case) renders the raw body.
    let renderedAst: RenderedAstDecodeOutcome?
    let rawBody: String
    let onSelectDestination: (ReadDestination) -> Void
    /// Set only where the host owns a scroll container that registers the
    /// rendered-AST heading anchors (the reader); when absent, in-page
    /// `#fragment` links stay inert.
    var onNavigateToFragment: ((String) -> Void)?

    var body: some View {
        let viewer = ImageViewerConfiguration(
            resolver: OriginalImageResolver(
                workspaceOrigin: session.context.workspace.workspaceOrigin,
                apiClient: session.apiClient
            ),
            confidentialNotice: session.confidential
        )
        if case .envelope(let document)? = renderedAst {
            RenderedAstView(
                document: document,
                imageLoader: session.imageCache,
                imageBaseURL: session.context.workspace.workspaceOrigin.baseURL,
                onNavigateToWikiLink: { target in onSelectDestination(.page(path: target)) },
                onNavigateToMention: { username in onSelectDestination(.profile(username: username)) },
                onNavigateToRelativePath: { target in onSelectDestination(.page(path: target)) },
                onNavigateToFragment: onNavigateToFragment,
                imageViewer: viewer
            )
        } else {
            WorkspacePageMarkdownView(
                rawBody: rawBody,
                imageLoader: session.imageCache,
                imageBaseURL: session.context.workspace.workspaceOrigin.baseURL,
                onNavigateToWikiLink: { target in onSelectDestination(.page(path: target)) },
                onNavigateToMention: { username in onSelectDestination(.profile(username: username)) },
                onNavigateToRelativePath: { target in onSelectDestination(.page(path: target)) },
                imageViewer: viewer
            )
        }
    }
}
