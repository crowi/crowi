import Foundation

/// RFC-0021 — the merged page-history timeline: content revisions and
/// metadata events (rename / trash / restore / visibility change / creation
/// / draft publish), interleaved in the server's own order (newest first).
/// `GET /pages/{pageId}/history` replaces the old meta-only
/// `GET /pages/{pageId}/revisions` list as this app's history source.
public enum PageHistoryLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
}

/// One `content_revision` row — same flat-actor convention as the old
/// `RevisionMetaLenient` it replaces: `actorName`/`actorUsername`/
/// `actorImage` hold the WHOLE person to show, decoded once at the wire
/// boundary as `savedBy ?? actor` (the row carries both separately —
/// `actor` is always the original author, `savedBy` is who pressed save,
/// added later and possibly a different person in the collaborative flow).
/// The web picks the same way (`page-history.tsx`: `entry.savedBy ??
/// entry.actor`); picking here, once, means a row can never print one
/// person's name beside the other's avatar.
public struct PageHistoryContentRowLenient: Sendable, Equatable, Identifiable, Codable {
    public let id: String
    public let sequence: Int?
    public let occurredAt: String
    public let actorName: String?
    public let actorUsername: String?
    public let actorImage: String?
    public let revisionId: String
    public let editVia: String?
    /// Still in the page's outbox — no durable revision exists yet. The old
    /// list endpoint never surfaced these; the timeline does, so callers
    /// must exclude `pending` rows from both tap-to-view (its GET would
    /// 404) and diff-compare selection.
    public let pending: Bool

    public init(
        id: String,
        sequence: Int?,
        occurredAt: String,
        actorName: String?,
        actorUsername: String?,
        actorImage: String?,
        revisionId: String,
        editVia: String?,
        pending: Bool
    ) {
        self.id = id
        self.sequence = sequence
        self.occurredAt = occurredAt
        self.actorName = actorName
        self.actorUsername = actorUsername
        self.actorImage = actorImage
        self.revisionId = revisionId
        self.editVia = editVia
        self.pending = pending
    }

    public var isAPIEdit: Bool { editVia == "oauth" || editVia == "pat" }

    public var displayName: String? {
        if let actorName, !actorName.isEmpty { return actorName }
        if let actorUsername, !actorUsername.isEmpty { return actorUsername }
        return nil
    }

    static func decode(_ object: [String: Any]) -> PageHistoryContentRowLenient? {
        guard let id = object["id"] as? String, let revisionId = object["revisionId"] as? String else { return nil }
        // `savedBy ?? actor`, object-level: a row carrying both must not
        // print one person's name beside the other's avatar.
        let user = (object["savedBy"] as? [String: Any]) ?? (object["actor"] as? [String: Any])
        return PageHistoryContentRowLenient(
            id: id,
            sequence: object["sequence"] as? Int,
            occurredAt: object["occurredAt"] as? String ?? "",
            actorName: user?["name"] as? String,
            actorUsername: user?["username"] as? String,
            actorImage: user?["image"] as? String,
            revisionId: revisionId,
            editVia: object["editVia"] as? String,
            pending: object["pending"] as? Bool ?? false
        )
    }
}

/// One `page_event` row. `kind` is kept RAW (not a Swift enum) so a kind
/// this build has never heard of still renders — as a generic row — rather
/// than disappearing from the timeline (the `NotificationLenient` stance).
/// Kind-specific payload fields are flattened onto the row (only the ones
/// the row's own `kind` populates are ever non-nil), rather than carried as
/// an opaque dictionary — `Equatable`/`Codable` fall out for free and every
/// reader sees exactly which fields it may use.
public struct PageHistoryEventRowLenient: Sendable, Equatable, Identifiable, Codable {
    public let id: String
    public let sequence: Int?
    public let occurredAt: String
    public let actorName: String?
    public let actorUsername: String?
    public let actorImage: String?
    public let kind: String
    public let operationId: String?
    public let subtree: Bool
    public let pending: Bool
    public let fromPath: String?
    public let toPath: String?
    public let redirectCreated: Bool?
    public let fromGrant: Int?
    public let toGrant: Int?

    public init(
        id: String,
        sequence: Int?,
        occurredAt: String,
        actorName: String?,
        actorUsername: String?,
        actorImage: String?,
        kind: String,
        operationId: String?,
        subtree: Bool,
        pending: Bool,
        fromPath: String?,
        toPath: String?,
        redirectCreated: Bool?,
        fromGrant: Int?,
        toGrant: Int?
    ) {
        self.id = id
        self.sequence = sequence
        self.occurredAt = occurredAt
        self.actorName = actorName
        self.actorUsername = actorUsername
        self.actorImage = actorImage
        self.kind = kind
        self.operationId = operationId
        self.subtree = subtree
        self.pending = pending
        self.fromPath = fromPath
        self.toPath = toPath
        self.redirectCreated = redirectCreated
        self.fromGrant = fromGrant
        self.toGrant = toGrant
    }

    public var displayName: String? {
        if let actorName, !actorName.isEmpty { return actorName }
        if let actorUsername, !actorUsername.isEmpty { return actorUsername }
        return nil
    }

    static func decode(_ object: [String: Any]) -> PageHistoryEventRowLenient? {
        guard let id = object["id"] as? String, let kind = object["kind"] as? String else { return nil }
        let actor = object["actor"] as? [String: Any]
        let payload = object["payload"] as? [String: Any] ?? [:]
        return PageHistoryEventRowLenient(
            id: id,
            sequence: object["sequence"] as? Int,
            occurredAt: object["occurredAt"] as? String ?? "",
            actorName: actor?["name"] as? String,
            actorUsername: actor?["username"] as? String,
            actorImage: actor?["image"] as? String,
            kind: kind,
            operationId: object["operationId"] as? String,
            subtree: object["subtree"] as? Bool ?? false,
            pending: object["pending"] as? Bool ?? false,
            fromPath: payload["fromPath"] as? String,
            toPath: payload["toPath"] as? String,
            redirectCreated: payload["redirectCreated"] as? Bool,
            fromGrant: payload["fromGrant"] as? Int,
            toGrant: payload["toGrant"] as? Int
        )
    }
}

/// One timeline row — a content revision or a metadata event. The `type`
/// discriminator itself (unlike `kind` above) is a closed, structural
/// distinction the wire format defines; a row of neither type is dropped
/// (`compactMap`), the same "skip a malformed row rather than throwing"
/// stance `GetBacklinksResponseLenient` already takes.
public enum PageHistoryEntryLenient: Sendable, Equatable, Identifiable {
    case contentRevision(PageHistoryContentRowLenient)
    case event(PageHistoryEventRowLenient)

    public var id: String {
        switch self {
        case .contentRevision(let row): return row.id
        case .event(let row): return row.id
        }
    }

    public var occurredAt: String {
        switch self {
        case .contentRevision(let row): return row.occurredAt
        case .event(let row): return row.occurredAt
        }
    }

    public var isPending: Bool {
        switch self {
        case .contentRevision(let row): return row.pending
        case .event(let row): return row.pending
        }
    }

    static func decode(_ object: [String: Any]) -> PageHistoryEntryLenient? {
        switch object["type"] as? String {
        case "content_revision":
            return PageHistoryContentRowLenient.decode(object).map { .contentRevision($0) }
        case "page_event":
            return PageHistoryEventRowLenient.decode(object).map { .event($0) }
        default:
            return nil
        }
    }
}

/// Internal cache round-trip only (`CachedRevisionSummary`) — this shape is
/// never compared against the server's wire format, so a private envelope
/// keyed on its own discriminator is enough; it does not need to mirror
/// `type`/`kind` at all.
extension PageHistoryEntryLenient: Codable {
    private enum Case: String, Codable { case contentRevision, event }

    private struct Envelope: Codable {
        let caseName: Case
        let contentRevision: PageHistoryContentRowLenient?
        let event: PageHistoryEventRowLenient?
    }

    public init(from decoder: Decoder) throws {
        let envelope = try Envelope(from: decoder)
        switch envelope.caseName {
        case .contentRevision:
            guard let row = envelope.contentRevision else {
                throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "missing contentRevision payload"))
            }
            self = .contentRevision(row)
        case .event:
            guard let row = envelope.event else {
                throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "missing event payload"))
            }
            self = .event(row)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .contentRevision(let row):
            try Envelope(caseName: .contentRevision, contentRevision: row, event: nil).encode(to: encoder)
        case .event(let row):
            try Envelope(caseName: .event, contentRevision: nil, event: row).encode(to: encoder)
        }
    }
}

/// Whether the page records metadata history, and from when. Both states
/// must decode without throwing even though this app currently renders
/// nothing special for either — a page's timeline is displayed the same
/// way regardless.
public enum PageHistoryTrackingLenient: Sendable, Equatable, Codable {
    case ready(trackingStartedAt: String)
    case untracked
    case unknown

    static func decode(_ object: [String: Any]?) -> PageHistoryTrackingLenient {
        guard let object, let state = object["state"] as? String else { return .unknown }
        switch state {
        case "ready": return .ready(trackingStartedAt: object["trackingStartedAt"] as? String ?? "")
        case "untracked": return .untracked
        default: return .unknown
        }
    }
}

public struct PageHistoryResponseLenient: Sendable, Equatable {
    public let entries: [PageHistoryEntryLenient]
    /// Opaque continuation token; `nil` when the timeline is exhausted.
    public let nextCursor: String?
    public let tracking: PageHistoryTrackingLenient

    public static func decode(_ data: Data) throws -> PageHistoryResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PageHistoryLenientDecodeError.notAnObject
        }
        let rawEntries = object["entries"] as? [[String: Any]] ?? []
        return PageHistoryResponseLenient(
            entries: rawEntries.compactMap(PageHistoryEntryLenient.decode),
            nextCursor: object["nextCursor"] as? String,
            tracking: PageHistoryTrackingLenient.decode(object["tracking"] as? [String: Any])
        )
    }

    public static func fetch(pageId: String, cursor: String? = nil, limit: Int = 50, using client: AuthenticatedAPIClient) async throws -> PageHistoryResponseLenient {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let (data, status) = try await client.get("pages/\(pageId)/history", query: query)
        guard status.isSuccessfulHTTPStatus else { throw PageHistoryLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
