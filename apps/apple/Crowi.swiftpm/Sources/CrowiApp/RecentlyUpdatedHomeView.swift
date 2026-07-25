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
struct RecentlyUpdatedHomeView: View {
    let session: WorkspaceSession
    let onSelect: (ReadDestination) -> Void

    @State private var pages: [PageLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?

    /// The home's initial screenful — the server default is 50
    /// (`ListPagesRequestSchema.limit`), more than a home screen needs.
    /// Paging is out of scope (spec).
    private static let listLimit = 20

    var body: some View {
        List {
            // The tree entry point lives INSIDE the list (not the toolbar,
            // which is owned by `WorkspaceHomeView` and already carries
            // switcher/search/recently-viewed/profile — task openQuestion).
            // It must stay reachable even when the recency fetch fails, so
            // the empty/error states below render inside their own section
            // rather than as a whole-view overlay covering this link.
            Section {
                NavigationLink {
                    PageTreeView(session: session, path: "/", onSelect: onSelect)
                } label: {
                    Label("Browse Pages", systemImage: "folder")
                }
            }
            Section("Recently Updated") {
                if pages.isEmpty {
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    } else {
                        Text(loadErrorMessage ?? "No pages here yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(pages, id: \.id) { page in
                        Button {
                            onSelect(.page(path: page.path))
                        } label: {
                            row(for: page)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        // The workspace's own name as the home title — the small brand/
        // context cue the switcher sheet otherwise keeps hidden.
        .navigationTitle(session.context.workspace.displayTitle)
        .task { await load() }
        .refreshable { await load() }
    }

    private func row(for page: PageLenient) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            PageRowTitleLabel(path: page.path)
            PageRowMetadataLabel(
                lastUpdatedAt: page.updatedAt,
                updaterName: page.lastUpdateUserName,
                updaterImage: page.lastUpdateUserImage,
                loader: session.imageCache
            )
        }
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
