import Foundation

/// RFC-0016 §3 / OQ-2 pin — the **non-secret** ordered workspace index:
/// `{ id, workspaceOrigin, displayTitle }` only, **never** a token. OQ-2 pins
/// this to standard `UserDefaults` for v1 (a share-extension / widget would
/// need an app-group suite — that migration is that future feature's own
/// spec's job, not this one's).
///
/// This is deliberately the ONLY place workspace identity is persisted
/// outside the Keychain — the §10/§14 CI-fixed "no secret in UserDefaults"
/// invariant is provable by construction here: `WorkspaceIndexEntry` has no
/// token field to accidentally serialize.
public struct WorkspaceIndexEntry: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let workspaceOriginString: String
    public let displayTitle: String

    public init(id: String, workspaceOriginString: String, displayTitle: String) {
        self.id = id
        self.workspaceOriginString = workspaceOriginString
        self.displayTitle = displayTitle
    }

    /// `nil` only if a corrupted/hand-edited default ever stored a
    /// non-URL string — `WorkspaceIndexStore` skips such an entry rather
    /// than crashing the whole index load.
    public var workspaceOrigin: WorkspaceOrigin? {
        URL(string: workspaceOriginString).map(WorkspaceOrigin.init)
    }
}

/// `@unchecked Sendable`: `UserDefaults` itself is not (yet) formally
/// `Sendable`-annotated even though it is documented thread-safe (KVO caveats
/// aside) — this type only ever calls it via its own thread-safe API
/// (`.data(forKey:)`/`.set(_:forKey:)`), never mutating shared Swift state
/// across threads itself.
public final class WorkspaceIndexStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    /// - Parameters:
    ///   - defaults: standard suite by default (OQ-2); inject `.init(suiteName:)`
    ///     only for test isolation.
    ///   - key: overridable so parallel test cases never collide on the same
    ///     real `UserDefaults` key.
    public init(defaults: UserDefaults = .standard, key: String = "wiki.crowi.ios.workspaceIndex") {
        self.defaults = defaults
        self.key = key
    }

    /// The ordered list, in the order workspaces were added (or last
    /// reordered by `reorder(to:)`) — the order the Slack-style switcher
    /// renders.
    public func loadAll() -> [WorkspaceIndexEntry] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([WorkspaceIndexEntry].self, from: data)) ?? []
    }

    /// Appends `entry` (or replaces the existing entry with the same `id`,
    /// preserving its position — an add-workspace retry after a partial
    /// failure must not duplicate the row).
    public func upsert(_ entry: WorkspaceIndexEntry) {
        var all = loadAll()
        if let index = all.firstIndex(where: { $0.id == entry.id }) {
            all[index] = entry
        } else {
            all.append(entry)
        }
        persist(all)
    }

    public func remove(id: String) {
        persist(loadAll().filter { $0.id != id })
    }

    /// Replaces the whole ordering — the switcher's drag-to-reorder writes
    /// through here. `newOrder` must be a permutation of the existing ids;
    /// any id it omits is dropped (a defensive no-op path, not expected in
    /// practice) and any id it doesn't recognize is ignored.
    public func reorder(to newOrder: [String]) {
        let all = loadAll()
        let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        persist(newOrder.compactMap { byId[$0] })
    }

    private func persist(_ entries: [WorkspaceIndexEntry]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: key)
    }
}
