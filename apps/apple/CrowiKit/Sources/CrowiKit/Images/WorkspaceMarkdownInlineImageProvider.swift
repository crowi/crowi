import MarkdownUI
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// RFC-0016 §6.1 — the **inline** counterpart to `WorkspaceMarkdownImageProvider`.
///
/// swift-markdown-ui renders an image node through one of TWO independent
/// environment keys, chosen by cmark-gfm's own parse shape, not by anything
/// this app controls:
///   - a paragraph that is JUST an image (`![alt](url)` alone on its line)
///     parses to a block `.image` node → `ImageView` → `\.imageProvider`
///     (`WorkspaceMarkdownImageProvider`, wired in `WorkspacePageMarkdownView`);
///   - a paragraph where the image shares a line with other inline content —
///     crucially, crowi's own image-attribute markdown extension
///     `![alt](url){width=500px}` is exactly this shape: cmark-gfm parses it
///     as an image inline node FOLLOWED BY a text inline node holding the
///     literal `{width=500px}` — parses to `InlineText` → `\.inlineImageProvider`.
/// Gate C (Phase 0) only ever exercised the first shape. Any page body using
/// the width/height attribute markdown — or, more generally, any image that
/// is not alone on its own paragraph line — fell through to
/// swift-markdown-ui's OWN default (`DefaultInlineImageProvider`, backed by
/// `NetworkImage`): an unauthenticated fetch that also never receives the
/// workspace's Bearer token and, without `imageBaseURL` wired on `Markdown(...)`,
/// cannot even resolve crowi's relative attachment URLs (`/api/v2/attachments/<id>`)
/// to begin with. Net effect: every inline-shaped image silently rendered
/// nothing.
///
/// This provider closes that gap by reusing the EXACT SAME
/// `WorkspaceMarkdownImageLoading.loadImage(url:using:)` pipeline the block
/// provider already uses — the same `WorkspaceImageFetching` conformer, so
/// the same §6.1 same-origin-Bearer-attach + redirect-strip rule applies to
/// inline images too, with no second, drifted auth path.
///
/// Usage — always paired with `.markdownImageProvider(WorkspaceMarkdownImageProvider(...))`
/// on the SAME `Markdown` view, never alone (`WorkspacePageMarkdownView` wires both):
/// ```swift
/// Markdown(pageBody, imageBaseURL: workspaceOrigin)
///     .markdownImageProvider(WorkspaceMarkdownImageProvider(loader: imageLoader))
///     .markdownInlineImageProvider(WorkspaceMarkdownInlineImageProvider(loader: imageLoader))
/// ```
public struct WorkspaceMarkdownInlineImageProvider: InlineImageProvider {
    private let loader: any WorkspaceImageFetching
    private let containerWidth: InlineImageContainerWidthReference?

    /// - Parameter containerWidth: the measured markdown-column width a
    ///   `width=<n>%` inline image resolves against
    ///   (`WorkspacePageMarkdownView` owns the measurement and always passes
    ///   one). `nil` — a provider constructed without a measuring host —
    ///   keeps `%` unapplied, never guessed.
    public init(loader: any WorkspaceImageFetching, containerWidth: InlineImageContainerWidthReference? = nil) {
        self.loader = loader
        self.containerWidth = containerWidth
    }

    /// `InlineImageProvider`'s contract (`swift-markdown-ui`'s `InlineText`)
    /// is `async throws -> Image` — there is no "return a placeholder" option
    /// the way the block `ImageProvider.makeImage(url:)` path has (a `View`
    /// that can show `Color.clear` while `@State` is nil). `loadImage`
    /// already collapses every failure (disallowed scheme, non-2xx, bytes
    /// that don't decode as a raster image) into `nil`; this just re-surfaces
    /// that as a throw so the failing image renders as empty rather than
    /// crashing or hanging — matching swift-markdown-ui's own
    /// `DefaultInlineImageProvider`, which propagates its network loader's
    /// errors the same way. Per swift-markdown-ui's `InlineText.loadInlineImages()`,
    /// a throw here fails the WHOLE `withThrowingTaskGroup` for that
    /// paragraph, so any other inline image sharing the same line also comes
    /// back blank — an accepted, upstream-inherited degrade (Phase 1), not
    /// something this provider can avoid while staying within the protocol's
    /// throwing contract.
    public func image(with url: URL, label: String) async throws -> Image {
        // Detach the RFC-0015 `#crowi-image-attrs:` side-channel FIRST — the
        // URL that reaches `loadImage` (and through it the loader/disk-cache/
        // allowlist stack) stays byte-identical to the pre-carry one. The
        // inline path applies width only (`px` directly, `%` against the
        // measured container — see `applyingInlineWidth`), mirroring the
        // server's own inline branch (`image-attrs.ts` — `align`/`float` are
        // discarded entirely for an image sharing a line with other inline
        // content, while width/height stay applied).
        let extraction = ImageDisplayAttributes.extract(from: url)
        guard let platformImage = await WorkspaceMarkdownImageLoading.loadImage(url: extraction.url, using: loader) else {
            throw WorkspaceMarkdownInlineImageLoadFailure()
        }
        let capped = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(platformImage)
        let scaled = WorkspaceInlineImageDownscaling.applyingInlineWidth(
            extraction.attributes?.width,
            to: capped,
            containerWidth: containerWidth?.width
        )
        return Image(platformImage: scaled)
    }
}

/// The inline path's container-width reference (review round 1 — the piece
/// that makes `width=<n>%` a NATIVE inline application instead of
/// parse-only).
///
/// `InlineImageProvider.image(with:label:)` receives a URL and nothing else —
/// no layout proposal ever reaches it, unlike the block path's
/// `AttributeSizedLayout`. To give a `%` inline image the same reference box
/// the web resolves against (CSS `width: 60%` of the containing block = the
/// markdown text column), `WorkspacePageMarkdownView` measures its own
/// rendered width and publishes it through this shared, lock-protected box;
/// the provider reads the latest measurement at load time. `nil` (not yet
/// measured — a standalone provider, or an image load racing the very first
/// layout pass) degrades to "unapplied", never a guessed width; the next
/// body re-render re-loads inline images with the measurement in place.
///
/// A reference type on purpose: the provider is a value stored in a SwiftUI
/// environment, created fresh on every render — the box is the ONE stable
/// identity (held in `@State` by the measuring view) both sides share.
public final class InlineImageContainerWidthReference: @unchecked Sendable {
    private let lock = NSLock()
    private var measuredWidth: CGFloat?

    public init() {}

    public var width: CGFloat? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return measuredWidth
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            measuredWidth = newValue
        }
    }
}

/// Thrown by `WorkspaceMarkdownInlineImageProvider.image(with:label:)` when
/// `WorkspaceMarkdownImageLoading.loadImage` returns `nil` — no case needs to
/// distinguish transport vs. decode failure here since swift-markdown-ui
/// treats any thrown error identically (the image is simply not shown).
struct WorkspaceMarkdownInlineImageLoadFailure: Error {}

/// The inline path's last line of defense against oversized images.
///
/// `InlineImageProvider.image(with:label:)` returns a bare `Image` value,
/// which swift-markdown-ui embeds via `Text(image:)`
/// (`TextInlineRenderer.renderImage`, swift-markdown-ui's
/// `Renderer/TextInlineRenderer.swift`) — an image concatenated into `Text`
/// renders at its native bitmap size with no frame/aspectRatio modifier able
/// to constrain it afterwards (unlike the block `ImageProvider` path, which
/// returns an ordinary `View` `WorkspaceMarkdownImageProvider` can size with
/// `.resizable().scaledToFit().frame(maxWidth: .infinity)`). The only lever
/// left, this deep in the pipeline, is the decoded BITMAP's own pixel size —
/// so this downscales the bitmap itself before it ever becomes an `Image`.
///
/// This is a backstop, not the primary fix: after
/// `ImageAttributeBlockPreprocessor` strips a trailing attribute block, most
/// previously-inline attributed images fall back to the block path anyway.
/// This only matters for images that stay genuinely inline — sharing a line
/// with real surrounding text/other inline content.
enum WorkspaceInlineImageDownscaling {
    /// An arbitrary but generous cap — comfortably larger than any device
    /// screen dimension in points, so a normal-sized inline image (an emoji,
    /// a small icon) is never touched, while a full-resolution photo or
    /// screenshot embedded inline no longer renders many times wider than
    /// the screen.
    static let defaultMaxDimension: CGFloat = 1024

    /// Returns `image` unchanged if its longest edge is already within
    /// `maxDimension`; otherwise returns a redrawn copy scaled down
    /// (preserving aspect ratio) so its longest edge equals `maxDimension`.
    static func downscaledForInlineDisplay(_ image: PlatformImage, maxDimension: CGFloat = defaultMaxDimension) -> PlatformImage {
        let size = image.size
        let longestEdge = max(size.width, size.height)
        guard longestEdge > maxDimension, longestEdge > 0 else { return image }

        let scale = maxDimension / longestEdge
        return redrawn(image, in: CGSize(width: size.width * scale, height: size.height * scale))
    }

    /// RFC-0015 inline-path width application
    /// (`feature-ios-phase3-notifications-extensions`): the only lever the
    /// inline path has is the bitmap's own point size (see this type's doc
    /// comment), so an already-validated width resizes the bitmap (up OR
    /// down — CSS `width` scales both ways), capped at `defaultMaxDimension`
    /// ("smaller wins", the same composition rule the block path applies
    /// against its container):
    ///   - `width=<n>px` targets `n` points directly;
    ///   - `width=<n>%` (review round 1 — previously parse-only) resolves
    ///     against `containerWidth`, the measured markdown-column width
    ///     `InlineImageContainerWidthReference` carries — the same reference
    ///     box the web's CSS `width: <n>%` and the block path's
    ///     `AttributeSizedLayout` resolve against. Without a usable
    ///     measurement (`nil`/zero — a load racing the very first layout
    ///     pass) the bitmap passes through untouched: degrade, never guess.
    static func applyingInlineWidth(
        _ width: ImageDisplayAttributes.Size?,
        to image: PlatformImage,
        containerWidth: CGFloat? = nil
    ) -> PlatformImage {
        guard let width else { return image }
        let requestedWidth: CGFloat
        switch width.unit {
        case .pixels:
            requestedWidth = CGFloat(width.number)
        case .percent:
            guard let containerWidth, containerWidth.isFinite, containerWidth > 0 else { return image }
            requestedWidth = containerWidth * CGFloat(width.number) / 100
        }
        let size = image.size
        let targetWidth = min(requestedWidth, defaultMaxDimension)
        guard size.width > 0, size.height > 0, abs(size.width - targetWidth) > 0.5 else { return image }
        let scale = targetWidth / size.width
        return redrawn(image, in: CGSize(width: targetWidth, height: size.height * scale))
    }

    private static func redrawn(_ image: PlatformImage, in targetSize: CGSize) -> PlatformImage {
        #if canImport(UIKit)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        #elseif canImport(AppKit)
        let resized = NSImage(size: targetSize)
        resized.lockFocus()
        image.draw(
            in: CGRect(origin: .zero, size: targetSize),
            from: CGRect(origin: .zero, size: image.size),
            operation: .sourceOver,
            fraction: 1.0
        )
        resized.unlockFocus()
        return resized
        #endif
    }
}
