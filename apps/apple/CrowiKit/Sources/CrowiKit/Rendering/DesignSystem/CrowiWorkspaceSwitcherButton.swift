import SwiftUI

/// feature-ios-visual-redesign Phase 2 — the workspace switcher, as the
/// Home screen's subtitle line.
///
/// The design has no switcher control at all (it draws a single workspace),
/// but the app is multi-workspace and the switcher used to be a "Workspaces"
/// toolbar button. Rather than invent a control the design never sketched,
/// the affordance is folded into the one place the design DOES put the
/// workspace name: the muted line under "Home". The trailing
/// `chevron.up.chevron.down` is what turns that line from a caption into a
/// control — it is the platform's own "this opens a list of alternatives"
/// glyph (a `chevron.right` would promise a pushed screen, which this is
/// not: it presents `RootScene`'s existing switcher sheet).
///
/// There is exactly ONE such affordance in the app. The page count the
/// design pairs with the name ("· 128 pages") is not rendered: no endpoint
/// reports a workspace-wide total, and a fabricated number is worse than a
/// missing one.
public struct CrowiWorkspaceSwitcherButton: View {
    private let workspaceName: String
    private let action: () -> Void

    public init(workspaceName: String, action: @escaping () -> Void) {
        self.workspaceName = workspaceName
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(workspaceName)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .accessibilityHidden(true)
            }
            // A subtitle-sized control is the easiest thing in a design to
            // leave under the HIG minimum — the text itself is ~20pt tall, so
            // the row is held open explicitly, exactly as `CrowiRow` does.
            .frame(minHeight: CrowiMetrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        // `.plain` so the line keeps the muted subtitle colour
        // `CrowiScreenTitle` hands down, instead of being tinted like a link:
        // it reads as the workspace's name first and as a control second.
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace: \(workspaceName)")
        .accessibilityHint("Switch workspace")
    }
}
