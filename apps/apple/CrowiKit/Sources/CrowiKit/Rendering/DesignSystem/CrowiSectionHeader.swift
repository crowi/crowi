import SwiftUI

/// feature-ios-visual-redesign Phase 1 — the label above a `CrowiCard`:
/// 13px/600 uppercase, `letter-spacing:.04em`, `var(--muted-foreground)`,
/// `padding:16px 20px 8px`, with an optional trailing action link
/// (14px `var(--primary)`).
///
/// Carries `.isHeader` so VoiceOver's heading rotor can jump between a
/// screen's sections — the semantic `List`/`Section` gave us for free and
/// that a hand-built card stack has to state.
public struct CrowiSectionHeader<Action: View>: View {
    private let title: String
    private let action: Action

    public init(_ title: String, @ViewBuilder action: () -> Action) {
        self.title = title
        self.action = action()
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(CrowiTypography.sectionHeader)
                .tracking(CrowiTypography.sectionHeaderTracking)
                .textCase(.uppercase)
                .foregroundStyle(CrowiTheme.mutedForeground)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            action
                .font(CrowiTypography.sectionAction)
                .foregroundStyle(CrowiTheme.primary)
        }
        .padding(.horizontal, CrowiMetrics.screenHorizontalMargin)
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
        .padding(.bottom, CrowiMetrics.sectionHeaderBottomPadding)
    }
}

extension CrowiSectionHeader where Action == EmptyView {
    public init(_ title: String) {
        self.init(title, action: { EmptyView() })
    }
}

/// The design's large screen title: 33px/800, `letter-spacing:-.02em`,
/// `margin:10px 20px 2px`, over an optional 15px muted subtitle line.
///
/// Used where the screen owns its own title area instead of the navigation
/// bar's — today that is the workspace home, whose bar carries only actions.
/// Every PUSHED screen keeps `.navigationTitle` instead: iOS's own large
/// title is the platform's implementation of this exact element (same step in
/// the scale, and it collapses on scroll the way the design's does), and
/// stacking a second title under it would just print the same words twice.
///
/// The subtitle is a VIEW rather than a string so a screen can compose its
/// own line out of parts (the home's "workspace · N pages") without this
/// container having to know about any of them. It supplies the subtitle's
/// type and colour, so a plain `Text` subtitle needs no styling of its own.
///
/// The `accessory` is the design's title-row link — Notifications' "Mark all
/// read", set in `--primary` and baseline-aligned with the heading. It lives
/// HERE rather than in the navigation bar because that is where the design
/// draws it, and because a bar this screen otherwise leaves empty would
/// present it 60pt above the list it acts on.
public struct CrowiScreenTitle<Accessory: View, Subtitle: View>: View {
    private let title: String
    private let accessory: Accessory
    private let subtitle: Subtitle

    public init(
        _ title: String,
        @ViewBuilder accessory: () -> Accessory,
        @ViewBuilder subtitle: () -> Subtitle
    ) {
        self.title = title
        self.accessory = accessory()
        self.subtitle = subtitle()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .lastTextBaseline) {
                Text(title)
                    .font(CrowiTypography.screenTitle)
                    .tracking(CrowiTypography.screenTitleTracking)
                    .foregroundStyle(CrowiTheme.foreground)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                accessory
                    .font(CrowiTypography.sectionAction)
                    .foregroundStyle(CrowiTheme.primary)
            }
            subtitle
                .font(CrowiTypography.screenSubtitle)
                .foregroundStyle(CrowiTheme.mutedForeground)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CrowiMetrics.screenHorizontalMargin)
        .padding(.top, CrowiMetrics.screenTitleTopPadding)
        .padding(.bottom, CrowiMetrics.screenTitleBottomPadding)
    }
}

extension CrowiScreenTitle where Accessory == EmptyView {
    /// A title with a subtitle but no trailing link.
    public init(_ title: String, @ViewBuilder subtitle: () -> Subtitle) {
        self.init(title, accessory: { EmptyView() }, subtitle: subtitle)
    }
}

extension CrowiScreenTitle where Accessory == EmptyView, Subtitle == EmptyView {
    /// A title with no subtitle line at all — `EmptyView` contributes no
    /// subview, so the `VStack` does not leave a phantom 2pt gap under it.
    public init(_ title: String) {
        self.init(title, accessory: { EmptyView() }, subtitle: { EmptyView() })
    }
}
