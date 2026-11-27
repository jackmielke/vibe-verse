/**
 * The Wizard, wired up: one world's edits from Supabase, folded and drawn,
 * live for everybody on it, plus the conversation and the remix button.
 *
 * Where the world lives. `commons` is the shared island everybody builds
 * together. Any world can be remixed: `fork` copies what is standing into a
 * new world that only this device can wish into, and anybody with the link
 * (`?world=<id>`) can visit it and remix it again. Same tables, same
 * renderer, same Wizard; a fork is just a different `world_id`.
 *
 * Sync is the table itself. Every client subscribes to `postgres_changes` on
 * `wizard_edits` for its world, so a granted wish (an INSERT) or an undo (an
 * UPDATE) reaches every browser without anybody hosting anything, and a
 * reload sees the same world because it reads the same rows.
 *
 * `?wizard=local` skips the network entirely, for the sandbox, which cannot
 * reach Supabase: wishes are refused, but `window.__wizard.apply()` draws
 * ops exactly as a granted wish would.
 */
import * as THREE from "three";

import { supabase } from "@/integrations/supabase/client";
import { fold, type EditRow, type Here, type Op, type WorldState } from "../../supabase/functions/vibe-wizard/spec.ts";
import { createWizardLayer, type WizardLayer } from "./render";

export interface WizardWorld {
  id: string;
  name: string;
  parent_id?: string | null;
  owner_name?: string | null;
  /** This device may wish into it. */
  mine: boolean;
  shared: boolean;
}

export interface ChatLine {
  who: "you" | "wizard" | "system";
  text: string;
  editId?: number;
  undone?: boolean;
  tier?: string;
}

export type Busy = null | "fast" | "smart" | "remix";

export interface WizardSnapshot {
  world: WizardWorld;
  things: number;
  busy: Busy;
  log: ChatLine[];
  offline: boolean;
  /** Recent wishes on this world by anybody, newest first. */
  feed: Array<{ id: number; author: string; prompt: string; undone: boolean; mine: boolean }>;
}

export interface WizardController {
  layer: WizardLayer;
  snapshot(): WizardSnapshot;
  subscribe(cb: () => void): () => void;
  wish(text: string): Promise<void>;
  undo(editId: number): Promise<void>;
  remix(name?: string): Promise<void>;
  switchWorld(id: string): Promise<void>;
  shareUrl(): string;
  /** Fired when a wish lands (yours or anybody's), with where. */
  onGrant(cb: (at: THREE.Vector3, mine: boolean) => void): () => void;
  onSpeak(cb: (text: string) => void): () => void;
  update(dt: number, now: number, viewer?: THREE.Vector3): void;
  dispose(): void;
}

const DEVICE_KEY = "wizard.device";
const MINE_KEY = "wizard.myWorlds";
const MY_EDITS_KEY = "wizard.myEdits";

function readJson<T>(key: string, d: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}
export function deviceId(): string {
  let id = "";
  try {
    id = localStorage.getItem(DEVICE_KEY) ?? "";
    if (!id) {
      id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "");
      localStorage.setItem(DEVICE_KEY, id);
    }
  } catch {
    id = "ephemeral" + Math.random().toString(36).slice(2);
  }
  return id;
}

interface FullRow extends EditRow {
  id: number;
  world_id: string;
  author: string | null;
  prompt: string | null;
  reply: string | null;
  tier: string | null;
}

// The generated types do not know these tables; keep the escape hatch in one place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function createWizard(opts: {
  getHere: () => Here;
  getName: () => string;
  initialWorld?: string;
  offline?: boolean;
  lowDetail?: boolean;
}): WizardController {
  const layer = createWizardLayer({ lowDetail: opts.lowDetail });
  const device = deviceId();
  const listeners = new Set<() => void>();
  const grantListeners = new Set<(at: THREE.Vector3, mine: boolean) => void>();
  const speakListeners = new Set<(text: string) => void>();
  const offline = !!opts.offline;

  let rows: FullRow[] = [];
  let state: WorldState = { things: new Map() };
  let channel: { unsubscribe(): void } | null = null;
  let busy: Busy = null;
  const log: ChatLine[] = [];
  let myEdits = new Set<number>(readJson<number[]>(MY_EDITS_KEY, []));
  let myWorlds: Record<string, string> = readJson(MINE_KEY, {});
  let world: WizardWorld = { id: "commons", name: "Vibe Island", mine: true, shared: true };
  let snap: WizardSnapshot | null = null;
  let disposed = false;
  let localSeq = 1_000_000;

  const emit = () => {
    snap = null;
    listeners.forEach((l) => l());
  };
  const say = (who: ChatLine["who"], text: string, extra: Partial<ChatLine> = {}) => {
    log.push({ who, text: text.replace(/\s*[\u2014\u2013]\s*/g, ", "), ...extra });
    if (log.length > 60) log.splice(0, log.length - 60);
    if (who === "wizard") speakListeners.forEach((l) => l(text));
    emit();
  };

  const refold = () => {
    state = fold(rows);
    layer.setState(state);
    emit();
  };

  const centreOf = (ops: Op[]): THREE.Vector3 | null => {
    for (const op of ops) if (op.op === "add") return new THREE.Vector3(...op.thing.at);
    return null;
  };

  const ingest = (row: FullRow, fresh: boolean) => {
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = { ...rows[i], ...row };
    else {
      rows.push(row);
      rows.sort((a, b) => a.id - b.id);
      if (fresh && !row.undone) {
        const at = centreOf((Array.isArray(row.ops) ? row.ops : []) as Op[]);
        if (at) grantListeners.forEach((l) => l(at, myEdits.has(row.id)));
      }
    }
    refold();
  };

  const loadWorld = async (id: string) => {
    channel?.unsubscribe();
    channel = null;
    rows = [];
    const mine = id === "commons" || !!myWorlds[id];
    world = { id, name: id === "commons" ? "Vibe Island" : myWorlds[id] ?? "a remixed world", mine, shared: id === "commons" };
    refold();
    if (offline) return;
    const { data: w } = await db.from("wizard_worlds").select("id, name, parent_id, owner_name").eq("id", id).maybeSingle();
    if (disposed) return;
    if (!w) {
      if (id !== "commons") {
        say("system", "That world has vanished in a puff of smoke. Back to the shared island!");
        return loadWorld("commons");
      }
    } else {
      world = { ...world, name: w.name, parent_id: w.parent_id, owner_name: w.owner_name };
    }
    const { data } = await db
      .from("wizard_edits")
      .select("id, world_id, author, prompt, reply, ops, tier, undone, created_at")
      .eq("world_id", id)
      .order("id", { ascending: true })
      .limit(2000);
    if (disposed || world.id !== id) return;
    rows = (data ?? []) as FullRow[];
    refold();
    const ch = db
      .channel(`wizard-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "wizard_edits", filter: `world_id=eq.${id}` },
        (p: { new: FullRow }) => {
          if (world.id === id && p.new?.id) ingest(p.new, true);
        })
      .subscribe();
    channel = ch;
  };

  const invoke = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("vibe-wizard", { body: { device, author: opts.getName(), ...body } });
    if (error) {
      // A 4xx carries a friendly message in the body; surface it.
      try {
        const ctx = (error as { context?: Response }).context;
        const j = ctx ? await ctx.json() : null;
        if (j?.error) return { ok: false, error: j.error as string, code: j.code as string | undefined };
      } catch {
        /* fall through */
      }
      return { ok: false, error: "The spell backfired. Is the internet awake?" };
    }
    return data as Record<string, unknown> & { ok: boolean; error?: string };
  };

  const remember = (editId: number) => {
    myEdits.add(editId);
    writeJson(MY_EDITS_KEY, [...myEdits].slice(-300));
  };

  const history = () => log.filter((l) => l.who !== "system").slice(-6).map((l) => ({ who: l.who, text: l.text }));

  const ask = async (text: string, tier: "fast" | "smart"): Promise<void> => {
    busy = tier;
    emit();
    const here = opts.getHere();
    const res = await invoke({ action: "wish", world: world.id, text, here, tier, history: history().slice(0, -1) });
    busy = null;
    if (!res.ok) {
      say("wizard", String(res.error ?? "The spell fizzled."));
      if (res.code === "not_owner") world = { ...world, mine: false };
      emit();
      return;
    }
    const verdict = String(res.verdict);
    const line = String(res.say ?? "");
    if (verdict === "escalate") {
      say("wizard", line || "Ooh, that needs the ancient scrolls. One moment!", { tier: "smart" });
      return ask(text, "smart");
    }
    const edit = res.edit as FullRow | undefined;
    if (edit?.id) remember(edit.id);
    say("wizard", line, { editId: edit?.id, tier });
    if (edit) ingest(edit, true);
  };

  const api: WizardController = {
    layer,
    snapshot() {
      if (!snap) {
        snap = {
          world,
          things: state.things.size,
          busy,
          log: log.map((l) => (l.editId ? { ...l, undone: !!rows.find((r) => r.id === l.editId)?.undone } : l)),
          offline,
          feed: rows
            .filter((r) => r.tier !== "fork" && r.prompt)
            .slice(-12)
            .reverse()
            .map((r) => ({ id: r.id, author: r.author ?? "someone", prompt: r.prompt ?? "", undone: !!r.undone, mine: myEdits.has(r.id) })),
        };
      }
      return snap;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async wish(text) {
      const t = text.trim();
      if (!t || busy) return;
      say("you", t);
      if (offline) {
        say("wizard", "My crystal ball has no signal here. (Offline mode: use window.__wizard.apply in a test.)");
        return;
      }
      if (!world.mine) {
        say("wizard", "This world belongs to somebody else, so I cannot change it for you. Press Remix and it is yours!");
        return;
      }
      try {
        await ask(t, "fast");
      } catch {
        busy = null;
        say("wizard", "The spell backfired. Try again?");
      }
    },
    async undo(editId) {
      if (offline) {
        const r = rows.find((x) => x.id === editId);
        if (r) ingest({ ...r, undone: !r.undone }, false);
        return;
      }
      const r = rows.find((x) => x.id === editId);
      const redo = !!r?.undone;
      const res = await invoke({ action: "undo", edit: editId, redo });
      if (!res.ok) say("wizard", String(res.error ?? "That one is stuck fast."));
      else if (r) ingest({ ...r, undone: !redo }, false);
    },
    async remix(name) {
      if (busy) return;
      if (offline) {
        say("system", "Remix needs the internet.");
        return;
      }
      busy = "remix";
      emit();
      const res = await invoke({ action: "fork", world: world.id, name: name ?? `${opts.getName()}'s world` });
      busy = null;
      if (!res.ok || !res.world) {
        say("wizard", String(res.error ?? "The remix spell fizzled."));
        return;
      }
      const w = res.world as { id: string; name: string };
      myWorlds = { ...myWorlds, [w.id]: w.name };
      writeJson(MINE_KEY, myWorlds);
      await api.switchWorld(w.id);
      say("wizard", `Behold, ${w.name}! Everything here is yours to change, and nobody else's world will notice.`);
    },
    async switchWorld(id) {
      log.push({ who: "system", text: id === "commons" ? "You are on the shared island. Everybody sees what you wish." : "" });
      if (!log[log.length - 1].text) log.pop();
      try {
        const u = new URL(window.location.href);
        if (id === "commons") u.searchParams.delete("world");
        else u.searchParams.set("world", id);
        window.history.replaceState(window.history.state, "", u.toString());
      } catch {
        /* not in a browser */
      }
      await loadWorld(id);
    },
    shareUrl() {
      const u = new URL(window.location.href);
      u.search = "";
      if (world.id !== "commons") u.searchParams.set("world", world.id);
      return u.toString();
    },
    onGrant(cb) {
      grantListeners.add(cb);
      return () => grantListeners.delete(cb);
    },
    onSpeak(cb) {
      speakListeners.add(cb);
      return () => speakListeners.delete(cb);
    },
    update(dt, now, viewer) {
      layer.update(dt, now, viewer);
    },
    dispose() {
      disposed = true;
      channel?.unsubscribe();
      layer.dispose();
      listeners.clear();
    },
  };

  void loadWorld(opts.initialWorld || "commons");

  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__wizard = {
      snapshot: () => api.snapshot(),
      count: () => layer.count(),
      /** Draw ops as if a wish had been granted here (relative coordinates, like the model writes). */
      apply: async (ops: Op[], hereOverride?: Here) => {
        const { cleanOps, placeOps, LIMITS } = await import("../../supabase/functions/vibe-wizard/spec.ts");
        const here = hereOverride ?? opts.getHere();
        const placed = placeOps(cleanOps(ops, LIMITS.smart.parts), here, "t" + (localSeq % 1000), "test", "smart", new Set(state.things.keys()));
        const row: FullRow = { id: localSeq++, world_id: world.id, author: "test", prompt: "test", reply: null, ops: placed, tier: "test", undone: false };
        remember(row.id);
        ingest(row, true);
        return row.id;
      },
      /** Draw stored rows (absolute coordinates) as the database would deliver them. */
      rows: (list: Array<{ id: number; ops: unknown }>) => {
        for (const r of list) ingest({ id: r.id, world_id: world.id, author: "test", prompt: "test", reply: null, ops: r.ops, tier: "test", undone: false }, true);
        return layer.count();
      },
      undo: (id: number) => api.undo(id),
      wish: (t: string) => api.wish(t),
      here: () => opts.getHere(),
    };
  }

  return api;
}
