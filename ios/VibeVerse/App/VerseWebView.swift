import SwiftUI
import WebKit

/// Full-screen WKWebView on myvibeverse.com. Swipe from the left edge to go back.
struct VerseWebView: UIViewRepresentable {
    @ObservedObject var model: WebModel

    /// `app=ios` lets the page know it is inside the app.
    static let home = URL(string: "https://myvibeverse.com/?app=ios")!
    /// Main-frame pages on these hosts stay in the app; anything else opens in Safari.
    static let ownHosts = ["myvibeverse.com", "supabase.co"]

    static func isOwn(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return true }
        return ownHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "VibeVerse-iOS/1.0"
        // window.webkit.messageHandlers.haptic.postMessage("light" | "medium" | "heavy" | "success" | "warning" | "error" | "selection")
        config.userContentController.add(HapticBridge(), name: "haptic")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = true
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

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(VerseWebView.isOwn(origin.host) ? .grant : .prompt)
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
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if mainFrame, ["http", "https"].contains(scheme), !VerseWebView.isOwn(url.host) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            if !["http", "https", "about", "blob", "data"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // target=_blank / window.open: our own pages load in place, the rest go to Safari.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                if VerseWebView.isOwn(url.host) { webView.load(URLRequest(url: url)) } else { UIApplication.shared.open(url) }
            }
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

        // Big 3D worlds can get the web process killed; come back instead of a white screen.
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

/// Taps, hits and wins from the page, felt in the hand. See `src/lib/haptics.ts`.
final class HapticBridge: NSObject, WKScriptMessageHandler {
    private let selection = UISelectionFeedbackGenerator()
    private let notify = UINotificationFeedbackGenerator()

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let kind = message.body as? String else { return }
        switch kind {
        case "selection": selection.selectionChanged()
        case "success": notify.notificationOccurred(.success)
        case "warning": notify.notificationOccurred(.warning)
        case "error": notify.notificationOccurred(.error)
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "rigid": UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
