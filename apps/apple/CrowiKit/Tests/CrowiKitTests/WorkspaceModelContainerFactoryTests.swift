import SwiftData
import XCTest

@testable import CrowiKit

/// RFC-0016 §7.1/§7.3 — `WorkspaceModelContainerFactory`: per-workspace
/// physical isolation (distinct store files) and the drop-and-rebuild
/// schema-version reconciliation (a version bump drops the old store and
/// starts empty, rather than crashing on an un-migratable schema change).
@Model
private final class FixtureRecord {
    var value: String
    init(value: String) {
        self.value = value
    }
}

final class WorkspaceModelContainerFactoryTests: XCTestCase {
    private var baseDirectory: URL!

    override func setUp() {
        super.setUp()
        baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("crowikit-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseDirectory)
        super.tearDown()
    }

    /// Phase 1's actual runtime usage (`WorkspaceContext.makeModelContainer()`'s
    /// default) — no `@Model` types yet, the read spec adds them (§7.3 OQ).
    /// Pins that an empty `Schema` is a valid, buildable `ModelContainer`.
    func testMakeContainerSucceedsWithAnEmptySchema() throws {
        XCTAssertNoThrow(
            try WorkspaceModelContainerFactory.makeContainer(
                workspaceId: "workspace-empty-schema",
                models: [],
                schemaVersion: 1,
                baseDirectory: baseDirectory
            )
        )
    }

    func testMakeContainerCreatesAStoreFileOnDisk() throws {
        _ = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )

        let storeURL = WorkspaceModelContainerFactory.storeURL(workspaceId: "workspace-1", baseDirectory: baseDirectory)
        XCTAssertTrue(FileManager.default.fileExists(atPath: storeURL.path))
    }

    func testDataSurvivesReopeningWithTheSameSchemaVersion() throws {
        let container1 = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let context1 = ModelContext(container1)
        context1.insert(FixtureRecord(value: "persisted"))
        try context1.save()

        let container2 = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let context2 = ModelContext(container2)
        let records = try context2.fetch(FetchDescriptor<FixtureRecord>())

        XCTAssertEqual(records.map(\.value), ["persisted"])
    }

    /// §7.3's core invariant: a schema-version MISMATCH drops the old store
    /// (data loss is the accepted cost, per spec) and rebuilds empty —
    /// rather than the container init throwing/crashing.
    func testSchemaVersionMismatchDropsAndRebuildsEmpty() throws {
        let container1 = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let context1 = ModelContext(container1)
        context1.insert(FixtureRecord(value: "will-be-dropped"))
        try context1.save()

        let container2 = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 2,
            baseDirectory: baseDirectory
        )
        let context2 = ModelContext(container2)
        let records = try context2.fetch(FetchDescriptor<FixtureRecord>())

        XCTAssertTrue(records.isEmpty, "a schema-version bump must drop-and-rebuild, never carry stale rows forward")
    }

    func testDeleteWorkspaceDirectoryRemovesTheStoreAndMarker() throws {
        _ = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let directory = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))

        WorkspaceModelContainerFactory.deleteWorkspaceDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)

        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    /// §7.2's sign-out cache-deletion policy, ahead of Phase 2 actually
    /// populating this directory: any bytes a future disk-backed image
    /// cache writes under `imagesCacheDirectory` are nested inside
    /// `storeDirectory`, so `deleteWorkspaceDirectory` purges them for free.
    func testDeleteWorkspaceDirectoryAlsoRemovesTheImagesCacheDirectory() throws {
        _ = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let imagesDirectory = WorkspaceModelContainerFactory.imagesCacheDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)
        try FileManager.default.createDirectory(at: imagesDirectory, withIntermediateDirectories: true)
        let cachedImage = imagesDirectory.appendingPathComponent("cached-attachment.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: cachedImage)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cachedImage.path))

        WorkspaceModelContainerFactory.deleteWorkspaceDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)

        XCTAssertFalse(FileManager.default.fileExists(atPath: cachedImage.path))
    }

    /// The explicit counterpart the sign-out call site actually invokes
    /// (`WorkspaceStore.signOut`, `WorkspaceStoreTests.testSignOutPurgesThatWorkspacesImagesCacheDirectory`
    /// pins the end-to-end path): removes exactly the images cache
    /// directory, independent of whether `deleteWorkspaceDirectory` is also
    /// called.
    func testDeleteImagesCacheDirectoryRemovesOnlyTheImagesDirectory() throws {
        _ = try WorkspaceModelContainerFactory.makeContainer(
            workspaceId: "workspace-1",
            models: [FixtureRecord.self],
            schemaVersion: 1,
            baseDirectory: baseDirectory
        )
        let imagesDirectory = WorkspaceModelContainerFactory.imagesCacheDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)
        try FileManager.default.createDirectory(at: imagesDirectory, withIntermediateDirectories: true)
        let cachedImage = imagesDirectory.appendingPathComponent("cached-attachment.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: cachedImage)
        let storeURL = WorkspaceModelContainerFactory.storeURL(workspaceId: "workspace-1", baseDirectory: baseDirectory)

        WorkspaceModelContainerFactory.deleteImagesCacheDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)

        XCTAssertFalse(FileManager.default.fileExists(atPath: cachedImage.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: imagesDirectory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: storeURL.path), "must not touch the SwiftData store itself")
    }

    func testDeletingOneWorkspaceDirectoryLeavesAnotherIntact() throws {
        _ = try WorkspaceModelContainerFactory.makeContainer(workspaceId: "workspace-1", models: [FixtureRecord.self], schemaVersion: 1, baseDirectory: baseDirectory)
        _ = try WorkspaceModelContainerFactory.makeContainer(workspaceId: "workspace-2", models: [FixtureRecord.self], schemaVersion: 1, baseDirectory: baseDirectory)

        WorkspaceModelContainerFactory.deleteWorkspaceDirectory(workspaceId: "workspace-1", baseDirectory: baseDirectory)

        let directory2 = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "workspace-2", baseDirectory: baseDirectory)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory2.path))
    }
}
