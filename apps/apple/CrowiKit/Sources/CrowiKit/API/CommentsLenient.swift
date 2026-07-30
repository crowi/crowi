import Foundation

/// RFC-0016 §5.2/§2.1 — lenient decode of `GET /comments` (read-only in
/// Phase 1 — posting a comment is bounded-write, Phase 2/`feature-ios-phase2-write`).
public enum CommentsLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

public struct CommentLenient: Sendable, Equatable, Codable, Identifiable {
    public var id: String { commentId }
    public let commentId: String
    public let creatorUsername: String?
    public let creatorName: String?
    /// `creator.image` (`PageUserSchema.image`) — a same-origin, Bearer-gated
    /// attachment path (`/api/attachments/by-key/user/...`), never
    /// displayed via a bare unauthenticated image view (`WorkspaceAvatarView`
    /// routes it through the workspace's own `WorkspaceImageFetching`
    /// conformer, §6.1).
    public let creatorImage: String?
    public let comment: String
    public let createdAt: String?

    static func decode(_ object: [String: Any]) -> CommentLenient? {
        guard let commentId = object["_id"] as? String, let comment = object["comment"] as? String else { return nil }
        let creatorDict = object["creator"] as? [String: Any]
        return CommentLenient(
            commentId: commentId,
            creatorUsername: creatorDict?["username"] as? String,
            creatorName: creatorDict?["name"] as? String,
            creatorImage: creatorDict?["image"] as? String,
            comment: comment,
            createdAt: object["createdAt"] as? String
        )
    }
}

public struct ListCommentsResponseLenient: Sendable, Equatable {
    public let comments: [CommentLenient]

    public static func decode(_ data: Data) throws -> ListCommentsResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CommentsLenientDecodeError.notAnObject
        }
        let rawComments = object["comments"] as? [[String: Any]] ?? []
        return ListCommentsResponseLenient(comments: rawComments.compactMap(CommentLenient.decode))
    }

    public static func fetch(pageId: String, using client: AuthenticatedAPIClient) async throws -> ListCommentsResponseLenient {
        let (data, status) = try await client.get("comments", query: [URLQueryItem(name: "page_id", value: pageId)])
        guard status.isSuccessfulHTTPStatus else { throw CommentsLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
