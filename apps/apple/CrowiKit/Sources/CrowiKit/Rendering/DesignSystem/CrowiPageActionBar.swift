import SwiftUI

/// feature-ios-visual-redesign Phase 3 — the reader's floating action pill:
/// Edit · | · bookmark · like+count · comments+count · more.
///
/// Same glass as `CrowiTabBar` (`.regularMaterial` in a `Capsule`, hairline
/// rim, shadow on the background shape rather than on the composed bar) —
/// the two are the same element in the design, one per screen kind, and the
/// tab bar's doc comment is the normative explanation of that translation.
/// This one is hosted by the reader as its own `safeAreaInset(edge:.bottom)`,
/// which is only free because the tab bar's inset COLLAPSES the moment a tab
/// pushes anything (`CrowiTabNavigation.isTabBarVisible`) — a page is always
/// a pushed screen, so the two pills can never be inset on top of each other.
///
/// ## The design's one inconsistency
///
/// The exported design draws this first button with a pencil glyph and the
/// label "Edit" but wires its handler to `back` — a leftover from the
/// prototype's fake navigation. The glyph and the label are the intent, so it
/// is an Edit button here (`onEdit` opens the same editor sheet the toolbar
/// used to).
///
/// ## What it does NOT own
///
/// Watch lives in the action sheet (`CrowiPageAction.watch`), not here: the
/// design's pill has four slots and watch is not one of them. The seen count
/// lives in `CrowiPageHeader`'s stats row. Both were on the inline engagement
/// bar this replaced; neither is lost.
public struct CrowiPageActionBar: View {
    private let likeCount: Int
    private let isLiked: Bool
    private let isBookmarked: Bool
    private let commentCount: Int
    private let isTogglingLike: Bool
    private let isTogglingBookmark: Bool
    /// `false` until the reader has built its `PageEngagementModel` (the
    /// cold-cache paint, where the counts on screen come from the cached page
    /// and there is nothing to write to yet). The toggles are then INERT
    /// rather than silently swallowing taps.
    private let isEngagementReady: Bool
    private let isEditable: Bool
    private let onEdit: () -> Void
    private let onToggleBookmark: () -> Void
    private let onToggleLike: () -> Void
    private let onShowComments: () -> Void
    private let onShowActions: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var glyphSize: CGFloat = CrowiMetrics.pageActionBarGlyphSize

    public init(
        likeCount: Int,
        isLiked: Bool,
        isBookmarked: Bool,
        commentCount: Int,
        isTogglingLike: Bool = false,
        isTogglingBookmark: Bool = false,
        isEngagementReady: Bool = true,
        isEditable: Bool = true,
        onEdit: @escaping () -> Void,
        onToggleBookmark: @escaping () -> Void,
        onToggleLike: @escaping () -> Void,
        onShowComments: @escaping () -> Void,
        onShowActions: @escaping () -> Void
    ) {
        self.likeCount = likeCount
        self.isLiked = isLiked
        self.isBookmarked = isBookmarked
        self.commentCount = commentCount
        self.isTogglingLike = isTogglingLike
        self.isTogglingBookmark = isTogglingBookmark
        self.isEngagementReady = isEngagementReady
        self.isEditable = isEditable
        self.onEdit = onEdit
        self.onToggleBookmark = onToggleBookmark
        self.onToggleLike = onToggleLike
        self.onShowComments = onShowComments
        self.onShowActions = onShowActions
    }

    public var body: some View {
        HStack(spacing: CrowiMetrics.pageActionBarItemSpacing) {
            editButton
            Rectangle()
                .fill(CrowiTheme.border)
                .frame(width: CrowiTheme.hairline, height: CrowiMetrics.pageActionBarDividerHeight)
                .accessibilityHidden(true)
            iconButton(
                systemImage: isBookmarked ? "bookmark.fill" : "bookmark",
                tint: isBookmarked ? CrowiTheme.primary : CrowiTheme.foreground,
                label: isBookmarked ? "Remove Bookmark" : "Bookmark",
                action: onToggleBookmark
            )
            .disabled(isTogglingBookmark || !isEngagementReady)
            iconButton(
                systemImage: isLiked ? "heart.fill" : "heart",
                tint: isLiked ? CrowiTheme.primary : CrowiTheme.foreground,
                count: likeCount,
                label: isLiked ? "Unlike" : "Like",
                action: onToggleLike
            )
            .disabled(isTogglingLike || !isEngagementReady)
            iconButton(
                systemImage: "bubble.left",
                tint: CrowiTheme.foreground,
                count: commentCount,
                label: "Comments",
                action: onShowComments
            )
            iconButton(
                systemImage: "ellipsis",
                tint: CrowiTheme.foreground,
                label: "More Actions",
                action: onShowActions
            )
        }
        .padding(.horizontal, CrowiMetrics.pageActionBarInnerHorizontalPadding)
        .padding(.vertical, CrowiMetrics.pageActionBarInnerVerticalPadding)
        .background {
            Capsule(style: .continuous)
                .fill(.regularMaterial)
                // Design: `0 14px 38px -8px rgba(20,30,45,.34)` — a CSS blur
                // radius is twice SwiftUI's, and the negative spread keeps it
                // under the pill rather than around it.
                .shadow(color: .black.opacity(0.2), radius: 19, x: 0, y: 14)
        }
        .overlay {
            Capsule(style: .continuous)
                .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
        }
        .padding(.bottom, CrowiMetrics.pageActionBarBottomInset)
    }

    private var editButton: some View {
        Button(action: onEdit) {
            HStack(spacing: CrowiMetrics.pageActionBarLabelSpacing) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: glyphSize, weight: .regular))
                Text("Edit")
                    .font(CrowiTypography.pillLabel)
                    .lineLimit(1)
                    // The pill is one intrinsic-width capsule and cannot
                    // scroll; at an accessibility text size the label shrinks
                    // a little rather than pushing the toggles off screen.
                    .minimumScaleFactor(0.7)
            }
            .padding(.horizontal, CrowiMetrics.pageActionBarButtonHorizontalPadding)
            .frame(minHeight: CrowiMetrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(CrowiTheme.primary)
        .disabled(!isEditable)
    }

    private func iconButton(
        systemImage: String,
        tint: Color,
        count: Int? = nil,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: CrowiMetrics.pageActionBarLabelSpacing) {
                Image(systemName: systemImage)
                    .font(.system(size: glyphSize, weight: .regular))
                if let count {
                    Text("\(count)")
                        .font(CrowiTypography.pillCount)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, CrowiMetrics.pageActionBarButtonHorizontalPadding)
            // Every slot is a control, so every slot clears 44pt — the design's
            // 8px padding around a ~20px glyph lands well under it on its own
            // (`CrowiRow`'s floor, applied to the pill).
            .frame(minHeight: CrowiMetrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .accessibilityLabel(count.map { "\(label), \($0)" } ?? label)
    }
}

/// The transient "that write didn't land" notice, shown above the pill.
///
/// The inline engagement bar it replaced printed this next to the toggles
/// (`PageEngagementModel.lastActionFailed`, set after the optimistic state has
/// already been reverted). The pill has no room for a sentence, so the notice
/// floats over it in the same bottom inset — the one place the user is
/// looking after tapping a toggle.
public struct CrowiPageActionFailureNotice: View {
    private let message: String

    public init(message: String = "Couldn't update — try again") {
        self.message = message
    }

    public var body: some View {
        Text(message)
            .font(CrowiTypography.pageStats)
            .foregroundStyle(CrowiTheme.destructive)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                Capsule(style: .continuous).fill(.regularMaterial)
            }
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
            }
            .padding(.bottom, CrowiMetrics.pageHeaderSpacing)
    }
}
