import CrowiKit
import SwiftUI

/// RFC-0016 §8/§9 — revisions list + a read-only past-revision detail
/// view. Only the single-revision detail endpoint (`GET /pages/revisions/{id}`)
/// carries `body` (§8's detail-endpoint-only rule, mirrored the same way as
/// the page resource itself); the list endpoint is meta-only.
struct RevisionHistoryView: View {
    let session: WorkspaceSession
    let pageId: String
    let pagePath: String

    @State private var revisions: [RevisionMetaLenient] = []
    @State private var selectedRevisionBody: String?
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
        .sheet(isPresented: Binding(get: { selectedRevisionBody != nil }, set: { if !$0 { selectedRevisionBody = nil } })) {
            if let selectedRevisionBody {
                NavigationStack {
                    ScrollView {
                        // Past revisions are read-only display: wikilink/
                        // mention taps have nowhere useful to navigate from
                        // inside a modal, so they are inert here (`{ _ in }`)
                        // rather than dismissing the sheet unexpectedly.
                        WorkspacePageMarkdownView(
                            rawBody: selectedRevisionBody,
                            imageLoader: session.imageCache,
                            imageBaseURL: session.context.workspace.workspaceOrigin.baseURL,
                            onNavigateToWikiLink: { _ in },
                            onNavigateToMention: { _ in },
                            onNavigateToRelativePath: { _ in }
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
            selectedRevisionBody = response.revision.body ?? ""
        } catch {
            errorMessage = "Couldn't load this revision."
        }
    }
}
