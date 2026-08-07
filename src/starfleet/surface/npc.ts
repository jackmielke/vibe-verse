/**
 * A person, built to survive being looked at from two metres.
 *
 * The first version of this file was eleven primitives: a capsule torso, four
 * capsule limbs, a sphere head. It was fine at ten metres and it was the
 * weakest thing in the world at three — which is a problem, because three
 * metres is where every conversation in this game happens. You walk up to a
 * Vulcan master to ask her about Kolinahr and you are looking at a bowling pin.
 *
 * So this one is built the other way round: proportioned off real human
 * canon (head is 1/7.5 of standing height, shoulders at 0.82, hip at 0.52,
 * knee at 0.28), jointed at the elbow and knee so the limbs bend where limbs
 * bend, and given a face with a brow, a nose, a jaw, eyes that blink and a
 * mouth. None of that is expensive — it is about four hundred triangles more
 * than the capsule version — it is simply *placed* rather than approximated.
 *
 * ## What actually makes it read
 *
 * **The lathe torso.** A capsule is a constant radius and a human is not: the
 * silhouette that says "person" is wide at the shoulder, narrow at the waist,
 * wide again at the hip. That is six points on a profile curve and it does more
 * work than every other change in here combined.
 *
 * **Two-segment limbs.** An arm that bends at the elbow can gesture. A capsule
 * can only point. Half the character animation in this file is impossible
 * without the joint.
 *
 * **Eyes with a highlight.** Two dark spheres with a tiny bright one in front
 * of each. The catchlight is four triangles and it is the single strongest
 * "this is alive" cue a face has — it is what the eye is looking for when it
 * decides whether it is looking at a person or a mannequin.
 *
 * **Blinking.** Every four to seven seconds, for 90 ms. Nobody consciously
 * notices it. Everybody notices its absence.
 *
 * ## Species
 *
 * Still silhouette-first: antennae mean Andorian, a forehead crest means
 * Klingon, an earring on the right means Bajoran, spots down the temple mean
 * Trill, pointed ears mean Vulcan or Romulan and the robe separates those two.
 * What is new is that the tells are now built onto a head that has a front,
 * so a Cardassian's neck fan sits beside a jaw instead of floating next to a
 * ball.
 */
import * as THREE from "three";
import { surfaced } from "../gfx/surfacing";
import type { Character } from "../crew/characters";

export interface Npc {
  group: THREE.Group;
  character: Character;
  /** Where the captain should stand to be "in conversation". */
  position: THREE.Vector3;
  /** Drives the idle, the head-track, blinking and the talking gesture. */
  update(dt: number, playerPos: THREE.Vector3, talking: boolean): void;
  setNameplate(visible: boolean): void;
  dispose(): void;
}

/** Standing-height fractions. Real proportions, and they are load-bearing. */
const HIP = 0.52;
const WAIST = 0.6;
const SHOULDER = 0.82;
const NECK = 0.86;

export function createNpc(character: Character, at: THREE.Vector3, facing = 0): Npc {
  const look = character.look;
  const H = look.height;
  const group = new THREE.Group();
  group.position.copy(at);
  group.rotation.y = facing;

  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  /* --- materials --------------------------------------------------------- */
  // Skin gets the organic bake at a very tight tile — pores rather than
  // pebbles — and a little specular, because completely matte skin reads as
  // clay. Cloth gets the woven bake. Both are the same triplanar path
  // everything else in the world uses, so a person is lit by the same probe as
  // the pillar behind them.
  const skin = keep(surfaced({ color: look.skin, family: "organic", tile: 0.16, bump: 0.5, roughness: 0.78, macro: 0.05 }));
  const cloth = keep(surfaced({ color: look.cloth, family: "cloth", tile: 0.3, bump: 0.9, macro: 0.08 }));
  const trim = keep(surfaced({ color: look.trim, family: "metal", tile: 0.22, roughness: 0.55, metalness: 0.7, macro: 0.05 }));
  const hair = keep(new THREE.MeshStandardMaterial({ color: look.hair ?? 0x1a1a1a, roughness: 0.62 }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x120e0c, roughness: 0.28 }));
  const wet = keep(new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.08, metalness: 0.0 }));

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  };

  /* --- torso -------------------------------------------------------------- */
  const pelvis = new THREE.Group();
  pelvis.position.y = H * HIP;
  group.add(pelvis);

  // The silhouette. Wide at the shoulder, narrow at the waist, wide at the hip
  // — six points, and they do more work than everything else in the file.
  const torsoProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, -H * 0.02),
    new THREE.Vector2(H * 0.112, -H * 0.01),
    new THREE.Vector2(H * 0.118, H * 0.02),
    new THREE.Vector2(H * 0.098, H * (WAIST - HIP)),
    new THREE.Vector2(H * 0.116, H * 0.19),
    new THREE.Vector2(H * 0.132, H * 0.26),
    new THREE.Vector2(H * 0.126, H * (SHOULDER - HIP)),
    new THREE.Vector2(H * 0.052, H * (NECK - HIP)),
    new THREE.Vector2(0.0, H * (NECK - HIP) + H * 0.004),
  ];
  pelvis.add(mesh(new THREE.LatheGeometry(torsoProfile, 22), cloth));

  // Belt / sash. One band of contrast at the waist, and it is what stops a
  // figure reading as a single-coloured pawn.
  const belt = mesh(
    new THREE.CylinderGeometry(H * 0.104, H * 0.108, H * 0.036, 22),
    trim,
  );
  belt.position.y = H * (WAIST - HIP);
  pelvis.add(belt);

  // A robe for anyone whose culture wears one. It is a lathe skirt from the
  // waist to the ankle and it changes the whole silhouette.
  const robed = look.ridges === "talosian" || look.pointed || look.ridges === "bajoran";
  if (robed) {
    /* Bottom to top.
     *
     * `LatheGeometry` winds its faces from the order of the profile, so a
     * curve written top-down comes out inside-out — and a back-face-culled
     * robe means you see straight through it to the legs, which is exactly
     * what the first version did. Hem first, waist last. */
    const skirt: THREE.Vector2[] = [
      new THREE.Vector2(H * 0.15, -H * 0.485),
      new THREE.Vector2(H * 0.196, -H * 0.47),
      new THREE.Vector2(H * 0.184, -H * 0.38),
      new THREE.Vector2(H * 0.156, -H * 0.2),
      new THREE.Vector2(H * 0.126, H * 0.0),
      new THREE.Vector2(H * 0.104, H * (WAIST - HIP)),
    ];
    const robe = mesh(new THREE.LatheGeometry(skirt, 26), cloth);
    robe.receiveShadow = true;
    pelvis.add(robe);
  }

  /* --- head --------------------------------------------------------------- */
  const neck = new THREE.Group();
  neck.position.y = H * (NECK - HIP);
  pelvis.add(neck);

  const column = mesh(new THREE.CylinderGeometry(H * 0.036, H * 0.044, H * 0.05, 14), skin);
  column.position.y = -H * 0.012;
  neck.add(column);

  const skull = mesh(new THREE.SphereGeometry(H * 0.062, 24, 18), skin);
  skull.scale.set(0.94, 1.06, 1.0);
  skull.position.y = H * 0.05;
  neck.add(skull);

  // A jaw, so the head has a front. A sphere alone reads as a ball whichever
  // way it is turned.
  const jaw = mesh(new THREE.SphereGeometry(H * 0.05, 18, 14), skin);
  jaw.scale.set(0.86, 0.72, 0.94);
  jaw.position.set(0, H * 0.024, H * 0.012);
  neck.add(jaw);

  const brow = mesh(new THREE.BoxGeometry(H * 0.086, H * 0.012, H * 0.02), skin);
  brow.position.set(0, H * 0.062, H * 0.05);
  brow.rotation.x = -0.18;
  neck.add(brow);

  const nose = mesh(new THREE.ConeGeometry(H * 0.014, H * 0.036, 8), skin);
  nose.position.set(0, H * 0.042, H * 0.06);
  nose.rotation.x = Math.PI * 0.52;
  neck.add(nose);

  const mouth = mesh(new THREE.BoxGeometry(H * 0.03, H * 0.005, H * 0.008), dark);
  mouth.position.set(0, H * 0.016, H * 0.056);
  neck.add(mouth);

  /* Eyes. Two dark spheres, each with a catchlight in front of it — the
     catchlight is four triangles and it is the strongest "alive" cue a face
     has. Without it the character is a mannequin at any polycount. */
  const lids: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const socket = mesh(new THREE.SphereGeometry(H * 0.0145, 12, 10), wet);
    socket.position.set(side * H * 0.026, H * 0.049, H * 0.046);
    neck.add(socket);
    const iris = mesh(new THREE.SphereGeometry(H * 0.0085, 10, 8), dark);
    iris.position.set(side * H * 0.026, H * 0.049, H * 0.056);
    neck.add(iris);
    const glint = mesh(new THREE.SphereGeometry(H * 0.0026, 6, 5), wet);
    glint.position.set(side * H * 0.026 + H * 0.004, H * 0.053, H * 0.061);
    neck.add(glint);

    /* The lid is a skin-coloured shell that scales *down over* the eye, not
       the eye scaling to nothing. Squashing the eyeball makes it vanish and
       leaves a hole in the face; a lid closing looks like a blink because it
       is one. */
    const lid = mesh(new THREE.SphereGeometry(H * 0.0165, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), skin);
    lid.position.set(side * H * 0.026, H * 0.0505, H * 0.047);
    lid.rotation.x = 0.25;
    lid.scale.y = 0.02;
    neck.add(lid);
    lids.push(lid);
  }

  if (look.hair !== undefined) {
    /* A cap, not a helmet. thetaLength 0.62π reaches most of the way down the
       front of the skull and swallows the face — from three metres the whole
       head reads as one black ball and every feature underneath it is wasted.
       0.40π stops at the hairline, and the cap is pushed back and up so the
       brow is clear. */
    const cap = mesh(
      new THREE.SphereGeometry(H * 0.066, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.4),
      hair,
    );
    cap.position.set(0, H * 0.052, -H * 0.008);
    cap.scale.set(1.02, 1.16, 1.06);
    cap.rotation.x = -0.16;
    neck.add(cap);
    // A short fall at the back, so the silhouette from behind is not a bald
    // sphere with a beret on it.
    const back = mesh(
      new THREE.SphereGeometry(H * 0.062, 20, 14, 0, Math.PI, Math.PI * 0.18, Math.PI * 0.5),
      hair,
    );
    back.position.set(0, H * 0.046, -H * 0.006);
    back.rotation.y = -Math.PI / 2;
    back.scale.set(1.06, 1.1, 1.06);
    neck.add(back);
  }

  /* --- species tells ------------------------------------------------------ */
  if (look.pointed) {
    for (const side of [-1, 1]) {
      const ear = mesh(new THREE.ConeGeometry(H * 0.016, H * 0.058, 7), skin);
      ear.position.set(side * H * 0.058, H * 0.052, -H * 0.002);
      ear.rotation.z = side * -0.24;
      ear.rotation.x = -0.12;
      ear.scale.z = 0.45;
      neck.add(ear);
    }
  }
  if (look.antennae) {
    for (const side of [-1, 1]) {
      const stalk = mesh(new THREE.CapsuleGeometry(H * 0.007, H * 0.085, 3, 7), skin);
      stalk.position.set(side * H * 0.026, H * 0.112, H * 0.006);
      stalk.rotation.z = side * -0.4;
      stalk.rotation.x = -0.22;
      stalk.name = "antenna";
      neck.add(stalk);
      const tip = mesh(new THREE.SphereGeometry(H * 0.009, 8, 6), skin);
      tip.position.set(side * H * 0.048, H * 0.152, H * 0.02);
      neck.add(tip);
    }
  }

  switch (look.ridges) {
    case "klingon": {
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const r = mesh(
          new THREE.BoxGeometry(H * (0.082 - i * 0.006), H * 0.013, H * 0.017),
          skin,
        );
        r.position.set(0, H * (0.072 - t * 0.006), H * (0.049 - t * 0.086));
        r.rotation.x = -0.5 + t * 0.9;
        neck.add(r);
      }
      break;
    }
    case "cardassian": {
      const spoon = mesh(new THREE.SphereGeometry(H * 0.02, 12, 10), skin);
      spoon.position.set(0, H * 0.072, H * 0.048);
      spoon.scale.set(1.5, 1.7, 0.35);
      neck.add(spoon);
      for (const side of [-1, 1]) {
        const fan = mesh(new THREE.BoxGeometry(H * 0.018, H * 0.052, H * 0.014), skin);
        fan.position.set(side * H * 0.05, H * 0.012, 0);
        fan.rotation.z = side * 0.46;
        neck.add(fan);
      }
      break;
    }
    case "bajoran": {
      for (let i = 0; i < 4; i++) {
        const ridge = mesh(new THREE.BoxGeometry(H * 0.026, H * 0.006, H * 0.012), skin);
        ridge.position.set(0, H * (0.052 - i * 0.009), H * (0.062 - i * 0.002));
        neck.add(ridge);
      }
      // The earring, right ear, always — a family record rather than jewellery,
      // and the most recognisable Bajoran cue there is.
      const hoop = mesh(new THREE.TorusGeometry(H * 0.016, H * 0.0035, 6, 14), trim);
      hoop.position.set(H * 0.06, H * 0.036, 0);
      hoop.rotation.y = Math.PI / 2;
      neck.add(hoop);
      const chain = mesh(new THREE.BoxGeometry(H * 0.004, H * 0.02, H * 0.004), trim);
      chain.position.set(H * 0.06, H * 0.055, 0);
      neck.add(chain);
      break;
    }
    case "ferengi": {
      for (const side of [-1, 1]) {
        const lobe = mesh(new THREE.SphereGeometry(H * 0.05, 14, 12), skin);
        lobe.position.set(side * H * 0.062, H * 0.048, -H * 0.006);
        lobe.scale.set(0.34, 1.2, 0.86);
        neck.add(lobe);
      }
      const crown = mesh(new THREE.SphereGeometry(H * 0.056, 16, 12), skin);
      crown.position.set(0, H * 0.076, H * 0.004);
      crown.scale.set(1.06, 0.62, 1.0);
      neck.add(crown);
      break;
    }
    case "trill": {
      const spot = keep(new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.85 }));
      for (const side of [-1, 1]) {
        for (let i = 0; i < 9; i++) {
          const d = new THREE.Mesh(
            keep(new THREE.SphereGeometry(H * 0.0068, 6, 5)),
            spot,
          );
          d.position.set(
            side * H * (0.055 - i * 0.0012),
            H * (0.072 - i * 0.017),
            H * (0.014 - i * 0.003),
          );
          neck.add(d);
        }
      }
      break;
    }
    case "talosian": {
      // The cranium, and the veins on it. Nothing else about a Talosian
      // matters, and the jaw stays small so the skull dominates.
      skull.scale.set(1.36, 1.5, 1.36);
      jaw.scale.set(0.66, 0.56, 0.74);
      for (let i = 0; i < 7; i++) {
        const v = mesh(new THREE.TorusGeometry(H * 0.074, H * 0.0038, 5, 16, Math.PI * 0.62), skin);
        v.position.y = H * 0.062;
        v.rotation.set(Math.PI / 2, (i / 7) * Math.PI, 0.38);
        neck.add(v);
      }
      break;
    }
    default:
      break;
  }

  /* --- arms --------------------------------------------------------------- */
  interface Limb {
    root: THREE.Group;
    joint: THREE.Group;
  }
  const arms: Limb[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * H * 0.122, H * (SHOULDER - HIP) - H * 0.012, 0);
    pelvis.add(shoulder);

    const deltoid = mesh(new THREE.SphereGeometry(H * 0.042, 14, 10), cloth);
    shoulder.add(deltoid);

    const upper = mesh(new THREE.CapsuleGeometry(H * 0.031, H * 0.135, 4, 12), cloth);
    upper.position.y = -H * 0.085;
    shoulder.add(upper);

    // The elbow. An arm that bends can gesture; a capsule can only point, and
    // half the animation below is impossible without this joint.
    const elbow = new THREE.Group();
    elbow.position.y = -H * 0.163;
    shoulder.add(elbow);

    const fore = mesh(new THREE.CapsuleGeometry(H * 0.026, H * 0.12, 4, 12), cloth);
    fore.position.y = -H * 0.072;
    elbow.add(fore);

    const cuff = mesh(new THREE.CylinderGeometry(H * 0.028, H * 0.026, H * 0.018, 12), trim);
    cuff.position.y = -H * 0.128;
    elbow.add(cuff);

    const hand = mesh(new THREE.SphereGeometry(H * 0.027, 12, 9), skin);
    hand.scale.set(0.78, 1.15, 0.5);
    hand.position.y = -H * 0.152;
    elbow.add(hand);

    shoulder.rotation.z = side * 0.09;
    elbow.rotation.x = -0.2;
    arms.push({ root: shoulder, joint: elbow });
  }

  /* --- legs --------------------------------------------------------------- */
  const legs: Limb[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * H * 0.052, -H * 0.01, 0);
    pelvis.add(hip);

    const thigh = mesh(new THREE.CapsuleGeometry(H * 0.045, H * 0.17, 4, 12), cloth);
    thigh.position.y = -H * 0.105;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -H * 0.235;
    hip.add(knee);

    const shin = mesh(new THREE.CapsuleGeometry(H * 0.035, H * 0.16, 4, 12), cloth);
    shin.position.y = -H * 0.095;
    knee.add(shin);

    const boot = mesh(new THREE.BoxGeometry(H * 0.058, H * 0.042, H * 0.108), trim);
    boot.position.set(0, -H * 0.2, H * 0.022);
    knee.add(boot);

    legs.push({ root: hip, joint: knee });
  }

  /* --- nameplate ---------------------------------------------------------- */
  const plateMat = keep(
    new THREE.SpriteMaterial({ map: keep(nameplate(character)), depthTest: true, transparent: true }),
  );
  const plate = new THREE.Sprite(plateMat);
  plate.position.y = H * 1.16;
  plate.scale.set(2.0, 0.5, 1);
  group.add(plate);

  const antennae = group.getObjectsByProperty?.("name", "antenna") ?? [];

  /* --- animation ---------------------------------------------------------- */
  let t = Math.random() * 20;
  let blinkAt = 2 + Math.random() * 4;
  const toPlayer = new THREE.Vector3();

  return {
    group,
    character,
    position: group.position,
    update(dt, playerPos, talking) {
      t += dt;

      const plateD = Math.max(0.5, group.position.distanceTo(playerPos));
      const pw = clampf(plateD * 0.21, 1.1, 5.2);
      plate.scale.set(pw, pw * 0.25, 1);

      /* Breath and weight shift. Both tiny, and both the difference between a
         person and a statue: the chest rises about six millimetres and the
         hips roll about a degree. */
      pelvis.position.y = H * HIP + Math.sin(t * 1.05) * H * 0.005;
      pelvis.rotation.z = Math.sin(t * 0.34) * 0.02;
      pelvis.rotation.y = Math.sin(t * 0.21) * 0.035;
      legs[0].root.rotation.x = Math.sin(t * 0.34) * 0.028;
      legs[1].root.rotation.x = -Math.sin(t * 0.34) * 0.028;
      legs[0].joint.rotation.x = 0.06 + Math.sin(t * 0.34) * 0.03;
      legs[1].joint.rotation.x = 0.06 - Math.sin(t * 0.34) * 0.03;

      /* Head track, bounded to about fifty degrees. A head that swivels past
         the shoulders to keep looking at you is horror, not attention. */
      toPlayer.copy(playerPos).sub(group.position);
      const want = Math.atan2(toPlayer.x, toPlayer.z);
      const rel = wrap(want - group.rotation.y - pelvis.rotation.y);
      neck.rotation.y = clampf(rel, -0.9, 0.9) * 0.7;
      neck.rotation.x = clampf((playerPos.y - (group.position.y + H * 0.9)) * 0.16, -0.32, 0.3);
      neck.rotation.z = Math.sin(t * 0.47) * 0.02;

      // Turn the body if the captain has walked well round the side — slowly,
      // so it reads as having noticed rather than as a turntable.
      if (Math.abs(rel) > 0.7 && toPlayer.lengthSq() < 420) {
        group.rotation.y += clampf(rel, -1, 1) * dt * 0.85;
      }

      /* Blink: 110 ms, every four to seven seconds. Nobody consciously notices
         it happening and everybody notices it never happening. */
      if (t > blinkAt) {
        const k = (t - blinkAt) / 0.11;
        const shut = k < 1 ? Math.sin(k * Math.PI) : 0;
        for (const l of lids) l.scale.y = 0.02 + shut * 1.15;
        if (k >= 1) blinkAt = t + 4 + Math.random() * 3;
      }

      for (const a of antennae as THREE.Object3D[]) {
        a.rotation.x = -0.22 + Math.sin(t * 1.6 + a.position.x * 40) * 0.13;
      }

      if (talking) {
        /* One arm gestures on an irregular phase, from the shoulder *and* the
           elbow. Two arms moving in sympathy is a puppet; one arm with a
           working elbow is somebody making a point. */
        const g = Math.sin(t * 2.7) * 0.5 + Math.sin(t * 1.31) * 0.3;
        arms[0].root.rotation.x = -0.45 + g * 0.4;
        arms[0].root.rotation.z = 0.09 + Math.sin(t * 1.9) * 0.2;
        arms[0].joint.rotation.x = -0.7 - Math.abs(g) * 0.5;
        arms[1].root.rotation.x = damp(arms[1].root.rotation.x, Math.sin(t * 0.8) * 0.06, 3, dt);
        arms[1].joint.rotation.x = damp(arms[1].joint.rotation.x, -0.3, 3, dt);
        // A talking head nods a little.
        neck.rotation.x += Math.sin(t * 3.3) * 0.03;
      } else {
        arms[0].root.rotation.x = damp(arms[0].root.rotation.x, Math.sin(t * 0.85) * 0.045, 3, dt);
        arms[0].root.rotation.z = damp(arms[0].root.rotation.z, -0.09, 3, dt);
        arms[0].joint.rotation.x = damp(arms[0].joint.rotation.x, -0.22, 3, dt);
        arms[1].root.rotation.x = damp(arms[1].root.rotation.x, -Math.sin(t * 0.85) * 0.045, 3, dt);
        arms[1].joint.rotation.x = damp(arms[1].joint.rotation.x, -0.22, 3, dt);
      }
    },
    setNameplate(visible) {
      plate.visible = visible;
    },
    dispose() {
      for (const o of owned) {
        try {
          o.dispose();
        } catch {
          /* already gone */
        }
      }
      group.parent?.remove(group);
    },
  };
}

const clampf = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
/** Shortest signed angle. Without this the head snaps a full turn at ±π. */
function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function nameplate(c: Character): THREE.CanvasTexture {
  const W = 512;
  const Hh = 128;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = Hh;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, W, Hh);
    // The LCARS bracket. Two bars and a rule, which is the whole grammar.
    ctx.fillStyle = `#${c.accent.toString(16).padStart(6, "0")}`;
    ctx.fillRect(0, 46, 14, 40);
    ctx.fillRect(W - 14, 46, 14, 40);
    ctx.globalAlpha = 0.28;
    ctx.fillRect(18, 62, W - 36, 3);
    ctx.globalAlpha = 1;

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 46px ui-monospace, Menlo, monospace";
    ctx.fillText(c.name.toUpperCase(), W / 2, 52);
    ctx.fillStyle = `#${c.accent.toString(16).padStart(6, "0")}`;
    ctx.font = "26px ui-monospace, Menlo, monospace";
    ctx.fillText(`${c.species.toUpperCase()} · ${c.title.toUpperCase()}`, W / 2, 96);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}
