/**
 * Vibe Kart — everything the road is bolted to.
 *
 * Guardrails and concrete barriers along the edges, the Old Cannery tunnel, the
 * Gull Creek bridge, the steel ramps either side of Bluff Jump, the rock face
 * the anti-gravity plating clings to, the viaduct out over the bay, and the
 * gantry across the start line.
 *
 * Two rules keep this cheap. Everything that runs *along* the track is an
 * extruded profile sharing the ribbon's ring list, emitted face by face with
 * flat normals so a barrier reads as cast concrete rather than an inflated
 * tube. Everything that *repeats* — rail posts, bridge piers, viaduct pylons,
 * tunnel lights — is an InstancedMesh, so a hundred posts cost one draw.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { SEGMENTS } from "./layout";
import type { GroundField } from "./ground";
import { SEA_LEVEL } from "./ground";
import type { TrackCurve } from "./spline";
import { WALL_HEIGHT, makeCross, type TrackSurface } from "./surface";
import type { RingSet } from "./ribbon";
import { MeshBuilder, lerp, type MaterialResolver } from "./util";

export interface StructureBuild {
  root: THREE.Object3D;
  geometries: THREE.BufferGeometry[];
}

/** A cross-section in (lateral-from-face, height-along-up) metres. */
type Profile = Array<[number, number]>;

/** Armco: one deep beam, face on. */
const RAIL_PROFILE: Profile = [
  [0.0, 0.46],
  [0.0, 1.02],
  [0.13, 1.02],
  [0.13, 0.46],
];

/** Jersey barrier: sloped toe, vertical face, flat cap. */
const BARRIER_PROFILE: Profile = [
  [0.0, 0.0],
  [0.0, 0.28],
  [0.16, 0.86],
  [0.19, 1.45],
  [0.62, 1.45],
  [0.62, 0.0],
];

/** Anti-gravity guide: a square-section glowing tube on a stub. */
const TUBE_PROFILE: Profile = [
  [0.04, 0.34],
  [0.04, 0.62],
  [0.3, 0.62],
  [0.3, 0.34],
];

/** Bridge railing: two timber rails. */
const POST_PROFILE: Profile = [
  [0.0, 0.5],
  [0.0, 0.66],
  [0.12, 0.66],
  [0.12, 0.5],
];
const POST_PROFILE_HI: Profile = [
  [0.0, 0.86],
  [0.0, 1.0],
  [0.12, 1.0],
  [0.12, 0.86],
];

const EDGE_MATERIAL: Record<string, string> = {
  rail: "metal",
  barrier: "concrete",
  tube: "neon",
  post: "wood",
};

export function buildStructures(
  curve: TrackCurve,
  surface: TrackSurface,
  ground: GroundField,
  mats: MaterialResolver,
  quality: KartQuality,
  rings: RingSet,
): StructureBuild {
  const root = new THREE.Group();
  root.name = "track/structures";
  const geometries: THREE.BufferGeometry[] = [];
  const N = rings.count;

  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const rgt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const cross = makeCross();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const add = (mb: MeshBuilder, name: string, material: THREE.Material, cast = true) => {
    if (!mb.vertexCount) return;
    const g = mb.toGeometry(name);
    geometries.push(g);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.castShadow = cast && quality !== "low";
    mesh.receiveShadow = true;
    root.add(mesh);
  };

  /** Rock and masonry read from both sides — the camera gets inside all of it. */
  const twoSided = (name: string): THREE.Material =>
    mats.variant(name, "twoSided", (m) => {
      m.side = THREE.DoubleSide;
      (m as THREE.MeshStandardMaterial).shadowSide = THREE.FrontSide;
    });

  // ---------------------------------------------------------------------
  // Edge guards
  // ---------------------------------------------------------------------
  const guardBuilders = new Map<string, MeshBuilder>();
  const postPoints: Array<{ p: THREE.Vector3; q: THREE.Quaternion; kind: string }> = [];
  const basis = new THREE.Matrix4();
  const negFwd = new THREE.Vector3();

  for (const side of [0, 1] as const) {
    const sign = side === 0 ? -1 : 1;
    let k = 0;
    while (k < N) {
      const kind = surface.wallKind(rings.s[k], side);
      let len = 1;
      while (k + len < N && surface.wallKind(rings.s[(k + len) % N], side) === kind) len++;
      if (kind !== "none") {
        const matName = EDGE_MATERIAL[kind] ?? "metal";
        let mb = guardBuilders.get(matName);
        if (!mb) guardBuilders.set(matName, (mb = new MeshBuilder()));
        const tile = mats.tile(matName);
        const profiles: Profile[] =
          kind === "rail"
            ? [RAIL_PROFILE]
            : kind === "barrier"
              ? [BARRIER_PROFILE]
              : kind === "tube"
                ? [TUBE_PROFILE]
                : [POST_PROFILE, POST_PROFILE_HI];
        for (const profile of profiles) {
          extrude(mb, k, len, sign, profile, tile);
        }
        // Posts every few metres, wherever the guard needs them to stand up.
        if (kind === "rail" || kind === "post" || kind === "tube") {
          const spacing = kind === "tube" ? 9 : 4.6;
          let acc = spacing;
          for (let i = 0; i <= len; i++) {
            const s = rings.s[(k + i) % N];
            if (i > 0) {
              const prev = rings.s[(k + i - 1 + N) % N];
              let d = s - prev;
              if (d < 0) d += curve.length;
              acc += d;
            }
            if (acc < spacing) continue;
            acc = 0;
            curve.sample(s, pos, fwd, rgt, up);
            const face = surface.wallLateral(s, side);
            if (!Number.isFinite(face)) continue;
            a.copy(pos).addScaledVector(rgt, face * sign);
            negFwd.copy(fwd).multiplyScalar(-1);
            basis.makeBasis(rgt, up, negFwd);
            postPoints.push({
              p: a.clone(),
              q: new THREE.Quaternion().setFromRotationMatrix(basis),
              kind,
            });
          }
        }
      }
      k += len;
    }
  }

  /** Extrude a profile along rings [from, from+len], face by face. */
  function extrude(mb: MeshBuilder, from: number, len: number, sign: number, profile: Profile, tile: number): void {
    for (let e = 0; e < profile.length - 1; e++) {
      const p0 = profile[e];
      const p1 = profile[e + 1];
      const dl = p1[0] - p0[0];
      const dh = p1[1] - p0[1];
      const inv = 1 / (Math.hypot(dl, dh) || 1e-6);
      // The profiles are wound clockwise in (lateral, height), so the outward
      // normal of an edge is (−dh, dl) — pointing away from the solid.
      const n2l = -dh * inv * sign;
      const n2h = dl * inv;
      const base = mb.vertexCount;
      let v = 0;
      for (let i = 0; i <= len; i++) {
        const s = rings.s[(from + i) % N];
        if (i > 0) {
          const prev = rings.s[(from + i - 1 + N) % N];
          let d = s - prev;
          if (d < 0) d += curve.length;
          v += d;
        }
        curve.sample(s, pos, fwd, rgt, up);
        surface.crossAt(s, cross);
        const face = surface.wallLateral(s, side0(sign));
        const faceLat = Number.isFinite(face) ? face : cross.halfWidth + 0.55;
        nrm.copy(rgt).multiplyScalar(n2l).addScaledVector(up, n2h).normalize();
        for (let c = 0; c < 2; c++) {
          const pp = c === 0 ? p0 : p1;
          a.copy(pos)
            .addScaledVector(rgt, (faceLat + pp[0]) * sign)
            .addScaledVector(up, pp[1] + surface.profile(cross, faceLat * sign));
          mb.vertex(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, v / tile, (c === 0 ? p0[1] : p1[1]) / tile);
        }
      }
      // The natural winding of a ring-major grid faces +right, which is correct
      // for a guard on the left of the road and inside-out for one on the right.
      if (sign < 0) mb.grid(base, len + 1, 2, false);
      else {
        for (let r = 0; r < len; r++) {
          const r0 = base + r * 2;
          const r1 = base + (r + 1) * 2;
          mb.tri(r0, r1 + 1, r1);
          mb.tri(r0, r0 + 1, r1 + 1);
        }
      }
    }
  }

  function side0(sign: number): 0 | 1 {
    return sign > 0 ? 1 : 0;
  }

  for (const [name, mb] of guardBuilders) add(mb, `track/guard/${name}`, mats.get(name));

  // Rail and railing posts, instanced.
  {
    const groups = new Map<string, Array<{ p: THREE.Vector3; q: THREE.Quaternion }>>();
    for (const pt of postPoints) {
      let list = groups.get(pt.kind);
      if (!list) groups.set(pt.kind, (list = []));
      list.push(pt);
    }
    const m4 = new THREE.Matrix4();
    const scale = new THREE.Vector3(1, 1, 1);
    for (const [kind, list] of groups) {
      const geo =
        kind === "tube"
          ? new THREE.BoxGeometry(0.22, 0.36, 0.22)
          : kind === "post"
            ? new THREE.BoxGeometry(0.16, 1.1, 0.16)
            : new THREE.BoxGeometry(0.14, 1.05, 0.2);
      geometries.push(geo);
      const matName = kind === "tube" ? "metal" : kind === "post" ? "wood" : "metal";
      const inst = new THREE.InstancedMesh(geo, mats.get(matName), list.length);
      inst.name = `track/posts/${kind}`;
      inst.castShadow = quality !== "low";
      inst.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        // The post's origin sits at its base; lift by half its height.
        a.copy(list[i].p).addScaledVector(UP_AXIS.set(0, 1, 0).applyQuaternion(list[i].q), 0.5);
        m4.compose(a, list[i].q, scale);
        inst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      root.add(inst);
    }
  }

  // ---------------------------------------------------------------------
  // The Old Cannery tunnel
  // ---------------------------------------------------------------------
  {
    const span = curve.spanOf("tunnel");
    const s0 = span.start - 6;
    const s1 = span.end + 6;
    const steps = Math.max(8, Math.round((s1 - s0) / (quality === "low" ? 8 : 4)));
    const arcSegs = quality === "low" ? 8 : 14;
    const bore = new MeshBuilder();
    const tile = mats.tile("stone");
    const HEIGHT = 7.6;
    let v = 0;
    const base = bore.vertexCount;
    for (let k = 0; k <= steps; k++) {
      const s = lerp(s0, s1, k / steps);
      if (k > 0) v += (s1 - s0) / steps;
      curve.sample(s, pos, fwd, rgt, up);
      surface.crossAt(s, cross);
      const half = cross.halfWidth + 2.6;
      for (let c = 0; c <= arcSegs; c++) {
        // A segmental arch: vertical springing up to 2.6 m, then a half-ellipse.
        const t = c / arcSegs;
        const ang = Math.PI * t;
        const lat = -Math.cos(ang) * half;
        const h = 2.4 + Math.sin(ang) * (HEIGHT - 2.4);
        a.copy(pos).addScaledVector(rgt, lat).addScaledVector(up, h - 0.9 * (1 - Math.sin(ang)));
        // Normals point in at the road: this is an interior surface.
        nrm.copy(rgt).multiplyScalar(Math.cos(ang)).addScaledVector(up, -Math.sin(ang)).normalize();
        bore.vertex(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, (t * Math.PI * half) / tile, v / tile);
      }
    }
    // Interior winding.
    for (let r = 0; r < steps; r++) {
      const r0 = base + r * (arcSegs + 1);
      const r1 = base + (r + 1) * (arcSegs + 1);
      for (let c = 0; c < arcSegs; c++) {
        bore.tri(r0 + c, r1 + c + 1, r1 + c);
        bore.tri(r0 + c, r0 + c + 1, r1 + c + 1);
      }
    }
    add(bore, "track/tunnel/bore", twoSided("stone"), false);

    // Portal rings: a fat brick arch standing proud of each mouth.
    const portal = new MeshBuilder();
    for (const [ps, dir] of [
      [s0, 1],
      [s1, -1],
    ] as Array<[number, number]>) {
      curve.sample(ps, pos, fwd, rgt, up);
      surface.crossAt(ps, cross);
      const half = cross.halfWidth + 2.6;
      const DEPTH = 1.8;
      const OUT = 1.5;
      const bt = mats.tile("brick");
      const ringBase = portal.vertexCount;
      for (let k = 0; k <= 1; k++) {
        const s = ps - dir * DEPTH * k;
        curve.sample(s, pos, fwd, rgt, up);
        for (let c = 0; c <= arcSegs; c++) {
          const t = c / arcSegs;
          const ang = Math.PI * t;
          const rad = k === 0 ? OUT : 0;
          const lat = -Math.cos(ang) * (half + rad);
          const h = 2.4 + Math.sin(ang) * (HEIGHT - 2.4 + rad);
          a.copy(pos).addScaledVector(rgt, lat).addScaledVector(up, h - 0.9 * (1 - Math.sin(ang)));
          nrm.copy(fwd).multiplyScalar(dir);
          portal.vertex(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, (t * Math.PI * half) / bt, k * (OUT / bt));
        }
      }
      for (let c = 0; c < arcSegs; c++) {
        const r0 = ringBase + c;
        const r1 = ringBase + (arcSegs + 1) + c;
        if (dir > 0) {
          portal.tri(r0, r1, r1 + 1);
          portal.tri(r0, r1 + 1, r0 + 1);
        } else {
          portal.tri(r0, r1 + 1, r1);
          portal.tri(r0, r0 + 1, r1 + 1);
        }
      }
    }
    add(portal, "track/tunnel/portal", twoSided("brick"), false);

    // Strip lights down the crown. Emissive, so the bloom pass does the rest.
    const lightGeo = new THREE.BoxGeometry(0.5, 0.16, 2.6);
    geometries.push(lightGeo);
    const nLights = Math.max(2, Math.floor((s1 - s0) / 11));
    const lights = new THREE.InstancedMesh(lightGeo, mats.get("neon"), nLights);
    lights.name = "track/tunnel/lights";
    const m4 = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < nLights; i++) {
      const s = lerp(s0 + 5, s1 - 5, nLights === 1 ? 0.5 : i / (nLights - 1));
      curve.sample(s, pos, fwd, rgt, up);
      a.copy(pos).addScaledVector(up, HEIGHT - 1.0);
      negFwd.copy(fwd).multiplyScalar(-1);
      basis.makeBasis(rgt, up, negFwd);
      m4.compose(a, new THREE.Quaternion().setFromRotationMatrix(basis), one);
      lights.setMatrixAt(i, m4);
    }
    lights.instanceMatrix.needsUpdate = true;
    lights.frustumCulled = false;
    root.add(lights);
  }

  // ---------------------------------------------------------------------
  // Gull Creek bridge
  // ---------------------------------------------------------------------
  buildDeck(["chicane1", "bridge", "chicane2"], "wood", 1.1, 0.9, true);

  // ---------------------------------------------------------------------
  // Bluff Jump ramps and the Bay Viaduct
  // ---------------------------------------------------------------------
  buildDeck(["kick"], "metal", 0.75, 1.2, false);
  buildDeck(["land"], "metal", 0.75, 1.2, false);
  buildDeck(["agExit"], "metal", 0.9, 1.6, false);

  /**
   * The underside of an elevated section: a box girder hung under the ribbon
   * plus legs down to whatever the ground is doing beneath it.
   */
  function buildDeck(ids: string[], material: string, depth: number, overhang: number, piers: boolean): void {
    const spans = ids.map((id) => curve.spanOf(id));
    const s0 = spans[0].start;
    const s1 = spans[spans.length - 1].end;
    // Only the genuinely elevated part earns a girder; the approach ramps are
    // included so the structure does not stop in mid-air.
    const anyElevated = ids.some((id) => SEGMENTS.find((g) => g.id === id)?.elevated);
    if (!anyElevated) return;
    const mb = new MeshBuilder();
    const tile = mats.tile(material);
    const steps = Math.max(4, Math.round((s1 - s0) / 3));
    const legs: Array<{ p: THREE.Vector3; h: number }> = [];
    let v = 0;
    const base = mb.vertexCount;
    for (let k = 0; k <= steps; k++) {
      const s = lerp(s0, s1, k / steps);
      if (k > 0) v += (s1 - s0) / steps;
      curve.sample(s, pos, fwd, rgt, up);
      surface.crossAt(s, cross);
      const half = cross.halfWidth + overhang;
      // Six points: down the left face, across the soffit, up the right.
      const pts: Array<[number, number]> = [
        [-half, 0.02],
        [-half, -depth],
        [-half * 0.72, -depth * 1.35],
        [half * 0.72, -depth * 1.35],
        [half, -depth],
        [half, 0.02],
      ];
      for (const [l, h] of pts) {
        a.copy(pos).addScaledVector(rgt, l).addScaledVector(up, h);
        nrm.copy(up).multiplyScalar(-1).addScaledVector(rgt, l > 0 ? 0.5 : -0.5).normalize();
        mb.vertex(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, l / tile, v / tile);
      }
      if (piers && k > 0 && k < steps && k % Math.max(2, Math.floor(steps / 3)) === 0) {
        a.copy(pos).addScaledVector(up, -depth * 1.35);
        legs.push({ p: a.clone(), h: a.y - ground.height(a.x, a.z) });
      }
    }
    mb.grid(base, steps + 1, 6, false);
    add(mb, `track/deck/${ids[0]}`, twoSided(material));

    if (legs.length) {
      const geo = new THREE.CylinderGeometry(1.5, 2.2, 1, 8, 1);
      geometries.push(geo);
      const inst = new THREE.InstancedMesh(geo, mats.get("stone"), legs.length);
      inst.name = `track/piers/${ids[0]}`;
      inst.castShadow = quality !== "low";
      inst.receiveShadow = true;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      for (let i = 0; i < legs.length; i++) {
        const h = Math.max(2, legs[i].h);
        sc.set(1, h, 1);
        a.copy(legs[i].p);
        a.y -= h * 0.5;
        m4.compose(a, q, sc);
        inst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      root.add(inst);
    }
  }

  // ---------------------------------------------------------------------
  // The bluff face under the anti-gravity plating
  // ---------------------------------------------------------------------
  {
    const span = curve.spanOf("antigrav");
    const steps = Math.max(8, Math.round((span.end - span.start) / 5));
    const mb = new MeshBuilder();
    const tile = mats.tile("stone");
    const INLAND = 62;
    const front: THREE.Vector3[] = [];
    const back: THREE.Vector3[] = [];
    const top: THREE.Vector3[] = [];
    for (let k = 0; k <= steps; k++) {
      const s = lerp(span.start - 8, span.end + 8, k / steps);
      curve.sample(s, pos, fwd, rgt, up);
      surface.crossAt(s, cross);
      // On the plating the frame is rolled to vertical: `right` is world up and
      // `up` is the seaward face normal. Slice the rock from the waterline to
      // well above the road and push it inland behind the road surface.
      const latLow = -(pos.y - SEA_LEVEL + 3);
      const latHigh = cross.halfWidth + 13;
      a.copy(pos).addScaledVector(rgt, latLow).addScaledVector(up, -0.5);
      front.push(a.clone());
      a.copy(pos).addScaledVector(rgt, latHigh).addScaledVector(up, -0.5);
      top.push(a.clone());
      b.copy(pos).addScaledVector(rgt, latHigh).addScaledVector(up, -INLAND);
      b.y = Math.max(ground.height(b.x, b.z) + 2, b.y - 22);
      back.push(b.clone());
    }
    ribbonBetween(mb, front, top, tile, 1);
    ribbonBetween(mb, top, back, tile, 1);
    add(mb, "track/bluffFace", twoSided("stone"));
  }

  /** Two parallel polylines stitched into a quad strip with smooth normals. */
  function ribbonBetween(mb: MeshBuilder, left: THREE.Vector3[], right: THREE.Vector3[], tile: number, dir: number): void {
    const base = mb.vertexCount;
    const n = Math.min(left.length, right.length);
    let v = 0;
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (i > 0) v += left[i].distanceTo(left[i - 1]);
      const j = Math.min(i + 1, n - 1);
      const h = Math.max(i - 1, 0);
      e1.subVectors(left[j], left[h]);
      e2.subVectors(right[i], left[i]);
      nrm.crossVectors(e2, e1).normalize().multiplyScalar(dir);
      const w = left[i].distanceTo(right[i]);
      mb.vertex(left[i].x, left[i].y, left[i].z, nrm.x, nrm.y, nrm.z, 0, v / tile);
      mb.vertex(right[i].x, right[i].y, right[i].z, nrm.x, nrm.y, nrm.z, w / tile, v / tile);
    }
    mb.grid(base, n, 2, false);
  }

  // ---------------------------------------------------------------------
  // Start/finish gantry
  // ---------------------------------------------------------------------
  {
    const gantry = new THREE.Group();
    gantry.name = "track/gantry";
    curve.sample(2.0, pos, fwd, rgt, up);
    surface.crossAt(2.0, cross);
    const half = cross.halfWidth + 3.2;
    const H = 8.4;

    const legGeo = new THREE.BoxGeometry(1.1, H, 1.1);
    const beamGeo = new THREE.BoxGeometry(half * 2 + 1.1, 1.5, 1.3);
    const bannerGeo = new THREE.PlaneGeometry(half * 2 - 1.5, 2.6);
    geometries.push(legGeo, beamGeo, bannerGeo);
    const steel = mats.get("metal");

    for (const sgn of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, steel);
      leg.position.copy(pos).addScaledVector(rgt, half * sgn).addScaledVector(up, H * 0.5);
      leg.quaternion.setFromRotationMatrix(basis.makeBasis(rgt, up, negFwd.copy(fwd).multiplyScalar(-1)));
      leg.castShadow = quality !== "low";
      gantry.add(leg);
    }
    const beam = new THREE.Mesh(beamGeo, steel);
    beam.position.copy(pos).addScaledVector(up, H + 0.4);
    beam.quaternion.setFromRotationMatrix(basis.makeBasis(rgt, up, negFwd.copy(fwd).multiplyScalar(-1)));
    beam.castShadow = quality !== "low";
    gantry.add(beam);

    const banner = new THREE.Mesh(bannerGeo, mats.get("banner"));
    banner.position.copy(pos).addScaledVector(up, H - 1.4).addScaledVector(fwd, -0.75);
    banner.quaternion.copy(beam.quaternion);
    gantry.add(banner);

    root.add(gantry);
  }

  return { root, geometries };
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);
