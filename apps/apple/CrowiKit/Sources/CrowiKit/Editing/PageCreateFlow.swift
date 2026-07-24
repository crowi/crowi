import Foundation

/// The UX state a `POST /pages` attempt lands in — RFC-0016 §8's "4 種の
/// `400` を個別 UX で受ける": each server error code is a DISTINCT state
/// with its own affordance, never one generic failure alert.
public enum PageCreateOutcome: Sendable, Equatable {
    /// Created — the same `{ page }` envelope a detail `GET` returns, so the
    /// caller can upsert `CachedPage` and navigate without a refetch.
    case created(PageLenient)
    /// `PAGE_EXISTS` and the immediate follow-up open SUCCEEDED — the
    /// existing page is really openable, so the UI may offer "open it".
    case pageExists(existing: PageLenient)
    /// `PAGE_EXISTS` but the follow-up open failed (404 / denied): the
    /// server deliberately collapses not-granted pages into the same code
    /// (`page.ts` — "a stricter-grant race we must not leak"), so the app
    /// must NEVER promise the page is openable — this degrades to "that
    /// path is taken, choose another".
    case pathTaken
    /// `PAGE_TWIN_EXISTS` — the `/x` ↔ `/x/` trailing-slash twin guard.
    /// `twinPath` is derived CLIENT-side by toggling the attempted path's
    /// trailing slash (the response carries the twin path only inside its
    /// human-readable English message — never parse prose).
    case twinExists(twinPath: String)
    /// `NON_EXISTENT_USER_PAGE` — creating under `/user/<name>/...` for a
    /// user page that doesn't exist; gets its own explanation, not a
    /// generic error (spec pin).
    case nonExistentUserPage
    /// Residual `PAGE_CREATE_FAILED` (or any unknown code — lenient
    /// degrade): generic failure display.
    case createFailed(message: String?)
}

/// RFC-0016 §8 / `feature-ios-phase2-write` — the create-page flow:
/// `POST /pages` through the workspace's own `AuthenticatedAPIClient`
/// (`session.apiClient` — the phase-1 structural per-workspace isolation
/// invariant applies to writes too), typed into `PageCreateOutcome`.
///
/// Offline behavior is §7.4's fail-fast: a transport failure (`URLError`)
/// THROWS out of `create` — no offline queue, no background retry; the UI
/// keeps the in-memory form state and offers a manual retry.
public struct PageCreateFlow: Sendable {
    private let client: AuthenticatedAPIClient

    public init(client: AuthenticatedAPIClient) {
        self.client = client
    }

    /// Attempt to create a page. `grant: nil` omits the field entirely so
    /// the server applies its default (public).
    public func create(path: String, body: String, grant: PageGrantOption?) async throws -> PageCreateOutcome {
        try await create(path: Self.normalizedPath(path), body: body, grantValue: grant?.rawValue, isInvalidGrantRetry: false)
    }

    /// The `POST /pages` body (`CreatePageRequestSchema`). `grant` is
    /// optional — the synthesized `Encodable` conformance omits a `nil`
    /// optional entirely (`encodeIfPresent`), which is what "use the server
    /// default" means on the wire.
    private struct CreatePageBody: Encodable {
        let path: String
        let body: String
        let grant: Int?
    }

    private func create(path: String, body: String, grantValue: Int?, isInvalidGrantRetry: Bool) async throws -> PageCreateOutcome {
        let (data, status) = try await client.post("pages", json: CreatePageBody(path: path, body: body, grant: grantValue))
        if status.isSuccessfulHTTPStatus {
            let page = try GetPageResponseLenient.decode(data).page
            return .created(page)
        }
        let envelope = APIErrorEnvelopeLenient.decode(data)
        switch envelope.code {
        case "PAGE_EXISTS":
            // Follow-up open, attempted IMMEDIATELY on receipt (task
            // openQuestion resolved: probing now lets the alert itself say
            // the right thing, instead of a promising "open" affordance
            // that only fails after the user taps it). ONLY an HTTP-level
            // failure — the 404/denied grant-secrecy collapse — degrades to
            // `.pathTaken`: the server actually answered, so "that path is
            // taken and we won't promise it opens" is the truthful state.
            // A TRANSPORT failure (offline/DNS `URLError`) propagates
            // instead, §7.4 fail-fast: connectivity loss must surface as
            // the retryable error it is, never be absorbed into a UX state.
            // (A decode failure on a 2xx follow-up also propagates, exactly
            // like the create-success decode above.)
            do {
                let existing = try await GetPageResponseLenient.fetch(path: path, using: client)
                return .pageExists(existing: existing.page)
            } catch PageLenientDecodeError.httpError {
                return .pathTaken
            }
        case "PAGE_TWIN_EXISTS":
            return .twinExists(twinPath: Self.twinPath(of: path))
        case "NON_EXISTENT_USER_PAGE":
            return .nonExistentUserPage
        case "INVALID_GRANT" where !isInvalidGrantRetry:
            // Structurally unreachable while the picker emits only
            // `PageGrantOption` values — but if a future server tightens
            // the set, fall back to the default grant exactly once
            // (spec: "万一受けたら既定 grant に fallback").
            return try await create(path: path, body: body, grantValue: nil, isInvalidGrantRetry: true)
        default:
            return .createFailed(message: envelope.message)
        }
    }

    /// The `/x` ↔ `/x/` twin of an attempted (normalized) path — mirrors
    /// what the server's `Page.findExistingTwin` checked, without parsing
    /// the human-readable message the response buries the path in.
    static func twinPath(of path: String) -> String {
        path.hasSuffix("/") ? String(path.dropLast()) : path + "/"
    }

    /// Minimal client-side normalization (trim + ensure a leading `/`) so
    /// the twin derivation and the follow-up open see the same path shape
    /// the server's own `normalizePath` will produce for it.
    static func normalizedPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("/") ? trimmed : "/" + trimmed
    }
}
