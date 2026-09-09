/**
 * Every road in the data draped on the graded ground: chip-seal on the county
 * roads (aggregate in a dark binder, polished darker in the wheel tracks,
 * patched, cracked, tar snakes), smoother asphalt with a fog line each side and
 * a double yellow down Blakely Ave, gravel or old asphalt or concrete on the
 * driveways with two tyre tracks and a grass strip on the long ones, packed
 * dirt on the tracks and trails. No kerbs, no sidewalks. Every edge feathers
 * into the gravel the ground paints beside it, a driveway flares where it
 * meets the road, and a culvert pipe shows where it crosses the ditch.
 */
import * as THREE from "three";
import type { Neighbourhood } from "./geo";
import { buildRoadNet, isMainRoad, sampleChain, type Chain } from "./roadnet";
import type { Ground } from "./terrain";
import { asphaltWorld, chipSealWorld, concreteWorld, dirtWorld, disposeWorldSurface, gravelWorld, oldAsphaltWorld, paintTexture, roadMacro, type WorldSurface } from "./textures.roads";

export interface Roads {
  group: THREE.Group;
  dispose(): void;
}

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

interface RoadLook {
  /** Where the wheels run, as a fraction of the half width, two tracks. */
  tracks: [number, number];
  trackDark: number;
  /** How much of the macro wear texture shows. */
  wear: number;
  /** Fraction of the half width where the surface starts to feather out. */
  feather: number;
  edgeLight: number;
}

function roadMaterial(s: WorldSurface, macro: THREE.Texture, look: RoadLook, base: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughness: 1, metalness: 0, transparent: true, depthWrite: true, ...base });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uMacro: { value: macro },
      uTile: { value: s.tile },
      uTrack: { value: new THREE.Vector2(look.tracks[0], look.tracks[1]) },
      uTrackDark: { value: look.trackDark },
      uWear: { value: look.wear },
      uFeather: { value: look.feather },
      uEdgeLight: { value: look.edgeLight },
      uGrass: { value: new THREE.Color(0x4b5c2c) },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aAcross; attribute float aStrip; varying float vAcross; varying float vStrip;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAcross = aAcross; vStrip = aStrip;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uMacro; uniform float uTile; uniform vec2 uTrack; uniform float uTrackDark; uniform float uWear; uniform float uFeather; uniform float uEdgeLight; uniform vec3 uGrass;
        varying float vAcross; varying float vStrip; float gRough; float gTrack;`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        vec2 wuv = vMapUv;
        vec4 texel = texture2D(map, wuv / uTile);
        vec3 macro = texture2D(uMacro, vec2(wuv.x / 8.0 + 0.37, wuv.y / 16.0)).rgb;
        float a = abs(vAcross);
        vec3 col = texel.rgb * (1.0 + (macro.r - 0.5) * 2.0 * uWear);
        // Wheel tracks: the binder polished dark where the tyres run.
        float t1 = (a - uTrack.x) / 0.13;
        float t2 = (a - uTrack.y) / 0.13;
        gTrack = exp(-t1 * t1) + exp(-t2 * t2);
        gTrack = clamp(gTrack, 0.0, 1.0) * (0.75 + 0.5 * macro.b);
        col *= mix(1.0, uTrackDark, gTrack);
        // More loose aggregate and dust at the very edge.
        col *= mix(1.0, 1.0 + uEdgeLight, smoothstep(0.78, 1.0, a));
        // A grass strip down the middle of a long gravel driveway.
        float strip = vStrip * (1.0 - smoothstep(0.1, 0.3, a)) * smoothstep(0.35, 0.6, macro.r + 0.2);
        col = mix(col, uGrass * (0.75 + 0.5 * macro.b), strip);
        gRough = (0.65 + 0.7 * macro.b) * mix(1.0, 0.82, gTrack);
        diffuseColor.rgb *= col;
        // The edge feathers into the shoulder rather than stopping on a line.
        float fn = (macro.r - 0.5) * 0.35 + (macro.b - 0.5) * 0.2;
        diffuseColor.a *= 1.0 - smoothstep(uFeather + fn, 1.0 + fn * 0.5, a);`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * gRough;")
      .replace(
        "#include <normal_fragment_maps>",
        `vec3 mapN = texture2D(normalMap, vNormalMapUv / uTile).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale * mix(1.0, 0.5, gTrack);
        normal = normalize(tbn * mapN);`,
      );
  };
  return mat;
}

interface Strip {
  pos: number[];
  uv: number[];
  across: number[];
  strip: number[];
  idx: number[];
}

function newStrip(): Strip {
  return { pos: [], uv: [], across: [], strip: [], idx: [] };
}

function stripGeometry(s: Strip): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(s.pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(s.uv, 2));
  g.setAttribute("aAcross", new THREE.Float32BufferAttribute(s.across, 1));
  g.setAttribute("aStrip", new THREE.Float32BufferAttribute(s.strip, 1));
  g.setIndex(s.idx);
  g.computeVertexNormals();
  return g;
}

const ACROSS = [-1, -0.5, 0, 0.5, 1];

/** The paved surface of one chain, five vertices across with a crown, flared at an apron end. */
function ribbon(c: Chain, ground: Ground, into: Strip): void {
  const a = c.trim[0];
  const b = Math.max(a + 1, c.len - c.trim[1]);
  const pts = sampleChain(c, 2, a, b);
  const hw0 = c.w / 2;
  const crown = isMainRoad(c.cls) ? 0.05 : 0.025;
  const flare = 1.7;
  const hwAt = (s: number) => {
    let hw = hw0;
    if (c.apron[0]) hw += flare * (1 - smooth01((s - a) / 6));
    if (c.apron[1]) hw += flare * (1 - smooth01((b - s) / 6));
    return hw;
  };
  const base = into.pos.length / 3;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nx = -p.tz;
    const nz = p.tx;
    const hw = hwAt(p.s);
    for (let k = 0; k < ACROSS.length; k++) {
      const f = ACROSS[k];
      const x = p.x + nx * f * hw;
      const z = p.z + nz * f * hw;
      const y = ground.heightAt(x, z) + c.lift + crown * (1 - f * f);
      into.pos.push(x, y, z);
      into.uv.push(f * hw, p.s);
      into.across.push(f);
      into.strip.push(c.strip ? 1 : 0);
    }
    if (i < n - 1) {
      const r0 = base + i * ACROSS.length;
      const r1 = r0 + ACROSS.length;
      // Across is the left-hand normal of along, so the up-facing winding is (here, across, along).
      for (let k = 0; k < ACROSS.length - 1; k++) into.idx.push(r0 + k, r0 + k + 1, r1 + k, r0 + k + 1, r1 + k + 1, r1 + k);
    }
  }
}

/** A painted line along a chain at an offset from the centre, sitting just on the surface. */
function paintLine(c: Chain, ground: Ground, offset: number, width: number, into: Strip): void {
  const a = c.trim[0];
  const b = Math.max(a + 1, c.len - c.trim[1]);
  const pts = sampleChain(c, 2, a, b);
  const hw = c.w / 2;
  const crown = 0.05;
  const base = into.pos.length / 3;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const nx = -p.tz;
    const nz = p.tx;
    for (const e of [-width / 2, width / 2]) {
      const o = offset + e;
      const x = p.x + nx * o;
      const z = p.z + nz * o;
      const f = o / hw;
      const y = ground.heightAt(x, z) + c.lift + crown * (1 - f * f) + 0.012;
      into.pos.push(x, y, z);
      into.uv.push(e < 0 ? 0 : 1, p.s / 6);
      into.across.push(0);
      into.strip.push(0);
    }
    if (i < pts.length - 1) {
      const r = base + i * 2;
      into.idx.push(r, r + 1, r + 2, r + 1, r + 3, r + 2);
    }
  }
}

export function buildRoads(data: Neighbourhood, ground: Ground): Roads {
  const group = new THREE.Group();
  const net = buildRoadNet(data);
  const macro = roadMacro();
  const surfaces = {
    chipseal: chipSealWorld(),
    asphalt: asphaltWorld(),
    gravel: gravelWorld(),
    oldasphalt: oldAsphaltWorld(),
    concrete: concreteWorld(),
    dirt: dirtWorld(),
  };
  const mainTracks: [number, number] = [0.24, 0.76];
  const driveTracks: [number, number] = [0.44, 0.44];
  const materials: Record<keyof typeof surfaces, THREE.MeshStandardMaterial> = {
    chipseal: roadMaterial(surfaces.chipseal, macro, { tracks: mainTracks, trackDark: 0.7, wear: 0.3, feather: 0.86, edgeLight: 0.14 }, { color: 0xe8ddcf }),
    asphalt: roadMaterial(surfaces.asphalt, macro, { tracks: mainTracks, trackDark: 0.8, wear: 0.2, feather: 0.9, edgeLight: 0.08 }, { color: 0xdcd5cb }),
    gravel: roadMaterial(surfaces.gravel, macro, { tracks: driveTracks, trackDark: 0.8, wear: 0.14, feather: 0.72, edgeLight: 0.0 }),
    oldasphalt: roadMaterial(surfaces.oldasphalt, macro, { tracks: driveTracks, trackDark: 0.85, wear: 0.3, feather: 0.8, edgeLight: 0.06 }),
    concrete: roadMaterial(surfaces.concrete, macro, { tracks: driveTracks, trackDark: 0.9, wear: 0.12, feather: 0.9, edgeLight: 0.0 }),
    dirt: roadMaterial(surfaces.dirt, macro, { tracks: driveTracks, trackDark: 0.88, wear: 0.2, feather: 0.55, edgeLight: 0.0 }),
  };
  const strips: Record<keyof typeof surfaces, Strip> = { chipseal: newStrip(), asphalt: newStrip(), gravel: newStrip(), oldasphalt: newStrip(), concrete: newStrip(), dirt: newStrip() };
  const white = newStrip();
  const yellow = newStrip();
  for (const c of net.chains) {
    ribbon(c, ground, strips[c.surface]);
    if (c.cls === "secondary" || c.cls === "tertiary") {
      paintLine(c, ground, -(c.w / 2 - 0.3), 0.1, white);
      paintLine(c, ground, c.w / 2 - 0.3, 0.1, white);
    }
    if (c.cls === "secondary") {
      paintLine(c, ground, -0.1, 0.1, yellow);
      paintLine(c, ground, 0.1, 0.1, yellow);
    }
  }
  const geos: THREE.BufferGeometry[] = [];
  const order: (keyof typeof surfaces)[] = ["dirt", "gravel", "oldasphalt", "concrete", "chipseal", "asphalt"];
  order.forEach((k, i) => {
    const s = strips[k];
    if (!s.idx.length) return;
    const g = stripGeometry(s);
    geos.push(g);
    const m = new THREE.Mesh(g, materials[k]);
    m.receiveShadow = true;
    m.renderOrder = 1 + i;
    group.add(m);
  });
  const whiteTex = paintTexture("#e6e4dc");
  const yellowTex = paintTexture("#d9b53a");
  const lineMats = [
    new THREE.MeshStandardMaterial({ map: whiteTex, transparent: true, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    new THREE.MeshStandardMaterial({ map: yellowTex, transparent: true, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  ];
  [white, yellow].forEach((s, i) => {
    if (!s.idx.length) return;
    const g = stripGeometry(s);
    geos.push(g);
    const m = new THREE.Mesh(g, lineMats[i]);
    m.renderOrder = 10;
    group.add(m);
  });

  // Culverts: where a driveway crosses the ditch beside a road, the pipe ends show either side of it.
  const culvertGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.4, 10, 1, true).rotateZ(Math.PI / 2);
  const culvertMat = new THREE.MeshStandardMaterial({ color: 0x55534d, roughness: 0.7, metalness: 0.35, side: THREE.DoubleSide });
  const culverts: THREE.Matrix4[] = [];
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const c of net.chains) {
    if (c.cls !== "service") continue;
    for (const end of [0, 1] as const) {
      if (!c.apron[end]) continue;
      const e = end === 0 ? c.pts[0] : c.pts[c.pts.length - 1];
      const road = net.nearest(e[0], e[1], 2, (o) => isMainRoad(o.cls));
      if (!road) continue;
      // Along the driveway, from the road centreline out to the middle of the ditch.
      const d0 = end === 0 ? c.pts[1] : c.pts[c.pts.length - 2];
      let dx = d0[0] - e[0];
      let dz = d0[1] - e[1];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const out = road.chain.w / 2 + road.chain.shoulder + 1.1;
      const cx = road.x + dx * out;
      const cz = road.z + dz * out;
      const edgeY = ground.heightAt(road.x + dx * (road.chain.w / 2 + 0.2), road.z + dz * (road.chain.w / 2 + 0.2));
      const gapY = ground.heightAt(cx + -dz * (c.w / 2 + 1.2), cz + dx * (c.w / 2 + 1.2));
      if (gapY > edgeY - 0.1) continue;
      for (const side of [-1, 1]) {
        const x = cx + -dz * side * (c.w / 2 + 0.55);
        const z = cz + dx * side * (c.w / 2 + 0.55);
        pos.set(x, ground.heightAt(x, z) + 0.05, z);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(-dz), -dx) + Math.PI / 2);
        culverts.push(m4.compose(pos, quat, one).clone());
      }
    }
  }
  const culvertMesh = new THREE.InstancedMesh(culvertGeo, culvertMat, Math.max(1, culverts.length));
  culverts.forEach((m, i) => culvertMesh.setMatrixAt(i, m));
  culvertMesh.count = culverts.length;
  culvertMesh.instanceMatrix.needsUpdate = true;
  culvertMesh.castShadow = true;
  group.add(culvertMesh);

  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
      for (const s of Object.values(surfaces)) disposeWorldSurface(s);
      macro.dispose();
      whiteTex.dispose();
      yellowTex.dispose();
      for (const m of lineMats) m.dispose();
      culvertGeo.dispose();
      culvertMat.dispose();
    },
  };
}
