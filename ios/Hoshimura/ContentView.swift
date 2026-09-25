import SwiftUI
import WebKit

/// The valley, the moment before it loads, and what to do if it cannot.
struct ContentView: View {
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()

            MagicianWebView(model: model)
                .ignoresSafeArea()
                .opacity(model.loaded ? 1 : 0)
                .animation(.easeOut(duration: 0.6), value: model.loaded)

            if !model.loaded && model.error == nil {
                VStack(spacing: 14) {
                    Text("星村")
                        .font(.system(size: 18, weight: .medium, design: .serif))
                        .foregroundStyle(Color(red: 0.55, green: 0.85, blue: 0.95))
                        .tracking(6)
                    Text("Hoshimura")
                        .font(.system(size: 40, weight: .regular, design: .serif))
                        .foregroundStyle(Color(red: 1.0, green: 0.95, blue: 0.9))
                    ProgressView().tint(Color(red: 1.0, green: 0.84, blue: 0.63)).padding(.top, 8)
                }
                .transition(.opacity)
            }

            if let error = model.error {
                VStack(spacing: 16) {
                    Text("The valley is out of reach")
                        .font(.system(size: 24, weight: .regular, design: .serif))
                        .foregroundStyle(Color(red: 1.0, green: 0.95, blue: 0.9))
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.55))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Button("Try again") { model.reload() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color(red: 0.76, green: 0.23, blue: 0.17))
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
        if let web {
            if web.url == nil { web.load(URLRequest(url: MagicianWebView.home)) } else { web.reload() }
        }
    }
}
