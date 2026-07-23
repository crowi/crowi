import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — the most recent `GET /search` result set for a
/// query string, so re-opening `SearchView` with the same query paints
/// instantly. A flattened, `Codable`-only payload (not `SearchHitLenient`
/// itself, which nests a full `PageLenient`) — a cached search hit only ever
/// needs enough to render the results list; opening a hit re-fetches the
/// real page detail (§8 detail-GET-before-render still applies).
public struct CachedSearchHitPayload: Sendable, Equatable, Codable {
    public let pageId: String
    public let path: String
    public let rawSnippet: String?
    public let bookmarkCount: Int?

    public init(pageId: String, path: String, rawSnippet: String?, bookmarkCount: Int?) {
        self.pageId = pageId
        self.path = path
        self.rawSnippet = rawSnippet
        self.bookmarkCount = bookmarkCount
    }

    public init(_ hit: SearchHitLenient) {
        self.init(pageId: hit.pageId, path: hit.path, rawSnippet: hit.rawSnippet, bookmarkCount: hit.bookmarkCount)
    }
}

@Model
public final class CachedSearchResult {
    @Attribute(.unique) public var query: String
    public var hitsData: Data
    public var cachedAt: Date

    public init(query: String, hitsData: Data, cachedAt: Date = Date()) {
        self.query = query
        self.hitsData = hitsData
        self.cachedAt = cachedAt
    }

    public var hits: [CachedSearchHitPayload] {
        (try? JSONDecoder().decode([CachedSearchHitPayload].self, from: hitsData)) ?? []
    }
}

extension CachedSearchResult {
    public static func upsert(query: String, hits: [SearchHitLenient], in context: ModelContext) {
        let payloads = hits.map(CachedSearchHitPayload.init)
        guard let data = try? JSONEncoder().encode(payloads) else { return }
        let descriptor = FetchDescriptor<CachedSearchResult>(predicate: #Predicate { $0.query == query })
        if let existing = try? context.fetch(descriptor).first {
            existing.hitsData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedSearchResult(query: query, hitsData: data))
        }
    }

    public static func cached(query: String, in context: ModelContext) -> [CachedSearchHitPayload]? {
        let descriptor = FetchDescriptor<CachedSearchResult>(predicate: #Predicate { $0.query == query })
        return (try? context.fetch(descriptor).first)?.hits
    }
}
