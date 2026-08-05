import Foundation

/// RFC-0016 §5.2/§2.1/§8 — lenient decode of the revision-history read
/// endpoints: `GET /pages/{page_id}/revisions` (meta only, no `body`) and
/// `GET /pages/revisions/{id}` (single revision, WITH `body` — mirrors the
/// §8 "detail-endpoint-only" rule `PageLenient`/`PageRevisionLenient` pin
/// for the page resource itself).
public enum RevisionsLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

public struct RevisionMetaLenient: Sendable, Equatable, Codable, Identifiable {
    public var id: String { revisionId }
    public let revisionId: String
    /// WHO the row shows. `RevisionMetaSchema` carries two users: `savedBy`
    /// (who pressed save, added later) and `author` (which v1.x already
    /// populated). The web picks `savedBy ?? author` as a WHOLE object, and
    /// that choice is made here, once, at the wire boundary — so these three
    /// fields are always one person rather than a mix of two.
    public let authorName: String?
    public let authorUsername: String?
    /// Added after the first release of this type: absent from cached JSON
    /// written before it existed, which is why every new field here is
    /// optional (an old blob still decodes, with `nil`).
    public let authorImage: String?
    /// `editVia` — `web` for the browser/collab editor, `oauth`/`pat` for the
    /// API token paths. Kept RAW (not an enum) so a future channel degrades
    /// to "no chip" instead of dropping the row, the `NotificationLenient`
    /// stance.
    public let editVia: String?
    public let createdAt: String?

    /// Whether this revision was saved through an API token rather than the
    /// web editor — the "app" chip the web's history shows
    /// (`page-history.tsx`'s `ApiEditChip`). This app is itself one of those
    /// clients, so its own edits are the ones this marks.
    public var isAPIEdit: Bool { editVia == "oauth" || editVia == "pat" }

    /// The name to print, or `nil` when the server sent neither user.
    public var displayName: String? {
        if let authorName, !authorName.isEmpty { return authorName }
        if let authorUsername, !authorUsername.isEmpty { return authorUsername }
        return nil
    }

    static func decode(_ object: [String: Any]) -> RevisionMetaLenient? {
        guard let revisionId = object["_id"] as? String else { return nil }
        // The web's `savedBy ?? author`, object-level: a revision with a
        // `savedBy` must not print that person's name beside the other's
        // avatar.
        let user = (object["savedBy"] as? [String: Any]) ?? (object["author"] as? [String: Any])
        return RevisionMetaLenient(
            revisionId: revisionId,
            authorName: user?["name"] as? String,
            authorUsername: user?["username"] as? String,
            authorImage: user?["image"] as? String,
            editVia: object["editVia"] as? String,
            createdAt: object["createdAt"] as? String
        )
    }
}

public struct ListRevisionsResponseLenient: Sendable, Equatable {
    public let revisions: [RevisionMetaLenient]

    public static func decode(_ data: Data) throws -> ListRevisionsResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RevisionsLenientDecodeError.notAnObject
        }
        let raw = object["revisions"] as? [[String: Any]] ?? []
        return ListRevisionsResponseLenient(revisions: raw.compactMap(RevisionMetaLenient.decode))
    }

    public static func fetch(pageId: String, limit: Int = 50, offset: Int = 0, using client: AuthenticatedAPIClient) async throws
        -> ListRevisionsResponseLenient
    {
        let (data, status) = try await client.get(
            "pages/\(pageId)/revisions",
            query: [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        )
        guard status.isSuccessfulHTTPStatus else { throw RevisionsLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}

/// `GET /pages/revisions/{id}` — the only revision endpoint that carries
/// `body`, needed to render a past revision (read-only in this phase).
///
/// RFC-0023 Phase 5 — this fetch declares `X-Crowi-Ast-Version: 1` like the
/// page detail GET does (`getRevision` returns `renderedAst`, wire-contract
/// design §16's deliberate Phase 5 promotion), and the shared
/// `PageRevisionLenient` decode already carries the strict envelope
/// outcome. Body-only responses (old servers, never-rendered revisions)
/// keep falling back to the raw-body path.
public struct GetRevisionResponseLenient: Sendable, Equatable {
    public let revision: PageRevisionLenient

    public static func decode(_ data: Data) throws -> GetRevisionResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RevisionsLenientDecodeError.notAnObject
        }
        guard let revisionObject = object["revision"], let revision = PageRevisionLenient.decode(revisionObject) else {
            throw RevisionsLenientDecodeError.notAnObject
        }
        return GetRevisionResponseLenient(revision: revision)
    }

    public static func fetch(revisionId: String, using client: AuthenticatedAPIClient) async throws -> GetRevisionResponseLenient {
        let (data, status) = try await client.get(
            "pages/revisions/\(revisionId)",
            headers: GetPageResponseLenient.astNegotiationHeaders
        )
        guard status.isSuccessfulHTTPStatus else { throw RevisionsLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
