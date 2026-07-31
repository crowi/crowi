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
    private let loader: any WorkspaceImageFetching

    @ScaledMetric(relativeTo: .headline) private var avatarSize: CGFloat = CrowiMetrics.leadingChipSize

    public init(
        path: String,
        lastUpdatedAt: String?,
        updaterName: String?,
        updaterImage: String?,
        loader: any WorkspaceImageFetching
    ) {
        self.path = path
        self.lastUpdatedAt = lastUpdatedAt
        self.updaterName = updaterName
        self.updaterImage = updaterImage
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
                    initialsSource: updaterName
                )
            }
        } content: {
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                PageRowTitleLabel(path: path)
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
}
