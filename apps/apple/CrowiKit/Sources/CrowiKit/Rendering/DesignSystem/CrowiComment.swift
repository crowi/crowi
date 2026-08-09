import SwiftUI

/// One comment, as the design draws it: a 34pt avatar beside a
/// "**Name** · time" byline over the comment's own text.
///
/// The byline is ONE `Text` (a concatenation), not an `HStack` of three —
/// so the separator dot stays welded to the name when a long name wraps,
/// and VoiceOver reads the line as a sentence rather than as three
/// fragments.
///
/// This replaces a stock stack that set the author in `.subheadline.bold`
/// over `.body` text with no time at all: the same three facts the design
/// shows, in the design's hierarchy, plus the timestamp the reader needs to
/// tell a fresh comment from a year-old one.
public struct CrowiCommentRow: View {
    private let authorName: String
    /// Seeds the generated avatar (`WorkspaceAvatarView`) — a display name
    /// would give the same person a different face than the web draws.
    private let authorUsername: String?
    private let authorImageURLString: String?
    private let relativeTime: String?
    private let text: String
    private let loader: any WorkspaceImageFetching

    public init(
        authorName: String,
        authorUsername: String? = nil,
        authorImageURLString: String?,
        relativeTime: String?,
        text: String,
        loader: any WorkspaceImageFetching
    ) {
        self.authorName = authorName
        self.authorUsername = authorUsername
        self.authorImageURLString = authorImageURLString
        self.relativeTime = relativeTime
        self.text = text
        self.loader = loader
    }

    public var body: some View {
        HStack(alignment: .top, spacing: CrowiMetrics.commentContentSpacing) {
            WorkspaceAvatarView(
                imageURLString: authorImageURLString,
                loader: loader,
                size: CrowiMetrics.commentAvatarSize,
                seed: authorUsername ?? authorName
            )
            VStack(alignment: .leading, spacing: CrowiMetrics.commentBylineSpacing) {
                byline
                Text(text)
                    .font(CrowiTypography.commentBody)
                    .foregroundStyle(CrowiTheme.foreground)
                    .lineSpacing(CrowiTypography.resolvedBodyPointSize * CrowiTypography.commentLineSpacingRatio)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
            }
        }
    }

    private var byline: some View {
        let name = Text(authorName)
            .fontWeight(.semibold)
            .foregroundStyle(CrowiTheme.foreground)
        guard let relativeTime else {
            return name.font(CrowiTypography.commentByline)
        }
        return (name + Text(" · \(relativeTime)").foregroundStyle(CrowiTheme.mutedForeground))
            .font(CrowiTypography.commentByline)
    }
}

/// The design's comment input: a 30pt avatar beside a `--muted` pill.
///
/// The design draws the pill alone, with no send control — which a web form
/// can get away with (Enter submits) and a phone cannot. The send button is
/// therefore revealed only once there is something to send, so an untouched
/// composer is exactly the design's row and the affordance appears at the
/// moment it becomes meaningful.
///
/// Presentation only: the caller owns the text, the in-flight flag and the
/// posting itself.
public struct CrowiCommentComposer: View {
    @Binding private var text: String
    private let authorImageURLString: String?
    private let authorName: String?
    /// Seeds the generated avatar (`WorkspaceAvatarView`) — a display name
    /// would give the same person a different face than the web draws.
    private let authorUsername: String?
    private let isPosting: Bool
    private let loader: any WorkspaceImageFetching
    private let onSend: () -> Void

    public init(
        text: Binding<String>,
        authorImageURLString: String?,
        authorName: String?,
        authorUsername: String? = nil,
        isPosting: Bool,
        loader: any WorkspaceImageFetching,
        onSend: @escaping () -> Void
    ) {
        _text = text
        self.authorImageURLString = authorImageURLString
        self.authorName = authorName
        self.authorUsername = authorUsername
        self.isPosting = isPosting
        self.loader = loader
        self.onSend = onSend
    }

    /// Whether the field holds something worth sending. Separate from
    /// `canSend` because the two answer different questions: this one decides
    /// whether the send button EXISTS, `canSend` whether it is enabled — and
    /// a button that vanished mid-post would be worse than a dim one.
    public static func hasContent(text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether a send would do any work — the button's enabled state, and the
    /// caller's own guard against a stale tap.
    public static func canSend(text: String, isPosting: Bool) -> Bool {
        !isPosting && hasContent(text: text)
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: CrowiMetrics.composerSpacing) {
            WorkspaceAvatarView(
                imageURLString: authorImageURLString,
                loader: loader,
                size: CrowiMetrics.composerAvatarSize,
                seed: authorUsername ?? authorName
            )
            field
            // Appears as soon as something is typed, and stays put while the
            // post is in flight — disabled, not removed.
            if Self.hasContent(text: text) || isPosting {
                sendButton
            }
        }
    }

    private var field: some View {
        TextField("Add a comment…", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .font(CrowiTypography.searchInput)
            .foregroundStyle(CrowiTheme.foreground)
            .lineLimit(1...5)
            .padding(.vertical, CrowiMetrics.composerFieldVerticalPadding)
            .padding(.horizontal, CrowiMetrics.composerFieldHorizontalPadding)
            .background(CrowiTheme.muted)
            .clipShape(RoundedRectangle(cornerRadius: CrowiMetrics.composerFieldCornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: CrowiMetrics.composerFieldCornerRadius, style: .continuous)
                    .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
            }
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Image(systemName: "arrow.up.circle.fill")
                .font(.system(size: CrowiMetrics.composerAvatarSize * 0.9))
                .foregroundStyle(CrowiTheme.primary)
                .frame(
                    minWidth: CrowiMetrics.minimumTapTarget,
                    minHeight: CrowiMetrics.minimumTapTarget
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!Self.canSend(text: text, isPosting: isPosting))
        .accessibilityLabel("Post comment")
    }
}
