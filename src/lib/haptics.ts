/**
 * Haptics inside the iOS app. The shell (`ios/VibeVerse`, `HapticBridge`)
 * listens on `window.webkit.messageHandlers.haptic`; everywhere else this is a
 * no-op, so worlds can call it freely.
 */
export type Haptic = "selection" | "light" | "medium" | "heavy" | "rigid" | "success" | "warning" | "error";

interface HapticWindow {
  webkit?: { messageHandlers?: { haptic?: { postMessage: (k: Haptic) => void } } };
}

export function haptic(kind: Haptic = "light"): void {
  try {
    (window as unknown as HapticWindow).webkit?.messageHandlers?.haptic?.postMessage(kind);
  } catch {
    /* not in the app */
  }
}
