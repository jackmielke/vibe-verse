import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vibeventures.vibeverse',
  appName: 'VibeVerse',
  webDir: 'dist',

  // ── Alternative mode: live web app instead of bundled assets ─────────────
  //
  // Uncommenting the `server` block below makes the native app load the
  // deployed web app directly from the URL instead of the files bundled in
  // the binary. Every deploy to the web instantly updates the iOS app — no
  // App Store release, no review, no TestFlight build needed for updates.
  //
  // Trade-offs:
  //   + Ship web fixes/features instantly (OTA-style updates)
  //   - Requires network on first launch (no offline shell)
  //   - Apple review prefers apps that bundle their assets; a pure web
  //     wrapper pointing at a remote URL can draw extra scrutiny (guideline
  //     4.2 "minimum functionality"). Keep bundled mode (the default, with
  //     this block commented out) for App Store / TestFlight submissions.
  //
  // server: {
  //   url: 'https://vibeverse.example.com', // <- your production deploy URL
  // },
};

export default config;
