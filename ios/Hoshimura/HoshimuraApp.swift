import AVFoundation
import SwiftUI

/// Hoshimura: The Magician as an app.
///
/// The world itself is the web build at myvibeverse.com/magician, so every
/// push to main is in the app the next time it opens, with no new build.
/// What the app adds is what a browser tab cannot: no browser chrome, the
/// microphone granted once for Vibey, sound that plays with the silent
/// switch on, and a screen that stays awake while you play.
@main
struct HoshimuraApp: App {
    init() {
        Sound.configure()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                .preferredColorScheme(.dark)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

enum Sound {
    /// Play-and-record, so Vibey can hear you; to the speaker, not the
    /// earpiece; and not silenced by the ring switch, which would otherwise
    /// mute the whole valley on most phones in a demo room.
    static func configure() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? session.setActive(true)
    }
}
