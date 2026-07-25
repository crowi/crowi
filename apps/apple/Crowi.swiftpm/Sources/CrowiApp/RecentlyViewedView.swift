import CrowiKit
import SwiftUI

/// RFC-0016 §2.1/§9 — `GET /me/recently-viewed-pages`.
struct RecentlyViewedView: View {
    let session: WorkspaceSession
    let onSelectDestination: (ReadDestination) -> Void

    @State private var pages: [PageLenient] = []
    @State private var errorMessage: String?

    var body: some View {
        List(pages, id: \.id) { page in
            Button {
                onSelectDestination(.page(path: page.path))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    // `GET /me/recently-viewed-pages` does not populate
                    // `lastUpdateUser`, so the metadata footer's fallback
                    // ladder shows the relative time only (which is what this
                    // row printed as a raw ISO string before), with no
                    // placeholder avatar.
                    PageRowTitleLabel(path: page.path)
                    PageRowMetadataLabel(
                        lastUpdatedAt: page.updatedAt,
                        updaterName: page.lastUpdateUserName,
                        updaterImage: page.lastUpdateUserImage,
                        loader: session.imageCache
                    )
                }
            }
            .buttonStyle(.plain)
        }
        .overlay {
            if pages.isEmpty, let errorMessage {
                ContentUnavailableView(errorMessage, systemImage: "clock")
            } else if pages.isEmpty {
                ContentUnavailableView("No recently viewed pages yet", systemImage: "clock")
            }
        }
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
