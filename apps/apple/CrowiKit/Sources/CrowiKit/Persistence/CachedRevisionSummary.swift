import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — the `GET /pages/{page_id}/revisions` history
/// listing (meta only, no `body` — §8's revision-list vs. revision-detail
/// distinction) for one page id.
@Model
public final class CachedRevisionSummary {
    @Attribute(.unique) public var pageId: String
    public var revisionsData: Data
    public var cachedAt: Date

    public init(pageId: String, revisionsData: Data, cachedAt: Date = Date()) {
        self.pageId = pageId
        self.revisionsData = revisionsData
        self.cachedAt = cachedAt
    }

    public var revisions: [RevisionMetaLenient] {
        (try? JSONDecoder().decode([RevisionMetaLenient].self, from: revisionsData)) ?? []
    }
}

extension CachedRevisionSummary {
    public static func upsert(pageId: String, revisions: [RevisionMetaLenient], in context: ModelContext) {
        guard let data = try? JSONEncoder().encode(revisions) else { return }
        let descriptor = FetchDescriptor<CachedRevisionSummary>(predicate: #Predicate { $0.pageId == pageId })
        if let existing = try? context.fetch(descriptor).first {
            existing.revisionsData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedRevisionSummary(pageId: pageId, revisionsData: data))
        }
    }

    public static func cached(pageId: String, in context: ModelContext) -> [RevisionMetaLenient]? {
        let descriptor = FetchDescriptor<CachedRevisionSummary>(predicate: #Predicate { $0.pageId == pageId })
        return (try? context.fetch(descriptor).first)?.revisions
    }
}
