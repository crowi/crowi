import Foundation

/// Light, dark, or whatever the device is doing.
///
/// iOS already has a system-wide switch, so this exists for the case that
/// switch cannot express: a reader whose device is dark all day but who wants
/// long-form prose light (or the reverse). Persisted by raw value so a future
/// case cannot silently reinterpret a stored setting.
public enum AppAppearance: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
}

/// The app's OWN settings — the ones that belong to this install rather than
/// to any wiki.
///
/// Nothing here is ever sent anywhere. A Crowi account's settings live on its
/// server and are edited there; these describe how this copy of the app
/// behaves, so they stay in `UserDefaults` beside the workspace index and are
/// lost with the app, which is the correct lifetime for them.
@MainActor
public final class AppSettings: ObservableObject {
    private let defaults: UserDefaults

    /// Shows the raw failure behind a message, and the server facts a
    /// bug report needs.
    ///
    /// Ordinary copy deliberately says only what the reader can act on, which
    /// leaves nothing to report when something genuinely unforeseen happens —
    /// and a self-hosted wiki behind someone's own reverse proxy produces
    /// exactly those. This is the escape hatch, off by default because the
    /// detail is Apple's or the server's wording, not the app's.
    @Published public var isDeveloperModeEnabled: Bool {
        didSet { defaults.set(isDeveloperModeEnabled, forKey: Self.developerModeKey) }
    }

    /// Overrides the device's light/dark choice for this app only.
    @Published public var appearance: AppAppearance {
        didSet { defaults.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// Whether an external link opens inside the app.
    ///
    /// Handing it to the system browser leaves the app, and coming back can
    /// mean coming back to a process iOS terminated meanwhile — the page, the
    /// scroll position and the tab's history all gone for one tap on a
    /// citation. On by default for that reason; off is for readers who would
    /// rather have their real browser's extensions and sign-ins.
    @Published public var opensLinksInApp: Bool {
        didSet { defaults.set(opensLinksInApp, forKey: Self.opensLinksInAppKey) }
    }

    static let appearanceKey = "wiki.crowi.ios.settings.appearance"
    static let developerModeKey = "wiki.crowi.ios.settings.developerMode"
    static let opensLinksInAppKey = "wiki.crowi.ios.settings.opensLinksInApp"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        isDeveloperModeEnabled = defaults.bool(forKey: Self.developerModeKey)
        // `bool(forKey:)` answers false for "never set", which is the wrong
        // default here — read the object to tell unset from off.
        opensLinksInApp = defaults.object(forKey: Self.opensLinksInAppKey) as? Bool ?? true
        // An unreadable or retired stored value falls back to following the
        // device rather than picking a side for the reader.
        appearance = AppAppearance(rawValue: defaults.string(forKey: Self.appearanceKey) ?? "") ?? .system
    }
}

/// A message for the reader, and the failure it came from.
///
/// The two are kept together rather than the detail being discarded at the
/// catch site: whether the detail is shown is a SETTING, decided at render
/// time, and a value that threw it away could not answer that question later.
public struct DisplayableFailure: Equatable, Sendable {
    /// What the reader is told. Always the app's own words.
    public let message: String
    /// The underlying failure, for a bug report. `nil` when the app decided
    /// the outcome itself and there is no underlying error to show.
    public let detail: String?

    public init(message: String, detail: String? = nil) {
        self.message = message
        self.detail = detail
    }

    public init(message: String, error: Error) {
        self.message = message
        let error = error as NSError
        self.detail = "\(error.domain) \(error.code): \(error.localizedDescription)"
    }
}
