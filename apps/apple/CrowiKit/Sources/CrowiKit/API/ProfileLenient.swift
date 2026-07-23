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
            bookmarksCount: object["bookmarksCount"] as? Int
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
