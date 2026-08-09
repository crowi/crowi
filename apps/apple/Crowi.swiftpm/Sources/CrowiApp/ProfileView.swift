import CrowiKit
import SwiftUI

/// RFC-0016 §6/§9/§15 — the own profile (`GET /me`) and public profile
/// (`GET /user/{username}`) screens. A tapped `@mention` navigates here
/// UNCONDITIONALLY (§6/§15 — username existence is validated only
/// server-side at save time, which the app never reads); an unknown
/// username surfaces its own not-found state from THIS endpoint's `404`,
/// never a client-side pre-check.
///
/// ## The design language, arriving late
///
/// Like Notifications, this screen was outside the Phase 1 restyle and kept
/// the stock `List`. It now carries the design's profile header (a 64pt
/// initials-capable avatar beside name and handle) and its stat strip.
///
/// The strip's three numbers are all the target USER's own actions — pages
/// they created, pages they liked, comments they wrote — which is what the
/// server means by them (`feature-profile-stats-and-page-total`), not
/// activity their pages received from others. A count the server did not
/// send is dropped from the strip rather than printed as a zero, so an older
/// server degrades to two stats (or none) instead of lying about one.
///
/// The own-profile tab therefore issues TWO requests: `GET /me` has no
/// counts on it at all, and `/user/{username}` — the only endpoint that
/// reports them — is keyed by a username `/me` is what tells us. The second
/// is best-effort: a failure there leaves the header intact and the strip
/// absent, never an error screen for a profile that loaded.
///
/// The design's "Drafts" row is not built — the app has no drafts concept.
struct ProfileView: View {
    let session: WorkspaceSession
    /// `nil` = the signed-in user's own profile.
    let username: String?

    @State private var displayName: String?
    @State private var displayUsername: String?
    @State private var displayImage: String?
    @State private var introduction: String?
    @State private var createdPagesCount: Int?
    @State private var bookmarksCount: Int?
    @State private var likesCount: Int?
    @State private var commentsCount: Int?
    @State private var notFound = false

    /// Whether this screen is a tab ROOT (own profile) rather than a pushed
    /// destination. A root owns its title area the way Home does; a pushed
    /// screen keeps the navigation bar's own title, which is the platform's
    /// implementation of the same element.
    private var isRoot: Bool { username == nil }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if isRoot {
                    CrowiScreenTitle("Profile")
                }
                if notFound {
                    CrowiCard {
                        CrowiRow(showsChevron: false) {
                            Text("User not found")
                                .font(CrowiTypography.rowMeta)
                                .foregroundStyle(CrowiTheme.mutedForeground)
                        }
                    }
                } else {
                    header
                    CrowiStatStrip(stats)
                    if let bookmarksCount {
                        CrowiCard {
                            CrowiRow(showsChevron: false) {
                                CrowiRowChip(systemImage: "bookmark")
                            } content: {
                                HStack {
                                    Text("Bookmarks")
                                        .font(CrowiTypography.rowTitle)
                                        .foregroundStyle(CrowiTheme.foreground)
                                    Spacer(minLength: 8)
                                    Text(bookmarksCount, format: .number)
                                        .font(CrowiTypography.rowMeta)
                                        .foregroundStyle(CrowiTheme.mutedForeground)
                                }
                            }
                        }
                        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        .navigationTitle(isRoot ? "" : "@\(username ?? "")")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: username) { await load() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: CrowiMetrics.profileHeaderSpacing) {
            WorkspaceAvatarView(
                imageURLString: displayImage,
                loader: session.imageCache,
                size: CrowiMetrics.profileAvatarSize,
                seed: displayUsername ?? displayName
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName ?? displayUsername ?? "")
                    .font(CrowiTypography.profileName)
                    .foregroundStyle(CrowiTheme.foreground)
                if let displayUsername {
                    Text("@\(displayUsername)")
                        .font(CrowiTypography.screenSubtitle)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                }
                if let introduction, !introduction.isEmpty {
                    Text(introduction)
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, CrowiMetrics.screenHorizontalMargin)
        .padding(.top, CrowiMetrics.screenTitleTopPadding)
        .padding(.bottom, CrowiMetrics.sectionHeaderTopPadding)
    }

    /// Only the counts the server actually reported — see the type's doc
    /// comment for why a missing one is dropped rather than zeroed.
    private var stats: [CrowiStat] {
        [
            createdPagesCount.map { CrowiStat(value: $0, label: "Pages") },
            likesCount.map { CrowiStat(value: $0, label: "Likes") },
            commentsCount.map { CrowiStat(value: $0, label: "Comments") },
        ]
        .compactMap { $0 }
    }

    private func load() async {
        do {
            if let username {
                apply(try await UserPageResponseLenient.fetch(username: username, using: session.apiClient))
            } else {
                let profile = try await ProfileLenient.fetchMe(using: session.apiClient)
                displayUsername = profile.username
                displayName = profile.name
                displayImage = profile.image
                introduction = profile.introduction
                // Best-effort second hop for the counts `/me` does not carry.
                // `try?`: the profile itself already loaded, and losing the
                // strip is not worth losing the screen.
                if let ownUsername = profile.username,
                   let stats = try? await UserPageResponseLenient.fetch(username: ownUsername, using: session.apiClient)
                {
                    createdPagesCount = stats.createdPagesCount
                    bookmarksCount = stats.bookmarksCount
                    likesCount = stats.likesCount
                    commentsCount = stats.commentsCount
                }
            }
            notFound = false
        } catch ProfileLenientDecodeError.httpError(let status) where status == 404 {
            notFound = true
        } catch {
            // Best-effort read: leave whatever the previous state was
            // rather than showing a hard error for a profile screen.
        }
    }

    private func apply(_ response: UserPageResponseLenient) {
        displayUsername = response.username
        displayName = response.name
        displayImage = response.image
        introduction = response.introduction
        createdPagesCount = response.createdPagesCount
        bookmarksCount = response.bookmarksCount
        likesCount = response.likesCount
        commentsCount = response.commentsCount
    }
}
