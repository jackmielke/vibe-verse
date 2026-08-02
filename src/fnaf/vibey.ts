/**
 * VIBEY — the fifth one on the floor, and the only one who is pleased to see
 * you.
 *
 * He is not an animatronic. He is the vibeverse's own mascot, wandered into the
 * pizzeria after hours because there are people in it.
 *
 * He is built here rather than loaded, and that was a decision rather than
 * laziness. The obvious move was `/models/vibey.glb`, the file Vibe City and
 * the village map already share — but that model is a *humanoid* robot with
 * arms, legs, shoulders and feet, and the Vibey in Jack's reference photo is a
 * different design entirely: a rounded white head with two big goggle lenses on
 * a bridge, two coiled antennas, and an egg body wearing a lightning-bolt
 * smiley, sat on a dark ring. The photo is the brief, so the photo is what is
 * built. It also costs nothing to download, which is not nothing on a phone.
 *
 * He does not walk, because he has no legs. He *scoots*: a little disc under
 * him spins up, he hops, and he lands with a squash. Everything about the way
 * he moves is meant to read as delighted, because when he catches you the game
 * does not end in a scream — see `engine.ts`'s party ending.
 */
import * as THREE from "three";
import type { Animatronic } from "./animatronics";

export interface VibeyParts {
  /** Moved by the engine; everything else hangs off it. */
  root: THREE.Group;
  /** Bobs, squashes and spins. The model or the fallback goes in here. */
  body: THREE.Group;
  /** What the camera looks at, and what leans when he is curious. */
  head: THREE.Group;
  /** The disc he scoots on; spins with travel. */
  disc: THREE.Mesh;
  /** Lens material, so he can light up in a dark hall like the others do. */
  eyeMats: THREE.MeshStandardMaterial[];
  /** Antenna tips, waved about when he is excited. */
  antennas: THREE.Object3D[];
  dispose: () => void;
}

function mat(color: number, rough = 0.55, metal = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/**
 * The lightning-bolt smiley on his belly, drawn rather than imported — it is
 * two bolts and an arc, and a canvas is smaller than a PNG.
 */
function faceDecal(): THREE.CanvasTexture {
  const el = document.createElement("canvas");
  el.width = el.height = 256;
  const c = el.getContext("2d")!;
  c.clearRect(0, 0, 256, 256);
  c.strokeStyle = "#14141a";
  c.fillStyle = "#14141a";
  c.lineCap = "round";
  c.lineJoin = "round";

  const bolt = (cx: number, cy: number, s: number) => {
    c.beginPath();
    c.moveTo(cx + 6 * s, cy - 20 * s);
    c.lineTo(cx - 8 * s, cy + 2 * s);
    c.lineTo(cx + 1 * s, cy + 2 * s);
    c.lineTo(cx - 5 * s, cy + 20 * s);
    c.lineTo(cx + 9 * s, cy - 3 * s);
    c.lineTo(cx + 0 * s, cy - 3 * s);
    c.closePath();
    c.fill();
  };
  bolt(96, 108, 1.5);
  bolt(160, 108, 1.5);

  // The smile, with a little upward flick on the right.
  c.lineWidth = 13;
  c.beginPath();
  c.arc(128, 130, 54, 0.16 * Math.PI, 0.84 * Math.PI);
  c.stroke();
  c.beginPath();
  c.moveTo(170, 168);
  c.lineTo(183, 140);
  c.stroke();
  c.beginPath();
  c.moveTo(183, 140);
  c.lineTo(174, 146);
  c.lineTo(186, 150);
  c.closePath();
  c.fill();

  const t = new THREE.CanvasTexture(el);
  t.anisotropy = 4;
  return t;
}

/** One antenna: a coiled spring at the base, then a long thin whip. */
function antenna(side: number): THREE.Group {
  const g = new THREE.Group();
  const dark = mat(0x2a2a30, 0.5, 0.4);
  for (let i = 0; i < 5; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.009, 6, 12), dark);
    coil.rotation.x = Math.PI / 2;
    coil.position.y = i * 0.022;
    g.add(coil);
  }
  const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0035, 0.5, 6), dark);
  whip.position.y = 0.36;
  g.add(whip);
  // Negated: rotating +Y about +Z sends the tip toward -X, so the *left*
  // antenna needs a positive angle to splay outward. Signed the other way they
  // lean inward and cross over the top of his head like a pair of scissors.
  g.rotation.z = -side * 0.42;
  return g;
}

/**
 * Vibey, matched to the reference photo: a rounded white head with two big
 * black lenses joined by a bridge, two coiled antennas, and a white egg body
 * wearing a lightning smiley, sitting on a dark ring.
 */
function buildVibey(parts: VibeyParts) {
  const shell = mat(0xf4f5f7, 0.42, 0.06);
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0a0a0f,
    roughness: 0.12,
    metalness: 0.5,
  });
  const trim = mat(0x1a1a20, 0.5, 0.3);

  // Body: an egg, flat where it meets the floor.
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.34, 26, 20), shell);
  belly.scale.set(1, 0.97, 0.94);
  belly.position.y = 0.35;
  belly.castShadow = true;
  parts.body.add(belly);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.26, 0.11, 26), shell);
  skirt.position.y = 0.08;
  parts.body.add(skirt);

  const smile = new THREE.Mesh(
    new THREE.PlaneGeometry(0.46, 0.46),
    new THREE.MeshStandardMaterial({ map: faceDecal(), transparent: true, roughness: 0.6 }),
  );
  smile.position.set(0, 0.34, 0.325);
  parts.body.add(smile);

  // Head: a rounded pillow, wider than it is tall.
  parts.head.position.y = 0.75;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 28, 22), shell);
  // Wider than tall and slightly boxy — in the reference his head is a rounded
  // pillow, not a ball, and that read is most of what makes him look friendly.
  skull.scale.set(1.24, 0.86, 0.94);
  skull.castShadow = true;
  parts.head.add(skull);

  // The goggles: two big lenses on a bridge, which is the whole face.
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.06, 26), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(s * 0.155, 0.01, 0.225);
    parts.head.add(ring);

    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0f,
      roughness: 0.1,
      metalness: 0.4,
      // Barely lit. They are glass in the photo, and a robot with two
      // headlamps for eyes is a different, worse character.
      emissive: new THREE.Color(0x39d6ff),
      emissiveIntensity: 0.14,
    });
    parts.eyeMats.push(lensMat);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.108, 22, 18), lensMat);
    lens.scale.set(1, 1, 0.55);
    lens.position.set(s * 0.155, 0.01, 0.255);
    parts.head.add(lens);

    // A catchlight, so the lenses read as glass and not as holes.
    const glint = new THREE.Mesh(
      new THREE.SphereGeometry(0.026, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 }),
    );
    glint.scale.set(1, 0.7, 0.4);
    glint.position.set(s * 0.155 - 0.04, 0.048, 0.315);
    parts.head.add(glint);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.03, 0.055), trim);
  bridge.position.set(0, 0.01, 0.258);
  parts.head.add(bridge);
  void glass;

  for (const s of [-1, 1]) {
    const a = antenna(s);
    a.position.set(s * 0.17, 0.21, -0.05);
    parts.head.add(a);
    parts.antennas.push(a);
  }
}

export function makeVibeyParts(): VibeyParts {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const head = new THREE.Group();
  root.add(body);
  body.add(head);

  // The disc he scoots on. Not decoration: it spins with travel, which is what
  // sells "skittering" rather than "sliding".
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.27, 0.29, 0.055, 26),
    mat(0x17171d, 0.45, 0.35),
  );
  disc.position.y = 0.028;
  root.add(disc);

  const parts: VibeyParts = {
    root,
    body,
    head,
    disc,
    eyeMats: [],
    antennas: [],
    dispose: () => undefined,
  };

  buildVibey(parts);

  parts.dispose = () => undefined;

  return parts;
}

/* ------------------------------------------------------------------- rig */

/**
 * Vibey as something the director can move around like anybody else.
 *
 * He satisfies the same `Animatronic` contract as the four animatronics, which
 * is what lets the existing AI, pathing and door logic drive him with no
 * special cases — but the limbs are stubs, because he has none, and `update`
 * runs a hop instead of a gait.
 */
export function makeVibey(): Animatronic {
  const parts = makeVibeyParts();
  const { root, body, head, disc } = parts;
  const queue: THREE.Vector3[] = [];
  const stub = () => new THREE.Object3D();

  const a: Animatronic = {
    kind: "vibey",
    root,
    head,
    jaw: new THREE.Group(),
    eyeMats: parts.eyeMats,
    limbs: { la: stub(), ra: stub(), ll: stub(), rl: stub(), le: stub(), re: stub(), lk: stub(), rk: stub() },
    speed: 2.1,
    groundY: 0,
    runBlend: 0,
    target: null,
    targetYaw: 0,
    phase: 0,
    scare: 0,
    walkTo(x, z, yaw, speed, y = 0) {
      queue.length = 0;
      a.target = new THREE.Vector3(x, 0, z);
      a.targetYaw = yaw;
      a.groundY = y;
      if (speed) a.speed = speed;
    },
    walkPath(points, yaw, speed, y = 0) {
      queue.length = 0;
      if (!points.length) return;
      for (const [x, z] of points.slice(1)) queue.push(new THREE.Vector3(x, 0, z));
      a.target = new THREE.Vector3(points[0][0], 0, points[0][1]);
      a.targetYaw = yaw;
      a.groundY = y;
      if (speed) a.speed = speed;
    },
    teleport(x, z, yaw, y = 0) {
      queue.length = 0;
      root.position.set(x, y, z);
      root.rotation.y = yaw;
      a.target = null;
      a.targetYaw = yaw;
      a.groundY = y;
      a.phase = 0;
      a.runBlend = 0;
    },
    moving: () => a.target !== null,
    update(dt, t) {
      let travelling = false;
      if (a.target) {
        const d = a.target.clone().sub(root.position);
        d.y = 0;
        const dist = d.length();
        if (dist < 0.09) {
          a.target = queue.length ? queue.shift()! : null;
          if (!a.target) a.phase = 0;
        } else {
          travelling = true;
          const step = Math.min(dist, a.speed * dt);
          root.position.addScaledVector(d.normalize(), step);
          const want = Math.atan2(d.x, d.z);
          let diff = want - root.rotation.y;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          root.rotation.y += diff * Math.min(1, dt * 7);
          // Hops, not strides. Fast enough that he reads as scurrying.
          a.phase += dt * 7.5;
          disc.rotation.x -= dt * a.speed * 4.2;
        }
      } else {
        let diff = a.targetYaw - root.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        root.rotation.y += diff * Math.min(1, dt * 5);
      }
      a.runBlend += ((travelling ? 1 : 0) - a.runBlend) * Math.min(1, dt * 7);
      const run = a.runBlend;

      if (a.scare > 0) {
        /*
         * The party. He does not lunge — he bounces on the spot, spins, throws
         * his antennas about and lights up. The whole point of the character is
         * that being caught by Vibey is nice.
         */
        const s = a.scare;
        const bounce = Math.abs(Math.sin(t * 7.5));
        root.position.y = a.groundY + bounce * 0.3 * s;
        // A wiggle, not a spin. Spinning meant half the celebration was the
        // back of his head, and the point of this ending is his face.
        body.rotation.y = Math.sin(t * 6.5) * 0.55 * s;
        body.scale.set(1 + bounce * 0.1 * s, 1 - bounce * 0.13 * s, 1 + bounce * 0.1 * s);
        head.rotation.z = Math.sin(t * 9) * 0.28 * s;
        head.rotation.x = -0.16 * s;
        parts.antennas.forEach((ant, i) => {
          ant.rotation.z = (i ? -1 : 1) * (0.42 + Math.sin(t * 12 + i) * 0.45 * s);
          ant.rotation.x = Math.sin(t * 10 + i * 2) * 0.3 * s;
        });
        parts.eyeMats.forEach((m) => (m.emissiveIntensity = 0.2 + s * 1.6));
        return;
      }

      // Hop: up on the beat, squashed on the landing.
      const hop = Math.abs(Math.sin(a.phase));
      root.position.y = a.groundY + hop * 0.13 * run;
      const squash = 1 - Math.cos(a.phase * 2) * 0.06 * run;
      body.scale.set(2 - squash, squash, 2 - squash);
      // A lean into the direction of travel, and a happy sway when parked.
      body.rotation.x = run * 0.16;
      body.rotation.z = Math.sin(a.phase * 0.5) * 0.06 * run + Math.sin(t * 0.8) * 0.02;
      body.rotation.y = 0;
      head.rotation.y = Math.sin(t * 0.6) * 0.14 * (1 - run);
      head.rotation.z = Math.sin(t * 1.1) * 0.05;
      head.rotation.x = Math.sin(t * 0.9) * 0.04 - run * 0.1;
      head.scale.setScalar(1);
      parts.antennas.forEach((ant, i) => {
        // Antennas trail behind a hop and wobble at rest. They are the whole
        // performance from across a dark room.
        ant.rotation.z =
          (i ? -1 : 1) * 0.42 + Math.sin(t * 2.2 + i * 1.7) * 0.1 + run * hop * 0.25 * (i ? -1 : 1);
        ant.rotation.x = -run * 0.35 + Math.sin(t * 1.7 + i) * 0.06;
      });
      parts.eyeMats.forEach((m) => (m.emissiveIntensity = 0.14 + Math.sin(t * 1.4) * 0.04));
    },
  };

  a.teleport(0, 0, 0);
  return a;
}
