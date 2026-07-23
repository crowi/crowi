import Foundation

/// RFC-0016 §5.2/§2.1 — lenient decode of `GET /bookmarks` (this workspace
/// user's bookmark of one page, or `null`). Like/seen state is read directly
/// off `PageLenient` (`liker` / `likerCount` / `seenUsersCount`, already
/// present on every page row) — there is no separate "did I like this"
/// endpoint, so no `LikeLenient` type is needed.
public enum BookmarkLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

public struct BookmarkResponseLenient: Sendable, Equatable {
    /// `true` when the current user has bookmarked the page (`bookmark` was
    /// non-null in the response) — the read UI needs only presence, not the
    /// bookmark row's own fields.
    public let isBookmarked: Bool

    public static func decode(_ data: Data) throws -> BookmarkResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BookmarkLenientDecodeError.notAnObject
        }
        // A JSON `null` decodes to `NSNull`, not simply "key absent" — both
        // are treated as "not bookmarked".
        let isBookmarked = object["bookmark"] is [String: Any]
        return BookmarkResponseLenient(isBookmarked: isBookmarked)
    }

    public static func fetch(pageId: String, using client: AuthenticatedAPIClient) async throws -> BookmarkResponseLenient {
        let (data, status) = try await client.get("bookmarks", query: [URLQueryItem(name: "page_id", value: pageId)])
        guard status.isSuccessfulHTTPStatus else { throw BookmarkLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
