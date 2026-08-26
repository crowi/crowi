import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache, RFC-0021 shape — the `GET /pages/{page_id}/history`
/// merged timeline (content revisions + metadata events) for one page id.
/// Superseded from the old meta-only revisions list; the class name stays
/// (only the cached shape changed) to avoid an unnecessary SwiftData model
/// rename.
@Model
public final class CachedRevisionSummary {
    @Attribute(.unique) public var pageId: String
    public var entriesData: Data
    public var cachedAt: Date

    public init(pageId: String, entriesData: Data, cachedAt: Date = Date()) {
        self.pageId = pageId
        self.entriesData = entriesData
        self.cachedAt = cachedAt
    }

    public var entries: [PageHistoryEntryLenient] {
        (try? JSONDecoder().decode([PageHistoryEntryLenient].self, from: entriesData)) ?? []
    }
}

extension CachedRevisionSummary {
    public static func upsert(pageId: String, entries: [PageHistoryEntryLenient], in context: ModelContext) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        let descriptor = FetchDescriptor<CachedRevisionSummary>(predicate: #Predicate { $0.pageId == pageId })
        if let existing = try? context.fetch(descriptor).first {
            existing.entriesData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedRevisionSummary(pageId: pageId, entriesData: data))
        }
    }

    public static func cached(pageId: String, in context: ModelContext) -> [PageHistoryEntryLenient]? {
        let descriptor = FetchDescriptor<CachedRevisionSummary>(predicate: #Predicate { $0.pageId == pageId })
        return (try? context.fetch(descriptor).first)?.entries
    }
}
