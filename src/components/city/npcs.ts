/**
 * npcs — residents of Vibe City.
 *
 * A small crew of Quaternius characters (a different model each) who
 * wander the street grid: they walk the sidewalks, decide at every
 * intersection whether to turn, and turn around at the city limits.
 * Two of them live up on Cardboard Island and pace its stone paths.
 *
 * Skinned models must be cloned with SkeletonUtils (a plain .clone()
 * breaks the bone bindings), and every clone gets its own mixer with
 * a slightly different walk speed so the crowd doesn't march in step.
 *
 * Mixers only tick within ~150m of the player — distant NPCs still
 * move, they just stop paying for bone animation.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface NpcCrew {
  group: THREE.Group;
  update(dt: number, playerPos: THREE.Vector3): void;
}

interface Npc {
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  axis: "x" | "z";
  dir: 1 | -1;
  line: number; // the street (or path) line being walked, in world coords
  lateral: number; // sidewalk offset from the line
  speed: number;
  y: number;
  yaw: number;
  nextDecision: number; // coordinate of the next intersection
  bounds: [number, number]; // walkable range along the axis
  isIsland: boolean;
}

const ANIM_CULL_DIST_SQ = 150 * 150;

export function createNpcCrew(opts: {
  urls: string[];
  streetLines: number[]; // street center coordinates, both axes
  cityHalf: number;
  island: { x: number; z: number; topY: number };
}): NpcCrew {
  const { urls, streetLines, cityHalf, island } = opts;
  const group = new THREE.Group();
  const npcs: Npc[] = [];
  const interior = streetLines.slice(1, -1); // skip the outer ring

  const nextIntersection = (coord: number, dir: 1 | -1): number => {
    let best = dir > 0 ? Infinity : -Infinity;
    for (const line of streetLines) {
      if (dir > 0 && line > coord + 1 && line < best) best = line;
      if (dir < 0 && line < coord - 1 && line > best) best = line;
    }
    return Number.isFinite(best) ? best : dir * cityHalf;
  };

  const placeOnStreets = (obj: THREE.Object3D, mixer: THREE.AnimationMixer | null, i: number) => {
    const axis: "x" | "z" = i % 2 === 0 ? "x" : "z";
    const line = interior[(i * 3 + 1) % interior.length];
    // Bias half of the crew toward the plaza so the streets feel
    // inhabited right where players spawn.
    const start = i % 2 === 0 ? -50 + (i * 23) % 100 : (i * 37) % (cityHalf * 1.4) - cityHalf * 0.7;
    const npc: Npc = {
      obj,
      mixer,
      axis,
      dir: i % 3 === 0 ? -1 : 1,
      line,
      lateral: (i % 2 === 0 ? 1 : -1) * (3 + (i % 3)),
      speed: 1.3 + (i % 4) * 0.35,
      y: 0,
      yaw: 0,
      nextDecision: 0,
      bounds: [-cityHalf + 16, cityHalf - 16],
      isIsland: false,
    };
    npc.nextDecision = nextIntersection(start, npc.dir);
    if (axis === "x") obj.position.set(start, 0, line + npc.lateral);
    else obj.position.set(line + npc.lateral, 0, start);
    npcs.push(npc);
  };

  const placeOnIsland = (obj: THREE.Object3D, mixer: THREE.AnimationMixer | null, i: number) => {
    // Pace the stone path cross; ranges dodge the windmill and shops.
    const axis: "x" | "z" = i % 2 === 0 ? "x" : "z";
    const npc: Npc = {
      obj,
      mixer,
      axis,
      dir: 1,
      line: axis === "x" ? island.z - 4 : island.x + 2,
      lateral: 0,
      speed: 1.1 + i * 0.25,
      y: island.topY,
      yaw: 0,
      nextDecision: Infinity, // islanders never turn, they ping-pong
      bounds:
        axis === "x" ? [island.x - 30, island.x + 9] : [island.z - 26, island.z + 26],
      isIsland: true,
    };
    if (axis === "x") obj.position.set(island.x - 10 + i * 6, island.topY, npc.line);
    else obj.position.set(npc.line, island.topY, island.z - 8 + i * 6);
    npcs.push(npc);
  };

  const loader = new GLTFLoader();
  urls.forEach((url, ui) => {
    loader.load(url, (gltf) => {
      const base = gltf.scene;
      base.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(base);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 1.7 / Math.max(size.x, size.y, size.z, 0.0001);
      base.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const std = mesh.material as THREE.MeshStandardMaterial;
        if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.3);
          std.roughness = Math.max(std.roughness, 0.45);
        }
      });
      const walkClip =
        gltf.animations.find((c) => /walk/i.test(c.name) && !/carry/i.test(c.name)) ??
        gltf.animations[0];

      // Two residents per character model. Each is wrapped in a group
      // whose origin is the feet — the wander loop owns the wrapper's
      // position while the inner model keeps the foot offset.
      for (let c = 0; c < 2; c++) {
        const inst = cloneSkinned(base);
        inst.scale.setScalar(fit);
        inst.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(inst);
        inst.position.y = -scaled.min.y;
        const wrapper = new THREE.Group();
        wrapper.add(inst);
        let mixer: THREE.AnimationMixer | null = null;
        if (walkClip) {
          mixer = new THREE.AnimationMixer(inst);
          const action = mixer.clipAction(walkClip);
          action.timeScale = 0.9 + ((ui * 2 + c) % 5) * 0.08;
          action.play();
          mixer.update(((ui * 7 + c * 3) % 10) / 10); // desync the strides
        }
        group.add(wrapper);
        const idx = ui * 2 + c;
        // The last two residents move to the island.
        if (idx >= urls.length * 2 - 2) placeOnIsland(wrapper, mixer, c);
        else placeOnStreets(wrapper, mixer, idx);
      }
    });
  });

  return {
    group,
    update(dt, playerPos) {
      for (const npc of npcs) {
        const p = npc.obj.position;
        const coord = npc.axis === "x" ? p.x : p.z;
        let next = coord + npc.dir * npc.speed * dt;

        if (npc.isIsland) {
          if (next > npc.bounds[1] || next < npc.bounds[0]) {
            npc.dir = -npc.dir as 1 | -1;
            next = coord;
          }
        } else {
          // Turn around at the city limits.
          if (next > npc.bounds[1] || next < npc.bounds[0]) {
            npc.dir = -npc.dir as 1 | -1;
            npc.nextDecision = nextIntersection(coord, npc.dir);
            next = coord;
          } else if (
            (npc.dir > 0 && next >= npc.nextDecision) ||
            (npc.dir < 0 && next <= npc.nextDecision)
          ) {
            // At an intersection: half the time, turn onto it.
            const crossing = npc.nextDecision;
            if (Math.random() < 0.5) {
              const newAxis = npc.axis === "x" ? "z" : "x";
              const oldLine = npc.line;
              npc.axis = newAxis;
              npc.line = crossing;
              npc.dir = Math.random() < 0.5 ? 1 : -1;
              if (newAxis === "x") {
                p.z = crossing + npc.lateral;
                p.x = oldLine + npc.lateral;
              } else {
                p.x = crossing + npc.lateral;
                p.z = oldLine + npc.lateral;
              }
              npc.nextDecision = nextIntersection(npc.axis === "x" ? p.x : p.z, npc.dir);
              continue;
            }
            npc.nextDecision = nextIntersection(crossing + npc.dir, npc.dir);
          }
        }

        if (npc.axis === "x") p.x = next;
        else p.z = next;
        p.y = npc.y;

        // Face the direction of travel, with a soft turn.
        const targetYaw =
          npc.axis === "x" ? (npc.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : npc.dir > 0 ? 0 : Math.PI;
        let d = targetYaw - npc.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        npc.yaw += d * Math.min(1, dt * 6);
        npc.obj.rotation.y = npc.yaw;

        // Animate only when the player could actually see the stride.
        if (npc.mixer && p.distanceToSquared(playerPos) < ANIM_CULL_DIST_SQ) {
          npc.mixer.update(dt);
        }
      }
    },
  };
}
