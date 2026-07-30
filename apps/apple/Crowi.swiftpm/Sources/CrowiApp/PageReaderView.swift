import CrowiKit
import SwiftUI

/// RFC-0016 §8/§9/feature-ios-phase1-read — the page reader: always opens
/// via the single-page detail `GET` (§8's "detail-GET-before-render" rule —
/// a list/children-supplied row may carry no `body` at all), natively
/// renders the body (`WorkspacePageMarkdownView`), and shows like/bookmark/
/// seen-count state, comments, and backlinks.
///
/// `feature-ios-phase2-write` wires the bounded-write surface in here (the
/// phase-1 doc comment's deferred toggles/comment-posting): the engagement
/// bar becomes interactive (`PageEngagementModel` — optimistic toggle +
/// revert on failure), a comment composer sits under the comments list
/// (refreshing through the existing `fetchAndCacheComments` path), opening
/// a page marks it seen (idempotent, like the web viewer), and the toolbar
/// gains the quick-edit entry point (`PageEditorView` as a sheet).
struct PageReaderView: View {
    let session: WorkspaceSession
    let path: String
    let onSelectDestination: (ReadDestination) -> Void

    @State private var page: PageLenient?
    @State private var myProfileId: String?
    @State private var engagement: PageEngagementModel?
    @State private var comments: [CommentLenient] = []
    @State private var backlinks: [BacklinkLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?
    @State private var showEditor = false

    var body: some View {
        // The reader wraps the scroll container so rendered-AST heading
        // anchors (`RenderedAstView.anchorID`) are reachable from in-page
        // `#fragment` links (RFC-0023 Phase 4 — the server-issued heading
        // ids are the anchors, never a client-local slugger).
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let page, let body = page.revision?.body {
                        // A refresh that FAILED must not look like one that
                        // confirmed server truth — see `load()`'s catch.
                        if let loadErrorMessage {
                            Label(loadErrorMessage, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        PageBodyView(
                            session: session,
                            renderedAst: page.revision?.renderedAst,
                            rawBody: body,
                            onSelectDestination: onSelectDestination,
                            onNavigateToFragment: { fragment in
                                withAnimation {
                                    proxy.scrollTo(RenderedAstView.anchorID(fragment), anchor: .top)
                                }
                            }
                        )
                        engagementBar(for: page)
                        if !backlinks.isEmpty {
                            backlinksSection
                        }
                        commentsSection(for: page)
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
        }
        .navigationTitle(page?.path ?? path)
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    showEditor = true
                } label: {
                    Label("Edit", systemImage: "square.and.pencil")
                }
                .disabled(page == nil)
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
        .sheet(isPresented: $showEditor, onDismiss: {
            // Backstop for every editor exit that resolves to nothing (Cancel,
            // or a conflict whose re-fetch was unusable so there was no newer
            // revision to hand back): re-sync with the server instead of
            // trusting what is on screen. Deliberately an unstructured `Task`
            // — it must outlive the sheet's own teardown.
            Task { await load() }
        }) {
            // The editor runs its OWN fresh detail GET (§8 — never seeded
            // from this view's possibly-cache-painted state).
            PageEditorView(session: session, pagePath: page?.path ?? path) { latest in
                page = latest
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func engagementBar(for page: PageLenient) -> some View {
        HStack(spacing: 16) {
            if let engagement {
                // Each button is disabled while ITS OWN write is in flight
                // (the model's per-toggle guard is the backstop) — a rapid
                // double-tap must never race two like/unlike requests.
                Button {
                    Task { await engagement.toggleLike() }
                } label: {
                    Label("\(engagement.likerCount)", systemImage: engagement.likedByMe ? "heart.fill" : "heart")
                        .foregroundStyle(toggleTint(engagement.likedByMe, on: .red))
                }
                .disabled(engagement.isTogglingLike)
                Button {
                    Task { await engagement.toggleBookmark() }
                } label: {
                    Label("Bookmark", systemImage: engagement.isBookmarked ? "bookmark.fill" : "bookmark")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(toggleTint(engagement.isBookmarked, on: .orange))
                }
                .disabled(engagement.isTogglingBookmark)
                Button {
                    Task { await engagement.toggleWatch() }
                } label: {
                    Label("Watch", systemImage: engagement.isWatching ? "bell.fill" : "bell")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(toggleTint(engagement.isWatching, on: .tint))
                }
                .disabled(engagement.isTogglingWatch)
            } else {
                // Cold-cache fast-path paint before the network load settles
                // the interactive model — read-only, same glyphs.
                Label("\(page.likerCount ?? 0)", systemImage: "heart")
                    .foregroundStyle(.secondary)
            }
            // Prefers the engagement model's settled count (post mark-seen)
            // once it's loaded; falls back to the pre-mark detail-GET value
            // otherwise (cold-cache paint / model not yet built).
            Label("\(engagement?.seenUsersCount ?? page.seenUsersCount ?? 0)", systemImage: "eye")
                .foregroundStyle(.secondary)
            Label("\(page.commentCount ?? 0)", systemImage: "bubble.left")
                .foregroundStyle(.secondary)
            if engagement?.lastActionFailed == true {
                Text("Couldn't update — try again")
                    .foregroundStyle(.red)
            }
        }
        .buttonStyle(.plain)
        .font(.footnote)
    }

    /// The on/off tint of a toggle glyph — `AnyShapeStyle` erases the two
    /// differently-typed sides of the ternary.
    private func toggleTint(_ isOn: Bool, on: some ShapeStyle) -> AnyShapeStyle {
        isOn ? AnyShapeStyle(on) : AnyShapeStyle(.secondary)
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

    /// Always rendered (unlike phase 1's empty-hidden version) so the
    /// composer is reachable on a page with no comments yet. The composer
    /// needs the detail revision id (`AddCommentRequestSchema.revision_id`
    /// is required) — a detail-fetched page always carries it.
    @ViewBuilder
    private func commentsSection(for page: PageLenient) -> some View {
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
            if let revisionId = page.revision?.id {
                CommentComposerView(session: session, pageId: page.id, revisionId: revisionId) {
                    comments = (try? await fetchAndCacheComments(pageId: page.id)) ?? comments
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
            let actions = EngagementActions(client: session.apiClient)
            async let profileFetch = try? ProfileLenient.fetchMe(using: session.apiClient)
            async let bookmarkFetch = try? BookmarkResponseLenient.fetch(pageId: response.page.id, using: session.apiClient)
            async let watchFetch = try? actions.watchStatus(pageId: response.page.id)
            async let commentsFetch = try? fetchAndCacheComments(pageId: response.page.id)
            async let backlinksFetch = try? fetchAndCacheBacklinks(pageId: response.page.id)
            // Opening a page marks it seen, like the web viewer — idempotent
            // server-side (`addToSet`) and best-effort: a failure never
            // degrades the read experience (no error UI/retry). Ruling: spec
            // `feature-ios-phase2-write.md:27` classifies seen as a toggle
            // (楽観更新 + 失敗時 revert で可), unlike §7.4's fail-fast + manual
            // retry which is for create/edit. `try?` turns a thrown failure
            // into `nil`; that `nil` is NOT discarded below — it drives
            // `applySeenMarkResult`, which leaves the pre-mark count in
            // place instead of silently treating the failure as success.
            async let seenMarkResult: Int? = try? actions.markSeen(pageId: response.page.id)
            myProfileId = (await profileFetch)?.id
            let isBookmarked = (await bookmarkFetch)?.isBookmarked ?? false
            let isWatching = (await watchFetch) ?? false
            comments = (await commentsFetch) ?? []
            backlinks = (await backlinksFetch) ?? []
            let engagementModel = PageEngagementModel(
                pageId: response.page.id,
                likedByMe: likedByMe(response.page),
                likerCount: response.page.likerCount ?? 0,
                isBookmarked: isBookmarked,
                isWatching: isWatching,
                seenUsersCount: response.page.seenUsersCount ?? 0,
                actions: actions
            )
            engagementModel.applySeenMarkResult(await seenMarkResult)
            engagement = engagementModel
        } catch {
            // A cancelled load is not a failure: the view went away, or the
            // pull-to-refresh control tore its task down. Report nothing and
            // leave whatever is on screen alone.
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                return
            }
            // Otherwise SAY SO, even when content is already on screen. This
            // branch used to clear the message whenever `page != nil`, which
            // made a failed pull-to-refresh indistinguishable from one that
            // confirmed server truth — the reader silently kept stale content
            // and looked freshly loaded (reported 2026-07-25).
            loadErrorMessage = page == nil
                ? "Couldn't load this page."
                : "Couldn't refresh — showing the last version that loaded."
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
