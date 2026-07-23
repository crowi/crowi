import CrowiKit
import SwiftUI

/// RFC-0016 §6/§9/§15 — the own profile (`GET /me`) and public profile
/// (`GET /user/{username}`) screens. A tapped `@mention` navigates here
/// UNCONDITIONALLY (§6/§15 — username existence is validated only
/// server-side at save time, which the app never reads); an unknown
/// username surfaces its own not-found state from THIS endpoint's `404`,
/// never a client-side pre-check.
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
    @State private var notFound = false

    var body: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    WorkspaceAvatarView(imageURLString: displayImage, loader: session.imageCache, size: 56)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(displayName ?? displayUsername ?? "").font(.title2.bold())
                        if let displayUsername {
                            Text("@\(displayUsername)").foregroundStyle(.secondary)
                        }
                        if let introduction, !introduction.isEmpty {
                            Text(introduction).font(.body).padding(.top, 4)
                        }
                    }
                }
            }
            if createdPagesCount != nil || bookmarksCount != nil {
                Section {
                    if let createdPagesCount {
                        LabeledContent("Pages", value: "\(createdPagesCount)")
                    }
                    if let bookmarksCount {
                        LabeledContent("Bookmarks", value: "\(bookmarksCount)")
                    }
                }
            }
        }
        .overlay {
            if notFound {
                ContentUnavailableView("User not found", systemImage: "person.crop.circle.badge.exclamationmark")
            }
        }
        .navigationTitle(username.map { "@\($0)" } ?? "Profile")
        .task(id: username) { await load() }
    }

    private func load() async {
        do {
            if let username {
                let response = try await UserPageResponseLenient.fetch(username: username, using: session.apiClient)
                displayUsername = response.username
                displayName = response.name
                displayImage = response.image
                introduction = response.introduction
                createdPagesCount = response.createdPagesCount
                bookmarksCount = response.bookmarksCount
            } else {
                let profile = try await ProfileLenient.fetchMe(using: session.apiClient)
                displayUsername = profile.username
                displayName = profile.name
                displayImage = profile.image
                introduction = profile.introduction
                createdPagesCount = nil
                bookmarksCount = nil
            }
            notFound = false
        } catch ProfileLenientDecodeError.httpError(let status) where status == 404 {
            notFound = true
        } catch {
            // Best-effort read: leave whatever the previous state was
            // rather than showing a hard error for a profile screen.
        }
    }
}
