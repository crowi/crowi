import Foundation

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

    static let developerModeKey = "wiki.crowi.ios.settings.developerMode"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        isDeveloperModeEnabled = defaults.bool(forKey: Self.developerModeKey)
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
