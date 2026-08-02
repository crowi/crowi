import XCTest

@testable import CrowiKit

/// The notifications list's date headers, and the swipe geometry beside them.
final class CrowiDayGroupTests: XCTestCase {
    /// A fixed "now" and a fixed calendar — a grouping rule tested against the
    /// wall clock passes at 14:00 and fails at 00:30.
    private let now = Date(timeIntervalSince1970: 1_775_044_800) // 2026-04-01 12:00:00Z
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private func date(daysAgo days: Double, hoursAgo hours: Double = 0) -> Date {
        now.addingTimeInterval(-(days * 86_400 + hours * 3_600))
    }

    private func group(_ date: Date) -> CrowiDayGroup {
        CrowiDayGroup.of(date, relativeTo: now, calendar: calendar)
    }

    // MARK: - Which header a row lands under

    func testTodayAndYesterdayAreCalendarDaysNotTwentyFourHourWindows() {
        XCTAssertEqual(group(now), .today)
        XCTAssertEqual(group(date(daysAgo: 0, hoursAgo: 11)), .today, "01:00 the same day is still today")
        // 11 hours before 12:00 is 01:00 — same day; 13 hours is 23:00 the
        // day before. A rule counting 24-hour windows would call both "today".
        XCTAssertEqual(group(date(daysAgo: 0, hoursAgo: 13)), .yesterday)
    }

    func testTheWeekWindowRollsAndThenGivesUp() {
        XCTAssertEqual(group(date(daysAgo: 2)), .earlierThisWeek)
        XCTAssertEqual(group(date(daysAgo: 6)), .earlierThisWeek)
        XCTAssertEqual(group(date(daysAgo: 7)), .earlier, "the window is seven days, not eight")
        XCTAssertEqual(group(date(daysAgo: 400)), .earlier)
    }

    /// Server/device clock skew: a row stamped slightly in the future has just
    /// arrived, so it belongs at the top with today rather than under a header
    /// of its own.
    func testAFutureTimestampIsFiledUnderToday() {
        XCTAssertEqual(group(now.addingTimeInterval(90)), .today)
        XCTAssertEqual(group(now.addingTimeInterval(86_400 * 3)), .today)
    }

    // MARK: - Runs

    private struct Row {
        let name: String
        let date: Date?
    }

    private func runs(_ rows: [Row]) -> [CrowiDayGroupRun<Row>] {
        CrowiDayGroup.runs(of: rows, by: \.date, relativeTo: now, calendar: calendar)
    }

    func testConsecutiveRowsSharingADayBecomeOneHeadedRun() {
        let result = runs([
            Row(name: "a", date: now),
            Row(name: "b", date: date(daysAgo: 0, hoursAgo: 2)),
            Row(name: "c", date: date(daysAgo: 1)),
            Row(name: "d", date: date(daysAgo: 30)),
        ])

        XCTAssertEqual(result.map(\.group), [.today, .yesterday, .earlier])
        XCTAssertEqual(result.map { $0.items.map(\.name) }, [["a", "b"], ["c"], ["d"]])
    }

    /// The server's order IS the list's order. Grouping into buckets would
    /// re-sort a row whose timestamp disagrees with its position; runs render
    /// it where it already is, under a second header.
    func testAnOutOfOrderRowOpensASecondRunRatherThanBeingMoved() {
        let result = runs([
            Row(name: "a", date: now),
            Row(name: "b", date: date(daysAgo: 1)),
            Row(name: "c", date: now),
        ])

        XCTAssertEqual(result.map(\.group), [.today, .yesterday, .today])
        XCTAssertEqual(result.map { $0.items.map(\.name) }, [["a"], ["b"], ["c"]])
    }

    /// A row whose `createdAt` was missing or unparseable must not be lifted
    /// out of its position — it joins the run it already sits in.
    func testAnUndatedRowStaysWhereItIs() {
        let result = runs([
            Row(name: "a", date: now),
            Row(name: "undated", date: nil),
            Row(name: "b", date: date(daysAgo: 1)),
        ])

        XCTAssertEqual(result.map(\.group), [.today, .yesterday])
        XCTAssertEqual(result.map { $0.items.map(\.name) }, [["a", "undated"], ["b"]])
    }

    func testAnUndatedFirstRowFallsBackToTheTailHeader() {
        let result = runs([Row(name: "undated", date: nil)])

        XCTAssertEqual(result.map(\.group), [.earlier])
    }

    func testAnEmptyListHasNoHeaders() {
        XCTAssertTrue(runs([]).isEmpty)
    }

    // MARK: - Swipe geometry

    /// The list scrolls vertically, so an ambiguous drag belongs to the scroll
    /// view — a row that peels open under a flick down fights the list.
    func testOnlyAPredominantlyHorizontalDragMovesTheRow() {
        XCTAssertEqual(CrowiSwipeAction.offset(forTranslation: CGSize(width: -40, height: -10)), -40)
        XCTAssertEqual(CrowiSwipeAction.offset(forTranslation: CGSize(width: -40, height: -60)), 0)
    }

    func testTheRowOnlyOpensLeftwardsAndStopsAtThePanel() {
        XCTAssertEqual(CrowiSwipeAction.offset(forTranslation: CGSize(width: 120, height: 0)), 0, "there is no trailing action to reveal")
        XCTAssertEqual(
            CrowiSwipeAction.offset(forTranslation: CGSize(width: -400, height: 0)),
            -CrowiSwipeAction.revealWidth,
            "the row cannot be dragged off its own card"
        )
    }

    func testAReleaseFiresOnlyOnceTheSwipeHasCommitted() {
        XCTAssertFalse(CrowiSwipeAction.shouldCommit(offset: 0))
        XCTAssertFalse(CrowiSwipeAction.shouldCommit(offset: -(CrowiSwipeAction.commitThreshold - 1)))
        XCTAssertTrue(CrowiSwipeAction.shouldCommit(offset: -CrowiSwipeAction.commitThreshold))
        XCTAssertTrue(CrowiSwipeAction.shouldCommit(offset: -CrowiSwipeAction.revealWidth))
    }

    /// The threshold has to be reachable: a commit distance past the panel's
    /// own width could never be dragged to.
    func testTheCommitThresholdIsInsideTheRevealedPanel() {
        XCTAssertLessThan(CrowiSwipeAction.commitThreshold, CrowiSwipeAction.revealWidth)
    }
}
