import CrowiKit
import SwiftUI
import WebKit

/// RFC-0020 — the body of an HTML artifact page, in place of the Markdown
/// render: the artifact runs in a web view pointed at its signed delivery
/// URL.
///
/// Never at the body the app already holds. The server's sandbox (scripts
/// allowed, but an opaque origin, no network, no forms, no popups) exists
/// only as a response header on that URL, so a locally loaded copy would run
/// the author's scripts with none of it — which is also why an offline
/// reader gets a notice here rather than the cached body.
///
/// The URL expires within a minute, so it is minted right before each load
/// and never kept.
struct ArtifactBodyView: View {
    enum Presentation {
        /// Inside a page's scroll view, at the web's own proportions.
        case inline
        /// Filling a full-screen cover.
        case fill
    }

    let session: WorkspaceSession
    let pageId: String
    let revisionId: String?
    var presentation: Presentation = .inline

    private enum Phase: Equatable {
        case preparing
        case running(URL)
        case unavailable(title: String, message: String, canRetry: Bool)
    }

    private struct MintKey: Equatable {
        let revisionId: String?
        let attempt: Int
    }

    @EnvironmentObject private var settings: AppSettings
    @Environment(\.openURL) private var openURL
    @State private var phase: Phase = .preparing
    /// Bumped to mint a fresh URL — a reload of the old one would hit an
    /// expired token.
    @State private var attempt = 0
    @State private var externalLink: ExternalLink?
    @State private var showsFullScreen = false

    var body: some View {
        content
            .task(id: MintKey(revisionId: revisionId, attempt: attempt)) { await mint() }
            .sheet(item: $externalLink) { link in
                SafariView(url: link.url)
                    .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showsFullScreen) {
                NavigationStack {
                    ArtifactBodyView(session: session, pageId: pageId, revisionId: revisionId, presentation: .fill)
                        .ignoresSafeArea(edges: .bottom)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showsFullScreen = false }
                            }
                        }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .preparing:
            ProgressView("Preparing page…")
                .frame(maxWidth: .infinity, minHeight: 160)
        case .running(let url):
            running(url)
        case .unavailable(let title, let message, let canRetry):
            ContentUnavailableView {
                Label(title, systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                if canRetry {
                    Button("Try Again") { attempt += 1 }
                }
            }
        }
    }

    @ViewBuilder
    private func running(_ url: URL) -> some View {
        let webView = ArtifactWebView(
            url: url,
            onOpenExternally: open,
            onLoadFailed: {
                phase = .unavailable(title: "Couldn't start this page", message: "The page didn't load.", canRetry: true)
            },
            onContentProcessTerminated: { attempt += 1 }
        )
        switch presentation {
        case .fill:
            webView
        case .inline:
            VStack(alignment: .leading, spacing: 8) {
                webView
                    .containerRelativeFrame(.vertical) { length, _ in max(length * 0.7, 480) }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(CrowiTheme.border, lineWidth: CrowiTheme.hairline))
                HStack(alignment: .firstTextBaseline) {
                    Text("Running sandboxed, agent-generated content. Anything you type here is not guaranteed to stay private.")
                        .font(CrowiTypography.rowMeta)
                        .foregroundStyle(CrowiTheme.mutedForeground)
                    Spacer(minLength: 12)
                    Button {
                        showsFullScreen = true
                    } label: {
                        Label("Full Screen", systemImage: "arrow.up.left.and.arrow.down.right")
                            .labelStyle(.iconOnly)
                    }
                }
            }
        }
    }

    private func mint() async {
        phase = .preparing
        do {
            switch try await ArtifactURLMint.mint(pageId: pageId, revisionId: revisionId, using: session.apiClient) {
            case .ready(let url):
                phase = .running(url)
            case .deliveryDisabled:
                phase = .unavailable(
                    title: "This page can't run here",
                    message: "HTML artifact delivery isn't configured on this server.",
                    canRetry: false
                )
            case .notAnArtifact, .failed:
                phase = .unavailable(
                    title: "Couldn't start this page",
                    message: "Something went wrong preparing this page to run.",
                    canRetry: true
                )
            }
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                return
            }
            let reason = NetworkFailureMessage.message(for: error) ?? "Something went wrong preparing this page to run."
            phase = .unavailable(
                title: "Available only while online",
                message: "\(reason) This page is sandboxed HTML the server delivers, so it can't be shown from the offline copy.",
                canRetry: true
            )
        }
    }

    /// Same rule as a Markdown body's links: the in-app browser when the
    /// reader asked for it, the system browser otherwise.
    private func open(_ url: URL) {
        if settings.opensLinksInApp {
            externalLink = ExternalLink(url: url)
        } else {
            openURL(url)
        }
    }
}

/// The web view the artifact runs in. What keeps it contained is the
/// server's CSP; what this adds is what the web gets from the document that
/// frames it: the artifact may not navigate itself anywhere else
/// (`ArtifactNavigationPolicy`), may not open windows, and shares no storage
/// with anything (a non-persistent data store, no script message handlers).
struct ArtifactWebView: UIViewRepresentable {
    let url: URL
    let onOpenExternally: (URL) -> Void
    /// The delivery route answered with something other than the page — an
    /// expired or reused token reads as a plain-text 404.
    let onLoadFailed: () -> Void
    let onContentProcessTerminated: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsLinkPreview = false
        context.coordinator.load(url, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.deliveryURL != url {
            context.coordinator.load(url, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: ArtifactWebView
        private(set) var deliveryURL: URL?
        /// The app's own request is let through as issued rather than judged
        /// by URL, since WebKit may hand it back re-encoded. A refusal later
        /// on (a redirect off the delivered document) is caught by
        /// `hasCommitted` instead of leaving a blank view.
        private var awaitsOwnRequest = false
        private var hasCommitted = false

        init(parent: ArtifactWebView) {
            self.parent = parent
        }

        func load(_ url: URL, in webView: WKWebView) {
            deliveryURL = url
            awaitsOwnRequest = true
            hasCommitted = false
            webView.load(URLRequest(url: url))
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let deliveryURL else {
                decisionHandler(.cancel)
                return
            }
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
            if awaitsOwnRequest, isMainFrame {
                awaitsOwnRequest = false
                decisionHandler(.allow)
                return
            }
            let decision = ArtifactNavigationPolicy.decide(
                requestURL: navigationAction.request.url,
                deliveryURL: deliveryURL,
                isMainFrame: isMainFrame,
                isLinkActivation: navigationAction.navigationType == .linkActivated
            )
            switch decision {
            case .allow:
                decisionHandler(.allow)
            case .cancel:
                decisionHandler(.cancel)
                if isMainFrame, !hasCommitted {
                    parent.onLoadFailed()
                }
            case .openExternally(let url):
                decisionHandler(.cancel)
                parent.onOpenExternally(url)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            if navigationResponse.isForMainFrame,
                let response = navigationResponse.response as? HTTPURLResponse,
                !(200..<300).contains(response.statusCode)
            {
                decisionHandler(.cancel)
                parent.onLoadFailed()
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            hasCommitted = true
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            reportUnlessCancelled(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportUnlessCancelled(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.onContentProcessTerminated()
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        /// A navigation this view itself refused ends as an interrupted load
        /// (WebKit's "frame load interrupted by policy change", which has no
        /// public constant), and that is not a failure of the page.
        private func reportUnlessCancelled(_ error: Error) {
            let nsError = error as NSError
            let interruptedByPolicy = nsError.domain == "WebKitErrorDomain" && nsError.code == 102
            let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
            guard !interruptedByPolicy, !cancelled else { return }
            parent.onLoadFailed()
        }
    }
}
