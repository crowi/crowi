import SwiftUI

/// The design's create action, as a floating button above the tab bar.
///
/// ## Why it is not a tab
///
/// The design draws "New" as the CENTRE SLOT of a five-slot bar. That is the
/// one thing a `TabView` cannot express — its bar takes tabs, which are
/// destinations with selection state, and create is an action that opens a
/// sheet. The app used to answer this by drawing the whole bar itself, which
/// meant hand-building the selection highlight, the travel animation, the
/// press feedback and the glass, and getting none of what the OS ships.
///
/// The bar went back to the system; only this button stayed custom. It is one
/// circle instead of a whole navigation surface, and it keeps the design's
/// point — that creating a page is the app's primary action and should be the
/// most prominent thing on screen — while the tab bar itself gets Liquid
/// Glass, the sliding selection indicator, Dynamic Type, VoiceOver and every
/// future OS refinement for free. (Slack's iOS bar is the same composition:
/// the system's tab bar, plus its own floating compose button.)
public struct CrowiCreateButton: View {
    private let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = CrowiMetrics.createButtonSize

    public init(action: @escaping () -> Void) {
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Circle()
                .fill(CrowiTheme.primary)
                .frame(width: size, height: size)
                // Design: `0 4px 12px -2px primary 55%` — the button reads as
                // lifted off the content rather than printed on it.
                .shadow(color: CrowiTheme.primary.opacity(0.4), radius: 8, x: 0, y: 4)
                .overlay {
                    Image(systemName: "plus")
                        .font(.system(size: size * 0.44, weight: .semibold))
                        .foregroundStyle(CrowiTheme.primaryForeground)
                }
        }
        .buttonStyle(CrowiPressableButtonStyle())
        .padding(.trailing, CrowiMetrics.createButtonTrailingInset)
        .padding(.bottom, CrowiMetrics.createButtonBottomInset)
        .accessibilityLabel("New Page")
    }
}

/// A button that dips under the finger.
///
/// `.plain` gives no feedback at all, which is what made the app's own chrome
/// feel inert next to the system's. The spring carries a little overshoot on
/// release for the same reason the tab bar's own indicator does — a
/// critically-damped return reads as mechanical.
public struct CrowiPressableButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(.snappy(duration: 0.2, extraBounce: 0.25), value: configuration.isPressed)
    }
}
