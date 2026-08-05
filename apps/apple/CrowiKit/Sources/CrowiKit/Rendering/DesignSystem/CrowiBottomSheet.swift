import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// The geometry of the panel's dismiss drag, as pure values.
public enum CrowiBottomSheetDrag {
    /// How far down the panel must be dragged at RELEASE to dismiss.
    public static let dismissThreshold: CGFloat = 60

    /// How far the panel is drawn for a raw drag translation. Downwards
    /// only — the panel is already at the bottom, so an upward drag has
    /// nowhere to go and must not peel it off the screen edge.
    public static func offset(forTranslation height: CGFloat) -> CGFloat {
        max(height, 0)
    }

    public static func shouldDismiss(offset: CGFloat) -> Bool {
        offset >= dismissThreshold
    }
}

/// The design's bottom sheet: cards floating on a dimmed backdrop, drawn by
/// this app rather than presented by the system.
///
/// ## Why this is not a `.sheet`
///
/// A system sheet on this OS FLOATS: it is inset from the left, right and
/// bottom screen edges and rounded on all four corners. Holding cards, that
/// reads as a card inside a card — the reported problem, and one that
/// survived every attempt to style it away:
///
///   - the system's own opaque panel is the same white as the cards on it in
///     light mode, so what the eye actually saw of it was the cards' borders,
///     drawn one inset in;
///   - dropping those borders and clearing the background
///     (`presentationBackground(.clear)`) left a translucent material layer,
///     WITH its rounded corners and shadow, that the cleared background does
///     not remove. (Observed: the panel went from white to grey — the
///     background being cleared — while the floating rounded edge stayed.)
///
/// There is no API to stop a sheet floating, so the sheet is drawn here
/// instead: full width, flush to the bottom, curved only on the edge it grows
/// from. That is the shape every bottom sheet worth copying uses (Discord's
/// is the one this was measured against), and it is the difference between a
/// panel that belongs to the screen and one that hovers over it.
///
/// What the platform gave for free is reimplemented rather than dropped:
/// tapping the backdrop dismisses, dragging the panel down dismisses (with
/// the grabber that advertises it), and VoiceOver's escape gesture dismisses.
/// The panel is also marked as modal so VoiceOver does not wander into the
/// page behind it.
///
/// ## Known deviation
///
/// The backdrop covers the screen but NOT the navigation bar, which the
/// enclosing `NavigationStack` draws above this overlay. The design dims the
/// bar too. Covering it would mean hoisting this overlay's state out of the
/// reader and into the tab shell — a change to how the whole screen is
/// composed, for one bar's worth of dimming. Left as-is deliberately.
public struct CrowiBottomSheet<Content: View>: View {
    @Binding private var isPresented: Bool
    private let content: Content

    @State private var dragOffset: CGFloat = 0

    /// Design: `background:rgba(0,0,0,.4)` on the backdrop.
    private static var backdropOpacity: Double { 0.4 }

    public init(isPresented: Binding<Bool>, @ViewBuilder content: () -> Content) {
        _isPresented = isPresented
        self.content = content()
    }

    public var body: some View {
        ZStack(alignment: .bottom) {
            if isPresented {
                backdrop
                panel
            }
        }
        // Design: `transition:transform .4s cubic-bezier(.32,.72,0,1)` — the
        // platform's own sheet curve, which `.snappy` is.
        .animation(.snappy(duration: 0.32), value: isPresented)
        .ignoresSafeArea()
    }

    private var backdrop: some View {
        Color.black.opacity(Self.backdropOpacity)
            .ignoresSafeArea()
            .transition(.opacity)
            .onTapGesture { dismiss() }
            // The backdrop is the dismiss target, not content: VoiceOver
            // should reach the panel's rows, not a full-screen button.
            .accessibilityHidden(true)
    }

    private var panel: some View {
        VStack(spacing: 0) {
            grabber
            content
        }
        .padding(.bottom, CrowiMetrics.sheetPanelBottomPadding)
        // The home indicator's clearance, on top of the 12pt above. Inside
        // the panel's background, so the surface reaches the screen edge
        // instead of stopping short of it.
        .padding(.bottom, safeAreaBottomInset)
        .frame(maxWidth: .infinity)
        .background(CrowiTheme.muted)
        // Rounded at the TOP only, and flush left/right/bottom. A panel inset
        // from the screen edges reads as a floating card holding more cards —
        // which is the shape the system's own sheet imposes and the reason
        // this overlay exists. Every bottom sheet worth copying (Discord's is
        // the one this was measured against) anchors the panel to three edges
        // and curves only the one it grows from.
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: CrowiMetrics.sheetPanelCornerRadius,
                topTrailingRadius: CrowiMetrics.sheetPanelCornerRadius,
                style: .continuous
            )
        )
        .offset(y: dragOffset)
        .gesture(dragToDismiss)
        .transition(.move(edge: .bottom))
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { dismiss() }
    }

    /// The platform's drag pill. Not in the design's mock, but this panel
    /// dismisses on a downward drag and an affordance nobody can see is an
    /// affordance nobody uses.
    private var grabber: some View {
        Capsule()
            .fill(CrowiTheme.border)
            .frame(width: CrowiMetrics.sheetGrabberWidth, height: CrowiMetrics.sheetGrabberHeight)
            .padding(.top, CrowiMetrics.sheetGrabberTopPadding)
            .padding(.bottom, CrowiMetrics.sheetPanelTopPadding)
            .accessibilityHidden(true)
    }

    private var dragToDismiss: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                dragOffset = CrowiBottomSheetDrag.offset(forTranslation: value.translation.height)
            }
            .onEnded { value in
                let final = CrowiBottomSheetDrag.offset(forTranslation: value.translation.height)
                if CrowiBottomSheetDrag.shouldDismiss(offset: final) {
                    dismiss()
                }
                // Snap back either way — on dismissal the panel is leaving on
                // its own transition, and a released-but-not-dismissed panel
                // must not stay parked half-open.
                withAnimation(.snappy(duration: 0.2)) { dragOffset = 0 }
            }
    }

    private func dismiss() {
        isPresented = false
    }

    /// The bottom safe area, read from the window rather than from a
    /// `GeometryReader`: this overlay already ignores the safe area (so the
    /// backdrop reaches the screen edges), which leaves any reader inside it
    /// reporting zero.
    private var safeAreaBottomInset: CGFloat {
        #if canImport(UIKit)
        return UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.bottom }
            .max() ?? 0
        #else
        return 0
        #endif
    }
}

extension View {
    /// Presents `content` as the design's bottom sheet over this view.
    ///
    /// An overlay, not a presentation — see `CrowiBottomSheet` for why.
    public func crowiBottomSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        overlay {
            CrowiBottomSheet(isPresented: isPresented, content: content)
        }
    }
}
