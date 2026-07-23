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

    /// `[]` / `nil` until the first `activated()`/`foregrounded()` call
    /// completes — the same conservative "unknown, not yet confirmed"
    /// default `AppInfoCache` itself uses.
    @Published public private(set) var capabilities: [String] = []
    @Published public private(set) var confidential: String?

    /// - Parameter urlSession: overridden only by tests (`WorkspaceSessionTests`)
    ///   to inject a mocked transport for the `AppInfoCache`/`AuthenticatedAPIClient`/
    ///   `WorkspaceImageDiskCache` this session builds — production callers
    ///   (`WorkspaceHomeView`'s `WorkspaceSessionHolder`) always take the
    ///   `.shared` default.
    public init(context: WorkspaceContext, models: [any PersistentModel.Type], schemaVersion: Int, urlSession: URLSession = .shared) throws {
        self.context = context
        self.appInfoCache = context.makeAppInfoCache(urlSession: urlSession)
        self.apiClient = context.makeAPIClient(urlSession: urlSession)
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
        await refreshAppInfo { try await appInfoCache.activated() }
    }

    /// Call on app foreground (§5.2 — same as activation: always forces a
    /// refresh so a workspace that changed while backgrounded is reflected
    /// within this one refresh, not up to 10 minutes later).
    public func foregrounded() async {
        await refreshAppInfo { try await appInfoCache.foregrounded() }
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
