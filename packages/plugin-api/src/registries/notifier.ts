/**
 * Notification payload — the runtime-neutral shape passed to every
 * notifier driver. Drivers translate it into provider-specific
 * messages (Slack: `chat.postMessage`; Webhook: HTTP POST; etc.).
 */
export interface NotificationPayload {
  /** Plain-text title (e.g. "Page updated: /team/eng/foo"). */
  title: string;
  /** Optional plain-text body / details. */
  body?: string;
  /**
   * Absolute URL the notification should link to. Drivers that render
   * clickable text use this; otherwise it appears in the body.
   */
  url?: string;
  /**
   * Originating event kind, opaque to drivers but useful for debug logs
   * and for plugins that filter (e.g. only forward 'page:updated').
   */
  event: string;
  /**
   * Provider-routing hint pulled from the source page's plugin metadata
   * (e.g. `{ channel: '#eng' }` for slack). Drivers cast this to their
   * own typed shape.
   */
  routing?: Record<string, unknown>;
}

/**
 * Notifier driver. Active driver is selected at registration time and
 * called for every event the core opts to forward. Multiple drivers
 * can be registered simultaneously (a single page-save can fan out to
 * Slack and Webhook); the runtime calls each registered driver in
 * parallel.
 */
export interface NotifierDriver {
  /**
   * Send the notification. Implementations should swallow transient
   * provider errors (log + continue) — a flaky Slack must not break
   * the page-save handler. Persistent misconfiguration should throw
   * so the admin sees it.
   */
  send(payload: NotificationPayload): Promise<void>;
}

export interface NotifierRegistry {
  register(driverName: string, driver: NotifierDriver): void;
}
