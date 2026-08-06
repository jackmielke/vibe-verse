/**
 * The race. You, an unlimited hydroplane, and the Seafair course.
 *
 * Seafair is a boat race that grew an air show. The boats have been out on the
 * lake since the first version of this world, running the real course at the
 * real speed, and being unable to be one of them was always the obvious hole in
 * it. This is the hole filled: the same 3.2 km oval off Stan Sayres, the same
 * six-boat field, and you in the seventh.
 *
 * ## What this system does and does not own
 *
 * It owns the player's boat — the hull, the physics in `hydro/boat.ts`, the
 * rooster tail, the lap timing and the scoring. It does *not* own the other
 * boats: `world/life.ts` was already driving six of them round the right oval
 * at the right speed, and duplicating that to have something to race against
 * would have put twelve hydroplanes on a lake that holds six. It publishes
 * their course progress instead and this reads it.
 *
 * ## Reusing the crash
 *
 * A blowover emits `angels:crash`, which means the fireball, the camera shake,
 * the slow motion, the boom and the white flash all arrive without this file
 * knowing any of them exist. That is the whole point of the event bus, and it
 * is why a hydroplane going over backwards looks as expensive as a jet flying
 * into the Space Needle on the first try.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import { HYDRO_COURSE, LAKE_LEVEL, latToZ, lonToX } from "../world/geo";
import type { LifeService } from "../world/life";
import { AERIAL_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "../world/env";
import type { EnvService } from "../world/sky";
import {
  UNLIMITED,
  createBoatState,
  placeBoat,
  stepBoat,
  type BoatControls,
  type BoatEnvironment,
  type BoatState,
} from "../hydro/boat";

/**
 * Laps in a heat.
 *
 * The real thing runs five round a two-mile course. This oval is a shade over
 * five kilometres and an unlimited takes about seventy seconds to get round it,
 * so five would be six minutes of racing before anything is decided. Two is a
 * race you can lose in the first corner and still win.
 */
export const RACE_LAPS = 2;

/** How long you watch the wreckage before the boat is handed back. */
const WRECK_SECONDS = 4;

export interface HydroService {
  /** True while the race owns the world. */
  readonly active: boolean;
  readonly state: BoatState;
  /** 0..1 round the oval, and how many times round. */
  readonly progress: { t: number; laps: number };
  /** 1 is the lead. Counts the six AI boats. */
  readonly place: number;
  readonly field: number;
  readonly lapTime: number;
  readonly bestLap: number;
  readonly totalTime: number;
  readonly finished: boolean;
  readonly laps: number;
  readonly wreck: { active: boolean; timer: number; duration: number };
  /** Where the boat is looking, for the camera. */
  readonly forward: THREE.Vector3;
  readonly position: THREE.Vector3;
  start(): void;
  stop(): void;
  restart(): void;
}

export function createHydro(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const uniforms = env ? (env.uniforms as unknown as Record<string, THREE.IUniform>) : {};
  const terrain = ctx.services.terrain as TerrainService | undefined;

  const group = new THREE.Group();
  group.name = "hydro";
  group.visible = false;
  ctx.scene.add(group);

  const owned: Array<{ dispose(): void }> = [];

  // ---- the course ----------------------------------------------------------

  const courseX = lonToX(HYDRO_COURSE.centre[1]);
  const courseZ = latToZ(HYDRO_COURSE.centre[0]);
  const head = (HYDRO_COURSE.heading * Math.PI) / 180;
  /** Along the course's long axis. */
  const axis = new THREE.Vector3(Math.sin(head), 0, -Math.cos(head));
  /** Across it. */
  const cross = new THREE.Vector3(axis.z, 0, -axis.x);

  const _p = new THREE.Vector3();
  /** The racing line, as the AI boats run it — anticlockwise round the oval. */
  function oval(t: number, out: THREE.Vector3): THREE.Vector3 {
    const a = t * Math.PI * 2;
    const along = Math.cos(a) * HYDRO_COURSE.halfLength;
    const across = Math.sin(a) * HYDRO_COURSE.halfWidth;
    return out.set(
      courseX + axis.x * along + cross.x * across,
      LAKE_LEVEL + 0.1,
      courseZ + axis.z * along + cross.z * across,
    );
  }

  /**
   * Where a point is round the course, 0..1.
   *
   * The oval is a Lissajous of the two course axes, so inverting it is one
   * `atan2` of the projections — no search, no nearest-point-on-a-polyline, and
   * exactly the same parameter the AI boats are already using.
   */
  function courseParam(x: number, z: number): number {
    const dx = x - courseX;
    const dz = z - courseZ;
    const along = (dx * axis.x + dz * axis.z) / HYDRO_COURSE.halfLength;
    const across = (dx * cross.x + dz * cross.z) / HYDRO_COURSE.halfWidth;
    const a = Math.atan2(across, along);
    return (a / (Math.PI * 2) + 1) % 1;
  }

  // ---- the boat ------------------------------------------------------------

  const state = createBoatState();
  const controls: BoatControls = { throttle: 0, steer: 0 };

  const hullMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uHullColor: { value: new THREE.Color(0xf0d022) } },
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vDist;
      void main() {
        vLocal = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(normalMatrix * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHullColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vDist;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}
      void main() {
        vec3 n = normalize(vNormal);
        // Two-tone down the centreline, the way every unlimited has ever been
        // painted: a hull colour and a white deck flash.
        // Hull colour outboard of the centreline, white down the middle.
        float flash = smoothstep(0.30, 0.46, abs(vLocal.x) / 2.2);
        vec3 col = mix(vec3(0.94, 0.95, 0.97), uHullColor, flash);
        // Sponson bottoms are bare metal.
        if (vLocal.y < 0.10) col = vec3(0.32, 0.33, 0.36);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max((dot(n, uSunDir) + 0.35) / 1.35, 0.0);
        vec3 lit = col * (uSunColor * (ndl * 1.1 + wrap * 0.3) + uSkyColor * 0.42);
        lit *= mix(1.0, 0.3, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });
  owned.push(hullMat);

  /**
   * A three-point hull, which is the shape of the whole class.
   *
   * Two sponsons out front on either side of a tunnel, a long flat afterbody
   * between them, the turbine cowling and the canopy on the centreline, and a
   * vertical fin over the transom. Draw it as a wedge — which is what the
   * scenery boats are — and it reads as a speedboat; the tunnel between the
   * sponsons is the silhouette everybody actually recognises.
   */
  function buildHull(): THREE.Group {
    const g = new THREE.Group();
    // The offset is baked into the geometry rather than set on the mesh,
    // because the paint scheme in the shader keys off `position` — and with a
    // per-part mesh transform that is the position within *that box*, never
    // more than half a metre from its own centre. The whole boat came out
    // white: every fragment tested inboard of the centreline stripe.
    const add = (geo: THREE.BufferGeometry, x = 0, y = 0, z = 0) => {
      geo.translate(x, y, z);
      owned.push(geo);
      const m = new THREE.Mesh(geo, hullMat);
      g.add(m);
      return m;
    };

    const L = UNLIMITED.length;
    const B = UNLIMITED.beam;

    // Afterbody: the flat plank the whole thing is built on.
    add(new THREE.BoxGeometry(B * 0.46, 0.42, L * 0.78), 0, 0.24, L * 0.12);
    // Sponsons, splayed forward and outboard.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(B * 0.30, 0.55, L * 0.44), (side * B) / 2.4, 0.28, -L * 0.26);
    }
    // The bridge between them, well clear of the water — the tunnel.
    add(new THREE.BoxGeometry(B * 0.98, 0.28, L * 0.16), 0, 0.62, -L * 0.3);
    // Turbine cowling and canopy.
    add(new THREE.BoxGeometry(B * 0.42, 0.5, L * 0.3), 0, 0.68, L * 0.08);
    const canopyGeo = new THREE.SphereGeometry(0.52, 12, 8);
    canopyGeo.scale(1, 0.8, 1.5);
    add(canopyGeo, 0, 0.98, -L * 0.06);
    // Fin over the transom, which is where the number goes.
    add(new THREE.BoxGeometry(0.14, 1.05, L * 0.2), 0, 0.95, L * 0.4);
    add(new THREE.BoxGeometry(B * 0.5, 0.1, L * 0.1), 0, 1.42, L * 0.42);
    return g;
  }

  const hull = buildHull();
  group.add(hull);

  // ---- the rooster tail ----------------------------------------------------
  // The thing you can see from a mile away, and the only reason anybody knows
  // what an unlimited looks like from the shore. Thirty metres long, ten high.

  const plumeGeo = new THREE.ConeGeometry(1, 1, 14, 6, true);
  plumeGeo.rotateX(Math.PI / 2);
  owned.push(plumeGeo);
  const plumeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uStrength: { value: 0 }, uExposure: uniforms.uExposure ?? { value: 0.66 } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec3 vPos;
      ${OUTPUT_GLSL}
      void main() {
        // Dense at the transom, breaking up downstream, and thinner at the
        // edges — it is a curtain of water, not a solid cone.
        float along = clamp(vPos.z * 0.5 + 0.5, 0.0, 1.0);
        float a = uStrength * pow(1.0 - along, 1.6) * 0.34;
        gl_FragColor = vec4(outputColor(vec3(1.5, 1.62, 1.75)), a);
      }
    `,
  });
  owned.push(plumeMat);
  const plume = new THREE.Mesh(plumeGeo, plumeMat);
  plume.frustumCulled = false;
  plume.renderOrder = 12;
  group.add(plume);

  // ---- state ---------------------------------------------------------------

  let active = false;
  let laps = 0;
  let lastParam = 0;
  let lapTime = 0;
  let bestLap = 0;
  let totalTime = 0;
  let finished = false;
  let place = 1;
  /**
   * Each AI boat's course progress when the flag dropped.
   *
   * Scoring on absolute position round the oval would mean starting sixth of
   * seven purely because the field happens to be spread out — they have been
   * circulating as scenery since the world booted. Measuring everybody's
   * progress *since the start* is the race that was actually run.
   */
  const baseline: number[] = [];
  const wreck = { active: false, timer: 0, duration: WRECK_SECONDS };
  const forward = new THREE.Vector3(0, 0, -1);
  const position = new THREE.Vector3();

  const life = () => ctx.services.life as LifeService | undefined;

  const boatEnv: BoatEnvironment = {
    wake(x, z) {
      // The only rough water that matters is somebody else's rooster tail, and
      // the danger zone is close behind — which is exactly where you have to be
      // to pass. That tension is the race.
      const l = life();
      if (!l) return 0;
      const d = l.nearestHydro(x, z);
      return Math.max(0, 1 - d / 55);
    },
    onWater(x, z) {
      return terrain ? terrain.isWater(x, z) : true;
    },
  };

  function gridPosition(): void {
    // On the start line, which on this course is the middle of the front
    // straight, pointed the way the field runs.
    oval(0.02, _p);
    const ahead = oval(0.05, new THREE.Vector3()).sub(_p);
    placeBoat(state, _p.x, LAKE_LEVEL, _p.z, Math.atan2(ahead.x, -ahead.z));
    laps = 0;
    lastParam = courseParam(state.x, state.z);
    lapTime = 0;
    bestLap = 0;
    totalTime = 0;
    finished = false;
    wreck.active = false;
    wreck.timer = 0;
    baseline.length = 0;
    for (const h of life()?.hydros ?? []) baseline.push(h.laps + h.t);
  }

  const service: HydroService = {
    get active() {
      return active;
    },
    state,
    progress: { t: 0, laps: 0 },
    get place() {
      return place;
    },
    get field() {
      return (life()?.hydros.length ?? 0) + 1;
    },
    get lapTime() {
      return lapTime;
    },
    get bestLap() {
      return bestLap;
    },
    get totalTime() {
      return totalTime;
    },
    get finished() {
      return finished;
    },
    get laps() {
      return laps;
    },
    wreck,
    forward,
    position,
    start() {
      active = true;
      group.visible = true;
      gridPosition();
      // The AI field is scenery at full pace and a race at a slightly gentler
      // one: six boats running a clean 62 m/s never make a mistake, and a race
      // you cannot win is a demo with a lap counter on it.
      life()?.setHydroPace(0.88);
      baseline.length = 0;
      for (const h of life()?.hydros ?? []) baseline.push(h.laps + h.t);
      ctx.emit("angels:hydro", true);
    },
    stop() {
      active = false;
      group.visible = false;
      life()?.setHydroPace(1);
      ctx.emit("angels:hydro", false);
    },
    restart() {
      gridPosition();
    },
  };
  ctx.services.hydro = service;

  const _ahead = new THREE.Vector3();
  /** Integrated from the up/down keys — a boat has a lever, not a pedal. */
  let lever = 0;

  return {
    fixedUpdate(dt, c) {
      if (!active) return;

      if (wreck.active) {
        wreck.timer += dt;
        stepBoat(state, UNLIMITED, { throttle: 0, steer: 0 }, boatEnv, dt);
        if (wreck.timer >= wreck.duration) {
          gridPosition();
          lever = 0;
        }
        return;
      }

      if (c.input.resetPressed) {
        gridPosition();
        lever = 0;
        return;
      }

      // A thumb on the touch throttle is an absolute lever; a keyboard is not,
      // so up and down open and close it and it stays where it was put.
      if (c.input.touch) {
        lever = c.input.throttle;
      } else {
        lever = Math.max(0, Math.min(1, lever + c.input.steerY * dt * 1.1));
        // Nothing held and no throttle set yet: a race that will not start
        // because the player has not discovered the accelerator is a bad first
        // ten seconds, so it idles forward.
        if (state.age < 1.5 && lever < 0.35) lever = 0.35;
      }
      controls.throttle = lever;
      controls.steer = c.input.steerX;
      if (c.input.brake > 0.5) controls.throttle = 0;

      const before = state.speed;
      const outcome = stepBoat(state, UNLIMITED, controls, boatEnv, dt);
      void before;

      if (outcome.blewOver) {
        wreck.active = true;
        wreck.timer = 0;
        ctx.emit("angels:crash", {
          position: { x: state.x, y: LAKE_LEVEL + 2, z: state.z },
          speed: state.speed,
          cause: "the water",
          landmark: null,
        });
        return;
      }

      // ---- laps ------------------------------------------------------------
      if (!finished) {
        totalTime += dt;
        lapTime += dt;
      }
      const t = courseParam(state.x, state.z);
      // Crossing the line: the parameter wraps from just under 1 to just over
      // 0. Guard against the wrong direction, so reversing over the line does
      // not award a lap.
      if (lastParam > 0.85 && t < 0.15) {
        laps++;
        if (bestLap === 0 || lapTime < bestLap) bestLap = lapTime;
        lapTime = 0;
        if (laps >= RACE_LAPS && !finished) {
          finished = true;
          ctx.emit("angels:hydrofinish", { place, time: totalTime, best: bestLap });
        }
      } else if (lastParam < 0.15 && t > 0.85) {
        laps = Math.max(0, laps - 1);
      }
      lastParam = t;
      service.progress.t = t;
      service.progress.laps = laps;

      // ---- who is winning --------------------------------------------------
      const field = life()?.hydros ?? [];
      const mine = laps + t - 0.02; // the grid slot is a fifty-metre head start
      let ahead = 0;
      for (let i = 0; i < field.length; i++) {
        const gone = field[i].laps + field[i].t - (baseline[i] ?? 0);
        if (gone > mine) ahead++;
      }
      place = ahead + 1;
    },

    lateUpdate(_dt, c) {
      if (!active) return;
      position.set(state.x, LAKE_LEVEL, state.z);
      forward.set(Math.sin(state.heading), 0, -Math.cos(state.heading));

      hull.position.copy(position);
      // The hull rides higher as it comes up onto the sponsons, and the pitch
      // and roll are what make it look like a hydroplane rather than a model
      // being dragged along a line.
      hull.position.y += 0.15 + state.planing * 0.35 + state.lift * 1.4;
      hull.rotation.set(0, 0, 0);
      hull.rotateY(-state.heading);
      hull.rotateX(-state.pitch - state.lift * 0.8);
      hull.rotateZ(state.roll);

      const strength = Math.min(1, Math.max(0, (state.speed - 12) / 40)) * (state.blownOver ? 0.3 : 1);
      plume.visible = strength > 0.02;
      if (plume.visible) {
        const len = 8 + strength * 13;
        plume.position.copy(hull.position);
        plume.position.addScaledVector(forward, -UNLIMITED.length * 0.55);
        plume.position.y += 1.2;
        // Grows out and up behind the transom, leaning back as it goes.
        plume.rotation.set(0, -state.heading, 0);
        plume.scale.set(1.4 + strength * 1.7, 1.8 + strength * 3.4, len);
        plume.position.addScaledVector(forward, -len * 0.5);
        plume.position.y += len * 0.16;
        plumeMat.uniforms.uStrength.value = strength;
      }
      void c;
    },

    dispose() {
      ctx.scene.remove(group);
      for (const o of owned) o.dispose();
      owned.length = 0;
      if (ctx.services.hydro === service) delete ctx.services.hydro;
    },
  };
}
