import SwiftUI

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
