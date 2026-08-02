/**
 * Vibe Kart — the start/finish gantry.
 *
 * This is the one piece of scenery every player looks at directly, twice a lap,
 * and stares at for the whole countdown. It gets hero treatment: a real lattice
 * tower each side, a trussed span, a printed banner, a row of hanging floods, a
 * timing tower, and the five-bulb start rig the race system drives.
 *
 * Unlike everything else in this directory the gantry is not instanced — there
 * is exactly one of it — but it is still merged aggressively: the whole steel
 * structure is a single geometry, so the prop costs about six draw calls
 * including its lit bulbs and their haloes.
 *
 * `setStartLights(n)` is the published contract. `n` bulbs light red; dropping
 * to zero from a lit state plays the green GO flash, so a race system that only
 * counts down still gets the launch beat for free.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import {
  at,
  clamp01,
  gBox,
  gCyl,
  gIco,
  gPlane,
  merge,
  strut,
  type Part,
} from "./util";

/** Colours of the rig, so the bulb states are one edit rather than five. */
const BULB_OFF = 0x3a1418;
const BULB_RED = 0xff2b2b;
const BULB_GREEN = 0x3dff72;

export interface GantryHandle extends SceneryPiece {
  /** 0..5 bulbs lit red. Falling to 0 from lit plays the green GO flash. */
  setStartLights(n: number): void;
  /** World position of the gantry crown, for cameras that want to frame it. */
  readonly position: THREE.Vector3;
}

/**
 * One lattice tower leg-to-leg: four uprights, ladder rungs and X-bracing on
 * all four faces. Written out rather than looped over a face list because the
 * bracing pattern differs front-to-back, and a truss that reads as a truss is
 * worth the twenty extra lines.
 */
function towerParts(parts: Part[], height: number, w: number, steel: number): void {
  const h = w * 0.5;
  const legs: Array<[number, number]> = [
    [-h, -h],
    [h, -h],
    [-h, h],
    [h, h],
  ];
  for (const [lx, lz] of legs) {
    parts.push({ geo: at(gBox(0.17, height, 0.17), lx, height * 0.5, lz), color: steel });
  }
  const bays = Math.max(4, Math.round(height / 1.6));
  for (let i = 1; i <= bays; i++) {
    const y = (i / bays) * height;
    // Horizontal rungs around the perimeter.
    parts.push({ geo: at(gBox(w, 0.1, 0.1), 0, y, -h), color: steel });
    parts.push({ geo: at(gBox(w, 0.1, 0.1), 0, y, h), color: steel });
    parts.push({ geo: at(gBox(0.1, 0.1, w), -h, y, 0), color: steel });
    parts.push({ geo: at(gBox(0.1, 0.1, w), h, y, 0), color: steel });
    if (i === bays) break;
    // Alternating diagonals: the zig-zag is what makes a lattice legible from
    // a moving kart, where individual members are two pixels wide.
    const y1 = ((i + 1) / bays) * height;
    const flip = i % 2 === 0;
    parts.push({
      geo: strut(gBox(1, 1, 1), flip ? -h : h, y, -h, flip ? h : -h, y1, -h, 0.075),
      color: steel,
    });
    parts.push({
      geo: strut(gBox(1, 1, 1), flip ? h : -h, y, h, flip ? -h : h, y1, h, 0.075),
      color: steel,
    });
  }
  // Base plates, so the tower lands on the ground instead of ending at it.
  for (const [lx, lz] of legs) {
    parts.push({ geo: at(gBox(0.42, 0.14, 0.42), lx, 0.07, lz), color: 0xb9bec5 });
  }
}

export function buildGantry(b: BuildCtx): GantryHandle {
  const { sampler, mats, res, plan } = b;
  const frame = sampler.frameAt(plan.startT);

  const hw = frame.halfWidth;
  const span = hw + 4.2;
  const towerH = 11.5;
  const beamY = 8.4;
  const steel = 0xe9ecef;

  // --- structure -----------------------------------------------------------
  const parts: Part[] = [];
  for (const sx of [-1, 1]) {
    const g: Part[] = [];
    towerParts(g, towerH, 1.5, steel);
    for (const p of g) {
      p.geo.translate(sx * span, 0, 0);
      parts.push(p);
    }
  }

  // The span: two chords, verticals and a full run of diagonals.
  for (const z of [-0.7, 0.7]) {
    for (const y of [beamY, beamY + 1.5]) {
      parts.push({ geo: at(gBox(span * 2, 0.16, 0.16), 0, y, z), color: steel });
    }
    const cells = Math.max(6, Math.round((span * 2) / 1.5));
    for (let i = 0; i <= cells; i++) {
      const x = -span + (i / cells) * span * 2;
      parts.push({ geo: at(gBox(0.11, 1.5, 0.11), x, beamY + 0.75, z), color: steel });
      if (i === cells) break;
      const x1 = -span + ((i + 1) / cells) * span * 2;
      const flip = i % 2 === 0;
      parts.push({
        geo: strut(gBox(1, 1, 1), flip ? x : x1, beamY, z, flip ? x1 : x, beamY + 1.5, z, 0.08),
        color: steel,
      });
    }
  }
  // Lateral ties between the two chord planes.
  for (let i = 0; i <= 8; i++) {
    const x = -span + (i / 8) * span * 2;
    parts.push({ geo: at(gBox(0.1, 0.1, 1.4), x, beamY + 1.5, 0), color: steel });
  }

  // Timing tower on the pit side: a stack of illuminated panels facing the
  // grid, and — because it is just as often seen side-on from the run-off — a
  // liveried flank rather than a blank beige slab.
  const tt = span + 3.4;
  parts.push({ geo: at(gBox(2.6, 13.5, 2.0), tt, 6.75, 1.2), color: 0xf1eee7 });
  parts.push({ geo: at(gBox(3.0, 0.3, 2.4), tt, 13.6, 1.2), color: 0x1b2a6b });
  parts.push({ geo: at(gBox(2.66, 1.1, 2.06), tt, 12.3, 1.2), color: 0x1b2a6b });
  for (let i = 0; i < 6; i++) {
    parts.push({ geo: at(gBox(2.1, 0.62, 0.09), tt, 3.4 + i * 1.5, 0.14), color: 0x161a22 });
    parts.push({ geo: at(gBox(0.32, 0.42, 0.05), tt - 0.72, 3.4 + i * 1.5, 0.1), color: 0xffcc22 });
  }
  for (const sx of [-1, 1]) {
    // A colour band and a stack of window slots down each flank.
    parts.push({ geo: at(gBox(0.08, 12.6, 0.6), tt + sx * 1.32, 6.6, 0.35), color: 0xe8402a });
    parts.push({ geo: at(gBox(0.08, 12.6, 0.24), tt + sx * 1.32, 6.6, 0.86), color: 0xffcc22 });
    for (let i = 0; i < 5; i++) {
      parts.push({ geo: at(gBox(0.07, 0.8, 0.8), tt + sx * 1.32, 3.9 + i * 2.1, 1.75), color: 0x22303f });
    }
  }

  // Lamp housings hanging off the front chord.
  const lamps = 7;
  for (let i = 0; i < lamps; i++) {
    const x = -span * 0.82 + (i / (lamps - 1)) * span * 1.64;
    parts.push({ geo: at(gBox(0.09, 0.6, 0.09), x, beamY - 0.3, -0.9), color: steel });
    parts.push({ geo: at(gCyl(0.34, 0.24, 0.42, 8), x, beamY - 0.78, -0.9, 0, Math.PI), color: 0x2c3138 });
    parts.push({ geo: at(gCyl(0.4, 0.4, 0.06, 10), x, beamY - 1.0, -0.9), color: 0xfff2c8 });
  }

  const structureGeo = res.geo(merge(parts));
  const structure = new THREE.Mesh(structureGeo, mats.painted);
  structure.name = "scenery/gantry-structure";
  structure.castShadow = b.density.shadows;
  structure.receiveShadow = true;

  // --- banner --------------------------------------------------------------
  // 8:1 artwork on an 8:1 quad, hung between the chords and double-sided so it
  // reads on the approach and in the mirror.
  const bannerGeo = res.geo(gPlane(span * 1.94, span * 1.94 / 8, 1, 1));
  const banner = new THREE.Mesh(bannerGeo, mats.banner);
  banner.position.set(0, beamY + 0.75, -0.78);
  banner.name = "scenery/gantry-banner";

  // A second banner facing the other way, so the far side is not a blank sheet.
  const bannerBack = new THREE.Mesh(bannerGeo, mats.banner);
  bannerBack.position.set(0, beamY + 0.75, 0.78);
  bannerBack.rotation.y = Math.PI;

  // --- start lights --------------------------------------------------------
  const rigParts: Part[] = [
    { geo: at(gBox(4.4, 1.5, 0.42), 0, beamY - 1.5, -0.35), color: 0x14171d },
    { geo: at(gBox(4.6, 0.16, 0.5), 0, beamY - 0.78, -0.35), color: 0x22262e },
    { geo: at(gBox(4.6, 0.16, 0.5), 0, beamY - 2.24, -0.35), color: 0x22262e },
  ];
  for (let i = 0; i < 5; i++) {
    const x = -1.7 + i * 0.85;
    // A shroud over each bulb: without it the lens is a flat disc and the rig
    // stops reading as five distinct lights the moment the sun is behind you.
    rigParts.push({ geo: at(gCyl(0.32, 0.26, 0.3, 10, true), x, beamY - 1.5, -0.62, 0, Math.PI / 2), color: 0x0d0f13 });
  }
  const rigGeo = res.geo(merge(rigParts));
  const rig = new THREE.Mesh(rigGeo, mats.painted);
  rig.name = "scenery/start-rig";

  const bulbGeo = res.geo(gIco(0.21, 1));
  const bulbs: THREE.Mesh[] = [];
  const haloes: THREE.Sprite[] = [];
  const bulbColors: THREE.Color[] = [];
  for (let i = 0; i < 5; i++) {
    const x = -1.7 + i * 0.85;
    // Each bulb owns its material so the five can be lit independently; they
    // are five materials, not five hundred, and the alternative is five meshes
    // fighting over one emissive colour.
    const mat = res.mat(
      new THREE.MeshStandardMaterial({
        name: `scenery/bulb${i}`,
        color: 0x1a0a0c,
        emissive: new THREE.Color(BULB_OFF),
        emissiveIntensity: 1,
        roughness: 0.25,
        metalness: 0,
        toneMapped: true,
      }),
    );
    const mesh = new THREE.Mesh(bulbGeo, mat);
    mesh.position.set(x, beamY - 1.5, -0.76);
    bulbs.push(mesh);
    bulbColors.push(new THREE.Color(BULB_OFF));

    // Each halo needs its own material because opacity is per-material, not
    // per-sprite; the clone shares the texture so this costs nothing but five
    // tiny uniform blocks.
    const haloMat = res.mat(mats.halo.clone());
    haloMat.opacity = 0;
    const halo = new THREE.Sprite(haloMat);
    halo.position.set(x, beamY - 1.5, -0.86);
    halo.scale.setScalar(1.5);
    haloes.push(halo);
  }

  // --- assemble ------------------------------------------------------------
  const group = new THREE.Group();
  group.name = "scenery/gantry";
  group.add(structure, banner, bannerBack, rig, ...bulbs, ...haloes);

  const pos = frame.position.clone();
  pos.y = sampler.groundAt(pos.x, pos.z);
  const bx = frame.right.clone().setY(0).normalize();
  const by = new THREE.Vector3(0, 1, 0);
  // +Z faces oncoming traffic. right × up = -forward, so (right, up, -forward)
  // is the right-handed basis that points the banner at the grid.
  const bz = frame.forward.clone().setY(0).normalize().negate();
  const m = new THREE.Matrix4().makeBasis(bx, by, bz);
  m.setPosition(pos);
  group.applyMatrix4(m);
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  b.root.add(group);

  plan.keepOut.push({ x: pos.x, z: pos.z, r: span + 8 });

  // --- lighting logic ------------------------------------------------------
  let lit = 0;
  let goTimer = 0;

  const hot = [false, false, false, false, false];

  const paint = (index: number, hex: number, glow: number) => {
    bulbColors[index].setHex(hex, THREE.SRGBColorSpace);
    hot[index] = glow > 0;
    const mat = bulbs[index].material as THREE.MeshStandardMaterial;
    mat.emissive.copy(bulbColors[index]);
    // Hot enough for bloom to catch it, not so hot that ACES clips the hue to
    // white. A lit bulb wants to read as *red*, not as a bright spot.
    mat.emissiveIntensity = glow > 0 ? 1.8 + glow * 1.4 : 0.35;
    haloes[index].scale.setScalar(1.1 + glow * 0.9);
    (haloes[index].material as THREE.SpriteMaterial).color.copy(bulbColors[index]);
  };

  const apply = () => {
    for (let i = 0; i < 5; i++) {
      const on = i < lit;
      paint(i, on ? BULB_RED : BULB_OFF, on ? 1 : 0);
    }
  };
  apply();

  const handle: GantryHandle = {
    position: pos.clone().setY(pos.y + beamY),

    setStartLights(n: number) {
      const next = Math.max(0, Math.min(5, Math.round(n)));
      // Lights out from a lit rig is the launch. Firing the green flash here
      // rather than on a separate call means a race system that only counts
      // down still gets the beat.
      if (next === 0 && lit > 0) goTimer = 1.15;
      lit = next;
      if (goTimer <= 0) apply();
    },

    update(dt: number, elapsed: number) {
      if (goTimer > 0) {
        goTimer = Math.max(0, goTimer - dt);
        const k = clamp01(goTimer / 1.15);
        for (let i = 0; i < 5; i++) paint(i, BULB_GREEN, k * k);
        if (goTimer === 0) apply();
      }
      // Haloes are additive sprites and have to be driven every frame anyway;
      // a slow flicker on the lit ones keeps the rig from looking painted on.
      for (let i = 0; i < 5; i++) {
        const flick = hot[i] ? 0.82 + Math.sin(elapsed * 21 + i) * 0.06 : 0;
        const mat = haloes[i].material as THREE.SpriteMaterial;
        // Decay rather than snap: a bulb going out leaves an afterglow, which
        // is both physically true of a filament and reads better at 60 fps.
        mat.opacity = Math.max(mat.opacity * (1 - Math.min(1, dt * 6)), flick);
      }
    },
  };

  return handle;
}
