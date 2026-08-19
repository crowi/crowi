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
///       (`hasPortal`), its body renders as a section ABOVE the children
///       list — the web portal's mental model — via the same detail-GET +
///       `WorkspacePageMarkdownView` wiring `PageReaderView` uses. A missing
///       portal body (a portal-like path with no document, a 404, any fetch
///       failure) silently omits the section.
///
/// feature-ios-visual-redesign Phase 1 restyles the children into the shared
/// `CrowiCard` + `CrowiRow` vocabulary (the folder/page glyph becomes the
/// design's `var(--muted)` leading chip). The rows keep showing the RAW path
/// segment — `feature-ios-page-display-name` deliberately left tree rows
/// unlike flat lists, since a tree row's whole job is to name the one segment
/// you are about to descend into. The portal body deliberately does NOT go
/// inside a card: the design renders page bodies edge-to-edge at a 20pt inset
/// (its "Page view"), and boxing long-form markdown at a further 15pt row
/// inset would narrow the measure for no gain.
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let portalBody {
                    // RFC-0023 Phase 4 — the portal body takes the same
                    // AST-first / raw-body-fallback branch as the reader
                    // (fetched through the same `GetPageResponseLenient`
                    // negotiation). Fragment links are inert here (this
                    // section has no scroll target of its own); the "View
                    // Portal Page" affordance opens the full reader where
                    // anchors work.
                    PageBodyView(
                        session: session,
                        renderedAst: portalPage?.revision?.renderedAst,
                        rawBody: portalBody,
                        onSelectDestination: onSelect
                    )
                    .padding(.horizontal, CrowiMetrics.screenHorizontalMargin)
                    .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
                }
                if !children.isEmpty {
                    CrowiSectionHeader("Pages")
                    CrowiCardRows(children, id: \.path) { child in
                        row(for: child)
                    }
                } else if portalBody == nil {
                    // Only when nothing at all is on screen — a rendered
                    // portal body with zero children is a legitimate state
                    // (body-only portal), not an empty/error one.
                    emptyStateView
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle(path == "/" ? "Pages" : path)
        .toolbar {
            // feature-ios-phase2-write — the tree's current directory is the
            // natural relative origin for a new page's path input.
            ToolbarItem(placement: .primaryAction) {
                Button {
                    onSelect(.createPage(originPath: path))
                } label: {
                    Label("New Page", systemImage: "square.and.pencil")
                }
            }
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
    private var emptyStateView: some View {
        Group {
            if isLoading {
                ProgressView()
            } else if let loadErrorMessage {
                ContentUnavailableView(loadErrorMessage, systemImage: "exclamationmark.triangle")
            } else {
                ContentUnavailableView("No pages here yet", systemImage: "doc.text")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 280)
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
            Button {
                onSelect(.pageTree(path: child.path, hasPortal: child.hasPortal))
            } label: {
                label(for: child, systemImage: child.hasPortal ? "folder.fill" : "folder")
            }
            .buttonStyle(.plain)
        } else if child.isPage {
            Button {
                onSelect(.page(path: String(child.path.dropLast())))
            } label: {
                label(for: child, systemImage: "doc.text")
            }
            .buttonStyle(.plain)
        } else {
            // Neither a page nor a directory — nothing to open, so no
            // chevron either: the affordance has to mean something.
            label(for: child, systemImage: "questionmark.folder", showsChevron: false)
        }
    }

    private func label(for child: PageChildSegmentLenient, systemImage: String, showsChevron: Bool = true) -> some View {
        CrowiRow(showsChevron: showsChevron) {
            CrowiRowChip(systemImage: systemImage)
        } content: {
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                // The RAW segment, not a display name — see this view's doc
                // comment.
                Text(child.segment)
                    .font(CrowiTypography.rowTitle)
                    .foregroundStyle(CrowiTheme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                // (1) — renders nothing at all when the server predates
                // feature-child-segments-metadata (both fields nil), so the
                // row falls back to exactly its previous look.
                PageRowMetadataLabel(
                    lastUpdatedAt: child.lastUpdatedAt,
                    updaterName: child.updaterName,
                    updaterImage: child.updaterImage,
                    updaterUsername: child.updaterUsername,
                    loader: session.imageCache
                )
            }
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
