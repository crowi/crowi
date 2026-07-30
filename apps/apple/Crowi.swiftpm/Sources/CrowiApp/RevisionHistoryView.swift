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
        List(revisions) { revision in
            Button {
                Task { await loadRevisionBody(revision.revisionId) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(revision.authorName ?? revision.authorUsername ?? "Unknown").font(.subheadline.bold())
                    if let createdAt = revision.createdAt {
                        Text(createdAt).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .overlay {
            if revisions.isEmpty, let errorMessage {
                ContentUnavailableView(errorMessage, systemImage: "clock.arrow.circlepath")
            }
        }
        .navigationTitle("History")
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
