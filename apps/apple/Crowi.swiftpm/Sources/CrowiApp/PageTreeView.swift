import CrowiKit
import SwiftUI

/// RFC-0016 §9 — the hierarchy/portal/children sidebar: the `NavigationSplitView`
/// sidebar column on iPad/regular width, and (behind the recency-first home,
/// feature-ios-design-language (3)) a pushed entry point on both size classes.
/// Drills into a sub-directory by pushing another `PageTreeView` for that
/// segment's path (simpler and more robust across both size classes than an
/// in-place expandable outline for a lazily-paginated, one-level-at-a-time
/// server API).
///
/// feature-ios-design-language additions — the tree's DRILL behavior itself
/// is unchanged (spec: "ツリー挙動そのものの変更" is out of scope):
///   (1) each row carries a `PageRowMetadataLabel` (relative last-updated
///       time + updater avatar from `PageChildSegment.lastUpdatedAt`/`updater`,
///       feature-child-segments-metadata) with graceful nil-degrade for
///       pre-extension servers;
///   (2) when the drilled-into path itself has a portal document
///       (`hasPortal`), its body renders as a `Section` ABOVE the children
///       list — the web portal's mental model — via the same detail-GET +
///       `WorkspacePageMarkdownView` wiring `PageReaderView` uses. A missing
///       portal body (a portal-like path with no document, a 404, any fetch
///       failure) silently omits the section.
struct PageTreeView: View {
    let session: WorkspaceSession
    let path: String
    /// Whether `path` ITSELF (not its children) has a real portal page saved
    /// at it (`PageChildSegment.hasPortal` for the segment being drilled
    /// into) — gates the inline portal-body section AND the toolbar action
    /// to open that page's own full reader (comments/backlinks/history,
    /// which the inline section doesn't show), since a segment can be BOTH a
    /// portal document and a directory of further pages at once (§9 — a
    /// portal-with-children segment must not lose its own body behind an
    /// always-drill-down affordance). Defaults to `true` for the root ("/"):
    /// a Crowi instance's home page is itself almost always a real portal
    /// document, and if it happens not to be, the body section is simply
    /// omitted (no crash).
    var hasPortal = true
    /// `RootScene`-style callback: `WorkspaceHomeView` decides what
    /// "select" means per size class (push on iPhone, set the split-view
    /// detail selection on iPad).
    let onSelect: (ReadDestination) -> Void

    @State private var children: [PageChildSegmentLenient] = []
    @State private var portalPage: PageLenient?
    @State private var isLoading = false
    @State private var loadErrorMessage: String?

    private var portalBody: String? { portalPage?.revision?.body }

    var body: some View {
        List {
            if let portalBody {
                Section {
                    WorkspacePageMarkdownView(
                        rawBody: portalBody,
                        imageLoader: session.imageCache,
                        imageBaseURL: session.context.workspace.workspaceOrigin.baseURL,
                        onNavigateToWikiLink: { target in onSelect(.page(path: target)) },
                        onNavigateToMention: { username in onSelect(.profile(username: username)) },
                        onNavigateToRelativePath: { target in onSelect(.page(path: target)) },
                        imageViewer: ImageViewerConfiguration(
                            resolver: OriginalImageResolver(
                                workspaceOrigin: session.context.workspace.workspaceOrigin,
                                apiClient: session.apiClient
                            ),
                            confidentialNotice: session.confidential
                        )
                    )
                }
            }
            Section {
                ForEach(children, id: \.path) { child in
                    row(for: child)
                }
            }
        }
        .overlay {
            // Only when nothing at all is on screen — a rendered portal body
            // with zero children is a legitimate state (body-only portal),
            // not an empty/error one.
            if children.isEmpty, portalBody == nil {
                if isLoading {
                    ProgressView()
                } else if let loadErrorMessage {
                    ContentUnavailableView(loadErrorMessage, systemImage: "exclamationmark.triangle")
                } else {
                    ContentUnavailableView("No pages here yet", systemImage: "doc.text")
                }
            }
        }
        .navigationTitle(path == "/" ? "Pages" : path)
        .toolbar {
            if hasPortal {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        // The portal document's own saved path IS `path`
                        // (trailing-slashed, e.g. `/crowi/rfc/`) — unlike a
                        // leaf page below, never dropped: a portal's page
                        // row in `pages` is stored WITH the trailing slash.
                        onSelect(.page(path: path))
                    } label: {
                        Label("View Portal Page", systemImage: "doc.text")
                    }
                }
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func row(for child: PageChildSegmentLenient) -> some View {
        // A directory-like segment (a portal doc, or descendants exist)
        // drills further; a pure leaf page opens directly. A segment that
        // is BOTH a portal document AND a directory (`hasPortal && count >
        // 0`) still drills down as its primary action, but carries its own
        // toolbar affordance (above, once pushed) to open the portal body
        // itself — so neither the children nor the portal's own content is
        // ever unreachable.
        if child.hasPortal || child.count > 0 {
            NavigationLink {
                PageTreeView(session: session, path: child.path, hasPortal: child.hasPortal, onSelect: onSelect)
            } label: {
                label(for: child, systemImage: child.hasPortal ? "folder.fill" : "folder")
            }
        } else if child.isPage {
            Button {
                onSelect(.page(path: String(child.path.dropLast())))
            } label: {
                label(for: child, systemImage: "doc.text")
            }
            .buttonStyle(.plain)
        } else {
            label(for: child, systemImage: "questionmark.folder")
        }
    }

    private func label(for child: PageChildSegmentLenient, systemImage: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(child.segment)
                // (1) — renders nothing at all when the server predates
                // feature-child-segments-metadata (both fields nil), so the
                // row falls back to exactly its previous look.
                PageRowMetadataLabel(
                    lastUpdatedAt: child.lastUpdatedAt,
                    updaterName: child.updaterName,
                    updaterImage: child.updaterImage,
                    loader: session.imageCache
                )
            }
        } icon: {
            Image(systemName: systemImage)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        // (2) fast-path: paint the portal body from the read cache while the
        // network refresh runs — the same `CachedPage` seam `PageReaderView`
        // uses (only ever REPLACED by a successful fresh fetch, so a network
        // failure keeps the cached body on screen).
        if hasPortal, portalPage == nil, let cached = CachedPage.cached(path: path, in: session.modelContext), cached.body != nil {
            portalPage = cached.asPageLenient
        }
        async let portalFetch = fetchPortalDetail()
        do {
            let response = try await ListPageChildrenResponseLenient.fetch(path: path, using: session.apiClient)
            children = response.children
            loadErrorMessage = nil
            CachedPageChildren.upsert(path: path, children: response.children, in: session.modelContext)
        } catch {
            if let cached = CachedPageChildren.cached(path: path, in: session.modelContext), !cached.isEmpty {
                children = cached
            }
            loadErrorMessage = children.isEmpty ? "Couldn't load this workspace's pages." : nil
        }
        if let portalResponse = await portalFetch {
            portalPage = portalResponse.page
            CachedPage.upsert(from: portalResponse.page, in: session.modelContext)
        }
    }

    /// (2) — the portal document's own detail, fetched with the SAME
    /// trailing-slash `path` this view lists children for (a portal's page
    /// row is stored WITH the slash — the toolbar affordance above already
    /// relies on this). Any failure (no portal document at this path, 404,
    /// network) returns `nil`, which silently omits the body section — the
    /// spec's "本文が無いポータル的パスでは子ページ一覧のみ".
    private func fetchPortalDetail() async -> GetPageResponseLenient? {
        guard hasPortal else { return nil }
        return try? await GetPageResponseLenient.fetch(path: path, using: session.apiClient)
    }
}
