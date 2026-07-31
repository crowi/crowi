import SwiftUI

/// RFC-0016 §11/§9 — the ONE notifications toolbar entry point: a bell with
/// the unread-count badge (`unread count` = the number of UNREAD
/// notifications, `GET /notifications/status`).
///
/// Lives in CrowiKit for the `SearchCapabilityToolbarButton` reason: the App
/// target's manifest imports `AppleProductTypes`, which the bare `swift` CLI
/// running `CrowiKitTests` cannot even parse — so the production toolbar
/// view and the render-pinned test subject have to be one and the same type
/// here. `WorkspaceHomeView` places EXACTLY this type (through a thin
/// `@ObservedObject` session wrapper that feeds it
/// `session.unreadNotificationCount`), never a re-derived inline badge, so
/// the badge-decrement CI-fixed test (`NotificationBellToolbarButtonTests`)
/// reaches the real UI entity.
public struct NotificationBellToolbarButton: View {
    private let unreadCount: Int
    private let action: () -> Void

    public init(unreadCount: Int, action: @escaping () -> Void) {
        self.unreadCount = unreadCount
        self.action = action
    }

    /// The badge text `body` renders — `nil` (no badge at all) at zero, and
    /// capped at `99+` exactly like the web bell's `badgeLabel`
    /// (`notification-bell.tsx`).
    public var badgeText: String? { CrowiUnreadBadge.text(for: unreadCount) }

    public var body: some View {
        Button(action: action) {
            Label("Notifications", systemImage: "bell")
                .overlay(alignment: .topTrailing) {
                    CrowiUnreadBadge(unreadCount: unreadCount)
                        .offset(x: 8, y: -6)
                }
        }
    }
}

/// The unread pill itself, extracted so the toolbar bell (regular width) and
/// the tab bar's Notifications slot (compact) paint the SAME badge from the
/// SAME rule. Two hand-maintained copies of "red capsule, 99+ cap" is
/// exactly the drift `SearchCapabilityToolbarButton`'s doc comment warns
/// about, one level down.
public struct CrowiUnreadBadge: View {
    private let unreadCount: Int

    public init(unreadCount: Int) {
        self.unreadCount = unreadCount
    }

    /// `nil` = no badge at all, not an empty one.
    public static func text(for unreadCount: Int) -> String? {
        guard unreadCount > 0 else { return nil }
        return unreadCount > 99 ? "99+" : String(unreadCount)
    }

    public var body: some View {
        if let text = Self.text(for: unreadCount) {
            Text(text)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(minWidth: 15, minHeight: 15)
                .background(Capsule().fill(.red))
                .accessibilityLabel("\(unreadCount) unread notifications")
        }
    }
}
