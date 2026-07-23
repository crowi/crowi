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

    public init(loader: any WorkspaceImageFetching) {
        self.loader = loader
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
        guard let platformImage = await WorkspaceMarkdownImageLoading.loadImage(url: url, using: loader) else {
            throw WorkspaceMarkdownInlineImageLoadFailure()
        }
        let scaled = WorkspaceInlineImageDownscaling.downscaledForInlineDisplay(platformImage)
        return Image(platformImage: scaled)
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
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)

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
            from: CGRect(origin: .zero, size: size),
            operation: .sourceOver,
            fraction: 1.0
        )
        resized.unlockFocus()
        return resized
        #endif
    }
}
