/**
 * Cannon Run's wire: two trucks, one Mort.
 *
 * The host's browser owns the chase (Mort, traffic, every cannonball and every
 * point of damage). The guest owns only where its own truck is and where its
 * cannon points, because steering through somebody else's round trip feels
 * like driving on ice. Each side sends what it owns, about fifteen times a
 * second, and both draw the same road.
 *
 *  - `online` is a Supabase Realtime broadcast channel, one per room.
 *  - `local` is a BroadcastChannel: every tab of one browser, no server. It is
 *    how this is tested in the sandbox, where Realtime is blocked, and it is
 *    also a real way to play: two windows on one laptop.
 */

export type NetMode = "online" | "local";

export interface Upgrades { armor: number; loader: number; nitro: number; auto: number; punch: number; engine: number }
export const UPGRADE_KEYS = ["armor", "loader", "nitro", "auto", "punch", "engine"] as const;

/** Guest to host, on joining and until the host says go. */
export interface Hello { t: "hi"; up: Upgrades }
/** Host to guest: the chase is on. */
export interface Go { t: "go" }
/** Guest to host: where my truck is and what my cannon is doing. */
export interface Input { t: "in"; g: number; s: number; lat: number; v: number; vl: number; boost: number; yaw: number; pitch: number; fire: number }
/** Host to guest: everything else. Arrays, to keep packets small. */
export interface Snap {
  t: "st";
  /** host clock, seconds */
  k: number;
  /** which run this is; it goes up by one on every restart */
  g: number;
  ph: string;
  /** riders: s, lat, v, vl, hull, max, boost, reload, yaw, pitch, out, respawn, disarmed, gone, autoYaw */
  r: number[][];
  /** Mort: s, lat, y, roll, level, hp, max, wreck, rage, lunge, v, vl, seated, rollV, vy */
  e: number[];
  /** Linda, when there are two of you */
  e2?: number[] | null;
  tk2?: string;
  /** balls: s, lat, y, vs, vl, vy, small */
  b: number[][];
  /** thrown: s, lat, y, vs, vl, vy, kind, targetLat, passed, rider */
  th: number[][];
  /** traffic: s, lat, y, v, vl, vy, rx, ry, rz, wx, wy, wz, color, mode */
  tr: number[][];
  /** the walk, when Mort comes for the cannon: s, lat, y, yaw, phase, carrying, rider */
  w: number[] | null;
  sc: number;
  cash: number;
  hits: number;
  wrecks: number;
  talk: string;
  toast: string;
  /** henchmen, one row per pool slot: s, lat, y, state (-1 for none), v, rx, walk, yaw */
  hm: number[][];
  /** the big red alert, when backup is coming */
  al: string;
  /** effects since the last snapshot: [kind, s, lat, y, rider] */
  ev: (string | number)[][];
}
export interface Bye { t: "bye" }
export type Wire = Hello | Go | Input | Snap | Bye;

export interface Transport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 8000;
const TOPIC = "cr";

const isWire = (m: unknown): m is Wire => typeof m === "object" && m !== null && typeof (m as { t?: unknown }).t === "string";

export async function openTransport(mode: NetMode, room: string): Promise<Transport | null> {
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

function openLocal(room: string): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`cannonrun-${room}`);
  let handler: ((msg: Wire) => void) | null = null;
  ch.onmessage = (ev: MessageEvent) => { if (handler && isWire(ev.data)) handler(ev.data); };
  return {
    send: (msg) => { try { ch.postMessage(msg); } catch { /* closed */ } },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; try { ch.close(); } catch { /* closed */ } },
  };
}

async function openOnline(room: string): Promise<Transport | null> {
  const { supabase } = await import("@/integrations/supabase/client");
  const channel = supabase.channel(`cannonrun-${room}`, { config: { broadcast: { self: false, ack: false } } });
  let handler: ((msg: Wire) => void) | null = null;
  channel.on("broadcast", { event: TOPIC }, ({ payload }: { payload: unknown }) => { if (handler && isWire(payload)) handler(payload); });
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
    const timer = window.setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") { window.clearTimeout(timer); finish(true); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { window.clearTimeout(timer); finish(false); }
    });
  });
  if (!ok) { try { await supabase.removeChannel(channel); } catch { /* nothing */ } return null; }
  return {
    send: (msg) => { void channel.send({ type: "broadcast", event: TOPIC, payload: msg }); },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; void supabase.removeChannel(channel); },
  };
}

/** Four letters nobody will misread on a phone. */
export function roomCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/* ------------------------------------------------------------ the garage */

export const UPGRADE_COST = [250, 600, 1200];
export const UPGRADES: { key: keyof Upgrades; name: string; what: string }[] = [
  { key: "armor", name: "Armour plate", what: "+25 truck health a level" },
  { key: "loader", name: "Quick loader", what: "the cannon reloads 15% faster a level" },
  { key: "nitro", name: "Bigger nitro", what: "more boost, and it lasts longer" },
  { key: "auto", name: "Auto cannon", what: "a roof gun that shoots by itself, henchmen first; faster each level" },
  { key: "punch", name: "Heavier shot", what: "the auto cannon hits harder" },
  { key: "engine", name: "Big engine", what: "a faster truck: Mort closes in slower" },
];

export function readBank(): { bank: number; up: Upgrades } {
  const up: Upgrades = { armor: 0, loader: 0, nitro: 0, auto: 0, punch: 0, engine: 0 };
  let bank = 0;
  try {
    bank = Math.max(0, Number(localStorage.getItem("cannonrun.bank") ?? 0) || 0);
    const raw = JSON.parse(localStorage.getItem("cannonrun.upgrades") ?? "{}") as Partial<Upgrades>;
    for (const k of UPGRADE_KEYS) up[k] = Math.max(0, Math.min(3, Math.floor(Number(raw[k] ?? 0) || 0)));
  } catch { /* private window */ }
  return { bank, up };
}

export function writeBank(bank: number, up: Upgrades): void {
  try {
    localStorage.setItem("cannonrun.bank", String(Math.max(0, Math.round(bank))));
    localStorage.setItem("cannonrun.upgrades", JSON.stringify(up));
  } catch { /* private window */ }
}
