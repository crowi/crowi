import CrowiKit
import SwiftUI

/// RFC-0016 §11 (`feature-ios-phase3-notifications-extensions`) — the
/// notifications tab:
///
///   - rows for all four wired actions (COMMENT / LIKE / MENTION / UPDATE) —
///     first action-user avatar (through the workspace's authenticated image
///     cache, §6.1), the actor / verb / page hierarchy, relative time, and
///     the unopened dot (`UNREAD`/`UNOPENED` — web parity: mark-all-read
///     zeroes the BADGE but keeps the row highlight, which only opening
///     clears);
///   - tap = TWO actions (the §11 design): fire the single-shot open POST
///     (optimistic row update; a failure never blocks — the
///     `EngagementActions` loose-write discipline via
///     `session.openNotification`) and navigate to the target page through
///     the existing `ReadDestination.page(path:)`. A row whose target is
///     missing is listed but non-navigable — the phase's degrade pin (an
///     unknown action degrades only the message wording, never navigation);
///   - swipe a row to mark it read WITHOUT opening it — the same single-shot
///     POST, which is what makes a list of things you have already seen
///     elsewhere clearable;
///   - mark-all-read in the title row (UNREAD → UNOPENED in bulk);
///   - offset pager as an explicit "Load more" row (`pager.next` from the
///     wire; the web uses an infinite query — a visible button is the
///     simpler native equivalent and an accepted implementation judgment);
///   - while this list is on screen it re-fetches on the SAME fixed cadence
///     the badge poller uses (§11: "一覧画面表示中は GET /notifications も
///     再取得") — but only while the user hasn't paged deeper, so a refresh
///     never yanks a scrolled-back list out from under them (new arrivals
///     still reach the badge either way).
///
/// ## The design language, arriving late
///
/// This screen was outside the Phase 1 restyle and kept the stock `List`. Two
/// things came with the catch-up beyond the card container:
///
///   - a READ row is no longer drawn `.secondary` in full. Dimming the whole
///     row made a fully-read list look like a disabled control — the design
///     distinguishes read from unread with the leading dot ALONE, and every
///     row keeps the same text colours;
///   - the message is a HIERARCHY, not one sentence: bold actor + verb on the
///     first line, page on a muted second, time trailing. The one-sentence
///     form (`NotificationLenient.messageText`) stays as the row's
///     accessibility label — VoiceOver wants the sentence, the eye wants the
///     structure.
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                CrowiScreenTitle("Notifications") {
                    Button("Mark all read") {
                        Task { await markAllRead() }
                    }
                    .disabled(isMarkingAllRead || !notifications.contains(where: \.isUnopened))
                } subtitle: {
                    Text(NotificationsSummary.subtitle(unopenedCount: notifications.filter(\.isUnopened).count))
                }

                if notifications.isEmpty {
                    emptyCard
                } else {
                    // Grouped from each row's own `createdAt`, in the order
                    // the server already sorted them (newest first).
                    ForEach(CrowiDayGroup.runs(of: notifications, by: { PageRowMetadataLabel.date(fromISO8601: $0.createdAt) })) { run in
                        CrowiSectionHeader(run.group.title)
                        CrowiCardRows(run.items, id: \.notificationId) { notification in
                            row(notification)
                        }
                    }
                    if let nextOffset {
                        loadMore(from: nextOffset)
                    }
                }
            }
            .padding(.bottom, CrowiMetrics.screenBottomPadding)
        }
        .background(CrowiTheme.background)
        // The title block is rendered in the CONTENT by `CrowiScreenTitle`,
        // exactly as on Home — a bar title here would print the same word a
        // second time, 60pt higher.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task { await pollWhileVisible() }
        .refreshable { await reload() }
    }

    private var emptyCard: some View {
        CrowiCard {
            CrowiRow(showsChevron: false) {
                Text(errorMessage ?? (hasLoaded ? "No notifications yet" : " "))
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
            }
        }
    }

    private func loadMore(from offset: Int) -> some View {
        Button {
            Task { await loadMore(startingAt: offset) }
        } label: {
            Text("Load more")
                .font(CrowiTypography.sectionAction)
                .foregroundStyle(CrowiTheme.primary)
                .frame(maxWidth: .infinity, minHeight: CrowiMetrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .padding(.top, CrowiMetrics.sectionHeaderTopPadding)
    }

    private func row(_ notification: NotificationLenient) -> some View {
        CrowiSwipeActionRow(
            actionLabel: "Read",
            actionSystemImage: "checkmark",
            // Nothing to mark on a row that is already opened — a swipe there
            // would animate a panel that does nothing.
            isActionAvailable: notification.isUnopened,
            action: { markRead(notification) }
        ) {
            Button {
                open(notification)
            } label: {
                rowContent(notification)
            }
            .buttonStyle(.plain)
            .disabled(!notification.isNavigable)
        }
    }

    private func rowContent(_ notification: NotificationLenient) -> some View {
        HStack(alignment: .top, spacing: CrowiMetrics.rowContentSpacing) {
            // The dot's column is always present, so the avatars of read and
            // unread rows line up instead of stepping 8pt sideways.
            Circle()
                .fill(notification.isUnopened ? AnyShapeStyle(CrowiTheme.primary) : AnyShapeStyle(.clear))
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            WorkspaceAvatarView(
                imageURLString: notification.actionUsers.first?.image,
                loader: session.imageCache,
                size: CrowiMetrics.leadingChipSize,
                seed: notification.actionUsers.first?.username ?? notification.actionUsers.first?.displayName
            )
            VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
                (
                    Text(notification.actorText).fontWeight(.bold)
                        + Text(" \(notification.actionText)")
                )
                .font(CrowiTypography.rowMeta)
                .foregroundStyle(CrowiTheme.foreground)
                .multilineTextAlignment(.leading)
                Text(notification.pageText)
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let time = PageRowMetadataLabel.relativeTimeText(from: notification.createdAt) {
                Text(time)
                    .font(CrowiTypography.rowMeta)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, CrowiMetrics.rowVerticalPadding)
        .padding(.horizontal, CrowiMetrics.rowHorizontalPadding)
        .frame(minHeight: CrowiMetrics.minimumTapTarget)
        .contentShape(Rectangle())
        // The drawn hierarchy is three separate strings; the spoken row is
        // the one sentence it was built from.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(for: notification))
    }

    private func accessibilityLabel(for notification: NotificationLenient) -> String {
        [
            notification.isUnopened ? "Unopened" : nil,
            notification.messageText,
            PageRowMetadataLabel.relativeTimeText(from: notification.createdAt),
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }

    private func open(_ notification: NotificationLenient) {
        guard let path = notification.targetPath else { return }
        markRead(notification)
        onSelectDestination(.page(path: path))
    }

    /// The optimistic row update + the loose open POST, with no navigation —
    /// the swipe's whole behavior, and the half of a tap that is not the
    /// push. Navigation is never gated on the POST.
    private func markRead(_ notification: NotificationLenient) {
        if let index = notifications.firstIndex(where: { $0.notificationId == notification.notificationId }) {
            notifications[index] = notification.opened()
        }
        Task { await session.openNotification(id: notification.notificationId) }
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

    private func loadMore(startingAt offset: Int) async {
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
