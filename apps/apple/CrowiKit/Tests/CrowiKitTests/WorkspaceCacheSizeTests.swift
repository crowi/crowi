import XCTest

@testable import CrowiKit

final class WorkspaceCacheSizeTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    func testAWorkspaceWithNothingOnDiskMeasuresZero() {
        XCTAssertEqual(WorkspaceModelContainerFactory.directorySizeInBytes(workspaceId: "ws", baseDirectory: base), 0)
    }

    func testItCountsTheImageCacheNestedInsideTheStore() throws {
        let images = WorkspaceModelContainerFactory.imagesCacheDirectory(workspaceId: "ws", baseDirectory: base)
        try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
        try Data(repeating: 0, count: 40_000).write(to: images.appendingPathComponent("a.bin"))

        let store = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "ws", baseDirectory: base)
        try Data(repeating: 0, count: 40_000).write(to: store.appendingPathComponent("b.bin"))

        // Allocated size rounds up to whole blocks, so assert the floor rather
        // than an exact figure — the point is that BOTH files are counted.
        let measured = WorkspaceModelContainerFactory.directorySizeInBytes(workspaceId: "ws", baseDirectory: base)
        XCTAssertGreaterThanOrEqual(measured, 80_000)
    }

    func testOneWorkspaceNeverMeasuresAnother() throws {
        let mine = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "mine", baseDirectory: base)
        try FileManager.default.createDirectory(at: mine, withIntermediateDirectories: true)
        try Data(repeating: 0, count: 10_000).write(to: mine.appendingPathComponent("a.bin"))

        let theirs = WorkspaceModelContainerFactory.storeDirectory(workspaceId: "theirs", baseDirectory: base)
        try FileManager.default.createDirectory(at: theirs, withIntermediateDirectories: true)
        try Data(repeating: 0, count: 999_000).write(to: theirs.appendingPathComponent("b.bin"))

        let measured = WorkspaceModelContainerFactory.directorySizeInBytes(workspaceId: "mine", baseDirectory: base)
        XCTAssertLessThan(measured, 500_000, "the other workspace's cache must not be in this number")
    }
}
