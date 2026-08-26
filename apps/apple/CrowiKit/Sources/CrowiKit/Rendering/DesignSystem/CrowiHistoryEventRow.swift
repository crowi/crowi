import SwiftUI

/// One RFC-0021 metadata event in the merged page-history timeline: a
/// rename, trash, restore, visibility change, creation or draft publish.
/// Never selectable for the diff view — only `content_revision` rows carry
/// a body — so unlike `CrowiRevisionRow` this never sits behind a `Button`
/// at the call site.
public struct CrowiHistoryEventRow: View {
    private let actorDisplayName: String
    private let username: String?
    private let imageURLString: String?
    private let relativeTime: String?
    private let message: String
    private let detail: CrowiHistoryEventDetail?
    private let isSubtree: Bool
    private let loader: any WorkspaceImageFetching

    public init(
        actorDisplayName: String,
        username: String?,
        imageURLString: String?,
        relativeTime: String?,
        message: String,
        detail: CrowiHistoryEventDetail?,
        isSubtree: Bool,
        loader: any WorkspaceImageFetching
    ) {
        self.actorDisplayName = actorDisplayName
        self.username = username
        self.imageURLString = imageURLString
        self.relativeTime = relativeTime
        self.message = message
        self.detail = detail
        self.isSubtree = isSubtree
        self.loader = loader
    }

    public var body: some View {
        CrowiRow(showsChevron: false) {
            WorkspaceAvatarView(imageURLString: imageURLString, loader: loader, size: CrowiMetrics.leadingChipSize, seed: username ?? actorDisplayName)
        } content: {
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                HStack(spacing: 6) {
                    Text(actorDisplayName)
                        .font(CrowiTypography.revisionAuthor)
                        .foregroundStyle(CrowiTheme.foreground)
                        .lineLimit(1)
                    Text(message)
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                        .lineLimit(1)
                    if isSubtree {
                        CrowiRowChipLabel("Subtree")
                    }
                }
                if let detail {
                    detailView(detail)
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

    @ViewBuilder
    private func detailView(_ detail: CrowiHistoryEventDetail) -> some View {
        switch detail {
        case .text(let text, let showsRedirectBadge):
            HStack(spacing: 6) {
                Text(text)
                    .font(CrowiTypography.rowPath)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if showsRedirectBadge {
                    CrowiRowChipLabel("Redirected")
                }
            }
        case .visibility(let fromLabel, let toLabel):
            HStack(spacing: 6) {
                CrowiRowChipLabel(fromLabel)
                Image(systemName: "arrow.right")
                    .font(.caption2)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .accessibilityHidden(true)
                CrowiRowChipLabel(toLabel)
            }
        }
    }

    private var accessibilityLabel: String {
        var parts = [actorDisplayName, message]
        switch detail {
        case .text(let text, _): parts.append(text)
        case .visibility(let fromLabel, let toLabel): parts.append("\(fromLabel) to \(toLabel)")
        case nil: break
        }
        if let relativeTime { parts.append(relativeTime) }
        return parts.joined(separator: ", ")
    }
}
