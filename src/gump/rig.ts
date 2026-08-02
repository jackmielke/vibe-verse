/**
 * Everybody in this world is built here, out of boxes.
 *
 * There is no model file anywhere in RUN, VIBEY, RUN, and that is a deliberate
 * trade rather than a shortcut. A game whose whole subject is *running* needs
 * one thing to be right — the run cycle — and needs it to be right on a boy in
 * leg braces, a running back, a soldier carrying a friend, a shrimp captain and
 * a bearded man crossing America. A rig assembled from primitives can be
 * re-skinned into all six in a line of config and still share one animation,
 * which is worth far more here than a nicer silhouette on one of them.
 *
 * The cycle itself is driven by *distance travelled*, not by wall-clock time.
 * That is the single thing that makes procedural running read as running: feet
 * planted per metre means the stride stretches when you sprint instead of the
 * legs spinning faster underneath a body that is barely moving.
 */
import * as THREE from "three";

export interface HumanSpec {
  /** Metres, crown of the head. 1.8 is an adult; the boy is 1.25. */
  height?: number;
  skin?: number;
  shirt?: number;
  pants?: number;
  shoes?: number;
  hair?: number;
  hairStyle?: "short" | "long" | "bowl" | "none";
  hat?: "none" | "cap" | "football" | "army" | "rain" | "boonie";
  hatColor?: number;
  beard?: boolean;
  /** The boy's leg braces. Removable at runtime — that is the whole point. */
  braces?: boolean;
  /**
   * Head size multiplier. A child is not an adult scaled down — the give-away
   * is the head, which is nearly adult-sized on a much smaller body, and one
   * multiplier here is the difference between a boy and a very short man.
   */
  headScale?: number;
  /** Skips arms/hands detail for crowd extras that are never seen up close. */
  simple?: boolean;
}

export interface Human {
  group: THREE.Group;
  /**
   * @param phase  Stride phase in radians — feed it distance, not time.
   * @param effort 0 = standing, 1 = flat out. Drives stride length and lean.
   * @param air    0 = on the ground, 1 = mid-jump (legs tuck, arms up).
   */
  pose(phase: number, effort: number, air?: number): void;
  /** Sit on a bench: knees at ninety, hands on thighs, no stride. */
  sit(): void;
  /** Snap the braces off the boy's legs. Returns where they fell. */
  removeBraces(): THREE.Vector3 | null;
  dispose(): void;
}

/*
 * Geometry and material caches, keyed by their arguments.
 *
 * These matter more than they look. The finale puts forty followers behind
 * you, all built by the same code path — without the cache that is forty sets
 * of identical box geometries uploaded to the GPU and forty materials to break
 * batching with. Keyed caches make an extra runner cost one draw call's worth
 * of matrices and nothing else.
 */
const MATS = new Map<string, THREE.MeshLambertMaterial>();
const GEOS = new Map<string, THREE.BufferGeometry>();

function mat(color: number) {
  const key = String(color);
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    MATS.set(key, m);
  }
  return m;
}

function box(w: number, h: number, d: number) {
  const key = `b${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)}`;
  let g = GEOS.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    GEOS.set(key, g);
  }
  return g;
}

function sphere(r: number, seg = 10) {
  const key = `s${r.toFixed(4)},${seg}`;
  let g = GEOS.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75));
    GEOS.set(key, g);
  }
  return g;
}

/**
 * A limb segment: a Group pinned at the joint with the mesh hung *below* it,
 * so rotating the group swings the segment from the shoulder or hip rather
 * than spinning it around its own middle. Every joint in the rig is this.
 */
function segment(len: number, thick: number, material: THREE.Material, depth = thick) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(box(thick, len, depth), material);
  mesh.position.y = -len / 2;
  g.add(mesh);
  return { joint: g, mesh, len };
}

export function makeHuman(spec: HumanSpec = {}): Human {
  const H = spec.height ?? 1.8;
  const s = H / 1.8; // everything below is authored at adult scale and scaled

  const skin = mat(spec.skin ?? 0xd9a37a);
  const shirt = mat(spec.shirt ?? 0x4a7fb5);
  const pants = mat(spec.pants ?? 0x3b4a63);
  const shoes = mat(spec.shoes ?? 0x2a2220);
  const hairMat = mat(spec.hair ?? 0x6b4a2c);

  const group = new THREE.Group();
  const root = new THREE.Group(); // carries the bob so `group` stays on the floor
  group.add(root);

  const hipY = 0.92 * s;
  const thighLen = 0.44 * s;
  const shinLen = 0.42 * s;

  /* --- torso ------------------------------------------------------------ */
  const torso = new THREE.Group();
  torso.position.y = hipY;
  root.add(torso);

  const chest = new THREE.Mesh(box(0.42 * s, 0.62 * s, 0.24 * s), shirt);
  chest.position.y = 0.31 * s;
  torso.add(chest);

  const neck = new THREE.Mesh(box(0.12 * s, 0.08 * s, 0.12 * s), skin);
  neck.position.y = 0.66 * s;
  torso.add(neck);

  /* --- head ------------------------------------------------------------- */
  const head = new THREE.Group();
  head.position.y = 0.7 * s;
  head.scale.setScalar(spec.headScale ?? 1);
  torso.add(head);

  const skull = new THREE.Mesh(box(0.24 * s, 0.28 * s, 0.24 * s), skin);
  skull.position.y = 0.14 * s;
  head.add(skull);

  // Eyes, because a head with no face reads as a mannequin at any distance.
  const eyeGeo = box(0.035 * s, 0.045 * s, 0.02 * s);
  const eyeMat = mat(0x14100e);
  for (const x of [-0.055, 0.055]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(x * s, 0.16 * s, 0.125 * s);
    head.add(e);
  }

  const style = spec.hairStyle ?? "short";
  if (style !== "none") {
    const cap = new THREE.Mesh(
      box(0.26 * s, style === "bowl" ? 0.14 * s : 0.1 * s, 0.26 * s),
      hairMat,
    );
    cap.position.y = (style === "bowl" ? 0.25 : 0.27) * s;
    head.add(cap);
    if (style === "long") {
      const back = new THREE.Mesh(box(0.26 * s, 0.3 * s, 0.08 * s), hairMat);
      back.position.set(0, 0.1 * s, -0.11 * s);
      head.add(back);
    }
  }

  if (spec.beard) {
    const beard = new THREE.Mesh(box(0.22 * s, 0.16 * s, 0.16 * s), hairMat);
    beard.position.set(0, 0.05 * s, 0.06 * s);
    head.add(beard);
  }

  if (spec.hat && spec.hat !== "none") {
    const hc = mat(spec.hatColor ?? 0xb3261e);
    if (spec.hat === "cap") {
      const crown = new THREE.Mesh(box(0.27 * s, 0.12 * s, 0.27 * s), hc);
      crown.position.y = 0.3 * s;
      const brim = new THREE.Mesh(box(0.27 * s, 0.03 * s, 0.14 * s), hc);
      brim.position.set(0, 0.25 * s, 0.19 * s);
      head.add(crown, brim);
    } else if (spec.hat === "football") {
      const shell = new THREE.Mesh(sphere(0.18 * s, 12), hc);
      shell.scale.set(1, 0.9, 1.05);
      shell.position.y = 0.17 * s;
      const bar = new THREE.Mesh(box(0.24 * s, 0.02 * s, 0.02 * s), mat(0xdedad0));
      bar.position.set(0, 0.06 * s, 0.18 * s);
      head.add(shell, bar);
    } else if (spec.hat === "army" || spec.hat === "boonie") {
      const shell = new THREE.Mesh(sphere(0.17 * s, 10), mat(0x4a5236));
      shell.scale.set(1, 0.8, 1.1);
      shell.position.y = 0.2 * s;
      head.add(shell);
      if (spec.hat === "boonie") {
        const brim = new THREE.Mesh(box(0.4 * s, 0.02 * s, 0.4 * s), mat(0x4a5236));
        brim.position.y = 0.16 * s;
        head.add(brim);
      }
    } else if (spec.hat === "rain") {
      const crown = new THREE.Mesh(box(0.26 * s, 0.14 * s, 0.26 * s), hc);
      crown.position.y = 0.31 * s;
      const brim = new THREE.Mesh(box(0.44 * s, 0.025 * s, 0.36 * s), hc);
      brim.position.y = 0.25 * s;
      brim.rotation.x = -0.12;
      head.add(crown, brim);
    }
  }

  /* --- arms ------------------------------------------------------------- */
  const armThick = 0.11 * s;
  const arms: Array<{ upper: ReturnType<typeof segment>; lower: ReturnType<typeof segment> }> = [];
  for (const side of [-1, 1]) {
    const upper = segment(0.34 * s, armThick, shirt);
    upper.joint.position.set(side * 0.26 * s, 0.56 * s, 0);
    torso.add(upper.joint);
    const lower = segment(0.32 * s, armThick * 0.9, spec.simple ? shirt : skin);
    lower.joint.position.y = -0.34 * s;
    upper.joint.add(lower.joint);
    arms.push({ upper, lower });
  }

  /* --- legs ------------------------------------------------------------- */
  const legs: Array<{
    thigh: ReturnType<typeof segment>;
    shin: ReturnType<typeof segment>;
    foot: THREE.Mesh;
  }> = [];
  for (const side of [-1, 1]) {
    const thigh = segment(thighLen, 0.15 * s, pants);
    thigh.joint.position.set(side * 0.11 * s, 0, 0);
    torso.add(thigh.joint);
    const shin = segment(shinLen, 0.13 * s, pants);
    shin.joint.position.y = -thighLen;
    thigh.joint.add(shin.joint);
    const foot = new THREE.Mesh(box(0.13 * s, 0.08 * s, 0.26 * s), shoes);
    foot.position.set(0, -shinLen - 0.03 * s, 0.05 * s);
    shin.joint.add(foot);
    legs.push({ thigh, shin, foot });
  }

  /* --- the braces -------------------------------------------------------
   * Two steel uprights and three straps per leg, parented to the thigh joint
   * so they swing with him. `removeBraces()` unparents them rather than hiding
   * them, so the moment they come off the chapter can drop them in the road
   * and leave them lying there behind him. */
  const braceRigs: THREE.Group[] = [];
  if (spec.braces) {
    const steel = mat(0xc2cbd2);
    const strap = mat(0x5a4632);
    const legLen = thighLen + shinLen;
    for (const leg of legs) {
      const b = new THREE.Group();
      // Chunky on purpose. A realistic 25 mm upright is invisible from a
      // chase camera, and the braces have to read at a glance or the moment
      // they come off means nothing.
      for (const x of [-0.1, 0.1]) {
        const bar = new THREE.Mesh(box(0.045 * s, legLen * 0.98, 0.045 * s), steel);
        bar.position.set(x * s, -legLen * 0.48, 0);
        b.add(bar);
      }
      for (const f of [0.16, 0.54, 0.92]) {
        const st = new THREE.Mesh(box(0.26 * s, 0.075 * s, 0.2 * s), strap);
        st.position.y = -f * legLen;
        b.add(st);
      }
      // The stirrup under the boot, which is the bit everybody remembers.
      const stirrup = new THREE.Mesh(box(0.27 * s, 0.05 * s, 0.05 * s), steel);
      stirrup.position.y = -legLen * 1.0;
      b.add(stirrup);
      leg.thigh.joint.add(b);
      braceRigs.push(b);
    }
  }

  /* --- animation --------------------------------------------------------- */
  let bracesOn = Boolean(spec.braces);

  function pose(phase: number, effort: number, air = 0) {
    const e = THREE.MathUtils.clamp(effort, 0, 1);
    const grounded = 1 - THREE.MathUtils.clamp(air, 0, 1);

    // Stride opens up with effort. Braces are a *pose* constraint as much as a
    // speed one — stiff legs are why the boy looks wrong until they come off.
    const swing = (0.35 + e * 0.75) * (bracesOn ? 0.35 : 1) * grounded;
    const sw = Math.sin(phase);
    const cw = Math.cos(phase);

    for (const [i, leg] of legs.entries()) {
      const dir = i === 0 ? 1 : -1;
      const t = sw * dir;
      leg.thigh.joint.rotation.x = t * swing - 0.06 * e + air * -0.9;
      // Knees only bend one way. Feeding the raw sine through max() is what
      // stops the shin hyper-extending forward on the back half of the stride.
      leg.shin.joint.rotation.x =
        Math.max(0, -t) * (1.5 * swing) + (bracesOn ? 0 : 0.1) + air * 1.1;
      leg.foot.rotation.x = -leg.shin.joint.rotation.x * 0.4;
    }

    for (const [i, arm] of arms.entries()) {
      const dir = i === 0 ? -1 : 1;
      const t = sw * dir;
      arm.upper.joint.rotation.x = t * swing * 0.9 + air * -1.6;
      arm.upper.joint.rotation.z = (i === 0 ? 1 : -1) * (0.12 + e * 0.06);
      arm.lower.joint.rotation.x = -(0.5 + Math.max(0, t) * 0.9) * (0.4 + e * 0.9);
    }

    torso.rotation.x = 0.06 + e * 0.22;
    torso.rotation.z = cw * 0.03 * e;
    head.rotation.x = -(0.06 + e * 0.2); // he keeps his eyes up the road
    root.position.y = Math.abs(sw) * 0.045 * s * e * grounded;
  }

  function sit() {
    for (const leg of legs) {
      leg.thigh.joint.rotation.x = -Math.PI / 2;
      leg.shin.joint.rotation.x = Math.PI / 2;
      leg.foot.rotation.x = 0;
    }
    for (const [i, arm] of arms.entries()) {
      arm.upper.joint.rotation.x = -0.9;
      arm.upper.joint.rotation.z = (i === 0 ? 1 : -1) * 0.2;
      arm.lower.joint.rotation.x = -0.5;
    }
    torso.rotation.set(0.02, 0, 0);
    head.rotation.x = 0;
    root.position.y = 0;
  }

  function removeBraces(): THREE.Vector3 | null {
    if (!bracesOn) return null;
    bracesOn = false;
    const where = new THREE.Vector3();
    for (const b of braceRigs) {
      b.getWorldPosition(where);
      b.removeFromParent();
    }
    braceRigs.length = 0;
    return where;
  }

  /**
   * Geometry and materials come out of the module caches at the top of this
   * file and are shared by every human on screen, so a rig only detaches
   * itself here. `disposeRigCache()` frees the actual GPU memory, once.
   */
  function dispose() {
    group.removeFromParent();
  }

  pose(0, 0);
  return { group, pose, sit, removeBraces, dispose };
}

/**
 * The looks. Named after the beat they belong to so a chapter can ask for
 * `LOOKS.army` and not carry a colour palette around with it.
 */
export const LOOKS: Record<string, HumanSpec> = {
  /** Greenbow, Alabama. Bowl cut, stripey shirt, and the braces. */
  boy: {
    height: 1.32,
    headScale: 1.28,
    shirt: 0xe2d6b8,
    pants: 0x6d7f9c,
    hair: 0xc9a24a,
    hairStyle: "bowl",
    shoes: 0x8a6a3a,
    braces: true,
  },
  /** Same boy, grown, in the blue plaid. */
  plaid: { shirt: 0x4a7fb5, pants: 0x394a63, hair: 0x7a5432, hairStyle: "short" },
  football: {
    shirt: 0xa6192e,
    pants: 0xe4e0d6,
    hat: "football",
    hatColor: 0xe4e0d6,
    hair: 0x7a5432,
    shoes: 0x1c1a18,
  },
  army: {
    shirt: 0x4d5a35,
    pants: 0x4d5a35,
    hat: "army",
    hair: 0x7a5432,
    shoes: 0x2f2a22,
  },
  pingpong: { shirt: 0xf2f2f0, pants: 0xb3261e, hair: 0x7a5432, shoes: 0xf0efe9 },
  captain: {
    shirt: 0xf2c23b,
    pants: 0xf2c23b,
    hat: "rain",
    hatColor: 0xf2c23b,
    hair: 0x7a5432,
    shoes: 0x2a2a2a,
  },
  /** Three years, two months, fourteen days and sixteen hours of beard. */
  beard: {
    shirt: 0xdedad0,
    pants: 0x9a3b3b,
    hair: 0x6b4a2c,
    hairStyle: "long",
    beard: true,
    hat: "cap",
    hatColor: 0xb3261e,
    shoes: 0xe8e4dc,
  },
};

/** Dispose every cached geometry/material. Called once, from engine teardown. */
export function disposeRigCache() {
  for (const g of GEOS.values()) g.dispose();
  for (const m of MATS.values()) m.dispose();
  GEOS.clear();
  MATS.clear();
}

/** The shared caches, for world props that want to match the rig's palette. */
export const rigMaterial = mat;
export const rigBox = box;
export const rigSphere = sphere;
