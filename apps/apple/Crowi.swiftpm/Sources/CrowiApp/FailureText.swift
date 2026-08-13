import CrowiKit
import SwiftUI

/// A failure as the reader sees it: the app's sentence, and — only with
/// developer mode on — the raw error underneath it.
///
/// The detail is carried all the way to here rather than being dropped where
/// the error was caught, because whether to show it is a setting and a value
/// that discarded it could not answer that question later. It is monospaced
/// and selectable: its whole purpose is to be copied into a bug report.
struct FailureText: View {
    let failure: DisplayableFailure

    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(failure.message)
                .font(CrowiTypography.rowMeta)
                .foregroundStyle(CrowiTheme.destructive)
            if settings.isDeveloperModeEnabled, let detail = failure.detail {
                Text(detail)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .textSelection(.enabled)
            }
        }
    }
}
