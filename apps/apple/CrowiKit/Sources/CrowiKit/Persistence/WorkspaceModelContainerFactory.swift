import Foundation
import SwiftData

/// RFC-0016 §7.1/§7.2/§7.3 — builds a per-workspace `ModelContainer` backed
/// by its own store file at `Application Support/workspaces/<id>/crowi.store`
/// (physical cache isolation, §7.1: no shared table a query could
/// accidentally cross), with the §7.2 rest-state protections
/// (`NSFileProtection` baseline + backup exclusion) and the §7.3
/// drop-and-rebuild schema-version reconciliation applied before the
/// container is ever opened.
public enum WorkspaceModelContainerFactory {
    public enum FactoryError: Error {
        case directoryCreationFailed(underlying: Error)
        case containerCreationFailed(underlying: Error)
    }

    /// This app's `Application Support` directory, resolved once per call so
    /// tests can redirect it to a scratch directory — production callers
    /// never override this.
    public static func defaultBaseDirectory(fileManager: FileManager = .default) -> URL {
        (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fileManager.temporaryDirectory
    }

    /// The per-workspace directory (`.../workspaces/<id>/`) — everything
    /// that workspace owns on disk (the store, its WAL/SHM siblings, and the
    /// out-of-store schema marker) lives here, so deleting this ONE
    /// directory (§4.2/§14 sign-out) can never touch another workspace's.
    public static func storeDirectory(workspaceId: String, baseDirectory: URL) -> URL {
        baseDirectory.appendingPathComponent("workspaces", isDirectory: true).appendingPathComponent(workspaceId, isDirectory: true)
    }

    public static func storeURL(workspaceId: String, baseDirectory: URL) -> URL {
        storeDirectory(workspaceId: workspaceId, baseDirectory: baseDirectory).appendingPathComponent("crowi.store")
    }

    /// Where this workspace's disk-backed image cache MUST live (§7.2) —
    /// reserved now so a future disk cache (`feature-ios-phase1-read`, which
    /// actually wires up `WorkspaceImageLoader`'s persistence) inherits
    /// automatic sign-out purge for free: it is nested INSIDE
    /// `storeDirectory`, so `deleteWorkspaceDirectory` already removes it
    /// along with the SwiftData store. Nothing writes here yet in Phase 1 —
    /// `testDeleteWorkspaceDirectoryAlsoRemovesTheImagesCacheDirectory` pins
    /// the purge guarantee ahead of that code existing.
    public static func imagesCacheDirectory(workspaceId: String, baseDirectory: URL) -> URL {
        storeDirectory(workspaceId: workspaceId, baseDirectory: baseDirectory).appendingPathComponent("images", isDirectory: true)
    }

    /// Build (or re-open) `workspaceId`'s `ModelContainer`.
    ///
    /// - Parameters:
    ///   - models: the workspace's `@Model` types. Phase 1 has none yet — an
    ///     empty schema, per the Phase 1 spec's explicit "read spec adds the
    ///     real `@Model` types" note (§7.3 OQ).
    ///   - schemaVersion: bumped by whichever spec adds/changes `@Model`
    ///     types (§7.3) — a mismatch against the persisted marker drops and
    ///     rebuilds the store empty (never a `SchemaMigrationPlan`, per §7.3's
    ///     explicit no-migration-plan policy) rather than crashing.
    ///   - baseDirectory: overridden only by tests (never production code).
    public static func makeContainer(
        workspaceId: String,
        models: [any PersistentModel.Type] = [],
        schemaVersion: Int,
        baseDirectory: URL = defaultBaseDirectory(),
        fileManager: FileManager = .default
    ) throws -> ModelContainer {
        let directory = storeDirectory(workspaceId: workspaceId, baseDirectory: baseDirectory)
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw FactoryError.directoryCreationFailed(underlying: error)
        }

        if SchemaVersionMarker.reconcile(inDirectory: directory, currentVersion: schemaVersion, fileManager: fileManager) {
            deleteStoreFiles(at: storeURL(workspaceId: workspaceId, baseDirectory: baseDirectory), fileManager: fileManager)
        }

        applyRestStateProtections(directory: directory)

        let configuration = ModelConfiguration(url: storeURL(workspaceId: workspaceId, baseDirectory: baseDirectory))
        do {
            return try ModelContainer(for: Schema(models), configurations: [configuration])
        } catch {
            throw FactoryError.containerCreationFailed(underlying: error)
        }
    }

    /// Deletes a workspace's entire on-disk directory (store + WAL/SHM + the
    /// schema marker + the images cache — `imagesCacheDirectory` is nested
    /// inside this directory, so removing it removes that too). The §7.2/§14
    /// sign-out cache-deletion policy. Never affects any other workspace's
    /// directory.
    public static func deleteWorkspaceDirectory(workspaceId: String, baseDirectory: URL = defaultBaseDirectory(), fileManager: FileManager = .default) {
        try? fileManager.removeItem(at: storeDirectory(workspaceId: workspaceId, baseDirectory: baseDirectory))
    }

    /// Deletes exactly a workspace's on-disk **image cache** directory —
    /// called out as its own explicit step (not merely relied upon as a side
    /// effect of `deleteWorkspaceDirectory`'s nesting) so the sign-out
    /// contract's four distinct parts — revoke, Keychain purge, ModelContainer
    /// purge, image-cache purge (§3/§7.2/§14) — are each visible as their own
    /// call at the sign-out call site (`WorkspaceStore.signOut`). Safe to call
    /// even when nothing has ever been written there yet (Phase 1 has no
    /// disk-backed image cache writer; `feature-ios-phase1-read` adds one and
    /// inherits this purge for free, no new wiring needed). Idempotent with
    /// `deleteWorkspaceDirectory` — removing the same nested directory twice
    /// (or an already-absent one) is a no-op, never an error.
    public static func deleteImagesCacheDirectory(workspaceId: String, baseDirectory: URL = defaultBaseDirectory(), fileManager: FileManager = .default) {
        try? fileManager.removeItem(at: imagesCacheDirectory(workspaceId: workspaceId, baseDirectory: baseDirectory))
    }

    private static func deleteStoreFiles(at storeURL: URL, fileManager: FileManager) {
        let lastComponent = storeURL.lastPathComponent
        let directory = storeURL.deletingLastPathComponent()
        // SQLite's WAL-mode siblings — best-effort removal (a `-wal`/`-shm`
        // may legitimately not exist, e.g. on the very first run).
        for suffix in ["", "-wal", "-shm"] {
            try? fileManager.removeItem(at: directory.appendingPathComponent(lastComponent + suffix))
        }
    }

    /// §7.2 rest-state protections: `isExcludedFromBackup` (cross-platform)
    /// always; `NSFileProtection` is iOS/tvOS/watchOS-only (absent from the
    /// macOS SDK entirely), so it is isolated behind `#if os(iOS)` — the §9
    /// platform-conditional idiom-delta rule, applied here rather than
    /// bolted on later.
    private static func applyRestStateProtections(directory: URL) {
        var directoryURL = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directoryURL.setResourceValues(values)

        #if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        #endif
    }
}
