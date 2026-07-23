import Foundation

/// RFC-0016 §5.2/§8 — hand-written lenient decoders for the page read
/// screens (detail / list / children), following `AppInfoLenient`'s pattern
/// exactly: only the fields a screen actually reads, optionals-first,
/// degrade rather than throw on anything unexpected.
public enum PageLenientDecodeError: Error, Equatable {
    case notAnObject
    case missingPage
    case httpError(status: Int)
}

/// `PageSchema.revision` (`packages/api-contract/src/schemas/page.ts:129`) is
/// `z.union([z.string(), RevisionSchema]).optional()`: list / children /
/// portal rows may carry a bare revision-id string with **no** `body`,
/// while the single-page detail response always carries the full object.
public struct PageRevisionLenient: Sendable, Equatable {
    public let id: String?
    /// `nil` on a list/children/portal row (§8 — "detail-GET-before-render"
    /// is a hard rule every read screen that opens such a row must honor,
    /// since native rendering needs `body` and never reads `renderedAst`).
    public let body: String?
    public let createdAt: String?

    /// Explicit `public` memberwise init: Swift's auto-synthesized one is
    /// `internal` even for an all-`public`-property struct, which would
    /// otherwise make this type unconstructible (only readable) from the App
    /// target — needed there to reconstruct a `PageLenient` from a
    /// `CachedPage` SwiftData row for the cold-start fast-path display.
    public init(id: String?, body: String?, createdAt: String?) {
        self.id = id
        self.body = body
        self.createdAt = createdAt
    }

    static func decode(_ object: Any?) -> PageRevisionLenient? {
        if let idString = object as? String {
            return PageRevisionLenient(id: idString, body: nil, createdAt: nil)
        }
        guard let dict = object as? [String: Any] else { return nil }
        return PageRevisionLenient(id: dict["_id"] as? String, body: dict["body"] as? String, createdAt: dict["createdAt"] as? String)
    }
}

public struct PageLenient: Sendable, Equatable {
    public let id: String
    public let path: String
    public let revision: PageRevisionLenient?
    public let status: String?
    public let commentCount: Int?
    public let likerCount: Int?
    public let seenUsersCount: Int?
    public let updatedAt: String?
    /// User ids who liked this page (`PageSchema.liker`) — the read UI
    /// checks membership against the signed-in user's own id (`ProfileLenient`)
    /// to render "liked by me" state; there is no dedicated "did I like this"
    /// endpoint.
    public let liker: [String]?

    /// `true` when this row's `revision` is either absent or a bare id with
    /// no `body` — the §8 signal that a detail `GET` is required before the
    /// page can be rendered.
    public var needsDetailFetchForBody: Bool { revision?.body == nil }

    /// Explicit `public` memberwise init — same reason as
    /// `PageRevisionLenient.init` above (App-target reconstruction from a
    /// `CachedPage` row).
    public init(
        id: String,
        path: String,
        revision: PageRevisionLenient?,
        status: String?,
        commentCount: Int?,
        likerCount: Int?,
        seenUsersCount: Int?,
        updatedAt: String?,
        liker: [String]?
    ) {
        self.id = id
        self.path = path
        self.revision = revision
        self.status = status
        self.commentCount = commentCount
        self.likerCount = likerCount
        self.seenUsersCount = seenUsersCount
        self.updatedAt = updatedAt
        self.liker = liker
    }

    static func decode(_ object: [String: Any]) -> PageLenient? {
        guard let id = object["_id"] as? String, let path = object["path"] as? String else { return nil }
        return PageLenient(
            id: id,
            path: path,
            revision: PageRevisionLenient.decode(object["revision"]),
            status: object["status"] as? String,
            commentCount: object["commentCount"] as? Int,
            likerCount: object["likerCount"] as? Int,
            seenUsersCount: object["seenUsersCount"] as? Int,
            updatedAt: object["updatedAt"] as? String,
            liker: object["liker"] as? [String]
        )
    }
}

/// `GET /pages` (detail, `path` or `page_id` query) — `{ page: PageWithRevision }`.
public struct GetPageResponseLenient: Sendable, Equatable {
    public let page: PageLenient

    public static func decode(_ data: Data) throws -> GetPageResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PageLenientDecodeError.notAnObject
        }
        guard let pageObject = object["page"] as? [String: Any], let page = PageLenient.decode(pageObject) else {
            throw PageLenientDecodeError.missingPage
        }
        return GetPageResponseLenient(page: page)
    }

    /// Fetch the single-page detail by `path` — the only source of a
    /// `body`-carrying revision (§8).
    public static func fetch(path: String, using client: AuthenticatedAPIClient) async throws -> GetPageResponseLenient {
        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "path", value: path)])
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }

    /// Fetch the single-page detail by `page_id` — used when re-opening a
    /// page from a cached/list row that only carries the id.
    public static func fetch(pageId: String, using client: AuthenticatedAPIClient) async throws -> GetPageResponseLenient {
        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "page_id", value: pageId)])
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /pages/list` — `{ pages: [Page], pager, portalPage? }`.
public struct ListPagesResponseLenient: Sendable, Equatable {
    public let pages: [PageLenient]
    public let portalPage: PageLenient?

    public static func decode(_ data: Data) throws -> ListPagesResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PageLenientDecodeError.notAnObject
        }
        let rawPages = object["pages"] as? [[String: Any]] ?? []
        let portalPage = (object["portalPage"] as? [String: Any]).flatMap(PageLenient.decode)
        return ListPagesResponseLenient(pages: rawPages.compactMap(PageLenient.decode), portalPage: portalPage)
    }

    public static func fetch(path: String, using client: AuthenticatedAPIClient) async throws -> ListPagesResponseLenient {
        let (data, status) = try await client.get("pages/list", query: [URLQueryItem(name: "path", value: path)])
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /pages/children` — `{ children: [PageChildSegment] }` (the sidebar
/// hierarchy tree, §9's `NavigationSplitView` sidebar column).
public struct PageChildSegmentLenient: Sendable, Equatable, Codable {
    public let segment: String
    public let path: String
    public let isPage: Bool
    public let hasPortal: Bool
    public let count: Int
}

public struct ListPageChildrenResponseLenient: Sendable, Equatable {
    public let children: [PageChildSegmentLenient]

    public static func decode(_ data: Data) throws -> ListPageChildrenResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PageLenientDecodeError.notAnObject
        }
        let rawChildren = object["children"] as? [[String: Any]] ?? []
        let children = rawChildren.compactMap { dict -> PageChildSegmentLenient? in
            guard let segment = dict["segment"] as? String, let path = dict["path"] as? String else { return nil }
            return PageChildSegmentLenient(
                segment: segment,
                path: path,
                isPage: dict["isPage"] as? Bool ?? false,
                hasPortal: dict["hasPortal"] as? Bool ?? false,
                count: dict["count"] as? Int ?? 0
            )
        }
        return ListPageChildrenResponseLenient(children: children)
    }

    public static func fetch(path: String, using client: AuthenticatedAPIClient) async throws -> ListPageChildrenResponseLenient {
        let (data, status) = try await client.get("pages/children", query: [URLQueryItem(name: "path", value: path)])
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
