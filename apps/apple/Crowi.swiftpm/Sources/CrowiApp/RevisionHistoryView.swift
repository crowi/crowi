import CrowiKit
import SwiftUI

/// RFC-0016 §8/§9 — revisions list + a read-only past-revision detail
/// view. Only the single-revision detail endpoint (`GET /pages/revisions/{id}`)
/// carries `body` (§8's detail-endpoint-only rule, mirrored the same way as
/// the page resource itself); the list endpoint is meta-only.
///
/// RFC-0023 Phase 5 — history renders through the SAME `PageBodyView`
/// branch as the reader (design §16's deliberate Phase 4 deferral,
/// resolved here): the revision detail GET declares `X-Crowi-Ast-Version`
/// and a returned v1 envelope takes the typed-AST path; anything else
/// (old server, never-rendered revision, decode-limit failure) keeps the
/// raw-body MarkdownUI fallback. Nothing new is persisted — the outcome
/// lives only in this view's state (the AST stays online-only, §16).
///
/// ## The design language, arriving last
///
/// This was the final screen still on a stock `List` printing a bold name
/// over a RAW ISO timestamp. It now carries the design's history screen:
/// day-grouped cards (the same `CrowiDayGroup` runs the notifications list
/// uses), an avatar, relative time, and the two status chips.
///
/// The design's version chip (`v15`), change summary, `+142 / -38` diff stat,
/// range label, multi-select comparison, diff view and restore are all
/// ABSENT, on purpose: `RevisionMetaSchema` carries the two users, `editVia`
/// and `createdAt` and nothing else, and the app has no diff or restore
/// surface. See `CrowiRevisionRow` for the full ruling.
struct RevisionHistoryView: View {
    let session: WorkspaceSession
    let pageId: String
    let pagePath: String

    /// The loaded past-revision content: the raw body (always present —
    /// it IS the fallback) plus the decoded `renderedAst` outcome.
    struct SelectedRevision: Identifiable {
        let id: String
        let body: String
        let renderedAst: RenderedAstDecodeOutcome?
    }

    @State private var revisions: [RevisionMetaLenient] = []
    @State private var selectedRevision: SelectedRevision?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                subtitle
                if revisions.isEmpty {
                    emptyCard
                } else {
                    // The server sorts `createdAt: -1`, so the runs come out
                    // newest-first and the first row of the first run is the
                    // page's current revision.
                    ForEach(CrowiDayGroup.runs(of: revisions, by: { PageRowMetadataLabel.date(fromISO8601: $0.createdAt) })) { run in
                        CrowiSectionHeader(run.group.title)
                        CrowiCardRows(run.items, id: \.revisionId) { revision in
                            Button {
                                Task { await loadRevisionBody(revision.revisionId) }
                            } label: {
                                CrowiRevisionRow(
                                    name: revision.displayName ?? "Unknown",
                                    imageURLString: revision.authorImage,
                                    relativeTime: PageRowMetadataLabel.relativeTimeText(from: revision.createdAt),
                                    isCurrent: revision.revisionId == revisions.first?.revisionId,
                                    isAPIEdit: revision.isAPIEdit,
                                    loader: session.imageCache
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        // A PUSHED screen keeps the navigation bar's own title — iOS's large
        // title IS the platform's implementation of the design's 28pt
        // heading, and it collapses on scroll the way the design's does.
        // Only the count line below it has to be rendered in content.
        .navigationTitle("Version history")
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $selectedRevision) { revision in
            NavigationStack {
                ScrollView {
                    // Past revisions are read-only display: wikilink/
                    // mention taps have nowhere useful to navigate from
                    // inside a modal, so they are inert here (`{ _ in }`)
                    // rather than dismissing the sheet unexpectedly.
                    PageBodyView(
                        session: session,
                        renderedAst: revision.renderedAst,
                        rawBody: revision.body,
                        onSelectDestination: { _ in }
                    )
                    .padding()
                }
                .navigationTitle(pagePath)
                #if canImport(UIKit)
                .navigationBarTitleDisplayMode(.inline)
                #endif
            }
        }
    }

    /// The design's "15 revisions · <page>" line. The count is what the
    /// screen actually loaded, not a server total — there is no total on the
    /// wire, and `50` would be a lie the moment a page has more.
    @ViewBuilder
    private var subtitle: some View {
        if !revisions.isEmpty {
            Text("\(revisions.count) revisions · \(PageRowTitleLabel(path: pagePath).titleText)")
                .font(CrowiTypography.screenSubtitle)
                .foregroundStyle(CrowiTheme.mutedForeground)
                .lineLimit(2)
                .padding(.horizontal, CrowiMetrics.screenHorizontalMargin)
                .padding(.bottom, CrowiMetrics.sectionHeaderBottomPadding)
        }
    }

    private var emptyCard: some View {
        CrowiCard {
            CrowiRow(showsChevron: false) {
                Text(errorMessage ?? "No revisions yet")
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
            }
        }
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
    }

    private func load() async {
        do {
            let response = try await ListRevisionsResponseLenient.fetch(pageId: pageId, using: session.apiClient)
            revisions = response.revisions
            errorMessage = nil
            CachedRevisionSummary.upsert(pageId: pageId, revisions: response.revisions, in: session.modelContext)
        } catch {
            revisions = CachedRevisionSummary.cached(pageId: pageId, in: session.modelContext) ?? []
            errorMessage = revisions.isEmpty ? "Couldn't load revision history." : nil
        }
    }

    private func loadRevisionBody(_ revisionId: String) async {
        do {
            let response = try await GetRevisionResponseLenient.fetch(revisionId: revisionId, using: session.apiClient)
            selectedRevision = SelectedRevision(
                id: revisionId,
                body: response.revision.body ?? "",
                renderedAst: response.revision.renderedAst
            )
        } catch {
            errorMessage = "Couldn't load this revision."
        }
    }
}
