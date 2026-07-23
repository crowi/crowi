import Foundation

/// RFC-0016 §5.2/§2.1 — lenient decode of `GET /backlinks`.
public enum BacklinksLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

public struct BacklinkLenient: Sendable, Equatable, Codable, Identifiable {
    public var id: String { backlinkId }
    public let backlinkId: String
    public let fromPagePath: String
    public let updatedAt: String?

    static func decode(_ object: [String: Any]) -> BacklinkLenient? {
        guard let backlinkId = object["_id"] as? String,
            let fromPage = object["fromPage"] as? [String: Any],
            let fromPagePath = fromPage["path"] as? String
        else { return nil }
        return BacklinkLenient(backlinkId: backlinkId, fromPagePath: fromPagePath, updatedAt: object["updatedAt"] as? String)
    }
}

public struct GetBacklinksResponseLenient: Sendable, Equatable {
    public let backlinks: [BacklinkLenient]
    public let hasNext: Bool

    public static func decode(_ data: Data) throws -> GetBacklinksResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BacklinksLenientDecodeError.notAnObject
        }
        let rawBacklinks = object["backlinks"] as? [[String: Any]] ?? []
        return GetBacklinksResponseLenient(
            backlinks: rawBacklinks.compactMap(BacklinkLenient.decode),
            hasNext: object["hasNext"] as? Bool ?? false
        )
    }

    public static func fetch(pageId: String, limit: Int = 20, offset: Int = 0, using client: AuthenticatedAPIClient) async throws
        -> GetBacklinksResponseLenient
    {
        let (data, status) = try await client.get(
            "backlinks",
            query: [
                URLQueryItem(name: "page_id", value: pageId),
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "offset", value: String(offset)),
            ]
        )
        guard status.isSuccessfulHTTPStatus else { throw BacklinksLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
