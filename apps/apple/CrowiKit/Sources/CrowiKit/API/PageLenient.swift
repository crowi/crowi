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
    /// since native rendering needs `body` for the raw-body fallback path).
    public let body: String?
    public let createdAt: String?
    /// RFC-0023 Phase 4 — the strict-decoded `renderedAst` outcome. The
    /// response SHELL stays lenient (this decoder never throws); strict
    /// validation applies only INSIDE the envelope value, and only when the
    /// value independently proves to be a v1 envelope (`astVersion == 1` —
    /// design doc §9's belt-and-suspenders: an old replica ignores the
    /// request header and returns a bare `Root`, which reads as a fallback
    /// decision here, never a decode failure). `nil` when the response had
    /// no `renderedAst` field at all (list rows, cached reconstructions).
    ///
    /// `rendererVersion` is deliberately NOT decoded anywhere in this file:
    /// it is a freshness diagnostic, never a rendering switch (parent spec
    /// design judgment 1).
    public let renderedAst: RenderedAstDecodeOutcome?

    /// Explicit `public` memberwise init: Swift's auto-synthesized one is
    /// `internal` even for an all-`public`-property struct, which would
    /// otherwise make this type unconstructible (only readable) from the App
    /// target — needed there to reconstruct a `PageLenient` from a
    /// `CachedPage` SwiftData row for the cold-start fast-path display
    /// (which always passes `renderedAst: nil` — the AST is online-only,
    /// wire-contract design §16).
    public init(id: String?, body: String?, createdAt: String?, renderedAst: RenderedAstDecodeOutcome? = nil) {
        self.id = id
        self.body = body
        self.createdAt = createdAt
        self.renderedAst = renderedAst
    }

    static func decode(_ object: Any?) -> PageRevisionLenient? {
        if let idString = object as? String {
            return PageRevisionLenient(id: idString, body: nil, createdAt: nil)
        }
        guard let dict = object as? [String: Any] else { return nil }
        return PageRevisionLenient(
            id: dict["_id"] as? String,
            body: dict["body"] as? String,
            createdAt: dict["createdAt"] as? String,
            renderedAst: dict["renderedAst"].map { RenderedAstEnvelopeDecoder.decode(responseValue: $0) }
        )
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
    /// `lastUpdateUser` (`PageSchema.lastUpdateUser`, a `string | PageUser`
    /// union like `revision`) flattened to the two fields the row-metadata
    /// label actually renders (the `CommentLenient` creator pattern —
    /// feature-ios-design-language (3)). A bare id string, `null`, or a
    /// missing field degrades both to `nil`.
    public let lastUpdateUserName: String?
    public let lastUpdateUserImage: String?

    /// `true` when this row's `revision` is either absent or a bare id with
    /// no `body` — the §8 signal that a detail `GET` is required before the
    /// page can be rendered.
    public var needsDetailFetchForBody: Bool { revision?.body == nil }

    /// The like count a LIST ROW shows, by the web's own rule
    /// (`page-list-item.tsx`): the server's aggregate when it sent one, else
    /// the length of the `liker` array it did send, else zero.
    ///
    /// Both sources exist because different endpoints populate different
    /// ones, and a row that read only `likerCount` would show nothing for a
    /// liked page listed by an endpoint that returns the array instead. The
    /// rule lives here so the row and the reader can never disagree about
    /// what "3 likes" means.
    public var displayLikeCount: Int { likerCount ?? liker?.count ?? 0 }

    /// The comment count a list row shows. No array fallback — a listing
    /// never carries the comments themselves.
    public var displayCommentCount: Int { commentCount ?? 0 }

    /// Explicit `public` memberwise init — same reason as
    /// `PageRevisionLenient.init` above (App-target reconstruction from a
    /// `CachedPage` row). The updater fields default to `nil` since the read
    /// cache doesn't persist them (the recency home is network-only).
    public init(
        id: String,
        path: String,
        revision: PageRevisionLenient?,
        status: String?,
        commentCount: Int?,
        likerCount: Int?,
        seenUsersCount: Int?,
        updatedAt: String?,
        liker: [String]?,
        lastUpdateUserName: String? = nil,
        lastUpdateUserImage: String? = nil
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
        self.lastUpdateUserName = lastUpdateUserName
        self.lastUpdateUserImage = lastUpdateUserImage
    }

    static func decode(_ object: [String: Any]) -> PageLenient? {
        guard let id = object["_id"] as? String, let path = object["path"] as? String else { return nil }
        let lastUpdateUser = object["lastUpdateUser"] as? [String: Any]
        return PageLenient(
            id: id,
            path: path,
            revision: PageRevisionLenient.decode(object["revision"]),
            status: object["status"] as? String,
            commentCount: object["commentCount"] as? Int,
            likerCount: object["likerCount"] as? Int,
            seenUsersCount: object["seenUsersCount"] as? Int,
            updatedAt: object["updatedAt"] as? String,
            liker: object["liker"] as? [String],
            lastUpdateUserName: lastUpdateUser?["name"] as? String,
            lastUpdateUserImage: lastUpdateUser?["image"] as? String
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

    /// RFC-0023 Phase 4 — the detail GET declares the typed-AST capability.
    /// A server that understands it returns the v1 envelope; one that does
    /// not silently ignores the header (bare `Root` → raw-body fallback).
    static let astNegotiationHeaders: [String: String] = [
        RenderedAstWireContract.headerName: String(RenderedAstWireContract.currentAstVersion)
    ]

    /// Fetch the single-page detail by `path` — the only source of a
    /// `body`-carrying revision (§8).
    public static func fetch(path: String, using client: AuthenticatedAPIClient) async throws -> GetPageResponseLenient {
        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "path", value: path)], headers: astNegotiationHeaders)
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }

    /// Fetch the single-page detail by `page_id` — used when re-opening a
    /// page from a cached/list row that only carries the id.
    public static func fetch(pageId: String, using client: AuthenticatedAPIClient) async throws -> GetPageResponseLenient {
        let (data, status) = try await client.get("pages", query: [URLQueryItem(name: "page_id", value: pageId)], headers: astNegotiationHeaders)
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /pages/list` — `{ pages: [Page], pager, total, portalPage? }`.
public struct ListPagesResponseLenient: Sendable, Equatable {
    public let pages: [PageLenient]
    public let portalPage: PageLenient?
    /// feature-profile-stats-and-page-total — the exact size of the
    /// viewer-visible set `pages` is a page OF, independent of `limit`. On
    /// the root listing (`path=/`, which is every visible page in the
    /// workspace) that is the number the home's subtitle prints.
    ///
    /// Optional: a server predating the field leaves the count off the
    /// subtitle rather than printing the page COUNT of the current slice,
    /// which would say "20 pages" for any workspace larger than a screenful.
    public let total: Int?

    public static func decode(_ data: Data) throws -> ListPagesResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PageLenientDecodeError.notAnObject
        }
        let rawPages = object["pages"] as? [[String: Any]] ?? []
        let portalPage = (object["portalPage"] as? [String: Any]).flatMap(PageLenient.decode)
        return ListPagesResponseLenient(
            pages: rawPages.compactMap(PageLenient.decode),
            portalPage: portalPage,
            total: object["total"] as? Int
        )
    }

    /// - Parameter limit: forwarded as the `limit` query when non-nil (the
    ///   server default is 50, `ListPagesRequestSchema` — the recency home
    ///   asks for fewer). Sort deliberately stays the server default,
    ///   `updatedAt` desc — the exact "recently updated" order
    ///   (feature-ios-design-language (3)).
    public static func fetch(path: String, limit: Int? = nil, using client: AuthenticatedAPIClient) async throws -> ListPagesResponseLenient {
        var query = [URLQueryItem(name: "path", value: path)]
        if let limit {
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        let (data, status) = try await client.get("pages/list", query: query)
        guard status.isSuccessfulHTTPStatus else { throw PageLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// The home screen's subtitle — the design's "Almoha Wiki · 128 pages".
///
/// In CrowiKit so the wording, the plural and the missing-count degrade can
/// be asserted; the App target's manifest imports `AppleProductTypes`, which
/// the bare `swift` CLI running the tests cannot parse.
public enum WorkspaceSubtitleLabel {
    /// - Parameter totalPages: `ListPagesResponseLenient.total` for the ROOT
    ///   listing. `nil` (a server that does not report it) prints the
    ///   workspace name alone — the design's line without its count is still
    ///   the design's line, whereas a guessed number is not.
    public static func text(workspaceName: String, totalPages: Int?) -> String {
        guard let totalPages else { return workspaceName }
        let unit = totalPages == 1 ? "page" : "pages"
        return "\(workspaceName) · \(totalPages.formatted(.number)) \(unit)"
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
    /// `PageChildSegmentSchema.lastUpdatedAt` — feature-child-segments-metadata's
    /// additive contract extension, consumed by feature-ios-design-language (1).
    /// Optional so BOTH a pre-extension server's response AND an old
    /// `CachedPageChildren` JSON blob (persisted before these fields existed)
    /// keep decoding unchanged — synthesized `Codable` uses `decodeIfPresent`
    /// for optionals, so no `WorkspaceReadCacheSchema.schemaVersion` bump.
    public let lastUpdatedAt: String?
    /// `updater.name` / `updater.image` flattened (the `CommentLenient`
    /// creator pattern) — `nil` when the server can't resolve the updater
    /// (deleted user, legacy rows) or predates the extension.
    public let updaterName: String?
    public let updaterImage: String?
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
            let updater = dict["updater"] as? [String: Any]
            return PageChildSegmentLenient(
                segment: segment,
                path: path,
                isPage: dict["isPage"] as? Bool ?? false,
                hasPortal: dict["hasPortal"] as? Bool ?? false,
                count: dict["count"] as? Int ?? 0,
                lastUpdatedAt: dict["lastUpdatedAt"] as? String,
                updaterName: updater?["name"] as? String,
                updaterImage: updater?["image"] as? String
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
