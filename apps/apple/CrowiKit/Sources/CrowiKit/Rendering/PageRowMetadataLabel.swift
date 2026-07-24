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
public struct PageRowMetadataLabel: View {
    private let lastUpdatedAt: String?
    private let updaterName: String?
    private let updaterImage: String?
    private let loader: any WorkspaceImageFetching

    public init(lastUpdatedAt: String?, updaterName: String?, updaterImage: String?, loader: any WorkspaceImageFetching) {
        self.lastUpdatedAt = lastUpdatedAt
        self.updaterName = updaterName
        self.updaterImage = updaterImage
        self.loader = loader
    }

    /// Whether an updater (name and/or image) is known — gates the avatar,
    /// so a `null` updater shows no placeholder circle (AC (1): "アバターを
    /// 出さず日時のみ").
    public var hasUpdater: Bool { updaterName != nil || updaterImage != nil }

    /// The relative representation of `lastUpdatedAt` ("3 days ago" /
    /// 「3日前」, device locale) — `nil` when missing or unparseable, which
    /// drops the time from the label rather than showing a raw/garbled value.
    public var relativeTimeText: String? { Self.relativeTimeText(from: lastUpdatedAt) }

    /// Whether this label renders anything at all — `false` degrades the row
    /// to its plain pre-extension look (segment/path title only, no empty gap).
    public var hasMetadata: Bool { hasUpdater || relativeTimeText != nil }

    public var body: some View {
        if hasMetadata {
            HStack(spacing: 5) {
                if hasUpdater {
                    WorkspaceAvatarView(imageURLString: updaterImage, loader: loader, size: 14)
                }
                if let text = metadataText {
                    Text(text)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    /// The caption line ("Sotaro · 3 days ago" / name only / time only) —
    /// `nil` when neither part is available (an image-only updater then
    /// still shows just the avatar).
    public var metadataText: String? {
        let parts = [updaterName, relativeTimeText].compactMap { $0 }
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

    /// - Parameter now: injectable for tests only — production callers use
    ///   the default.
    public static func relativeTimeText(from isoString: String?, relativeTo now: Date = Date()) -> String? {
        guard let date = date(fromISO8601: isoString) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
