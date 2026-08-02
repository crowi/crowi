import SwiftUI

/// The geometry of the design's swipe-to-act row, as pure values so the
/// interaction can be asserted without a gesture recognizer.
public enum CrowiSwipeAction {
    /// Design: the action panel behind a row is `width:104px`.
    public static let revealWidth: CGFloat = 104
    /// How far the row must have travelled at RELEASE for the action to fire.
    /// Deliberately short of a full reveal — a swipe that has clearly
    /// committed should not also have to be precise.
    public static let commitThreshold: CGFloat = 62

    /// How far the row is drawn for a raw drag translation.
    ///
    /// Leftwards only: this row has no trailing-edge action, so a rightward
    /// drag must not peel it open onto an empty panel. Clamped at the panel's
    /// width so the content cannot be dragged off its own card.
    public static func offset(forTranslation translation: CGSize) -> CGFloat {
        guard isHorizontal(translation) else { return 0 }
        return min(max(translation.width, -revealWidth), 0)
    }

    /// Whether a release at this offset fires the action.
    public static func shouldCommit(offset: CGFloat) -> Bool {
        -offset >= commitThreshold
    }

    /// Whether a drag reads as an attempt to swipe the row rather than as the
    /// start of a scroll. The list this lives in scrolls vertically, so an
    /// ambiguous drag must belong to the scroll view — a row that peels open
    /// under a flick down is a row that fights the list.
    static func isHorizontal(_ translation: CGSize) -> Bool {
        abs(translation.width) > abs(translation.height)
    }
}

/// A card row with ONE swipe-revealed action.
///
/// The design draws a pointer-dragged panel with a tappable button in it;
/// this is the same interaction resolved to the platform's idiom — the panel
/// is revealed under the drag, and a release past `commitThreshold` fires the
/// action (the "full swipe" every iOS list uses) rather than parking the row
/// open around a second tap target. That also keeps the row stateless between
/// gestures: nothing can be left half-open behind a refresh that replaces the
/// data under it.
///
/// Not `List`'s own `.swipeActions`, for the reason `CrowiCard` exists at all:
/// these rows are not in a `List`. Bringing one back for the swipe would trade
/// every one of the design's card metrics for it.
///
/// The action is ALSO an accessibility action, so it is reachable without
/// performing a drag at all — a swipe-only affordance is invisible to
/// VoiceOver and unusable with Switch Control.
public struct CrowiSwipeActionRow<Content: View>: View {
    private let actionLabel: String
    private let actionSystemImage: String
    private let isActionAvailable: Bool
    private let action: () -> Void
    private let content: Content

    @State private var offset: CGFloat = 0

    public init(
        actionLabel: String,
        actionSystemImage: String,
        isActionAvailable: Bool = true,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.actionLabel = actionLabel
        self.actionSystemImage = actionSystemImage
        self.isActionAvailable = isActionAvailable
        self.action = action
        self.content = content()
    }

    public var body: some View {
        content
            .background(CrowiTheme.card)
            .offset(x: offset)
            .background(alignment: .trailing) { panel }
            // Clipped to the row's own bounds: the panel is drawn to the
            // row's trailing edge, and without this it would paint over the
            // rows above and below while the drag is in flight.
            .clipped()
            .gesture(isActionAvailable ? drag : nil)
            .accessibilityAction(named: Text(actionLabel), action)
    }

    @ViewBuilder
    private var panel: some View {
        if offset < 0 {
            CrowiTheme.primary
                .frame(width: CrowiSwipeAction.revealWidth)
                .overlay {
                    VStack(spacing: 2) {
                        Image(systemName: actionSystemImage)
                            .font(.system(size: 20, weight: .semibold))
                        Text(actionLabel)
                            .font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(CrowiTheme.primaryForeground)
                }
                // The row's own text already carries the action's meaning to
                // VoiceOver through `accessibilityAction`; this panel exists
                // for the eyes mid-drag.
                .accessibilityHidden(true)
        }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 15)
            .onChanged { value in
                offset = CrowiSwipeAction.offset(forTranslation: value.translation)
            }
            .onEnded { value in
                let final = CrowiSwipeAction.offset(forTranslation: value.translation)
                // Close FIRST, then act: the action replaces the row's data
                // (a read row loses its dot), and animating a row shut after
                // its content has already changed under it reads as a glitch.
                withAnimation(.snappy(duration: 0.2)) { offset = 0 }
                if CrowiSwipeAction.shouldCommit(offset: final) {
                    action()
                }
            }
    }
}
