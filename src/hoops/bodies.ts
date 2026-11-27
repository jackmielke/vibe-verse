/**
 * VIBE HOOPS — the people on the floor, as three.js bodies.
 *
 * Three kinds, one interface (`Body.pose` takes what the rules say a player
 * is doing and makes the body look like it):
 *
 *  - **Vibey**: the goggled robot from `src/fnaf/vibey.ts`. No arms, no legs,
 *    so he scoots and hops, and the ball floats where his hands would be.
 *  - **The junkyard crew**: Cannon Chase's `buildMort`, with Hubcap Hank and
 *    Rusty Ray repainted from Mort's own parts. Limbs swung in code.
 *  - **Anybody in the roster** (`src/lib/characters.ts`), files and code
 *    alike, through `loadCharacterRig`. A file with clips gets its own Run,
 *    Jump, Punch (for a steal) and Victory; a code-built one runs its gait.
 *
 * Everything faces +z and stands on y = 0 when it leaves here.
 */
import * as THREE from "three";
import { loadCharacterRig, refitByRender, type CharacterRig } from "@/lib/characterRig";
import { findCharacter, type CharSpec } from "@/lib/characters";
import { buildMort, type Mort } from "@/cannonrun/models";
import { makeVibeyParts } from "@/fnaf/vibey";
import type { Act } from "./game";
import type { Baller } from "./teams";

export interface Pose {
  speed: number;
  /** Height off the floor, metres. */
  z: number;
  act: Act;
  actT: number;
  has: boolean;
  mood: "play" | "win" | "lose";
}

export interface Body {
  root: THREE.Group;
  height: number;
  /** Where a held ball sits above the floor when shooting, for the renderer. */
  handY: number;
  pose(dt: number, s: Pose): void;
  dispose(): void;
}

const HEIGHT = 1.85;

export async function buildBody(who: Baller, renderer: THREE.WebGLRenderer | null, me?: CharSpec | null): Promise<Body> {
  const kind = who.body;
  if (kind === "vibey") return vibeyBody();
  if (kind === "mort" || kind === "linda" || kind === "hank" || kind === "ray") return crewBody(kind);
  // A roster id ("Kimono_Male", "seraph"), or whoever the visitor picked in My Vibe.
  const spec = kind === "me" ? (me ?? findCharacter(null)) : findCharacter(kind);
  return rosterBody(spec, renderer);
}

// ---------------------------------------------------------------- Vibey

function vibeyBody(): Body {
  const parts = makeVibeyParts();
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(parts.root);
  root.add(holder);
  // He is about a metre; a basketball Vibey stands a bit taller.
  const box = new THREE.Box3().setFromObject(parts.root);
  const h = Math.max(0.5, box.max.y - box.min.y);
  const k = 1.55 / h;
  holder.scale.setScalar(k);
  holder.position.y = -box.min.y * k;
  parts.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  let phase = 0;
  let spin = 0;
  return {
    root,
    height: 1.55,
    handY: 1.75,
    pose(dt, s) {
      phase += dt * (6 + s.speed * 1.6);
      spin += dt * s.speed * 4;
      parts.disc.rotation.y = spin;
      const hop = s.z > 0.02 ? 0 : Math.abs(Math.sin(phase)) * Math.min(0.12, s.speed * 0.02);
      parts.body.position.y = hop / k;
      const squash = s.z > 0.02 ? 1.06 : 1 - hop * 0.6;
      parts.body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      parts.body.rotation.x = Math.min(0.3, s.speed * 0.04);
      parts.head.rotation.x = s.act === "shoot" || s.act === "dunk" ? -0.35 : 0;
      const cheer = s.mood === "win" ? Math.sin(phase * 1.4) * 0.6 : 0;
      parts.body.rotation.z = cheer * 0.3;
      parts.antennas.forEach((a, n) => (a.rotation.z = Math.sin(phase * 1.3 + n) * (0.15 + s.speed * 0.03) + cheer));
      for (const m of parts.eyeMats) m.emissiveIntensity = s.act === "dunk" ? 2.4 : 1;
    },
    dispose() {
      parts.dispose();
    },
  };
}

// ---------------------------------------------------------------- the crew

const REPAINT: Record<string, Record<number, number>> = {
  // Hubcap Hank: orange overalls, a chrome cap that looks a lot like a hubcap.
  hank: { 0x35507a: 0xe2781e, 0x2b5a2a: 0xc8d0d8, 0xe8e2d4: 0x2a2a30 },
  // Rusty Ray: rust-brown overalls, a lime cap, a grubby green vest.
  ray: { 0x35507a: 0x8a4a22, 0x2b5a2a: 0x7ce04a, 0xe8e2d4: 0x4e7a3a },
};

function crewBody(kind: "mort" | "linda" | "hank" | "ray"): Body {
  const m: Mort = buildMort(kind === "linda");
  const paint = REPAINT[kind];
  m.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    if (!paint) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat && mat.color && paint[mat.color.getHex()] !== undefined) mat.color.setHex(paint[mat.color.getHex()]);
  });
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(m.root);
  root.add(holder);
  const k = 1.9 / 1.95;
  holder.scale.setScalar(k);
  let phase = 0;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    root,
    height: 1.9,
    handY: 2.15,
    pose(dt, s) {
      phase += dt * (2 + s.speed * 1.9);
      const run = Math.min(1, s.speed / 6);
      const swing = Math.sin(phase) * 0.85 * run;
      const air = s.z > 0.05;
      const up = s.act === "shoot" || s.act === "dunk" || s.act === "layup" || s.act === "hang" || s.act === "jump";
      const k2 = Math.min(1, dt * 14);
      // Arms: swing when running, up for shots and blocks, a jab for a steal.
      let la = -swing;
      let ra = swing;
      if (up) la = ra = -2.8;
      if (s.has && !up) ra = -0.6 + Math.abs(Math.sin(phase * 1.2)) * 0.5; // the dribble hand
      if (s.act === "steal") ra = -1.5;
      if (s.mood === "win") la = ra = -2.9 + Math.sin(phase * 2) * 0.3;
      if (s.mood === "lose") la = ra = 0.1;
      m.armL.rotation.x = lerp(m.armL.rotation.x, la, k2);
      m.armR.rotation.x = lerp(m.armR.rotation.x, ra, k2);
      m.legL.rotation.x = lerp(m.legL.rotation.x, air ? -0.7 : swing, k2);
      m.legR.rotation.x = lerp(m.legR.rotation.x, air ? 0.3 : -swing, k2);
      holder.position.y = air ? 0 : Math.abs(Math.cos(phase)) * 0.05 * run;
      holder.rotation.x = lerp(holder.rotation.x, run * 0.12, k2);
      m.head.rotation.z = s.mood === "lose" ? 0 : Math.sin(phase * 0.5) * 0.05;
    },
    dispose() {
      m.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
      });
    },
  };
}

// ---------------------------------------------------------------- the roster

function rosterBody(spec: CharSpec, renderer: THREE.WebGLRenderer | null): Promise<Body> {
  return loadCharacterRig(spec, { height: HEIGHT, center: true, castShadow: true, walkSpeed: 6 }).then((rig: CharacterRig) => {
    if (renderer && spec.url) {
      try {
        refitByRender(renderer, rig, HEIGHT);
      } catch {
        /* keep the box fit */
      }
    }
    const root = new THREE.Group();
    root.add(rig.object);
    const clips = rig.clips;
    const mixer = rig.mixer;
    const find = (re: RegExp) => clips.find((c) => re.test(c.name.replace(/^.*\|/, "")));
    type Slot = { action: THREE.AnimationAction; w: number };
    const slots: Record<string, Slot | null> = {};
    if (mixer && clips.length) {
      mixer.stopAllAction();
      const make = (clip: THREE.AnimationClip | undefined, once = false): Slot | null => {
        if (!clip) return null;
        const a = mixer.clipAction(clip);
        a.reset();
        a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = once;
        a.enabled = true;
        a.setEffectiveWeight(0);
        a.play();
        return { action: a, w: 0 };
      };
      slots.idle = make(find(/^idle$/i) ?? find(/idle/i) ?? clips[0]);
      slots.run = make(find(/^run$/i) ?? find(/run|walk/i));
      slots.jump = make(find(/^jump$/i) ?? find(/jump/i));
      slots.steal = make(find(/^punch$/i) ?? find(/punch|sword|slash/i));
      slots.win = make(find(/^victory$/i) ?? find(/victory|yes|wave|cheer/i));
      slots.lose = make(find(/^defeat$/i) ?? find(/defeat|no$|death/i));
      if (slots.jump) slots.jump.action.paused = true;
    }
    return {
      root,
      height: HEIGHT,
      handY: 2.1,
      pose(dt, s) {
        if (!mixer || !clips.length) {
          rig.setLocomotion(Math.min(1, s.speed / 6));
          rig.update(dt);
          return;
        }
        const air = s.z > 0.05 || s.act === "dunk" || s.act === "hang";
        const want: Record<string, number> = { idle: 0, run: 0, jump: 0, steal: 0, win: 0, lose: 0 };
        if (s.mood === "win" && slots.win) want.win = 1;
        else if (s.mood === "lose" && slots.lose) want.lose = 1;
        else if (air && slots.jump) want.jump = 1;
        else if (s.act === "steal" && slots.steal) want.steal = 1;
        else {
          const r = Math.min(1, s.speed / 3);
          want.run = slots.run ? r : 0;
          want.idle = 1 - want.run;
        }
        const k = Math.min(1, dt * 12);
        for (const key of Object.keys(slots)) {
          const sl = slots[key];
          if (!sl) continue;
          sl.w += ((want[key] ?? 0) - sl.w) * k;
          sl.action.setEffectiveWeight(sl.w);
        }
        if (slots.run) slots.run.action.timeScale = 0.6 + Math.min(1.4, s.speed / 6);
        if (slots.jump) {
          // Hold the jump clip at the pose that matches how high we are.
          const d = slots.jump.action.getClip().duration;
          slots.jump.action.time = d * (0.28 + Math.min(0.2, s.z * 0.15));
        }
        if (slots.steal && s.act === "steal" && s.actT < 0.05) slots.steal.action.reset().play();
        mixer.update(dt);
      },
      dispose() {
        rig.dispose();
      },
    };
  });
}

/** Something to stand in while a file loads, or if it never does. */
export function placeholderBody(color: string): Body {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 10), mat);
  torso.position.y = 1.05;
  torso.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), new THREE.MeshStandardMaterial({ color: 0xf1c7a0, roughness: 0.7 }));
  head.position.y = 1.78;
  head.castShadow = true;
  root.add(torso, head);
  return {
    root,
    height: 1.85,
    handY: 2.1,
    pose() {},
    dispose() {
      torso.geometry.dispose();
      head.geometry.dispose();
      mat.dispose();
    },
  };
}
