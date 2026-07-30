import CrowiKit
import SwiftUI

/// RFC-0016 §11 (`feature-ios-phase3-notifications-extensions`) — the
/// notifications list, opened from the toolbar bell:
///
///   - rows for all four wired actions (COMMENT / LIKE / MENTION / UPDATE) —
///     first action-user avatar (through the workspace's authenticated image
///     cache, §6.1), the shared message line (`NotificationLenient.messageText`),
///     relative time, and the unopened dot (`UNREAD`/`UNOPENED` — web parity:
///     mark-all-read zeroes the BADGE but keeps the row highlight, which only
///     opening clears);
///   - tap = TWO actions (the §11 design): fire the single-shot open POST
///     (optimistic row update; a failure never blocks — the
///     `EngagementActions` loose-write discipline via
///     `session.openNotification`) and navigate to the target page through
///     the existing `ReadDestination.page(path:)`. A row whose target is
///     missing is listed but non-navigable — the phase's degrade pin (an
///     unknown action degrades only the message wording, never navigation);
///   - mark-all-read in the toolbar (UNREAD → UNOPENED in bulk);
///   - offset pager as an explicit "Load more" row (`pager.next` from the
///     wire; the web uses an infinite query — a visible button is the
///     simpler native equivalent and an accepted implementation judgment);
///   - while this list is on screen it re-fetches on the SAME fixed cadence
///     the badge poller uses (§11: "一覧画面表示中は GET /notifications も
///     再取得") — but only while the user hasn't paged deeper, so a refresh
///     never yanks a scrolled-back list out from under them (new arrivals
///     still reach the badge either way).
struct NotificationsView: View {
    let session: WorkspaceSession
    let onSelectDestination: (ReadDestination) -> Void

    @State private var notifications: [NotificationLenient] = []
    @State private var nextOffset: Int?
    @State private var hasLoaded = false
    @State private var errorMessage: String?
    @State private var isMarkingAllRead = false

    private static let pageSize = 20

    var body: some View {
        List {
            ForEach(notifications) { notification in
                row(notification)
            }
            if let nextOffset {
                Button {
                    Task { await loadMore(from: nextOffset) }
                } label: {
                    Text("Load more")
                        .font(.callout)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .overlay {
            if notifications.isEmpty, let errorMessage {
                ContentUnavailableView(errorMessage, systemImage: "bell.slash")
            } else if notifications.isEmpty, hasLoaded {
                ContentUnavailableView("No notifications yet", systemImage: "bell")
            }
        }
        .navigationTitle("Notifications")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Mark All Read") {
                    Task { await markAllRead() }
                }
                .disabled(isMarkingAllRead)
            }
        }
        .task { await pollWhileVisible() }
        .refreshable { await reload() }
    }

    private func row(_ notification: NotificationLenient) -> some View {
        Button {
            open(notification)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                WorkspaceAvatarView(
                    imageURLString: notification.actionUsers.first?.image,
                    loader: session.imageCache,
                    size: 32
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(notification.messageText)
                        .font(.subheadline)
                        .foregroundStyle(notification.isUnopened ? .primary : .secondary)
                    if let time = PageRowMetadataLabel.relativeTimeText(from: notification.createdAt) {
                        Text(time)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if notification.isUnopened {
                    Circle()
                        .fill(.red)
                        .frame(width: 8, height: 8)
                        .padding(.top, 6)
                        .accessibilityLabel("Unopened")
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!notification.isNavigable)
    }

    private func open(_ notification: NotificationLenient) {
        guard let path = notification.targetPath else { return }
        // Optimistic row update first, then the loose open POST (which also
        // re-polls the badge) — navigation is never gated on the POST.
        if let index = notifications.firstIndex(where: { $0.notificationId == notification.notificationId }) {
            notifications[index] = notification.opened()
        }
        Task { await session.openNotification(id: notification.notificationId) }
        onSelectDestination(.page(path: path))
    }

    private func markAllRead() async {
        isMarkingAllRead = true
        defer { isMarkingAllRead = false }
        await session.markAllNotificationsRead()
        // Re-fetch so the rows show their server truth (UNREAD → UNOPENED:
        // the dots stay, the badge — refreshed inside the session call —
        // zeroes).
        await reload()
    }

    private func pollWhileVisible() async {
        await reload()
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(NotificationsPoller.defaultInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            // Skip the periodic replace once the user paged deeper — see the
            // type doc comment.
            guard notifications.count <= Self.pageSize else { continue }
            await reload()
        }
    }

    private func reload() async {
        do {
            let response = try await NotificationsAPI.fetchList(limit: Self.pageSize, offset: 0, using: session.apiClient)
            notifications = response.notifications
            nextOffset = response.nextOffset
            errorMessage = nil
        } catch {
            errorMessage = notifications.isEmpty ? "Couldn't load notifications." : nil
        }
        hasLoaded = true
    }

    private func loadMore(from offset: Int) async {
        do {
            let response = try await NotificationsAPI.fetchList(limit: Self.pageSize, offset: offset, using: session.apiClient)
            let known = Set(notifications.map(\.notificationId))
            notifications += response.notifications.filter { !known.contains($0.notificationId) }
            nextOffset = response.nextOffset
        } catch {
            // Keep what we have; the button stays for a manual retry.
        }
    }
}
