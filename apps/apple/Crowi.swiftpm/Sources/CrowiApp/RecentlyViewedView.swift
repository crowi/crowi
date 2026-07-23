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
                    Text(page.path).font(.headline)
                    if let updatedAt = page.updatedAt {
                        Text(updatedAt).font(.caption).foregroundStyle(.secondary)
                    }
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
