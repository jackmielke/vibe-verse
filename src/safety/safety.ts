/**
 * Report and block — what the App Store asks of anywhere strangers can show
 * each other words (Guideline 1.2).
 *
 * Three pieces, all keyed to what a player can actually see:
 *
 * - **Block** hides a player everywhere, by name (and by id when a world has
 *   a stable one). Names are what is on screen, and most worlds give peers a
 *   fresh id per tab, so a name is the only thing that survives a reload. The
 *   list lives on this device; each block is also sent to the server so the
 *   developer hears about it, which Apple requires.
 * - **Report** sends a player and/or a piece of content to `ugc-report`,
 *   which stores it and DMs Jack, so it can be acted on inside 24 hours.
 * - **Who is here** — each multiplayer world tells this module which players
 *   and messages are on screen (`setSafetyPeers`, `noteSafetyContent`), so the
 *   one Safety sheet can offer them without every world drawing its own.
 *
 * Worlds filter with `isBlocked(name, id)` wherever they take a peer in.
 */
import { supabase } from "@/integrations/supabase/client";
import { deviceId } from "@/magician/voice/session";

export interface SafetyTarget {
  /** Display name as shown on screen. */
  name?: string;
  /** Whatever stable id the world has for this player, if any. */
  id?: string;
  /** The words being reported, when it is a message rather than a person. */
  text?: string;
  /** Registry key of the world it happened in. */
  world?: string;
}

const BLOCKED_KEY = "vibe.blocked";
const TERMS_KEY = "vibe.termsAccepted.v1";
const CHANGED = "vibe:safety-changed";
const OPEN = "vibe:safety-open";

export const norm = (name?: string): string => (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

interface BlockedEntry {
  name: string;
  id?: string;
  at: number;
}

function readBlocked(): BlockedEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.name === "string") : [];
  } catch {
    return [];
  }
}

let blocked: BlockedEntry[] = readBlocked();
let blockedNames = new Set(blocked.map((e) => norm(e.name)));
let blockedIds = new Set(blocked.flatMap((e) => (e.id ? [e.id] : [])));

function save() {
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
  } catch {
    /* private mode: the block still holds for this page */
  }
  blockedNames = new Set(blocked.map((e) => norm(e.name)));
  blockedIds = new Set(blocked.flatMap((e) => (e.id ? [e.id] : [])));
  emit();
}

/** True if this player, by name or id, is on this device's block list. */
export function isBlocked(name?: string, id?: string): boolean {
  if (id && blockedIds.has(id)) return true;
  const n = norm(name);
  return n !== "" && blockedNames.has(n);
}

export const blockedList = (): readonly BlockedEntry[] => blocked;

export function block(t: SafetyTarget): void {
  const n = norm(t.name);
  if (!n && !t.id) return;
  if (!isBlocked(t.name, t.id)) {
    blocked = [...blocked, { name: t.name?.trim() || t.id || "player", id: t.id, at: Date.now() }];
    save();
  }
  void send("block", t);
}

export function unblock(name: string): void {
  const n = norm(name);
  blocked = blocked.filter((e) => norm(e.name) !== n);
  save();
}

export const REPORT_REASONS = [
  "Harassment or bullying",
  "Hate speech",
  "Sexual content",
  "Violence or threats",
  "Spam or scam",
  "Something else",
] as const;

/** File a report. Resolves true when the server has it. */
export async function report(t: SafetyTarget, reason: string): Promise<boolean> {
  return send("report", t, reason);
}

async function send(kind: "report" | "block", t: SafetyTarget, reason?: string): Promise<boolean> {
  try {
    const { data: auth } = await supabase.auth.getSession();
    const { error } = await supabase.functions.invoke("ugc-report", {
      body: {
        kind,
        reason,
        world: t.world ?? currentWorld(),
        target_name: t.name?.slice(0, 80),
        target_id: t.id?.slice(0, 120),
        content: t.text?.slice(0, 1000),
        device: deviceId(),
        user_id: auth.session?.user.id,
        path: window.location.pathname,
      },
    });
    return !error;
  } catch {
    return false;
  }
}

const currentWorld = () => window.location.pathname.replace(/^\//, "") || "home";

// ---------------------------------------------------------------------------
// Who and what is on screen — fed by the worlds, read by the Safety sheet
// ---------------------------------------------------------------------------

export interface SafetyPeer {
  name: string;
  id?: string;
}

export interface SafetyContent {
  name?: string;
  id?: string;
  text: string;
  at: number;
}

let peers: { world: string; list: SafetyPeer[] } = { world: "", list: [] };
let content: { world: string; list: SafetyContent[] } = { world: "", list: [] };

/** Replace the list of other players currently in `world`. */
export function setSafetyPeers(world: string, list: SafetyPeer[]): void {
  peers = { world, list: list.filter((p) => norm(p.name) !== "").slice(0, 100) };
  emit();
}

/** Remember a message somebody else wrote, so it can be reported. Keeps the last 40. */
export function noteSafetyContent(world: string, item: Omit<SafetyContent, "at">): void {
  if (!item.text?.trim()) return;
  const list = content.world === world ? content.list : [];
  content = { world, list: [...list, { ...item, at: Date.now() }].slice(-40) };
  emit();
}

export const safetyPeers = () => peers;
export const safetyContent = () => content;

/** Called on every route change, so the sheet never offers the last world's players. */
export function clearSafetyLists(): void {
  peers = { world: "", list: [] };
  content = { world: "", list: [] };
  emit();
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export function termsAccepted(): boolean {
  try {
    return localStorage.getItem(TERMS_KEY) !== null;
  } catch {
    return false;
  }
}

export function acceptTerms(): void {
  try {
    localStorage.setItem(TERMS_KEY, new Date().toISOString());
  } catch {
    /* shown again next launch, which is the safe failure */
  }
  emit();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let version = 0;
function emit() {
  version++;
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribeSafety(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
}

export const safetyVersion = () => version;

/** Open the Safety sheet, optionally on one player or message (tap a chat line, a name tag). */
export function openSafety(target?: SafetyTarget): void {
  window.dispatchEvent(new CustomEvent<SafetyTarget | undefined>(OPEN, { detail: target }));
}

export function onOpenSafety(cb: (t?: SafetyTarget) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<SafetyTarget | undefined>).detail);
  window.addEventListener(OPEN, h);
  return () => window.removeEventListener(OPEN, h);
}
