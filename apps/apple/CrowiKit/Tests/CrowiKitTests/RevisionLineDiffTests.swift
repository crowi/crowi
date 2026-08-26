import XCTest

@testable import CrowiKit

final class RevisionLineDiffTests: XCTestCase {
    func testIdenticalBodiesProduceOnlyUnchangedRows() {
        let rows = RevisionLineDiff.compute(from: "a\nb\nc", to: "a\nb\nc")

        XCTAssertEqual(rows.map(\.kind), [.unchanged, .unchanged, .unchanged])
        XCTAssertEqual(rows.map(\.text), ["a", "b", "c"])
    }

    func testEmptyOldBodyIsAllAdded() {
        let rows = RevisionLineDiff.compute(from: "", to: "a\nb")

        // An empty string splits into one empty line, which is itself
        // removed — the real content ("a", "b") is all added.
        XCTAssertEqual(rows.filter { $0.kind == .added }.map(\.text), ["a", "b"])
        XCTAssertTrue(rows.contains { $0.kind == .removed })
    }

    func testEmptyNewBodyIsAllRemoved() {
        let rows = RevisionLineDiff.compute(from: "a\nb", to: "")

        XCTAssertEqual(rows.filter { $0.kind == .removed }.map(\.text), ["a", "b"])
        XCTAssertTrue(rows.contains { $0.kind == .added })
    }

    func testEveryLineChangedProducesNoUnchangedRows() {
        let rows = RevisionLineDiff.compute(from: "a\nb", to: "x\ny")

        XCTAssertFalse(rows.contains { $0.kind == .unchanged })
        XCTAssertEqual(rows.filter { $0.kind == .removed }.map(\.text), ["a", "b"])
        XCTAssertEqual(rows.filter { $0.kind == .added }.map(\.text), ["x", "y"])
    }

    /// A single line changed in the middle: the unified reconstruction must
    /// keep the untouched lines in place and slot the removed/added pair
    /// between them, in reading order.
    func testAOneLineChangeInTheMiddleKeepsSurroundingContextInOrder() {
        let rows = RevisionLineDiff.compute(from: "a\nb\nc", to: "a\nx\nc")

        XCTAssertEqual(rows.map(\.kind), [.unchanged, .removed, .added, .unchanged])
        XCTAssertEqual(rows.map(\.text), ["a", "b", "x", "c"])
    }

    func testAppendingALineAtTheEndIsPureAddition() {
        let rows = RevisionLineDiff.compute(from: "a\nb", to: "a\nb\nc")

        XCTAssertEqual(rows.map(\.kind), [.unchanged, .unchanged, .added])
        XCTAssertEqual(rows.map(\.text), ["a", "b", "c"])
    }
}
