import AVFoundation
import SwiftUI

/// The whole Vibe Verse as an app: a shell around myvibeverse.com, so every
/// push to main is in the app the next time it opens. The shell adds no
/// browser chrome, sound with the silent switch on, the mic granted once,
/// and a screen that stays awake while you play.
@main
struct VibeVerseApp: App {
    init() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
        try? session.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                .preferredColorScheme(.dark)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}
