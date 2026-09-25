import CrowiKit
import SwiftUI

/// A profile's page list — the pages a user bookmarked or created — in the
/// same card rows as every other flat page list.
struct UserPageListView: View {
    let session: WorkspaceSession
    let username: String
    let kind: UserPageListKind
    let onSelectDestination: (ReadDestination) -> Void

    private static let pageSize = 30

    @State private var pages: [PageLenient] = []
    @State private var nextOffset: Int?
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if pages.isEmpty {
                    emptyState
                        .frame(maxWidth: .infinity, minHeight: 280)
                } else {
                    CrowiCardRows(pages, id: \.id) { page in
                        Button {
                            onSelectDestination(.page(path: page.path))
                        } label: {
                            CrowiPageRow(
                                path: page.path,
                                lastUpdatedAt: page.updatedAt,
                                updaterName: page.lastUpdateUserName,
                                updaterImage: page.lastUpdateUserImage,
                                updaterUsername: page.lastUpdateUserUsername,
                                likeCount: page.displayLikeCount,
                                commentCount: page.displayCommentCount,
                                isArtifact: page.displayedContentType == .artifact,
                                loader: session.imageCache
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
                    if nextOffset != nil {
                        loadMoreRow
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: username) { await load() }
        .refreshable { await load() }
    }

    private var title: String {
        switch kind {
        case .bookmarks: "Bookmarks"
        case .created: "Pages"
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if isLoading {
            ProgressView()
        } else if let errorMessage {
            ContentUnavailableView(errorMessage, systemImage: "exclamationmark.triangle")
        } else {
            switch kind {
            case .bookmarks:
                ContentUnavailableView("No bookmarks yet", systemImage: "bookmark")
            case .created:
                ContentUnavailableView("No pages created yet", systemImage: "doc.text")
            }
        }
    }

    private var loadMoreRow: some View {
        Button {
            Task { await loadMore() }
        } label: {
            Group {
                if isLoadingMore {
                    ProgressView()
                } else {
                    Text("Load more")
                        .font(CrowiTypography.sectionAction)
                        .foregroundStyle(CrowiTheme.primary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: CrowiMetrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .disabled(isLoadingMore)
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await UserPageListResponseLenient.fetch(
                username: username, kind: kind, limit: Self.pageSize, offset: 0, using: session.apiClient
            )
            pages = response.pages
            nextOffset = response.nextOffset
            errorMessage = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                return
            }
            errorMessage = NetworkFailureMessage.message(for: error) ?? "Couldn't load this list."
        }
    }

    private func loadMore() async {
        guard let offset = nextOffset else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        guard let response = try? await UserPageListResponseLenient.fetch(
            username: username, kind: kind, limit: Self.pageSize, offset: offset, using: session.apiClient
        ) else { return }
        let known = Set(pages.map(\.id))
        pages += response.pages.filter { !known.contains($0.id) }
        nextOffset = response.nextOffset
    }
}
