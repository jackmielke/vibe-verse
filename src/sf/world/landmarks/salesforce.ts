/**
 * Salesforce Tower — 326 m, the tallest thing west of the Mississippi when it
 * topped out, and the object that fixed San Francisco's skyline in place.
 *
 * Three things define it and nothing else really matters:
 *
 *  1. **The taper is continuous and gentle.** It loses about a quarter of its
 *     plan over 61 floors, and the *corners round off* as it rises, so a square
 *     base becomes almost a circle at the top. A straight extrusion with a
 *     scale factor gets the width right and the shape wrong.
 *  2. **The crown is empty.** The curtain wall keeps going for 30 m past the
 *     last occupied floor as an open metal veil. You can see sky through it,
 *     and that transparency is the whole silhouette.
 *  3. **"Day for Night".** Jim Campbell's LED sculpture wraps the top nine
 *     floors — 11,000 points of light showing slow, blurred figures. At dusk
 *     it is the brightest thing in the city and it *moves*.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, loft, roundedRectRing, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const PODIUM = 14;
const ROOF = 295;
const CROWN_TOP = 326;
const FLOORS = 61;
const LED_START = 252;

/** Plan half-width at elevation y. */
function halfAt(y: number): number {
  const t = Math.min(1, Math.max(0, y / ROOF));
  // Slightly faster narrowing in the top third — the real profile is a subtle
  // ogee, not a straight cone.
  return 22 - 6.4 * (t * 0.55 + t * t * 0.45);
}

/** Corner radius at elevation y — the square dissolving into a circle. */
function cornerAt(y: number): number {
  const t = Math.min(1, Math.max(0, y / ROOF));
  return 5.5 + 10 * t;
}

function planRing(y: number, gy: number, seg: number, shrink = 0): Float32Array {
  const h = halfAt(y) - shrink;
  return roundedRectRing(h * 2, h * 2, Math.min(cornerAt(y), h * 0.95), gy + y, seg);
}

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const glass = M.curtainGlass(0xc8d6e0);
  const fin = M.paintedColour(0xb9bfc4, 1.4);
  const stone = M.civicStone(0xd8d3c8);
  const seg = detail ? 48 : 20;

  /* ---------------- podium ---------------- */
  batch.add(stone, box(64, PODIUM, 58), xform(0, g + PODIUM / 2, 0));
  batch.add(glass, box(64.4, PODIUM - 5, 58.4), xform(0, g + (PODIUM - 5) / 2 + 1.4, 0));
  batch.add(stone, box(68, 1.6, 62), xform(0, g + PODIUM + 0.8, 0));
  ctx.collide.box(0, g + PODIUM / 2, 0, 32, PODIUM / 2, 29, 0, { walkable: false });
  ctx.collide.box(0, g + PODIUM + 0.8, 0, 34, 0.8, 31, 0, { walkable: true });

  /* ---------------- shaft ---------------- */
  // Two rings per floor: the glazing line and the spandrel, 100 mm apart. The
  // horizontal shadow every 4.8 m is what gives the tower its scale.
  const rings: Float32Array[] = [];
  const bands = detail ? FLOORS * 2 : 10;
  for (let i = 0; i <= bands; i++) {
    const y = PODIUM + ((ROOF - PODIUM) * i) / bands;
    rings.push(planRing(y, g, seg, detail && i % 2 === 1 ? 0.22 : 0));
  }
  batch.add(glass, loft(rings, false, false));

  /* ---------------- vertical fins ---------------- */
  // Every second mullion projects 300 mm. They converge as the plan shrinks,
  // which is why they are lofted rather than instanced boxes.
  if (detail) {
    const count = 32;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const lo = new Float32Array(12);
      const hi = new Float32Array(12);
      const y0 = PODIUM;
      const y1 = ROOF;
      const r0 = halfAt(y0) * 1.02;
      const r1 = halfAt(y1) * 1.02;
      const w = 0.55;
      const pts: [number, number][] = [
        [-w / 2, 0],
        [w / 2, 0],
        [w / 2, 0.34],
        [-w / 2, 0.34],
      ];
      for (let k = 0; k < 4; k++) {
        const [du, dn] = pts[k];
        lo[k * 3] = cos * (r0 + dn) - sin * du;
        lo[k * 3 + 1] = g + y0;
        lo[k * 3 + 2] = sin * (r0 + dn) + cos * du;
        hi[k * 3] = cos * (r1 + dn) - sin * du;
        hi[k * 3 + 1] = g + y1;
        hi[k * 3 + 2] = sin * (r1 + dn) + cos * du;
      }
      batch.add(fin, loft([lo, hi], true, true));
    }
  }

  /* ---------------- the crown ---------------- */
  // Open metal veil: vertical blades only, no glazing, stepping in as it goes.
  const bladeCount = detail ? 40 : 14;
  for (let i = 0; i < bladeCount; i++) {
    const a = (i / bladeCount) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const lo = new Float32Array(12);
    const hi = new Float32Array(12);
    const r0 = halfAt(ROOF);
    const r1 = r0 * 0.72;
    const w = 0.85;
    const pts: [number, number][] = [
      [-w / 2, -0.2],
      [w / 2, -0.2],
      [w / 2, 0.2],
      [-w / 2, 0.2],
    ];
    for (let k = 0; k < 4; k++) {
      const [du, dn] = pts[k];
      lo[k * 3] = cos * (r0 + dn) - sin * du;
      lo[k * 3 + 1] = g + ROOF - 4;
      lo[k * 3 + 2] = sin * (r0 + dn) + cos * du;
      hi[k * 3] = cos * (r1 + dn) - sin * du;
      hi[k * 3 + 1] = g + CROWN_TOP;
      hi[k * 3 + 2] = sin * (r1 + dn) + cos * du;
    }
    batch.add(fin, loft([lo, hi], true, true));
  }
  // Two ring stiffeners so the crown does not read as loose bristles.
  for (const t of [0.4, 0.8]) {
    const y = ROOF - 4 + (CROWN_TOP - (ROOF - 4)) * t;
    const r = halfAt(ROOF) * (1 - 0.28 * t);
    const a = roundedRectRing(r * 2, r * 2, r * 0.9, g + y, seg);
    const b = roundedRectRing(r * 2, r * 2, r * 0.9, g + y + 0.7, seg);
    batch.add(fin, loft([a, b], false, false));
  }
  // Roof plant + the mast.
  batch.add(M.paintedColour(0x8d9298, 1.2), box(14, 4, 14), xform(0, g + ROOF - 2, 0));
  batch.add(M.paintedColour(0xd0d3d6, 0.8), box(0.7, 16, 0.7), xform(0, g + CROWN_TOP + 8, 0));

  /* ---------------- Day for Night ---------------- */
  // Nine floors of LED. Modelled as emissive bands with a slow luminance drift
  // so it reads as an image scrolling rather than a lit ring.
  const ledMats: THREE.MeshStandardMaterial[] = [];
  const ledRows = detail ? 9 : 3;
  for (let r = 0; r < ledRows; r++) {
    const y = LED_START + ((ROOF - 6 - LED_START) * r) / ledRows;
    const h = halfAt(y) + 0.42;
    const mat = M.emitter(r % 2 === 0 ? 0x9fd4ff : 0xffd9a8, 3);
    ledMats.push(mat);
    const a = roundedRectRing(h * 2, h * 2, Math.min(cornerAt(y), h * 0.95), g + y, seg);
    const b = roundedRectRing(h * 2, h * 2, Math.min(cornerAt(y), h * 0.95), g + y + 2.6, seg);
    batch.add(mat, loft([a, b], false, false));
  }
  ctx.onFrame((t) => {
    for (let i = 0; i < ledMats.length; i++) {
      // A travelling wave up the tower: the artwork is always moving.
      const phase = t * 0.55 - i * 0.42;
      ledMats[i].emissiveIntensity = 1.1 + 2.6 * (0.5 + 0.5 * Math.sin(phase)) ** 2;
    }
  });

  const beacon = M.emitter(0xff3020, 6);
  const beaconGeo = new THREE.SphereGeometry(0.8, 10, 8);
  batch.add(beacon, beaconGeo, xform(0, g + CROWN_TOP + 16.6, 0));
  beaconGeo.dispose();

  /* ---------------- collision ---------------- */
  const layers = 8;
  for (let i = 0; i < layers; i++) {
    const y0 = PODIUM + ((ROOF - PODIUM) * i) / layers;
    const y1 = PODIUM + ((ROOF - PODIUM) * (i + 1)) / layers;
    const h = halfAt((y0 + y1) / 2);
    ctx.collide.box(0, g + (y0 + y1) / 2, 0, h, (y1 - y0) / 2, h, 0, { walkable: false });
  }
  ctx.collide.box(0, g + ROOF, 0, halfAt(ROOF), 1, halfAt(ROOF), 0, { walkable: true });
}

export const salesforceTower: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build,
  nearRange: (def) => Math.max(1400, def.radius * 14),
  anchor: true,
};
