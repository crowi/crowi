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
///
/// A user with no picture gets the same generated face the web draws
/// (`CrowiBeamAvatarView`), seeded by `seed`. Call sites that pass nothing
/// keep the SF Symbol placeholder — that is the "this row knows nothing about
/// a person" state, which is different from "this person has no picture".
///
/// `seed` must be the USERNAME wherever one is available: the web seeds on
/// `user.username || displayName`, and seeding on the display name instead
/// would give the same person two different faces depending on which client
/// is open.
public struct WorkspaceAvatarView: View {
    private let imageURLString: String?
    private let loader: any WorkspaceImageFetching
    private let size: CGFloat
    private let seed: String?

    @State private var image: PlatformImage?

    public init(
        imageURLString: String?,
        loader: any WorkspaceImageFetching,
        size: CGFloat = 32,
        seed: String? = nil
    ) {
        self.imageURLString = imageURLString
        self.loader = loader
        self.size = size
        self.seed = seed
    }

    /// One or two letters standing in for a name.
    ///
    /// Two initials for a multi-word name (first word + LAST word — a middle
    /// name must not displace the family name), one leading character
    /// otherwise, which is also what a single-token CJK name such as
    /// 「柄沢聡太郎」 wants: there is no word boundary to split on, and its
    /// first character is the family name. `nil` for a missing or
    /// whitespace-only name.
    ///
    /// Users no longer use this — they get a generated face. It stays because
    /// a WORKSPACE mark is still initials (`CrowiWorkspaceIconButton`): a
    /// workspace is not a person, and a face would say it was.
    public static func initials(from name: String?) -> String? {
        guard let name else { return nil }
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return nil }
        guard words.count > 1, let last = words.last?.first else {
            return String(first).uppercased()
        }
        return (String(first) + String(last)).uppercased()
    }

    /// Whether a seed names anybody. Whitespace-only is not a person, and
    /// generating a face for `"   "` would give every such row the same one.
    static func generatedFaceSeed(from seed: String?) -> String? {
        guard let seed, !seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return seed
    }

    public var body: some View {
        Group {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let generated = Self.generatedFaceSeed(from: seed) {
                CrowiBeamAvatarView(name: generated, diameter: size)
            } else {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        // The name is already read out by the row's own metadata line; a
        // VoiceOver pass that also says "S K" is noise.
        .accessibilityHidden(true)
        .task(id: imageURLString) {
            image = nil
            guard let imageURLString, let url = URL(string: imageURLString) else { return }
            image = await WorkspaceMarkdownImageLoading.loadImage(url: url, using: loader)
        }
    }
}
