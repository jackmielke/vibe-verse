import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()

            VerseWebView(model: model)
                // Keep clear of the Dynamic Island; the page doesn't pad for it.
                .ignoresSafeArea(edges: .bottom)
                .opacity(model.loaded && model.minTimeElapsed ? 1 : 0)
                .animation(.easeOut(duration: 0.5), value: model.loaded && model.minTimeElapsed)

            if !(model.loaded && model.minTimeElapsed) && model.error == nil {
                SplashView().transition(.opacity)
            }

            if let error = model.error {
                VStack(spacing: 16) {
                    Text("Can't reach the Vibe Verse").font(.title2.bold()).foregroundStyle(.white)
                    Text(error).font(.footnote).foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center).padding(.horizontal, 32)
                    Button("Try again") { model.reload() }.buttonStyle(.borderedProminent)
                }
            }
        }
    }
}

@MainActor
final class WebModel: ObservableObject {
    @Published var loaded = false
    @Published var error: String?
    /// Hold the splash long enough to be seen, even on a warm cache.
    @Published var minTimeElapsed = false
    weak var web: WKWebView?

    init() {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.easeOut(duration: 0.5)) { minTimeElapsed = true }
        }
    }

    func reload() {
        error = nil
        loaded = false
        guard let web else { return }
        if web.url == nil { web.load(URLRequest(url: VerseWebView.home)) } else { web.reload() }
    }
}
