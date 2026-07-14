# VibeVerse on iOS — Mac → TestFlight Checklist

The iOS app is a Capacitor wrapper around the web app. Everything Linux-side is
already done: the `ios/` Xcode project is scaffolded, `capacitor.config.ts` is
set up, and the npm scripts exist. This doc is the Mac side — follow it top to
bottom and you'll be on TestFlight in ~30 minutes (plus Apple's build
processing time).

## 0. Prerequisites (one-time)

- [ ] **Xcode** — install from the Mac App Store (it's big; start the download
      first). Open it once and accept the license / let it install components.
- [ ] **Apple Developer Program** — you already pay for this. Make sure you're
      signed in: Xcode → Settings → Accounts → add your Apple ID.
- [ ] **Node** — anything ≥ 20 is fine.
- [ ] **CocoaPods — NOT needed.** Capacitor 8 uses Swift Package Manager;
      there is no Podfile in this project. Xcode resolves the Capacitor
      packages automatically on first open. (Older guides say
      `sudo gem install cocoapods` — skip it.)

## 1. Get the code building

```bash
git clone <repo-url> vibe-explorer   # or cd into your existing checkout
cd vibe-explorer
git checkout claude/local-business-strategy-a2xnu4   # or main once merged
npm install --legacy-peer-deps
npm run mobile:sync    # vite build + copies web assets into ios/
npm run mobile:open    # opens the project in Xcode
```

`npm run mobile:sync` is the command to re-run **every time you change web
code** and want it in the app. The `ios/App/App/public/` folder is
git-ignored on purpose — sync regenerates it from `dist/`.

## 2. Xcode: signing (2 minutes)

1. In the left sidebar, click the blue **App** project icon → select the
   **App** target.
2. **Signing & Capabilities** tab:
   - Check **Automatically manage signing**.
   - **Team**: pick your Apple Developer team.
   - **Bundle Identifier**: should already read `com.vibeventures.vibeverse`
     — leave it.
3. First open only: wait for the status bar to finish "Resolving Package
   Dependencies" (SPM pulling Capacitor — 1–3 min).

## 3. Test on your actual iPhone first

The map (Mapbox GL) and 3D pages (Three.js) are heavy — **the simulator lies
about performance and sometimes about WebGL. Test on the real device.**

1. Plug in your iPhone. On the phone: trust the computer.
2. In Xcode's toolbar device picker, choose your iPhone.
3. Press **Run** (⌘R). First time: on the phone go to
   Settings → General → VPN & Device Management → trust your developer cert.
4. Click around: map loads, location prompt appears, 3D scenes render, login
   works.

## 4. App Store Connect: create the app record (one-time)

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) →
   **Apps** → **+** → **New App**.
2. Fill in:
   - **Platform**: iOS
   - **Name**: VibeVerse (must be unique on the App Store — have a backup
     like "VibeVerse World" just in case)
   - **Primary language**: English (U.S.)
   - **Bundle ID**: `com.vibeventures.vibeverse` (appears in the dropdown
     after Xcode registers it — if it's missing, register it at
     developer.apple.com → Identifiers, or just do step 5's Archive first)
   - **SKU**: `vibeverse-ios` (internal only, never shown to users)

## 5. Archive → TestFlight

1. In Xcode's device picker choose **Any iOS Device (arm64)** (not a
   simulator — Archive is greyed out otherwise).
2. **Product → Archive**. Wait for the build.
3. In the Organizer window that pops up: **Distribute App** →
   **TestFlight & App Store** (a.k.a. "App Store Connect") → **Upload** →
   accept defaults → **Upload**.
4. Wait 5–30 min for processing (you'll get an email). Then in App Store
   Connect → your app → **TestFlight** tab:
   - Answer the export-compliance question (standard HTTPS only → "None of
     the algorithms mentioned above" / exempt).
   - Add yourself to **Internal Testing** → install via the TestFlight app
     on your phone.
5. For friends: add their Apple IDs as internal testers (instant, up to 100),
   or create an external group + public link (requires a one-time lightweight
   Beta App Review, usually < 24h).

## 6. Shipping updates

- **Web changes** (most of your work): `npm run mobile:sync`, then Archive →
  Upload again. Bump **Build number** (App target → General) each upload —
  Xcode will refuse duplicates.
- **Native changes** (new plugins, config): same, plus `npx cap sync ios`
  is already part of `mobile:sync`.

## Gotchas & good-to-knows

- **First build is slow.** SPM package resolution + a cold Xcode build can
  take several minutes. Subsequent builds are fast.
- **App size: the 3D models are BIG.** The bundled web assets are ~270 MB
  (floating-island, astronaut, rocky, etc. `.glb` files). TestFlight is fine
  with this, but it makes uploads/downloads slow and the installed app chunky.
  If it hurts, load the GLBs from a CDN/Supabase storage instead of bundling.
- **Permissions.** `NSLocationWhenInUseUsageDescription` is already in
  `ios/App/App/Info.plist` (the map asks for location). If you later add
  camera or photo uploads, add `NSCameraUsageDescription` /
  `NSPhotoLibraryUsageDescription` there too — the app hard-crashes on use
  without them.
- **Simulator ≠ iPhone.** Mapbox + Three.js run on WebGL/Metal; judge
  performance only on hardware.
- **OTA-style updates (the escape hatch).** `capacitor.config.ts` has a
  commented-out `server: { url: ... }` block. Uncomment it and the app loads
  your live deployed site instead of bundled files — every web deploy
  instantly updates the app, zero App Store releases. Trade-offs: needs
  network, and Apple review prefers bundled assets (a bare remote-URL wrapper
  can trip "minimum functionality" review). Recommended play: keep bundled
  mode for App Store submissions; server-url mode is great for internal
  TestFlight iteration.
- **"Signing requires a development team"** → you skipped step 2, or your
  membership lapsed.
- **Blank white screen on launch** → you forgot `npm run mobile:sync` after
  a fresh clone (no `dist/` copied in yet).

Much love ✌🏼
