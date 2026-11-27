/**
 * The quest givers: Granny Mabel, Vinnie the bookie and Sal the fisherman,
 * plus the three runaway pets. All built in code out of a handful of
 * primitives, so they appear on the first frame with nothing to fetch, and
 * each one gets a little idle loop (`animate`) so a still frame does not read
 * as a mannequin.
 *
 * The "!" over a quest giver's head is the one convention borrowed wholesale
 * from every game ever: gold means "talk to me", it hides while the quest is
 * running and comes back when there is something new to say.
 */
import * as THREE from "three";

export interface Npc {
  group: THREE.Group;
  /** The floating "!" marker. */
  marker: THREE.Object3D;
  animate(t: number, dt: number): void;
  dispose(): void;
}

export interface Pet {
  group: THREE.Group;
  /** A walking cycle, 0 when standing. */
  animate(t: number, speed: number): void;
  dispose(): void;
}

type Mats = THREE.Material[];

function mat(color: string | number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}, keep?: Mats) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts });
  keep?.push(m);
  return m;
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}

function disposeTree(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mt = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mt)) mt.forEach((x) => x.dispose());
      else mt?.dispose();
    }
  });
}

/** The gold "!" that floats over a quest giver. */
export function questMarker(color = 0xffc531): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), m);
  bar.position.y = 0.38;
  const dot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), m);
  g.add(bar, dot);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
  );
  halo.position.y = 0.25;
  g.add(halo);
  return g;
}

interface PersonSpec {
  skin: string;
  shirt: string;
  legs: string;
  hair: string;
  height?: number;
  build?: number;
}

/** A body: legs, torso, arms, head. Returns the parts so a builder can dress it. */
function person(spec: PersonSpec) {
  const g = new THREE.Group();
  const h = spec.height ?? 1.7;
  const b = spec.build ?? 1;
  const s = h / 1.7;
  const skin = mat(spec.skin);
  const shirt = mat(spec.shirt);
  const legs = mat(spec.legs);
  const hairM = mat(spec.hair, { roughness: 0.95 });
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  for (const [leg, x] of [[legL, -0.1], [legR, 0.1]] as const) {
    leg.position.set(x * b, 0.82 * s, 0);
    leg.add(mesh(new THREE.CapsuleGeometry(0.075 * b, 0.62 * s, 3, 8), legs, 0, -0.4 * s, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.13 * b, 0.08, 0.24), mat("#2a2420"), 0, -0.8 * s, 0.04));
    g.add(leg);
  }
  const torso = mesh(new THREE.CapsuleGeometry(0.2 * b, 0.42 * s, 4, 10), shirt, 0, 1.1 * s, 0);
  torso.scale.set(1, 1, 0.72);
  g.add(torso);
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  for (const [arm, x] of [[armL, -1], [armR, 1]] as const) {
    arm.position.set(x * 0.27 * b, 1.38 * s, 0);
    arm.add(mesh(new THREE.CapsuleGeometry(0.06 * b, 0.5 * s, 3, 8), shirt, 0, -0.27 * s, 0));
    arm.add(mesh(new THREE.SphereGeometry(0.065, 10, 8), skin, 0, -0.58 * s, 0));
    g.add(arm);
  }
  const head = new THREE.Group();
  head.position.y = 1.62 * s;
  head.add(mesh(new THREE.SphereGeometry(0.15, 18, 14), skin, 0, 0, 0));
  // Eyes, so the face has a front.
  const eyeM = mat("#1a1a1a", { roughness: 0.3 });
  head.add(mesh(new THREE.SphereGeometry(0.022, 8, 6), eyeM, -0.055, 0.02, 0.135));
  head.add(mesh(new THREE.SphereGeometry(0.022, 8, 6), eyeM, 0.055, 0.02, 0.135));
  head.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), skin, 0, -0.02, 0.15));
  g.add(head);
  return { g, head, armL, armR, legL, legR, torso, skin, shirt, hairM, s };
}

function withMarker(g: THREE.Group, y: number) {
  const marker = questMarker();
  marker.position.y = y;
  g.add(marker);
  return marker;
}

/** Granny Mabel: grey bun, lilac cardigan, pearls, a cane and a worried look. */
export function buildGranny(): Npc {
  const p = person({ skin: "#f1c9a8", shirt: "#b89be0", legs: "#4b3f5c", hair: "#d9d6de", height: 1.55, build: 1.05 });
  const { g, head, armL, armR, s } = p;
  // Skirt.
  const skirt = mesh(new THREE.CylinderGeometry(0.2, 0.32, 0.55, 14), mat("#5d4b78"), 0, 0.68 * s, 0);
  g.add(skirt);
  // Bun and curls.
  head.add(mesh(new THREE.SphereGeometry(0.16, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), p.hairM, 0, 0.02, -0.01));
  head.add(mesh(new THREE.SphereGeometry(0.08, 12, 10), p.hairM, 0, 0.13, -0.1));
  // Glasses.
  const rim = mat("#c9a14a", { metalness: 0.7, roughness: 0.3 });
  for (const x of [-0.055, 0.055]) {
    const r = mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 16), rim, x, 0.02, 0.148);
    head.add(r);
  }
  // Pearls.
  const pearl = mat("#fffaf0", { roughness: 0.2 });
  for (let i = 0; i < 9; i++) {
    const a = -1.1 + (i / 8) * 2.2;
    g.add(mesh(new THREE.SphereGeometry(0.018, 6, 5), pearl, Math.sin(a) * 0.15, 1.36 * s - Math.cos(a) * 0.03, Math.cos(a) * 0.12));
  }
  // The cane in her right hand.
  const cane = new THREE.Group();
  cane.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.85, 6), mat("#5b3a1e"), 0, -0.42, 0));
  const hook = mesh(new THREE.TorusGeometry(0.05, 0.018, 6, 12, Math.PI), mat("#5b3a1e"), 0.05, 0.0, 0);
  cane.add(hook);
  cane.position.set(0, -0.55 * s, 0.05);
  armR.add(cane);
  armR.rotation.x = -0.25;
  // A handbag on the left arm.
  armL.add(mesh(new THREE.BoxGeometry(0.2, 0.16, 0.08), mat("#a13d5c"), 0.02, -0.5 * s, 0.08));
  const marker = withMarker(g, 2.05);
  return {
    group: g,
    marker,
    animate(t) {
      // Wringing her hands and looking about.
      head.rotation.y = Math.sin(t * 0.8) * 0.5;
      armL.rotation.x = -0.4 + Math.sin(t * 3) * 0.08;
      marker.position.y = 2.05 + Math.sin(t * 2.4) * 0.08;
      marker.rotation.y = t * 1.5;
    },
    dispose: () => disposeTree(g),
  };
}

/** Vinnie Two-Tires: sunglasses, gold chain, racing jacket, a clipboard of bets. */
export function buildBookie(): Npc {
  const p = person({ skin: "#c98f65", shirt: "#141414", legs: "#262a33", hair: "#1b1410", height: 1.78, build: 1.12 });
  const { g, head, armL, armR, torso, s } = p;
  // Racing stripes down the jacket.
  const stripe = mat("#ff2d55", { emissive: "#ff2d55", emissiveIntensity: 0.25 });
  for (const x of [-0.08, 0.08]) g.add(mesh(new THREE.BoxGeometry(0.035, 0.62 * s, 0.02), stripe, x, 1.1 * s, 0.155));
  void torso;
  // Slicked hair and shades.
  head.add(mesh(new THREE.SphereGeometry(0.155, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), p.hairM, 0, 0.02, -0.01));
  head.add(mesh(new THREE.BoxGeometry(0.22, 0.05, 0.04), mat("#050505", { roughness: 0.1, metalness: 0.6 }), 0, 0.025, 0.14));
  // Gold chain.
  const gold = mat("#ffcf40", { metalness: 0.9, roughness: 0.25 });
  const chain = mesh(new THREE.TorusGeometry(0.13, 0.014, 6, 24, Math.PI), gold, 0, 1.36 * s, 0.07);
  chain.rotation.set(Math.PI / 2 + 0.5, 0, Math.PI);
  g.add(chain);
  // Clipboard in the left hand, a wad of cash in the right.
  armL.add(mesh(new THREE.BoxGeometry(0.22, 0.3, 0.02), mat("#c9a26b"), 0.02, -0.55 * s, 0.1));
  armL.rotation.x = -0.6;
  armR.add(mesh(new THREE.BoxGeometry(0.1, 0.03, 0.06), mat("#3fae5a"), 0, -0.6 * s, 0.04));
  const marker = withMarker(g, 2.25);
  return {
    group: g,
    marker,
    animate(t) {
      // Flicking through the cash.
      armR.rotation.x = -0.5 + Math.sin(t * 5) * 0.25;
      head.rotation.y = Math.sin(t * 0.5) * 0.35;
      marker.position.y = 2.25 + Math.sin(t * 2.4) * 0.08;
      marker.rotation.y = t * 1.5;
    },
    dispose: () => disposeTree(g),
  };
}

/** Sal: yellow sou'wester and slicker, white beard, sat on a crate with a rod. */
export function buildFisher(): Npc {
  const p = person({ skin: "#e0b08a", shirt: "#ffc928", legs: "#2f3b4f", hair: "#f2f2f2", height: 1.72, build: 1.1 });
  const { g, head, armL, armR, legL, legR, s } = p;
  // Sitting: thighs forward, body lowered onto a crate.
  legL.rotation.x = legR.rotation.x = -Math.PI / 2.2;
  g.children.forEach((c) => (c.position.y -= 0.42 * s));
  const crate = mesh(new THREE.BoxGeometry(0.55, 0.42, 0.45), mat("#8a5a32"), 0, 0.21, -0.05);
  g.add(crate);
  // Beard.
  head.add(mesh(new THREE.SphereGeometry(0.12, 12, 10, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55), p.hairM, 0, -0.05, 0.05));
  // Sou'wester.
  const hatM = mat("#ffc928", { roughness: 0.5 });
  head.add(mesh(new THREE.SphereGeometry(0.165, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hatM, 0, 0.03, 0));
  const brim = mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.025, 20), hatM, 0, 0.03, -0.02);
  brim.rotation.x = 0.15;
  head.add(brim);
  // His own rod, held out over the water.
  const rod = new THREE.Group();
  const rodM = mat("#3b2b1d");
  const pole = mesh(new THREE.CylinderGeometry(0.008, 0.02, 2.4, 6), rodM, 0, 1.2, 0);
  rod.add(pole);
  rod.rotation.x = 1.0;
  rod.position.set(0, -0.55 * s, 0.06);
  armR.add(rod);
  armR.rotation.x = -0.9;
  armL.rotation.x = -0.9;
  const marker = withMarker(g, 1.75);
  return {
    group: g,
    marker,
    animate(t) {
      rod.rotation.z = Math.sin(t * 0.9) * 0.06;
      head.rotation.x = Math.sin(t * 0.3) * 0.06 + 0.05;
      marker.position.y = 1.75 + Math.sin(t * 2.4) * 0.08;
      marker.rotation.y = t * 1.5;
    },
    dispose: () => disposeTree(g),
  };
}

/** Gail the gecko-shoe vendor: a climber in a chalk-dusted hoodie, harness, and helmet. */
export function buildClimber(): Npc {
  const p = person({ skin: "#8d5a3b", shirt: "#26c6a2", legs: "#353a46", hair: "#2a1a10", height: 1.68 });
  const { g, head, armL, armR } = p;
  head.add(mesh(new THREE.SphereGeometry(0.17, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), mat("#ff7a1a", { roughness: 0.4 }), 0, 0.03, 0));
  // Harness loop and a coil of rope over the shoulder.
  const rope = mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 20), mat("#e8423f"), 0, 1.25, 0);
  rope.rotation.set(0.3, 0, 0.8);
  g.add(rope);
  g.add(mesh(new THREE.TorusGeometry(0.21, 0.025, 6, 20), mat("#222"), 0, 0.86, 0)).rotation.x = Math.PI / 2;
  const marker = withMarker(g, 2.1);
  return {
    group: g,
    marker,
    animate(t) {
      // Stretching, arm over the head.
      armR.rotation.z = Math.PI * 0.85 + Math.sin(t * 1.2) * 0.1;
      armL.rotation.x = Math.sin(t * 1.2) * 0.2;
      marker.position.y = 2.1 + Math.sin(t * 2.4) * 0.08;
      marker.rotation.y = t * 1.5;
    },
    dispose: () => disposeTree(g),
  };
}

// ---- Pets -------------------------------------------------------------------

export type PetKind = "cat" | "pug" | "bunny";

/** A four-legged pet with a waggable tail. Faces +z. */
export function buildPet(kind: PetKind): Pet {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const fur = kind === "cat" ? "#f2973b" : kind === "pug" ? "#d8b88a" : "#f4f1ea";
  const dark = kind === "cat" ? "#b8611d" : kind === "pug" ? "#2b231d" : "#e7b9c4";
  const furM = mat(fur, { roughness: 0.95 });
  const darkM = mat(dark, { roughness: 0.95 });
  const eyeM = mat("#111", { roughness: 0.2 });
  const len = kind === "bunny" ? 0.32 : 0.46;
  const torso = mesh(new THREE.CapsuleGeometry(kind === "pug" ? 0.15 : 0.12, len, 4, 10), furM, 0, 0.3, 0);
  torso.rotation.x = Math.PI / 2;
  body.add(torso);
  if (kind === "cat") {
    for (let i = 0; i < 3; i++) body.add(mesh(new THREE.BoxGeometry(0.25, 0.02, 0.05), darkM, 0, 0.42, -0.12 + i * 0.12));
  }
  const legs: THREE.Object3D[] = [];
  const legH = kind === "bunny" ? 0.16 : 0.24;
  for (const [x, z] of [[-0.08, 0.17], [0.08, 0.17], [-0.08, -0.17], [0.08, -0.17]]) {
    const leg = new THREE.Group();
    leg.position.set(x, 0.26, z * (len / 0.46));
    leg.add(mesh(new THREE.CapsuleGeometry(0.035, legH - 0.06, 3, 6), furM, 0, -legH / 2, 0));
    body.add(leg);
    legs.push(leg);
  }
  const head = new THREE.Group();
  head.position.set(0, 0.45, len / 2 + 0.12);
  body.add(head);
  head.add(mesh(new THREE.SphereGeometry(kind === "pug" ? 0.14 : 0.12, 16, 12), furM, 0, 0, 0));
  head.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), eyeM, -0.05, 0.03, 0.1));
  head.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), eyeM, 0.05, 0.03, 0.1));
  if (kind === "cat") {
    for (const x of [-0.06, 0.06]) {
      const ear = mesh(new THREE.ConeGeometry(0.045, 0.1, 4), furM, x, 0.12, 0);
      head.add(ear);
    }
    head.add(mesh(new THREE.SphereGeometry(0.018, 6, 5), mat("#e57a8a"), 0, -0.01, 0.12));
  } else if (kind === "pug") {
    head.add(mesh(new THREE.SphereGeometry(0.075, 12, 10), darkM, 0, -0.03, 0.09));
    for (const x of [-0.1, 0.1]) {
      const ear = mesh(new THREE.SphereGeometry(0.05, 8, 6), darkM, x, 0.08, 0);
      ear.scale.set(1, 0.5, 1);
      head.add(ear);
    }
    // A red collar with a gold tag.
    const collar = mesh(new THREE.TorusGeometry(0.11, 0.02, 6, 16), mat("#d62828"), 0, 0.4, len / 2 + 0.03);
    body.add(collar);
  } else {
    for (const x of [-0.04, 0.04]) {
      const ear = mesh(new THREE.CapsuleGeometry(0.03, 0.18, 3, 8), furM, x, 0.2, -0.02);
      ear.rotation.z = x * 2;
      head.add(ear);
      head.add(mesh(new THREE.CapsuleGeometry(0.015, 0.14, 3, 6), darkM, x, 0.2, 0.005)).rotation.z = x * 2;
    }
    head.add(mesh(new THREE.SphereGeometry(0.016, 6, 5), mat("#e57a8a"), 0, -0.01, 0.115));
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.36, -len / 2 - 0.08);
  body.add(tail);
  if (kind === "bunny") tail.add(mesh(new THREE.SphereGeometry(0.07, 10, 8), mat("#ffffff"), 0, 0, -0.02));
  else if (kind === "pug") tail.add(mesh(new THREE.TorusGeometry(0.05, 0.022, 6, 12), furM, 0, 0.04, 0));
  else {
    const t = mesh(new THREE.CapsuleGeometry(0.025, 0.3, 3, 6), furM, 0, 0.15, -0.04);
    t.rotation.x = -0.4;
    tail.add(t);
  }
  return {
    group: g,
    animate(t, speed) {
      const k = Math.min(1, speed / 2);
      const f = kind === "bunny" ? 9 : 12;
      legs.forEach((l, i) => (l.rotation.x = Math.sin(t * f + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI / 2 : 0)) * 0.7 * k));
      body.position.y = kind === "bunny" ? Math.abs(Math.sin(t * f * 0.5)) * 0.18 * k : Math.abs(Math.sin(t * f)) * 0.02 * k;
      tail.rotation.y = Math.sin(t * (speed > 0.1 ? 14 : 3)) * 0.5;
      head.rotation.y = speed > 0.1 ? 0 : Math.sin(t * 0.7) * 0.6;
    },
    dispose: () => disposeTree(g),
  };
}
