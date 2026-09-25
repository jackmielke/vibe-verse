import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()

            VerseWebView(model: model)
                .ignoresSafeArea()
                .opacity(model.loaded ? 1 : 0)
                .animation(.easeOut(duration: 0.5), value: model.loaded)

            if !model.loaded && model.error == nil {
                VStack(spacing: 16) {
                    Text("Vibe Verse").font(.system(size: 32, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    ProgressView().tint(.white)
                }
                .transition(.opacity)
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
    weak var web: WKWebView?

    func reload() {
        error = nil
        loaded = false
        guard let web else { return }
        if web.url == nil { web.load(URLRequest(url: VerseWebView.home)) } else { web.reload() }
    }
}
