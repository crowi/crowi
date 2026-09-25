import Foundation

/// RFC-0016 §5.2/§2.1 — lenient decode of `GET /me` (own profile),
/// `GET /user/{username}` (public profile), and
/// `GET /me/recently-viewed-pages`.
public enum ProfileLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

/// `GET /me` — `UserProfileResponseSchema`. `id` is what `PageLenient.liker`
/// membership is checked against for "did I like this page" (§2.1).
public struct ProfileLenient: Sendable, Equatable {
    public let id: String?
    public let username: String?
    public let name: String?
    public let image: String?
    public let introduction: String?

    public static func decode(_ data: Data) throws -> ProfileLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProfileLenientDecodeError.notAnObject
        }
        return ProfileLenient(
            id: object["id"] as? String,
            username: object["username"] as? String,
            name: object["name"] as? String,
            image: object["image"] as? String,
            introduction: object["introduction"] as? String
        )
    }

    /// The signed-in user's own profile.
    public static func fetchMe(using client: AuthenticatedAPIClient) async throws -> ProfileLenient {
        let (data, status) = try await client.get("me")
        guard status.isSuccessfulHTTPStatus else { throw ProfileLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /user/{username}` — `UserPageResponseSchema` (`{ user, createdPagesCount, bookmarksCount, ... }`).
/// A tapped `@mention` navigates here unconditionally (§6's mention-tap
/// rule): username existence is validated only server-side at save time, so
/// this endpoint's own 404 is what surfaces an unknown user, never a
/// client-side pre-check.
public struct UserPageResponseLenient: Sendable, Equatable {
    public let username: String?
    public let name: String?
    public let image: String?
    public let introduction: String?
    public let createdPagesCount: Int?
    public let bookmarksCount: Int?
    /// feature-profile-stats-and-page-total — the target user's OWN actions:
    /// pages THEY liked and comments THEY wrote, not activity their pages
    /// received. Optional like every other count here, so a server predating
    /// the extension drops the stat instead of printing a confident zero.
    public let likesCount: Int?
    public let commentsCount: Int?

    public static func decode(_ data: Data) throws -> UserPageResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProfileLenientDecodeError.notAnObject
        }
        let user = object["user"] as? [String: Any] ?? [:]
        return UserPageResponseLenient(
            username: user["username"] as? String,
            name: user["name"] as? String,
            image: user["image"] as? String,
            introduction: user["introduction"] as? String,
            createdPagesCount: object["createdPagesCount"] as? Int,
            bookmarksCount: object["bookmarksCount"] as? Int,
            likesCount: object["likesCount"] as? Int,
            commentsCount: object["commentsCount"] as? Int
        )
    }

    public static func fetch(username: String, using client: AuthenticatedAPIClient) async throws -> UserPageResponseLenient {
        let (data, status) = try await client.get("user/\(username)")
        guard status.isSuccessfulHTTPStatus else { throw ProfileLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /me/recently-viewed-pages` — `{ pages: [Page] }`.
public struct RecentlyViewedPagesResponseLenient: Sendable, Equatable {
    public let pages: [PageLenient]

    public static func decode(_ data: Data) throws -> RecentlyViewedPagesResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProfileLenientDecodeError.notAnObject
        }
        let rawPages = object["pages"] as? [[String: Any]] ?? []
        return RecentlyViewedPagesResponseLenient(pages: rawPages.compactMap(PageLenient.decode))
    }

    public static func fetch(using client: AuthenticatedAPIClient) async throws -> RecentlyViewedPagesResponseLenient {
        let (data, status) = try await client.get("me/recently-viewed-pages")
        guard status.isSuccessfulHTTPStatus else { throw ProfileLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// The page lists a profile links to. Both are the target user's own
/// actions, keyed by username.
public enum UserPageListKind: String, Sendable, Hashable, CaseIterable {
    /// `GET /user/{username}/bookmarks` — `{ bookmarks: [{ page }], pager, total }`.
    case bookmarks
    /// `GET /user/{username}/pages` — `{ pages, pager, total }`, pages the
    /// user created.
    case created

    var endpoint: String {
        switch self {
        case .bookmarks: "bookmarks"
        case .created: "pages"
        }
    }
}

public struct UserPageListResponseLenient: Sendable, Equatable {
    public let pages: [PageLenient]
    public let total: Int?
    /// The offset to ask for next, `nil` once the list is exhausted. Taken
    /// from the server's pager rather than counted from `pages`: the
    /// bookmarks endpoint drops rows whose page has since been deleted, so
    /// a slice can hold fewer pages than it paged over.
    public let nextOffset: Int?

    public static func decode(_ data: Data, kind: UserPageListKind) throws -> UserPageListResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProfileLenientDecodeError.notAnObject
        }
        let rawPages: [[String: Any]]
        switch kind {
        case .bookmarks:
            rawPages = (object["bookmarks"] as? [[String: Any]] ?? []).compactMap { $0["page"] as? [String: Any] }
        case .created:
            rawPages = object["pages"] as? [[String: Any]] ?? []
        }
        let pager = object["pager"] as? [String: Any]
        return UserPageListResponseLenient(
            pages: rawPages.compactMap(PageLenient.decode),
            total: object["total"] as? Int,
            nextOffset: pager?["next"] as? Int
        )
    }

    public static func fetch(
        username: String,
        kind: UserPageListKind,
        limit: Int,
        offset: Int,
        using client: AuthenticatedAPIClient
    ) async throws -> UserPageListResponseLenient {
        let (data, status) = try await client.get(
            "user/\(username)/\(kind.endpoint)",
            query: [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        )
        guard status.isSuccessfulHTTPStatus else { throw ProfileLenientDecodeError.httpError(status: status) }
        return try decode(data, kind: kind)
    }
}
