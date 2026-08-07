/**
 * A person, made of eleven primitives.
 *
 * No rig, no downloaded clip, no skinning. A body is a capsule, a head is a
 * sphere, and the limbs are four more capsules parented at the shoulder and
 * hip — which means the entire animation system is "write six rotations a
 * frame off a phase". That is enough for breathing, weight-shifting, a head
 * that tracks the captain across the plaza and an arm that gestures while the
 * character is speaking, and it costs nothing, which is what lets a Klingon
 * councillor exist on a phone.
 *
 * The species tells do the rest of the work. At the distance these
 * conversations happen — three to eight metres — silhouette and two details is
 * the entire read: antennae mean Andorian, a forehead ridge means Klingon, a
 * spoon means Ferengi, a spot line means Trill, pointed ears mean Vulcan or
 * Romulan and the robe colour separates those two. Nobody is going to inspect
 * the topology.
 *
 * The nameplate is a canvas sprite rather than DOM. It has to be occluded by
 * the pillar the character is standing behind, and an HTML label cannot be.
 */
import * as THREE from "three";
import type { Character } from "../crew/characters";

export interface Npc {
  group: THREE.Group;
  character: Character;
  /** Where the captain should stand to be "in conversation". */
  position: THREE.Vector3;
  /** Drives the idle, the head-track and the talking gesture. */
  update(dt: number, playerPos: THREE.Vector3, talking: boolean): void;
  setNameplate(visible: boolean): void;
  dispose(): void;
}

export function createNpc(character: Character, at: THREE.Vector3, facing = 0): Npc {
  const look = character.look;
  const group = new THREE.Group();
  group.position.copy(at);
  group.rotation.y = facing;

  const H = look.height;
  const skin = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: look.cloth, roughness: 0.92 });
  const trim = new THREE.MeshStandardMaterial({ color: look.trim, roughness: 0.5, metalness: 0.45 });
  const hair = new THREE.MeshStandardMaterial({ color: look.hair ?? 0x1a1a1a, roughness: 1 });
  const owned: THREE.Material[] = [skin, cloth, trim, hair];

  /* --- body --- */
  const hips = new THREE.Group();
  hips.position.y = H * 0.5;
  group.add(hips);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(H * 0.115, H * 0.28, 4, 12), cloth);
  torso.position.y = H * 0.1;
  hips.add(torso);

  // A sash/belt in the trim colour. One band of contrast at the waist is what
  // stops every character reading as a single-coloured pawn.
  const sash = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.125, H * 0.125, H * 0.05, 12), trim);
  sash.position.y = H * 0.0;
  hips.add(sash);

  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(H * 0.055, H * 0.2, 3, 8), cloth);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.y = H * 0.24;
  hips.add(shoulders);

  /* --- head --- */
  const neck = new THREE.Group();
  neck.position.y = H * 0.30;
  hips.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.072, 18, 14), skin);
  head.scale.set(0.92, 1.08, 0.98);
  neck.add(head);

  if (look.hair !== undefined) {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(H * 0.076, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.58),
      hair,
    );
    cap.position.y = H * 0.008;
    neck.add(cap);
  }

  if (look.pointed) {
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(H * 0.017, H * 0.055, 6), skin);
      ear.position.set(side * H * 0.068, H * 0.012, 0);
      ear.rotation.z = side * -0.28;
      neck.add(ear);
    }
  }

  if (look.antennae) {
    for (const side of [-1, 1]) {
      const ant = new THREE.Mesh(new THREE.CapsuleGeometry(H * 0.008, H * 0.09, 3, 6), skin);
      ant.position.set(side * H * 0.028, H * 0.10, H * 0.01);
      ant.rotation.z = side * -0.42;
      ant.rotation.x = -0.25;
      ant.name = "antenna";
      neck.add(ant);
    }
  }

  switch (look.ridges) {
    case "klingon": {
      // A crest of five ridges front to back — the one detail that reads as
      // Klingon from any angle including behind.
      for (let i = 0; i < 5; i++) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(H * 0.09 - i * H * 0.008, H * 0.011, H * 0.016), skin);
        r.position.set(0, H * 0.052 - i * H * 0.004, H * 0.052 - i * H * 0.019);
        r.rotation.x = -0.35 + i * 0.14;
        neck.add(r);
      }
      break;
    }
    case "cardassian": {
      // The neck fan and the spoon.
      const spoon = new THREE.Mesh(new THREE.SphereGeometry(H * 0.022, 10, 8), skin);
      spoon.position.set(0, H * 0.035, H * 0.062);
      spoon.scale.set(1.4, 1.6, 0.4);
      neck.add(spoon);
      for (const side of [-1, 1]) {
        const fan = new THREE.Mesh(new THREE.BoxGeometry(H * 0.02, H * 0.05, H * 0.012), skin);
        fan.position.set(side * H * 0.066, -H * 0.03, 0);
        fan.rotation.z = side * 0.5;
        neck.add(fan);
      }
      break;
    }
    case "bajoran": {
      const nose = new THREE.Mesh(new THREE.BoxGeometry(H * 0.028, H * 0.03, H * 0.014), skin);
      nose.position.set(0, H * 0.02, H * 0.068);
      neck.add(nose);
      // The earring, right ear, always. It is not jewellery, it is a family
      // record, and it is the single most recognisable Bajoran silhouette cue.
      const ear = new THREE.Mesh(new THREE.TorusGeometry(H * 0.018, H * 0.004, 6, 12), trim);
      ear.position.set(H * 0.072, -H * 0.005, 0);
      ear.rotation.y = Math.PI / 2;
      neck.add(ear);
      break;
    }
    case "ferengi": {
      for (const side of [-1, 1]) {
        const lobe = new THREE.Mesh(new THREE.SphereGeometry(H * 0.05, 12, 10), skin);
        lobe.position.set(side * H * 0.072, H * 0.005, -H * 0.005);
        lobe.scale.set(0.35, 1.25, 0.9);
        neck.add(lobe);
      }
      const brow = new THREE.Mesh(new THREE.SphereGeometry(H * 0.05, 12, 10), skin);
      brow.position.set(0, H * 0.048, H * 0.01);
      brow.scale.set(1.1, 0.6, 1.0);
      neck.add(brow);
      break;
    }
    case "trill": {
      // Two lines of spots down the temples and the neck.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 7; i++) {
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(H * 0.0075, 6, 5),
            new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 1 }),
          );
          dot.position.set(side * H * 0.062, H * 0.045 - i * H * 0.018, H * 0.018 - i * H * 0.004);
          neck.add(dot);
          if (i === 0) owned.push(dot.material as THREE.Material);
        }
      }
      break;
    }
    case "talosian": {
      // The cranium, and the veins on it. Nothing else about a Talosian
      // matters.
      head.scale.set(1.35, 1.5, 1.35);
      head.position.y = H * 0.02;
      for (let i = 0; i < 6; i++) {
        const v = new THREE.Mesh(new THREE.TorusGeometry(H * 0.07, H * 0.004, 5, 14, Math.PI * 0.7), skin);
        v.position.y = H * 0.03;
        v.rotation.set(Math.PI / 2, (i / 6) * Math.PI, 0.4);
        neck.add(v);
      }
      break;
    }
    default:
      break;
  }

  /* --- limbs --- */
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * H * 0.125, H * 0.245, 0);
    hips.add(shoulder);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(H * 0.032, H * 0.24, 3, 8), cloth);
    arm.position.y = -H * 0.145;
    shoulder.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(H * 0.032, 8, 6), skin);
    hand.position.y = -H * 0.28;
    shoulder.add(hand);
    shoulder.rotation.z = side * 0.12;
    arms.push(shoulder);
  }

  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * H * 0.055, -H * 0.08, 0);
    hips.add(hip);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(H * 0.042, H * 0.30, 3, 8), cloth);
    leg.position.y = -H * 0.19;
    hip.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(H * 0.06, H * 0.04, H * 0.11), trim);
    boot.position.set(0, -H * 0.375, H * 0.02);
    hip.add(boot);
    legs.push(hip);
  }

  /* --- nameplate --- */
  const plate = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: nameplate(character),
      depthTest: true,
      transparent: true,
    }),
  );
  plate.position.y = H * 1.18;
  /* Scaled with distance every frame, not fixed.
   *
   * A sprite's apparent size is its world scale over its distance, so any
   * fixed value is legible at exactly one range: 2.6 m read well at the five
   * metres a conversation happens at and was an unreadable smear at the
   * twenty-five where you first spot somebody — and 3.6 fixed that end and
   * then covered half the screen when you walked up to them. Scaling
   * proportionally holds it at one size on screen wherever you stand. */
  plate.scale.set(2.0, 0.5, 1);
  group.add(plate);

  const antennae = group.getObjectsByProperty?.("name", "antenna") ?? [];

  let t = Math.random() * 10;
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

      // Breathing and a slow weight shift. Both tiny; both the difference
      // between a person and a statue.
      hips.position.y = H * 0.5 + Math.sin(t * 1.1) * H * 0.006;
      hips.rotation.z = Math.sin(t * 0.37) * 0.022;
      legs[0].rotation.x = Math.sin(t * 0.37) * 0.03;
      legs[1].rotation.x = -Math.sin(t * 0.37) * 0.03;

      // Head-track, but only within about 100° — a head that swivels past the
      // shoulders to keep looking at you is horror, not attention.
      toPlayer.copy(playerPos).sub(group.position);
      const want = Math.atan2(toPlayer.x, toPlayer.z);
      const rel = wrap(want - group.rotation.y);
      neck.rotation.y = clampf(rel, -0.9, 0.9) * 0.75;
      neck.rotation.x = clampf((playerPos.y - (group.position.y + H * 0.85)) * 0.12, -0.3, 0.3);

      // Turn the body too, but slowly, and only if the captain is well round
      // the side. This is what makes walking around someone feel like they
      // noticed rather than like they are on a turntable.
      if (Math.abs(rel) > 0.75 && toPlayer.lengthSq() < 400) {
        group.rotation.y += clampf(rel, -1, 1) * dt * 0.9;
      }

      for (const a of antennae as THREE.Object3D[]) {
        a.rotation.x = -0.25 + Math.sin(t * 1.7 + a.position.x * 40) * 0.12;
      }

      if (talking) {
        // One arm gestures on a fast irregular phase. Two arms gesturing in
        // sympathy looks like a puppet; one looks like someone making a point.
        arms[0].rotation.x = -0.5 + Math.sin(t * 3.4) * 0.35;
        arms[0].rotation.z = 0.12 + Math.sin(t * 2.1) * 0.18;
        arms[1].rotation.x = Math.sin(t * 1.1) * 0.08;
      } else {
        arms[0].rotation.x = damp(arms[0].rotation.x, Math.sin(t * 0.9) * 0.05, 3, dt);
        arms[0].rotation.z = damp(arms[0].rotation.z, -0.12, 3, dt);
        arms[1].rotation.x = damp(arms[1].rotation.x, -Math.sin(t * 0.9) * 0.05, 3, dt);
      }
    },
    setNameplate(visible) {
      plate.visible = visible;
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      owned.forEach((m) => m.dispose());
      const pm = plate.material as THREE.SpriteMaterial;
      pm.map?.dispose();
      pm.dispose();
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
