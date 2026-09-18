import CrowiKit
import SwiftUI

/// RFC-0016 §8/§9 / RFC-0021 — the merged page-history timeline (content
/// revisions interleaved with rename/trash/restore/visibility/creation
/// events, `GET /pages/{pageId}/history`) plus two ways to look at a past
/// state: tapping a single revision opens its read-only rendered body (as
/// before), and a "Compare" mode lets picking two revisions open a diff.
///
/// RFC-0023 Phase 5 — single-revision detail still renders through the SAME
/// `PageBodyView` branch as the reader: the revision detail GET declares
/// `X-Crowi-Ast-Version` and a returned v1 envelope takes the typed-AST
/// path; anything else keeps the raw-body MarkdownUI fallback. The diff
/// view is a separate, source-only comparison (matches the web's own
/// `RevisionDiff.tsx`, which diffs raw `body` rather than the AST) — there
/// is no typed-AST diffing anywhere in this app.
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
        let contentType: PageContentType
    }

    @State private var entries: [PageHistoryEntryLenient] = []
    @State private var nextCursor: String?
    @State private var isLoadingMore = false
    @State private var selectedRevision: SelectedRevision?
    @State private var errorMessage: String?

    @State private var isCompareMode = false
    @State private var selectedForCompare: [PageHistoryContentRowLenient] = []
    @State private var comparePresented = false
    @State private var comparePair: (from: PageHistoryContentRowLenient, to: PageHistoryContentRowLenient)?
    @State private var diffRows: [RevisionLineDiffRow] = []
    @State private var isDiffLoading = false
    @State private var diffError: String?
    @State private var diffRequestToken = 0

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                subtitle
                if entries.isEmpty {
                    emptyCard
                } else {
                    // The server orders newest-first, so the runs come out
                    // newest-first too and the first `content_revision` row
                    // encountered is the page's current revision.
                    ForEach(CrowiDayGroup.runs(of: entries, by: { PageRowMetadataLabel.date(fromISO8601: $0.occurredAt) })) { run in
                        CrowiSectionHeader(run.group.title)
                        CrowiCardRows(run.items) { entry in
                            row(for: entry)
                        }
                    }
                    if nextCursor != nil {
                        loadMoreRow
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle("Version history")
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(isCompareMode ? "Cancel" : "Compare") {
                    isCompareMode.toggle()
                    selectedForCompare = []
                }
            }
        }
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
                        contentType: revision.contentType,
                        pageId: pageId,
                        revisionId: revision.id,
                        renderedAst: revision.renderedAst,
                        rawBody: revision.body,
                        sourcePath: pagePath,
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
        // `isPresented` + externally-held pair state (not `item:`): picking a
        // new pair while the sheet is already open updates `comparePair`
        // in place rather than dismissing and re-presenting.
        .sheet(isPresented: $comparePresented, onDismiss: {
            isCompareMode = false
            selectedForCompare = []
            comparePair = nil
        }) {
            if let comparePair {
                CrowiRevisionDiffSheet(
                    fromLabel: String(comparePair.from.revisionId.suffix(8)),
                    toLabel: String(comparePair.to.revisionId.suffix(8)),
                    rows: diffRows,
                    isLoading: isDiffLoading,
                    errorMessage: diffError,
                    onRetry: {
                        Task { await loadDiff(from: comparePair.from, to: comparePair.to) }
                    }
                )
            }
        }
    }

    /// The design's "15 revisions · <page>" line, now counting every
    /// timeline row (revisions and events alike) since that is what the
    /// screen actually loaded — there is no total on the wire, and `50`
    /// would be a lie the moment a page has more.
    @ViewBuilder
    private var subtitle: some View {
        if !entries.isEmpty {
            Text("\(entries.count) updates · \(PageRowTitleLabel(path: pagePath).titleText)")
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
                Text(errorMessage ?? "No history yet")
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
            }
        }
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
    }

    private var loadMoreRow: some View {
        CrowiCard {
            Button {
                Task { await loadMore() }
            } label: {
                CrowiRow(showsChevron: false) {
                    if isLoadingMore {
                        ProgressView()
                    } else {
                        Text("Load more")
                            .font(CrowiTypography.sheetRow)
                            .foregroundStyle(CrowiTheme.primary)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(isLoadingMore)
        }
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
    }

    /// The newest `content_revision` row in the (newest-first) timeline —
    /// NOT `entries.first`, which may well be an event (a rename, a
    /// visibility change) that carries no revision at all.
    private var currentRevisionId: String? {
        for entry in entries {
            if case .contentRevision(let row) = entry { return row.revisionId }
        }
        return nil
    }

    @ViewBuilder
    private func row(for entry: PageHistoryEntryLenient) -> some View {
        switch entry {
        case .contentRevision(let revision):
            contentRow(revision)
        case .event(let event):
            CrowiHistoryEventRow(
                actorDisplayName: event.displayName ?? "Unknown",
                username: event.actorUsername,
                imageURLString: event.actorImage,
                relativeTime: PageRowMetadataLabel.relativeTimeText(from: event.occurredAt),
                message: PageHistoryEventMessage.message(for: event.kind),
                detail: PageHistoryEventMessage.detail(for: event),
                isSubtree: event.subtree,
                loader: session.imageCache
            )
        }
    }

    private func contentRow(_ revision: PageHistoryContentRowLenient) -> some View {
        let isSelected = selectedForCompare.contains { $0.revisionId == revision.revisionId }
        return Button {
            guard !revision.pending else { return }
            if isCompareMode {
                toggleCompareSelection(revision)
            } else {
                Task { await loadRevisionBody(revision.revisionId) }
            }
        } label: {
            CrowiRevisionRow(
                name: revision.displayName ?? "Unknown",
                username: revision.actorUsername,
                imageURLString: revision.actorImage,
                relativeTime: PageRowMetadataLabel.relativeTimeText(from: revision.occurredAt),
                isCurrent: revision.revisionId == currentRevisionId,
                isAPIEdit: revision.isAPIEdit,
                loader: session.imageCache
            )
            .background(isSelected ? CrowiTheme.accent.opacity(0.5) : Color.clear)
            .opacity(revision.pending ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .disabled(revision.pending)
    }

    private func toggleCompareSelection(_ revision: PageHistoryContentRowLenient) {
        if let index = selectedForCompare.firstIndex(where: { $0.revisionId == revision.revisionId }) {
            selectedForCompare.remove(at: index)
            return
        }
        selectedForCompare.append(revision)
        if selectedForCompare.count > 2 {
            selectedForCompare.removeFirst(selectedForCompare.count - 2)
        }
        if selectedForCompare.count == 2 {
            presentCompare(selectedForCompare[0], selectedForCompare[1])
        }
    }

    /// Normalizes tap order into (older = from, newer = to) using each
    /// revision's position in the newest-first timeline — whichever was
    /// tapped second is not necessarily the newer one.
    private func presentCompare(_ a: PageHistoryContentRowLenient, _ b: PageHistoryContentRowLenient) {
        func index(of revisionId: String) -> Int {
            entries.firstIndex {
                if case .contentRevision(let row) = $0 { return row.revisionId == revisionId }
                return false
            } ?? 0
        }
        let (fromRevision, toRevision) = index(of: a.revisionId) > index(of: b.revisionId) ? (a, b) : (b, a)
        comparePair = (from: fromRevision, to: toRevision)
        comparePresented = true
        Task { await loadDiff(from: fromRevision, to: toRevision) }
    }

    private func load() async {
        do {
            let response = try await PageHistoryResponseLenient.fetch(pageId: pageId, using: session.apiClient)
            entries = response.entries
            nextCursor = response.nextCursor
            errorMessage = nil
            CachedRevisionSummary.upsert(pageId: pageId, entries: response.entries, in: session.modelContext)
        } catch {
            entries = CachedRevisionSummary.cached(pageId: pageId, in: session.modelContext) ?? []
            nextCursor = nil
            errorMessage = entries.isEmpty ? "Couldn't load page history." : nil
        }
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let response = try await PageHistoryResponseLenient.fetch(pageId: pageId, cursor: cursor, using: session.apiClient)
            entries.append(contentsOf: response.entries)
            nextCursor = response.nextCursor
            CachedRevisionSummary.upsert(pageId: pageId, entries: entries, in: session.modelContext)
        } catch {
            // Best-effort: the list already loaded stays as-is, the "Load
            // more" row simply remains tappable to retry.
        }
    }

    private func loadRevisionBody(_ revisionId: String) async {
        do {
            let response = try await GetRevisionResponseLenient.fetch(revisionId: revisionId, using: session.apiClient)
            selectedRevision = SelectedRevision(
                id: revisionId,
                body: response.revision.body ?? "",
                renderedAst: response.revision.renderedAst,
                contentType: response.revision.contentType ?? .markdown
            )
        } catch {
            errorMessage = "Couldn't load this revision."
        }
    }

    private func loadDiff(from: PageHistoryContentRowLenient, to: PageHistoryContentRowLenient) async {
        diffRequestToken += 1
        let token = diffRequestToken
        isDiffLoading = true
        diffError = nil
        defer { if token == diffRequestToken { isDiffLoading = false } }
        do {
            let response = try await GetRevisionsResponseLenient.fetch(ids: [from.revisionId, to.revisionId], using: session.apiClient)
            guard token == diffRequestToken else { return }
            guard let fromBody = response.revisions.first(where: { $0.revisionId == from.revisionId })?.body,
                  let toBody = response.revisions.first(where: { $0.revisionId == to.revisionId })?.body
            else {
                diffError = "Couldn't load these revisions."
                diffRows = []
                return
            }
            diffRows = RevisionLineDiff.compute(from: fromBody, to: toBody)
        } catch {
            guard token == diffRequestToken else { return }
            diffError = "Couldn't load the diff."
            diffRows = []
        }
    }
}
