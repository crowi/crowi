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
    public static let schemaVersion = 2

    public static let models: [any PersistentModel.Type] = [
        CachedPage.self,
        CachedPageChildren.self,
        CachedBacklink.self,
        CachedComment.self,
        CachedRevisionSummary.self,
        CachedSearchResult.self,
    ]
}
