import CrowiKit
import SwiftUI

/// The landing for a link that names a page by ID rather than by path —
/// which is what crowi's "copy link" hands out, so it is the shape most
/// links pasted between pages have.
///
/// Resolved with the ordinary by-id read (`GET /pages?page_id=`), NOT the
/// `POST /pages/link-access` the web's id landing uses. That endpoint also
/// admits a first-time visitor into a `GRANT_RESTRICTED` page's
/// `grantedUsers`, and the server confines that power to web sessions
/// (`authContext.kind === 'web'`) — this app signs in as an OAuth client,
/// so it is refused with a 403 no matter what scopes it holds. Reading a
/// page the user already has access to needs none of that.
///
/// What the app therefore cannot do is claim a share for the first time.
/// That is exactly what the browser is offered for when the read fails:
/// following the same link there runs the claim and, from then on, the page
/// opens here like any other.
///
/// The reader appears in THIS screen's place once the path is known, rather
/// than being pushed on top of it — the id is an address for the page, not a
/// step on the way to it, and back should return to whatever linked here
/// (the web replaces the history entry for the same reason).
struct SharedPageLinkView: View {
    let session: WorkspaceSession
    let pageId: String
    let onSelectDestination: (ReadDestination) -> Void

    @Environment(\.openURL) private var openURL
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
            VStack(alignment: .leading, spacing: CrowiMetrics.sectionHeaderTopPadding) {
                CrowiCard {
                    CrowiRow(showsChevron: false) {
                        Text(message)
                            .font(CrowiTypography.rowMeta)
                            .foregroundStyle(CrowiTheme.mutedForeground)
                    }
                }
                Button("Open in Safari") { openURL(browserURL) }
                    .font(CrowiTypography.sectionAction)
                    .foregroundStyle(CrowiTheme.primary)
                    .frame(maxWidth: .infinity, minHeight: CrowiMetrics.minimumTapTarget)
            }
            .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var browserURL: URL {
        session.context.workspace.workspaceOrigin.baseURL.appendingPathComponent(pageId)
    }

    private func resolve() async {
        do {
            let response = try await GetPageResponseLenient.fetch(pageId: pageId, using: session.apiClient)
            path = response.page.path
            failure = nil
        } catch PageLenientDecodeError.httpError(let status) where status == 404 {
            failure = "That page doesn't exist, or it hasn't been shared with you yet."
        } catch {
            failure = "Couldn't open that link."
        }
    }
}
