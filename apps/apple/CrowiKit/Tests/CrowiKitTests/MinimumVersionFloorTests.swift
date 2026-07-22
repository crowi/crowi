import XCTest

@testable import CrowiKit

/// RFC-0016 §3 step 3 / §4.4 / OQ-6 — the minimum-version gate. OQ-6's
/// concrete floor VALUE is a placeholder (release-checklist's job); this
/// file pins the GATE LOGIC (semver precedence + the `ok`/`tooOld`/
/// `unparseable` trichotomy), which is a Phase 1 deliverable regardless of
/// what the placeholder string is.
final class MinimumVersionFloorTests: XCTestCase {
    func testHostAtExactlyTheFloorPasses() {
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: MinimumVersionFloor.floor), .ok)
    }

    func testHostAboveTheFloorPasses() {
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: "9.9.9", floor: "2.0.0"), .ok)
    }

    func testHostBelowTheFloorIsTooOld() {
        XCTAssertEqual(
            MinimumVersionFloor.evaluate(hostVersion: "1.9.0", floor: "2.0.0"),
            .tooOld(hostVersion: "1.9.0", floor: "2.0.0")
        )
    }

    func testPrereleaseHostBelowAPrereleaseFloorOrdersCorrectly() {
        // 2.0.0-alpha.1 < 2.0.0-alpha.7 < 2.0.0 (semver 2.0.0 §11 precedence).
        XCTAssertEqual(
            MinimumVersionFloor.evaluate(hostVersion: "2.0.0-alpha.1", floor: "2.0.0-alpha.7"),
            .tooOld(hostVersion: "2.0.0-alpha.1", floor: "2.0.0-alpha.7")
        )
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: "2.0.0-alpha.7", floor: "2.0.0-alpha.7"), .ok)
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: "2.0.0-alpha.9", floor: "2.0.0-alpha.7"), .ok)
    }

    func testPlainReleaseOutranksItsOwnPrerelease() {
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: "2.0.0", floor: "2.0.0-alpha.1"), .ok)
        XCTAssertEqual(
            MinimumVersionFloor.evaluate(hostVersion: "2.0.0-alpha.1", floor: "2.0.0"),
            .tooOld(hostVersion: "2.0.0-alpha.1", floor: "2.0.0")
        )
    }

    func testNilHostVersionIsUnparseable() {
        XCTAssertEqual(MinimumVersionFloor.evaluate(hostVersion: nil), .unparseable(hostVersion: ""))
    }

    func testGarbageHostVersionIsUnparseable() {
        XCTAssertEqual(
            MinimumVersionFloor.evaluate(hostVersion: "not-a-version", floor: "2.0.0"),
            .unparseable(hostVersion: "not-a-version")
        )
    }
}
