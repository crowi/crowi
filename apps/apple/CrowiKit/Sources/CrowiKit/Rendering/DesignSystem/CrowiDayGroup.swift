import Foundation

/// The design's date headers over a reverse-chronological list — TODAY /
/// YESTERDAY / EARLIER THIS WEEK, plus the tail the design's sample data
/// never reached.
///
/// Client-side, from each row's own timestamp: no endpoint groups anything,
/// and asking one to would be asking the server to decide what "today" means
/// for a device in another timezone.
public enum CrowiDayGroup: String, CaseIterable, Sendable {
    case today
    case yesterday
    case earlierThisWeek
    case earlier

    public var title: String {
        switch self {
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .earlierThisWeek: return "Earlier this week"
        case .earlier: return "Earlier"
        }
    }

    /// The rolling window "earlier this week" covers, in days back from
    /// today. A ROLLING seven days rather than the calendar week: on a Monday
    /// the calendar reading would put all of last week's activity under
    /// "Earlier" and leave "Earlier this week" holding a few hours, which is
    /// the opposite of what the header is for.
    private static let weekWindowDays = 7

    /// - Parameters:
    ///   - now: injectable for tests; production callers use the default.
    ///   - calendar: the device's, so "today" ends at the user's midnight.
    public static func of(_ date: Date, relativeTo now: Date = Date(), calendar: Calendar = .current) -> CrowiDayGroup {
        // Day-granular, never `timeIntervalSince`: 23:59 and 00:01 are one
        // minute and two days apart, and an hours-based rule would file them
        // under the same header.
        guard let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: now)
        ).day else {
            return .earlier
        }
        switch days {
        // Negative = stamped in the future (clock skew between the device and
        // the server). It has just arrived, so it belongs at the top with the
        // rest of today rather than in a header of its own.
        case ..<1: return .today
        case 1: return .yesterday
        case 2..<weekWindowDays: return .earlierThisWeek
        default: return .earlier
        }
    }
}

/// One run of consecutive rows that share a header.
public struct CrowiDayGroupRun<Element>: Identifiable {
    /// Positional: the same group can legitimately open a second run if the
    /// list is not perfectly ordered, and both must render.
    public let id: Int
    public let group: CrowiDayGroup
    public let items: [Element]
}

extension CrowiDayGroup {
    /// Splits an ALREADY-ORDERED list into headed runs.
    ///
    /// Runs, not a dictionary bucketing: the server's order is the truth this
    /// list renders (newest first), and grouping into buckets would silently
    /// re-sort rows whose timestamps disagree with their position. A row
    /// whose date is missing or unparseable joins the run it already sits in
    /// (`.earlier` if it is the very first row) rather than being lifted out
    /// to the bottom of the screen — a decode gap must not move a row.
    public static func runs<Element>(
        of items: [Element],
        by date: (Element) -> Date?,
        relativeTo now: Date = Date(),
        calendar: Calendar = .current
    ) -> [CrowiDayGroupRun<Element>] {
        var runs: [CrowiDayGroupRun<Element>] = []
        var currentGroup: CrowiDayGroup?
        var currentItems: [Element] = []

        for item in items {
            let group = date(item).map { of($0, relativeTo: now, calendar: calendar) }
                ?? currentGroup
                ?? .earlier
            if group != currentGroup, let openGroup = currentGroup {
                runs.append(CrowiDayGroupRun(id: runs.count, group: openGroup, items: currentItems))
                currentItems = []
            }
            currentGroup = group
            currentItems.append(item)
        }
        if let openGroup = currentGroup {
            runs.append(CrowiDayGroupRun(id: runs.count, group: openGroup, items: currentItems))
        }
        return runs
    }
}
