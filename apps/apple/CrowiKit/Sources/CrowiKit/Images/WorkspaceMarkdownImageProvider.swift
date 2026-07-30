import MarkdownUI
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// `feature-ios-phase1-read` — the seam `WorkspaceImageLoader.fetch(_:)` and
/// `WorkspaceImageDiskCache.fetch(_:)` both satisfy: "give me decodable bytes
/// for this URL". Generalizing `WorkspaceMarkdownImageProvider` over this
/// protocol (rather than the concrete `WorkspaceImageLoader`) is what lets
/// Phase 1's real reader UI pass the real per-workspace disk cache — the
/// §7.2 wrapper this phase adds — through the EXACT SAME, already-proven
/// (Phase 0 AC-4) renderer integration, with zero change to that wiring.
public protocol WorkspaceImageFetching: Sendable {
    func fetch(_ urlString: String) async throws -> Data
}

extension WorkspaceImageLoader: WorkspaceImageFetching {}

/// Phase 0 gate C — the AC-4 renderer integration: wires a
/// `WorkspaceImageFetching` conformer (the §6.1 same-origin-Bearer +
/// redirect-strip fetch, already proven against a real local dev attachment
/// — see `WorkspaceImageLoaderTests`) into swift-markdown-ui's
/// `ImageProvider` extension point, so a `Markdown` view configured with
/// this provider renders an **authenticated** workspace attachment through
/// the guarded transport, instead of swift-markdown-ui's own built-in
/// `.default` provider (`NetworkImage`, unauthenticated — it would never
/// attach the workspace's Bearer token nor strip it on a cross-origin
/// redirect).
///
/// Usage — the real reader UI passes the per-workspace `WorkspaceImageDiskCache`
/// (`WorkspaceContext.makeImageCache()`), never a bare loader constructed ad
/// hoc from a view:
/// ```swift
/// Markdown(pageBody)
///     .markdownImageProvider(WorkspaceMarkdownImageProvider(loader: workspaceSession.imageCache))
/// ```
public struct WorkspaceMarkdownImageProvider: ImageProvider {
    private let loader: any WorkspaceImageFetching
    private let onImageTap: ((URL, PlatformImage) -> Void)?

    /// - Parameter onImageTap: `feature-ios-image-viewer` — invoked with the
    ///   image's (already-rebased) URL and its decoded bitmap when the user
    ///   taps a successfully-rendered block image. `nil` (the default) keeps
    ///   every image non-tappable. Only the BLOCK path carries this: the
    ///   inline path's `InlineImageProvider` contract returns a bare
    ///   `Image` value concatenated into `Text`, which cannot carry a
    ///   gesture — and `ImageAttributeBlockPreprocessor.strip` already
    ///   restores attribute-annotated images to the block path, so a
    ///   genuinely-inline image (sharing a line with real text) staying
    ///   non-tappable is the accepted degrade.
    public init(loader: any WorkspaceImageFetching, onImageTap: ((URL, PlatformImage) -> Void)? = nil) {
        self.loader = loader
        self.onImageTap = onImageTap
    }

    public func makeImage(url: URL?) -> some View {
        Self.makeImageView(url: url, loader: loader, onImageTap: onImageTap)
    }

    /// The concrete view behind `makeImage` — the ONE place the block path
    /// detaches the RFC-0015 `#crowi-image-attrs:` side-channel
    /// (`ImageDisplayAttributes.extract(from:)`): everything downstream
    /// (fetch, disk-cache key, scheme allowlist, tap/viewer canonical URL)
    /// sees the byte-identical pre-carry URL, and only the render layer sees
    /// the attributes. Internal (not folded into `makeImage`) so
    /// `WorkspaceMarkdownImageProviderTests` can pin the detach wiring
    /// without inspecting an opaque `some View`.
    static func makeImageView(url: URL?, loader: any WorkspaceImageFetching, onImageTap: ((URL, PlatformImage) -> Void)?)
        -> WorkspaceMarkdownImageView
    {
        let extraction = url.map(ImageDisplayAttributes.extract(from:))
        return WorkspaceMarkdownImageView(
            url: extraction?.url ?? url,
            attributes: extraction?.attributes,
            loader: loader,
            onImageTap: onImageTap
        )
    }
}

/// The `View` swift-markdown-ui renders per image node. Delegates the actual
/// fetch+decode to `WorkspaceMarkdownImageLoading.loadImage`, kept as a free
/// function (rather than inlined in `.task`) specifically so
/// `WorkspaceMarkdownImageProviderTests` can exercise the full
/// loader → decode pipeline directly, without rendering or inspecting a live
/// SwiftUI view tree.
struct WorkspaceMarkdownImageView: View {
    /// Always the CLEANED URL (`ImageDisplayAttributes.extract` already ran
    /// in `makeImageView`) — byte-identical to what this view received
    /// before the RFC-0015 carry existed.
    let url: URL?
    let attributes: ImageDisplayAttributes?
    let loader: any WorkspaceImageFetching
    let onImageTap: ((URL, PlatformImage) -> Void)?

    @State private var image: PlatformImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                // `.resizable().scaledToFit()` alone constrains the image to
                // whatever width its ancestor actually PROPOSES, but
                // swift-markdown-ui's own `image` block style is a bare
                // passthrough (`Theme.image = { $0.label }` — no frame at
                // all), so nothing upstream of this provider guarantees a
                // bounded proposal ever reaches it.
                // `ImageDisplayAttributedBlockFrame` makes that bound
                // explicit and unconditional here, at the one place every
                // block-path image renders — with `attributes == nil` it IS
                // the previous `.frame(maxWidth: .infinity)`, and with
                // attributes it additionally applies the RFC-0015
                // width/align/float (server-identical DROP validation
                // already happened at parse/extract time).
                ImageDisplayAttributedBlockFrame(attributes: attributes) {
                    let rendered = Image(platformImage: image)
                        .resizable()
                        .scaledToFit()
                    // `feature-ios-image-viewer` — the tap gesture exists
                    // ONLY on this branch (a successfully-decoded raster
                    // image): an inert image (disallowed scheme / fetch or
                    // decode failure) renders the zero-size placeholder
                    // below, which structurally cannot carry the gesture —
                    // "inert images are not tappable" holds by construction,
                    // not by a runtime check. The gesture sits on the image
                    // itself, inside the alignment frame, so the empty
                    // margin an aligned/sized image leaves is not tappable.
                    if WorkspaceMarkdownImageTapPolicy.isTapEnabled(decodedImage: image, url: url, hasTapHandler: onImageTap != nil),
                        let url, let onImageTap {
                        rendered
                            .onTapGesture { onImageTap(url, image) }
                            .accessibilityAddTraits(.isButton)
                    } else {
                        rendered
                    }
                }
            } else {
                // Zero-size placeholder while loading/on failure — matches
                // swift-markdown-ui's own `DefaultImageProvider` failure
                // presentation (never a broken-image glyph; §6.1's SVG-DOM
                // guard means decode failures are a plain miss, not a retry
                // into an unsandboxed renderer).
                Color.clear.frame(width: 0, height: 0)
            }
        }
        .task(id: url) {
            guard !failed else { return }
            image = await WorkspaceMarkdownImageLoading.loadImage(url: url, using: loader)
            failed = image == nil
        }
    }
}

/// `feature-ios-image-viewer` — the tap-activation rule
/// `WorkspaceMarkdownImageView` consumes, free-standing (mirroring
/// `WorkspaceMarkdownImageLoading`) so it is unit-testable without a SwiftUI
/// host: a tap is active only for a successfully-decoded image with a real
/// URL AND a configured handler — never for a loading/failed/inert image,
/// and never when the hosting screen didn't opt into the viewer.
enum WorkspaceMarkdownImageTapPolicy {
    static func isTapEnabled(decodedImage: PlatformImage?, url: URL?, hasTapHandler: Bool) -> Bool {
        decodedImage != nil && url != nil && hasTapHandler
    }
}

/// Free-standing so it is unit-testable without a SwiftUI host.
public enum WorkspaceMarkdownImageLoading {
    /// Fetches `url` through `loader` (same-origin-Bearer attached,
    /// redirect-stripped per §6.1) and decodes the raw bytes into a raster
    /// `PlatformImage` — never a web/SVG-DOM context, per §6.1's guard.
    /// Returns `nil` on any transport or decode failure (never throws) since
    /// the caller only needs a presence/absence signal to pick a placeholder.
    public static func loadImage(url: URL?, using loader: any WorkspaceImageFetching) async -> PlatformImage? {
        guard let url else { return nil }
        guard let data = try? await loader.fetch(url.absoluteString) else { return nil }
        return PlatformImage(data: data)
    }
}

#if canImport(UIKit)
public typealias PlatformImage = UIImage
#elseif canImport(AppKit)
public typealias PlatformImage = NSImage
#endif

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #elseif canImport(AppKit)
        self.init(nsImage: platformImage)
        #endif
    }
}
