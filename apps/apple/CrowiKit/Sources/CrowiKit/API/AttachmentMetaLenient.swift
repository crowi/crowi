import Foundation

/// `feature-ios-image-viewer` — the tolerant decode of
/// `GET /api/attachments/{id}/meta` (`AttachmentMetaSchema`,
/// `packages/api-contract/src/schemas/attachment.ts`), following the Phase
/// 0-pinned lenient pattern (`AppInfoLenient`/`PageLenient`) exactly:
/// hand-written, `JSONSerialization`-based, optionals-first, degrade rather
/// than throw on anything unexpected — never the strict generated `Output`.
///
/// The image viewer only ever reads `originalUrl` — the
/// `feature-image-derivative-optimization` Phase 2 explicit-original path
/// (`${url}/original`, always the original bytes regardless of whether a
/// display derivative exists). A workspace running a Crowi from before that
/// contract has no `/meta` endpoint at all (a `404` — `fetch` throws
/// `httpError`) or no `originalUrl` field (decodes to `nil`); either way
/// `OriginalImageResolver` falls back to the canonical URL instead of
/// breaking the viewer.
public struct AttachmentMetaLenient: Sendable, Equatable {
    public let id: String?
    /// The canonical (display-derivative-serving) relative URL —
    /// `/api/attachments/<id>`, the same URL the page body embeds.
    public let url: String?
    /// The explicit original-bytes relative URL — `${url}/original`. `nil`
    /// when the host predates the display-derivative contract.
    public let originalUrl: String?
    /// The name the file was uploaded under. Carried because a preview needs
    /// an extension to know what it is looking at — bytes alone are not
    /// enough for the system's own viewer.
    public let originalName: String?
    /// The server's MIME type, as a fallback when the name has no extension.
    public let fileFormat: String?

    /// Decode leniently: unknown extra keys are ignored, missing keys become
    /// `nil` — only a body that is not a JSON object at all throws.
    public static func decode(_ data: Data) throws -> AttachmentMetaLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodeError.notAnObject
        }
        return AttachmentMetaLenient(
            id: object["_id"] as? String,
            url: object["url"] as? String,
            originalUrl: object["originalUrl"] as? String,
            originalName: object["originalName"] as? String,
            fileFormat: object["fileFormat"] as? String
        )
    }

    public enum DecodeError: Error, Equatable {
        case notAnObject
        /// Non-2xx — includes the `404` an old (pre-display-contract) Crowi
        /// answers for a route it never had, and the grant-denied `404` the
        /// handler collapses hidden pages into.
        case httpError(status: Int)
    }

    /// Fetch + decode `GET {apiBaseURL}/attachments/{id}/meta` through the
    /// ONE per-workspace authenticated-fetch primitive every hand-written
    /// lenient decoder is built on (§5.1 — never a bare `URLSession`).
    public static func fetch(attachmentId: String, using client: AuthenticatedAPIClient) async throws -> AttachmentMetaLenient {
        let (data, status) = try await client.get("attachments/\(attachmentId)/meta")
        guard status.isSuccessfulHTTPStatus else { throw DecodeError.httpError(status: status) }
        return try decode(data)
    }
}
