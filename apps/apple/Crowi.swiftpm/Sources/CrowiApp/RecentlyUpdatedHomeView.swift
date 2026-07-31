import CrowiKit
import SwiftUI

/// feature-ios-design-language (3) — the recency-first workspace home: a
/// "Recently Updated" list (updater avatar + relative time via the same
/// `PageRowMetadataLabel` the tree rows use) with the page tree demoted to
/// ONE entry point at the top. This replaces `PageTreeView` as
/// `WorkspaceHomeView`'s root content only — the tree's own behavior is
/// untouched (spec: out of scope).
///
/// Data source (recorded in the spec's "(3) データ源確認(実施記録)"): the
/// EXISTING `GET /pages/list` root branch (`path=/`,
/// `handlers/page.ts:406-459`) — grant-filtered server-side
/// (`visiblePageGrantOr`/`visiblePageStatusOr`), default-sorted `updatedAt`
/// desc, `lastUpdateUser` populated (image included). No server extension
/// was needed.
///
/// Deliberately NO client-side path filter (`/user/*` pages appear): the
/// web's own `/` listing shows every visible page in the same order, and a
/// filtered subtree here would make "recently updated" silently disagree
/// between clients. `/trash` is already excluded server-side by the status
/// filter. (Task openQuestion resolved in favor of parity.)
///
/// Network-only, like `RecentlyViewedView` (which remains the separate
/// "recently VIEWED by me" screen behind its toolbar button): no SwiftData
/// cache model for this listing — the home always reflects a fresh fetch.
///
/// ## feature-ios-visual-redesign Phase 1
///
/// This screen IS the design's Home "Recently updated" card, so it is where
/// the design language lands most literally: a large screen title, uppercase
/// section headers, and `CrowiCard`-contained rows instead of `List`'s
/// grouped chrome. It is also the one screen that owns its own title area —
/// the navigation bar here carries actions only (there is no back button at
/// the stack root), so the bar's title is suppressed and `CrowiScreenTitle`
/// renders it at the design's weight rather than printing it twice.
///
/// ## feature-ios-visual-redesign Phase 2
///
/// The title is the design's "Home" (this screen is the Home TAB now), and
/// the workspace name moves to the subtitle line the design puts it on —
/// where it doubles as the app's ONE workspace-switcher affordance
/// (`CrowiWorkspaceSwitcherButton`), replacing the "Workspaces" toolbar
/// button. The page count the design pairs with it ("· 128 pages") is still
/// not rendered: no endpoint reports a workspace-wide total. The "Your
/// drafts" card is likewise not built — the app has no drafts concept, and
/// inventing one would mean inventing the data behind it.
struct RecentlyUpdatedHomeView: View {
    let session: WorkspaceSession
    let onSelect: (ReadDestination) -> Void
    /// Presents `RootScene`'s workspace-switcher sheet.
    let onShowSwitcher: () -> Void

    @State private var pages: [PageLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?

    /// The home's initial screenful — the server default is 50
    /// (`ListPagesRequestSchema.limit`), more than a home screen needs.
    /// Paging is out of scope (spec).
    private static let listLimit = 20

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                CrowiScreenTitle("Home") {
                    CrowiWorkspaceSwitcherButton(
                        workspaceName: session.context.workspace.displayTitle,
                        action: onShowSwitcher
                    )
                }

                // The tree entry point stays ABOVE the recency list (not in
                // the toolbar, which is owned by `WorkspaceHomeView` and
                // already carries switcher/search/recently-viewed/profile —
                // task openQuestion). It must stay reachable even when the
                // recency fetch fails, so the empty/error state below renders
                // as its own card rather than as a whole-view overlay
                // covering this link.
                CrowiSectionHeader("Browse")
                CrowiCard {
                    NavigationLink {
                        PageTreeView(session: session, path: "/", onSelect: onSelect)
                    } label: {
                        CrowiRow {
                            CrowiRowChip(systemImage: "folder")
                        } content: {
                            Text("Browse Pages")
                                .font(CrowiTypography.rowTitle)
                                .foregroundStyle(CrowiTheme.foreground)
                        }
                    }
                    .buttonStyle(.plain)
                }

                CrowiSectionHeader("Recently updated")
                if pages.isEmpty {
                    CrowiCard {
                        CrowiRow(showsChevron: false) {
                            if isLoading {
                                ProgressView()
                                    .frame(maxWidth: .infinity, alignment: .center)
                            } else {
                                Text(loadErrorMessage ?? "No pages here yet")
                                    .font(CrowiTypography.rowMeta)
                                    .foregroundStyle(CrowiTheme.mutedForeground)
                            }
                        }
                    }
                } else {
                    CrowiCardRows(pages, id: \.id) { page in
                        Button {
                            onSelect(.page(path: page.path))
                        } label: {
                            CrowiPageRow(
                                path: page.path,
                                lastUpdatedAt: page.updatedAt,
                                updaterName: page.lastUpdateUserName,
                                updaterImage: page.lastUpdateUserImage,
                                loader: session.imageCache
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        // The title block is rendered in the CONTENT by `CrowiScreenTitle`
        // above, so the bar shows only the toolbar actions. A non-empty bar
        // title here would print the same words a second time, 60pt higher.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        // `.task` re-fires every time this view becomes the top of the
        // `NavigationStack` again — e.g. popping back from a page onto home
        // — which is SwiftUI's documented behavior, not a bug. That makes
        // this a background refresh far more often than an initial load, so
        // only flip `isLoading` (and show the spinner) when there is nothing
        // on screen yet; toggling it unconditionally forces a body
        // re-evaluation for a refetch that should be invisible when it
        // changes nothing.
        let isInitialLoad = pages.isEmpty
        if isInitialLoad { isLoading = true }
        defer { if isInitialLoad { isLoading = false } }
        do {
            let response = try await ListPagesResponseLenient.fetch(path: "/", limit: Self.listLimit, using: session.apiClient)
            // Skip the assignment when the refetch is a no-op (`PageLenient`
            // is `Equatable`) — reassigning an identical array still forces
            // SwiftUI to re-diff and re-render every row in the `ForEach`,
            // which is the other half of the pop-to-home stutter.
            if response.pages != pages {
                pages = response.pages
            }
            loadErrorMessage = nil
        } catch {
            loadErrorMessage = pages.isEmpty ? "Couldn't load recently updated pages." : nil
        }
    }
}
