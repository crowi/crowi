import Foundation
import SwiftData

/// RFC-0016 §7.2 read-cache — one page's body + metadata, keyed by page id.
/// No `workspaceId` field: physical isolation is already the per-workspace
/// `ModelContainer` itself (§7.1), so a query against this type can never
/// cross into another workspace's cache. Best-effort / fast-path only — the
/// app always prefers a fresh network fetch when online (§7.2); this exists
/// so `PageReaderView` can paint something instantly on a cold re-open.
///
/// **`renderedAst` is deliberately NOT persisted** (RFC-0023 /
/// wire-contract design §16 — the AST is online-only, so this schema and
/// `WorkspaceReadCacheSchema.schemaVersion` stay untouched by Phase 4):
/// `data.renderPending` retries are never written back server-side, so the
/// same `revisionId` can legitimately return a DIFFERENT AST on every read
/// — persisting one snapshot would pin a possibly-still-pending render on
/// offline readers indefinitely, which is worse than the raw-body fallback
/// (current source text, less rich but never stale). A cache-painted page
/// therefore always renders through the raw-body path
/// (`asPageLenient` yields `renderedAst: nil`); the network refresh that
/// follows swaps in the typed path when the server returns an envelope.
/// `RenderedAstFallbackTests` pins this round-trip.
@Model
public final class CachedPage {
    @Attribute(.unique) public var pageId: String
    public var path: String
    /// `nil` until a detail `GET` has populated it (§8 — a list/children row
    /// alone never carries `body`).
    public var body: String?
    public var revisionId: String?
    public var status: String?
    public var commentCount: Int
    public var likerCount: Int
    public var seenUsersCount: Int
    public var updatedAt: String?
    /// RFC-0020 `PageContentType` raw value. Persisted so a cold paint of an
    /// artifact page never shows its HTML source as Markdown before the
    /// network read lands. `nil` reads as Markdown.
    public var contentType: String?
    public var cachedAt: Date

    public init(
        pageId: String,
        path: String,
        body: String?,
        revisionId: String?,
        status: String?,
        commentCount: Int,
        likerCount: Int,
        seenUsersCount: Int,
        updatedAt: String?,
        contentType: String? = nil,
        cachedAt: Date = Date()
    ) {
        self.pageId = pageId
        self.path = path
        self.body = body
        self.revisionId = revisionId
        self.status = status
        self.commentCount = commentCount
        self.likerCount = likerCount
        self.seenUsersCount = seenUsersCount
        self.updatedAt = updatedAt
        self.contentType = contentType
        self.cachedAt = cachedAt
    }

    public func update(from page: PageLenient, cachedAt: Date = Date()) {
        self.path = page.path
        if let body = page.revision?.body {
            self.body = body
        }
        self.revisionId = page.revision?.id ?? self.revisionId
        self.status = page.status
        self.commentCount = page.commentCount ?? self.commentCount
        self.likerCount = page.likerCount ?? self.likerCount
        self.seenUsersCount = page.seenUsersCount ?? self.seenUsersCount
        self.updatedAt = page.updatedAt
        self.contentType = (page.revision?.contentType ?? page.contentType)?.rawValue ?? self.contentType
        self.cachedAt = cachedAt
    }
}

extension CachedPage {
    /// Fetch-or-insert-and-update in one call — the standard read-cache
    /// write-through every screen in this phase uses (fetch by unique key,
    /// mutate if found, insert if not).
    public static func upsert(from page: PageLenient, in context: ModelContext) {
        let pageId = page.id
        let descriptor = FetchDescriptor<CachedPage>(predicate: #Predicate { $0.pageId == pageId })
        if let existing = try? context.fetch(descriptor).first {
            existing.update(from: page)
        } else {
            context.insert(CachedPage(
                pageId: page.id,
                path: page.path,
                body: page.revision?.body,
                revisionId: page.revision?.id,
                status: page.status,
                commentCount: page.commentCount ?? 0,
                likerCount: page.likerCount ?? 0,
                seenUsersCount: page.seenUsersCount ?? 0,
                updatedAt: page.updatedAt,
                contentType: (page.revision?.contentType ?? page.contentType)?.rawValue
            ))
        }
    }

    public static func cached(pageId: String, in context: ModelContext) -> CachedPage? {
        let descriptor = FetchDescriptor<CachedPage>(predicate: #Predicate { $0.pageId == pageId })
        return try? context.fetch(descriptor).first
    }

    public static func cached(path: String, in context: ModelContext) -> CachedPage? {
        let descriptor = FetchDescriptor<CachedPage>(predicate: #Predicate { $0.path == path })
        return try? context.fetch(descriptor).first
    }

    /// The inverse of `upsert(from:)`, for the cold-open fast-path paint:
    /// rebuilds the lenient page value a reader screen renders from this
    /// cached row. Fields the cache doesn't persist (`liker`, the updater
    /// pair, and — deliberately, design §16 — `renderedAst`) come back
    /// `nil` — the fresh network fetch that always follows replaces the
    /// whole value anyway.
    public var asPageLenient: PageLenient {
        PageLenient(
            id: pageId,
            path: path,
            revision: body.map { PageRevisionLenient(id: revisionId, body: $0, createdAt: nil, renderedAst: nil, contentType: cachedContentType) },
            status: status,
            commentCount: commentCount,
            likerCount: likerCount,
            seenUsersCount: seenUsersCount,
            updatedAt: updatedAt,
            liker: nil,
            contentType: cachedContentType
        )
    }

    private var cachedContentType: PageContentType? {
        PageContentType.decode(contentType)
    }
}
