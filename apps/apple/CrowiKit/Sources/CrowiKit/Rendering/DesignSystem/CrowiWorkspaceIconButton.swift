import SwiftUI

/// The workspace switcher, as the leading navigation-bar icon.
///
/// This replaces the Home screen's subtitle-as-control
/// (the Phase 2 `CrowiWorkspaceSwitcherButton`) for two reasons, one from the
/// design and one from the shell:
///
///   - the design's subtitle line is a LABEL ("Almoha Wiki · 128 pages"), not
///     a control. Folding an affordance into it made the one line that states
///     where you are also the one that changes it;
///   - the switcher hung off Home alone, so it was unreachable from
///     Search / Notifications / Profile — you had to walk back to Home to
///     change workspace. As a leading toolbar item on EVERY tab's root it is
///     always one tap away, which is where multi-workspace apps put it.
///
/// The mark is the workspace name's initials on a `--primary` squircle: Crowi
/// has no workspace image endpoint, so there is no logo to draw, and the
/// initials rule is the shared one (`WorkspaceAvatarView.initials(from:)`)
/// rather than a second, subtly different truncation. A workspace whose name
/// yields no initial at all (empty / whitespace-only title) falls back to the
/// platform's own building glyph — the same "rather an honest placeholder than
/// an empty disc" stance `WorkspaceAvatarView` takes.
///
/// A squircle, not the circle `WorkspaceAvatarView` draws: a circular mark in
/// the same bar as circular user avatars would read as "some person", and the
/// rounded square is the established shape for "an organization / a space" on
/// this platform.
public struct CrowiWorkspaceIconButton: View {
    private let workspaceName: String
    private let action: () -> Void

    /// Design: the leading chip's 34pt, taken in one step to the size a
    /// navigation bar actually gives a custom item — the glyph beside it
    /// (`Label`-rendered toolbar buttons) is ~22pt, and a 34pt disc next to it
    /// makes the bar look mis-set.
    private static let markSize: CGFloat = 28

    public init(workspaceName: String, action: @escaping () -> Void) {
        self.workspaceName = workspaceName
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            mark
                // The mark is small enough to miss; the tap target is not.
                // A toolbar gives a custom item only the room its content
                // asks for, so the floor is stated here exactly as
                // `CrowiRow` states it for a list row.
                .frame(
                    minWidth: CrowiMetrics.minimumTapTarget,
                    minHeight: CrowiMetrics.minimumTapTarget
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace: \(workspaceName)")
        .accessibilityHint("Switch workspace")
    }

    @ViewBuilder
    private var mark: some View {
        if let initials = WorkspaceAvatarView.initials(from: workspaceName) {
            CrowiTheme.primary
                .overlay {
                    Text(initials)
                        .font(.system(size: Self.markSize * 0.4, weight: .bold))
                        .foregroundStyle(CrowiTheme.primaryForeground)
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                }
                .frame(width: Self.markSize, height: Self.markSize)
                .clipShape(
                    RoundedRectangle(
                        // The design's chip squircle-ness
                        // (`border-radius:9px` on 34px), held as a ratio so
                        // this mark keeps the same corner at its own size.
                        cornerRadius: Self.markSize * CrowiMetrics.leadingChipCornerRadiusRatio,
                        style: .continuous
                    )
                )
        } else {
            Image(systemName: "building.2.crop.circle")
                .resizable()
                .scaledToFit()
                .foregroundStyle(CrowiTheme.primary)
                .frame(width: Self.markSize, height: Self.markSize)
        }
    }
}
