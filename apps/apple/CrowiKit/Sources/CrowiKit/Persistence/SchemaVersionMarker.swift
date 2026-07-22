import Foundation

/// RFC-0016 §7.3 — schema versioning is **drop-and-rebuild**, never a
/// `SchemaMigrationPlan`: because the SwiftData cache is best-effort (§7.2),
/// v1 does not write migration plans. A small marker, persisted **outside**
/// the SwiftData store itself, records the schema version the store on disk
/// was last built with; a mismatch at launch means "drop the store file and
/// rebuild it empty, then let normal reads repopulate it" rather than
/// crashing on an un-migratable schema change.
///
/// Phase 1 has no read-side `@Model` types yet (§7.1 note in the Phase 1
/// spec's architecturalNotes — this plumbing exists now so
/// `feature-ios-phase1-read` only has to add `@Model` types and bump the
/// version it passes in, never re-plumb the container/drop-and-rebuild
/// machinery).
enum SchemaVersionMarker {
    private struct Marker: Codable {
        let schemaVersion: Int
    }

    static func markerURL(inDirectory directory: URL) -> URL {
        directory.appendingPathComponent("schema-version.json")
    }

    /// Compares the persisted marker (if any) against `currentVersion`. If
    /// they differ — including "no marker exists yet", the first-ever run
    /// for this workspace — the marker is rewritten to `currentVersion` and
    /// `true` is returned so the caller knows to drop any stale store files
    /// (§7.3) before opening the `ModelContainer`.
    @discardableResult
    static func reconcile(inDirectory directory: URL, currentVersion: Int, fileManager: FileManager = .default) -> Bool {
        let url = markerURL(inDirectory: directory)
        let previousVersion = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Marker.self, from: $0) }?.schemaVersion
        let mismatched = previousVersion != currentVersion
        if mismatched, let data = try? JSONEncoder().encode(Marker(schemaVersion: currentVersion)) {
            try? data.write(to: url, options: .atomic)
        }
        return mismatched
    }
}
