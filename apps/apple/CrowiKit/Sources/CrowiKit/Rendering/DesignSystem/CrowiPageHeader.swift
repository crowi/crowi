import SwiftUI

/// feature-ios-visual-redesign Phase 3 — the page reader's title block, above
/// the rendered body: breadcrumb → title → author byline → read-only stats →
/// hairline.
///
/// The stats here are DELIBERATELY read-only. The design splits engagement in
/// two: the counts a reader glances at live in the header, and the toggles
/// live in the floating pill (`CrowiPageActionBar`). Adding a tap to these
/// numbers would recreate the inline engagement bar this replaced and leave
/// the page with two ways to like it.
///
/// Nothing here re-derives a page's display name or its relative timestamp:
/// `PageRowTitleLabel` remains the sole owner of the first rule (ported from
/// the web and pinned against the shared fixture table) and
/// `PageRowMetadataLabel` of the second (the ISO-8601 parse + the cached
/// relative formatter). This view only composes them into the design's layout.
public struct CrowiPageHeader: View {
    private let path: String
    private let updaterName: String?
    private let updaterImage: String?
    private let updatedAt: String?
    private let seenCount: Int
    private let likeCount: Int
    private let commentCount: Int
    private let loader: any WorkspaceImageFetching

    @ScaledMetric(relativeTo: .subheadline) private var avatarSize: CGFloat = CrowiMetrics.pageHeaderAvatarSize

    public init(
        path: String,
        updaterName: String?,
        updaterImage: String?,
        updatedAt: String?,
        seenCount: Int,
        likeCount: Int,
        commentCount: Int,
        loader: any WorkspaceImageFetching
    ) {
        self.path = path
        self.updaterName = updaterName
        self.updaterImage = updaterImage
        self.updatedAt = updatedAt
        self.seenCount = seenCount
        self.likeCount = likeCount
        self.commentCount = commentCount
        self.loader = loader
    }

    /// The design's `Home / Survey / dev / release / 2026` trail.
    ///
    /// It is the page's PARENT path, not the full one: the title right under
    /// it already shows the display name, which for a date page
    /// (`/user/foo/日報/2026/05/23`) is a whole trailing run of segments —
    /// printing them in the trail too would say the same thing twice, three
    /// lines apart. `PageRowTitleLabel.displayParent` is the same split the
    /// list rows use, so the two surfaces agree by construction.
    ///
    /// Always starts with "Home" (the design's own first crumb), which is also
    /// the entire trail for a root-level page.
    public static func breadcrumb(for path: String) -> [String] {
        let parent = PageRowTitleLabel.displayParent(for: path)
        return ["Home"] + parent.split(separator: "/").map(String.init)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            breadcrumbRow
                .padding(.bottom, CrowiMetrics.pageHeaderSpacing)
            // `PageRowTitleLabel`'s own hero-line rule (display name, or the
            // raw path when there is none), borrowed rather than re-derived —
            // the row it draws is two truncated lines, which is not what a
            // hero title wants, but the STRING is exactly the same one.
            Text(PageRowTitleLabel(path: path).titleText)
                .font(CrowiTypography.pageTitle)
                .tracking(CrowiTypography.pageTitleTracking)
                .foregroundStyle(CrowiTheme.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, CrowiMetrics.pageHeaderTitleSpacing)
            if bylineText != nil || hasUpdater {
                bylineRow
                    .padding(.bottom, CrowiMetrics.pageHeaderSpacing)
            }
            statsRow
                .padding(.bottom, CrowiMetrics.pageHeaderBottomPadding)
            CrowiRowSeparator()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Breadcrumb

    private var breadcrumbRow: some View {
        let segments = Self.breadcrumb(for: path)
        // ONE concatenated `Text`, not an `HStack` of them: the design's trail
        // is `flex-wrap:wrap`, and an `HStack` cannot wrap — a deep path would
        // squeeze every crumb into its own ellipsis instead. Concatenation
        // keeps the per-crumb colouring AND lets the line break like prose.
        return segments.enumerated()
            .reduce(Text("")) { trail, item in
                let separator = item.offset > 0
                    ? Text(" / ").foregroundStyle(CrowiTheme.border)
                    : Text("")
                // The design tints the LAST crumb — here, the directory this
                // page actually sits in.
                let isLast = item.offset == segments.count - 1
                let crumb = Text(item.element)
                    .foregroundStyle(isLast ? CrowiTheme.primary : CrowiTheme.mutedForeground)
                return trail + separator + crumb
            }
            .font(CrowiTypography.rowPath)
            .lineLimit(2)
            // Deep paths lose their MIDDLE, never their tail: the directory a
            // page sits in is the part worth keeping.
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Display only — the design's trail is not interactive, and the
            // page tree (which knows which of these segments are real pages
            // and which are bare directories) is the app's actual way up.
            .accessibilityLabel("In \(segments.joined(separator: " / "))")
    }

    // MARK: - Byline

    private var hasUpdater: Bool { updaterName != nil || updaterImage != nil }

    /// "**Sotaro Karasawa** · Updated 53m ago" — the name in `foreground`, the
    /// timestamp muted, as the design draws it. Degrades exactly the way
    /// `PageRowMetadataLabel`'s ladder does: either half may be missing, and
    /// when both are the row disappears instead of leaving a gap.
    private var bylineText: Text? {
        let name = updaterName.map { Text($0).foregroundStyle(CrowiTheme.foreground) }
        let time = PageRowMetadataLabel.relativeTimeText(from: updatedAt)
            .map { Text("Updated \($0)").foregroundStyle(CrowiTheme.mutedForeground) }
        switch (name, time) {
        case (let name?, let time?):
            return name + Text(" · ").foregroundStyle(CrowiTheme.mutedForeground) + time
        case (let name?, nil):
            return name
        case (nil, let time?):
            return time
        case (nil, nil):
            return nil
        }
    }

    private var bylineRow: some View {
        HStack(spacing: CrowiMetrics.pageHeaderBylineSpacing) {
            if hasUpdater {
                WorkspaceAvatarView(
                    imageURLString: updaterImage,
                    loader: loader,
                    size: avatarSize,
                    initialsSource: updaterName
                )
            }
            if let bylineText {
                bylineText
                    .font(CrowiTypography.pageByline)
                    .lineLimit(2)
            }
        }
    }

    // MARK: - Stats

    private var statsRow: some View {
        HStack(spacing: CrowiMetrics.pageHeaderStatsSpacing) {
            stat(count: seenCount, systemImage: "eye", singular: "view", plural: "views")
            stat(count: likeCount, systemImage: "heart", singular: "like", plural: "likes")
            stat(count: commentCount, systemImage: "bubble.left", singular: "comment", plural: "comments")
        }
        .font(CrowiTypography.pageStats)
        .foregroundStyle(CrowiTheme.mutedForeground)
    }

    private func stat(count: Int, systemImage: String, singular: String, plural: String) -> some View {
        Label("\(count) \(count == 1 ? singular : plural)", systemImage: systemImage)
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
            // Three stats on one row: at an accessibility text size they
            // shrink together instead of truncating into "12 vie…".
            .minimumScaleFactor(0.7)
    }
}
