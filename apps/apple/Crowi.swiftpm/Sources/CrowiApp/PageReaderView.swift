import CrowiKit
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

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
///
/// `feature-ios-visual-redesign` Phase 3 gives the screen the design's
/// chrome, and in doing so SPLITS engagement in two:
///   - the read-only counts (views / likes / comments) move up into
///     `CrowiPageHeader`, beside the title, breadcrumb and byline;
///   - the toggles move down into the floating pill (`CrowiPageActionBar`),
///     which also carries Edit and the entry to the action sheet.
/// The inline engagement bar that used to hold both is gone — nothing it did
/// is: the seen count is the header's "views" stat, each toggle is still
/// disabled while its OWN write is in flight, a failed toggle still reverts
/// and still says so (`CrowiPageActionFailureNotice`, above the pill), and
/// watch — which the design's pill has no slot for — is a row in the action
/// sheet.
///
/// The pill is hosted as this screen's own `safeAreaInset(edge:.bottom)`,
/// which is only free because the tab bar's inset collapses whenever the
/// active tab has pushed something (`CrowiTabNavigation.isTabBarVisible`) and
/// a page is always pushed; at regular width there is no tab bar at all.
struct PageReaderView: View {
    let session: WorkspaceSession
    let path: String
    let onSelectDestination: (ReadDestination) -> Void

    @State private var page: PageLenient?
    @State private var myProfileId: String?
    /// The signed-in user's own avatar and name — the composer's leading
    /// disc. From the SAME `GET /me` the like state already needs, so this
    /// costs no extra request.
    @State private var myProfileImage: String?
    @State private var myProfileName: String?
    @State private var engagement: PageEngagementModel?
    @State private var comments: [CommentLenient] = []
    @State private var backlinks: [BacklinkLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?
    @State private var showEditor = false

    @State private var showTableOfContents = false
    /// Derived ONCE per page (`apply(_:)`), not per render: extracting it is a
    /// walk of the whole AST, and this view's body re-evaluates on every
    /// engagement toggle and comment refresh.
    @State private var tableOfContents: [RenderedAstHeading] = []
    /// Held as an object, and deliberately NEVER read in this view's body:
    /// only the 2pt bar, the TOC sheet's label and the navigation bar's
    /// background modifier observe it, so a scroll frame does not
    /// re-evaluate the whole rendered page. See `CrowiReadingProgressModel`.
    @State private var readingProgress = CrowiReadingProgressModel()

    /// The scroll target the pill's comment button jumps to.
    private static let commentsAnchor = "crowi-reader-comments"

    var body: some View {
        // The reader wraps the scroll container so rendered-AST heading
        // anchors (`RenderedAstView.anchorID`) are reachable from in-page
        // `#fragment` links AND from the table of contents (RFC-0023 Phase 4 —
        // the server-issued heading ids are the anchors, never a client-local
        // slugger).
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
                        header(for: page)
                        PageBodyView(
                            session: session,
                            renderedAst: page.revision?.renderedAst,
                            rawBody: body,
                            onSelectDestination: onSelectDestination,
                            onNavigateToFragment: { fragment in
                                scroll(to: RenderedAstView.anchorID(fragment), using: proxy)
                            }
                        )
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
            .crowiReadingProgress(readingProgress)
            .safeAreaInset(edge: .top, spacing: 0) {
                if CrowiReadingProgress.isMeasurable {
                    CrowiReadingProgressBar(progress: readingProgress)
                }
            }
            // Only the failure notice is still hosted by hand: it is a
            // transient message about a reverted write, which no toolbar
            // placement expresses. The controls themselves moved into the
            // system's bottom toolbar (`pageActions`).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if engagement?.lastActionFailed == true {
                    CrowiPageActionFailureNotice()
                        // Anchored to the screen's bottom rather than riding
                        // up on the keyboard when the composer is focused: it
                        // is chrome for the page, not an accessory for the
                        // field.
                        .ignoresSafeArea(.keyboard, edges: .bottom)
                }
            }
            .toolbar { pageActions(proxy: proxy) }
            .sheet(isPresented: $showTableOfContents) {
                CrowiTableOfContentsSheet(
                    headings: tableOfContents,
                    progress: readingProgress,
                    onSelect: { heading in
                        showTableOfContents = false
                        guard let anchor = heading.anchor else { return }
                        scroll(to: RenderedAstView.anchorID(anchor), using: proxy)
                    },
                    onDone: { showTableOfContents = false }
                )
            }
        }
        .navigationTitle(PageRowTitleLabel(path: page?.path ?? path).titleText)
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        // The design's transparent-at-the-top bar. Driven explicitly because
        // the progress rule's `safeAreaInset` above breaks the bar's own
        // scroll tracking — see `CrowiScrolledToolbarBackground`.
        .crowiScrolledToolbarBackground(readingProgress)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                // The design's two nav-bar affordances. Everything the toolbar
                // used to carry moved: Edit into the pill, History into the
                // action sheet.
                if !tableOfContents.isEmpty {
                    // Absent — not disabled-and-empty — on the raw-body
                    // fallback path, which has no AST and therefore no
                    // anchors to jump to.
                    Button {
                        showTableOfContents = true
                    } label: {
                        Label("Contents", systemImage: "list.bullet")
                    }
                }
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
                apply(latest)
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    // MARK: - Header

    private func header(for page: PageLenient) -> some View {
        CrowiPageHeader(
            path: page.path,
            updaterName: page.lastUpdateUserName,
            updaterImage: page.lastUpdateUserImage,
            updatedAt: page.updatedAt,
            // The seen count the inline engagement bar used to show, with the
            // same precedence: the engagement model's settled (post
            // mark-seen) value once it exists, the pre-mark detail-GET value
            // otherwise (cold-cache paint / model not yet built).
            seenCount: engagement?.seenUsersCount ?? page.seenUsersCount ?? 0,
            likeCount: likeCount(for: page),
            commentCount: commentCount(for: page),
            loader: session.imageCache
        )
    }

    /// Prefers the interactive model's count so the header and the pill can
    /// never disagree after a toggle.
    private func likeCount(for page: PageLenient) -> Int {
        engagement?.likerCount ?? page.likerCount ?? 0
    }

    /// Once comments have actually loaded they ARE the count — the page's own
    /// `commentCount` is from the detail GET and goes stale the moment the
    /// composer posts one. Before that (or after a failed comments fetch) the
    /// server's number is all there is.
    private func commentCount(for page: PageLenient) -> Int {
        comments.isEmpty ? (page.commentCount ?? 0) : comments.count
    }

    // MARK: - Bottom bar

    /// The design's floating pill, as the system's own bottom toolbar.
    ///
    /// The app drew this as a hand-built glass capsule until the tab bar's
    /// migration showed what that costs: on iOS 26 a `.bottomBar` toolbar IS
    /// Liquid Glass, with press feedback, Dynamic Type, VoiceOver and the
    /// platform's own layout, for no code at all. It is also a single row of
    /// controls rather than icon-over-label, so it sits lower than the tab bar
    /// it replaces while a page is open.
    ///
    /// The counts stay inline (`♡ 3`) rather than becoming `.badge`, because
    /// they are VALUES the design shows, not unread markers — a toolbar item
    /// can host any view, so the label is an icon beside its number.
    @ToolbarContentBuilder
    private func pageActions(proxy: ScrollViewProxy) -> some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            Button {
                showEditor = true
            } label: {
                Label("Edit", systemImage: "square.and.pencil")
            }
            .disabled(page == nil)

            Button {
                Task { await engagement?.toggleBookmark() }
            } label: {
                Label(
                    engagement?.isBookmarked == true ? "Remove Bookmark" : "Bookmark",
                    systemImage: engagement?.isBookmarked == true ? "bookmark.fill" : "bookmark"
                )
            }
            // Each toggle stays disabled while ITS OWN write is in flight (the
            // model's per-toggle guard is the backstop) — a rapid double-tap
            // must never race two requests. The cold-cache paint has counts
            // but no model to write through yet, so the toggles are inert in
            // that window rather than swallowing taps.
            .disabled(engagement?.isTogglingBookmark ?? true)

            Button {
                Task { await engagement?.toggleLike() }
            } label: {
                countLabel(
                    engagement?.likedByMe == true ? "Unlike" : "Like",
                    systemImage: engagement?.likedByMe == true ? "heart.fill" : "heart",
                    count: page.map(likeCount(for:)) ?? 0
                )
            }
            .disabled(engagement?.isTogglingLike ?? true)

            Button {
                scroll(to: Self.commentsAnchor, using: proxy)
            } label: {
                countLabel("Comments", systemImage: "bubble.left", count: page.map(commentCount(for:)) ?? 0)
            }

            // Safari's composition: the overflow menu grows out of the ⋯ in
            // the bottom bar. A `Menu` anchors and morphs there by itself —
            // the app used to open a hand-drawn bottom sheet from this button,
            // which had to reimplement the backdrop, the drag-to-dismiss and
            // the escape gesture, and could never match the OS's glass.
            Menu {
                pageActionsMenu
            } label: {
                Label("More Actions", systemImage: "ellipsis")
            }
            .disabled(page == nil)
        }
    }

    /// The overflow menu's items. `Section` is what draws the divider Safari's
    /// own menu shows between groups.
    @ViewBuilder
    private var pageActionsMenu: some View {
        if let page, let shareURL = pageURL(for: page) {
            Section {
                ShareLink(item: shareURL) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                Button {
                    perform(.copyLink, page: page, shareURL: shareURL)
                } label: {
                    Label("Copy Link", systemImage: "link")
                }
            }
            Section {
                Button {
                    perform(.versionHistory, page: page, shareURL: shareURL)
                } label: {
                    Label("Version History", systemImage: "clock.arrow.circlepath")
                }
                Button {
                    perform(.watch, page: page, shareURL: shareURL)
                } label: {
                    Label(
                        engagement?.isWatching == true ? "Stop Watching" : "Watch Page",
                        systemImage: engagement?.isWatching == true ? "bell.fill" : "bell"
                    )
                }
                .disabled(engagement?.isTogglingWatch ?? true)
            }
        }
    }

    /// An icon beside its count — the design's `♡ 3`, as a toolbar item's
    /// label.
    ///
    /// `.titleAndIcon` is load-bearing: a toolbar collapses a `Label` to its
    /// ICON by default, silently dropping the number. These counts are values
    /// the page is showing, not decoration on a button.
    private func countLabel(_ title: String, systemImage: String, count: Int) -> some View {
        Label {
            Text(count, format: .number)
        } icon: {
            Image(systemName: systemImage)
        }
        .labelStyle(.titleAndIcon)
        .accessibilityLabel("\(title), \(count)")
    }

    private func scroll(to anchor: String, using proxy: ScrollViewProxy) {
        withAnimation {
            proxy.scrollTo(anchor, anchor: .top)
        }
    }

    // MARK: - Action sheet

    /// The page's browser url — what Share hands to the system sheet and what
    /// Copy Link puts on the pasteboard.
    private func pageURL(for page: PageLenient) -> URL? {
        session.context.workspace.workspaceOrigin.pageURL(forPath: page.path)
    }

    private func perform(_ action: CrowiPageAction, page: PageLenient, shareURL: URL) {
        switch action {
        case .share:
            // Presented by the sheet's own `ShareLink`; nothing to do here.
            break
        case .copyLink:
            #if canImport(UIKit)
            UIPasteboard.general.string = shareURL.absoluteString
            #endif

        case .versionHistory:

            onSelectDestination(.revisionHistory(pageId: page.id, pagePath: page.path))
        case .watch:
            // The one engagement toggle with no slot in the design's pill —
            // same optimistic-write-plus-revert model as the other two.
            Task { await engagement?.toggleWatch() }
        }
    }

    // MARK: - Sections

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
        VStack(alignment: .leading, spacing: CrowiMetrics.commentSpacing) {
            // The design's rule between the body and the discussion under it.
            Rectangle()
                .fill(CrowiTheme.border)
                .frame(height: CrowiTheme.hairline)
                .accessibilityHidden(true)
            Text(commentsTitle)
                .font(CrowiTypography.inPageSectionTitle)
                .foregroundStyle(CrowiTheme.foreground)
                .accessibilityAddTraits(.isHeader)
            ForEach(comments) { comment in
                CrowiCommentRow(
                    authorName: comment.creatorName ?? comment.creatorUsername ?? "Unknown",
                    authorImageURLString: comment.creatorImage,
                    relativeTime: PageRowMetadataLabel.relativeTimeText(from: comment.createdAt),
                    text: comment.comment,
                    loader: session.imageCache
                )
            }
            if let revisionId = page.revision?.id {
                CommentComposerView(
                    session: session,
                    pageId: page.id,
                    revisionId: revisionId,
                    authorImageURLString: myProfileImage,
                    authorName: myProfileName
                ) {
                    comments = (try? await fetchAndCacheComments(pageId: page.id)) ?? comments
                }
            }
        }
        // The pill's comment button scrolls here.
        .id(Self.commentsAnchor)
    }

    /// The design's "Comments · 2". The count is dropped when there are none:
    /// "Comments · 0" states a nothing, and the composer under the heading
    /// already says what the section is for.
    private var commentsTitle: String {
        comments.isEmpty ? "Comments" : "Comments · \(comments.count)"
    }

    /// The ONE place `page` is assigned, so the derived table of contents can
    /// never be left describing the previous revision. `[]` on every path
    /// without a decoded envelope (a cache-painted page, an old server's bare
    /// `Root`, an envelope that failed a limit gate) — which is exactly when
    /// the reader hides the Contents control.
    private func apply(_ newPage: PageLenient) {
        page = newPage
        tableOfContents = RenderedAstTableOfContents.headings(in: newPage.revision?.renderedAst)
    }

    private func likedByMe(_ page: PageLenient) -> Bool {
        guard let myProfileId, let liker = page.liker else { return false }
        return liker.contains(myProfileId)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        if let cached = CachedPage.cached(path: path, in: session.modelContext), page == nil {
            apply(cached.asPageLenient)
        }
        do {
            let response = try await GetPageResponseLenient.fetch(path: path, using: session.apiClient)
            apply(response.page)
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
            let profile = await profileFetch
            myProfileId = profile?.id
            myProfileImage = profile?.image
            myProfileName = profile?.name ?? profile?.username
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
