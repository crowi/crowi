import SwiftUI

/// One cell of a `CrowiStatStrip` — a number over its noun.
public struct CrowiStat: Identifiable, Equatable, Sendable {
    public var id: String { label }
    public let value: Int
    public let label: String

    public init(value: Int, label: String) {
        self.value = value
        self.label = label
    }
}

/// The design's profile stat row: equal columns inside one `CrowiCard`,
/// divided by hairlines — `128 Pages | 342 Likes | 89 Comments`.
///
/// Takes whatever cells it is given rather than exactly three: a stat whose
/// count the server did not send is DROPPED by the caller, and a strip that
/// insisted on three would then have to invent a zero. Two real numbers beside
/// each other are still the design's element; a fabricated third is not.
///
/// The number and its noun are one accessibility element ("128 Pages"), or
/// VoiceOver reads six disconnected fragments across the row.
public struct CrowiStatStrip: View {
    private let stats: [CrowiStat]

    public init(_ stats: [CrowiStat]) {
        self.stats = stats
    }

    public var body: some View {
        if !stats.isEmpty {
            CrowiCard {
                HStack(spacing: 0) {
                    ForEach(stats) { stat in
                        if stat != stats.first {
                            Rectangle()
                                .fill(CrowiTheme.border)
                                .frame(width: CrowiTheme.hairline)
                                .accessibilityHidden(true)
                        }
                        column(stat)
                    }
                }
                // The dividers are drawn as siblings of the columns, so the
                // strip has to be as tall as its tallest column for them to
                // reach — without this they collapse to the height of a
                // single line of text.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func column(_ stat: CrowiStat) -> some View {
        VStack(spacing: 1) {
            Text(stat.value, format: .number)
                .font(CrowiTypography.statValue)
                .foregroundStyle(CrowiTheme.foreground)
            Text(stat.label)
                .font(CrowiTypography.statLabel)
                .foregroundStyle(CrowiTheme.mutedForeground)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, CrowiMetrics.statColumnVerticalPadding)
        .accessibilityElement(children: .combine)
    }
}
