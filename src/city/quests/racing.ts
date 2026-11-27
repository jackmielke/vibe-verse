/**
 * Vinnie's Street Races.
 *
 * Vinnie Two-Tires runs a book on the west side, under a neon sign on the
 * corner by the police station (which is the joke). Roll up in anything with
 * wheels, put Vibe coins down, and race three of his regulars two laps round
 * the big block: north up the west avenue, east past the Empire State, south
 * down the east side and back west under the Eiffel Tower's arches.
 *
 * Win and he pays triple. Second gets the stake back. Otherwise Vinnie keeps
 * it. No Comets: Vinnie has seen what a Comet does to his book.
 *
 * The rivals are not physics. They run the course as a distance along the
 * polyline, slowing into corners, with a little rubber band so a race stays a
 * race, and they ghost through traffic (the player does not get that luxury).
 * The player is scored by the gates they pass, in order, so cutting a corner
 * through a building is not a thing, and neither is skipping half the lap.
 */
import * as THREE from "three";
import { buildCityCar } from "@/city/traffic";
import { buildBookie } from "./npc";
import { dist2, load, save, today, type Dialog, type Prompt, type QuestCtx, type QuestHost } from "./common";

/** The course, start line first, run in order and closed back to the start. */
const COURSE: Array<[number, number]> = [
  [-100, 10],
  [-100, -45],
  [-100, -100],
  [-40, -100],
  [30, -100],
  [100, -100],
  [100, -30],
  [100, 40],
  [100, 100],
  [30, 100],
  [-40, 100],
  [-100, 100],
  [-100, 55],
];
const LAPS = 2;
const BETS = [10, 25, 50, 100];
/** The most a device can win back from Vinnie in a day, net. */
const DAILY_WIN_CAP = 400;
const SAVE = "city.quest.racing";

interface Rival {
  name: string;
  skill: number;
  lane: number;
  car: ReturnType<typeof buildCityCar>;
  s: number;
  v: number;
  finished: number | null;
}

type State =
  | { kind: "idle" }
  | { kind: "grid"; stake: number }
  | { kind: "count"; stake: number; go: number }
  | { kind: "race"; stake: number; start: number; gate: number; outSince: number | null }
  | { kind: "done"; until: number };

export interface RaceUi {
  phase: "grid" | "count" | "race";
  countdown?: number;
  lap: number;
  laps: number;
  place: number;
  of: number;
  time: number;
  stake: number;
  /** Bearing to the next gate relative to the camera, radians. */
  arrow: number;
  hint?: string;
}

export interface RaceQuest {
  group: THREE.Group;
  at: THREE.Vector3;
  update(ctx: QuestCtx): void;
  prompt(ctx: QuestCtx): Prompt | null;
  dialog(): Dialog | null;
  choose(id: string): void;
  closeDialog(): void;
  ui(): RaceUi | null;
  log(): { title: string; status: string };
  dev(op?: string): unknown;
  dispose(): void;
}

export function buildRacing(host: QuestHost): RaceQuest {
  const group = new THREE.Group();
  group.name = "quest.racing";
  const keep: Array<{ dispose(): void }> = [];
  const K = <T extends { dispose(): void }>(x: T) => (keep.push(x), x);

  // ---- The course as distances ----------------------------------------
  const pts = COURSE.map(([x, z]) => new THREE.Vector2(x, z));
  const cum: number[] = [0];
  for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i % pts.length]));
  const LAP = cum[pts.length];
  const N = pts.length;
  const TOTAL = LAP * LAPS;
  /** A point on the course at distance s, and the heading there. */
  const at = (s: number, lane = 0) => {
    const d = ((s % LAP) + LAP) % LAP;
    let i = 0;
    while (i < N - 1 && cum[i + 1] <= d) i++;
    const a = pts[i];
    const b = pts[(i + 1) % N];
    const k = (d - cum[i]) / (cum[i + 1] - cum[i]);
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz) || 1;
    // Lanes are to the right of the direction of travel.
    const rx = -dz / len;
    const rz = dx / len;
    return { x: a.x + dx * k + rx * lane, z: a.y + dz * k + rz * lane, yaw: Math.atan2(dx, dz), seg: i, toCorner: cum[i + 1] - d };
  };

  // ---- Vinnie and his sign ---------------------------------------------
  const VINNIE = new THREE.Vector3(-108.2, 0, 16);
  const vinnie = buildBookie();
  vinnie.group.position.copy(VINNIE);
  vinnie.group.rotation.y = Math.PI / 2;
  group.add(vinnie.group);
  {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#07040d";
    x.fillRect(0, 0, 1024, 300);
    x.shadowColor = "#ff2d95";
    x.shadowBlur = 30;
    x.strokeStyle = "#ff2d95";
    x.lineWidth = 10;
    x.strokeRect(20, 20, 984, 260);
    x.font = "bold 120px Impact, 'Arial Black', sans-serif";
    x.textAlign = "center";
    x.fillStyle = "#fff0fb";
    x.fillText("STREET RACES", 512, 160);
    x.shadowColor = "#29f3ff";
    x.fillStyle = "#29f3ff";
    x.font = "bold 54px 'Arial Black', sans-serif";
    x.fillText("BETS TAKEN · ASK VINNIE", 512, 240);
    const t = K(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(K(new THREE.PlaneGeometry(5.2, 1.52)), K(new THREE.MeshBasicMaterial({ map: t, toneMapped: false, side: THREE.DoubleSide })));
    sign.position.set(VINNIE.x - 0.6, 4.2, VINNIE.z - 1.2);
    sign.rotation.y = Math.PI / 2;
    group.add(sign);
    const poleM = K(new THREE.MeshStandardMaterial({ color: "#222", metalness: 0.6, roughness: 0.4 }));
    for (const dz of [-2.2, 2.2]) {
      const pole = new THREE.Mesh(K(new THREE.CylinderGeometry(0.07, 0.07, 4.9, 8)), poleM);
      pole.position.set(VINNIE.x - 0.65, 2.45, VINNIE.z - 1.2 + dz);
      group.add(pole);
    }
  }

  // ---- Gates: a neon arch at each corner of the course -------------------
  const gateMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    const n = pts[(i + 1) % N];
    const yaw = Math.atan2(n.x - p.x, n.y - p.y);
    const start = i === 0;
    const m = K(new THREE.MeshBasicMaterial({ color: start ? 0xffffff : 0xff2d95, transparent: true, opacity: 0.35, toneMapped: false }));
    gateMats.push(m);
    const g = new THREE.Group();
    const W = 11;
    const H = 5.5;
    for (const sx of [-W / 2, W / 2]) {
      const post = new THREE.Mesh(K(new THREE.BoxGeometry(0.3, H, 0.3)), m);
      post.position.set(sx, H / 2, 0);
      g.add(post);
    }
    if (start) {
      // A chequered banner for the start and finish.
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 64;
      const x = c.getContext("2d")!;
      for (let k = 0; k < 32; k++) for (let r = 0; r < 4; r++) {
        x.fillStyle = (k + r) % 2 ? "#111" : "#fff";
        x.fillRect(k * 16, r * 16, 16, 16);
      }
      const t = K(new THREE.CanvasTexture(c));
      const banner = new THREE.Mesh(K(new THREE.PlaneGeometry(W, 0.9)), K(new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide })));
      banner.position.y = H;
      g.add(banner);
      // And the line on the road.
      const line = new THREE.Mesh(K(new THREE.PlaneGeometry(W, 1.2)), K(new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide })));
      line.rotation.x = -Math.PI / 2;
      line.position.y = 0.04;
      g.add(line);
    } else {
      const bar = new THREE.Mesh(K(new THREE.BoxGeometry(W, 0.3, 0.3)), m);
      bar.position.y = H;
      g.add(bar);
    }
    g.position.set(p.x, 0, p.y);
    g.rotation.y = yaw;
    g.visible = start;
    g.userData.gate = i;
    group.add(g);
  }
  const gateGroups = group.children.filter((c) => c.userData.gate !== undefined);

  // ---- Rivals -------------------------------------------------------------
  const rivals: Rival[] = [
    { name: "Neon Nadia", skill: 1.04, lane: -3.2, car: buildCityCar({ body: 0xff2d95, accent: 0x7a0f4a, trim: 0x111111 }, 1) },
    { name: "Turbo Tex", skill: 0.98, lane: 0, car: buildCityCar({ body: 0x29f3ff, accent: 0x0b5a66, trim: 0x111111 }, 3) },
    { name: "Dizzy Dee", skill: 0.92, lane: 3.2, car: buildCityCar({ body: 0xc6ff3d, accent: 0x4a6610, trim: 0x111111 }, 4) },
  ].map((r) => ({ ...r, s: 0, v: 0, finished: null }));
  for (const r of rivals) {
    r.car.group.visible = false;
    group.add(r.car.group);
  }

  const saved = load(SAVE, { day: "", won: 0, wins: 0, races: 0, best: 0 });
  let state: State = { kind: "idle" };
  let dialog: Dialog | null = null;
  let lastCtx: QuestCtx | null = null;
  let playerM = 0;
  let lastCount = 0;

  const placeRivals = (s: number) => {
    for (const r of rivals) {
      // Staggered on the grid, two car lengths apart, behind the line.
      const off = r.lane === 0 ? -6 : r.lane < 0 ? -1 : -11;
      r.s = s + off;
      r.v = 0;
      r.finished = null;
      const p = at(r.s, r.lane);
      r.car.group.position.set(p.x, 0, p.z);
      r.car.group.rotation.y = p.yaw;
      r.car.group.visible = true;
    }
  };
  const hideRivals = () => rivals.forEach((r) => (r.car.group.visible = false));
  const showGates = (all: boolean) => gateGroups.forEach((g) => (g.visible = all || g.userData.gate === 0));

  const winsLeft = () => {
    if (saved.day !== today()) {
      saved.day = today();
      saved.won = 0;
    }
    return Math.max(0, DAILY_WIN_CAP - saved.won);
  };

  const talk = (ctx: QuestCtx) => {
    const v = ctx.vehicle;
    const bal = host.balance();
    const reason = !v ? "Get in a car first" : v.kind === "comet" ? "No Comets. Vinnie's rules." : null;
    const bets = BETS.map((b) => ({
      id: `bet:${b}`,
      label: `Bet ${b} ✦`,
      disabled: reason ?? (bal < b ? `You have ${Math.floor(bal)} ✦` : undefined),
    }));
    dialog = {
      speaker: "Vinnie Two-Tires",
      emoji: "🕶️",
      text: !v
        ? "Hey, hey, the new kid. Two laps round the big block against my regulars, Nadia, Tex and Dee. You win, I pay triple. Second, you get your money back. But you can't race on foot, genius. Grab some wheels, press F next to a car, and come see me."
        : v.kind === "comet"
          ? "Whoa whoa whoa. Not in that thing. I've seen what a Comet does to my book. Bring me something honest."
          : `Nice ride. Two laps round the big block: up this avenue, east past the Empire State, down the far side and back under the Eiffel. Win pays triple, second gets your stake back. You're carrying ${Math.floor(bal)} ✦. What are we betting?`,
      options: [...bets, { id: "bet:0", label: "Just for fun", disabled: reason ?? undefined }, { id: "no", label: "Not now" }],
    };
  };

  const startGrid = (stake: number) => {
    if (stake > 0 && !host.spend(stake)) {
      host.toast("Not enough coins", "Vinnie doesn't do credit.");
      return;
    }
    placeRivals(0);
    showGates(true);
    state = { kind: "grid", stake };
    host.toast(stake ? `${stake} ✦ on the table` : "A friendly race", "Pull up to the chequered line and stop. The lights go when you do.");
    host.sound("chime", 4);
  };

  const cancel = (why: string, refund: boolean) => {
    if ((state.kind === "grid" || state.kind === "count") && refund && state.stake) host.earn(state.stake, "Vinnie gave your stake back");
    hideRivals();
    showGates(false);
    state = { kind: "idle" };
    host.toast("Race off", why);
  };

  const place = () => 1 + rivals.filter((r) => (r.finished !== null ? true : r.s > playerM)).length;

  const finish = (t: number) => {
    if (state.kind !== "race") return;
    const stake = state.stake;
    const time = t - state.start;
    const pos = 1 + rivals.filter((r) => r.finished !== null).length;
    saved.races++;
    let text: string;
    if (pos === 1) {
      saved.wins++;
      if (!saved.best || time < saved.best) saved.best = Math.round(time * 10) / 10;
      const pay = Math.min(stake * 3, stake + winsLeft());
      saved.won += Math.max(0, pay - stake);
      if (pay > 0) host.earn(pay, `Won Vinnie's street race (${stake} ✦ bet)`);
      text = stake
        ? `Ha! Look at you! ${time.toFixed(1)} seconds. Here's your ${pay} ✦. Don't spend it all at once, and don't tell Nadia.`
        : `${time.toFixed(1)} seconds, first across the line. Put some coins down next time and make it interesting.`;
      host.sound("fanfare");
    } else if (pos === 2) {
      if (stake) host.earn(stake, "Second place: stake back");
      text = `Second. Respectable. Here's your ${stake} ✦ back. ${rivals.find((r) => r.finished !== null)?.name ?? "Nadia"} says thanks for the tow.`;
      host.sound("chime", 3);
    } else {
      text = stake ? `${pos === 3 ? "Third" : "Last"}. Ouch. Vinnie thanks you for your generous donation of ${stake} ✦.` : `${pos === 3 ? "Third" : "Last"}. It's a long way round, huh?`;
      host.sound("thud", 0.4);
    }
    save(SAVE, saved);
    host.toast(`🏁 ${["", "1st", "2nd", "3rd", "4th"][pos]} place`, `${time.toFixed(1)} s`);
    dialog = { speaker: "Vinnie Two-Tires", emoji: "🕶️", text, options: [{ id: "again", label: "Run it back" }, { id: "no", label: "Later, Vinnie" }] };
    state = { kind: "done", until: t + 4 };
    showGates(false);
  };

  return {
    group,
    at: VINNIE,
    update(ctx) {
      lastCtx = ctx;
      const t = ctx.t;
      vinnie.animate(t, ctx.dt);
      vinnie.marker.visible = state.kind === "idle";
      const px = ctx.vehicle ? ctx.vehicle.x : ctx.player.x;
      const pz = ctx.vehicle ? ctx.vehicle.z : ctx.player.z;
      if (dialog && state.kind === "idle" && dist2(px, pz, VINNIE.x, VINNIE.z) > 14) dialog = null;
      // Gates: the next one bright and pulsing, the rest dim.
      const nextGate = state.kind === "race" ? (state.gate + 1) % N : 0;
      gateMats.forEach((m, i) => {
        m.opacity = i === nextGate ? 0.75 + Math.sin(t * 8) * 0.2 : 0.25;
      });

      if (state.kind === "grid") {
        if (!ctx.vehicle) return cancel("You got out of the car. Vinnie hands your stake back.", true);
        const d = dist2(px, pz, pts[0].x, pts[0].y + 6);
        if (d < 16 && Math.abs(ctx.vehicle.speed) < 4) {
          state = { kind: "count", stake: state.stake, go: t + 3 };
          lastCount = 4;
        }
      } else if (state.kind === "count") {
        if (!ctx.vehicle) return cancel("You got out of the car. Vinnie hands your stake back.", true);
        const left = Math.ceil(state.go - t);
        if (left !== lastCount && left > 0) {
          lastCount = left;
          host.sound("countdown");
        }
        if (t >= state.go) {
          state = { kind: "race", stake: state.stake, start: t, gate: 0, outSince: null };
          playerM = 0;
          host.sound("go");
        }
      } else if (state.kind === "race") {
        const r = state;
        // Out of the car too long is a forfeit.
        if (!ctx.vehicle) {
          r.outSince ??= t;
          if (t - r.outSince > 6) {
            hideRivals();
            showGates(false);
            state = { kind: "idle" };
            host.toast("Forfeit", "You left your car. Vinnie keeps the stake.");
            return;
          }
        } else r.outSince = null;
        // Gates in order. Passing gate k of the course (k counted across laps).
        const g = r.gate + 1;
        const gp = pts[g % N];
        if (dist2(px, pz, gp.x, gp.y) < 10) {
          r.gate = g;
          host.sound("chime", g % N === 0 ? 6 : 2);
          if (g >= N * LAPS) return finish(t);
          if (g % N === 0) host.toast(`Lap ${g / N + 1} of ${LAPS}`);
        }
        // Distance run: the last gate plus how far along toward the next.
        const a = pts[r.gate % N];
        const b = pts[(r.gate + 1) % N];
        const seg = new THREE.Vector2(b.x - a.x, b.y - a.y);
        const len = seg.length();
        const along = THREE.MathUtils.clamp(((px - a.x) * seg.x + (pz - a.y) * seg.y) / len, 0, len);
        playerM = Math.floor(r.gate / N) * LAP + cum[r.gate % N] + along;
        // Rivals.
        for (const rv of rivals) {
          if (rv.finished !== null) continue;
          const p = at(rv.s, rv.lane);
          let target = 24.5 * rv.skill;
          if (p.toCorner < 22) target = Math.min(target, 12 + p.toCorner * 0.35);
          const gap = rv.s - playerM;
          if (gap > 60) target *= 0.85;
          else if (gap < -40) target *= 1.12;
          rv.v += THREE.MathUtils.clamp(target - rv.v, -14 * ctx.dt, 9 * ctx.dt);
          rv.s += rv.v * ctx.dt;
          if (rv.s >= TOTAL) rv.finished = t;
          const q = at(rv.s, rv.lane);
          rv.car.group.position.set(q.x, 0, q.z);
          // Ease the heading through corners instead of snapping.
          let dy = q.yaw - rv.car.group.rotation.y;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          rv.car.group.rotation.y += dy * Math.min(1, ctx.dt * 7);
        }
        // Time limit: four minutes.
        if (t - r.start > 240) {
          hideRivals();
          showGates(false);
          state = { kind: "idle" };
          host.toast("Too slow", "The race is over. Vinnie keeps the stake.");
        }
      } else if (state.kind === "done") {
        // The rivals coast on past the line, then go home.
        for (const rv of rivals) {
          rv.v *= Math.pow(0.5, ctx.dt);
          rv.s += rv.v * ctx.dt;
          const q = at(rv.s, rv.lane);
          rv.car.group.position.set(q.x, 0, q.z);
        }
        if (t > state.until) {
          hideRivals();
          state = { kind: "idle" };
        }
      }
    },
    prompt(ctx) {
      if (state.kind !== "idle" && state.kind !== "done") return null;
      if (dialog || ctx.busy) return null;
      const px = ctx.vehicle ? ctx.vehicle.x : ctx.player.x;
      const pz = ctx.vehicle ? ctx.vehicle.z : ctx.player.z;
      const d = dist2(px, pz, VINNIE.x, VINNIE.z);
      if (d < (ctx.vehicle ? 12 : 3.2)) return { emoji: "🕶️", label: "Talk to Vinnie", dist: d, act: () => talk(ctx) };
      return null;
    },
    dialog: () => dialog,
    choose(id) {
      dialog = null;
      if (id.startsWith("bet:")) startGrid(Number(id.slice(4)));
      else if (id === "again" && lastCtx) talk(lastCtx);
    },
    closeDialog() {
      dialog = null;
    },
    ui() {
      const ctx = lastCtx;
      if (!ctx || (state.kind !== "grid" && state.kind !== "count" && state.kind !== "race")) return null;
      const px = ctx.vehicle ? ctx.vehicle.x : ctx.player.x;
      const pz = ctx.vehicle ? ctx.vehicle.z : ctx.player.z;
      const target = state.kind === "race" ? pts[(state.gate + 1) % N] : new THREE.Vector2(pts[0].x, pts[0].y + 6);
      const bearing = Math.atan2(target.x - px, target.y - pz);
      const arrow = bearing - (ctx.camYaw + Math.PI);
      const lap = state.kind === "race" ? Math.min(LAPS, Math.floor(state.gate / N) + 1) : 1;
      return {
        phase: state.kind,
        countdown: state.kind === "count" ? Math.max(1, Math.ceil(state.go - ctx.t)) : undefined,
        lap,
        laps: LAPS,
        place: state.kind === "race" ? place() : 4,
        of: 4,
        time: state.kind === "race" ? ctx.t - state.start : 0,
        stake: state.stake,
        arrow,
        hint: state.kind === "grid" ? "Pull up to the chequered line and stop" : state.kind === "race" && state.outSince ? "Get back in a car!" : undefined,
      };
    },
    log() {
      return {
        title: "🏁 Vinnie's Street Races",
        status: saved.races
          ? `${saved.wins} wins from ${saved.races} races${saved.best ? `, best ${saved.best} s` : ""}`
          : "Vinnie takes bets on the west avenue, by the police station",
      };
    },
    dev(op) {
      if (op === "skip" && state.kind === "race") {
        // Teleport the player's progress to one gate short of the finish.
        state.gate = N * LAPS - 1;
      }
      if (op === "slow") rivals.forEach((r) => (r.skill = 0.3));
      return { state, playerM, rivals: rivals.map((r) => ({ name: r.name, s: Math.round(r.s), v: Math.round(r.v), finished: r.finished })), saved, LAP, start: [pts[0].x, pts[0].y] };
    },
    dispose() {
      vinnie.dispose();
      rivals.forEach((r) => r.car.dispose());
      keep.forEach((k) => k.dispose());
    },
  };
}
