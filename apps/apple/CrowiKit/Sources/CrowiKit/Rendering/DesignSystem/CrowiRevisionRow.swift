import SwiftUI

/// A small pill beside a row's title — the design's `v15` chip position.
///
/// Two flavours, because the design's two chips are two different statements:
/// `.neutral` is a fact about the revision (`--muted` on `--muted-foreground`,
/// monospaced), `.accent` is a status (`--primary` on white).
public struct CrowiRowChipLabel: View {
    public enum Style: Sendable {
        case neutral
        case accent
    }

    private let text: String
    private let style: Style

    public init(_ text: String, style: Style = .neutral) {
        self.text = text
        self.style = style
    }

    public var body: some View {
        Text(text)
            .font(style == .neutral ? CrowiTypography.rowChipMono : CrowiTypography.rowChip)
            .foregroundStyle(style == .neutral ? CrowiTheme.mutedForeground : CrowiTheme.primaryForeground)
            .padding(.horizontal, CrowiMetrics.rowChipHorizontalPadding)
            .padding(.vertical, CrowiMetrics.rowChipVerticalPadding)
            .background(style == .neutral ? CrowiTheme.muted : CrowiTheme.primary)
            .clipShape(RoundedRectangle(cornerRadius: CrowiMetrics.rowChipCornerRadius, style: .continuous))
            .lineLimit(1)
            .fixedSize()
    }
}

/// One revision in the page's history, as the design draws it: an avatar
/// beside the saver's name, status chips, and when it happened.
///
/// ## What the design draws that this does not
///
/// The design's row also carries a `v15` version chip, a change summary, a
/// `+142 / -38` diff stat and a `v14 → v15` range label, and its screen adds
/// multi-select comparison, a diff view and restore. **None of it is
/// implemented, on purpose**: `RevisionMetaSchema` carries `_id`, the two
/// users, `editVia` and `createdAt` — there is no version number, no summary
/// and no diff stat on the wire, and the app has no diff or restore surface
/// at all. A version number derived from the row's index would be wrong the
/// moment history pages past its first 50 entries, and the rest would be
/// invented outright. Same ruling as the action sheet's absent "Move to…" and
/// "Delete page".
///
/// What IS on the wire and was being dropped: the saver's avatar, the
/// `savedBy ?? author` distinction, and `editVia` — the "app" chip the web's
/// own history shows for token-authored revisions.
public struct CrowiRevisionRow: View {
    private let name: String
    private let imageURLString: String?
    private let relativeTime: String?
    private let isCurrent: Bool
    private let isAPIEdit: Bool
    private let loader: any WorkspaceImageFetching

    @ScaledMetric(relativeTo: .headline) private var avatarSize: CGFloat = CrowiMetrics.leadingChipSize

    public init(
        name: String,
        imageURLString: String?,
        relativeTime: String?,
        isCurrent: Bool,
        isAPIEdit: Bool,
        loader: any WorkspaceImageFetching
    ) {
        self.name = name
        self.imageURLString = imageURLString
        self.relativeTime = relativeTime
        self.isCurrent = isCurrent
        self.isAPIEdit = isAPIEdit
        self.loader = loader
    }

    public var body: some View {
        CrowiRow {
            WorkspaceAvatarView(
                imageURLString: imageURLString,
                loader: loader,
                size: avatarSize,
                initialsSource: name
            )
        } content: {
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                HStack(spacing: 6) {
                    Text(name)
                        .font(CrowiTypography.revisionAuthor)
                        .foregroundStyle(CrowiTheme.foreground)
                        .lineLimit(1)
                    if isAPIEdit {
                        CrowiRowChipLabel("app")
                    }
                    if isCurrent {
                        CrowiRowChipLabel("Current", style: .accent)
                    }
                }
                if let relativeTime {
                    Text(relativeTime)
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        [
            name,
            isAPIEdit ? "edited through the API" : nil,
            isCurrent ? "current version" : nil,
            relativeTime,
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }
}
