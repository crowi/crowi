import SwiftUI

/// feature-ios-visual-redesign Phase 3 — the reader's "Contents" sheet: the
/// page's headings, indented by level, each tapping through to the anchor the
/// renderer registered for it.
///
/// The entries come from `RenderedAstTableOfContents` (pure, unit-tested) and
/// carry SERVER-issued anchors only. A heading the server gave no id renders
/// as a plain, inert row: it still tells the reader the page has that section,
/// but it does not pretend to be a jump — there is nowhere to jump TO, and
/// slugging one client-side would invent an anchor the body does not have.
///
/// Presented only when there ARE entries: on the raw-body fallback path there
/// is no AST, hence no anchors, and the reader hides the control entirely
/// rather than opening an empty sheet.
public struct CrowiTableOfContentsSheet: View {
    private let headings: [RenderedAstHeading]
    private let progress: CrowiReadingProgressModel
    private let onSelect: (RenderedAstHeading) -> Void
    private let onDone: () -> Void

    public init(
        headings: [RenderedAstHeading],
        progress: CrowiReadingProgressModel,
        onSelect: @escaping (RenderedAstHeading) -> Void,
        onDone: @escaping () -> Void
    ) {
        self.headings = headings
        self.progress = progress
        self.onSelect = onSelect
        self.onDone = onDone
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(headings) { heading in
                        row(heading)
                    }
                }
            }
            doneButton
        }
        .background(CrowiTheme.background)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Contents")
                .font(CrowiTypography.sheetTitle)
                .foregroundStyle(CrowiTheme.foreground)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            // The design's `{{ progressLabel }}`. Read here rather than passed
            // in as a number so a scroll tick invalidates this sheet and the
            // 2pt bar, never the reader's whole body. Absent — not stuck at
            // "0% read" — on an OS that cannot measure it
            // (`CrowiReadingProgress.isMeasurable`).
            if CrowiReadingProgress.isMeasurable {
                Text(CrowiReadingProgress.label(for: progress.fraction))
                    .font(CrowiTypography.pageStats)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, CrowiMetrics.sheetRowHorizontalPadding)
        .padding(.top, CrowiMetrics.pageHeaderBottomPadding)
        .padding(.bottom, CrowiMetrics.pageHeaderSpacing)
    }

    @ViewBuilder
    private func row(_ heading: RenderedAstHeading) -> some View {
        if heading.isNavigable {
            Button {
                onSelect(heading)
            } label: {
                rowLabel(heading)
            }
            .buttonStyle(.plain)
        } else {
            rowLabel(heading)
                // Says what it is, offers nothing to tap.
                .foregroundStyle(CrowiTheme.mutedForeground)
        }
    }

    private func rowLabel(_ heading: RenderedAstHeading) -> some View {
        HStack(spacing: CrowiMetrics.tocRowContentSpacing) {
            // The design's rail — drawn for every row (transparent unless it
            // is the row being read) so the labels stay on one leading edge
            // regardless of state. This app does not track the active section,
            // so it is currently the indentation guide only.
            Rectangle()
                .fill(Color.clear)
                .frame(width: CrowiMetrics.tocRailWidth)
                .accessibilityHidden(true)
            Text(heading.title)
                .font(heading.indentLevel == 0 ? CrowiTypography.tocRow : CrowiTypography.tocNestedRow)
                .foregroundStyle(heading.isNavigable ? CrowiTheme.foreground : CrowiTheme.mutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.leading, CrowiMetrics.tocRowHorizontalPadding + CGFloat(heading.indentLevel) * CrowiMetrics.tocRowIndentStep)
        .padding(.trailing, CrowiMetrics.tocRowHorizontalPadding)
        .padding(.vertical, CrowiMetrics.tocRowVerticalPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: CrowiMetrics.minimumTapTarget)
        .contentShape(Rectangle())
    }

    private var doneButton: some View {
        VStack(spacing: 0) {
            Divider()
            Button(action: onDone) {
                Text("Done")
                    .font(CrowiTypography.sheetRow.weight(.semibold))
                    .foregroundStyle(CrowiTheme.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, CrowiMetrics.sheetButtonPadding)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}
