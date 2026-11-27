/**
 * The Sky Sprint: sticky shoes up the Empire State.
 *
 * Gail rents gecko-grip climbing shoes from a stall by the tower's south
 * doors. Wearing them, walk into any face of the building and hold W: you
 * stick, and climb. A/D shuffle sideways, S climbs down, Space kicks off. At
 * the top of each setback you haul yourself onto the ledge, walk to the next
 * wall and go again, all the way up the mooring mast to the gold flag on top.
 *
 * Start a Sky Sprint and a clock runs from your first grip to the flag, with
 * a split at each setback and golden orbs on the faces worth a coin each.
 * Jetpacks void the run, which is the whole point: the tower is the course.
 *
 * Like every quest a climber is locked rather than simulated: each frame the
 * page's physics runs, and then the feet are put back on the wall.
 *
 * The tier sizes are copied from `landmarks/empireState.ts`; if the tower is
 * resized, change them here too.
 */
import * as THREE from "three";
import { buildClimber } from "./npc";
import { dist2, load, save, today, type Dialog, type Prompt, type QuestCtx, type QuestHost, type QuestStep } from "./common";

interface Tier {
  name: string;
  w: number;
  d: number;
  y0: number;
  /** Where the climbable face ends (the top of a railing, if there is one). */
  top: number;
  /** The roof you mantle onto. */
  roof: number;
  /** How far inside the collision box the drawn surface is (the mast is a tapered octagon). */
  inset?: number;
}

const TIERS: Tier[] = [
  { name: "Podium roof", w: 26, d: 24, y0: 0, top: 12, roof: 12 },
  { name: "Setback one", w: 22, d: 19, y0: 12, top: 34, roof: 34 },
  { name: "The shaft", w: 18, d: 15, y0: 34, top: 104, roof: 104 },
  { name: "86th floor deck", w: 15, d: 13, y0: 104, top: 119.8, roof: 117 },
  { name: "Upper tower", w: 9, d: 7, y0: 117, top: 125, roof: 125 },
  { name: "The crown", w: 7, d: 5.6, y0: 125, top: 129, roof: 129 },
  { name: "Crown top", w: 5.4, d: 4.4, y0: 129, top: 133, roof: 133 },
  { name: "Mooring mast", w: 4.4, d: 4.4, y0: 133, top: 153, roof: 153, inset: 0.75 },
];
const OFF = 0.5;
const CLIMB = 5;
const SPRINT_CLIMB = 7.5;
const SIDE = 3.5;
const SAVE = "city.quest.sprint";

type Face = { tier: number; axis: "x" | "z"; sign: 1 | -1 };

export interface SprintUi {
  shoes: boolean;
  climbing: boolean;
  run: { time: number; split: string | null; orbs: number; orbsTotal: number } | null;
  altitude: number;
  best: number | null;
}

export interface SprintQuest {
  group: THREE.Group;
  at: THREE.Vector3;
  update(ctx: QuestCtx): QuestStep | null;
  prompt(ctx: QuestCtx): Prompt | null;
  dialog(): Dialog | null;
  choose(id: string): void;
  closeDialog(): void;
  /** Take the shoes off wherever you are: ends a run and lets go of the wall. */
  quit(): void;
  ui(): SprintUi | null;
  log(): { title: string; status: string };
  dev(op?: string): unknown;
  dispose(): void;
}

export function buildSprint(host: QuestHost, opts: { cx: number; cz: number }): SprintQuest {
  const { cx, cz } = opts;
  const group = new THREE.Group();
  group.name = "quest.sprint";
  const keep: Array<{ dispose(): void }> = [];
  const K = <T extends { dispose(): void }>(x: T) => (keep.push(x), x);

  // Gail and her stall, beside the south doors.
  const GAIL = new THREE.Vector3(cx + 8.5, 0, cz + 14.2);
  const gail = buildClimber();
  gail.group.position.copy(GAIL);
  gail.group.rotation.y = Math.PI;
  group.add(gail.group);
  {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 200;
    const x = c.getContext("2d")!;
    x.fillStyle = "#123c33";
    x.fillRect(0, 0, 512, 200);
    x.strokeStyle = "#26c6a2";
    x.lineWidth = 10;
    x.strokeRect(10, 10, 492, 180);
    x.fillStyle = "#c6ff3d";
    x.font = "bold 62px 'Arial Black', sans-serif";
    x.textAlign = "center";
    x.fillText("STICKY SHOES", 256, 92);
    x.fillStyle = "#fff";
    x.font = "bold 34px Georgia, serif";
    x.fillText("🦎 climb it · Sky Sprint", 256, 156);
    const t = K(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(K(new THREE.PlaneGeometry(2.6, 1.0)), K(new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, side: THREE.DoubleSide })));
    board.position.set(GAIL.x, 2.6, GAIL.z - 1.3);
    group.add(board);
    const wood = K(new THREE.MeshStandardMaterial({ color: "#5b3d22", roughness: 0.9 }));
    const counter = new THREE.Mesh(K(new THREE.BoxGeometry(2.4, 1.0, 0.7)), wood);
    counter.position.set(GAIL.x, 0.5, GAIL.z - 1.1);
    group.add(counter);
    for (const dx of [-1.15, 1.15]) {
      const post = new THREE.Mesh(K(new THREE.BoxGeometry(0.1, 3.1, 0.1)), wood);
      post.position.set(GAIL.x + dx, 1.55, GAIL.z - 1.35);
      group.add(post);
    }
    // A pair of glowing green shoes on the counter.
    const shoeM = K(new THREE.MeshStandardMaterial({ color: "#c6ff3d", emissive: "#7acc00", emissiveIntensity: 0.6, roughness: 0.4 }));
    for (const dx of [-0.15, 0.15]) {
      const shoe = new THREE.Mesh(K(new THREE.BoxGeometry(0.16, 0.12, 0.34)), shoeM);
      shoe.position.set(GAIL.x + dx, 1.07, GAIL.z - 1.05);
      group.add(shoe);
    }
  }

  // The gold flag on the mast.
  const TOP = TIERS[TIERS.length - 1].roof;
  {
    const pole = new THREE.Mesh(K(new THREE.CylinderGeometry(0.06, 0.06, 3, 8)), K(new THREE.MeshStandardMaterial({ color: "#ddd", metalness: 0.8, roughness: 0.3 })));
    pole.position.set(cx, TOP + 1.5, cz + 0.35);
    const flag = new THREE.Mesh(
      K(new THREE.PlaneGeometry(1.4, 0.9)),
      K(new THREE.MeshStandardMaterial({ color: "#ffcf40", emissive: "#ffb300", emissiveIntensity: 0.6, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.3 })),
    );
    flag.position.set(cx + 0.72, TOP + 2.5, cz + 0.35);
    group.add(pole, flag);
  }

  // Golden orbs up the faces: one coin each per run.
  const orbM = K(new THREE.MeshBasicMaterial({ color: 0xffd34d, toneMapped: false }));
  const orbGeo = K(new THREE.OctahedronGeometry(0.35));
  const orbs: Array<{ mesh: THREE.Mesh; got: boolean }> = [];
  const placeOrb = (tier: number, axis: "x" | "z", sign: 1 | -1, u: number, y: number) => {
    const t = TIERS[tier];
    const m = new THREE.Mesh(orbGeo, orbM);
    const half = axis === "x" ? t.w / 2 : t.d / 2;
    if (axis === "x") m.position.set(cx + sign * (half + OFF), y, cz + u);
    else m.position.set(cx + u, y, cz + sign * (half + OFF));
    m.visible = false;
    group.add(m);
    orbs.push({ mesh: m, got: false });
  };
  placeOrb(0, "z", 1, -8, 6);
  placeOrb(1, "z", 1, 4, 22);
  placeOrb(1, "x", 1, 0, 28);
  for (let i = 0; i < 6; i++) placeOrb(2, i % 2 ? "x" : "z", 1, (i % 3) * 3 - 3, 42 + i * 10);
  placeOrb(3, "z", 1, 0, 110);
  placeOrb(4, "z", 1, 2, 121);
  placeOrb(7, "z", 1, 0, 140);
  placeOrb(7, "x", -1, 0, 147);

  const saved = load(SAVE, { best: 0, runs: 0, day: "", paid: 0 });
  let shoes = false;
  let dialog: Dialog | null = null;
  let cling: (Face & { u: number; y: number }) | null = null;
  let run: { start: number | null; split: string | null; splitAt: number; reached: number; orbs: number } | null = null;
  let kickGrace = 0;
  let release: THREE.Vector3 | null = null;
  let lastCtx: QuestCtx | null = null;

  const faceOf = (p: THREE.Vector3): Face | null => {
    for (let i = TIERS.length - 1; i >= 0; i--) {
      const t = TIERS[i];
      if (p.y < t.y0 - 0.4 || p.y > t.top - 0.3) continue;
      const dx = Math.abs(p.x - cx) - t.w / 2;
      const dz = Math.abs(p.z - cz) - t.d / 2;
      if (dx > -0.3 && dx < 1.1 && Math.abs(p.z - cz) < t.d / 2 - 0.2) return { tier: i, axis: "x", sign: p.x > cx ? 1 : -1 };
      if (dz > -0.3 && dz < 1.1 && Math.abs(p.x - cx) < t.w / 2 - 0.2) return { tier: i, axis: "z", sign: p.z > cz ? 1 : -1 };
    }
    return null;
  };
  const normalOf = (f: Face) => (f.axis === "x" ? new THREE.Vector3(f.sign, 0, 0) : new THREE.Vector3(0, 0, f.sign));
  const posOf = (c: Face & { u: number; y: number }) => {
    const t = TIERS[c.tier];
    const off = OFF - (t.inset ?? 0);
    return c.axis === "x"
      ? new THREE.Vector3(cx + c.sign * (t.w / 2 + off), c.y, cz + c.u)
      : new THREE.Vector3(cx + c.u, c.y, cz + c.sign * (t.d / 2 + off));
  };

  const resetOrbs = (show: boolean) => orbs.forEach((o) => ((o.got = false), (o.mesh.visible = show)));

  const startRun = () => {
    shoes = true;
    run = { start: null, split: null, splitAt: 0, reached: -1, orbs: 0 };
    resetOrbs(true);
    host.toast("🦎 Sky Sprint", "Walk into the tower and hold W to climb. The clock starts on your first grip. No jetpacks!");
    host.sound("chime", 4);
  };

  const voidRun = (why: string) => {
    if (!run) return;
    run = null;
    resetOrbs(false);
    host.toast("Run void", why);
    host.sound("thud", 0.4);
  };

  const finishRun = (t: number) => {
    if (!run || run.start === null) return;
    const time = Math.round((t - run.start) * 10) / 10;
    const record = !saved.best || time < saved.best;
    if (saved.day !== today()) {
      saved.day = today();
      saved.paid = 0;
    }
    // Twenty for a finish, ten more for a record, three paid finishes a day.
    let coins = run.orbs;
    if (saved.paid < 3) {
      coins += 20 + (record && saved.best ? 10 : 0);
      saved.paid++;
    }
    if (record) saved.best = time;
    saved.runs++;
    save(SAVE, saved);
    host.sound("fanfare");
    host.toast(`🏆 Sky Sprint: ${time} s${record ? " (new best!)" : ""}`, `${run.orbs} orbs. ${TOP} metres of Empire State, no jetpack.`);
    if (coins > 0) host.earn(coins, "Sky Sprint finished");
    run = null;
    resetOrbs(false);
  };

  return {
    group,
    at: GAIL,
    update(ctx) {
      lastCtx = ctx;
      const t = ctx.t;
      gail.animate(t, ctx.dt);
      gail.marker.visible = !shoes;
      kickGrace = Math.max(0, kickGrace - ctx.dt);
      if (dialog && dist2(ctx.player.x, ctx.player.z, GAIL.x, GAIL.z) > 7) dialog = null;
      orbs.forEach((o, i) => {
        if (o.mesh.visible) o.mesh.rotation.y = t * 2 + i;
      });

      if (release) {
        const r = release;
        release = null;
        return { lock: r };
      }
      if (!shoes || ctx.vehicle || ctx.busy) {
        if (cling) cling = null;
        return null;
      }

      // Jetpacks are not climbing.
      if (run && ctx.thrusting && !cling && kickGrace <= 0) voidRun("No jetpacks on the Sky Sprint. Gail saw that.");
      // Back on the street after a start: the run is over.
      if (run && run.start !== null && !cling && ctx.grounded && ctx.player.y < 0.6 && t - run.start > 3) voidRun("You're back on the ground. Talk to Gail to try again.");

      if (!cling) {
        if (!ctx.input.up) return null;
        const f = faceOf(ctx.player);
        if (!f) return null;
        const p = ctx.player;
        cling = { ...f, u: f.axis === "x" ? p.z - cz : p.x - cx, y: Math.max(p.y, TIERS[f.tier].y0) };
        if (run && run.start === null) run.start = t;
        host.sound("chime", 1);
      }

      // Teleported away ("take me there", a portal): let go of the wall.
      if (posOf(cling).distanceTo(ctx.player) > 4) {
        cling = null;
        return null;
      }
      const c = cling;
      const tier = TIERS[c.tier];
      const n = normalOf(c);
      if (ctx.input.jump) {
        const kick = n.clone().multiplyScalar(6);
        kick.y = 4.5;
        cling = null;
        kickGrace = 0.9;
        return { kick };
      }
      const speed = ctx.input.run ? SPRINT_CLIMB : CLIMB;
      if (ctx.input.up) c.y += speed * ctx.dt;
      if (ctx.input.down) c.y -= speed * ctx.dt;
      // Sideways, as the player sees it facing the wall.
      const faceYaw = Math.atan2(-n.x, -n.z);
      const right = new THREE.Vector3(-Math.cos(faceYaw), 0, Math.sin(faceYaw));
      const side = (ctx.input.right ? 1 : 0) - (ctx.input.left ? 1 : 0);
      const along = c.axis === "x" ? right.z : right.x;
      c.u += side * along * SIDE * ctx.dt;
      const half = (c.axis === "x" ? tier.d : tier.w) / 2 - 0.3;
      c.u = THREE.MathUtils.clamp(c.u, -half, half);
      if (c.y <= tier.y0) {
        // Climbed down to the ledge or street below: let go.
        c.y = tier.y0;
        if (ctx.input.down) {
          cling = null;
          return { lock: posOf({ ...c, y: tier.y0 }) };
        }
      }
      // Collect orbs within reach.
      if (run) {
        const here = posOf(c);
        for (const o of orbs) {
          if (!o.got && o.mesh.visible && o.mesh.position.distanceTo(here) < 1.6) {
            o.got = true;
            o.mesh.visible = false;
            run.orbs++;
            host.sound("coin");
          }
        }
      }
      // No ledge to stand on (the mast rises flush from the crown's long sides): keep climbing.
      const next = TIERS[c.tier + 1];
      if (c.y >= tier.top - 0.05 && next && tier.top === next.y0 && (c.axis === "x" ? next.w >= tier.w - 0.6 : next.d >= tier.d - 0.6)) {
        c.tier++;
        const nh = (c.axis === "x" ? next.d : next.w) / 2 - 0.3;
        c.u = THREE.MathUtils.clamp(c.u, -nh, nh);
        return { lock: posOf(c), face: faceYaw, cam: Math.atan2(n.x, n.z) };
      }
      if (c.y >= tier.top - 0.05) {
        // Haul up onto the ledge.
        const top = posOf({ ...c, y: tier.roof + 0.05 }).addScaledVector(n, -(OFF + (tier.top > tier.roof ? 1.4 : 0.9)));
        cling = null;
        if (run && run.start !== null && c.tier > run.reached) {
          run.reached = c.tier;
          run.split = `${tier.name}: ${(t - run.start).toFixed(1)} s`;
          run.splitAt = t;
          host.sound("chime", 5);
        }
        if (c.tier === TIERS.length - 1) {
          if (run) finishRun(t);
          else host.toast("🚩 On top of the Empire State", `${TOP} metres up, on sticky shoes.`);
        }
        return { lock: top };
      }
      return { lock: posOf(c), face: faceYaw, cam: Math.atan2(n.x, n.z) };
    },
    prompt(ctx) {
      if (ctx.vehicle || ctx.busy || dialog) return null;
      const d = dist2(ctx.player.x, ctx.player.z, GAIL.x, GAIL.z);
      if (d < 3.4 && ctx.player.y < 1.5)
        return {
          emoji: "🦎",
          label: "Talk to Gail",
          dist: d,
          act: () => {
            dialog = {
              speaker: "Gail the climber",
              emoji: "🧗",
              text: shoes
                ? "How are the shoes? Walk into the wall and hold W. Shift climbs faster, A and D shuffle, Space kicks off. Want to go for a timed Sky Sprint?"
                : `Sticky shoes! Gecko grip, free to borrow. Walk into any wall of this tower and hold W and you'll stick. The Sky Sprint is ground to the gold flag on top of the mast, ${TOP} metres. No jetpacks.${saved.best ? ` Your best is ${saved.best} seconds.` : ""}`,
              options: [
                { id: "sprint", label: run ? "Restart the Sky Sprint" : "Start a Sky Sprint" },
                ...(shoes ? [{ id: "off", label: "Give the shoes back" }] : [{ id: "shoes", label: "Just the shoes" }]),
                { id: "bye", label: "Later" },
              ],
            };
          },
        };
      return null;
    },
    dialog: () => dialog,
    choose(id) {
      dialog = null;
      if (id === "sprint") startRun();
      else if (id === "shoes") {
        shoes = true;
        host.toast("🦎 Sticky shoes on", "Walk into the Empire State and hold W to climb.");
      } else if (id === "off") {
        shoes = false;
        cling = null;
        if (run) voidRun("Shoes returned.");
      }
    },
    closeDialog() {
      dialog = null;
    },
    quit() {
      dialog = null;
      const wasRun = !!run;
      run = null;
      resetOrbs(false);
      shoes = false;
      cling = null;
      host.toast(wasRun ? "Sky Sprint cancelled" : "🦎 Sticky shoes off", "Gail keeps a spare pair by the south doors.");
      host.sound("thud", 0.3);
    },
    ui() {
      if (!shoes) return null;
      const t = lastCtx?.t ?? 0;
      return {
        shoes,
        climbing: !!cling,
        altitude: Math.round(lastCtx?.player.y ?? 0),
        best: saved.best || null,
        run: run
          ? {
              time: run.start === null ? 0 : t - run.start,
              split: run.split && t - run.splitAt < 4 ? run.split : null,
              orbs: run.orbs,
              orbsTotal: orbs.length,
            }
          : null,
      };
    },
    log() {
      return {
        title: "🦎 Sky Sprint up the Empire State",
        status: saved.runs ? `${saved.runs} sprints, best ${saved.best} s` : "Gail lends sticky shoes by the south doors",
      };
    },
    dev(op) {
      if (op === "sprint") startRun();
      if (op?.startsWith("y:") && cling) cling.y = Number(op.slice(2));
      return { shoes, cling, run, saved };
    },
    dispose() {
      gail.dispose();
      keep.forEach((k) => k.dispose());
    },
  };
}
