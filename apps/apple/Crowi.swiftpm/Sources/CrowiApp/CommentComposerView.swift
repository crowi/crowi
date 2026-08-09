import CrowiKit
import SwiftUI

/// RFC-0016 §8 / `feature-ios-phase2-write` — the plain-body comment input
/// at the bottom of `PageReaderView`'s comments section. Posts through
/// `EngagementActions.postComment` (`{ page_id, revision_id, comment }` —
/// never an anchor field, RFC-0018 is web-only) and, on success, hands
/// refresh back to the reader's existing `fetchAndCacheComments` path
/// rather than splicing the returned comment in locally.
///
/// The row itself is `CrowiCommentComposer` (the design's avatar + `--muted`
/// pill); this view owns only the posting, its in-flight flag and its error.
struct CommentComposerView: View {
    let session: WorkspaceSession
    let pageId: String
    let revisionId: String
    /// The signed-in user's avatar/name for the composer's leading disc.
    let authorImageURLString: String?
    let authorName: String?
    let authorUsername: String?
    /// The reader's own comments refresh (`fetchAndCacheComments`).
    let onPosted: () async -> Void

    @State private var text = ""
    @State private var isPosting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            CrowiCommentComposer(
                text: $text,
                authorImageURLString: authorImageURLString,
                authorName: authorName,
                authorUsername: authorUsername,
                isPosting: isPosting,
                loader: session.imageCache,
                onSend: { Task { await post() } }
            )
            if let errorMessage {
                // §7.4 fail-fast: the text stays in the field, retry is the
                // same send button.
                Text(errorMessage)
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.destructive)
            }
        }
    }

    private func post() async {
        // The button is disabled in the same state, but a send can also be
        // reached by a stale tap landing after the text was cleared — the
        // gate is the model's, not the view's.
        guard CrowiCommentComposer.canSend(text: text, isPosting: isPosting) else { return }
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
