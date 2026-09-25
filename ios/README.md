# Hoshimura for iPhone

The Magician as an app. It is a thin SwiftUI shell around a full-screen
WKWebView on `https://myvibeverse.com/magician?app=ios`, so the world itself
is the web build: every push to `main` is in the app the next time it opens,
and TestFlight only needs a new build when something in `ios/` changes.

What the shell adds over a Safari tab:

- no browser chrome, status bar or home indicator in the way
- the microphone granted once, for the app, instead of on every visit
- sound that plays with the ring/silent switch on (AVAudioSession `playAndRecord`)
- the screen stays awake while you play
- links off `myvibeverse.com` open in Safari; the page reloads itself if iOS
  kills its web process

## Run it on your phone

1. Open `ios/Hoshimura.xcodeproj` in Xcode 16 or newer.
2. Select the **Hoshimura** target, **Signing & Capabilities**, and pick your
   Team. A free Apple ID works for this step.
3. Plug in the phone (or pick it over Wi-Fi), choose it as the run
   destination, press Run. The first time, the phone asks you to trust the
   developer under Settings > General > VPN & Device Management.

## TestFlight

Needs a paid Apple Developer Program membership ($99 a year).

1. **Create the app record.** App Store Connect > Apps > + > New App.
   Platform iOS, bundle id `com.myvibeverse.hoshimura` (register it under
   Certificates, Identifiers & Profiles first if it is not in the list), SKU
   anything. The name must be unique across the whole App Store, so if
   "Hoshimura" is taken use something like "Hoshimura Valley"; the name on the
   home screen stays Hoshimura.
2. **Upload a build**, either way:
   - `TEAM_ID=ABCDE12345 ./ios/scripts/testflight.sh` (your team id is on
     developer.apple.com/account under Membership details), or
   - in Xcode: destination **Any iOS Device (arm64)**, Product > Archive, then
     Distribute App > App Store Connect > Upload. Bump the Build number in the
     target's General tab first if you have uploaded before.
3. **Wait for processing** (5 to 15 minutes; Apple emails you). The build
   appears under the app's TestFlight tab.
4. **Invite people.**
   - *Internal testers* (people on your App Store Connect team, up to 100):
     add them under Internal Testing. No review, available right away.
   - *Everyone else*: create an External Testing group, add the build and
     turn on a **public link**. The first build of an app goes through Beta
     App Review (usually under a day); it asks for a feedback email, a short
     "what to test", and a contact. Later builds are usually approved in
     minutes.

Testers install the TestFlight app, then open your invite or the public link.

## Details worth knowing

- **Export compliance** is answered in `Config/Info.plist`
  (`ITSAppUsesNonExemptEncryption = false`; the app only uses HTTPS), so
  uploads do not stop to ask.
- **The icon** is `Config/icon.svg`, rendered to
  `Hoshimura/Assets.xcassets/AppIcon.appiconset/icon-1024.png` with no alpha
  channel (App Store Connect rejects an icon with one).
- **The page can tell it is in the app**: the URL carries `?app=ios` and the
  user agent ends in `Hoshimura-iOS/1.0`.
- **Debugging the page**: Safari > Develop > (your phone) > Hoshimura attaches
  Web Inspector to the running app (iOS 16.4+).
- **Full App Store release** (not just TestFlight) is a different review.
  Apple's guideline 4.2 turns down apps that are "just a website", so that
  needs a case for what the app does natively. TestFlight has no such bar.
