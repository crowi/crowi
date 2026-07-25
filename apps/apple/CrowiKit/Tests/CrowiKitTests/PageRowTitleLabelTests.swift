import Foundation
import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// feature-ios-page-display-name — the drift guard for the Swift port of the
/// web's `pageDisplayName` / `pageDisplayParent`
/// (`packages/web/src/lib/page-path.ts:96-134`).
///
/// The expectation table is NOT written out here: it is read from
/// `packages/web/src/lib/__fixtures__/page-display-name.json`, the same file
/// `packages/web/src/lib/page-path.test.ts` asserts against. That is the whole
/// point — one table, two languages, so changing the rule on one side without
/// the other turns red instead of silently diverging.
///
/// Reading it means these cases only run where the repository source tree
/// exists, i.e. `swift test` on the host mac (the Apple island's objective
/// gate, `apps/apple/README.md` §"Objective gate commands"). If the suite is
/// ever moved onto a simulator/device — where `#filePath` points at a machine
/// the bundle can no longer see — the table has to be copied in as a test
/// resource; the failure below says so rather than silently skipping.
///
/// The last section additionally MEASURES the real SwiftUI layout at a
/// compact-ish (iPhone) and a regular-ish (iPad) row width — the objective
/// half of "co-exists with the row metadata without breaking the layout"
/// (`xcodebuild build` proves nothing visual), following
/// `SearchCapabilityToolbarButtonTests`' `ImageRenderer` precedent.
@MainActor
final class PageRowTitleLabelTests: XCTestCase {
    private struct FixtureTable: Decodable {
        struct Case: Decodable {
            let path: String
            let displayName: String
            let displayParent: String
            let why: String
        }

        let cases: [Case]
    }

    /// `<repo>/apps/apple/CrowiKit/Tests/CrowiKitTests/<this file>` → `<repo>`.
    private static var repositoryRootURL: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }

    private static let fixtureURL = repositoryRootURL
        .appendingPathComponent("packages/web/src/lib/__fixtures__/page-display-name.json")

    private func loadFixture() throws -> FixtureTable {
        let url = Self.fixtureURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                """
                Shared display-name fixture table not found at \(url.path).
                It is the single expectation set this Swift port and the web's
                page-path.test.ts both read. If the file moved, update BOTH
                consumers; if these tests now run somewhere the repo tree is
                absent (simulator/device), copy the table in as a test resource.
                """
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(FixtureTable.self, from: try Data(contentsOf: url))
    }

    /// The table is meant to be substantial; a truncated/emptied file must not
    /// pass as "all cases green".
    func testSharedFixtureTableIsLoadable() throws {
        let table = try loadFixture()

        XCTAssertGreaterThanOrEqual(table.cases.count, 20, "the shared table lost cases — check it against page-path.test.ts")
    }

    /// Every case in the shared table, both helpers. Covers the AC's fixture
    /// set: date hierarchies (full / partial / one segment / whole path, both
    /// under a parent and at the root), trailing slashes, user pages, portals,
    /// single segments, the root, digits inside a non-numeric segment, a
    /// numeric run that is not at the end, every path spelled out in
    /// `page-path.ts`'s own doc comments, every path the inline
    /// `pageDisplayName` / `pageDisplayParent` suites of `page-path.test.ts`
    /// assert, and the full-width-digit trap (Swift's
    /// `Character.isNumber` accepts `２０２６` where JavaScript's `\d` does not).
    func testDisplayNameAndParentMatchTheSharedFixtureTable() throws {
        for fixture in try loadFixture().cases {
            XCTAssertEqual(
                PageRowTitleLabel.displayName(for: fixture.path),
                fixture.displayName,
                "displayName(\(fixture.path)) — \(fixture.why)"
            )
            XCTAssertEqual(
                PageRowTitleLabel.displayParent(for: fixture.path),
                fixture.displayParent,
                "displayParent(\(fixture.path)) — \(fixture.why)"
            )
        }
    }

    /// The pairing property the web doc comment promises
    /// (`page-path.ts:117-121`): `displayParent + displayName` reproduces the
    /// path with trailing slashes stripped. Skipped exactly where the table's
    /// `roundTripRule` says it cannot hold — the top page (no display name)
    /// and a path carrying an empty segment (`/a//b`, which both
    /// implementations normalise away).
    func testParentPlusNameReconstructsThePath() throws {
        var asserted = 0
        for fixture in try loadFixture().cases {
            let name = PageRowTitleLabel.displayName(for: fixture.path)
            guard !name.isEmpty, !fixture.path.contains("//") else { continue }
            var expected = fixture.path
            while expected.hasSuffix("/") { expected.removeLast() }

            XCTAssertEqual(PageRowTitleLabel.displayParent(for: fixture.path) + name, expected, "round trip for \(fixture.path)")
            asserted += 1
        }

        XCTAssertGreaterThan(asserted, 10, "the round-trip property ended up asserting almost nothing")
    }

    // MARK: - Row rendering decisions (what the 3 flat lists actually show)

    /// The hero line is the display name, and the parent line is suppressed at
    /// root — the web list's `parentPath !== '/'` gate, so a root-level daily
    /// note never shows a lone `/` under its title.
    func testParentLineIsHiddenOnlyWhenTheParentIsRoot() {
        XCTAssertTrue(PageRowTitleLabel(path: "/user/foo/日報/2026/05/23").showsParent)
        XCTAssertEqual(PageRowTitleLabel(path: "/user/foo/日報/2026/05/23").parentText, "/user/foo/日報/")

        XCTAssertFalse(PageRowTitleLabel(path: "/foo").showsParent)
        XCTAssertFalse(PageRowTitleLabel(path: "/2026/05/23").showsParent, "a root-level date page must not render a bare '/' line")
        XCTAssertFalse(PageRowTitleLabel(path: "/2026/05/").showsParent, "a root-level date portal collapses entirely into the title too")
        XCTAssertFalse(PageRowTitleLabel(path: "/2026/").showsParent)
    }

    /// The top page has no display name at all, so the row falls back to the
    /// raw path instead of rendering an empty title.
    func testTitleFallsBackToTheRawPathWhenThereIsNoDisplayName() {
        XCTAssertEqual(PageRowTitleLabel(path: "/").titleText, "/")
        XCTAssertFalse(PageRowTitleLabel(path: "/").showsParent)
        XCTAssertEqual(PageRowTitleLabel(path: "/user/foo/日報/2026/05/23").titleText, "2026/05/23")
    }

    // MARK: - Measured layout on both size classes

    /// A pathologically deep parent — the realistic worst case for the muted
    /// second line (a short date title above a very long directory).
    private static let deepPath = "/user/sotarok/projects/crowi/design/reviews/2026/quarter-three/日報/2026/05/23"
    private static let shallowPath = "/日報/2026/05/23"
    /// The other worst case: a very long LEAF, i.e. a title that cannot fit
    /// even the regular width (the web's `truncate`d title span never wraps).
    private static let longBasenamePath = "/notes/" + String(repeating: "an-unreasonably-verbose-page-name-", count: 8)
    private static let shortBasenamePath = "/notes/short"
    /// Roughly an iPhone list row's content width (390pt screen minus the
    /// standard insets) and an iPad regular one.
    private static let compactRowWidth: CGFloat = 320
    private static let regularRowWidth: CGFloat = 700

    /// The muted parent line must TRUNCATE, never wrap: an arbitrarily deep
    /// path has to occupy exactly the same row height as a shallow one, at
    /// both size classes. A missing `lineLimit(1)` would make the deep row
    /// several lines taller here (and shove the metadata footer around).
    func testDeepParentPathDoesNotGrowTheRowAtEitherSizeClass() throws {
        for width in [Self.compactRowWidth, Self.regularRowWidth] {
            let shallow = try renderedSize(PageRowTitleLabel(path: Self.shallowPath), width: width)
            let deep = try renderedSize(PageRowTitleLabel(path: Self.deepPath), width: width)

            XCTAssertGreaterThan(shallow.height, 0, "the row must actually render at width \(width)")
            XCTAssertEqual(deep.height, shallow.height, accuracy: 1, "the parent line must truncate to one line at width \(width), not wrap")
        }
    }

    /// The hero line must TRUNCATE too, never wrap: a page whose own name is
    /// far wider than the row has to occupy exactly the same height as a short
    /// one, at both size classes. Without `lineLimit(1)` on the title SwiftUI
    /// wraps it over three-plus lines — the web list's title span is
    /// `truncate`d to one, and a wrapping title would also push every
    /// neighbouring row's metadata footer around.
    func testLongBasenameDoesNotGrowTheRowAtEitherSizeClass() throws {
        // The truncation is SwiftUI's, not a shortened model value: the row
        // still carries the whole name (and so does its accessibility text).
        XCTAssertEqual(PageRowTitleLabel(path: Self.longBasenamePath).titleText.count, 34 * 8)

        for width in [Self.compactRowWidth, Self.regularRowWidth] {
            let short = try renderedSize(PageRowTitleLabel(path: Self.shortBasenamePath), width: width)
            let long = try renderedSize(PageRowTitleLabel(path: Self.longBasenamePath), width: width)

            XCTAssertGreaterThan(short.height, 0, "the row must actually render at width \(width)")
            XCTAssertEqual(long.height, short.height, accuracy: 1, "the title must truncate to one line at width \(width), not wrap")
        }
    }

    /// The suppressed parent slot is a real layout saving, not just a blank
    /// line: a root-level page's row is strictly shorter.
    func testRootLevelRowIsShorterThanARowWithAParentLine() throws {
        let withParent = try renderedSize(PageRowTitleLabel(path: Self.shallowPath), width: Self.compactRowWidth)
        let rootLevel = try renderedSize(PageRowTitleLabel(path: "/2026/05/23"), width: Self.compactRowWidth)

        XCTAssertLessThan(rootLevel.height, withParent.height, "hiding the parent slot must remove its line, not leave an empty one")
    }

    /// The production row composition (title label + the existing
    /// `PageRowMetadataLabel` footer, exactly as the three flat lists stack
    /// them): three truncating lines whose height is identical on both size
    /// classes, and taller than the title block alone. Pins that adding the
    /// two-line title on top of the metadata footer neither collapses it nor
    /// lets an over-wide path — a deep parent, an over-long leaf, or both —
    /// reflow the row.
    func testTitleAndMetadataFooterCoexistWithTheSameHeightOnBothSizeClasses() throws {
        let worstCasePath = Self.deepPath.replacingOccurrences(of: "/2026/05/23", with: "") + Self.longBasenamePath

        for path in [Self.deepPath, Self.longBasenamePath, worstCasePath] {
            let row = VStack(alignment: .leading, spacing: 2) {
                PageRowTitleLabel(path: path)
                PageRowMetadataLabel(
                    lastUpdatedAt: "2026-07-20T10:00:00.000Z",
                    updaterName: "Sotaro",
                    updaterImage: nil,
                    loader: StubImageFetcher()
                )
            }

            let compact = try renderedSize(row, width: Self.compactRowWidth)
            let regular = try renderedSize(row, width: Self.regularRowWidth)
            let titleOnly = try renderedSize(PageRowTitleLabel(path: path), width: Self.compactRowWidth)

            XCTAssertEqual(compact.height, regular.height, accuracy: 1, "the composed row must lay out identically on compact and regular widths (\(path))")
            XCTAssertGreaterThan(compact.height, titleOnly.height, "the metadata footer must still occupy its own line under the title (\(path))")
        }
    }

    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    /// The measured size SwiftUI gives the view at a fixed width — the same
    /// `ImageRenderer` seam `SearchCapabilityToolbarButtonTests` uses to
    /// render production views under `swift test`.
    private func renderedSize(_ view: some View, width: CGFloat) throws -> CGSize {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw LayoutRenderingUnavailable() }
        return nsImage.size
        #else
        throw LayoutRenderingUnavailable()
        #endif
    }
}

/// Only exists so the `#else` branch above (an iOS `ImageRenderer` host, which
/// `swift test` never takes — it runs the macOS side of CrowiKit) type-checks.
private struct LayoutRenderingUnavailable: Error {}
