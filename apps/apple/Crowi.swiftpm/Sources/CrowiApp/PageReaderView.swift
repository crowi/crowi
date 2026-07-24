import CrowiKit
import SwiftUI

/// RFC-0016 §8/§9/feature-ios-phase1-read — the page reader: always opens
/// via the single-page detail `GET` (§8's "detail-GET-before-render" rule —
/// a list/children-supplied row may carry no `body` at all), natively
/// renders the body (`WorkspacePageMarkdownView`), and shows like/bookmark/
/// seen-count state, comments (read), and backlinks. Everything here is
/// READ-ONLY — engagement toggles and comment posting are bounded-write
/// (`feature-ios-phase2-write`).
struct PageReaderView: View {
    let session: WorkspaceSession
    let path: String
    let onSelectDestination: (ReadDestination) -> Void

    @State private var page: PageLenient?
    @State private var myProfileId: String?
    @State private var isBookmarked = false
    @State private var comments: [CommentLenient] = []
    @State private var backlinks: [BacklinkLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let page, let body = page.revision?.body {
                    WorkspacePageMarkdownView(
                        rawBody: body,
                        imageLoader: session.imageCache,
                        imageBaseURL: session.context.workspace.workspaceOrigin.baseURL,
                        onNavigateToWikiLink: { target in onSelectDestination(.page(path: target)) },
                        onNavigateToMention: { username in onSelectDestination(.profile(username: username)) },
                        onNavigateToRelativePath: { target in onSelectDestination(.page(path: target)) },
                        // feature-ios-image-viewer — tapping a body image
                        // opens the fullscreen zoom viewer, which fetches the
                        // ORIGINAL bytes (resolved via /attachments/<id>/meta,
                        // canonical fallback) through the same per-workspace
                        // image cache the body render used; the body embed
                        // itself stays on the canonical display derivative.
                        imageViewer: ImageViewerConfiguration(
                            resolver: OriginalImageResolver(
                                workspaceOrigin: session.context.workspace.workspaceOrigin,
                                apiClient: session.apiClient
                            ),
                            confidentialNotice: session.confidential
                        )
                    )
                    engagementBar(for: page)
                    if !backlinks.isEmpty {
                        backlinksSection
                    }
                    if !comments.isEmpty {
                        commentsSection
                    }
                } else if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else if let loadErrorMessage {
                    ContentUnavailableView(loadErrorMessage, systemImage: "exclamationmark.triangle")
                }
            }
            .padding()
        }
        .navigationTitle(page?.path ?? path)
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    if let pageId = page?.id {
                        onSelectDestination(.revisionHistory(pageId: pageId, pagePath: path))
                    }
                } label: {
                    Label("History", systemImage: "clock.arrow.circlepath")
                }
                .disabled(page == nil)
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    private func engagementBar(for page: PageLenient) -> some View {
        HStack(spacing: 16) {
            Label("\(page.likerCount ?? 0)", systemImage: likedByMe(page) ? "heart.fill" : "heart")
                .foregroundStyle(likedByMe(page) ? .red : .secondary)
            if isBookmarked {
                Label("Bookmarked", systemImage: "bookmark.fill")
                    .foregroundStyle(.orange)
            }
            Label("\(page.seenUsersCount ?? 0)", systemImage: "eye")
                .foregroundStyle(.secondary)
            Label("\(page.commentCount ?? 0)", systemImage: "bubble.left")
                .foregroundStyle(.secondary)
        }
        .font(.footnote)
    }

    private func likedByMe(_ page: PageLenient) -> Bool {
        guard let myProfileId, let liker = page.liker else { return false }
        return liker.contains(myProfileId)
    }

    private var backlinksSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Backlinks").font(.headline)
            ForEach(backlinks) { backlink in
                Button {
                    onSelectDestination(.page(path: backlink.fromPagePath))
                } label: {
                    Text(backlink.fromPagePath).font(.subheadline)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Comments").font(.headline)
            ForEach(comments) { comment in
                HStack(alignment: .top, spacing: 8) {
                    WorkspaceAvatarView(imageURLString: comment.creatorImage, loader: session.imageCache, size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(comment.creatorName ?? comment.creatorUsername ?? "Unknown").font(.subheadline.bold())
                        Text(comment.comment).font(.body)
                    }
                }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        if let cached = CachedPage.cached(path: path, in: session.modelContext), page == nil {
            page = cached.asPageLenient
        }
        do {
            let response = try await GetPageResponseLenient.fetch(path: path, using: session.apiClient)
            page = response.page
            loadErrorMessage = nil
            CachedPage.upsert(from: response.page, in: session.modelContext)
            async let profileFetch = try? ProfileLenient.fetchMe(using: session.apiClient)
            async let bookmarkFetch = try? BookmarkResponseLenient.fetch(pageId: response.page.id, using: session.apiClient)
            async let commentsFetch = try? fetchAndCacheComments(pageId: response.page.id)
            async let backlinksFetch = try? fetchAndCacheBacklinks(pageId: response.page.id)
            myProfileId = (await profileFetch)?.id
            isBookmarked = (await bookmarkFetch)?.isBookmarked ?? false
            comments = (await commentsFetch) ?? []
            backlinks = (await backlinksFetch) ?? []
        } catch {
            loadErrorMessage = page == nil ? "Couldn't load this page." : nil
        }
    }

    private func fetchAndCacheComments(pageId: String) async throws -> [CommentLenient] {
        let response = try await ListCommentsResponseLenient.fetch(pageId: pageId, using: session.apiClient)
        CachedComment.upsert(pageId: pageId, comments: response.comments, in: session.modelContext)
        return response.comments
    }

    private func fetchAndCacheBacklinks(pageId: String) async throws -> [BacklinkLenient] {
        let response = try await GetBacklinksResponseLenient.fetch(pageId: pageId, using: session.apiClient)
        CachedBacklink.upsert(pageId: pageId, backlinks: response.backlinks, in: session.modelContext)
        return response.backlinks
    }
}
