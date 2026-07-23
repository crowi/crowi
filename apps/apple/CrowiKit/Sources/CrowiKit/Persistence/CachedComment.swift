import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — the `GET /comments` thread for one page id.
@Model
public final class CachedComment {
    @Attribute(.unique) public var pageId: String
    public var commentsData: Data
    public var cachedAt: Date

    public init(pageId: String, commentsData: Data, cachedAt: Date = Date()) {
        self.pageId = pageId
        self.commentsData = commentsData
        self.cachedAt = cachedAt
    }

    public var comments: [CommentLenient] {
        (try? JSONDecoder().decode([CommentLenient].self, from: commentsData)) ?? []
    }
}

extension CachedComment {
    public static func upsert(pageId: String, comments: [CommentLenient], in context: ModelContext) {
        guard let data = try? JSONEncoder().encode(comments) else { return }
        let descriptor = FetchDescriptor<CachedComment>(predicate: #Predicate { $0.pageId == pageId })
        if let existing = try? context.fetch(descriptor).first {
            existing.commentsData = data
            existing.cachedAt = Date()
        } else {
            context.insert(CachedComment(pageId: pageId, commentsData: data))
        }
    }

    public static func cached(pageId: String, in context: ModelContext) -> [CommentLenient]? {
        let descriptor = FetchDescriptor<CachedComment>(predicate: #Predicate { $0.pageId == pageId })
        return (try? context.fetch(descriptor).first)?.comments
    }
}
