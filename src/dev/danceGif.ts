/**
 * Watching the dancers move — a build-time tool, not part of the app.
 *
 * Nothing imports this. `danceShot.ts` lays a dance out as still poses, which
 * is the right instrument for "is the arm where I meant it to be" and useless
 * for everything this file exists to check. Follow-through, groove, the
 * difference between four people and four copies of one person: all of it is
 * *timing*, and timing is invisible in a strip of stills. You have to watch it.
 *
 * So this renders a row of dancers into a real WebGL context, steps them at a
 * fixed dt, and encodes the frames as a GIF I can open and look at. Fixed dt
 * rather than wall time on purpose — the container renders this at about a
 * frame a second under SwiftShader, and a recording paced by the renderer
 * would be a slideshow of unrelated moments rather than a performance.
 */
import * as THREE from "three";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { buildProceduralPilot } from "@/components/city/proceduralPilot";
import {
  DANCES,
  STRAIGHT,
  createDancePose,
  evalDanceGrooved,
  findDance,
  makeGroove,
  type DanceGroove,
} from "@/components/city/dances";

export interface DanceGifOptions {
  /** Dance id for everybody in the row. Omit to give each their own. */
  dance?: string;
  /** Pilot design ids, one per dancer. */
  crew?: string[];
  /** Turn groove off, to see what the mechanical version looks like. */
  straight?: boolean;
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
}

/**
 * Render a row of dancers and return an animated GIF as a data URL.
 *
 * The camera is deliberately close and slightly above eye level: a dance floor
 * seen from thirty metres is four coloured dots, and every judgement about
 * whether a body reads as a body is made at conversational distance.
 */
export async function shootDanceGif(opts: DanceGifOptions = {}): Promise<string> {
  return (await record(opts)).gif();
}

/**
 * The same recording, laid out as a grid of frames in one PNG.
 *
 * A GIF is the honest artefact and it is useless to anybody reviewing this in
 * a terminal, which includes me: an image tool shows the first frame and
 * nothing else. A filmstrip is worse to watch and much better to *read* —
 * four dancers across, time down the page, so a groove that puts one of them a
 * frame ahead of the others is something you can see by looking along a row.
 */
export async function shootDanceStrip(
  opts: DanceGifOptions & { cols?: number; rows?: number } = {},
): Promise<string> {
  const cols = opts.cols ?? 4;
  const rows = opts.rows ?? 4;
  const rec = await record({ ...opts, seconds: opts.seconds ?? 2, fps: opts.fps ?? 12.5 });
  return rec.strip(cols, rows);
}

async function record(opts: DanceGifOptions) {
  const crew = opts.crew ?? ["pixel", "bumble", "chrome", "sable"];
  const seconds = opts.seconds ?? 4;
  const fps = opts.fps ?? 12.5;
  const width = opts.width ?? 420;
  const height = opts.height ?? 190;
  const dt = 1 / fps;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x141a2c, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshBasicMaterial({ color: 0x232b45 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(-3, 5, 5);
  const rim = new THREE.DirectionalLight(0x9fd4ff, 2.0);
  rim.position.set(2, 3, -5);
  scene.add(key, rim, new THREE.HemisphereLight(0xdce8ff, 0x6a6480, 2.2));
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  const SPACING = 1.5;
  const dancers = crew.map((id, i) => {
    const pilot = buildProceduralPilot(undefined, id);
    pilot.group.position.set((i - (crew.length - 1) / 2) * SPACING, 0, 0);
    /* No rotation: the rig is built facing +Z and the camera sits at +Z
       looking back down it, so a pilot straight out of the constructor is
       already facing us. The obvious `rotation.y = Math.PI` turns them round,
       and a filmstrip of four backs is a filmstrip of nothing. */
    scene.add(pilot.group);
    return {
      pilot,
      def: findDance(opts.dance ?? DANCES[(i * 3 + 1) % DANCES.length].id)!,
      groove: opts.straight ? STRAIGHT : makeGroove(i * 137 + 11),
    };
  });

  const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
  camera.position.set(0, 1.35, 4.9);
  camera.lookAt(0, 0.95, 0);

  const pose = createDancePose();
  // Settle: the springs in the rig start at rest and the first half-second of
  // any recording is them arriving, which is not the thing being filmed.
  for (let i = 0; i < 40; i++) {
    for (const d of dancers) {
      d.pilot.update(dt, { speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false });
    }
  }

  const frames: Uint8ClampedArray[] = [];
  const gl = renderer.getContext();
  const total = Math.round(seconds * fps);
  /* A fixed, round start so the recording begins on a downbeat — a GIF that
     loops has to start and end on the same phase or the seam reads as a
     stumble. `seconds` is chosen to be a whole number of bars by the caller. */
  const startMs = 0;
  for (let f = 0; f < total; f++) {
    const nowMs = startMs + f * dt * 1000;
    for (const d of dancers) {
      evalDanceGrooved(d.def, pose, d.groove, nowMs);
      d.pilot.update(dt, {
        speed: 0,
        grounded: true,
        verticalVel: 0,
        yawRate: 0,
        thrusting: false,
        dance: { pose, weight: 1, lag: d.def.lag },
      });
    }
    renderer.render(scene, camera);
    // Straight off the drawing buffer: no PNG round trip, and no decoder,
    // which this container does not have.
    const buf = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // WebGL's origin is bottom-left; GIF wants top-down.
    const flipped = new Uint8ClampedArray(width * height * 4);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      flipped.set(buf.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    frames.push(flipped);
  }

  // One palette for the whole clip, sampled across it — per-frame palettes
  // make a static background crawl. Same reasoning as `routeGif.ts`.
  const sample = new Uint8ClampedArray(frames.length * 4 * 2000);
  for (let i = 0; i < frames.length; i++) {
    const step = Math.max(4, Math.floor(frames[i].length / 4 / 2000) * 4);
    let o = i * 4 * 2000;
    for (let p = 0; p < frames[i].length && o < (i + 1) * 4 * 2000; p += step, o += 4) {
      sample.set(frames[i].subarray(p, p + 4), o);
    }
  }
  const palette = quantize(sample, 128, { format: "rgb565" });

  const cleanup = () => {
    for (const d of dancers) d.pilot.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };

  const gif = () => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
      const index = applyPalette(frames[i], palette, "rgb565");
      // Centiseconds, never below 2 — browsers silently rewrite 0 and 1 to 10.
      enc.writeFrame(index, width, height, {
        palette: i === 0 ? palette : undefined,
        delay: Math.max(2, Math.round(1000 / fps / 10)) * 10,
      });
    }
    enc.finish();
    const bytes = enc.bytes();
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    cleanup();
    return `data:image/gif;base64,${btoa(binary)}`;
  };

  const strip = (cols: number, rows: number) => {
    const sheet = document.createElement("canvas");
    sheet.width = width * cols;
    sheet.height = height * rows;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = "#0b0e16";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    const want = cols * rows;
    const tmp = document.createElement("canvas");
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext("2d")!;
    for (let n = 0; n < want && n < frames.length; n++) {
      // Consecutive frames, not spread across the clip: the thing being read
      // here is what changes between one frame and the next.
      tctx.putImageData(new ImageData(frames[n] as never, width, height), 0, 0);
      const cx = (n % cols) * width;
      const cy = Math.floor(n / cols) * height;
      ctx.drawImage(tmp, cx, cy);
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.strokeRect(cx + 0.5, cy + 0.5, width - 1, height - 1);
      ctx.fillStyle = "#ffd166";
      ctx.font = "bold 11px monospace";
      ctx.fillText(`f${n}  beat ${((n / fps) * 2).toFixed(2)}`, cx + 6, cy + 14);
    }
    cleanup();
    return sheet.toDataURL("image/png");
  };

  return { gif, strip };
}

declare global {
  interface Window {
    __shootDanceGif?: typeof shootDanceGif;
    __shootDanceStrip?: typeof shootDanceStrip;
  }
}

if (typeof window !== "undefined") {
  window.__shootDanceGif = shootDanceGif;
  window.__shootDanceStrip = shootDanceStrip;
}

export type { DanceGroove };
