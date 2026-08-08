import SwiftUI

/// feature-ios-visual-redesign Phase 3 — every row the reader's action sheet
/// offers, as a value.
///
/// The design's sheet also draws "Move to…" and a destructive "Delete page".
/// **Neither is implemented here on purpose**: the app has no rename/move and
/// no delete surface at all, and both are outside RFC-0016 §8's bounded-write
/// scope (like / bookmark / watch / seen / comment / quick-edit / create).
/// They are not present as disabled rows either — a greyed-out "Delete page"
/// advertises a capability the app does not have. `CrowiPageChromeTests` pins
/// this exact list so neither can reappear by accident.
public enum CrowiPageAction: String, CaseIterable, Identifiable, Sendable {
    /// The system share sheet, on the page's web URL.
    case share
    /// The same URL, straight to the pasteboard.
    case copyLink
    /// The existing `ReadDestination.revisionHistory` screen.
    case versionHistory
    /// The existing watch toggle (`EngagementActions.setWatching`) — the one
    /// engagement toggle the design's pill has no slot for.
    case watch

    public var id: String { rawValue }

    /// The rows, in the design's order. Deliberately a written-out list rather
    /// than `allCases`: adding a case to the enum must be a decision about
    /// what the sheet SHOWS, not a silent new row.
    public static let sheetActions: [CrowiPageAction] = [.share, .copyLink, .versionHistory, .watch]

    /// - Parameter isWatching: only `watch` reads it (its row is a toggle and
    ///   says which way it will go).
    public func title(isWatching: Bool) -> String {
        switch self {
        case .share: return "Share"
        case .copyLink: return "Copy Link"
        case .versionHistory: return "Version History"
        case .watch: return isWatching ? "Stop Watching" : "Watch Page"
        }
    }

    public func systemImage(isWatching: Bool) -> String {
        switch self {
        case .share: return "square.and.arrow.up"
        case .copyLink: return "link"
        case .versionHistory: return "clock.arrow.circlepath"
        case .watch: return isWatching ? "bell.fill" : "bell"
        }
    }
}

/// The sheet itself: the design's grouped card of rows over a Cancel button.
///
/// `share` is a real `ShareLink` rather than a callback: it presents the
/// system share sheet from INSIDE this sheet, so nothing has to race the
/// dismissal of one presentation against the presentation of another (the
/// hazard `WorkspaceTabsView.openDestinationAfterCreate` records for the
/// create flow). Every other row hands its action back to the reader, which
/// dismisses first and then acts.
///
