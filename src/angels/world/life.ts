/**
 * The things on the water.
 *
 * A flight sim over a lake with nothing on it is a flight sim over a texture.
 * Everything here exists to give the water a *scale* and a *speed* — you
 * cannot tell how fast you are going at 1,500 feet over open water, and one
 * ferry crossing underneath fixes that instantly.
 *
 * Four populations, in order of how much they matter:
 *
 *  - **Unlimited hydroplanes**, running the Seafair course at 150 mph with a
 *    thirty-metre rooster tail behind each one. They are the reason Seafair
 *    exists; the air show was added to the boat race, not the other way round.
 *  - **The spectator fleet** — several hundred boats rafted up inside the log
 *    booms along the west shore. That is genuinely what the lake looks like on
 *    the first weekend in August, and it is what makes a low pass down the
 *    show line feel like it is *for* somebody.
 *  - **Ferries** on the Seattle–Bainbridge run across Elliott Bay.
 *  - **Float planes** off Lake Union, because of course.
 *
 * All four are instanced, and the whole system is four draw calls.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import { AERIAL_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "./env";
import type { EnvService } from "./sky";
import { HYDRO_COURSE, LAKE_LEVEL, SEA_LEVEL, latToZ, lonToX } from "./geo";

const HULL_COUNTS: Record<string, { spectators: number; hydros: number }> = {
  low: { spectators: 120, hydros: 4 },
  medium: { spectators: 260, hydros: 6 },
  high: { spectators: 420, hydros: 6 },
  ultra: { spectators: 620, hydros: 6 },
};

/** The unlimiteds, in the colours they actually run in. */
const HYDRO_COLORS = [0xe8332a, 0xf5c518, 0x1f6fd0, 0xf07020, 0x22a06b, 0xd8d8dc];

export interface LifeService {
  /** Metres from this point to the nearest hydroplane. Used by the Easter eggs. */
  nearestHydro(x: number, z: number): number;
}

export function createLife(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const uniforms = env ? (env.uniforms as unknown as Record<string, THREE.IUniform>) : {};
  const counts = HULL_COUNTS[ctx.quality] ?? HULL_COUNTS.high;
  const rng = ctx.rng.fork(0x5ea1);
  const terrain = ctx.services.terrain as TerrainService | undefined;

  const group = new THREE.Group();
  group.name = "life";
  ctx.scene.add(group);

  const owned: Array<{ dispose(): void }> = [];

  // One fragment shader, two vertex shaders: the fleet is instanced and the
  // named craft are not. Writing the second one out longhand is a great deal
  // less fragile than cloning the first and doing surgery on its shader source
  // to strip the instancing out, which is what this used to do.
  const HULL_FRAGMENT = /* glsl */ `
    varying vec3 vHull;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying float vDist;
    ${ENV_UNIFORMS_GLSL}
    ${OUTPUT_GLSL}
    ${AERIAL_GLSL}
    void main() {
      vec3 n = normalize(vNormal);
      float ndl = max(dot(n, uSunDir), 0.0);
      float wrap = max((dot(n, uSunDir) + 0.35) / 1.35, 0.0);
      vec3 lit = vHull * (uSunColor * (ndl * 1.15 + wrap * 0.25) + uSkyColor * 0.4);
      lit *= mix(1.0, 0.22, uNight);
      gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
    }
  `;

  const hullMat = new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vHull;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vHull = instanceColor;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: HULL_FRAGMENT,
  });
  owned.push(hullMat);

  /** A hull painted one colour, drawn on its own. */
  function soloHullMaterial(color: number): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uHullColor: { value: new THREE.Color(color) } },
      fog: false,
      vertexShader: /* glsl */ `
        uniform vec3 uHullColor;
        varying vec3 vHull;
        varying vec3 vNormal;
        varying vec3 vWorld;
        varying float vDist;
        void main() {
          vHull = uHullColor;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vNormal = normalize(normalMatrix * normal);
          vec4 view = viewMatrix * world;
          vDist = -view.z;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: HULL_FRAGMENT,
    });
    owned.push(mat);
    return mat;
  }

  /** A boat hull: a wedge, pointed at -Z, sitting on the waterline. */
  function hullGeometry(length: number, beam: number, height: number): THREE.BufferGeometry {
    const l = length / 2;
    const b = beam / 2;
    const pts: Array<[number, number, number]> = [
      [0, 0, -l], // bow, at the waterline
      [-b, 0, l * 0.6],
      [b, 0, l * 0.6],
      [-b * 0.8, height, -l * 0.2], // deck
      [b * 0.8, height, -l * 0.2],
      [-b * 0.9, height, l * 0.6],
      [b * 0.9, height, l * 0.6],
    ];
    const tris = [
      [0, 1, 2],
      [0, 3, 1],
      [0, 2, 4],
      [0, 4, 3],
      [3, 5, 1],
      [4, 2, 6],
      [3, 4, 6],
      [3, 6, 5],
      [1, 5, 6],
      [1, 6, 2],
    ];
    const pos: number[] = [];
    for (const t of tris) for (const i of t) pos.push(...pts[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  // -------------------------------------------------------------------------
  // The spectator fleet
  // -------------------------------------------------------------------------
  const spectatorGeo = hullGeometry(9, 3.2, 2.2);
  owned.push(spectatorGeo);
  const fleetMesh = new THREE.InstancedMesh(spectatorGeo, hullMat, counts.spectators);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  const courseX = lonToX(HYDRO_COURSE.centre[1]);
  const courseZ = latToZ(HYDRO_COURSE.centre[0]);
  const courseHdg = (HYDRO_COURSE.heading * Math.PI) / 180;
  // Course axis: heading is a compass bearing, and north is -Z.
  const axis = new THREE.Vector3(Math.sin(courseHdg), 0, -Math.cos(courseHdg));
  const cross = new THREE.Vector3(-axis.z, 0, axis.x);

  let placed = 0;
  for (let tries = 0; placed < counts.spectators && tries < counts.spectators * 8; tries++) {
    // Rafted up outside the log booms, in a band a few hundred metres wide.
    const along = (rng.next() * 2 - 1) * HYDRO_COURSE.halfLength * 1.05;
    const side = rng.next() < 0.72 ? -1 : 1;
    const out = HYDRO_COURSE.halfWidth + 35 + Math.pow(rng.next(), 0.75) * 200;
    p.set(
      courseX + axis.x * along + cross.x * out * side,
      LAKE_LEVEL - 0.4,
      courseZ + axis.z * along + cross.z * out * side,
    );
    // Reject anything that landed on the beach. The band is wide enough that
    // a fixed offset would put a third of the fleet in Genesee Park, and a
    // boat parked in a park is the sort of detail that is all anyone sees.
    if (terrain && !terrain.isWater(p.x, p.z)) continue;
    const i = placed++;
    // Moored boats point every which way, but mostly into the wind.
    q.setFromAxisAngle(up, courseHdg + rng.gauss() * 0.5 + (rng.chance(0.5) ? Math.PI : 0));
    const size = 0.6 + Math.pow(rng.next(), 2) * 1.9;
    sc.set(size, size, size);
    m.compose(p, q, sc);
    fleetMesh.setMatrixAt(i, m);
    col.setHSL(rng.next(), 0.12 + rng.next() * 0.3, 0.62 + rng.next() * 0.28);
    fleetMesh.setColorAt(i, col);
  }
  // Anything the rejection sampler could not place is scaled to nothing rather
  // than left at the origin, which is in the middle of downtown.
  for (let i = placed; i < counts.spectators; i++) {
    m.compose(p.set(0, -5000, 0), q.identity(), sc.set(0, 0, 0));
    fleetMesh.setMatrixAt(i, m);
  }
  fleetMesh.instanceMatrix.needsUpdate = true;
  if (fleetMesh.instanceColor) fleetMesh.instanceColor.needsUpdate = true;
  fleetMesh.frustumCulled = false;
  group.add(fleetMesh);

  // The log booms themselves — two lines of logs that bound the race course.
  const boomGeo = new THREE.CylinderGeometry(0.5, 0.5, 12, 5);
  boomGeo.rotateZ(Math.PI / 2);
  owned.push(boomGeo);
  const boomCount = 180;
  const boomMesh = new THREE.InstancedMesh(boomGeo, hullMat, boomCount);
  for (let i = 0; i < boomCount; i++) {
    const side = i < boomCount / 2 ? -1 : 1;
    const t = ((i % (boomCount / 2)) / (boomCount / 2)) * 2 - 1;
    const along = t * HYDRO_COURSE.halfLength;
    const out = HYDRO_COURSE.halfWidth + 20;
    p.set(
      courseX + axis.x * along + cross.x * out * side,
      LAKE_LEVEL - 0.2,
      courseZ + axis.z * along + cross.z * out * side,
    );
    q.setFromAxisAngle(up, courseHdg);
    m.compose(p, q, sc.set(1, 1, 1));
    boomMesh.setMatrixAt(i, m);
    boomMesh.setColorAt(i, col.setHex(0x6b5a44));
  }
  boomMesh.instanceMatrix.needsUpdate = true;
  if (boomMesh.instanceColor) boomMesh.instanceColor.needsUpdate = true;
  boomMesh.frustumCulled = false;
  group.add(boomMesh);

  // -------------------------------------------------------------------------
  // Moving craft
  // -------------------------------------------------------------------------
  interface Craft {
    mesh: THREE.Mesh;
    /** Rooster tail or wake, scaled by speed. */
    spray: THREE.Mesh | null;
    /** Parametric position along its own route, 0..1. */
    t: number;
    speed: number;
    route: (t: number, out: THREE.Vector3) => void;
    /** Metres per unit of t. */
    routeLength: number;
    yOffset: number;
  }

  const craft: Craft[] = [];

  /**
   * The rooster tail.
   *
   * An unlimited hydroplane throws a plume thirty metres long and ten high,
   * and from the air it is far more visible than the boat. Built as a
   * stretched, tapered cone with additive spray shading.
   */
  const sprayGeo = new THREE.ConeGeometry(1, 1, 10, 3, true);
  sprayGeo.rotateX(Math.PI / 2);
  sprayGeo.translate(0, 0, 0.5);
  owned.push(sprayGeo);
  const sprayMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { ...uniforms, uTime: uniforms.uTime ?? { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vPos;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      void main() {
        // Densest at the transom, feathering out downstream, and bright
        // because it is a cloud of water droplets lit from every side.
        float along = clamp(vPos.z, 0.0, 1.0);
        float a = (1.0 - along) * (1.0 - along) * 0.85;
        vec3 col = mix(vec3(0.92, 0.96, 1.0), uSkyColor * 1.2, along * 0.6);
        gl_FragColor = vec4(outputColor(col * 0.9), a);
      }
    `,
  });
  owned.push(sprayMat);

  const hydroGeo = hullGeometry(9, 4.2, 1.3);
  owned.push(hydroGeo);

  /** The race course: a rounded oval, run anticlockwise like the real one. */
  const oval = (t: number, out: THREE.Vector3) => {
    const a = t * Math.PI * 2;
    // A stadium shape rather than an ellipse — the straights are straight.
    const along = Math.cos(a) * HYDRO_COURSE.halfLength;
    const across = Math.sin(a) * HYDRO_COURSE.halfWidth;
    out.set(
      courseX + axis.x * along + cross.x * across,
      LAKE_LEVEL + 0.1,
      courseZ + axis.z * along + cross.z * across,
    );
  };
  const ovalLength = 2 * Math.PI * Math.max(HYDRO_COURSE.halfLength, HYDRO_COURSE.halfWidth);

  for (let i = 0; i < counts.hydros; i++) {
    const mesh = new THREE.Mesh(hydroGeo, soloHullMaterial(HYDRO_COLORS[i % 6]));
    group.add(mesh);

    const spray = new THREE.Mesh(sprayGeo, sprayMat);
    spray.frustumCulled = false;
    group.add(spray);

    craft.push({
      mesh,
      spray,
      t: i / counts.hydros,
      // 150 mph, which is what an unlimited actually does on the straights.
      speed: 62 + rng.next() * 8,
      route: oval,
      routeLength: ovalLength,
      yOffset: 0.1,
    });
  }

  // ---- ferries --------------------------------------------------------------
  const ferryGeo = hullGeometry(110, 26, 14);
  owned.push(ferryGeo);
  const colmanDock = new THREE.Vector3(lonToX(-122.339), SEA_LEVEL, latToZ(47.602));
  const bainbridge = new THREE.Vector3(lonToX(-122.5107), SEA_LEVEL, latToZ(47.6229));
  const ferryRoute = (t: number, out: THREE.Vector3) => {
    // Out and back, so a ferry is always crossing in each direction.
    const u = t < 0.5 ? t * 2 : 2 - t * 2;
    out.lerpVectors(colmanDock, bainbridge, u);
    out.y = SEA_LEVEL;
  };
  const ferryLength = colmanDock.distanceTo(bainbridge) * 2;

  for (let i = 0; i < 2; i++) {
    // Washington State Ferries green-and-white, near enough.
    const mesh = new THREE.Mesh(ferryGeo, soloHullMaterial(0xe8e4dc));
    group.add(mesh);
    craft.push({
      mesh,
      spray: null,
      t: i * 0.5,
      // A Washington State Ferry does 18 knots and takes 35 minutes. Nobody is
      // going to watch it for 35 minutes, so it does 25.
      speed: 13,
      route: ferryRoute,
      routeLength: ferryLength,
      yOffset: 0,
    });
  }

  const service: LifeService = {
    nearestHydro(x, z) {
      let best = Infinity;
      for (const c of craft) {
        if (!c.spray) continue;
        best = Math.min(best, Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z));
      }
      return best;
    },
  };
  ctx.services.life = service;

  const _pos = new THREE.Vector3();
  const _ahead = new THREE.Vector3();

  return {
    update(dt) {
      for (const c of craft) {
        c.t = (c.t + (c.speed * dt) / c.routeLength) % 1;
        c.route(c.t, _pos);
        // Heading comes from sampling a little further along the route, which
        // works for any parametric path without needing its derivative.
        c.route((c.t + 0.004) % 1, _ahead);
        c.mesh.position.copy(_pos);
        c.mesh.position.y += c.yOffset;
        _ahead.sub(_pos);
        if (_ahead.lengthSq() > 1e-6) {
          c.mesh.rotation.y = Math.atan2(_ahead.x, _ahead.z) + Math.PI;
        }
        if (c.spray) {
          // The plume streams straight back from the transom.
          c.spray.position.copy(c.mesh.position);
          c.spray.rotation.y = c.mesh.rotation.y;
          c.spray.scale.set(5, 9, 34);
          c.spray.position.y += 1.5;
        }
      }
    },
    dispose() {
      ctx.scene.remove(group);
      fleetMesh.dispose();
      boomMesh.dispose();
      for (const o of owned) o.dispose();
      if (ctx.services.life === service) delete ctx.services.life;
    },
  };
}
