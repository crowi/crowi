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
/// ## Content only
///
/// This is the two cards and nothing else — no panel, no backdrop, no
/// presentation. `CrowiBottomSheet` hosts it (and its doc comment records why
/// the app draws the sheet instead of presenting one). Everything this type
/// used to carry for the system presentation — a measured detent, a cleared
/// background, a hidden grabber — went with the presentation itself.
public struct CrowiPageActionSheet: View {
    private let shareURL: URL
    private let isWatching: Bool
    private let isTogglingWatch: Bool
    private let onSelect: (CrowiPageAction) -> Void
    private let onCancel: () -> Void

    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 19

    public init(
        shareURL: URL,
        isWatching: Bool,
        isTogglingWatch: Bool = false,
        onSelect: @escaping (CrowiPageAction) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.shareURL = shareURL
        self.isWatching = isWatching
        self.isTogglingWatch = isTogglingWatch
        self.onSelect = onSelect
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(spacing: CrowiMetrics.sheetCardSpacing) {
            CrowiCard(.sheet) {
                ForEach(Array(CrowiPageAction.sheetActions.enumerated()), id: \.element.id) { index, action in
                    if index > 0 {
                        CrowiRowSeparator()
                    }
                    row(action)
                }
            }
            cancelButton
        }
    }

    private var cancelButton: some View {
        Button(action: onCancel) {
            Text("Cancel")
                .font(CrowiTypography.sheetRow.weight(.semibold))
                .foregroundStyle(CrowiTheme.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, CrowiMetrics.sheetButtonPadding)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The design's Cancel is a rounded BUTTON on the panel, not a card
        // holding one row — same surface and radius, but it never carries a
        // card's separator or outline.
        .background(CrowiTheme.popover)
        .clipShape(RoundedRectangle(cornerRadius: CrowiTheme.cardCornerRadius, style: .continuous))
        .padding(.horizontal, CrowiMetrics.sheetHorizontalMargin)
    }

    @ViewBuilder
    private func row(_ action: CrowiPageAction) -> some View {
        switch action {
        case .share:
            ShareLink(item: shareURL) {
                rowLabel(action)
            }
            .buttonStyle(.plain)
        default:
            Button {
                onSelect(action)
            } label: {
                rowLabel(action)
            }
            .buttonStyle(.plain)
            // The watch row writes to the server; while ITS write is in
            // flight it is inert, exactly like the pill's toggles (the
            // per-toggle guard `PageEngagementModel` exposes).
            .disabled(action == .watch && isTogglingWatch)
        }
    }

    private func rowLabel(_ action: CrowiPageAction) -> some View {
        HStack(spacing: CrowiMetrics.sheetRowContentSpacing) {
            Image(systemName: action.systemImage(isWatching: isWatching))
                .font(.system(size: glyphSize, weight: .regular))
                .foregroundStyle(CrowiTheme.primary)
                .frame(width: glyphSize * 1.4, alignment: .center)
            Text(action.title(isWatching: isWatching))
                .font(CrowiTypography.sheetRow)
                .foregroundStyle(CrowiTheme.foreground)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, CrowiMetrics.sheetRowHorizontalPadding)
        .padding(.vertical, CrowiMetrics.sheetRowVerticalPadding)
        .frame(minHeight: CrowiMetrics.minimumTapTarget)
        .contentShape(Rectangle())
    }
}

