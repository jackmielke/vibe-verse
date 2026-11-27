/**
 * Fishing off the main pier at Vibe Marina.
 *
 * Sal sits on his crate at the bait shack and will tell you how it works:
 * stand at the rail, E to cast, wait for the float to go under, E again to
 * strike, then the reel. The reel is the one game here with any skill in it:
 * a fish darts up and down a bar and you keep the green catch zone on it by
 * holding E (or the on-screen button). Keep it covered and the line comes in;
 * lose it and it goes slack.
 *
 * What bites is a weighted table. The Golden Vibe Koi is the one people come
 * for: about one cast in thirty by day, twice that at night, and it fights
 * like nothing else in the bay.
 */
import * as THREE from "three";
import { seaSurfaceAt } from "@/city/ocean";
import { buildFisher } from "./npc";
import { dist2, load, save, today, type Dialog, type Prompt, type QuestCtx, type QuestHost, type QuestStep } from "./common";

export interface Fish {
  id: string;
  name: string;
  emoji: string;
  /** Relative chance by day. */
  weight: number;
  nightWeight?: number;
  coins: number;
  /** kg range. */
  kg: [number, number];
  /** How wild it swims on the reel, 0..1. */
  fight: number;
}

export const FISH: Fish[] = [
  { id: "sardine", name: "Sardine", emoji: "🐟", weight: 30, coins: 2, kg: [0.05, 0.2], fight: 0.15 },
  { id: "mackerel", name: "Mackerel", emoji: "🐟", weight: 22, coins: 3, kg: [0.3, 1.2], fight: 0.3 },
  { id: "crab", name: "Dungeness Crab", emoji: "🦀", weight: 12, coins: 4, kg: [0.6, 1.4], fight: 0.25 },
  { id: "bass", name: "Striped Bass", emoji: "🐠", weight: 12, nightWeight: 16, coins: 5, kg: [1, 6], fight: 0.45 },
  { id: "boot", name: "Soggy Old Boot", emoji: "🥾", weight: 8, coins: 0, kg: [0.8, 0.8], fight: 0.05 },
  { id: "salmon", name: "King Salmon", emoji: "🍣", weight: 7, coins: 8, kg: [4, 18], fight: 0.6 },
  { id: "octopus", name: "Giant Octopus", emoji: "🐙", weight: 3, nightWeight: 5, coins: 12, kg: [5, 25], fight: 0.7 },
  { id: "golden", name: "Golden Vibe Koi", emoji: "✨", weight: 3, nightWeight: 6, coins: 60, kg: [2.4, 4.2], fight: 0.92 },
];

/** Most coins the pier pays out on one device in a day. */
const DAILY_CAP = 200;
const SAVE = "city.quest.fishing";

type Phase =
  | { kind: "idle" }
  | { kind: "cast"; t: number }
  | { kind: "wait"; until: number }
  | { kind: "bite"; until: number; fish: Fish }
  | { kind: "reel"; fish: Fish; zone: number; zoneV: number; f: number; fTarget: number; fNext: number; progress: number }
  | { kind: "result"; until: number; fish: Fish | null; kg: number };

export interface FishingUi {
  phase: Phase["kind"];
  /** The reel game, 0..1 positions on the bar. */
  reel?: { zone: number; zoneSize: number; fish: number; progress: number; golden: boolean };
  caught?: { name: string; emoji: string; kg: number; coins: number; best: boolean } | null;
}

export interface FishingQuest {
  group: THREE.Group;
  spot: THREE.Vector3;
  update(ctx: QuestCtx): QuestStep | null;
  prompt(ctx: QuestCtx): Prompt | null;
  dialog(): Dialog | null;
  choose(id: string): void;
  closeDialog(): void;
  ui(): FishingUi | null;
  active(): boolean;
  log(): { title: string; status: string; journal: Array<{ name: string; emoji: string; count: number; best: number }> };
  dev(op?: string): unknown;
  dispose(): void;
}

export function buildFishing(host: QuestHost, opts: { spot: THREE.Vector3; face: number; salAt: THREE.Vector3 }): FishingQuest {
  const group = new THREE.Group();
  group.name = "quest.fishing";
  const keep: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
  const K = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T) => (keep.push(x), x);

  const sal = buildFisher();
  sal.group.position.copy(opts.salAt);
  sal.group.rotation.y = opts.face;
  group.add(sal.group);

  // Bait & tackle: a sign, a bucket, a rod rack.
  {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const x = c.getContext("2d")!;
    x.fillStyle = "#0f3d5c";
    x.fillRect(0, 0, 512, 160);
    x.strokeStyle = "#ffc928";
    x.lineWidth = 8;
    x.strokeRect(8, 8, 496, 144);
    x.fillStyle = "#ffc928";
    x.font = "bold 58px Georgia, serif";
    x.textAlign = "center";
    x.fillText("BAIT & TACKLE", 256, 78);
    x.fillStyle = "#fff";
    x.font = "28px Georgia, serif";
    x.fillText("🎣 fish here · ask Sal", 256, 126);
    const t = K(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(K(new THREE.PlaneGeometry(2.4, 0.75)), K(new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, side: THREE.DoubleSide })));
    const wood = K(new THREE.MeshStandardMaterial({ color: "#6b4a2b", roughness: 0.9 }));
    const g = new THREE.Group();
    sign.position.y = 2.3;
    g.add(sign);
    for (const px of [-1.1, 1.1]) {
      const post = new THREE.Mesh(K(new THREE.BoxGeometry(0.1, 2.7, 0.1)), wood);
      post.position.set(px, 1.35, -0.05);
      g.add(post);
    }
    const bucket = new THREE.Mesh(K(new THREE.CylinderGeometry(0.22, 0.18, 0.36, 14)), K(new THREE.MeshStandardMaterial({ color: "#2f7fd6", roughness: 0.5 })));
    bucket.position.set(0.7, 0.18, 0.4);
    g.add(bucket);
    const rack = new THREE.Mesh(K(new THREE.BoxGeometry(0.8, 0.08, 0.2)), wood);
    rack.position.set(-0.6, 1.0, 0.1);
    g.add(rack);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(K(new THREE.CylinderGeometry(0.01, 0.018, 2.2, 5)), K(new THREE.MeshStandardMaterial({ color: ["#e8423f", "#26c6a2", "#ffc928"][i] })));
      r.position.set(-0.85 + i * 0.25, 1.1, 0.1);
      r.rotation.z = 0.1;
      g.add(r);
    }
    g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    g.position.copy(opts.salAt);
    g.rotation.y = opts.face;
    g.translateZ(-1.6);
    g.translateX(1.2);
    group.add(g);
    // A gold ring painted on the deck where you stand to fish.
    const ring = new THREE.Mesh(
      K(new THREE.RingGeometry(0.45, 0.6, 28)),
      K(new THREE.MeshBasicMaterial({ color: 0xffc928, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(opts.spot);
    ring.position.y += 0.03;
    group.add(ring);
  }

  // The player's rod, line and float.
  const rod = new THREE.Group();
  {
    const pole = new THREE.Mesh(K(new THREE.CylinderGeometry(0.008, 0.022, 2.6, 6)), K(new THREE.MeshStandardMaterial({ color: "#1b1b1b", roughness: 0.4 })));
    pole.position.y = 1.3;
    rod.add(pole);
    const reel = new THREE.Mesh(K(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12)), K(new THREE.MeshStandardMaterial({ color: "#c0c0c0", metalness: 0.8, roughness: 0.3 })));
    reel.rotation.z = Math.PI / 2;
    reel.position.set(0.05, 0.35, 0);
    rod.add(reel);
  }
  rod.visible = false;
  group.add(rod);
  const tip = new THREE.Vector3();
  const float = new THREE.Group();
  {
    const top = new THREE.Mesh(K(new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), K(new THREE.MeshStandardMaterial({ color: "#e8423f", roughness: 0.4 })));
    const bot = new THREE.Mesh(K(new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)), K(new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.4 })));
    float.add(top, bot);
  }
  float.visible = false;
  group.add(float);
  const lineGeo = K(new THREE.BufferGeometry());
  const linePos = new Float32Array(3 * 12);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  const line = new THREE.Line(lineGeo, K(new THREE.LineBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.7 })));
  line.frustumCulled = false;
  line.visible = false;
  group.add(line);
  // A splash ring for the bite.
  const splash = new THREE.Mesh(K(new THREE.RingGeometry(0.1, 0.18, 24)), K(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })));
  splash.rotation.x = -Math.PI / 2;
  group.add(splash);
  // The catch, held up for a moment.
  const trophy = new THREE.Group();
  group.add(trophy);

  const saved = load(SAVE, { day: "", earned: 0, journal: {} as Record<string, { count: number; best: number }> });
  let phase: Phase = { kind: "idle" };
  let dialog: Dialog | null = null;
  let landing = new THREE.Vector3();
  let caught: FishingUi["caught"] = null;
  let night = false;
  let splashT = 0;
  let forceFish: string | null = null;

  const fwd = new THREE.Vector3(Math.sin(opts.face), 0, Math.cos(opts.face));
  const right = new THREE.Vector3(Math.cos(opts.face), 0, -Math.sin(opts.face));

  const pick = (): Fish => {
    if (forceFish) {
      const f = FISH.find((x) => x.id === forceFish);
      forceFish = null;
      if (f) return f;
    }
    const w = FISH.map((f) => (night ? (f.nightWeight ?? f.weight) : f.weight));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < FISH.length; i++) {
      r -= w[i];
      if (r <= 0) return FISH[i];
    }
    return FISH[0];
  };

  const buildTrophy = (f: Fish | null) => {
    trophy.clear();
    if (!f) return;
    const golden = f.id === "golden";
    const color = golden ? "#ffcf40" : f.id === "salmon" ? "#f08a5d" : f.id === "octopus" ? "#b04a8a" : f.id === "crab" ? "#d9482b" : f.id === "boot" ? "#4a3a2a" : "#8fa9bf";
    const m = new THREE.MeshStandardMaterial({ color, roughness: golden ? 0.2 : 0.5, metalness: golden ? 0.8 : 0.1, emissive: golden ? "#ffb300" : "#000", emissiveIntensity: golden ? 0.6 : 0 });
    if (f.id === "boot") {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.35, 0.3), m);
      trophy.add(b);
    } else {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), m);
      body.scale.set(0.5, 1, 2.2);
      trophy.add(body);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 4), m);
      tail.rotation.x = -Math.PI / 2;
      tail.position.z = -0.38;
      trophy.add(tail);
    }
    trophy.rotation.x = Math.PI / 2;
    trophy.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  };

  const stop = () => {
    phase = { kind: "idle" };
    rod.visible = float.visible = line.visible = false;
    buildTrophy(null);
  };

  const cast = () => {
    landing = opts.spot.clone().addScaledVector(fwd, 7 + Math.random() * 4).addScaledVector(right, (Math.random() - 0.5) * 5);
    phase = { kind: "cast", t: 0 };
    rod.visible = line.visible = float.visible = true;
    caught = null;
    buildTrophy(null);
    host.sound("chime", 0);
  };

  const strike = () => {
    if (phase.kind !== "bite") return;
    phase = { kind: "reel", fish: phase.fish, zone: 0.3, zoneV: 0, f: 0.5, fTarget: 0.5, fNext: 0, progress: 0.3 };
    host.sound("chime", 6);
  };

  const land = (f: Fish) => {
    const kg = Math.round((f.kg[0] + Math.random() * (f.kg[1] - f.kg[0])) * 100) / 100;
    if (saved.day !== today()) {
      saved.day = today();
      saved.earned = 0;
    }
    const j = (saved.journal[f.id] ??= { count: 0, best: 0 });
    const best = kg > j.best;
    j.count++;
    j.best = Math.max(j.best, kg);
    const left = Math.max(0, DAILY_CAP - saved.earned);
    const coins = Math.min(f.coins, left);
    saved.earned += coins;
    save(SAVE, saved);
    if (coins > 0) host.earn(coins, `${f.emoji} ${f.name}, ${kg} kg`);
    caught = { name: f.name, emoji: f.emoji, kg, coins, best: best && j.count > 1 };
    phase = { kind: "result", until: 0, fish: f, kg };
    buildTrophy(f);
    if (f.id === "golden") {
      host.sound("fanfare");
      host.toast("✨ GOLDEN VIBE KOI! ✨", `${kg} kg of pure luck. +${coins} coins. Sal can't believe it.`);
    } else if (f.id === "boot") {
      host.toast("🥾 An old boot", "Sal says it's his. He's been looking for that.");
      host.sound("thud", 0.4);
    } else {
      host.sound("coin");
      if (coins === 0 && f.coins > 0) host.toast(`${f.emoji} ${f.name}, ${kg} kg`, "The pier's paid out all it will today. Fishing for glory now!");
    }
  };

  const lose = () => {
    caught = null;
    phase = { kind: "result", until: 0, fish: null, kg: 0 };
    host.toast("It got away!", "Keep the green zone on the fish to reel it in.");
    host.sound("thud", 0.3);
  };

  return {
    group,
    spot: opts.spot,
    update(ctx) {
      night = ctx.night;
      const t = ctx.t;
      sal.animate(t, ctx.dt);
      sal.marker.visible = !saved.journal.sardine && phase.kind === "idle";
      if (dialog && dist2(ctx.player.x, ctx.player.z, opts.salAt.x, opts.salAt.z) > 7) dialog = null;
      if (phase.kind === "idle") return null;

      // Walking off (or anything moving you) puts the rod away.
      const moving = ctx.input.up || ctx.input.down || ctx.input.left || ctx.input.right || ctx.input.jump;
      if (moving && phase.kind !== "reel") {
        stop();
        return null;
      }

      // Rod in the player's hands, angled out over the water.
      const base = opts.spot.clone().addScaledVector(fwd, 0.3).addScaledVector(right, 0.25);
      base.y += 1.0;
      rod.position.copy(base);
      const bend = phase.kind === "reel" ? 0.35 + Math.sin(t * 18) * 0.06 : phase.kind === "bite" ? 0.25 : 0;
      rod.rotation.set(0, 0, 0);
      rod.rotateY(opts.face);
      rod.rotateX(0.9 + bend);
      rod.updateMatrixWorld(true);
      tip.set(0, 2.6, 0).applyMatrix4(rod.matrixWorld);

      const sea = seaSurfaceAt(landing.x, landing.z, t);
      if (phase.kind === "cast") {
        phase.t += ctx.dt / 0.8;
        const k = Math.min(1, phase.t);
        float.position.lerpVectors(tip, new THREE.Vector3(landing.x, sea, landing.z), k);
        float.position.y += Math.sin(k * Math.PI) * 3;
        if (k >= 1) {
          phase = { kind: "wait", until: t + 2 + Math.random() * 5 };
          splashT = 0;
          host.sound("splash");
        }
      } else {
        float.position.set(landing.x, sea + Math.sin(t * 2.1) * 0.03, landing.z);
      }
      if (phase.kind === "wait" && t > phase.until) {
        phase = { kind: "bite", until: t + 1.2, fish: pick() };
        splashT = 0;
        host.sound("splash");
      }
      if (phase.kind === "bite") {
        float.position.y -= 0.12 + Math.abs(Math.sin(t * 20)) * 0.08;
        if (t > phase.until) {
          host.toast("Too slow!", "Press E the moment the float goes under.");
          phase = { kind: "wait", until: t + 2 + Math.random() * 4 };
        }
      }
      if (phase.kind === "reel") {
        const r = phase;
        float.position.y -= 0.1;
        float.position.x += Math.sin(t * 7) * 0.15;
        // The fish picks a new spot on the bar every so often; wilder fish more often and further.
        if (t > r.fNext) {
          const jump = 0.15 + r.fish.fight * 0.6;
          r.fTarget = THREE.MathUtils.clamp(r.f + (Math.random() - 0.5) * 2 * jump, 0.04, 0.96);
          r.fNext = t + (1.4 - r.fish.fight) * (0.5 + Math.random());
        }
        r.f += (r.fTarget - r.f) * Math.min(1, ctx.dt * (1.5 + r.fish.fight * 4));
        // The catch zone rises while you hold, falls when you let go.
        r.zoneV += (ctx.input.hold ? 2.6 : -2.2) * ctx.dt;
        r.zoneV *= Math.pow(0.4, ctx.dt);
        r.zone += r.zoneV * ctx.dt;
        if (r.zone < 0) (r.zone = 0), (r.zoneV = Math.max(0, r.zoneV) * -0.3);
        const size = r.fish.id === "golden" ? 0.2 : 0.28;
        if (r.zone > 1 - size) (r.zone = 1 - size), (r.zoneV = Math.min(0, r.zoneV) * -0.3);
        const inside = r.f >= r.zone && r.f <= r.zone + size;
        r.progress += (inside ? 0.32 : -0.22) * ctx.dt;
        if (r.progress >= 1) land(r.fish);
        else if (r.progress <= 0) lose();
      }
      if (phase.kind === "result") {
        if (!phase.until) phase.until = t + 2.6;
        float.position.lerp(tip, Math.min(1, ctx.dt * 6));
        trophy.position.copy(opts.spot).addScaledVector(fwd, 0.5);
        trophy.position.y += 1.6 + Math.sin(t * 6) * 0.05;
        trophy.rotation.z = Math.sin(t * 9) * 0.3;
        if (t > phase.until) {
          buildTrophy(null);
          phase = { kind: "idle" };
          rod.visible = float.visible = line.visible = false;
        }
      }
      // Splash ring.
      splashT += ctx.dt;
      const sm = splash.material as THREE.MeshBasicMaterial;
      sm.opacity = Math.max(0, 0.8 - splashT * 0.9);
      splash.scale.setScalar(1 + splashT * 6);
      splash.position.set(landing.x, sea + 0.02, landing.z);
      // The line sags between tip and float.
      for (let i = 0; i < 12; i++) {
        const k = i / 11;
        const sag = phase.kind === "reel" ? 0.1 : 0.9;
        linePos[i * 3] = tip.x + (float.position.x - tip.x) * k;
        linePos[i * 3 + 1] = tip.y + (float.position.y - tip.y) * k - Math.sin(k * Math.PI) * sag;
        linePos[i * 3 + 2] = tip.z + (float.position.z - tip.z) * k;
      }
      lineGeo.attributes.position.needsUpdate = true;
      const lock = opts.spot.clone();
      return { lock, face: opts.face };
    },
    prompt(ctx) {
      if (ctx.vehicle || ctx.busy) return null;
      const d = dist2(ctx.player.x, ctx.player.z, opts.spot.x, opts.spot.z);
      const dy = Math.abs(ctx.player.y - opts.spot.y);
      if (phase.kind === "bite") return { emoji: "❗", label: "Strike!", dist: 0, act: strike };
      if (phase.kind === "wait") return { emoji: "🎣", label: "Reel in", dist: 0, act: stop };
      if (phase.kind === "reel" || phase.kind === "cast") return null;
      if (phase.kind === "result") return { emoji: "🎣", label: "Cast again", dist: 0, act: cast };
      if (d < 2.2 && dy < 1.5) return { emoji: "🎣", label: "Cast a line", dist: d, act: cast };
      const dS = dist2(ctx.player.x, ctx.player.z, opts.salAt.x, opts.salAt.z);
      if (dS < 3 && dy < 1.5 && !dialog)
        return {
          emoji: "🧔",
          label: "Talk to Sal",
          dist: dS,
          act: () => {
            const n = Object.values(saved.journal).reduce((a, j) => a + j.count, 0);
            dialog = {
              speaker: "Sal the fisherman",
              emoji: "🧔",
              text:
                n === 0
                  ? "Ahoy. Fancy a go? Stand on the gold ring, press E to cast. When the float goes under, E again, sharp. Then hold E to lift the green bar and keep it on the fish. They say there's a Golden Vibe Koi in this bay. Bites more at night, they say."
                  : saved.journal.golden
                    ? "You! You're the one who pulled the Golden Koi. Forty years I've sat here. Forty years."
                    : `${n} fish so far. Not bad. Still no golden one, eh? Try after dark.`,
              options: [{ id: "bye", label: "Thanks, Sal" }],
            };
          },
        };
      return null;
    },
    dialog: () => dialog,
    choose() {
      dialog = null;
    },
    closeDialog() {
      dialog = null;
    },
    active: () => phase.kind !== "idle",
    ui() {
      if (phase.kind === "idle") return null;
      if (phase.kind === "reel")
        return {
          phase: "reel",
          reel: { zone: phase.zone, zoneSize: phase.fish.id === "golden" ? 0.2 : 0.28, fish: phase.f, progress: phase.progress, golden: phase.fish.id === "golden" },
        };
      return { phase: phase.kind, caught: phase.kind === "result" ? caught : null };
    },
    log() {
      const journal = FISH.filter((f) => saved.journal[f.id]).map((f) => ({ name: f.name, emoji: f.emoji, count: saved.journal[f.id].count, best: saved.journal[f.id].best }));
      const n = journal.reduce((a, j) => a + j.count, 0);
      return {
        title: "🎣 Fishing at Vibe Marina",
        status: n ? `${n} caught, ${journal.length} of ${FISH.length} kinds${saved.journal.golden ? ", golden koi landed!" : ""}` : "Sal's waiting on the main pier",
        journal,
      };
    },
    dev(op) {
      if (op?.startsWith("force:")) forceFish = op.slice(6);
      if (op === "bite" && phase.kind === "wait") phase.until = 0;
      if (op === "win" && phase.kind === "reel") phase.progress = 0.999;
      return { phase: phase.kind, saved, caught };
    },
    dispose() {
      sal.dispose();
      buildTrophy(null);
      keep.forEach((k) => k.dispose());
    },
  };
}
