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
/// ## Why the system sheet has no chrome of its own here
///
/// The design's action sheet is NOT a system sheet: it is a panel pinned to
/// the bottom (`padding:0 8px 12px`) holding cards that float directly on the
/// dimmed backdrop. There is no containing panel, no outline and no grabber.
///
/// Presenting it as a plain `.sheet` produced a box inside a box — the
/// system's own rounded panel (in `--background`, which is white in light
/// mode, exactly like the cards on it) with outlined cards inside it, so the
/// only thing the eye could actually see of the outer panel was the cards'
/// borders. `.presentationBackground(.clear)` removes the panel and its
/// corners while KEEPING the system dimming behind it (a separate layer), so
/// the result is the design's composition with the platform's real
/// presentation semantics — drag to dismiss, backdrop tap, VoiceOver escape
/// — still intact. Building the overlay by hand in a `ZStack` would have to
/// re-implement every one of those.
///
/// The height is MEASURED rather than estimated. It used to be a hand-summed
/// guess (row height × count + slack) which overshot the real layout, and
/// with a transparent background that surplus is not merely ugly: it is an
/// invisible region that still swallows the backdrop tap. The detent is the
/// content's own height plus the bottom safe area the detent spans but the
/// content does not occupy.
public struct CrowiPageActionSheet: View {
    private let shareURL: URL
    private let isWatching: Bool
    private let isTogglingWatch: Bool
    private let onSelect: (CrowiPageAction) -> Void
    private let onCancel: () -> Void

    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 19
    @State private var contentHeight: CGFloat = 0
    @State private var bottomSafeArea: CGFloat = 0

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
        ScrollView {
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
            .padding(.top, CrowiMetrics.sheetCardSpacing)
            .padding(.bottom, CrowiMetrics.sheetPanelBottomPadding)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: CrowiSheetContentHeightKey.self, value: proxy.size.height)
                }
            }
        }
        // Nothing to bounce against when the content fits, which it does at
        // every ordinary text size — a rubber-band on a panel with no visible
        // container just detaches the cards from the screen edge.
        .scrollBounceBehavior(.basedOnSize)
        .background {
            // Reports the inset the DETENT spans but the content above does
            // not occupy. `.ignoresSafeArea()` is what makes the reader see
            // the real number instead of the zero it would report from inside
            // the already-inset region.
            GeometryReader { proxy in
                Color.clear.preference(key: CrowiSheetBottomInsetKey.self, value: proxy.safeAreaInsets.bottom)
            }
            .ignoresSafeArea()
        }
        .onPreferenceChange(CrowiSheetContentHeightKey.self) { contentHeight = $0 }
        .onPreferenceChange(CrowiSheetBottomInsetKey.self) { bottomSafeArea = $0 }
        .presentationDetents([.height(detentHeight)])
        // See the type's doc comment: no panel, no corners, no grabber — the
        // system dimming stays.
        .presentationBackground(.clear)
        .presentationDragIndicator(.hidden)
    }

    /// The measured content, plus the safe area the detent spans under it.
    ///
    /// No ceiling of its own: a custom detent taller than a sheet may be is
    /// already clamped to that maximum by the system, and the `ScrollView`
    /// above is what makes the overflow at an accessibility text size scroll
    /// rather than clip. That pair replaces the `.large` companion detent
    /// this used to carry — a second detent the user could drag to was only
    /// ever there to rescue a height that had been guessed wrong.
    ///
    /// The floor applies only before the first measurement lands: a sheet
    /// that grows into place beats one that starts oversized and shrinks.
    private var detentHeight: CGFloat {
        max(CrowiSheetLayout.minimumHeight, contentHeight + bottomSafeArea)
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

/// The floor a content-sized sheet detent is held to.
///
/// Only reached before the first measurement lands (and by a caller with no
/// rows at all). A `.height(0)` detent is not a legal presentation, and one
/// that starts at the content's eventual size would need the size it is
/// trying to compute.
public enum CrowiSheetLayout {
    public static let minimumHeight: CGFloat = 120
}

/// The measured height of a bottom sheet's content.
struct CrowiSheetContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The bottom safe-area inset a content-sized detent has to add to it.
struct CrowiSheetBottomInsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
