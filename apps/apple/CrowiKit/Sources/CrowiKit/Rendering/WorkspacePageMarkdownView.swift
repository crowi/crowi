import MarkdownUI
import SwiftUI

/// RFC-0016 §6/§6.2/§15 — composes `Markdown(body)` (gate C's selected
/// renderer) with:
///   - `WorkspaceMarkdownImageProvider` — the proven §6.1 same-origin-Bearer
///     + redirect-strip authenticated image loader seam (Phase 0/1, reused
///     verbatim);
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
///     allowlist check.
public struct WorkspacePageMarkdownView: View {
    let rawBody: String
    let imageLoader: any WorkspaceImageFetching
    let onNavigateToWikiLink: (String) -> Void
    let onNavigateToMention: (String) -> Void
    /// An ordinary (non-wikilink, non-mention) workspace-relative Markdown
    /// link, e.g. `[text](/some/page)` — also routed in-app, since it is
    /// just as much "workspace content" as a wikilink; only a real
    /// absolute `http(s)` URL falls through to the system default (open
    /// externally).
    let onNavigateToRelativePath: (String) -> Void

    public init(
        rawBody: String,
        imageLoader: any WorkspaceImageFetching,
        onNavigateToWikiLink: @escaping (String) -> Void,
        onNavigateToMention: @escaping (String) -> Void,
        onNavigateToRelativePath: @escaping (String) -> Void
    ) {
        self.rawBody = rawBody
        self.imageLoader = imageLoader
        self.onNavigateToWikiLink = onNavigateToWikiLink
        self.onNavigateToMention = onNavigateToMention
        self.onNavigateToRelativePath = onNavigateToRelativePath
    }

    public var body: some View {
        Markdown(WikiLinkMentionPreprocessor.preprocess(rawBody))
            .markdownImageProvider(WorkspaceMarkdownImageProvider(loader: imageLoader))
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
