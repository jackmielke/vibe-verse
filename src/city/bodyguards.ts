/**
 * bodyguards — three samurai who follow you round Vibe City and fight the
 * police for you, and who do what they are told.
 *
 * This is the Magician's idea carried into the city: the world is driven by
 * tool calls, and a voice model (or the dumb keyword parser in
 * `squadCommands.ts`, which makes the same calls) is just one way of making
 * them. Everything a spoken order can do is a method here (`hire`, `dismiss`,
 * `order`, `say`), so the HUD buttons, the typed box and the voice all go
 * through the same door.
 *
 * ## The squad
 *
 * - **Kenji**, the leader: a katana, quick cuts, middling everything.
 * - **Hana**: a ninja who throws shuriken from eighteen metres, and the only
 *   one who keeps fighting while you drive (she leans out of the window).
 * - **Goro**: huge, slow, and the nodachi takes a cruiser apart in three.
 *
 * They are invulnerable on purpose: a cruiser at speed bowls one over and he
 * rolls back up, because a bodyguard who dies in the first chase is a
 * bodyguard you stop hiring. Wrecks they cause add no heat; the police only
 * hold you responsible for what you do yourself.
 *
 * ## Orders
 *
 * `follow` (the default: keep close, fight anything that comes within 26 m of
 * you), `stay` (hold this spot and defend it), `attack` (go looking, 70 m),
 * `peace` (follow, never fight) and `cheer` (stand still and celebrate).
 *
 * Bodies are the roster's own Quaternius models, loaded the first time
 * somebody is hired, so a visitor who never asks for a bodyguard downloads
 * nothing.
 */
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import type { CrashFx } from "@/city/crashFx";
import type { Mayhem } from "@/city/mayhem";
import kenjiUrl from "@/assets/glb/characters/Kimono_Male.glb";
import hanaUrl from "@/assets/glb/characters/Ninja_Female.glb";
import goroUrl from "@/assets/glb/characters/Ninja_Sand.glb";

export type GuardId = "kenji" | "hana" | "goro";
export type GuardOrder = "follow" | "stay" | "attack" | "peace" | "cheer";
export const GUARD_IDS: GuardId[] = ["kenji", "hana", "goro"];
export const GUARD_ORDERS: GuardOrder[] = ["follow", "stay", "attack", "peace", "cheer"];

export interface GuardSpec {
  id: GuardId;
  name: string;
  title: string;
  emoji: string;
  url: string;
  weapon: "katana" | "shuriken" | "nodachi";
  /** Metres at which a blow (or a throw) lands. */
  reach: number;
  damage: number;
  /** Seconds between blows. */
  interval: number;
  /** Running speed, m/s. */
  speed: number;
  height: number;
  /** Blade or star colour. */
  accent: number;
  lines: { hire: string[]; attack: string[]; wreck: string[]; follow: string[]; stay: string[]; peace: string[]; cheer: string[]; bye: string[] };
}

export const GUARDS: Record<GuardId, GuardSpec> = {
  kenji: {
    id: "kenji", name: "Kenji", title: "the leader", emoji: "⚔️", url: kenjiUrl,
    weapon: "katana", reach: 3.4, damage: 26, interval: 0.75, speed: 8, height: 1.8, accent: 0xdfe6ee,
    lines: {
      hire: ["Kenji, at your side.", "My blade is yours."],
      attack: ["Hai! Leave them to me.", "Steel answers."],
      wreck: ["One less.", "Too slow."],
      follow: ["Right behind you.", "Lead the way."],
      stay: ["I hold this ground.", "None shall pass."],
      peace: ["Blade sheathed.", "As you wish. Calm."],
      cheer: ["A fine day!", "Victory!"],
      bye: ["Call, and I return.", "Until next time."],
    },
  },
  hana: {
    id: "hana", name: "Hana", title: "the shadow", emoji: "🌸", url: hanaUrl,
    weapon: "shuriken", reach: 18, damage: 11, interval: 0.5, speed: 9.5, height: 1.7, accent: 0xff7aa8,
    lines: {
      hire: ["Hana's here. Try to keep up.", "Miss me?"],
      attack: ["Stars away!", "Fun time."],
      wreck: ["Bullseye.", "Did you see that?"],
      follow: ["On your six.", "Shadowing you."],
      stay: ["I'll watch from here.", "Fine. Waiting."],
      peace: ["Boring, but okay.", "Stars away... I mean, put away."],
      cheer: ["Woo!", "Party!"],
      bye: ["Vanishing.", "Later!"],
    },
  },
  goro: {
    id: "goro", name: "Goro", title: "the mountain", emoji: "🗻", url: goroUrl,
    weapon: "nodachi", reach: 4.2, damage: 42, interval: 1.35, speed: 6.6, height: 2.15, accent: 0xffc36b,
    lines: {
      hire: ["Goro.", "I am here."],
      attack: ["Smash.", "Goro go."],
      wreck: ["Hmph.", "Small car."],
      follow: ["Walking.", "With you."],
      stay: ["Goro stays.", "Rock."],
      peace: ["Okay.", "Rest."],
      cheer: ["HA!", "Good!"],
      bye: ["Bye.", "Goro sleep."],
    },
  },
};

export interface GuardInfo {
  id: GuardId;
  name: string;
  emoji: string;
  title: string;
  hired: boolean;
  loaded: boolean;
  order: GuardOrder;
  fighting: boolean;
  wrecks: number;
}

export type SquadEvent =
  | { kind: "hud"; guards: GuardInfo[] }
  | { kind: "event"; text: string; guard?: GuardId; important?: boolean };

export interface SquadCtx {
  /** The avatar's feet. */
  player: THREE.Vector3;
  yaw: number;
  driving: { x: number; y: number; z: number; yaw: number; speed: number } | null;
  /** In the air, on a mount or swimming: guards wait on the ground below. */
  airborne: boolean;
}

export interface BodyguardOpts {
  scene: THREE.Scene;
  mayhem: Mayhem;
  crashFx: CrashFx;
  /** Height of whatever someone standing at (x, z) near height y stands on. */
  ground(x: number, z: number, y: number): number;
  blocked(x: number, z: number, y: number): boolean;
  /** Optional: sword clash, throw and so on. */
  sound?(kind: "slash" | "throw" | "poof" | "wreck"): void;
}

export interface Bodyguards {
  group: THREE.Group;
  roster(): GuardInfo[];
  /** Returns the names of everybody who answered. */
  hire(who: GuardId | "all"): string[];
  dismiss(who: GuardId | "all"): string[];
  order(who: GuardId | "all", order: GuardOrder): string[];
  /** A speech bubble over a guard's head; the leader if `who` is omitted. */
  say(line: string, who?: GuardId): void;
  /** A line in the guard's own voice from their stock, for when no model is talking. */
  quip(who: GuardId, kind: keyof GuardSpec["lines"]): string;
  /** Plain-words snapshot for the voice model to read. */
  describe(): string;
  listen(fn: (e: SquadEvent) => void): () => void;
  update(dt: number, ctx: SquadCtx): void;
  debug(): Array<{ id: GuardId; x: number; y: number; z: number; visible: boolean; order: GuardOrder; anim: string; target: number; wrecks: number }>;
  dispose(): void;
}

const ON_KEY = "city.squad.on";

/**
 * Whether the squad exists at all on this device. Off by default while it is
 * being tried out: `?squad` switches it on and remembers, `?squad=off` (or
 * `0`) switches it off again.
 */
export function squadEnabled(search = typeof location === "undefined" ? "" : location.search): boolean {
  const q = new URLSearchParams(search).get("squad");
  try {
    if (q !== null) {
      const on = !/^(off|0|false|no)$/i.test(q);
      localStorage.setItem(ON_KEY, on ? "1" : "0");
      return on;
    }
    return localStorage.getItem(ON_KEY) === "1";
  } catch {
    return q !== null && !/^(off|0|false|no)$/i.test(q);
  }
}

// ---- Pure helpers (tested) ----------------------------------------------

/**
 * Where guard `index` of `count` stands relative to someone at the origin
 * facing `yaw` (forward is (sin yaw, cos yaw)): a loose arc behind them, the
 * leader at the back left, so nobody stands where the camera is looking.
 */
export function formationSlot(index: number, count: number, yaw: number, spread = 2.4): { x: number; z: number } {
  const n = Math.max(1, count);
  const t = n === 1 ? 0 : index / (n - 1) - 0.5; // -0.5..0.5
  const side = t * spread * 2 + (n === 1 ? -1.4 : 0);
  const back = -2.6 - Math.abs(t) * 0.6;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return { x: fx * back + rx * side, z: fz * back + rz * side };
}

/**
 * The threat a guard should go for: the nearest one to the guard among those
 * within `leash` of the point being defended. -1 when there is none.
 */
export function pickThreat(
  gx: number, gz: number, cx: number, cz: number, leash: number,
  threats: ReadonlyArray<{ x: number; z: number }>,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < threats.length; i++) {
    const t = threats[i];
    if (Math.hypot(t.x - cx, t.z - cz) > leash) continue;
    const d = Math.hypot(t.x - gx, t.z - gz);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** How far from the point it defends an order lets a guard go hunting. 0 means never. */
export function leashFor(order: GuardOrder): number {
  switch (order) {
    case "attack": return 70;
    case "follow": return 26;
    case "stay": return 16;
    default: return 0;
  }
}

// ---- Little meshes ----------------------------------------------------------

function buildBlade(kind: GuardSpec["weapon"], accent: number): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.25, metalness: 0.85 });
  const wrap = new THREE.MeshStandardMaterial({ color: 0x1b1414, roughness: 0.9 });
  const guard = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.4, metalness: 0.7 });
  if (kind === "shuriken") {
    // A four-point star, held flat.
    const star = new THREE.Shape();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 === 0 ? 0.16 : 0.05;
      if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(star, { depth: 0.015, bevelEnabled: false }), steel);
    m.rotation.x = Math.PI / 2;
    g.add(m);
    return g;
  }
  const len = kind === "nodachi" ? 1.45 : 0.95;
  const grip = kind === "nodachi" ? 0.4 : 0.26;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, grip, 8), wrap);
  handle.position.y = grip / 2 - 0.05;
  const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 12), guard);
  tsuba.position.y = grip - 0.05;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, len, 0.045), steel);
  blade.position.y = grip - 0.05 + len / 2;
  g.add(handle, tsuba, blade);
  return g;
}

function bubbleSprite(): { sprite: THREE.Sprite; draw(text: string, accent: string): void; dispose(): void } {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.2, 0.8, 1);
  sprite.renderOrder = 20;
  sprite.visible = false;
  return {
    sprite,
    draw(text, accent) {
      ctx.clearRect(0, 0, 512, 128);
      let size = 40;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      while (ctx.measureText(text).width > 460 && size > 20) {
        size -= 2;
        ctx.font = `600 ${size}px system-ui, sans-serif`;
      }
      const w = Math.min(500, ctx.measureText(text).width + 44);
      const x = (512 - w) / 2;
      ctx.fillStyle = "rgba(14,14,20,0.82)";
      ctx.beginPath();
      ctx.roundRect(x, 18, w, 78, 30);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 256, 58, 470);
      tex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
      mat.dispose();
    },
  };
}

// ---- The module ------------------------------------------------------------

type Anim = "Idle" | "Walk" | "Run" | "SwordSlash" | "Shoot_OneHanded" | "Roll" | "Victory";

interface Guard {
  spec: GuardSpec;
  root: THREE.Group;
  body: THREE.Group;
  rig: CharacterRig | null;
  loading: boolean;
  actions: Partial<Record<Anim, THREE.AnimationAction>>;
  anim: Anim | null;
  /** One-shot animation running, seconds left. */
  busy: number;
  hired: boolean;
  order: GuardOrder;
  x: number; y: number; z: number; yaw: number;
  anchorX: number; anchorZ: number;
  cool: number;
  /** Seconds until a swing's blow lands, or -1. */
  pending: number;
  target: number;
  tx: number; tz: number;
  /** Knocked aside by a car: sideways velocity and seconds left. */
  rollX: number; rollZ: number; roll: number;
  wrecks: number;
  bubble: ReturnType<typeof bubbleSprite>;
  bubbleT: number;
  blade: THREE.Group | null;
  lastLine: number;
  fighting: boolean;
}

interface Star {
  mesh: THREE.Mesh;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  t: number;
  life: number;
  owner: Guard;
  live: boolean;
}

const SAVE_KEY = "city.squad";
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

export function createBodyguards(opts: BodyguardOpts): Bodyguards {
  const { mayhem, crashFx } = opts;
  const group = new THREE.Group();
  group.name = "bodyguards";
  opts.scene.add(group);
  const listeners = new Set<(e: SquadEvent) => void>();
  const emit = (e: SquadEvent) => listeners.forEach((fn) => fn(e));

  const guards: Guard[] = GUARD_IDS.map((id) => {
    const root = new THREE.Group();
    root.name = `guard-${id}`;
    root.visible = false;
    const body = new THREE.Group();
    root.add(body);
    const bubble = bubbleSprite();
    bubble.sprite.position.y = GUARDS[id].height + 0.75;
    root.add(bubble.sprite);
    group.add(root);
    return {
      spec: GUARDS[id], root, body, rig: null, loading: false, actions: {}, anim: null, busy: 0,
      hired: false, order: "follow", x: 0, y: 0, z: 0, yaw: 0, anchorX: 0, anchorZ: 0,
      cool: 0, pending: -1, target: -1, tx: 0, tz: 0, rollX: 0, rollZ: 0, roll: 0, wrecks: 0,
      bubble, bubbleT: 0, blade: null, lastLine: 0, fighting: false,
    };
  });
  const byId = (id: GuardId) => guards.find((g) => g.spec.id === id)!;
  const pick = (who: GuardId | "all") => (who === "all" ? guards : [byId(who)]);

  // Shuriken in flight.
  const starGeo = new THREE.OctahedronGeometry(0.14, 0);
  starGeo.scale(1, 0.25, 1);
  const starMat = new THREE.MeshBasicMaterial({ color: GUARDS.hana.accent });
  const stars: Star[] = [];

  let clock = 0;
  let disposed = false;
  let lastPlayer = new THREE.Vector3();
  let lastYaw = 0;
  let placedOnce = false;

  // ---- Persistence ----------------------------------------------------
  const save = () => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        hired: guards.filter((g) => g.hired).map((g) => g.spec.id),
        orders: Object.fromEntries(guards.map((g) => [g.spec.id, g.order === "cheer" ? "follow" : g.order])),
      }));
    } catch { /* private mode */ }
  };

  const info = (): GuardInfo[] => guards.map((g) => ({
    id: g.spec.id, name: g.spec.name, emoji: g.spec.emoji, title: g.spec.title,
    hired: g.hired, loaded: Boolean(g.rig), order: g.order, fighting: g.fighting, wrecks: g.wrecks,
  }));
  let hudKey = "";
  const hud = (force = false) => {
    const list = info();
    const key = JSON.stringify(list);
    if (!force && key === hudKey) return;
    hudKey = key;
    emit({ kind: "hud", guards: list });
  };

  // ---- Bodies ----------------------------------------------------------
  const play = (g: Guard, name: Anim, once = false, fade = 0.18) => {
    if (!g.rig?.mixer) return;
    const next = g.actions[name];
    if (!next) return;
    if (g.anim === name && !once) return;
    const prev = g.anim ? g.actions[g.anim] : undefined;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    g.anim = name;
    if (once) g.busy = Math.max(0.3, next.getClip().duration / Math.max(0.01, next.timeScale) - 0.05);
  };

  const load = (g: Guard) => {
    if (g.rig || g.loading) return;
    g.loading = true;
    loadCharacterRig({ url: g.spec.url, id: g.spec.id }, { height: g.spec.height, center: true })
      .then((rig) => {
        if (disposed) return;
        g.rig = rig;
        g.loading = false;
        g.body.add(rig.object);
        rig.mixer?.stopAllAction();
        if (rig.mixer) {
          for (const clip of rig.clips) {
            const short = clip.name.split("|").pop() as Anim;
            if (["Idle", "Walk", "Run", "SwordSlash", "Shoot_OneHanded", "Roll", "Victory"].includes(short)) {
              g.actions[short] = rig.mixer.clipAction(clip);
            }
          }
          if (g.actions.SwordSlash) g.actions.SwordSlash.timeScale = g.spec.weapon === "nodachi" ? 1.1 : 1.6;
          if (g.actions.Shoot_OneHanded) g.actions.Shoot_OneHanded.timeScale = 1.8;
        }
        // The weapon goes in the right fist, sized against whatever scale
        // the armature carries so it reads the same on every body.
        let fist: THREE.Object3D | null = null;
        rig.object.traverse((o) => { if (!fist && /fist\.?r$|hand\.?r$|righthand/i.test(o.name)) fist = o; });
        const blade = buildBlade(g.spec.weapon, g.spec.accent);
        g.blade = blade;
        if (fist) {
          g.root.updateMatrixWorld(true);
          const ws = new THREE.Vector3();
          (fist as THREE.Object3D).getWorldScale(ws);
          blade.scale.setScalar(1 / Math.max(1e-4, ws.x));
          (fist as THREE.Object3D).add(blade);
        } else {
          blade.position.set(0.3, 1, 0.2);
          g.body.add(blade);
        }
        rig.object.traverse((o) => { o.frustumCulled = false; });
        play(g, "Idle");
        hud(true);
      })
      .catch((e) => {
        g.loading = false;
        console.warn("[bodyguards] could not load", g.spec.id, e);
      });
  };

  const say = (line: string, who?: GuardId) => {
    const g = who ? byId(who) : guards.find((x) => x.hired) ?? guards[0];
    g.bubble.draw(line, hex(g.spec.accent));
    g.bubble.sprite.visible = g.root.visible;
    g.bubbleT = Math.min(6, 1.8 + line.length * 0.06);
  };
  const quip = (who: GuardId, kind: keyof GuardSpec["lines"]) => {
    const list = GUARDS[who].lines[kind];
    return list[Math.floor(Math.random() * list.length)];
  };
  const bark = (g: Guard, kind: keyof GuardSpec["lines"], force = false) => {
    if (!force && clock - g.lastLine < 4) return;
    g.lastLine = clock;
    say(quip(g.spec.id, kind), g.spec.id);
  };

  const poof = (x: number, y: number, z: number) => {
    crashFx.debris(x, y + 0.9, z, 8, 0xe8e2d6, 3);
    crashFx.leaves(x, y + 1, z, 4);
    opts.sound?.("poof");
  };

  /** Stand a guard at its slot next to the player, with a puff of smoke. */
  const arrive = (g: Guard, ctx: { x: number; y: number; z: number; yaw: number }, index: number, count: number) => {
    const s = formationSlot(index, count, ctx.yaw);
    g.x = ctx.x + s.x;
    g.z = ctx.z + s.z;
    g.y = opts.ground(g.x, g.z, ctx.y + 1.5);
    g.yaw = ctx.yaw;
    g.root.position.set(g.x, g.y, g.z);
    poof(g.x, g.y, g.z);
  };

  const hiredList = () => guards.filter((g) => g.hired);

  const api: Bodyguards = {
    group,
    roster: info,
    hire(who) {
      const out: string[] = [];
      const team = hiredList().length;
      let k = team;
      for (const g of pick(who)) {
        if (g.hired) { out.push(g.spec.name); continue; }
        g.hired = true;
        g.order = g.order === "cheer" ? "follow" : g.order;
        if (g.order === "stay") g.order = "follow";
        load(g);
        g.root.visible = true;
        arrive(g, { x: lastPlayer.x, y: lastPlayer.y, z: lastPlayer.z, yaw: lastYaw }, k++, Math.max(3, team + 1));
        bark(g, "hire", true);
        out.push(g.spec.name);
        emit({ kind: "event", text: `${g.spec.emoji} ${g.spec.name} joined your squad`, guard: g.spec.id });
      }
      save();
      hud();
      return out;
    },
    dismiss(who) {
      const out: string[] = [];
      for (const g of pick(who)) {
        if (!g.hired) continue;
        g.hired = false;
        g.target = -1;
        g.fighting = false;
        poof(g.x, g.y, g.z);
        g.root.visible = false;
        out.push(g.spec.name);
      }
      save();
      hud();
      return out;
    },
    order(who, order) {
      const out: string[] = [];
      for (const g of pick(who)) {
        if (!g.hired) continue;
        g.order = order;
        if (order === "stay") { g.anchorX = g.x; g.anchorZ = g.z; }
        if (order === "peace" || order === "cheer") { g.target = -1; g.pending = -1; }
        if (order === "cheer") play(g, "Victory");
        bark(g, order, true);
        out.push(g.spec.name);
      }
      save();
      hud();
      return out;
    },
    say,
    quip,
    describe() {
      const on = hiredList();
      const threats = mayhem.threats();
      const d = mayhem.debug();
      const parts = [
        on.length
          ? `Squad: ${on.map((g) => `${g.spec.name} (${g.order}${g.fighting ? ", fighting" : ""}, ${g.wrecks} wrecked)`).join("; ")}.`
          : "Nobody is hired right now.",
        `Off duty: ${guards.filter((g) => !g.hired).map((g) => g.spec.name).join(", ") || "nobody"}.`,
        `Police: ${threats.length} cruiser${threats.length === 1 ? "" : "s"} on the street, wanted level ${Math.ceil(d.heat)} of 5.`,
      ];
      if (threats.length) {
        const near = Math.min(...threats.map((t) => Math.hypot(t.x - lastPlayer.x, t.z - lastPlayer.z)));
        parts.push(`Nearest cruiser ${Math.round(near)} m from the player.`);
      }
      return parts.join(" ");
    },
    listen(fn) {
      listeners.add(fn);
      fn({ kind: "hud", guards: info() });
      return () => { listeners.delete(fn); };
    },
    update(dt, ctx) {
      clock += dt;
      const drive = ctx.driving;
      const px = drive ? drive.x : ctx.player.x;
      const pz = drive ? drive.z : ctx.player.z;
      const py = drive ? drive.y : ctx.player.y;
      const pyaw = drive ? drive.yaw : ctx.yaw;
      lastPlayer.set(px, py, pz);
      lastYaw = pyaw;
      const team = hiredList();
      if (!placedOnce && team.length) {
        placedOnce = true;
        team.forEach((g, i) => arrive(g, { x: px, y: py, z: pz, yaw: pyaw }, i, team.length));
      }
      const threats = mayhem.threats();
      let anyFighting = false;

      team.forEach((g, index) => {
        if (!g.rig) { g.root.visible = false; return; }
        g.cool -= dt;
        g.busy = Math.max(0, g.busy - dt);
        g.rig.mixer?.update(dt);

        // In the car: everybody piles in. Hana keeps throwing from the window.
        if (drive && g.order !== "stay") {
          if (g.root.visible) { g.root.visible = false; poof(g.x, g.y, g.z); }
          g.x = px; g.z = pz; g.y = py;
          g.fighting = false;
          if (g.spec.weapon === "shuriken" && g.order !== "peace" && g.order !== "cheer") {
            const t = pickThreat(px, pz, px, pz, g.spec.reach, threats);
            if (t >= 0 && g.cool <= 0) {
              throwStar(g, px, py + 1.4, pz, threats[t].x, threats[t].z);
              g.cool = g.spec.interval * 1.4;
              g.fighting = true;
            }
          }
          if (g.fighting) anyFighting = true;
          return;
        }
        if (!g.root.visible) {
          // Out of the car (or just loaded): step out beside it.
          g.root.visible = true;
          arrive(g, { x: px, y: py, z: pz, yaw: pyaw }, index, team.length);
        }

        // Where am I meant to be?
        const slot = formationSlot(index, team.length, pyaw);
        const homeX = g.order === "stay" ? g.anchorX : px + slot.x;
        const homeZ = g.order === "stay" ? g.anchorZ : pz + slot.z;
        const far = Math.hypot(g.x - px, g.z - pz);
        if (g.order !== "stay" && far > 45 && !ctx.airborne) {
          poof(g.x, g.y, g.z);
          arrive(g, { x: px, y: py, z: pz, yaw: pyaw }, index, team.length);
        }

        // Anything to fight?
        const leash = leashFor(g.order);
        const cx = g.order === "stay" ? g.anchorX : px;
        const cz = g.order === "stay" ? g.anchorZ : pz;
        const ti = leash > 0 ? pickThreat(g.x, g.z, cx, cz, leash, threats) : -1;
        const had = g.target >= 0;
        g.target = ti;
        g.fighting = ti >= 0;
        if (g.fighting) anyFighting = true;
        if (ti >= 0 && !had) {
          bark(g, "attack");
          if (index === 0 || g.spec.id === "kenji") emit({ kind: "event", text: `${g.spec.name} is taking on a police cruiser`, guard: g.spec.id });
        }

        let goalX = homeX;
        let goalZ = homeZ;
        let stopAt = 0.6;
        if (ti >= 0) {
          const t = threats[ti];
          // Lead a moving car a little.
          const lead = Math.min(0.5, Math.hypot(t.x - g.x, t.z - g.z) / 20);
          goalX = t.x + Math.sin(t.yaw) * t.speed * lead;
          goalZ = t.z + Math.cos(t.yaw) * t.speed * lead;
          stopAt = g.spec.weapon === "shuriken" ? g.spec.reach * 0.7 : g.spec.reach * 0.55;
          g.tx = t.x;
          g.tz = t.z;
        }

        // A car at speed close by bowls a guard over. He rolls back up.
        if (g.roll <= 0) {
          for (const t of threats) {
            if (Math.abs(t.speed) > 8 && Math.hypot(t.x - g.x, t.z - g.z) < 2.2) {
              const dx = g.x - t.x, dz = g.z - t.z, d = Math.hypot(dx, dz) || 1;
              g.rollX = (dx / d) * 6;
              g.rollZ = (dz / d) * 6;
              g.roll = 0.55;
              g.pending = -1;
              play(g, "Roll", true, 0.08);
              crashFx.sparks(g.x, g.y + 0.8, g.z, dx / d, dz / d, 6);
              break;
            }
          }
        }

        let moving = 0;
        if (g.roll > 0) {
          g.roll -= dt;
          step(g, g.rollX * dt, g.rollZ * dt);
        } else if (g.order === "cheer") {
          if (!g.busy && g.anim !== "Victory") play(g, "Victory");
          const dx = px - g.x, dz = pz - g.z;
          g.yaw = turn(g.yaw, Math.atan2(dx, dz), dt * 4);
        } else {
          const dx = goalX - g.x;
          const dz = goalZ - g.z;
          const d = Math.hypot(dx, dz);
          if (d > stopAt && g.busy <= 0) {
            const run = d > 3.5 || ti >= 0;
            const sp = (run ? g.spec.speed : 2.2) * Math.min(1, d / 1.2);
            const mx = (dx / d) * sp * dt;
            const mz = (dz / d) * sp * dt;
            step(g, mx, mz);
            g.yaw = turn(g.yaw, Math.atan2(dx, dz), dt * 10);
            moving = run ? 2 : 1;
          } else if (ti >= 0) {
            g.yaw = turn(g.yaw, Math.atan2(g.tx - g.x, g.tz - g.z), dt * 12);
          } else if (d <= stopAt) {
            g.yaw = turn(g.yaw, pyaw, dt * 3);
          }
          // Strike.
          if (ti >= 0 && g.cool <= 0) {
            const reach = Math.hypot(g.tx - g.x, g.tz - g.z);
            if (reach <= g.spec.reach) {
              g.cool = g.spec.interval;
              if (g.spec.weapon === "shuriken") {
                play(g, "Shoot_OneHanded", true, 0.08);
                throwStar(g, g.x, g.y + 1.35, g.z, g.tx, g.tz);
              } else {
                play(g, "SwordSlash", true, 0.08);
                g.pending = g.spec.weapon === "nodachi" ? 0.35 : 0.2;
                opts.sound?.("slash");
              }
            }
          }
        }
        if (g.pending >= 0) {
          g.pending -= dt;
          if (g.pending < 0) {
            // Whoever is still in reach of the blade, now.
            const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
            const hx = g.x + fx * g.spec.reach * 0.5, hz = g.z + fz * g.spec.reach * 0.5;
            const now = mayhem.threats();
            let hit = -1, hd = Infinity;
            for (const t of now) {
              const d = Math.hypot(t.x - hx, t.z - hz);
              if (d < g.spec.reach + 1.2 && d < hd) { hd = d; hit = t.i; }
            }
            if (hit >= 0) {
              crashFx.sparks(hx, g.y + 1, hz, fx, fz, 10);
              crashFx.kick(g.spec.weapon === "nodachi" ? 0.12 : 0.05);
              if (mayhem.allyHit(hit, g.spec.damage)) wrecked(g);
            }
          }
        }
        if (g.busy <= 0 && g.order !== "cheer") play(g, moving === 2 ? "Run" : moving === 1 ? "Walk" : "Idle");

        g.y += (opts.ground(g.x, g.z, g.y + 1.5) - g.y) * Math.min(1, dt * 14);
        g.root.position.set(g.x, g.y, g.z);
        g.root.rotation.y = g.yaw;
      });

      // Speech bubbles fade on their own.
      for (const g of guards) {
        if (g.bubbleT > 0) {
          g.bubbleT -= dt;
          g.bubble.sprite.visible = g.root.visible && g.bubbleT > 0;
          (g.bubble.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, g.bubbleT * 2);
        }
      }

      // Stars.
      for (const s of stars) {
        if (!s.live) continue;
        s.t += dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
        s.mesh.position.set(s.x, s.y, s.z);
        s.mesh.rotation.y += dt * 30;
        let done = s.t > s.life || opts.blocked(s.x, s.z, s.y);
        if (!done) {
          for (const t of mayhem.threats()) {
            if (Math.hypot(t.x - s.x, t.z - s.z) < 2.1 && s.y < 2.2) {
              crashFx.sparks(s.x, s.y, s.z, -s.vx * 0.05, -s.vz * 0.05, 5);
              if (mayhem.allyHit(t.i, s.owner.spec.damage)) wrecked(s.owner);
              done = true;
              break;
            }
          }
        }
        if (done) { s.live = false; s.mesh.visible = false; }
      }
      void anyFighting;
      hud();
    },
    debug() {
      return guards.map((g) => ({
        id: g.spec.id, x: g.x, y: g.y, z: g.z, visible: g.root.visible, order: g.order,
        anim: g.anim ?? "", target: g.target, wrecks: g.wrecks,
      }));
    },
    dispose() {
      disposed = true;
      listeners.clear();
      for (const g of guards) {
        g.rig?.mixer?.stopAllAction();
        g.bubble.dispose();
        g.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry?.dispose();
        });
      }
      starGeo.dispose();
      starMat.dispose();
      opts.scene.remove(group);
    },
  };

  function wrecked(g: Guard) {
    g.wrecks++;
    bark(g, "wreck", true);
    opts.sound?.("wreck");
    emit({ kind: "event", text: `${g.spec.name} wrecked a police cruiser`, guard: g.spec.id, important: true });
    hud();
  }

  function throwStar(g: Guard, x: number, y: number, z: number, tx: number, tz: number) {
    let s = stars.find((q) => !q.live);
    if (!s) {
      if (stars.length >= 16) return;
      const mesh = new THREE.Mesh(starGeo, starMat);
      group.add(mesh);
      s = { mesh, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 0.9, owner: g, live: false };
      stars.push(s);
    }
    const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz) || 1;
    const sp = 38;
    s.x = x; s.y = y; s.z = z;
    s.vx = (dx / d) * sp;
    s.vz = (dz / d) * sp;
    s.vy = (0.9 - y) / Math.max(0.1, d / sp);
    s.t = 0;
    s.life = d / sp + 0.25;
    s.owner = g;
    s.live = true;
    s.mesh.visible = true;
    s.mesh.position.set(x, y, z);
    opts.sound?.("throw");
  }

  /** Move with the city's collision: slide along a wall rather than stick to it. */
  function step(g: Guard, mx: number, mz: number) {
    const y = g.y + 0.9;
    if (!opts.blocked(g.x + mx, g.z + mz, y)) { g.x += mx; g.z += mz; return; }
    if (!opts.blocked(g.x + mx, g.z, y)) { g.x += mx; return; }
    if (!opts.blocked(g.x, g.z + mz, y)) { g.z += mz; return; }
  }

  // Bring back whoever was hired last visit.
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { hired?: string[]; orders?: Record<string, string> };
      for (const g of guards) {
        const o = saved.orders?.[g.spec.id];
        if (o && (GUARD_ORDERS as string[]).includes(o) && o !== "stay") g.order = o as GuardOrder;
        if (saved.hired?.includes(g.spec.id)) { g.hired = true; load(g); }
      }
    }
  } catch { /* nothing saved */ }

  return api;
}

function turn(from: number, to: number, k: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * Math.min(1, k);
}
