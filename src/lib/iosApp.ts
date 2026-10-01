/**
 * Are we running inside the Vibe Verse iOS app?
 *
 * The shell (`ios/VibeVerse`) opens `/?app=ios` and appends `VibeVerse-iOS/1.0`
 * to its user agent. The query string is gone after the first in-app
 * navigation, so it is remembered in localStorage — which inside the app's
 * WKWebView is the app's own store, separate from Safari's, so a phone that
 * opens the website in Safari never inherits it.
 *
 * Read once at module load: whether you are in the app does not change while
 * the page is open, and the registry needs the answer before React exists.
 */
const KEY = "vibe.iosApp";

function detect(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (/VibeVerse-iOS\//.test(navigator.userAgent)) return true;
    const app = new URLSearchParams(window.location.search).get("app");
    if (app === "ios") {
      localStorage.setItem(KEY, "1");
      return true;
    }
    // `?app=web` undoes a `?app=ios` preview in a desktop browser.
    if (app === "web") localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const IOS_APP: boolean = detect();
