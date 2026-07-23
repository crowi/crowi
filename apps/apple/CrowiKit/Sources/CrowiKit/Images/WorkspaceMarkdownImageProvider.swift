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

    public init(loader: any WorkspaceImageFetching) {
        self.loader = loader
    }

    public func makeImage(url: URL?) -> some View {
        WorkspaceMarkdownImageView(url: url, loader: loader)
    }
}

/// The `View` swift-markdown-ui renders per image node. Delegates the actual
/// fetch+decode to `WorkspaceMarkdownImageLoading.loadImage`, kept as a free
/// function (rather than inlined in `.task`) specifically so
/// `WorkspaceMarkdownImageProviderTests` can exercise the full
/// loader → decode pipeline directly, without rendering or inspecting a live
/// SwiftUI view tree.
struct WorkspaceMarkdownImageView: View {
    let url: URL?
    let loader: any WorkspaceImageFetching

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
                // bounded proposal ever reaches it. `.frame(maxWidth:
                // .infinity)` makes that bound explicit and unconditional
                // here, at the one place every block-path image renders,
                // instead of depending on every future call site composing
                // this view inside a width-constrained container.
                Image(platformImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
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
