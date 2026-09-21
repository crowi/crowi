import SwiftUI

/// feature-ios-visual-redesign Phase 1 — the design's "recently updated" row,
/// and the one composition every flat page list uses: a 34pt leading avatar,
/// the page's display name over its parent path, the updater/time meta line,
/// and a trailing chevron.
///
/// This is where the two pre-existing shared row pieces meet rather than
/// staying two parallel styles: `PageRowTitleLabel` remains the sole owner of
/// the display-name rule (ported from the web and pinned against the shared
/// fixture table — nothing here re-derives it) and `PageRowMetadataLabel`
/// remains the sole owner of the metadata fallback ladder. This row supplies
/// only what the design adds around them: the leading avatar, the chevron,
/// and the row box.
public struct CrowiPageRow: View {
    private let path: String
    private let lastUpdatedAt: String?
    private let updaterName: String?
    private let updaterImage: String?
    /// Seeds the generated avatar (`WorkspaceAvatarView`) — a display name
    /// would give the same person a different face than the web draws.
    private let updaterUsername: String?
    private let likeCount: Int
    private let commentCount: Int
    private let isArtifact: Bool
    private let loader: any WorkspaceImageFetching


    @ScaledMetric(relativeTo: .headline) private var avatarSize: CGFloat = CrowiMetrics.leadingChipSize
    @ScaledMetric(relativeTo: .caption) private var reactionGlyphSize: CGFloat = 12

    public init(
        path: String,
        lastUpdatedAt: String?,
        updaterName: String?,
        updaterImage: String?,
        updaterUsername: String? = nil,
        likeCount: Int = 0,
        commentCount: Int = 0,
        isArtifact: Bool = false,
        loader: any WorkspaceImageFetching
    ) {
        self.path = path
        self.lastUpdatedAt = lastUpdatedAt
        self.updaterName = updaterName
        self.updaterImage = updaterImage
        self.updaterUsername = updaterUsername
        self.likeCount = likeCount
        self.commentCount = commentCount
        self.isArtifact = isArtifact
        self.loader = loader
    }

    /// Whether the leading avatar slot is occupied.
    ///
    /// Deliberately the SAME condition `PageRowMetadataLabel.hasUpdater`
    /// uses, for the same reason it exists there: an endpoint that does not
    /// populate `lastUpdateUser` at all (`GET /me/recently-viewed-pages`)
    /// must leave the slot empty rather than show a placeholder disc for a
    /// person the row knows nothing about. `CrowiPageRowTests` pins the two
    /// gates against each other so they cannot drift apart.
    public static func showsLeadingAvatar(updaterName: String?, updaterImage: String?) -> Bool {
        updaterName != nil || updaterImage != nil
    }

    public var body: some View {
        CrowiRow {
            if Self.showsLeadingAvatar(updaterName: updaterName, updaterImage: updaterImage) {
                WorkspaceAvatarView(
                    imageURLString: updaterImage,
                    loader: loader,
                    size: avatarSize,
                    seed: updaterUsername ?? updaterName
                )
            }
        } content: {
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    PageRowTitleLabel(path: path)
                    if isArtifact {
                        CrowiArtifactGlyph(size: reactionGlyphSize)
                            .foregroundStyle(CrowiTheme.mutedForeground)
                            .accessibilityLabel("HTML artifact page")
                    }
                    // Pinned to the title line and to the trailing edge, as
                    // the web list draws them — a page's activity belongs
                    // beside its name, not buried in the meta line under it.
                    reactions
                }
                // `showsAvatar: false` — the 34pt avatar above already shows
                // this updater; the label's own inline 14pt one would be the
                // same face a second time, 3pt lower.
                PageRowMetadataLabel(
                    lastUpdatedAt: lastUpdatedAt,
                    updaterName: updaterName,
                    updaterImage: updaterImage,
                    loader: loader,
                    showsAvatar: false
                )
            }
        }
    }

    /// The web's rule, unchanged (`page-list-item.tsx`): each count is shown
    /// only when it is non-zero, so an untouched page carries no chrome at
    /// all and a "0" never competes with a real number for attention.
    @ViewBuilder
    private var reactions: some View {
        if likeCount > 0 || commentCount > 0 {
            Spacer(minLength: 4)
            HStack(spacing: 8) {
                if likeCount > 0 {
                    reaction(systemImage: "hand.thumbsup", count: likeCount, label: "likes")
                }
                if commentCount > 0 {
                    reaction(systemImage: "bubble.left", count: commentCount, label: "comments")
                }
            }
            .foregroundStyle(CrowiTheme.mutedForeground)
        }
    }

    private func reaction(systemImage: String, count: Int, label: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: reactionGlyphSize))
            Text(count, format: .number)
                .font(CrowiTypography.rowMeta)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) \(label)")
    }
}
