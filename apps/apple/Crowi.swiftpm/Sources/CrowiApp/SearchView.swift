import CrowiKit
import SwiftUI

/// RFC-0016 §5.2/§9 — full-text search, capability-gated on the refreshed
/// `AppInfoCache.capabilities` containing `search` (a host without an
/// active search driver returns `503`, so the app hides/degrades this UI
/// rather than let the user hit that). `WorkspaceHomeView` already hides the
/// toolbar entry point when the capability is absent; this view ALSO
/// degrades gracefully if reached anyway (a stale toolbar, a race right
/// after the capability flips), matching the CI-fixed "capability gate: UI
/// follows a live flip" invariant.
struct SearchView: View {
    let session: WorkspaceSession
    let onSelectDestination: (ReadDestination) -> Void

    @State private var query = ""
    @State private var hits: [CachedSearchHitPayload] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List(hits, id: \.pageId) { hit in
            Button {
                onSelectDestination(.page(path: hit.path))
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    // No metadata footer here: `CachedSearchHitPayload` carries
                    // no `updatedAt`/updater, so a hit row is title + parent +
                    // snippet (extending the payload is out of scope).
                    PageRowTitleLabel(path: hit.path)
                    if let rawSnippet = hit.rawSnippet, !rawSnippet.isEmpty {
                        Text(SearchHitLenient.plainSnippet(rawSnippet))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .searchable(text: $query, prompt: "Search pages")
        .onSubmit(of: .search) { Task { await runSearch() } }
        .overlay {
            if isLoading, hits.isEmpty {
                ProgressView()
            } else if let errorMessage, hits.isEmpty {
                ContentUnavailableView(errorMessage, systemImage: "magnifyingglass")
            }
        }
        .navigationTitle("Search")
    }

    private func runSearch() async {
        guard !query.isEmpty else {
            hits = []
            errorMessage = nil
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await SearchPagesResponseLenient.fetch(query: query, capabilities: session.capabilities, using: session.apiClient)
            hits = response.hits.map(CachedSearchHitPayload.init)
            errorMessage = nil
            CachedSearchResult.upsert(query: query, hits: response.hits, in: session.modelContext)
        } catch SearchLenientDecodeError.searchCapabilityUnavailable {
            hits = []
            errorMessage = "Search isn't available on this workspace."
        } catch {
            hits = CachedSearchResult.cached(query: query, in: session.modelContext) ?? []
            errorMessage = hits.isEmpty ? "Couldn't search right now." : nil
        }
    }
}
