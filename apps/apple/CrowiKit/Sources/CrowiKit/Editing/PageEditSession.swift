import Foundation

/// What one `save(body:)` attempt resolved to — returned (not only stored in
/// `state`) so the editor view can react deterministically per attempt.
public enum PageEditSaveOutcome: Sendable, Equatable {
    case saved(PageLenient)
    /// HTTP `409` (`PAGE_REVISION_ERROR`): the page moved under us.
    /// `latest` is the freshly re-fetched current detail. `nil` only when
    /// the re-fetch was ANSWERED but unusable (an HTTP-level denial — e.g.
    /// the grant tightened concurrently — or an undecodable body): re-apply
    /// is then unavailable and discard is the only resolution. A TRANSPORT
    /// failure during the re-fetch never lands here — `save` throws instead
    /// (§7.4 fail-fast, manual retry).
    case conflict(latest: PageLenient?)
    /// Any other non-2xx response, or `save` called outside the `.editing`
    /// state (a pending conflict MUST be resolved explicitly first — there
    /// is no path that silently retries over it).
    case failed(message: String?)
}

/// RFC-0016 §8 / `feature-ios-phase2-write` — the CLIENT-enforced optimistic
/// lock for quick-edit. The server's `UpdatePageRequestSchema.revision_id`
/// is optional and only checked WHEN PRESENT (`page.ts` — omission silently
/// overwrites), so the lock discipline lives entirely here:
///
///   - **Constructible only from a detail `GET`** whose `revision` is the
///     full object variant carrying `body` (`init?` refuses a bare-string
///     revision — a list/children/portal row is never a valid lock base, §8).
///   - **`save()` is the sole `PUT /pages` construction path** in the app,
///     and its private `UpdatePageBody` carries `revision_id` as a
///     NON-OPTIONAL stored property — a `revision_id`-less PUT is
///     unconstructible by type (§10 CI-fixed invariant;
///     `PageEditSessionTests` additionally pins it at the wire level).
///   - **`grant` is never sent**: the server preserves the page's current
///     grant when the field is omitted; sending it is the grant-CHANGE path,
///     which is outside this phase's bounded-write scope.
///
/// Conflict stance mirrors `crowi edit` (the CLI): HTTP `409` → re-fetch the
/// current revision → the user chooses "discard" (the DEFAULT) or "re-apply",
/// where re-apply means swapping the lock base to the re-fetched revision
/// while KEEPING the user's edited text for an explicit second save — never
/// an automatic merge, never a silent overwrite.
@MainActor
public final class PageEditSession {
    public enum State: Sendable, Equatable {
        case editing
        case saving
        /// A `409` happened; `latest` is the re-fetched current detail
        /// (see `PageEditSaveOutcome.conflict`). Discard is the default
        /// resolution; `save` refuses to run until resolved.
        case conflict(latest: PageLenient?)
        case saved(PageLenient)
        /// Terminal: the user chose to discard their edits (the conflict
        /// default). The editor closes; nothing was written.
        case discarded
    }

    public let pageId: String
    /// The optimistic-lock base — the detail revision the editor was seeded
    /// from, replaced only by an explicit `reapplyOnLatest()`.
    public private(set) var baseRevisionId: String
    /// The body text the editor starts from (the lock base's own body).
    public let seedBody: String
    public private(set) var state: State = .editing

    private let client: AuthenticatedAPIClient

    /// Fails (returns `nil`) unless `detail` carries the full object-variant
    /// revision WITH `body` — the only response shape that can seed a lock.
    public init?(detail: GetPageResponseLenient, client: AuthenticatedAPIClient) {
        guard let revision = detail.page.revision, let revisionId = revision.id, let seedBody = revision.body else {
            return nil
        }
        self.pageId = detail.page.id
        self.baseRevisionId = revisionId
        self.seedBody = seedBody
        self.client = client
    }

    /// The `PUT /pages` body. `revisionId` is deliberately NON-optional —
    /// the §10 invariant that a `revision_id`-less PUT cannot be built.
    /// No `grant` property exists at all (omitting the field preserves the
    /// page's current grant server-side).
    private struct UpdatePageBody: Encodable {
        let pageId: String
        let body: String
        let revisionId: String

        enum CodingKeys: String, CodingKey {
            case pageId = "page_id"
            case body
            case revisionId = "revision_id"
        }
    }

    /// Save the edited body against the current lock base. Throws only on a
    /// transport failure — anywhere in the attempt, INCLUDING the conflict
    /// re-fetch (§7.4 fail-fast: the state returns to `.editing` so the
    /// user can retry manually; a retried save replays the whole attempt);
    /// every HTTP-answered result is a returned outcome. Status `409` is
    /// the conflict signal (primary — the `PAGE_REVISION_ERROR` code is
    /// confirmation only and the decode stays lenient).
    @discardableResult
    public func save(body: String) async throws -> PageEditSaveOutcome {
        guard state == .editing else {
            return .failed(message: nil)
        }
        state = .saving
        do {
            let (data, status) = try await client.put("pages", json: UpdatePageBody(pageId: pageId, body: body, revisionId: baseRevisionId))
            if status.isSuccessfulHTTPStatus {
                let page = try GetPageResponseLenient.decode(data).page
                state = .saved(page)
                return .saved(page)
            }
            if status == 409 {
                // The conflict itself is confirmed (the PUT was answered),
                // but the current-revision re-fetch can still fail two
                // DIFFERENT ways that must not be conflated: an ANSWERED
                // failure (`PageLenientDecodeError` — an HTTP denial such
                // as a concurrently-tightened grant, or an undecodable
                // body) degrades to a discard-only conflict, while a
                // TRANSPORT failure (offline/DNS `URLError`) falls through
                // to the outer catch and THROWS with the state back at
                // `.editing` — a manual save retry replays the PUT, hits
                // the 409 again, and re-attempts the re-fetch.
                do {
                    let latest = try await GetPageResponseLenient.fetch(pageId: pageId, using: client)
                    state = .conflict(latest: latest.page)
                    return .conflict(latest: latest.page)
                } catch is PageLenientDecodeError {
                    state = .conflict(latest: nil)
                    return .conflict(latest: nil)
                }
            }
            let envelope = APIErrorEnvelopeLenient.decode(data)
            state = .editing
            return .failed(message: envelope.message)
        } catch {
            state = .editing
            throw error
        }
    }

    /// Conflict resolution: swap the lock base to the re-fetched latest
    /// revision and return to `.editing` — the user's edited text stays in
    /// the editor for an explicit second save. Returns `false` (and stays
    /// in `.conflict`) when there is no usable latest revision to re-apply
    /// onto (the conflict re-fetch was answered but unusable).
    @discardableResult
    public func reapplyOnLatest() -> Bool {
        guard case .conflict(let latest) = state, let newBase = latest?.revision?.id else {
            return false
        }
        baseRevisionId = newBase
        state = .editing
        return true
    }

    /// Conflict resolution DEFAULT: abandon the edit. Terminal — nothing
    /// was (or will be) written.
    ///
    /// Returns the conflict's already-re-fetched `latest` detail — the OTHER
    /// person's newer revision, body included — so the caller can ADOPT it.
    /// Discarding means their version wins, so a reader that keeps showing
    /// the pre-edit body it painted before the edit is simply wrong (reported
    /// 2026-07-25: after Discard the reader still showed the old content).
    /// The conflict path already paid for this GET (`save`'s 409 branch), so
    /// adopting it costs no extra request. `nil` when there is nothing to
    /// adopt: the re-fetch was answered but unusable, or the state was not a
    /// conflict at all.
    @discardableResult
    public func discardConflict() -> PageLenient? {
        guard case .conflict(let latest) = state else { return nil }
        state = .discarded
        return latest
    }
}
