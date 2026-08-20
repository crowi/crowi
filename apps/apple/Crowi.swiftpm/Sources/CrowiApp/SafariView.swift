import SafariServices
import SwiftUI

/// `SFSafariViewController` as a sheet, for external links when the reader
/// has asked to stay in the app (`AppSettings.opensLinksInApp`).
///
/// Not a `WKWebView`: Safari View Controller keeps the reader's real cookies,
/// Reader mode, content blockers and password autofill, and is a surface
/// the app cannot see into — which is what makes it acceptable to send a
/// third-party page through it at all.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        return SFSafariViewController(url: url, configuration: configuration)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// An attachment being previewed — a bare `String` is not `Identifiable`,
/// which `.sheet(item:)` requires.
struct PreviewedAttachment: Identifiable {
    let id: String
}

/// A URL that is being presented — `URL` itself is not `Identifiable`.
struct ExternalLink: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}
