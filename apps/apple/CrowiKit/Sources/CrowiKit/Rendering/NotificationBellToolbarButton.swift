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
    public var badgeText: String? {
        guard unreadCount > 0 else { return nil }
        return unreadCount > 99 ? "99+" : String(unreadCount)
    }

    public var body: some View {
        Button(action: action) {
            Label("Notifications", systemImage: "bell")
                .overlay(alignment: .topTrailing) {
                    if let badgeText {
                        Text(badgeText)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(Capsule().fill(.red))
                            .offset(x: 8, y: -6)
                            .accessibilityLabel("\(unreadCount) unread notifications")
                    }
                }
        }
    }
}
