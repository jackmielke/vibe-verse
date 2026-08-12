/**
 * Should this keystroke open the universal search?
 *
 * A pure function rather than four conditions inside a `useEffect`, because
 * every one of them is a bug that fails silently and in somebody else's
 * feature. A global "/" handler that gets this wrong does not throw and does
 * not fail a build — it quietly eats a character out of a chat message, or
 * drops a full-screen overlay onto somebody mid-flight, and the report comes
 * back weeks later as "typing is weird in Vibe City".
 *
 * The rules, and who each one protects:
 *
 * - **A modifier means it is not ours.** Ctrl+/ and Cmd+/ are comment-toggles
 *   and browser shortcuts; only the bare key is a search.
 * - **Pointer lock means somebody is playing.** It is this repo's
 *   engine-agnostic "is playing" signal, used the same way by the home button.
 * - **A focused field owns its own keystrokes.** Inputs, textareas, selects and
 *   anything `contenteditable` — the "/" belongs to whoever is typing.
 */
export interface HotkeyContext {
  /** `document.pointerLockElement` — non-null while a world has the mouse. */
  pointerLocked: boolean;
  /** `document.activeElement`, or null. */
  active: { tagName: string; isContentEditable: boolean } | null;
}

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

export function isTypingTarget(active: HotkeyContext["active"]): boolean {
  if (!active) return false;
  return active.isContentEditable || TYPING.test(active.tagName);
}

export function shouldOpenSearch(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  ctx: HotkeyContext,
): boolean {
  if (e.key !== "/") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (ctx.pointerLocked) return false;
  if (isTypingTarget(ctx.active)) return false;
  return true;
}
