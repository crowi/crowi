import SwiftUI
import XCTest

@testable import CrowiKit

/// feature-ios-design-language (1)(3) — `PageRowMetadataLabel` IS the
/// production row-metadata footer both `PageTreeView`'s segment rows and the
/// recency home's page rows place under their titles (the
/// `SearchCapabilityToolbarButton` precedent: the App target cannot be
/// imported here, so the shared piece lives in CrowiKit and is pinned
/// directly). These tests fix the AC-(1) fallback ladder — full metadata →
/// time-only → updater-only → nothing at all — and the ISO8601 parsing the
/// relative timestamp depends on (the server emits `toISOString()` WITH
/// fractional seconds; a plain ISO8601 parse alone would reject every live
/// value).
final class PageRowMetadataLabelTests: XCTestCase {
    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    private func makeLabel(lastUpdatedAt: String?, updaterName: String?, updaterImage: String? = nil) -> PageRowMetadataLabel {
        PageRowMetadataLabel(lastUpdatedAt: lastUpdatedAt, updaterName: updaterName, updaterImage: updaterImage, loader: StubImageFetcher())
    }

    // MARK: - ISO8601 parsing

    /// The server's `Date#toISOString()` carries milliseconds
    /// (`.500Z`) — both that shape and the fraction-less one must parse, and
    /// the fractional part must actually be honored (not truncated).
    func testParsesISO8601WithAndWithoutFractionalSeconds() throws {
        let fractional = try XCTUnwrap(PageRowMetadataLabel.date(fromISO8601: "2026-07-20T10:00:00.500Z"))
        let plain = try XCTUnwrap(PageRowMetadataLabel.date(fromISO8601: "2026-07-20T10:00:00Z"))

        XCTAssertEqual(fractional.timeIntervalSince(plain), 0.5, accuracy: 0.001)
    }

    func testUnparseableOrMissingTimestampsYieldNil() {
        XCTAssertNil(PageRowMetadataLabel.date(fromISO8601: nil))
        XCTAssertNil(PageRowMetadataLabel.date(fromISO8601: ""))
        XCTAssertNil(PageRowMetadataLabel.date(fromISO8601: "not-a-date"))
        XCTAssertNil(PageRowMetadataLabel.date(fromISO8601: "2026/07/20 10:00"))
        XCTAssertNil(PageRowMetadataLabel.relativeTimeText(from: "not-a-date"))
    }

    /// Locale-dependent output — assert presence/shape, never the exact
    /// localized string.
    func testRelativeTextForAPastDateIsNonEmpty() throws {
        let now = try XCTUnwrap(PageRowMetadataLabel.date(fromISO8601: "2026-07-23T00:00:00Z"))
        let text = try XCTUnwrap(PageRowMetadataLabel.relativeTimeText(from: "2026-07-20T10:00:00.000Z", relativeTo: now))

        XCTAssertFalse(text.isEmpty)
    }

    // MARK: - AC-(1) fallback ladder

    func testFullMetadataShowsUpdaterAndTime() {
        let label = makeLabel(lastUpdatedAt: "2026-07-20T10:00:00.000Z", updaterName: "Sotaro", updaterImage: "/img.png")

        XCTAssertTrue(label.hasMetadata)
        XCTAssertTrue(label.hasUpdater)
        XCTAssertNotNil(label.relativeTimeText)
        XCTAssertEqual(label.metadataText?.hasPrefix("Sotaro · "), true)
    }

    /// `updater: null` → no avatar, time only.
    func testMissingUpdaterFallsBackToTimeOnly() {
        let label = makeLabel(lastUpdatedAt: "2026-07-20T10:00:00.000Z", updaterName: nil)

        XCTAssertTrue(label.hasMetadata)
        XCTAssertFalse(label.hasUpdater, "a null updater must not show a placeholder avatar")
        XCTAssertNotNil(label.relativeTimeText)
    }

    /// Timestamp missing (or unparseable) but updater known → updater only.
    func testMissingTimestampFallsBackToUpdaterOnly() {
        let label = makeLabel(lastUpdatedAt: nil, updaterName: "Sotaro")

        XCTAssertTrue(label.hasMetadata)
        XCTAssertNil(label.relativeTimeText)
        XCTAssertEqual(label.metadataText, "Sotaro")
    }

    /// A pre-extension server (both fields absent) → the label renders
    /// NOTHING, leaving the row exactly as before the feature — the "拡張前
    /// サーバでもクラッシュせずセグメント名のみで動く" half of AC (1).
    func testNoMetadataAtAllRendersNothing() {
        XCTAssertFalse(makeLabel(lastUpdatedAt: nil, updaterName: nil).hasMetadata)
        XCTAssertFalse(makeLabel(lastUpdatedAt: "garbage", updaterName: nil).hasMetadata, "an unparseable timestamp with no updater must degrade to nothing, not an empty gap")
    }
}
