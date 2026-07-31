import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// feature-ios-visual-redesign Phase 1 — the shared design-language
/// components, pinned the way the rest of this suite pins views: pure rules
/// asserted directly, and layout asserted by MEASURING the real SwiftUI
/// render (`PageRowTitleLabelTests` / `SearchCapabilityToolbarButtonTests`'
/// `ImageRenderer` seam). There is no snapshot infrastructure here and this
/// does not add one — nothing below asserts that a color equals itself.
@MainActor
final class CrowiDesignSystemTests: XCTestCase {
    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    // MARK: - Search field: the clear-button rule

    /// The clear button appears whenever there is anything to clear —
    /// including whitespace, which is the state where a user most needs it
    /// and the one the design's own trimmed `hasQuery` gate would have
    /// excluded.
    func testClearButtonIsShownForAnyNonEmptyTextIncludingWhitespace() {
        XCTAssertFalse(CrowiSearchField.showsClearButton(for: ""))
        XCTAssertTrue(CrowiSearchField.showsClearButton(for: "e"))
        XCTAssertTrue(CrowiSearchField.showsClearButton(for: "eng"))
        XCTAssertTrue(CrowiSearchField.showsClearButton(for: "  "), "whitespace must be clearable, not invisibly stuck in the field")
        XCTAssertTrue(CrowiSearchField.showsClearButton(for: "\n"))
    }

    /// The OTHER gate — what counts as a query worth sending. Whitespace is
    /// not, which is exactly where it diverges from the clear button above;
    /// asserted together so a future "simplification" collapsing the two
    /// rules into one turns red.
    func testEffectiveQueryIgnoresWhitespaceOnlyInput() {
        XCTAssertFalse(CrowiSearchField.hasEffectiveQuery(""))
        XCTAssertFalse(CrowiSearchField.hasEffectiveQuery("   "))
        XCTAssertFalse(CrowiSearchField.hasEffectiveQuery("\n \t"))
        XCTAssertTrue(CrowiSearchField.hasEffectiveQuery("eng"))
        XCTAssertTrue(CrowiSearchField.hasEffectiveQuery("  eng  "))

        // Whitespace-only is the ONE input the two gates disagree on (an
        // empty field is neither clearable nor searchable, a real query is
        // both) — which is exactly why it is asserted: a future
        // "simplification" collapsing them into one rule turns red here.
        for text in ["   ", "\n \t"] {
            XCTAssertNotEqual(
                CrowiSearchField.showsClearButton(for: text),
                CrowiSearchField.hasEffectiveQuery(text),
                "whitespace-only input is clearable but not searchable — the two gates are not the same rule (\(text.debugDescription))"
            )
        }
        for text in ["", "eng"] {
            XCTAssertEqual(
                CrowiSearchField.showsClearButton(for: text),
                CrowiSearchField.hasEffectiveQuery(text),
                "the gates only diverge on whitespace-only input (\(text.debugDescription))"
            )
        }
    }

    // MARK: - Avatar initials

    func testInitialsTakeTheFirstAndLastWordOfAMultiWordName() {
        XCTAssertEqual(WorkspaceAvatarView.initials(from: "Sotaro Karasawa"), "SK")
        XCTAssertEqual(WorkspaceAvatarView.initials(from: "Hiroki WADA"), "HW")
        XCTAssertEqual(WorkspaceAvatarView.initials(from: "  Aya   Nakamura  "), "AN", "extra whitespace must not become an initial")
        XCTAssertEqual(
            WorkspaceAvatarView.initials(from: "Ada Byron Lovelace"),
            "AL",
            "a middle name must not displace the family name"
        )
    }

    /// A single token yields ONE letter — the case that matters is a CJK
    /// name, which has no word boundary to split on and whose leading
    /// character is the family name. Two characters of 「柄沢聡太郎」 would be
    /// half a surname.
    func testInitialsTakeOneCharacterForASingleTokenName() {
        XCTAssertEqual(WorkspaceAvatarView.initials(from: "sotarok"), "S")
        XCTAssertEqual(WorkspaceAvatarView.initials(from: "柄沢聡太郎"), "柄")
    }

    /// No name → no initials → the row falls back to the SF Symbol
    /// placeholder rather than painting an empty coloured disc.
    func testInitialsAreNilWhenThereIsNoUsableName() {
        XCTAssertNil(WorkspaceAvatarView.initials(from: nil))
        XCTAssertNil(WorkspaceAvatarView.initials(from: ""))
        XCTAssertNil(WorkspaceAvatarView.initials(from: "   \n "))
    }

    // MARK: - Page row composition

    /// The row's leading-avatar gate and the metadata label's own
    /// `hasUpdater` gate must stay the SAME condition: they decide the same
    /// thing about the same fields, and if they drift a row can show an
    /// avatar for an updater whose name/time line has already degraded away
    /// (or the reverse). `GET /me/recently-viewed-pages` — which populates
    /// neither field — is the case in production that depends on it.
    func testLeadingAvatarGateAgreesWithTheMetadataLabelsOwnUpdaterGate() {
        let fixtures: [(name: String?, image: String?)] = [
            ("Sotaro", "https://wiki.example.com/api/attachments/by-key/user/sotarok"),
            ("Sotaro", nil),
            (nil, "https://wiki.example.com/api/attachments/by-key/user/sotarok"),
            (nil, nil),
        ]
        for fixture in fixtures {
            let label = PageRowMetadataLabel(
                lastUpdatedAt: "2026-07-20T10:00:00.000Z",
                updaterName: fixture.name,
                updaterImage: fixture.image,
                loader: StubImageFetcher()
            )

            XCTAssertEqual(
                CrowiPageRow.showsLeadingAvatar(updaterName: fixture.name, updaterImage: fixture.image),
                label.hasUpdater,
                "row avatar gate diverged from PageRowMetadataLabel.hasUpdater for (\(String(describing: fixture.name)), \(String(describing: fixture.image)))"
            )
        }
        XCTAssertFalse(
            CrowiPageRow.showsLeadingAvatar(updaterName: nil, updaterImage: nil),
            "a recently-viewed row (no updater at all) must leave the slot empty rather than show a placeholder disc"
        )
    }

    /// `CrowiPageRow` shows the 34pt leading avatar AND embeds the metadata
    /// label, so the label must be told to drop its own inline 14pt one —
    /// otherwise the same face is painted twice per row. Measured, not
    /// asserted on a flag: what matters is that the suppressed variant
    /// actually paints less.
    func testSuppressingTheMetadataLabelsInlineAvatarRemovesPaintedContent() throws {
        let withAvatar = try renderToPNGData(
            PageRowMetadataLabel(
                lastUpdatedAt: "2026-07-20T10:00:00.000Z",
                updaterName: "Sotaro Karasawa",
                updaterImage: nil,
                loader: StubImageFetcher(),
                showsAvatar: true
            )
        )
        let withoutAvatar = try renderToPNGData(
            PageRowMetadataLabel(
                lastUpdatedAt: "2026-07-20T10:00:00.000Z",
                updaterName: "Sotaro Karasawa",
                updaterImage: nil,
                loader: StubImageFetcher(),
                showsAvatar: false
            )
        )

        XCTAssertNotEqual(withAvatar, withoutAvatar, "showsAvatar must change what the label paints")
        XCTAssertGreaterThan(withAvatar.count, withoutAvatar.count, "the avatar-bearing variant must paint strictly more than the suppressed one")
    }

    // MARK: - Tap targets

    /// Every tappable row must clear 44pt, at the default text size and at
    /// the smallest one (where the design's 13px padding around a SINGLE
    /// line of text lands well under it and the explicit floor is the only
    /// thing holding the row open).
    func testEveryRowShapeClearsThe44ptMinimumTapTarget() throws {
        let singleLineRow = CrowiRow {
            CrowiRowChip(systemImage: "folder")
        } content: {
            Text("Browse Pages").font(CrowiTypography.rowTitle)
        }
        let pageRow = CrowiPageRow(
            path: "/user/sotarok/日報/2026/05/23",
            lastUpdatedAt: "2026-07-20T10:00:00.000Z",
            updaterName: "Sotaro Karasawa",
            updaterImage: nil,
            loader: StubImageFetcher()
        )
        let bareRow = CrowiRow(showsChevron: false) {
            Text("x").font(CrowiTypography.rowTitle)
        }

        for size in [DynamicTypeSize.xSmall, .large] {
            for (label, row) in [("single line + chip", AnyView(singleLineRow)), ("page row", AnyView(pageRow)), ("bare row", AnyView(bareRow))] {
                let height = try renderedSize(row.dynamicTypeSize(size), width: 358).height

                XCTAssertGreaterThanOrEqual(
                    height,
                    CrowiMetrics.minimumTapTarget,
                    "\(label) fell under the 44pt tap target at \(size)"
                )
            }
        }
    }

    /// The search field is tappable too — and its 9pt padding around one line
    /// of `.body` text is the tightest control in the design.
    func testSearchFieldClearsThe44ptMinimumTapTarget() throws {
        let height = try renderedSize(
            CrowiSearchField(text: .constant(""), prompt: "Search pages", onSubmit: {})
                .dynamicTypeSize(.xSmall),
            width: 390
        ).height

        XCTAssertGreaterThanOrEqual(height, CrowiMetrics.minimumTapTarget)
    }

    // MARK: - Card separators

    /// The design writes `border-top` on EVERY row and clips the first one
    /// away with `overflow:hidden`; the SwiftUI card emits separators BETWEEN
    /// rows instead. The observable consequence is that a card's height grows
    /// by (rows - 1) hairlines, not by (rows) — i.e. a one-row card has no
    /// stray line above its first row.
    func testCardHeightGrowsByOneSeparatorPerGapNotPerRow() throws {
        func card(rowCount: Int) -> some View {
            CrowiCardRows(Array(0..<rowCount), id: \.self) { index in
                CrowiRow(showsChevron: false) {
                    Text("row \(index)").font(CrowiTypography.rowTitle)
                }
            }
        }

        let oneRow = try renderedSize(card(rowCount: 1), width: 390).height
        let twoRows = try renderedSize(card(rowCount: 2), width: 390).height
        let threeRows = try renderedSize(card(rowCount: 3), width: 390).height

        let firstGap = twoRows - oneRow
        let secondGap = threeRows - twoRows

        XCTAssertEqual(firstGap, secondGap, accuracy: 0.01, "every added row must cost the same row + one separator")
        XCTAssertGreaterThan(firstGap, oneRow, "a second row must add its own height PLUS a separator")
        XCTAssertLessThan(firstGap - oneRow, 1.5, "the separator between rows must be a hairline, not a rule")
    }

    // MARK: - Helpers

    /// The measured size SwiftUI gives the view at a fixed width — the
    /// `ImageRenderer` seam `PageRowTitleLabelTests` established.
    private func renderedSize(_ view: some View, width: CGFloat) throws -> CGSize {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw DesignSystemRenderingUnavailable() }
        return nsImage.size
        #else
        throw DesignSystemRenderingUnavailable()
        #endif
    }

    private func renderToPNGData(_ view: some View) throws -> Data {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: 240, height: 30))
        renderer.scale = 1
        guard
            let nsImage = renderer.nsImage,
            let tiff = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else {
            throw DesignSystemRenderingUnavailable()
        }
        return png
        #else
        throw DesignSystemRenderingUnavailable()
        #endif
    }
}

/// Only exists so the `#else` branches above (an iOS `ImageRenderer` host,
/// which `swift test` never takes — it runs the macOS side of CrowiKit)
/// type-check.
private struct DesignSystemRenderingUnavailable: Error {}
