/**
 * Hoops, and the routes they hang along.
 *
 * Six courses, every one of them a real line through the real city:
 *
 *  - **The Show Line** — the Seafair box over Lake Washington, north to south
 *    between the I-90 bridges and Seward Park. Where the demo actually happens.
 *  - **Needle Run** — in off Elliott Bay, around the Space Needle, and out
 *    between the downtown towers.
 *  - **The Cut** — Ballard Locks to Lake Washington along the Ship Canal, under
 *    every bridge, through the Montlake Cut with Husky Stadium on the bank.
 *    Thirty metres wide. Good luck.
 *  - **Bridge Run** — both floating bridges, the West Seattle Bridge and the
 *    Aurora, low enough to matter.
 *  - **Rainier Dash** — south-east out of the box, climbing at the mountain.
 *  - **Elliott Bay Circuit** — ferries, Alki, the waterfront, Harbor Island.
 *
 * A hoop is passed when the segment between last frame's position and this
 * frame's crosses its plane inside the radius. Checking a distance instead
 * would miss at 300 knots, where a jet covers 150 m in a single frame — which
 * is exactly the kind of bug that makes a game feel unfair for no visible
 * reason.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import type { FleetService } from "./fleet";
import { latToZ, lonToX, type LatLon } from "../world/geo";

export interface HoopSpec {
  /** Where, in the real world. */
  at: LatLon;
  /** Metres above the ground or water below it. */
  agl: number;
  radius: number;
  /** Heading you should be flying when you go through, degrees true. */
  heading: number;
  /** Tilt the hoop back this many degrees — for climbing gates. */
  pitch?: number;
  label?: string;
}

export interface CourseSpec {
  id: string;
  name: string;
  blurb: string;
  /** Roughly how long a clean run takes, seconds. Used for the par time. */
  par: number;
  accent: number;
  hoops: HoopSpec[];
}

export const COURSES: CourseSpec[] = [
  {
    id: "showline",
    name: "The Show Line",
    blurb:
      "The Seafair box, north to south down Lake Washington. Low, straight, and in front of a hundred thousand people.",
    par: 62,
    accent: 0xffc61e,
    hoops: [
      { at: [47.5885, -122.2705], agl: 300, radius: 60, heading: 160, label: "Run in" },
      { at: [47.5805, -122.2685], agl: 220, radius: 52, heading: 160 },
      { at: [47.5715, -122.2665], agl: 150, radius: 46, heading: 160, label: "The pits" },
      { at: [47.564, -122.265], agl: 90, radius: 40, heading: 160, label: "Show centre" },
      { at: [47.5565, -122.2615], agl: 150, radius: 46, heading: 160 },
      { at: [47.5515, -122.2545], agl: 400, radius: 60, heading: 120, pitch: 24, label: "Break" },
      { at: [47.5585, -122.2415], agl: 700, radius: 70, heading: 20 },
      { at: [47.5745, -122.2455], agl: 500, radius: 60, heading: 340 },
      { at: [47.5865, -122.2585], agl: 260, radius: 50, heading: 300, label: "Rejoin" },
    ],
  },
  {
    id: "needle",
    name: "Needle Run",
    blurb:
      "In off Elliott Bay, around the Space Needle, out through the towers. The one every visitor asks for.",
    par: 58,
    accent: 0x35d6ff,
    hoops: [
      { at: [47.6, -122.375], agl: 260, radius: 60, heading: 55, label: "In off the bay" },
      { at: [47.6075, -122.3555], agl: 180, radius: 48, heading: 40 },
      { at: [47.6155, -122.3505], agl: 150, radius: 42, heading: 15, label: "Under the monorail" },
      { at: [47.6215, -122.3435], agl: 210, radius: 40, heading: 110, label: "Round the Needle" },
      { at: [47.6165, -122.3385], agl: 190, radius: 42, heading: 175 },
      { at: [47.609, -122.3345], agl: 320, radius: 44, heading: 190, label: "Between the towers" },
      { at: [47.5985, -122.3335], agl: 240, radius: 48, heading: 200 },
      { at: [47.5925, -122.332], agl: 160, radius: 50, heading: 215, label: "Over the stadiums" },
      { at: [47.586, -122.345], agl: 200, radius: 58, heading: 250 },
    ],
  },
  {
    id: "cut",
    name: "The Cut",
    blurb:
      "Ballard Locks to Lake Washington along the Ship Canal, under every bridge on the way. Thirty metres of water and no room to change your mind.",
    par: 66,
    accent: 0x6cff9d,
    hoops: [
      { at: [47.6656, -122.3972], agl: 90, radius: 55, heading: 100, label: "Over the locks" },
      { at: [47.6585, -122.3765], agl: 45, radius: 38, heading: 130, label: "Ballard Bridge" },
      { at: [47.651, -122.356], agl: 40, radius: 34, heading: 108, label: "Fremont Cut" },
      { at: [47.6478, -122.3496], agl: 32, radius: 30, heading: 95, label: "Under the Fremont" },
      { at: [47.647, -122.334], agl: 60, radius: 46, heading: 88, label: "Lake Union" },
      { at: [47.6533, -122.3205], agl: 42, radius: 34, heading: 55, label: "University Bridge" },
      { at: [47.6465, -122.3055], agl: 34, radius: 28, heading: 88, label: "Montlake Cut" },
      { at: [47.6472, -122.2965], agl: 34, radius: 28, heading: 85, label: "Husky Stadium" },
      { at: [47.6595, -122.2745], agl: 120, radius: 55, heading: 40, label: "Out onto the lake" },
    ],
  },
  {
    id: "bridges",
    name: "Bridge Run",
    blurb:
      "Both floating bridges, the high span at West Seattle, and the Aurora. Under is worth more than over.",
    par: 78,
    accent: 0xff7a45,
    hoops: [
      { at: [47.5899, -122.2836], agl: 14, radius: 34, heading: 92, label: "I-90 west" },
      { at: [47.5897, -122.2665], agl: 14, radius: 34, heading: 92, label: "I-90 mid" },
      { at: [47.5895, -122.2568], agl: 60, radius: 48, heading: 60, label: "Mercer Island" },
      { at: [47.6408, -122.2593], agl: 16, radius: 36, heading: 272, label: "SR-520 mid" },
      { at: [47.6415, -122.2745], agl: 90, radius: 50, heading: 280 },
      { at: [47.6475, -122.3475], agl: 26, radius: 30, heading: 268, label: "Under the Aurora" },
      { at: [47.5905, -122.3455], agl: 120, radius: 55, heading: 215 },
      { at: [47.5713, -122.3505], agl: 20, radius: 30, heading: 268, label: "Under West Seattle" },
    ],
  },
  {
    id: "rainier",
    name: "Rainier Dash",
    blurb:
      "Out of the box south-east and climb at the mountain. Twenty thousand feet, and it still fills the windscreen.",
    par: 95,
    accent: 0xd88cff,
    hoops: [
      { at: [47.5545, -122.2545], agl: 400, radius: 70, heading: 150, pitch: 12 },
      { at: [47.52, -122.21], agl: 1400, radius: 90, heading: 152, pitch: 22 },
      { at: [47.46, -122.13], agl: 3000, radius: 120, heading: 153, pitch: 26 },
      { at: [47.38, -122.03], agl: 4600, radius: 150, heading: 153, pitch: 20 },
      { at: [47.3, -121.95], agl: 5600, radius: 170, heading: 333, label: "Turn for home" },
      { at: [47.45, -122.16], agl: 3200, radius: 140, heading: 333 },
      { at: [47.5545, -122.2545], agl: 800, radius: 90, heading: 333, label: "Home" },
    ],
  },
  {
    id: "elliott",
    name: "Elliott Bay Circuit",
    blurb:
      "Round the waterfront the way the ferries go: Colman Dock, Alki, Duwamish Head, and back past the Great Wheel.",
    par: 84,
    accent: 0x4fd1c5,
    hoops: [
      { at: [47.6061, -122.3425], agl: 80, radius: 45, heading: 250, label: "The Great Wheel" },
      { at: [47.6, -122.375], agl: 120, radius: 55, heading: 260 },
      { at: [47.5905, -122.38], agl: 60, radius: 45, heading: 215, label: "Duwamish Head" },
      { at: [47.5762, -122.4202], agl: 70, radius: 45, heading: 190, label: "Alki Point" },
      { at: [47.556, -122.411], agl: 160, radius: 60, heading: 150 },
      { at: [47.5715, -122.3505], agl: 60, radius: 45, heading: 45, label: "The Duwamish" },
      { at: [47.5985, -122.345], agl: 100, radius: 50, heading: 20 },
      { at: [47.6215, -122.362], agl: 140, radius: 55, heading: 340, label: "Myrtle Edwards" },
      { at: [47.662, -122.4357], agl: 90, radius: 55, heading: 300, label: "West Point" },
    ],
  },
];

export interface Hoop {
  spec: HoopSpec;
  position: THREE.Vector3;
  /** Unit normal, the direction you should be going through it. */
  normal: THREE.Vector3;
  radius: number;
  mesh: THREE.Mesh;
  index: number;
}

export interface CourseService {
  courses: CourseSpec[];
  /** Load a course's hoops into the world. Null clears them. */
  load(id: string | null): void;
  active: CourseSpec | null;
  hoops: Hoop[];
  /** Index of the hoop the player should fly through next. */
  next: number;
  /** Reset progress without reloading the geometry. */
  restart(): void;
}

export function createCourses(ctx: AngelsCtx): System {
  const terrain = ctx.services.terrain as TerrainService | undefined;
  const group = new THREE.Group();
  group.name = "courses";
  ctx.scene.add(group);

  const torusGeo = new THREE.TorusGeometry(1, 0.055, 10, 44);

  /**
   * Hoops read as *gates*, not as decoration, because they are additive,
   * unlit, and pulse. The pulse is not fluff — the next hoop pulses and the
   * ones after it do not, which is the whole navigation system.
   */
  const hoopMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffc61e) },
      uState: { value: 0 }, // 0 upcoming, 1 next, 2 cleared
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uState;
      uniform float uTime;
      varying vec3 vPos;
      void main() {
        float pulse = 0.55 + 0.45 * sin(uTime * 3.4 + atan(vPos.y, vPos.x) * 3.0);
        float bright = uState < 0.5 ? 0.30 : (uState < 1.5 ? 0.75 + pulse * 0.85 : 0.14);
        vec3 col = uState > 1.5 ? mix(uColor, vec3(0.4, 1.0, 0.55), 0.7) : uColor;
        gl_FragColor = vec4(col * bright, min(1.0, bright));
      }
    `,
  });

  let active: CourseSpec | null = null;
  const hoops: Hoop[] = [];
  let next = 0;

  function clear(): void {
    for (const h of hoops) {
      group.remove(h.mesh);
      (h.mesh.material as THREE.Material).dispose();
    }
    hoops.length = 0;
    active = null;
    next = 0;
  }

  function load(id: string | null): void {
    clear();
    if (!id) {
      ctx.emit("angels:course", null);
      return;
    }
    const course = COURSES.find((c) => c.id === id);
    if (!course) return;
    active = course;

    for (let i = 0; i < course.hoops.length; i++) {
      const spec = course.hoops[i];
      const x = lonToX(spec.at[1]);
      const z = latToZ(spec.at[0]);
      const ground = terrain?.surfaceAt(x, z) ?? 0;
      const position = new THREE.Vector3(x, ground + spec.agl, z);

      const yaw = (spec.heading * Math.PI) / 180;
      const pitch = ((spec.pitch ?? 0) * Math.PI) / 180;
      const normal = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      ).normalize();

      const mat = hoopMat.clone();
      mat.uniforms.uColor.value = new THREE.Color(course.accent);
      const mesh = new THREE.Mesh(torusGeo, mat);
      mesh.position.copy(position);
      // The torus lies in its own XY plane; point its +Z along the normal.
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      mesh.scale.setScalar(spec.radius);
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      group.add(mesh);

      hoops.push({ spec, position, normal, radius: spec.radius, mesh, index: i });
    }
    next = 0;
    ctx.emit("angels:course", course.id);
  }

  const service: CourseService = {
    courses: COURSES,
    load,
    get active() {
      return active;
    },
    hoops,
    get next() {
      return next;
    },
    restart() {
      next = 0;
      ctx.emit("angels:course-restart", active?.id ?? null);
    },
  };
  ctx.services.courses = service;

  const lastPos = new THREE.Vector3();
  let haveLast = false;
  const _seg = new THREE.Vector3();
  const _rel = new THREE.Vector3();
  const _hit = new THREE.Vector3();

  return {
    update(dt, c) {
      hoopMat.uniforms.uTime.value = c.elapsed;
      const fleet = c.services.fleet as FleetService | undefined;
      if (!fleet) return;
      const pos = fleet.player.state.position;

      for (const h of hoops) {
        const mat = h.mesh.material as THREE.ShaderMaterial;
        mat.uniforms.uTime.value = c.elapsed;
        mat.uniforms.uState.value = h.index < next ? 2 : h.index === next ? 1 : 0;
      }

      if (!haveLast) {
        lastPos.copy(pos);
        haveLast = true;
        return;
      }

      if (active && next < hoops.length) {
        const h = hoops[next];
        // Did the path between frames cross this hoop's plane?
        _rel.subVectors(lastPos, h.position);
        const dPrev = _rel.dot(h.normal);
        _rel.subVectors(pos, h.position);
        const dNow = _rel.dot(h.normal);

        if (dPrev < 0 && dNow >= 0) {
          _seg.subVectors(pos, lastPos);
          const t = dPrev === dNow ? 0 : -dPrev / (dNow - dPrev);
          _hit.copy(lastPos).addScaledVector(_seg, t);
          const miss = _hit.distanceTo(h.position);
          if (miss <= h.radius) {
            // Dead centre is worth more than scraping the rim.
            const accuracy = 1 - miss / h.radius;
            next++;
            ctx.emit("angels:hoop", {
              index: h.index,
              total: hoops.length,
              accuracy,
              label: h.spec.label,
              last: next >= hoops.length,
            });
          }
        }
      }

      lastPos.copy(pos);
    },

    dispose() {
      clear();
      ctx.scene.remove(group);
      torusGeo.dispose();
      hoopMat.dispose();
      if (ctx.services.courses === service) delete ctx.services.courses;
    },
  };
}
