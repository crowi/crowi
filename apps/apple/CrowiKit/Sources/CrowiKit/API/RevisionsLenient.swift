import Foundation

/// RFC-0016 §5.2/§2.1/§8 — lenient decode of the remaining revision read
/// endpoints: `GET /pages/revisions?ids=` (batch by id, WITH `body` — the
/// diff view's source) and `GET /pages/revisions/{id}` (single revision,
/// WITH `body` — mirrors the §8 "detail-endpoint-only" rule
/// `PageLenient`/`PageRevisionLenient` pin for the page resource itself).
/// The meta-only `GET /pages/{page_id}/revisions` list this file used to
/// wrap is superseded by RFC-0021's merged timeline (`PageHistoryLenient`).
public enum RevisionsLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

/// One revision from the batch-by-ids fetch. Body only — `renderedAst` is
/// not decoded here: the diff view compares raw markdown source, matching
/// the web's own diff view (`RevisionDiff.tsx` diffs `.body`, never the
/// AST).
public struct RevisionBodyLenient: Sendable, Equatable, Identifiable {
    public var id: String { revisionId }
    public let revisionId: String
    public let body: String

    static func decode(_ object: [String: Any]) -> RevisionBodyLenient? {
        guard let revisionId = object["_id"] as? String, let body = object["body"] as? String else { return nil }
        return RevisionBodyLenient(revisionId: revisionId, body: body)
    }
}

/// `GET /pages/revisions?ids=a,b` — fetch multiple revisions by id in one
/// call. Response order is not guaranteed (mirrors the web's
/// `use-page-revisions.ts` contract); callers look up by `revisionId`.
public struct GetRevisionsResponseLenient: Sendable, Equatable {
    public let revisions: [RevisionBodyLenient]

    public static func decode(_ data: Data) throws -> GetRevisionsResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RevisionsLenientDecodeError.notAnObject
        }
        let raw = object["revisions"] as? [[String: Any]] ?? []
        return GetRevisionsResponseLenient(revisions: raw.compactMap(RevisionBodyLenient.decode))
    }

    public static func fetch(ids: [String], using client: AuthenticatedAPIClient) async throws -> GetRevisionsResponseLenient {
        let (data, status) = try await client.get("pages/revisions", query: [URLQueryItem(name: "ids", value: ids.joined(separator: ","))])
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
