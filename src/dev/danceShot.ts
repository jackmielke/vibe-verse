/**
 * Contact sheets for the dance system — a build-time tool, not part of the app.
 *
 * Nothing imports this. It exists because a dance is the one kind of change
 * that a build, a typecheck and a smoke test all pass with flying colours
 * while the character on screen stands with its arms folded into its own
 * chest. `npm run typecheck` cannot see a wrong rotation axis; only a person
 * looking at a frame can.
 *
 * So `scripts/dance-shots.mjs` opens the dev server, reaches into the real
 * `dances.ts` and the real rigs, and lays every dance out as a strip of poses
 * across one beat — the same way an animator would flip through keys. Both
 * families of character are photographed, because they take completely
 * different code paths to the same pose: the GLB skeletons go through the
 * bind-pose conjugation, and the procedural pilots write their joints direct.
 * A bug in either one is invisible in the other.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildProceduralPilot } from "@/components/city/proceduralPilot";
import {
  DANCES,
  applyDancePose,
  bindGltfDanceSkeleton,
  createDancePose,
  evalDance,
  findDance,
  releaseDanceSkeleton,
  resetDancePose,
} from "@/components/city/dances";
import { findCharacter } from "@/lib/characters";

export interface DanceShotOptions {
  /** Character id from the shared catalog — GLB or procedural, both work. */
  character?: string;
  /** How many poses across the strip. */
  frames?: number;
  /** How many beats the strip spans. */
  beats?: number;
  /** Per-tile pixels. */
  tile?: number;
  /** Camera yaw in radians. 0 is dead-on; the default is three-quarter. */
  yaw?: number;
}

const TILE_DEFAULT = 260;

/**
 * Render one dance as a horizontal strip of poses.
 *
 * Returns a PNG data URL. The beats are sampled evenly, so a strip of eight
 * over two beats catches every extreme of a two-beat move and reads as the
 * dance rather than as eight unrelated statues.
 */
export async function shootDance(
  danceId: string,
  opts: DanceShotOptions = {},
): Promise<string> {
  const def = findDance(danceId);
  if (!def) throw new Error(`no such dance: ${danceId}`);
  const charId = opts.character ?? "flux";
  const frames = opts.frames ?? 8;
  const beats = opts.beats ?? 2;
  const tile = opts.tile ?? TILE_DEFAULT;
  const yaw = opts.yaw ?? -0.5;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(tile, tile, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const holder = new THREE.Group();
  holder.rotation.y = yaw;
  scene.add(holder);

  // A floor, because half of what these strips are checking is vertical: a
  // hop that never leaves the ground and a hop that sinks the feet through it
  // look identical without one.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 48),
    new THREE.MeshBasicMaterial({ color: 0x2a3040 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(-3, 4.5, 5);
  const fill = new THREE.DirectionalLight(0x9fc4ff, 1.0);
  fill.position.set(4, 1.5, 2.5);
  const rim = new THREE.DirectionalLight(0xffffff, 2.0);
  rim.position.set(1.5, 3, -5);
  // Generous fill: half the cast is near-black, and a strip you cannot read
  // is not a check on anything.
  scene.add(key, fill, rim, new THREE.HemisphereLight(0xdce8ff, 0x6a6480, 2.6));
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));

  const spec = findCharacter(charId);
  const pose = createDancePose();

  // Two rigs, one pose. `poseAt` is whichever of them this character uses.
  let poseAt: (beat: number) => void;
  let restAt: () => void;
  let dispose = () => {};

  if (spec.url) {
    const gltf = await new GLTFLoader().loadAsync(spec.url);
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    model.scale.setScalar(1.85 / Math.max(size.x, size.y, size.z, 0.0001));
    model.updateMatrixWorld(true);
    model.position.y = -new THREE.Box3().setFromObject(model).min.y;
    // Bind before anything poses it, exactly as the city does.
    const sk = bindGltfDanceSkeleton(model);
    holder.add(model);
    if (sk.bound < 8) console.warn(`[danceShot] ${charId}: only ${sk.bound} bones bound`);
    poseAt = (beat) => {
      evalDance(def, pose, (beat / (def.bpm / 60)) * 1000);
      applyDancePose(sk, pose, 1);
    };
    restAt = () => {
      resetDancePose(pose);
      applyDancePose(sk, pose, 1);
      releaseDanceSkeleton(sk);
    };
  } else {
    const pilot = buildProceduralPilot(undefined, spec.id);
    holder.add(pilot.group);
    // Settle the springs so the cape and crest are where an idle holds them.
    for (let t = 0; t < 1.2; t += 1 / 60) {
      pilot.update(1 / 60, { speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false });
    }
    poseAt = (beat) => {
      evalDance(def, pose, (beat / (def.bpm / 60)) * 1000);
      // A couple of steps so the joints that the gait smooths (neck, elbows)
      // arrive at the dance rather than being caught halfway to it.
      for (let i = 0; i < 3; i++) {
        pilot.update(1 / 60, {
          speed: 0,
          grounded: true,
          verticalVel: 0,
          yawRate: 0,
          thrusting: false,
          dance: { pose, weight: 1 },
        });
      }
    };
    restAt = () => {
      for (let i = 0; i < 40; i++) {
        pilot.update(1 / 60, { speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false });
      }
    };
    dispose = () => pilot.dispose();
  }

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  // Fixed frame across every tile: a per-frame fit would zoom in and out with
  // the pose and hide exactly the vertical motion the strip is there to show.
  camera.position.set(0.62, 1.2, 4.75);
  camera.lookAt(0, 1.0, 0);

  const sheet = document.createElement("canvas");
  sheet.width = tile * frames;
  sheet.height = tile;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#6b7286";
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  for (let i = 0; i < frames; i++) {
    // Tile 0 is the character NOT dancing. Without a control frame every
    // reading of a strip is a guess about how much of what you are looking at
    // was already there — an arm the rig rests at 20° reads as a deliberate
    // 20° pose, and a body that floats reads as a bug in the dance.
    if (i === 0) restAt();
    else poseAt(((i - 1) / (frames - 1)) * beats);
    renderer.render(scene, camera);
    ctx.drawImage(renderer.domElement, i * tile, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(i * tile + 0.5, 0.5, tile - 1, tile - 1);
    ctx.fillStyle = i === 0 ? "#ffd166" : "rgba(255,255,255,0.6)";
    ctx.font = "12px monospace";
    ctx.fillText(
      i === 0 ? "rest" : `${(((i - 1) / (frames - 1)) * beats).toFixed(2)}`,
      i * tile + 8,
      tile - 10,
    );
  }
  // Where the floor actually is, projected through the same camera. Eyeballing
  // "is it floating?" off a shaded disc is guesswork; a line is not.
  const ground = new THREE.Vector3(0, 0, 0).project(camera);
  const groundPx = ((1 - ground.y) / 2) * tile;
  ctx.strokeStyle = "rgba(255,90,90,0.45)";
  ctx.beginPath();
  ctx.moveTo(0, groundPx);
  ctx.lineTo(sheet.width, groundPx);
  ctx.stroke();

  ctx.fillStyle = "#8ef0c8";
  ctx.font = "bold 14px monospace";
  ctx.fillText(`${def.label} · ${spec.label} · ${def.bpm}bpm`, 8, 20);

  const url = sheet.toDataURL("image/png");
  dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}

/** Every dance, one strip each, for a single character. */
export async function shootAllDances(opts: DanceShotOptions = {}) {
  const out: { id: string; url: string }[] = [];
  for (const d of DANCES) out.push({ id: d.id, url: await shootDance(d.id, opts) });
  return out;
}

declare global {
  interface Window {
    __shootDance?: typeof shootDance;
    __shootAllDances?: typeof shootAllDances;
  }
}

if (typeof window !== "undefined") {
  window.__shootDance = shootDance;
  window.__shootAllDances = shootAllDances;
}
