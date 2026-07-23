import Foundation

/// RFC-0016 §5.2 — lenient decode of `GET /search`
/// (`SearchPagesResponseSchema`), capability-gated on `search` in the
/// refreshed `AppInfoCache` (§5.2 — a host without an active search driver
/// returns `503 { feature: 'search' }`, so `SearchView` must hide itself
/// rather than let the user hit that).
public enum SearchLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
    /// The refreshed `AppInfoCache.capabilities` did not contain `search` —
    /// the app should hide the search UI rather than call this endpoint at
    /// all; surfaced as a distinct case so a caller that DOES call anyway
    /// gets a clear signal instead of a raw `503`.
    case searchCapabilityUnavailable
}

public struct SearchHitLenient: Sendable, Equatable {
    public let pageId: String
    public let path: String
    public let score: Double?
    /// The driver-supplied highlight string, carrying **unescaped**
    /// `<mark>` tokens verbatim (the server does not sanitize it, §5.2's
    /// `newFiles` note) — NEVER render this raw. Use
    /// `SearchHitLenient.plainSnippet(_:)` (strips every tag) for a
    /// native `Text`, since there is no HTML/DOM render context to safely
    /// interpret `<mark>` in (consistent with §6.1's raster-only-decode /
    /// never-a-web-context invariant for untrusted server content).
    public let rawSnippet: String?
    public let bookmarkCount: Int?
    public let page: PageLenient?

    static func decode(_ object: [String: Any]) -> SearchHitLenient? {
        guard let pageId = object["pageId"] as? String, let path = object["path"] as? String else { return nil }
        return SearchHitLenient(
            pageId: pageId,
            path: path,
            score: object["score"] as? Double,
            rawSnippet: object["snippet"] as? String,
            bookmarkCount: object["bookmarkCount"] as? Int,
            page: (object["page"] as? [String: Any]).flatMap(PageLenient.decode)
        )
    }

    /// Strips every `<...>` tag (in practice just the driver's `<mark>` /
    /// `</mark>` highlight wrapper) so the snippet is safe to place in a
    /// native `Text` view — never parsed/rendered as markup.
    public static func plainSnippet(_ rawSnippet: String) -> String {
        var result = ""
        var insideTag = false
        for character in rawSnippet {
            if character == "<" {
                insideTag = true
            } else if character == ">" {
                insideTag = false
            } else if !insideTag {
                result.append(character)
            }
        }
        return result
    }
}

public struct SearchPagesResponseLenient: Sendable, Equatable {
    public let total: Int
    public let results: Int
    public let hits: [SearchHitLenient]

    public static func decode(_ data: Data) throws -> SearchPagesResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SearchLenientDecodeError.notAnObject
        }
        let meta = object["meta"] as? [String: Any] ?? [:]
        let rawHits = object["data"] as? [[String: Any]] ?? []
        return SearchPagesResponseLenient(
            total: meta["total"] as? Int ?? 0,
            results: meta["results"] as? Int ?? rawHits.count,
            hits: rawHits.compactMap(SearchHitLenient.decode)
        )
    }

    /// - Parameter capabilities: the refreshed `AppInfoCache.capabilities`
    ///   the caller already holds — checked here (not just left to the UI
    ///   layer) so no call site can accidentally skip the capability gate.
    public static func fetch(
        query: String,
        capabilities: [String],
        page: Int = 1,
        limit: Int = 50,
        using client: AuthenticatedAPIClient
    ) async throws -> SearchPagesResponseLenient {
        guard capabilities.contains("search") else {
            throw SearchLenientDecodeError.searchCapabilityUnavailable
        }
        let (data, status) = try await client.get(
            "search",
            query: [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
        guard status.isSuccessfulHTTPStatus else { throw SearchLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
