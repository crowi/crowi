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
///
/// ## feature-ios-visual-redesign Phase 1
///
/// The field is `CrowiSearchField` in the scrolling content — the design's
/// `var(--muted)` pill under the title — replacing `.searchable(text:)`,
/// whose system search bar cannot take that fill/radius/placement and cannot
/// coexist with a second field without showing the user two of them.
///
/// Hits DO carry highlight positions, so the design's `<mark>` treatment is
/// real here rather than restyled away: the Elasticsearch driver wraps
/// matched terms in `<mark>` (`query-builder.ts`'s `pre_tags`/`post_tags`)
/// and the handler passes the fragment through, which
/// `CrowiSearchSnippetText` segments into highlighted runs — never parsing
/// the untrusted string as markup.
///
/// The design's "Recent" search-history card is NOT built: nothing stores
/// past queries, on the server or on the device.
struct SearchView: View {
    let session: WorkspaceSession
    let onSelectDestination: (ReadDestination) -> Void

    @State private var query = ""
    @State private var hits: [CachedSearchHitPayload] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    /// The query the results on screen actually belong to — `nil` until the
    /// first search of this visit completes. Distinguishes "you have not
    /// searched yet" from "that search matched nothing", which an empty
    /// `hits` alone cannot: typing (without submitting) would otherwise claim
    /// no page matched a query that was never sent.
    @State private var lastSearchedQuery: String?

    private var resultLabel: String {
        hits.count == 1 ? "1 result" : "\(hits.count) results"
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                CrowiSearchField(text: $query, prompt: "Search pages") {
                    Task { await runSearch() }
                }
                .padding(.top, 8)

                if !hits.isEmpty {
                    CrowiSectionHeader(resultLabel)
                    CrowiCardRows(hits, id: \.pageId) { hit in
                        Button {
                            onSelectDestination(.page(path: hit.path))
                        } label: {
                            // The design's search row has no chevron: its
                            // three stacked lines (title / path / snippet)
                            // already fill the row, and a trailing glyph
                            // beside a wrapping snippet reads as clutter.
                            CrowiRow(showsChevron: false) {
                                VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                                    // No metadata footer here:
                                    // `CachedSearchHitPayload` carries no
                                    // `updatedAt`/updater, so a hit row is
                                    // title + parent + snippet (extending
                                    // the payload is out of scope).
                                    PageRowTitleLabel(path: hit.path)
                                    if let rawSnippet = hit.rawSnippet, !rawSnippet.isEmpty {
                                        CrowiSearchSnippetText(rawSnippet: rawSnippet, lineLimit: 3)
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    // Inside the scroll content, NOT an `.overlay` — the
                    // field now lives in this view rather than in the
                    // navigation bar, and a full-screen overlay would sit on
                    // top of it and swallow every tap.
                    statusView
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        // Emptying the field (the clear button, or backspacing it away) also
        // drops the results it produced — the design's `hasQuery` gate.
        // Leaving them under an empty field would attribute someone else's
        // hits to whatever gets typed next.
        .onChange(of: query) { _, newValue in
            guard !CrowiSearchField.hasEffectiveQuery(newValue) else { return }
            hits = []
            errorMessage = nil
            lastSearchedQuery = nil
        }
        .navigationTitle("Search")
    }

    @ViewBuilder
    private var statusView: some View {
        Group {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                ContentUnavailableView(errorMessage, systemImage: "magnifyingglass")
            } else if lastSearchedQuery != nil {
                ContentUnavailableView("No pages matched", systemImage: "magnifyingglass")
            } else {
                ContentUnavailableView("Search this workspace", systemImage: "magnifyingglass")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 240)
    }

    private func runSearch() async {
        // `hasEffectiveQuery`, not `!query.isEmpty`: a field holding only
        // spaces is not a query, and firing the request anyway can only spend
        // a round trip to be told so.
        guard CrowiSearchField.hasEffectiveQuery(query) else {
            hits = []
            errorMessage = nil
            lastSearchedQuery = nil
            return
        }
        isLoading = true
        defer {
            isLoading = false
            lastSearchedQuery = query
        }
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
