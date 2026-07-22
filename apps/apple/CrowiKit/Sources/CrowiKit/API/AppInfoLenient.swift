import Foundation

/// RFC-0016 §3 add-flow step 2 / §5.2 / Phase 0 gate B — the **lenient**
/// `/app/info` decode, deliberately NOT the swift-openapi-generator strict
/// `Operations.get_sol_app_sol_info.Output`.
///
/// Phase 0 finding (pinning OQ-8, the lenient-decode seam): the generated
/// `AppInfoResponse` type is a strict `Codable` struct produced from
/// `AppInfoResponseSchema` (`packages/api-contract/src/schemas/app.ts:39-46`),
/// which marks `version` / `apiVersion` / `capabilities` **required**. A host
/// that omits `capabilities` (an old Crowi) would throw decoding through the
/// generated type — exactly the failure §5.2 exists to prevent, and the add-
/// workspace probe explicitly must not hard-fail on it. So the seam is
/// pinned here: **hand-written tolerant response models, decoded from the
/// raw response `Data`** (never through the generated `Output` for
/// *response* parsing). This holds for every response the app reads, not
/// just `/app/info` — the generated client's value is request/path
/// construction (gate B's `GeneratedClientSmoke` demonstrates that half),
/// not response decoding.
///
/// A second, independent finding from the real spec sharpens *why* a purely
/// mechanical "loosen `Codable`" fix over the generated type would not be
/// enough even if attempted: several `anyOf`/`oneOf` schemas in the real
/// document (e.g. `Revision.savedBy`) carry an explicit `{ "type": "null" }`
/// branch that swift-openapi-generator (as of the version this spike pinned)
/// silently **drops** from the generated union payload ("Schema 'null' is
/// not supported, reason: 'schema type', skipping" — observed directly from
/// `swift build`'s diagnostics against `packages/api-contract/openapi.json`).
/// A JSON `null` for such a field would then fail to decode into *any*
/// remaining generated payload case, so the generated response type is not
/// just "too strict on missing keys" but actively cannot represent a real,
/// valid response shape for those fields. Hand-written models sidestep this
/// entirely by treating every field the app doesn't strictly need as
/// `Optional` from the start.
public struct AppInfoLenient: Sendable, Equatable {
    public let title: String?
    public let confidential: String?
    public let version: String?
    public let apiVersion: String?
    /// `nil` capabilities (host omitted the field) is substituted with
    /// `StaticCapabilities.baseline` by `decode(_:)` below — callers never
    /// see the "missing" state, only the already-degraded baseline.
    public let capabilities: [String]
    public let canSelfRegister: Bool?

    /// True when the host omitted `capabilities` and this value is the
    /// substituted static baseline rather than a host-reported list. Kept
    /// only for the spike's own test assertions / observability — not part
    /// of any control-flow decision (the app always just reads `capabilities`).
    public let capabilitiesAreBaselineFallback: Bool

    /// `true` when this response looks like a real Crowi `/app/info` payload
    /// — i.e. it carries a `version`. A non-Crowi host (some other JSON API,
    /// or an error page's JSON body) typically has no `version` field at
    /// all; `AddWorkspaceFlow` (§3 step 2) rejects such a host with a clear
    /// "not a Crowi instance" error rather than treating it as a very old
    /// Crowi (which is instead the `capabilities`-missing degrade path above).
    public var looksLikeCrowiHost: Bool {
        version != nil
    }

    /// Decode leniently: unknown extra keys are ignored (`JSONSerialization`
    /// already does this benignly), missing optional keys become `nil`, and
    /// a missing/malformed `capabilities` degrades to the static baseline
    /// rather than throwing.
    public static func decode(_ data: Data) throws -> AppInfoLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodeError.notAnObject
        }
        let rawCapabilities = object["capabilities"] as? [String]
        return AppInfoLenient(
            title: object["title"] as? String,
            confidential: object["confidential"] as? String,
            version: object["version"] as? String,
            apiVersion: object["apiVersion"] as? String,
            capabilities: rawCapabilities ?? StaticCapabilities.baseline,
            canSelfRegister: object["canSelfRegister"] as? Bool,
            capabilitiesAreBaselineFallback: rawCapabilities == nil
        )
    }

    public enum DecodeError: Error, Equatable {
        case notAnObject
        /// The HTTP response itself was not a 2xx — a distinct case from
        /// `notAnObject` so callers (the add-workspace flow) can tell
        /// "host unreachable / errored" apart from "host responded but the
        /// body isn't JSON we can read at all".
        case httpError(status: Int)
    }

    /// Fetch + decode `GET {apiBaseURL}/app/info` (§3 add-flow step 2 / §5.2
    /// refresh). Mirrors `OAuthDiscoveryDocument.fetch(workspaceOrigin:)`'s
    /// shape — the two are the app's only two "probe an unauthenticated
    /// endpoint before any per-workspace client exists" call sites.
    public static func fetch(apiBaseURL: APIBaseURL, urlSession: URLSession = .shared) async throws -> AppInfoLenient {
        let (data, response) = try await urlSession.data(from: apiBaseURL.appending("app/info"))
        guard response.isSuccessfulHTTPResponse else {
            throw DecodeError.httpError(status: response.httpStatusCodeOrUnknown)
        }
        return try decode(data)
    }
}
