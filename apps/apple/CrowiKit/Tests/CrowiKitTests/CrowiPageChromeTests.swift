import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// feature-ios-visual-redesign Phase 3 — the page reader's chrome: the header
/// block, the floating action pill and the action sheet's row set.
///
/// Pinned the way the rest of this suite pins UI (`CrowiTabBarTests`): pure
/// rules asserted directly, layout MEASURED off the real SwiftUI render. No
/// snapshot infrastructure, and nothing below asserts that a colour equals
/// itself.
@MainActor
final class CrowiPageChromeTests: XCTestCase {
    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    // MARK: - Action sheet: exactly the actions this app can perform

    /// The design's sheet also draws "Move to…" and a destructive "Delete
    /// page". Neither exists in the app, and both are outside RFC-0016 §8's
    /// bounded-write scope — so the sheet has FOUR rows, and this is the
    /// assertion that keeps a future edit from quietly re-adding a fifth.
    func testTheActionSheetOffersExactlyShareCopyHistoryAndWatch() {
        XCTAssertEqual(CrowiPageAction.sheetActions, [.share, .copyLink, .versionHistory, .watch])
        XCTAssertEqual(CrowiPageAction.sheetActions.count, 4)
    }

    /// The written-out row list and the enum cannot drift: every case is a
    /// row, and every row is a case. (The list is written out rather than
    /// taken from `allCases` so that ADDING a case is a decision about the
    /// sheet — this is where that decision fails loudly if it was skipped.)
    func testEveryActionIsARowAndEveryRowIsAnAction() {
        XCTAssertEqual(
            CrowiPageAction.sheetActions.map(\.id).sorted(),
            CrowiPageAction.allCases.map(\.id).sorted()
        )
    }

    /// No row can destroy or relocate anything: the sheet is read-side plus
    /// two engagement writes. A "Delete page" row sneaking back in — as a
    /// title, in either watch state — turns this red.
    func testNoActionIsDestructiveOrMovesThePage() {
        let forbidden = ["delete", "move", "trash", "remove page", "rename"]
        for action in CrowiPageAction.sheetActions {
            for isWatching in [true, false] {
                let title = action.title(isWatching: isWatching).lowercased()
                for word in forbidden {
                    XCTAssertFalse(title.contains(word), "\(action.id) offered “\(title)”, which this app cannot do")
                }
            }
        }
    }

    /// Watch is the one row that is a TOGGLE: it says (and draws) which way
    /// it will go, like the pill's like/bookmark glyphs.
    func testTheWatchRowStatesTheDirectionItWillToggle() {
        XCTAssertEqual(CrowiPageAction.watch.title(isWatching: false), "Watch Page")
        XCTAssertEqual(CrowiPageAction.watch.title(isWatching: true), "Stop Watching")
        XCTAssertNotEqual(
            CrowiPageAction.watch.systemImage(isWatching: true),
            CrowiPageAction.watch.systemImage(isWatching: false)
        )

        for action in CrowiPageAction.sheetActions where action != .watch {
            XCTAssertEqual(
                action.title(isWatching: true),
                action.title(isWatching: false),
                "\(action.id) is not a watch-state-dependent row"
            )
        }
    }

    // MARK: - Header

    /// The trail is the page's PARENT path, always led by "Home" — the title
    /// right under it already shows the display name, and for a date page
    /// that name is a whole trailing run of segments.
    func testTheBreadcrumbIsTheParentTrailAndNeverRepeatsTheTitle() {
        XCTAssertEqual(CrowiPageHeader.breadcrumb(for: "/crowi/rfc/0001-plugin"), ["Home", "crowi", "rfc"])
        XCTAssertEqual(
            CrowiPageHeader.breadcrumb(for: "/user/sotarok/日報/2026/05/23"),
            ["Home", "user", "sotarok", "日報"],
            "the date run belongs to the title, not to the trail"
        )
        XCTAssertEqual(CrowiPageHeader.breadcrumb(for: "/foo"), ["Home"], "a root-level page's trail is just Home")
        XCTAssertEqual(CrowiPageHeader.breadcrumb(for: "/"), ["Home"])
    }

    /// The trail and the title are drawn from the SAME split the list rows
    /// use, so the two surfaces cannot disagree about where a page lives.
    func testTheBreadcrumbAgreesWithThePageRowTitleSplit() {
        for path in ["/crowi/rfc/0001-plugin", "/user/sotarok/日報/2026/05/23", "/foo", "/"] {
            let trail = CrowiPageHeader.breadcrumb(for: path).dropFirst().joined(separator: "/")
            let parent = PageRowTitleLabel.displayParent(for: path)
            XCTAssertEqual(
                trail.isEmpty ? "/" : "/" + trail + "/",
                parent,
                "the trail for \(path) is not the row's parent path"
            )
        }
    }

    // MARK: - Reading progress

    /// The number the two indicators print. The denominator is the actually
    /// scrollable range (content minus the VISIBLE height), which is the
    /// whole reason `ScrollGeometry`'s content insets are what feed this.
    func testTheReadingFractionIsTheScrolledShareOfTheScrollableRange() {
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 2000, viewportHeight: 800), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 600, contentHeight: 2000, viewportHeight: 800), 0.5)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 1200, contentHeight: 2000, viewportHeight: 800), 1)
    }

    /// Overscroll (rubber band) at either end is not progress, and cannot
    /// push the bar past its ends.
    func testOverscrollIsClampedAtBothEnds() {
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: -120, contentHeight: 2000, viewportHeight: 800), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 1600, contentHeight: 2000, viewportHeight: 800), 1)
    }

    /// A page that fits on screen has been read in full — there is nothing
    /// left to scroll to.
    func testAPageThatFitsOnScreenIsFullyRead() {
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 500, viewportHeight: 800), 1)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 800, viewportHeight: 800), 1)
    }

    /// Before layout there is no measurement — and an unmeasured page must
    /// read as the START of the document, never as a full bar. (The
    /// "everything fits" rule above is exactly what would fire here if the
    /// zero guard were dropped, which is why both are pinned together.)
    func testAnUnmeasuredPageReadsAsZeroAndNeverAsComplete() {
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 0, viewportHeight: 0), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 2000, viewportHeight: 0), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 0, contentHeight: 0, viewportHeight: 800), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: .nan, contentHeight: 2000, viewportHeight: 800), 0)
        XCTAssertEqual(CrowiReadingProgress.fraction(scrollOffset: 100, contentHeight: .infinity, viewportHeight: 800), 0)
    }

    func testTheProgressLabelIsARoundedPercentage() {
        XCTAssertEqual(CrowiReadingProgress.label(for: 0), "0% read")
        XCTAssertEqual(CrowiReadingProgress.label(for: 0.234), "23% read")
        XCTAssertEqual(CrowiReadingProgress.label(for: 0.236), "24% read")
        XCTAssertEqual(CrowiReadingProgress.label(for: 1), "100% read")
        XCTAssertEqual(CrowiReadingProgress.label(for: .nan), "0% read", "an unmeasurable value never prints garbage")
    }

    /// The model only publishes when the number actually moved — a scroll
    /// frame that changed nothing must not invalidate the views watching it.
    func testTheModelOnlyMovesWhenTheFractionDoes() {
        let model = CrowiReadingProgressModel()
        XCTAssertEqual(model.fraction, 0)

        model.report(scrollOffset: 600, contentHeight: 2000, viewportHeight: 800)
        XCTAssertEqual(model.fraction, 0.5)

        model.report(scrollOffset: 0, contentHeight: 0, viewportHeight: 0)
        XCTAssertEqual(model.fraction, 0, "an unmeasured frame resets to the start rather than holding a stale number")
    }

    // MARK: - Tap targets

    /// Every slot in the pill is a control, so the pill clears 44pt — at the
    /// default text size and at the smallest one, where the design's 6/8px
    /// padding around a ~20pt glyph lands well under it and the explicit
    /// floor is the only thing holding the bar open.
    func testTheActionPillClearsThe44ptMinimumTapTarget() throws {
        for size in [DynamicTypeSize.xSmall, .large] {
            let height = try renderedSize(pill().dynamicTypeSize(size), width: 390).height
            let barHeight = height - CrowiMetrics.pageActionBarBottomInset

            XCTAssertGreaterThanOrEqual(
                barHeight,
                CrowiMetrics.minimumTapTarget,
                "the pill fell under the 44pt tap target at \(size)"
            )
        }
    }

    /// …and the pill actually PAINTS its state: a liked page and an unliked
    /// one are not the same picture (the design's filled/hollow glyphs plus
    /// the count).
    func testThePillPaintsLikeAndBookmarkState() throws {
        let plain = try renderToPNGData(pill(isLiked: false, isBookmarked: false))
        let engaged = try renderToPNGData(pill(isLiked: true, isBookmarked: true))

        XCTAssertNotEqual(plain, engaged, "like/bookmark state must be visible in the render")
    }

    /// The header is a title block, not a control strip: it renders its
    /// counts and nothing about it is tappable. Measured as "it draws
    /// something", which is what a regression to an empty header would lose.
    func testTheHeaderRendersItsStatsRow() throws {
        let withCounts = try renderToPNGData(header(seen: 12, likes: 3, comments: 2))
        let withoutCounts = try renderToPNGData(header(seen: 0, likes: 0, comments: 0))

        XCTAssertNotEqual(withCounts, withoutCounts, "the header's read-only counts must be painted")
    }

    // MARK: - Helpers

    private func pill(isLiked: Bool = false, isBookmarked: Bool = false) -> some View {
        CrowiPageActionBar(
            likeCount: isLiked ? 4 : 3,
            isLiked: isLiked,
            isBookmarked: isBookmarked,
            commentCount: 2,
            onEdit: {},
            onToggleBookmark: {},
            onToggleLike: {},
            onShowComments: {},
            onShowActions: {}
        )
    }

    private func header(seen: Int, likes: Int, comments: Int) -> some View {
        CrowiPageHeader(
            path: "/crowi/rfc/0023-rendered-ast",
            updaterName: "Sotaro Karasawa",
            updaterImage: nil,
            updatedAt: "2026-07-26T09:00:00.000Z",
            seenCount: seen,
            likeCount: likes,
            commentCount: comments,
            loader: StubImageFetcher()
        )
    }

    private func renderedSize(_ view: some View, width: CGFloat) throws -> CGSize {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw PageChromeRenderingUnavailable() }
        return nsImage.size
        #else
        throw PageChromeRenderingUnavailable()
        #endif
    }

    private func renderToPNGData(_ view: some View) throws -> Data {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: 390))
        renderer.scale = 1
        guard
            let nsImage = renderer.nsImage,
            let tiff = nsImage.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else {
            throw PageChromeRenderingUnavailable()
        }
        return png
        #else
        throw PageChromeRenderingUnavailable()
        #endif
    }
}

/// Only exists so the `#else` branches above (an iOS `ImageRenderer` host,
/// which `swift test` never takes — it runs the macOS side of CrowiKit)
/// type-check.
private struct PageChromeRenderingUnavailable: Error {}
