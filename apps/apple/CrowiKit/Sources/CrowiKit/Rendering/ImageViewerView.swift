import SwiftUI

/// `feature-ios-image-viewer` — everything `WorkspacePageMarkdownView` needs
/// to turn tapped body images into the fullscreen pinch-zoom viewer. `nil`
/// (the default) leaves body images non-tappable, which is what the
/// read-only revision-history sheet keeps.
public struct ImageViewerConfiguration {
    let resolver: any ViewerImageURLResolving
    /// The §6.3 confidential notice, re-applied INSIDE the viewer content:
    /// a `fullScreenCover` is a separate presentation layer drawn ABOVE the
    /// workspace chrome root's own `.confidentialBanner` (`WorkspaceHomeView`),
    /// so without this the "always on top, on every screen" intent would
    /// break exactly while an image — often the most sensitive content on a
    /// confidential page — is fullscreen.
    let confidentialNotice: String?

    public init(resolver: any ViewerImageURLResolving, confidentialNotice: String?) {
        self.resolver = resolver
        self.confidentialNotice = confidentialNotice
    }
}

/// The tapped image `WorkspacePageMarkdownView` presents fullscreen. The
/// canonical URL identifies the item (`fullScreenCover(item:)`);
/// `initialImage` is the body's already-decoded display-derivative bitmap,
/// shown immediately while the original loads so zooming starts from a real
/// picture instead of a spinner.
public struct ImageViewerItem: Identifiable {
    public let canonicalURL: URL
    public let initialImage: PlatformImage?
    public var id: String { canonicalURL.absoluteString }

    public init(canonicalURL: URL, initialImage: PlatformImage?) {
        self.canonicalURL = canonicalURL
        self.initialImage = initialImage
    }
}

/// `feature-ios-image-viewer` — the fullscreen zoom viewer: pinch to zoom,
/// drag to pan while zoomed, double-tap to toggle zoom, swipe down to
/// dismiss while unzoomed, plus an explicit close button. Standard SwiftUI
/// gestures only (`MagnifyGesture`/`DragGesture`) — no custom transition
/// machinery.
///
/// Invariants carried over from the body's own image path (RFC-0016
/// §6.1/§14):
///   - bytes come ONLY through the injected `WorkspaceImageFetching`
///     conformer (the per-workspace disk cache wrapping the same-origin
///     Bearer + redirect-strip loader) — never a second fetch path;
///   - raster decode only (`WorkspaceMarkdownImageLoading.loadImage` →
///     `PlatformImage(data:)`) — SVG/whatever bytes are never handed to a
///     `WKWebView`/SVG-DOM context; what doesn't raster-decode simply
///     doesn't display;
///   - no save/share affordance (deliberate — a future confidential export
///     suppression would have to gate exactly that surface).
public struct ImageViewerView: View {
    let item: ImageViewerItem
    let loader: any WorkspaceImageFetching
    let resolver: any ViewerImageURLResolving
    let confidentialNotice: String?

    @Environment(\.dismiss) private var dismiss
    @State private var image: PlatformImage?
    @State private var failed = false
    @State private var zoom = ImageViewerZoomModel()
    @GestureState private var magnificationFactor: CGFloat = 1
    @GestureState private var dragTranslation: CGSize = .zero

    public init(
        item: ImageViewerItem,
        loader: any WorkspaceImageFetching,
        resolver: any ViewerImageURLResolving,
        confidentialNotice: String?
    ) {
        self.item = item
        self.loader = loader
        self.resolver = resolver
        self.confidentialNotice = confidentialNotice
        _image = State(initialValue: item.initialImage)
    }

    public var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(zoom.steadyScale * magnificationFactor)
                    .offset(currentOffset)
                    .gesture(magnifyGesture.simultaneously(with: dragGesture))
                    .onTapGesture(count: 2) {
                        withAnimation(.spring) { zoom.toggleDoubleTapZoom() }
                    }
                    .accessibilityLabel("Image")
                    .accessibilityZoomAction { action in
                        withAnimation(.spring) {
                            zoom.endMagnification(factor: action.direction == .zoomIn ? 2 : 0.5)
                        }
                    }
            } else if failed {
                ContentUnavailableView("Couldn't load this image.", systemImage: "photo")
            } else {
                ProgressView()
                    .tint(.white)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
                    .padding()
            }
            .accessibilityLabel("Close")
        }
        .confidentialBanner(confidentialNotice)
        .task { await load() }
    }

    private var currentOffset: CGSize {
        CGSize(
            width: zoom.steadyOffset.width + dragTranslation.width,
            height: zoom.steadyOffset.height + dragTranslation.height
        )
    }

    private var magnifyGesture: some Gesture {
        MagnifyGesture()
            .updating($magnificationFactor) { value, state, _ in
                state = value.magnification
            }
            .onEnded { value in
                withAnimation(.spring) { zoom.endMagnification(factor: value.magnification) }
            }
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                if ImageViewerZoomModel.shouldDismiss(onSwipeTranslation: value.translation, isZoomedIn: zoom.isZoomedIn) {
                    dismiss()
                } else if zoom.isZoomedIn {
                    zoom.endPan(translation: value.translation)
                }
                // Unzoomed + below the dismiss threshold: nothing to commit —
                // `@GestureState` resets `dragTranslation` to zero, snapping
                // the image back.
            }
    }

    private func load() async {
        let loaded = await ImageViewerLoading.loadViewerImage(canonicalURL: item.canonicalURL, resolver: resolver, loader: loader)
        if let loaded {
            image = loaded
            failed = false
        } else {
            // Keep the initial (display) image when the network is gone —
            // only a viewer with nothing at all to show reports failure.
            failed = image == nil
        }
    }
}

/// Free-standing (mirroring `WorkspaceMarkdownImageLoading`) so the viewer's
/// original-then-canonical loading order is unit-testable without a SwiftUI
/// host.
public enum ImageViewerLoading {
    /// Resolve `canonicalURL` to the viewer URL (original when available),
    /// fetch it through `loader` and raster-decode. When the ORIGINAL fetch
    /// or decode fails, fall back to fetching the canonical URL itself —
    /// the viewer must never display worse than the body did. Returns `nil`
    /// only when every path fails.
    public static func loadViewerImage(
        canonicalURL: URL,
        resolver: any ViewerImageURLResolving,
        loader: any WorkspaceImageFetching
    ) async -> PlatformImage? {
        let resolvedString = await resolver.viewerImageURLString(for: canonicalURL)
        if let resolvedURL = URL(string: resolvedString),
            let original = await WorkspaceMarkdownImageLoading.loadImage(url: resolvedURL, using: loader) {
            return original
        }
        // Already fell back to canonical at the resolver level (or the
        // resolved URL string didn't parse back) — a second fetch of the
        // same URL would just fail the same way.
        guard resolvedString != canonicalURL.absoluteString else { return nil }
        return await WorkspaceMarkdownImageLoading.loadImage(url: canonicalURL, using: loader)
    }
}

/// The viewer's zoom/pan/dismiss state transitions, extracted as a pure
/// value type so `ImageViewerViewTests` can drive them directly (SwiftUI
/// gesture callbacks themselves cannot be synthesized from `swift test`).
struct ImageViewerZoomModel: Equatable {
    /// The committed (post-gesture) zoom scale; in-flight pinch state lives
    /// in the view's `@GestureState` and multiplies on top of this.
    var steadyScale: CGFloat = 1
    /// The committed pan offset; in-flight drag state lives in the view's
    /// `@GestureState` and adds on top of this.
    var steadyOffset: CGSize = .zero

    static let minScale: CGFloat = 1
    static let maxScale: CGFloat = 6
    static let doubleTapZoomScale: CGFloat = 2.5
    /// How far down an unzoomed swipe must travel before ending it
    /// dismisses the viewer.
    static let dismissTranslationThreshold: CGFloat = 120

    var isZoomedIn: Bool { steadyScale > Self.minScale }

    /// Commit a finished pinch: multiply into the steady scale, clamped to
    /// `[minScale, maxScale]`; landing back at 1x also recenters (a stale
    /// pan offset on an unzoomed image would leave it stuck off-center).
    mutating func endMagnification(factor: CGFloat) {
        steadyScale = min(max(steadyScale * factor, Self.minScale), Self.maxScale)
        if !isZoomedIn {
            steadyOffset = .zero
        }
    }

    /// Commit a finished pan while zoomed in.
    mutating func endPan(translation: CGSize) {
        steadyOffset.width += translation.width
        steadyOffset.height += translation.height
    }

    /// Double-tap: zoomed-in → back to fit (recentered); fit → a fixed
    /// comfortable zoom.
    mutating func toggleDoubleTapZoom() {
        if isZoomedIn {
            steadyScale = Self.minScale
            steadyOffset = .zero
        } else {
            steadyScale = Self.doubleTapZoomScale
        }
    }

    /// Swipe-to-dismiss applies ONLY while unzoomed — while zoomed in the
    /// same drag is a pan, so a downward pan across a zoomed image never
    /// accidentally closes the viewer.
    static func shouldDismiss(onSwipeTranslation translation: CGSize, isZoomedIn: Bool) -> Bool {
        !isZoomedIn && translation.height > dismissTranslationThreshold
    }
}
