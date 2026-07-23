import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — the `GET /pages/children` hierarchy listing
/// for one portal `path`, so `PageTreeView`'s sidebar can paint instantly on
/// a cold re-open before the network refresh completes. The child rows
/// themselves are stored as an encoded JSON blob (not one `@Model` row per
/// child) since they are never queried individually — only ever read/written
/// whole, keyed by `path`.
@Model
public final class CachedPageChildren {
    @Attribute(.unique) public var path: String
    public var childrenData: Data
    public var cachedAt: Date

    public init(path: String, childrenData: Data, cachedAt: Date = Date()) {
        self.path = path
        self.childrenData = childrenData
        self.cachedAt = cachedAt
    }

    public var children: [PageChildSegmentLenient] {
        (try? JSONDecoder().decode([PageChildSegmentLenient].self, from: childrenData)) ?? []
    }
}

extension CachedPageChildren {
    public static func upsert(path: String, children: [PageChildSegmentLenient], in context: ModelContext) {
        guard let data = try? JSONEncoder().encode(children) else { return }
        let descriptor = FetchDescriptor<CachedPageChildren>(predicate: #Predicate { $0.path == path })
        if let existing = try? context.fetch(descriptor).first {
            existing.childrenData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedPageChildren(path: path, childrenData: data))
        }
    }

    public static func cached(path: String, in context: ModelContext) -> [PageChildSegmentLenient]? {
        let descriptor = FetchDescriptor<CachedPageChildren>(predicate: #Predicate { $0.path == path })
        return (try? context.fetch(descriptor).first)?.children
    }
}
