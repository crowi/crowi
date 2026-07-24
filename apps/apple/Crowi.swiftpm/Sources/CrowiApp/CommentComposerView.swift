import CrowiKit
import SwiftUI

/// RFC-0016 §8 / `feature-ios-phase2-write` — the plain-body comment input
/// at the bottom of `PageReaderView`'s comments section. Posts through
/// `EngagementActions.postComment` (`{ page_id, revision_id, comment }` —
/// never an anchor field, RFC-0018 is web-only) and, on success, hands
/// refresh back to the reader's existing `fetchAndCacheComments` path
/// rather than splicing the returned comment in locally.
struct CommentComposerView: View {
    let session: WorkspaceSession
    let pageId: String
    let revisionId: String
    /// The reader's own comments refresh (`fetchAndCacheComments`).
    let onPosted: () async -> Void

    @State private var text = ""
    @State private var isPosting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Add a comment", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await post() }
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .buttonStyle(.borderless)
                .disabled(isPosting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let errorMessage {
                // §7.4 fail-fast: the text stays in the field, retry is the
                // same send button.
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func post() async {
        isPosting = true
        defer { isPosting = false }
        do {
            try await EngagementActions(client: session.apiClient).postComment(pageId: pageId, revisionId: revisionId, comment: text)
            text = ""
            errorMessage = nil
            await onPosted()
        } catch {
            errorMessage = "Couldn't post your comment. It's still here — try again."
        }
    }
}
