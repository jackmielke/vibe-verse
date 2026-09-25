import SwiftUI
import WebKit

/// A full-screen WKWebView on /magician, set up for a 3D world you talk to.
struct MagicianWebView: UIViewRepresentable {
    @ObservedObject var model: WebModel

    /// Where the valley lives. `app=ios` lets the page know it is inside the app.
    static let home = URL(string: "https://myvibeverse.com/magician?app=ios")!
    /// Pages on these hosts stay in the app; anything else opens in Safari.
    static let ownHosts = ["myvibeverse.com"]

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "Hoshimura-iOS/1.0"

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        // A world, not a page: nothing scrolls, bounces or swipes back.
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.allowsLinkPreview = false
        if #available(iOS 16.4, *) { web.isInspectable = true }

        model.web = web
        web.load(URLRequest(url: Self.home))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: WebModel
        init(model: WebModel) { self.model = model }

        private func isOwn(_ url: URL) -> Bool {
            guard let host = url.host?.lowercased() else { return true }
            return MagicianWebView.ownHosts.contains { host == $0 || host.hasSuffix("." + $0) }
        }

        // The microphone for Vibey: granted for our own site without asking
        // a second time (iOS has already asked once, for the app).
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let own = MagicianWebView.ownHosts.contains { origin.host == $0 || origin.host.hasSuffix("." + $0) }
            decisionHandler(own ? .grant : .prompt)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            // Frames inside the page (the Magic Screen's sandbox) are the page's business.
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if mainFrame, ["http", "https"].contains(scheme), !isOwn(url) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            if !["http", "https", "about", "blob", "data"].contains(scheme) {
                // mailto:, sms:, and the like.
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // target=_blank and window.open: out to Safari.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                model.loaded = true
                model.error = nil
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

        private func fail(_ error: Error) {
            let e = error as NSError
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
            Task { @MainActor in
                if !model.loaded { model.error = e.localizedDescription }
            }
        }

        // A 3D world can outgrow what iOS allows a web page; if the page's
        // process is killed, bring the valley back instead of a white screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            completionHandler()
        }
    }
}
