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
/// feature-ios-visual-redesign Phase 1 adds the design's INITIALS fallback
/// (`SK` on a `--primary` disc) as an opt-in: pass `initialsSource` — the
/// user's display name — and a user with no avatar image reads as a person
/// rather than as the same anonymous glyph as everyone else. Call sites that
/// pass nothing keep the SF Symbol placeholder exactly as before.
///
/// The disc is `CrowiTheme.primary` for EVERY user, not a per-user hue. The
/// design mocks one colour per person, but there is no colour assignment
/// anywhere in the product to agree with — the web's own avatar renders
/// initials on `--crowi-primary`
/// (`packages/web/src/components/user-avatar.tsx`), and inventing a second,
/// iOS-only hashing scheme here would make the same person a different colour
/// on each client.
public struct WorkspaceAvatarView: View {
    private let imageURLString: String?
    private let loader: any WorkspaceImageFetching
    private let size: CGFloat
    private let initialsSource: String?

    @State private var image: PlatformImage?

    public init(
        imageURLString: String?,
        loader: any WorkspaceImageFetching,
        size: CGFloat = 32,
        initialsSource: String? = nil
    ) {
        self.imageURLString = imageURLString
        self.loader = loader
        self.size = size
        self.initialsSource = initialsSource
    }

    /// One or two letters standing in for a missing avatar image.
    ///
    /// Two initials for a multi-word name (first word + LAST word — a middle
    /// name must not displace the family name), one leading character
    /// otherwise, which is also what a single-token CJK name such as
    /// 「柄沢聡太郎」 wants: there is no word boundary to split on, and its
    /// first character is the family name. `nil` for a missing or
    /// whitespace-only name, which falls back to the SF Symbol rather than
    /// painting an empty disc.
    public static func initials(from name: String?) -> String? {
        guard let name else { return nil }
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return nil }
        guard words.count > 1, let last = words.last?.first else {
            return String(first).uppercased()
        }
        return (String(first) + String(last)).uppercased()
    }

    public var body: some View {
        Group {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let initials = Self.initials(from: initialsSource) {
                CrowiTheme.primary
                    .overlay {
                        Text(initials)
                            // Design: 12.5px inside the 34px disc. Derived
                            // from `size` so the ratio holds at every call
                            // site's (and every Dynamic Type setting's) disc.
                            .font(.system(size: size * 0.37, weight: .semibold))
                            .foregroundStyle(CrowiTheme.primaryForeground)
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                    }
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
