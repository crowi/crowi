import SwiftUI

/// feature-ios-design-language (1)(3) — the shared one-line "wiki metadata"
/// footer a page/segment row shows under its title: updater avatar + name +
/// relative last-updated time, in a standard `List` row (no custom card).
/// Lives in CrowiKit — not the App target — so `CrowiKitTests` can pin the
/// fallback ladder directly (the `SearchCapabilityToolbarButton` precedent:
/// the App target's manifest imports `AppleProductTypes`, which the bare
/// `swift` CLI running the tests cannot even parse).
///
/// Fallback ladder (AC (1)): updater + timestamp → avatar + name + time;
/// updater missing (`null`) → time only; timestamp missing/unparseable →
/// updater only; both missing (a pre-extension server) → renders nothing at
/// all, leaving the row exactly as it looked before this feature.
///
/// The avatar goes through `WorkspaceAvatarView` + the SAME
/// `WorkspaceImageFetching` conformer (the per-workspace disk cache) every
/// other avatar uses — never a new image-fetch path.
///
/// feature-ios-visual-redesign Phase 1: the label keeps its own inline 14pt
/// avatar by default, but `CrowiPageRow` — which already shows the design's
/// 34pt leading avatar for the same updater — passes `showsAvatar: false` so
/// a row never prints the same face twice.
public struct PageRowMetadataLabel: View {
    private let lastUpdatedAt: String?
    private let updaterName: String?
    private let updaterImage: String?
    /// Seeds the generated avatar (`WorkspaceAvatarView`) — a display name
    /// would give the same person a different face than the web draws.
    private let updaterUsername: String?
    private let loader: any WorkspaceImageFetching
    private let showsAvatar: Bool

    public init(
        lastUpdatedAt: String?,
        updaterName: String?,
        updaterImage: String?,
        updaterUsername: String? = nil,
        loader: any WorkspaceImageFetching,
        showsAvatar: Bool = true
    ) {
        self.lastUpdatedAt = lastUpdatedAt
        self.updaterName = updaterName
        self.updaterImage = updaterImage
        self.updaterUsername = updaterUsername
        self.loader = loader
        self.showsAvatar = showsAvatar
    }

    /// Whether an updater (name and/or image) is known — gates the avatar,
    /// so a `null` updater shows no placeholder circle (AC (1): "アバターを
    /// 出さず日時のみ").
    public var hasUpdater: Bool { updaterName != nil || updaterImage != nil }

    /// The relative representation of `lastUpdatedAt` ("3 days ago" /
    /// 「3日前」, device locale) — `nil` when missing or unparseable, which
    /// drops the time from the label rather than showing a raw/garbled value.
    ///
    /// Each call formats via the cached `relativeDateTimeFormatter` below, so
    /// calling this more than once (as the public `hasMetadata`/
    /// `metadataText` accessors below each do, for callers that use them
    /// standalone) no longer re-creates a formatter — only `body` needs to
    /// avoid the redundant *call*, which it does by deriving both from one
    /// local value.
    public var relativeTimeText: String? { Self.relativeTimeText(from: lastUpdatedAt) }

    /// Whether this label renders anything at all — `false` degrades the row
    /// to its plain pre-extension look (segment/path title only, no empty gap).
    public var hasMetadata: Bool { Self.hasMetadata(hasUpdater: hasUpdater, relativeTime: relativeTimeText) }

    public var body: some View {
        // Derive once per render and reuse for both the gate and the text —
        // `hasMetadata`/`metadataText` above each independently recompute
        // `relativeTimeText`, which used to mean two formatter *creations*
        // per row (one per accessor) before the formatter was cached below;
        // `body` avoids even the redundant call by deriving locally.
        let relativeTime = relativeTimeText
        if Self.hasMetadata(hasUpdater: hasUpdater, relativeTime: relativeTime) {
            HStack(spacing: 5) {
                if showsAvatar, hasUpdater {
                    WorkspaceAvatarView(imageURLString: updaterImage, loader: loader, size: 14, seed: updaterUsername ?? updaterName)
                }
                if let text = Self.metadataText(updaterName: updaterName, relativeTime: relativeTime) {
                    Text(text)
                }
            }
            .font(CrowiTypography.rowMeta)
            .foregroundStyle(CrowiTheme.mutedForeground)
            .lineLimit(1)
        }
    }

    /// The caption line ("Sotaro · 3 days ago" / name only / time only) —
    /// `nil` when neither part is available (an image-only updater then
    /// still shows just the avatar).
    public var metadataText: String? { Self.metadataText(updaterName: updaterName, relativeTime: relativeTimeText) }

    private static func hasMetadata(hasUpdater: Bool, relativeTime: String?) -> Bool {
        hasUpdater || relativeTime != nil
    }

    private static func metadataText(updaterName: String?, relativeTime: String?) -> String? {
        let parts = [updaterName, relativeTime].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Parses the server's `Date#toISOString()` output — WITH fractional
    /// seconds (`2026-07-24T12:34:56.789Z`, what every live server emits) and
    /// without (defensive, e.g. hand-written fixtures). `Date.ISO8601FormatStyle`
    /// is a Sendable value type, so there is no shared mutable formatter
    /// state to protect (a `static let ISO8601DateFormatter` would not be
    /// concurrency-safe).
    public static func date(fromISO8601 string: String?) -> Date? {
        guard let string else { return nil }
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle()
        return (try? fractional.parse(string)) ?? (try? plain.parse(string))
    }

    /// Cached instead of built per call. `RelativeDateTimeFormatter` init is
    /// comparatively expensive (locale/calendar setup); before this cache,
    /// every row created one from `hasMetadata` AND another from
    /// `metadataText` (`body` read both), so a 20-row re-render — e.g. the
    /// `RecentlyUpdatedHomeView` list re-appearing after popping back from a
    /// page — allocated up to 40 formatters, the dominant cost behind the
    /// pop-to-home stutter.
    ///
    /// `RelativeDateTimeFormatter` is a class and Apple does not document it
    /// as thread-safe, so sharing this one instance is only correct because
    /// every call site runs on the main thread: production callers are all
    /// SwiftUI `View.body` evaluations (implicitly main-thread), and the
    /// direct unit-test call below runs on XCTest's default main thread. Do
    /// not call `relativeTimeText`/this formatter from a background thread.
    private static let relativeDateTimeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        return formatter
    }()

    /// - Parameter now: injectable for tests only — production callers use
    ///   the default.
    public static func relativeTimeText(from isoString: String?, relativeTo now: Date = Date()) -> String? {
        guard let date = date(fromISO8601: isoString) else { return nil }
        return relativeDateTimeFormatter.localizedString(for: date, relativeTo: now)
    }
}
