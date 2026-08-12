/**
 * Portrait renderer for the shop — a build-time tool, not part of the app.
 *
 * Nothing imports this. It exists so `scripts/character-shots.mjs` can open
 * the dev server, reach into the real `buildProceduralPilot`, and photograph
 * each character exactly as the game builds it. The output lands in
 * `src/assets/characters/` and is what the shelf, the arcade card and the
 * grid all draw.
 *
 * Why pre-rendered stills rather than live 3D on the shelf: browsers cap live
 * WebGL contexts at around sixteen, and a shop that opens one per card breaks
 * the *next* world the visitor walks into. One canvas at a time is the rule
 * `/arcade/characters` already follows for exactly that reason. A card wants a
 * picture, and a picture costs nothing.
 *
 * Why renders rather than drawn art: the picture is a photograph of the thing
 * you actually get. Add a character to `PILOT_DESIGNS`, re-run the script, and
 * its portrait cannot be out of date or flattering — which is the same
 * argument `art.ts` makes about world cards, applied one level down.
 *
 * The background is transparent on purpose. One PNG then works on the violet
 * shelf, on the starfield grid and on anything built later, with the tint
 * coming from CSS underneath rather than being baked into six files that would
 * all have to be recaptured to change one colour.
 */
import * as THREE from "three";
import { buildProceduralPilot } from "@/components/city/proceduralPilot";

export interface ShotOptions {
  width?: number;
  height?: number;
  /** Seconds of idle to settle the springs before the shutter. */
  settle?: number;
  /**
   * How much of the character is in frame.
   *
   * `full` fits the whole rig, which is the honest picture and a terrible
   * thumbnail: at card size the head is forty pixels and every character
   * reduces to a coloured stick. `bust` frames the top ~55%, so the face,
   * the crown and the shoulders fill the tile — the three things that
   * actually distinguish one design from another.
   *
   * `face` goes tighter still, for an avatar. At 28px in a nav chip even a
   * bust is a smudge, and cropping a bust in CSS does not work: the slice is
   * measured from the top of each character, so a fixed crop that finds
   * Monarch's face lands on a crab's back. The camera has to be told, which
   * means it has to be rendered.
   */
  crop?: "full" | "bust" | "face";
}

/**
 * Render one design and return a PNG data URL with a transparent background.
 *
 * Called from Playwright via `page.evaluate`, so it must resolve on its own
 * and must not depend on anything the app has mounted.
 */
export async function shootCharacter(
  designId: string,
  opts: ShotOptions = {},
): Promise<string> {
  const width = opts.width ?? 640;
  const height = opts.height ?? 720;
  const settle = opts.settle ?? 1.4;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // toDataURL reads the buffer back
  });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();

  const pilot = buildProceduralPilot(undefined, designId);
  scene.add(pilot.group);

  // Settle the springs before the shutter. Straight out of the constructor
  // every joint is at rest and the crest, cape and tail hang dead straight —
  // the one pose that makes the secondary motion look like it isn't there.
  // A second and a bit of standing still leaves them where an idle actually
  // holds them.
  const step = 1 / 60;
  for (let t = 0; t < settle; t += step) {
    pilot.update(step, {
      speed: 0,
      grounded: true,
      verticalVel: 0,
      yawRate: 0,
      thrusting: false,
    });
  }

  // Three-quarter view. Dead-on is the worst angle for a rig whose whole
  // argument is silhouette — a tail, a cape and a snout all vanish into the
  // body from the front.
  pilot.group.rotation.y = -0.42;

  // Frame from the real bounds rather than a constant, because `chunk` makes
  // Pixel two thirds of Bumble's height and a fixed camera crops one or floats
  // the other.
  const box = new THREE.Box3().setFromObject(pilot.group);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const camera = new THREE.PerspectiveCamera(26, width / height, 0.1, 100);

  // What vertical slice to fill the frame with, measured down from the top of
  // the character rather than from its centre — the top is where the head is,
  // and the head is the only landmark every design shares. Halos and horns
  // push `box.max.y` above the skull, so the window is a fraction of the whole
  // height rather than an absolute number of metres, and Pixel at chunk 0.82
  // frames the same as Bumble at 1.1.
  const slice = opts.crop === "full" ? 1 : 0.56;
  const windowH = size.y * slice;
  let aimY = box.max.y - windowH / 2;
  let aimX = 0;
  let aimZ = 0;
  let fitH = windowH * 1.1;
  let fitW = (size.x * (opts.crop === "full" ? 1.3 : 1.05)) / camera.aspect;

  if (opts.crop === "face") {
    /**
     * The head, from the rig, rather than a fraction of the bounding box.
     *
     * A slice measured down from `box.max.y` is a fine heuristic for a humanoid
     * and it is wrong the moment a body plan stops being one: on a crab the top
     * of the bounds is the middle of its shell, so the "face" crop photographed
     * its back. `pilot.head` is the joint the rig already exposes so a hat can
     * be parented to the skull, and it is the only landmark that means the same
     * thing on every plan.
     *
     * Its box includes whatever grows out of the crown — antennae, eyestalks,
     * horns — which is right: those are the half of a silhouette you recognise
     * at 28 pixels.
     */
    pilot.group.updateMatrixWorld(true);
    const headBox = new THREE.Box3().setFromObject(pilot.head);
    const headSize = new THREE.Vector3();
    const headCentre = new THREE.Vector3();
    headBox.getSize(headSize);
    headBox.getCenter(headCentre);
    aimX = headCentre.x;
    aimY = headCentre.y;
    /* And the head's own Z. Aiming at the group's centre plane works for a
       humanoid, whose skull sits over its hips, and throws a crab's head — held
       out in front of it — off to the side of the frame. */
    aimZ = headCentre.z;
    /* Air on every side. `1.35` cropped flush to the edges: the box is the
       skull, and a face wants to be a face in a circle rather than a texture. */
    fitH = Math.max(headSize.y, headSize.x, headSize.z) * 1.9;
    fitW = fitH / camera.aspect;
  }

  const dist = (Math.max(fitH, fitW) / 2) / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(
    aimX + dist * 0.26,
    aimY + windowH * (opts.crop === "face" ? 0 : 0.04),
    aimZ + dist,
  );
  camera.lookAt(aimX, aimY, aimZ);

  // Lighting: a warm key from camera-left, a cool fill from the right to keep
  // the shadow side from going black, and a rim from behind to lift the
  // silhouette off whatever the card puts underneath. Darker characters —
  // Grimlock, Sable — are unreadable without the rim.
  const key = new THREE.DirectionalLight(0xfff4e6, 2.5);
  key.position.set(-3, 4.5, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fc4ff, 1.0);
  fill.position.set(4, 1.5, 2.5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 2.2);
  rim.position.set(1.5, 3, -5);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2438, 1.35));

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");

  // The tool renders sixty-odd characters in one page, so leaking a context
  // per shot would run the browser out before it finished.
  pilot.dispose();
  renderer.dispose();
  renderer.forceContextLoss();

  return url;
}

/** Handed to the capture script through `window`, which is all it can reach. */
declare global {
  interface Window {
    __shootCharacter?: typeof shootCharacter;
  }
}

if (typeof window !== "undefined") window.__shootCharacter = shootCharacter;
