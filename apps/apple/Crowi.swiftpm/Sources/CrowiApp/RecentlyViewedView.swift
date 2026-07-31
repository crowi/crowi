import CrowiKit
import SwiftUI

/// RFC-0016 §2.1/§9 — `GET /me/recently-viewed-pages`.
///
/// feature-ios-visual-redesign Phase 1: the same `CrowiCardRows` +
/// `CrowiPageRow` vocabulary the recency home uses, so the two "list of
/// pages" screens stop looking like different apps. The empty/error state
/// lives INSIDE the scroll content rather than in an `.overlay` so
/// pull-to-refresh still works while the list is empty — which is exactly
/// when a user reaches for it.
struct RecentlyViewedView: View {
    let session: WorkspaceSession
    let onSelectDestination: (ReadDestination) -> Void

    @State private var pages: [PageLenient] = []
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if pages.isEmpty {
                    ContentUnavailableView(
                        errorMessage ?? "No recently viewed pages yet",
                        systemImage: "clock"
                    )
                    .frame(maxWidth: .infinity, minHeight: 280)
                } else {
                    CrowiCardRows(pages, id: \.id) { page in
                        Button {
                            onSelectDestination(.page(path: page.path))
                        } label: {
                            // `GET /me/recently-viewed-pages` does not
                            // populate `lastUpdateUser`, so the row shows no
                            // leading avatar and the metadata line degrades
                            // to the relative time only (which is what this
                            // row printed as a raw ISO string before).
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
                    .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle("Recently Viewed")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let response = try await RecentlyViewedPagesResponseLenient.fetch(using: session.apiClient)
            pages = response.pages
            errorMessage = nil
        } catch {
            errorMessage = pages.isEmpty ? "Couldn't load recently viewed pages." : nil
        }
    }
}
