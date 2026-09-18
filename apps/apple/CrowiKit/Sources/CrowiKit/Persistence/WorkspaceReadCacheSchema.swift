import SwiftData

/// `feature-ios-phase1-read` — the full list of this phase's `@Model`
/// read-cache types, plus the bumped schema version. Phase 1 deliberately
/// left `WorkspaceModelContainerFactory`/`SchemaVersionMarker` on an EMPTY
/// schema (its own openQuestion flagged bumping this as mandatory when real
/// `@Model` types were added, §7.3) — this is that bump. Any installed build
/// whose store was ever opened at the old (empty) schema version drops and
/// rebuilds on next launch, per §7.3's no-migration-plan policy, rather than
/// launch-crashing.
public enum WorkspaceReadCacheSchema {
    /// Bumped to 3 when `CachedRevisionSummary`'s stored shape changed from
    /// the meta-only revisions list to the RFC-0021 merged timeline — an old
    /// store's `CachedRevisionSummary` rows would otherwise decode to `[]`
    /// forever rather than repopulating, since nothing else ever bumps this
    /// marker for them. Drop-and-rebuild (§7.3) instead.
    ///
    /// Bumped to 4 when `CachedPage` gained `contentType` (RFC-0020): an old
    /// row would otherwise cold-paint an artifact page's HTML source as
    /// Markdown until the network read replaced it.
    public static let schemaVersion = 4

    public static let models: [any PersistentModel.Type] = [
        CachedPage.self,
        CachedPageChildren.self,
        CachedBacklink.self,
        CachedComment.self,
        CachedRevisionSummary.self,
        CachedSearchResult.self,
    ]
}
