import Foundation
import SwiftData

/// `feature-ios-phase1-read` — bundles everything a workspace's read UI
/// needs behind ONE object injected into the SwiftUI environment, built
/// through `WorkspaceContext`'s factories (`makeAppInfoCache()`/
/// `makeAPIClient()`/`makeImageCache()`/`makeModelContainer()`) — never
/// construct any of these ad hoc from a bare `Workspace` value in a view
/// (the reuse-target note this phase's context carries). `RootScene`
/// creates one per active workspace and re-creates it on every switch, so
/// switching workspaces always re-points every dependency at the newly
/// active workspace's own isolated state (§3/§14).
@MainActor
public final class WorkspaceSession: ObservableObject {
    public let context: WorkspaceContext
    public let appInfoCache: AppInfoCache
    public let apiClient: AuthenticatedAPIClient
    public let imageCache: WorkspaceImageDiskCache
    public let modelContainer: ModelContainer
    /// RFC-0016 §11 — this workspace's foreground notifications poller,
    /// built on the session's OWN `apiClient` (never a second client — one
    /// `RefreshCoordinator` behind every JSON call this session makes, so
    /// the poll and the screens can't race each other into a double
    /// refresh-token submission).
    public let notificationsPoller: NotificationsPoller

    /// `[]` / `nil` until the first `activated()`/`foregrounded()` call
    /// completes — the same conservative "unknown, not yet confirmed"
    /// default `AppInfoCache` itself uses.
    @Published public private(set) var capabilities: [String] = []
    @Published public private(set) var confidential: String?
    /// The unread-notifications badge (`GET /notifications/status` — the
    /// number of UNREAD rows), refreshed by the poll loop
    /// (`runNotificationsPolling()`), by `foregrounded()`, and after every
    /// notifications write (`markAllNotificationsRead`/`openNotification`).
    /// `0` (badge hidden) until the first successful poll.
    @Published public private(set) var unreadNotificationCount: Int = 0

    /// This workspace has no credential the app can read, so every request
    /// it makes will fail before reaching the network — the screens must
    /// offer a way back in rather than each reporting its own load failure.
    ///
    /// The case this exists for is not a normal expiry (a refresh token
    /// outlives any session): it is the Keychain ITEM becoming unreachable.
    /// Items are stored under an access group derived from the signing Team
    /// ID, so re-signing the app under a different team — moving from a
    /// personal team to the organization's, say — orphans every stored
    /// credential while the workspace list (plain `UserDefaults`) survives
    /// intact. The result reads as "the app is broken": every workspace is
    /// listed, none of them load.
    ///
    /// Checked at activation and foreground rather than on each request:
    /// a signing change only takes effect across a relaunch, and both of
    /// those run on the way in.
    @Published public private(set) var needsSignIn = false

    /// - Parameter urlSession: overridden only by tests (`WorkspaceSessionTests`)
    ///   to inject a mocked transport for the `AppInfoCache`/`AuthenticatedAPIClient`/
    ///   `WorkspaceImageDiskCache` this session builds — production callers
    ///   (`WorkspaceHomeView`'s `WorkspaceSessionHolder`) always take the
    ///   `.shared` default.
    public init(context: WorkspaceContext, models: [any PersistentModel.Type], schemaVersion: Int, urlSession: URLSession = .shared) throws {
        self.context = context
        self.appInfoCache = context.makeAppInfoCache(urlSession: urlSession)
        let apiClient = context.makeAPIClient(urlSession: urlSession)
        self.apiClient = apiClient
        self.notificationsPoller = NotificationsPoller(client: apiClient)
        self.imageCache = context.makeImageCache(urlSession: urlSession)
        self.modelContainer = try context.makeModelContainer(models: models, schemaVersion: schemaVersion)
    }

    /// The shared, `@MainActor`-bound context every read screen writes its
    /// cache upserts through — SwiftData's own recommended default context
    /// for direct UI use, never a freshly-constructed one per call.
    public var modelContext: ModelContext { modelContainer.mainContext }

    /// Call once when this workspace becomes the active one (§5.2 — always
    /// forces an `/app/info` refresh, never serves a possibly-stale cache).
    public func activated() async {
        refreshCredentialState()
        await refreshAppInfo { try await appInfoCache.activated() }
    }

    /// Call on app foreground (§5.2 — same as activation: always forces a
    /// refresh so a workspace that changed while backgrounded is reflected
    /// within this one refresh, not up to 10 minutes later). Also resumes
    /// the notifications poll (§11) and immediately re-polls, so a badge
    /// change that happened while backgrounded shows now, not up to one
    /// interval later.
    public func foregrounded() async {
        refreshCredentialState()
        await refreshAppInfo { try await appInfoCache.foregrounded() }
        await notificationsPoller.resume()
        await refreshUnreadNotificationCount()
    }

    /// Call on app background (§11) — suspends the notifications poll so no
    /// network requests fire while backgrounded. (`/app/info` needs no
    /// counterpart: it only ever fetches on activation/foreground/read.)
    public func backgrounded() async {
        await notificationsPoller.suspend()
    }

    /// The §11 foreground fixed-interval poll loop — run this from the
    /// workspace home's `.task` so it is STRUCTURALLY cancelled the moment
    /// the workspace view tears down (workspace switch / sign-out): a
    /// non-active workspace's poller can never keep running, the §14
    /// per-workspace isolation invariant applied to polling.
    public func runNotificationsPolling() async {
        await notificationsPoller.run { [weak self] count in
            self?.unreadNotificationCount = count
        }
    }

    /// One immediate `GET /notifications/status`, published to the badge. A
    /// failure (offline, 5xx) keeps the last known value — the poll loop
    /// retries on its own cadence.
    public func refreshUnreadNotificationCount() async {
        guard let count = try? await notificationsPoller.pollOnce() else { return }
        unreadNotificationCount = count
    }

    /// `POST /notifications/read` (UNREAD → UNOPENED in bulk — the badge
    /// zeroes; rows keep their unopened highlight, web parity) followed by a
    /// badge re-poll. Returns whether the server acknowledged the write.
    @discardableResult
    public func markAllNotificationsRead() async -> Bool {
        let acknowledged = (try? await NotificationsAPI.markAllRead(using: apiClient)) != nil
        await refreshUnreadNotificationCount()
        return acknowledged
    }

    /// `POST /notifications/{id}/open` — the tap path. A single-shot loose
    /// write with no conflict model (the `EngagementActions` discipline):
    /// failure is absorbed, because the caller navigates to the target page
    /// regardless. The badge re-polls either way (opening an UNREAD row
    /// decrements the unread count server-side).
    public func openNotification(id: String) async {
        _ = try? await NotificationsAPI.open(id: id, using: apiClient)
        await refreshUnreadNotificationCount()
    }

    /// Adopt a credential obtained by signing this workspace in again, and
    /// bring the session back up with it.
    public func signedIn(with pair: StoredTokenPair) async throws {
        try context.saveTokens(pair)
        await activated()
    }

    /// A read failure here (the Keychain refusing the item for any reason)
    /// counts as "no credential" — the screens behind it cannot work either
    /// way, and offering sign-in is the only useful thing to show.
    private func refreshCredentialState() {
        needsSignIn = (try? context.loadTokens()) == nil
    }

    private func refreshAppInfo(_ fetch: () async throws -> AppInfoLenient) async {
        guard let info = try? await fetch() else { return }
        capabilities = info.capabilities
        confidential = info.confidential
        // §6.3/§7.2 — escalate (or de-escalate) BOTH the image cache's and the
        // SwiftData store's rest-state protection the moment confidentiality
        // is (re)detected, not only at construction time. These are two
        // separate on-disk directories (`WorkspaceImageDiskCache` and
        // `context.makeModelContainer`'s store directory), so both calls are
        // required — one alone leaves the other directory behind at the
        // stale baseline protection level.
        await imageCache.applyConfidentialProtection(info.confidential != nil)
        context.applyConfidentialStorageProtection(info.confidential != nil)
    }
}
