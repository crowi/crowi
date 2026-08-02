import Observation
import SwiftUI

/// feature-ios-visual-redesign Phase 3 — how far through a page the reader has
/// scrolled, as the design's two indicators read it: the hairline along the
/// navigation bar's bottom edge (`width:(progress*100)%`) and the TOC sheet's
/// "N% read" label.
///
/// ## Why this is measured, not estimated
///
/// The fraction is only meaningful if the denominator is the *actually
/// scrollable* range, which is the content height minus the VISIBLE height —
/// and the visible height is the scroll view's height minus its content
/// insets (the navigation bar above, the home indicator and this screen's own
/// floating pill below). Those insets are ~100pt on a phone: a version of
/// this that used the scroll view's raw frame instead would saturate at 100%
/// roughly a screenful before the end, which on a page only slightly taller
/// than the screen means the bar is full while a third of the text is still
/// unread.
///
/// `ScrollGeometry` (`onScrollGeometryChange`) reports the insets directly, so
/// the number is exact — but it is iOS 18 / macOS 15, and this app's floor is
/// iOS 17 (RFC-0016). Rather than reconstructing the insets from a stack of
/// `GeometryReader` measurements on the older path and printing a number that
/// is confidently wrong there, the indicators are simply ABSENT below iOS 18
/// (`CrowiReadingProgress.isMeasurable`).
public enum CrowiReadingProgress {
    /// Whether this OS can measure reading progress at all. Both indicators
    /// (`CrowiReadingProgressBar`, the TOC sheet's label) are hidden when it
    /// is `false` — no bar, no label, rather than a bar stuck at 0%.
    public static var isMeasurable: Bool {
        if #available(iOS 18.0, macOS 15.0, *) { return true }
        return false
    }

    /// - Parameters:
    ///   - scrollOffset: how far the content's top has travelled ABOVE the
    ///     visible region's top edge. Negative during a rubber-band
    ///     overscroll, which reads as 0.
    ///   - contentHeight: the scrolled content's full height.
    ///   - viewportHeight: the VISIBLE height (container minus content insets).
    /// - Returns: `0…1`, or `0` while either measurement is still missing.
    public static func fraction(scrollOffset: CGFloat, contentHeight: CGFloat, viewportHeight: CGFloat) -> Double {
        // Nothing has been laid out yet (or a measurement came back garbage):
        // report the START of the document, never the end. This guard has to
        // come first — without it an unmeasured 0-height content would fall
        // into the "everything fits on screen" branch below and paint a full
        // bar before a single glyph existed.
        guard contentHeight.isFinite, viewportHeight.isFinite, scrollOffset.isFinite else { return 0 }
        guard contentHeight > 0, viewportHeight > 0 else { return 0 }
        let scrollable = contentHeight - viewportHeight
        // The whole page fits on screen: it is all visible, so it is all read.
        guard scrollable > 0 else { return 1 }
        return min(max(Double(scrollOffset / scrollable), 0), 1)
    }

    /// The design's `Math.round(progress*100)+'% read'`.
    public static func label(for fraction: Double) -> String {
        let clamped = fraction.isFinite ? min(max(fraction, 0), 1) : 0
        return "\(Int((clamped * 100).rounded()))% read"
    }

    /// How far the content must have travelled before the navigation bar
    /// stops being transparent. Small enough that the bar reacts to a real
    /// scroll immediately, large enough that a rubber-band settle or a
    /// one-pixel layout jitter at rest does not flicker it.
    public static let scrolledThreshold: CGFloat = 8

    /// Whether the page has scrolled out from under the navigation bar — the
    /// design's "transparent at the top, material once you are reading".
    ///
    /// Derived from the raw OFFSET rather than from `fraction`: a page
    /// shorter than the screen has `fraction == 1` from the first frame (it
    /// is all visible, so it is all read), and a bar permanently opaque over
    /// a page that cannot scroll is the same bug in the other direction. An
    /// overscroll above the top reads as not-scrolled.
    public static func isScrolled(scrollOffset: CGFloat) -> Bool {
        guard scrollOffset.isFinite else { return false }
        return scrollOffset > scrolledThreshold
    }
}

/// The live scroll position of ONE page reader, held as a reference type on
/// purpose.
///
/// The reader's body renders the whole page (a full `RenderedAstView` tree).
/// Keeping the fraction in `@State` on that view would re-evaluate all of it
/// on every scroll frame; keeping it in an `@Observable` object that ONLY the
/// two small progress views read means a scroll tick invalidates a 2pt bar and
/// a sheet label, and nothing else.
///
/// Not `@MainActor`-isolated (so it can be a plain `@State` default value),
/// but every caller is a SwiftUI view update, i.e. the main thread — the
/// `PageRowMetadataLabel.relativeDateTimeFormatter` stance.
@Observable
public final class CrowiReadingProgressModel {
    public private(set) var fraction: Double = 0
    /// Whether the content has scrolled under the navigation bar. A SEPARATE
    /// property from `fraction`, not a derivation of it, so the view that
    /// swaps the bar's background is invalidated twice per page (in, out)
    /// instead of on every scroll frame — `@Observable` tracks the individual
    /// properties a body reads.
    public private(set) var isScrolled = false

    public init() {}

    public func report(scrollOffset: CGFloat, contentHeight: CGFloat, viewportHeight: CGFloat) {
        let next = CrowiReadingProgress.fraction(
            scrollOffset: scrollOffset,
            contentHeight: contentHeight,
            viewportHeight: viewportHeight
        )
        // Observation publishes on every assignment; a scroll frame that did
        // not move the needle must not invalidate the views watching this.
        if next != fraction {
            fraction = next
        }
        let nextIsScrolled = CrowiReadingProgress.isScrolled(scrollOffset: scrollOffset)
        if nextIsScrolled != isScrolled {
            isScrolled = nextIsScrolled
        }
    }
}

/// What one `ScrollGeometry` sample reduces to. `Equatable` so
/// `onScrollGeometryChange` only calls back when a number actually moved.
struct CrowiScrollMetrics: Equatable {
    var scrollOffset: CGFloat
    var contentHeight: CGFloat
    var viewportHeight: CGFloat
}

/// Feeds a `CrowiReadingProgressModel` from the enclosing scroll view.
///
/// Applied to the `ScrollView` itself. A no-op below iOS 18 — see
/// `CrowiReadingProgress.isMeasurable` for why that is the whole story rather
/// than a fallback path.
public struct CrowiReadingProgressTracker: ViewModifier {
    private let progress: CrowiReadingProgressModel

    public init(progress: CrowiReadingProgressModel) {
        self.progress = progress
    }

    @ViewBuilder
    public func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollGeometryChange(for: CrowiScrollMetrics.self) { geometry in
                CrowiScrollMetrics(
                    // `contentOffset.y` is `-contentInsets.top` at rest, so
                    // adding the inset back makes 0 the top of the document.
                    scrollOffset: geometry.contentOffset.y + geometry.contentInsets.top,
                    contentHeight: geometry.contentSize.height,
                    viewportHeight: geometry.containerSize.height
                        - geometry.contentInsets.top
                        - geometry.contentInsets.bottom
                )
            } action: { _, metrics in
                progress.report(
                    scrollOffset: metrics.scrollOffset,
                    contentHeight: metrics.contentHeight,
                    viewportHeight: metrics.viewportHeight
                )
            }
        } else {
            content
        }
    }
}

/// The design's scroll-reactive navigation bar: transparent while the reader
/// is at the top of a page, the system's material once the text has started
/// moving under it.
///
/// iOS does this automatically for a plain `ScrollView` in a
/// `NavigationStack`, and the reader lost it: the reading-progress rule is a
/// `safeAreaInset(edge:.top)`, which interposes a view between the bar and the
/// scroll view, and the bar then never sees the scroll it tracks — it stayed
/// in its scroll-edge (transparent) appearance forever, over any content.
/// Rather than give up the rule's placement, the bar is driven EXPLICITLY from
/// the same measurement the rule already takes.
///
/// Reads `isScrolled` in the MODIFIER's own body, not in the reader's: the
/// reader's body renders the whole page, and re-evaluating it to change a bar
/// background would be the expensive half of `CrowiReadingProgressModel`'s
/// reason for existing.
public struct CrowiScrolledToolbarBackground: ViewModifier {
    private let progress: CrowiReadingProgressModel

    public init(progress: CrowiReadingProgressModel) {
        self.progress = progress
    }

    @ViewBuilder
    public func body(content: Content) -> some View {
        #if canImport(UIKit)
        // `ToolbarPlacement.navigationBar` is UIKit-only; AppKit's bar is a
        // window toolbar with its own appearance model, and `swift test`
        // renders these views on macOS.
        content.toolbarBackground(progress.isScrolled ? .visible : .hidden, for: .navigationBar)
        #else
        content
        #endif
    }
}

extension View {
    /// Sugar for `.modifier(CrowiReadingProgressTracker(progress:))`.
    public func crowiReadingProgress(_ progress: CrowiReadingProgressModel) -> some View {
        modifier(CrowiReadingProgressTracker(progress: progress))
    }

    /// Sugar for `.modifier(CrowiScrolledToolbarBackground(progress:))`.
    public func crowiScrolledToolbarBackground(_ progress: CrowiReadingProgressModel) -> some View {
        modifier(CrowiScrolledToolbarBackground(progress: progress))
    }
}

/// The design's `progressBarStyle`: a 2px `var(--primary)` rule pinned to the
/// navigation bar's bottom edge, as wide a fraction of the screen as the
/// reader has got through.
///
/// Hosted as a `safeAreaInset(edge:.top)` rather than drawn INTO the
/// navigation bar: SwiftUI does not let an app put a subview inside the
/// system bar, and a top inset lands in exactly the place the design draws —
/// flush under the bar, above the scrolling content, never over it.
///
/// Reads `progress.fraction` in ITS OWN body (the reason the model is passed
/// as an object rather than as a `Double`): only this view redraws per frame.
public struct CrowiReadingProgressBar: View {
    private let progress: CrowiReadingProgressModel

    /// Design: `height:2px`.
    public static let height: CGFloat = 2

    public init(progress: CrowiReadingProgressModel) {
        self.progress = progress
    }

    public var body: some View {
        // Read HERE, in `body`, rather than inside the `GeometryReader`'s
        // closure: `@Observable` tracks the properties a view reads while its
        // body is being evaluated, and a read deferred into a layout-time
        // closure is not reliably part of that.
        let fraction = progress.fraction
        return GeometryReader { geometry in
            CrowiTheme.primary
                .frame(width: geometry.size.width * fraction)
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Chrome, and a duplicate of what the TOC sheet says in words.
        .accessibilityHidden(true)
    }
}
