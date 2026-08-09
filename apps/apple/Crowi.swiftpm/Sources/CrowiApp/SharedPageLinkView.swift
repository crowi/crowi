import CrowiKit
import SwiftUI

/// The landing for a link that names a page by ID rather than by path —
/// which is what crowi's "copy link" hands out, so it is the shape most
/// links pasted between pages have.
///
/// Resolved through `POST /pages/link-access`, the same endpoint the web's
/// id landing uses: on a link-shared restricted page that call is what
/// admits the visitor, so a link opened here behaves as it would in a
/// browser rather than reporting a page that is merely not shared with the
/// reader YET.
///
/// The reader appears in THIS screen's place once the path is known, rather
/// than being pushed on top of it — the id is an address for the page, not a
/// step on the way to it, and back should return to whatever linked here
/// (the web replaces the history entry for the same reason).
struct SharedPageLinkView: View {
    let session: WorkspaceSession
    let pageId: String
    let onSelectDestination: (ReadDestination) -> Void

    @State private var path: String?
    @State private var failure: String?

    var body: some View {
        Group {
            if let path {
                PageReaderView(session: session, path: path, onSelectDestination: onSelectDestination)
            } else if let failure {
                notice(failure)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(CrowiTheme.background)
            }
        }
        .task(id: pageId) { await resolve() }
    }

    private func notice(_ message: String) -> some View {
        ScrollView {
            CrowiCard {
                CrowiRow(showsChevron: false) {
                    Text(message)
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                }
            }
            .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func resolve() async {
        do {
            let response = try await GetPageResponseLenient.resolveSharedLink(pageId: pageId, using: session.apiClient)
            path = response.page.path
            failure = nil
        } catch PageLenientDecodeError.httpError(let status) where status == 403 {
            failure = "You don't have access to this page."
        } catch PageLenientDecodeError.httpError(let status) where status == 404 {
            failure = "That page no longer exists."
        } catch {
            failure = "Couldn't open that link."
        }
    }
}
