import SwiftUI

/// RFC-0016 §6/§9 — a small circular avatar shared by every read screen that
/// displays a user's avatar (own/public profile, comment authors, …). Avatar
/// URLs are `PageUserSchema.image` / `UserProfileResponseSchema.image` values
/// — same-origin, Bearer-gated `by-key/user/<username>` attachment paths
/// (§6.1) — so this is fetched through the SAME `WorkspaceImageFetching`
/// conformer (`WorkspaceImageLoader`/`WorkspaceImageDiskCache`) every other
/// embedded image goes through, never a bare unauthenticated `AsyncImage`
/// (which would never attach the workspace's Bearer token). Falls back to a
/// plain SF Symbol placeholder while loading, on failure, or when there is
/// no image URL at all.
public struct WorkspaceAvatarView: View {
    private let imageURLString: String?
    private let loader: any WorkspaceImageFetching
    private let size: CGFloat

    @State private var image: PlatformImage?

    public init(imageURLString: String?, loader: any WorkspaceImageFetching, size: CGFloat = 32) {
        self.imageURLString = imageURLString
        self.loader = loader
        self.size = size
    }

    public var body: some View {
        Group {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: imageURLString) {
            image = nil
            guard let imageURLString, let url = URL(string: imageURLString) else { return }
            image = await WorkspaceMarkdownImageLoading.loadImage(url: url, using: loader)
        }
    }
}
