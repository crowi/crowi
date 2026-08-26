import SwiftUI

/// The diff view's bottom sheet: peeks at `CrowiMetrics.diffSheetPeekHeight`
/// (a header plus a sliver of the diff) and drags up to `.large`.
/// `presentationBackgroundInteraction` keeps the history list behind it
/// tappable while peeked, so picking a different pair doesn't require
/// dismissing first.
///
/// This view is presentation-only: the call site owns fetching (so it can
/// hold the last-loaded diff visible, with `isLoading` as a subtle overlay,
/// while a newly picked pair's fetch is in flight — never blanking the
/// sheet just because the user picked again).
public struct CrowiRevisionDiffSheet: View {
    private let fromLabel: String
    private let toLabel: String
    private let rows: [RevisionLineDiffRow]
    private let isLoading: Bool
    private let errorMessage: String?
    private let onRetry: () -> Void

    public init(
        fromLabel: String,
        toLabel: String,
        rows: [RevisionLineDiffRow],
        isLoading: Bool,
        errorMessage: String?,
        onRetry: @escaping () -> Void
    ) {
        self.fromLabel = fromLabel
        self.toLabel = toLabel
        self.rows = rows
        self.isLoading = isLoading
        self.errorMessage = errorMessage
        self.onRetry = onRetry
    }

    private var hasChanges: Bool {
        rows.contains { $0.kind != .unchanged }
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(CrowiTheme.popover)
        .presentationDetents([.height(CrowiMetrics.diffSheetPeekHeight), .large])
        .presentationDragIndicator(.visible)
        .presentationBackgroundInteraction(.enabled(upThrough: .height(CrowiMetrics.diffSheetPeekHeight)))
    }

    private var header: some View {
        HStack(spacing: 6) {
            CrowiRowChipLabel(fromLabel)
            Image(systemName: "arrow.right")
                .font(.caption2)
                .foregroundStyle(CrowiTheme.mutedForeground)
                .accessibilityHidden(true)
            CrowiRowChipLabel(toLabel)
            Spacer(minLength: 8)
            if isLoading {
                ProgressView()
                    .accessibilityLabel("Loading diff")
            }
        }
        .padding(.horizontal, CrowiMetrics.sheetRowHorizontalPadding)
        .padding(.vertical, CrowiMetrics.pageHeaderSpacing)
    }

    @ViewBuilder
    private var content: some View {
        if let errorMessage, rows.isEmpty {
            VStack(spacing: 12) {
                Text(errorMessage)
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .multilineTextAlignment(.center)
                Button("Retry", action: onRetry)
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else if rows.isEmpty {
            // First load still in flight: the peek stays at its full height
            // (empty content, not a collapsed sheet) so the drag-up
            // affordance never disappears out from under the user.
            Spacer(minLength: 0)
        } else if !hasChanges {
            Text("No changes between these revisions.")
                .font(CrowiTypography.rowMeta)
                .foregroundStyle(CrowiTheme.mutedForeground)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        diffLine(row)
                    }
                }
            }
        }
    }

    private func diffLine(_ row: RevisionLineDiffRow) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(marker(for: row.kind))
                .font(CrowiTypography.rowPath)
                .foregroundStyle(markerColor(for: row.kind))
                .frame(width: 14, alignment: .center)
                .accessibilityHidden(true)
            Text(row.text.isEmpty ? " " : row.text)
                .font(CrowiTypography.rowPath)
                .foregroundStyle(CrowiTheme.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, CrowiMetrics.sheetRowHorizontalPadding)
        .padding(.vertical, 2)
        .background(background(for: row.kind))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: row))
    }

    private func marker(for kind: RevisionLineDiffKind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "-"
        case .unchanged: return ""
        }
    }

    private func markerColor(for kind: RevisionLineDiffKind) -> Color {
        switch kind {
        case .added: return CrowiTheme.success
        case .removed: return CrowiTheme.danger
        case .unchanged: return CrowiTheme.mutedForeground
        }
    }

    private func background(for kind: RevisionLineDiffKind) -> Color {
        switch kind {
        case .added: return CrowiTheme.success.opacity(0.12)
        case .removed: return CrowiTheme.danger.opacity(0.12)
        case .unchanged: return .clear
        }
    }

    private func accessibilityLabel(for row: RevisionLineDiffRow) -> String {
        switch row.kind {
        case .added: return "Added: \(row.text)"
        case .removed: return "Removed: \(row.text)"
        case .unchanged: return row.text
        }
    }
}
