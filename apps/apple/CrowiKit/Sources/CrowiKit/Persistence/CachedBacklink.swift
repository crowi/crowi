import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — the `GET /backlinks` listing for one target
/// page id, keyed the same "whole blob per key" way as `CachedPageChildren`
/// (backlinks are only ever read/written as the full set for a page, never
/// queried individually).
@Model
public final class CachedBacklink {
    @Attribute(.unique) public var pageId: String
    public var backlinksData: Data
    public var cachedAt: Date

    public init(pageId: String, backlinksData: Data, cachedAt: Date = Date()) {
        self.pageId = pageId
        self.backlinksData = backlinksData
        self.cachedAt = cachedAt
    }

    public var backlinks: [BacklinkLenient] {
        (try? JSONDecoder().decode([BacklinkLenient].self, from: backlinksData)) ?? []
    }
}

extension CachedBacklink {
    public static func upsert(pageId: String, backlinks: [BacklinkLenient], in context: ModelContext) {
        guard let data = try? JSONEncoder().encode(backlinks) else { return }
        let descriptor = FetchDescriptor<CachedBacklink>(predicate: #Predicate { $0.pageId == pageId })
        if let existing = try? context.fetch(descriptor).first {
            existing.backlinksData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedBacklink(pageId: pageId, backlinksData: data))
        }
    }

    public static func cached(pageId: String, in context: ModelContext) -> [BacklinkLenient]? {
        let descriptor = FetchDescriptor<CachedBacklink>(predicate: #Predicate { $0.pageId == pageId })
        return (try? context.fetch(descriptor).first)?.backlinks
    }
}
