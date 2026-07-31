import SwiftUI

/// feature-ios-visual-redesign Phase 2 — the design's "Liquid Glass" tab
/// bar: a floating pill inset from both sides and lifted off the bottom,
/// holding Home · Search · New · Notifications · Profile.
///
/// ## Translating the CSS
///
/// The design's glass is `background:rgba(252,252,253,.6)` +
/// `backdrop-filter:blur(30px) saturate(1.9)` + a white inner rim. The
/// SwiftUI equivalent is a `Material`, NOT a hand-built blur: `.regularMaterial`
/// already samples what is behind it, already carries the vibrancy the
/// `saturate(1.9)` is reaching for, and already inverts for dark mode — a
/// literal filter chain would be both more code and wrong on device (a fixed
/// light fill over a dark backdrop). The `.5px` rim becomes a `strokeBorder`
/// at `CrowiTheme.hairline` in `CrowiTheme.border`, the same hairline every
/// other container in this vocabulary is outlined with.
///
/// The shadow is applied to the BACKGROUND shape rather than to the composed
/// bar: `.shadow` on the whole thing would drop a shadow behind every glyph
/// and label inside it too.
///
/// ## Not the system tab bar
///
/// This is drawn by the app, with `TabView`'s own bar hidden
/// (`.toolbar(.hidden, for: .tabBar)`) — the center create slot is a FAB
/// rather than a tab, which no version of `TabView` can express.
public struct CrowiTabBar: View {
    private let selection: CrowiTab
    private let unreadCount: Int
    private let onSelect: (CrowiTab) -> Void
    private let onCreate: () -> Void

    @ScaledMetric(relativeTo: .caption2) private var glyphSize: CGFloat = CrowiMetrics.tabBarGlyphSize
    @ScaledMetric(relativeTo: .caption2) private var createButtonSize: CGFloat = CrowiMetrics.tabBarCreateButtonSize

    public init(
        selection: CrowiTab,
        unreadCount: Int = 0,
        onSelect: @escaping (CrowiTab) -> Void,
        onCreate: @escaping () -> Void
    ) {
        self.selection = selection
        self.unreadCount = unreadCount
        self.onSelect = onSelect
        self.onCreate = onCreate
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(CrowiTabBarSlot.allSlots) { slot in
                switch slot {
                case .tab(let tab):
                    tabButton(tab)
                case .create:
                    createButton
                }
            }
        }
        .padding(.horizontal, CrowiMetrics.tabBarInnerHorizontalPadding)
        .padding(.top, CrowiMetrics.tabBarInnerTopPadding)
        .padding(.bottom, CrowiMetrics.tabBarInnerBottomPadding)
        .background {
            Capsule(style: .continuous)
                .fill(.regularMaterial)
                // Design: `0 12px 34px -8px rgba(20,30,45,.3)`. A CSS blur
                // radius is twice SwiftUI's, and the negative spread is what
                // keeps the shadow under the pill rather than around it —
                // approximated by the smaller radius against the 12pt drop.
                .shadow(color: .black.opacity(0.18), radius: 17, x: 0, y: 12)
        }
        .overlay {
            Capsule(style: .continuous)
                .strokeBorder(CrowiTheme.border, lineWidth: CrowiTheme.hairline)
        }
        .padding(.horizontal, CrowiMetrics.tabBarHorizontalInset)
        .padding(.bottom, CrowiMetrics.tabBarBottomInset)
    }

    private func tabButton(_ tab: CrowiTab) -> some View {
        Button {
            onSelect(tab)
        } label: {
            VStack(spacing: CrowiMetrics.tabBarItemSpacing) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: glyphSize, weight: .regular))
                    .overlay(alignment: .topTrailing) {
                        if tab == .notifications {
                            CrowiUnreadBadge(unreadCount: unreadCount)
                                .offset(x: 9, y: -5)
                        }
                    }
                Text(tab.title)
                    .font(CrowiTypography.tabLabel)
                    .lineLimit(1)
                    // "Notifications" is the widest label in the design and
                    // the bar cannot scroll — it shrinks a little rather than
                    // truncating into "Notificat…".
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: CrowiMetrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Design: `chrome(active)` — the selected tab in the brand colour,
        // everything else muted.
        .foregroundStyle(tab == selection ? CrowiTheme.primary : CrowiTheme.mutedForeground)
        .accessibilityAddTraits(tab == selection ? [.isSelected] : [])
    }

    private var createButton: some View {
        Button(action: onCreate) {
            Circle()
                .fill(CrowiTheme.primary)
                .frame(width: createButtonSize, height: createButtonSize)
                // Design: `0 4px 12px -2px primary 55%` — the FAB reads as
                // lifted off the glass rather than printed on it.
                .shadow(color: CrowiTheme.primary.opacity(0.45), radius: 6, x: 0, y: 3)
                .overlay {
                    Image(systemName: "plus")
                        .font(.system(size: createButtonSize * 0.5, weight: .semibold))
                        .foregroundStyle(CrowiTheme.primaryForeground)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: CrowiMetrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The glass variant hides the "New" caption (`fabLabelStyle:
        // display:none`), so the label has to exist for VoiceOver instead of
        // being read off the screen.
        .accessibilityLabel("New Page")
    }
}
