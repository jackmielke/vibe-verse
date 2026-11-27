/**
 * The camera, and what is watching it.
 *
 * `startCamera()` opens the front camera. `PoseTracker` loads MediaPipe's pose
 * landmarker (vendored under /vendor/mediapipe, loaded with a runtime import
 * so nobody pays for it until they pick camera mode) and runs it on every new
 * video frame. If the landmarker cannot load, `MotionTracker` takes over: it
 * diffs tiny greyscale frames and calls a burst of movement on one side of the
 * picture a punch with that hand. It cannot see a guard or a slip, so the
 * page keeps the thumb and keyboard controls live underneath both.
 */
import { BodyReader, type BodyRead, type Landmark } from "./pose";

const BASE = "/vendor/mediapipe";

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot open a camera here.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
  if (!video.videoWidth) {
    await new Promise<void>((res) => {
      const done = () => { video.removeEventListener("loadedmetadata", done); res(); };
      video.addEventListener("loadedmetadata", done);
      setTimeout(done, 3000);
    });
  }
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export interface Tracker {
  readonly kind: "pose" | "motion";
  /** Call once per animation frame. Returns null when there is no new video frame. */
  update(nowMs: number): BodyRead | null;
  /** The last raw landmarks, for drawing the skeleton. */
  landmarks(): Landmark[] | null;
  recentre(): void;
  dispose(): void;
}

/* Just enough of the MediaPipe surface to type the calls we make. */
interface PoseLandmarkerLike {
  detectForVideo(video: HTMLVideoElement, ts: number): { landmarks: Landmark[][] };
  close(): void;
}
interface VisionModule {
  PoseLandmarker: {
    createFromOptions(fileset: unknown, opts: unknown): Promise<PoseLandmarkerLike>;
  };
}

/**
 * The bundle is one self-contained ES module. Vite's dev server refuses to
 * let source code import a file from /public, so it is fetched and imported
 * from a blob URL, which works the same in dev and in the built site.
 */
async function loadVision(): Promise<VisionModule> {
  const res = await fetch(`${BASE}/vision_bundle.mjs`);
  if (!res.ok) throw new Error(`vision bundle: ${res.status}`);
  const blob = new Blob([await res.text()], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ url)) as VisionModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class PoseTracker implements Tracker {
  readonly kind = "pose" as const;
  private reader = new BodyReader();
  private lastVideoTime = -1;
  private last: Landmark[] | null = null;
  private constructor(private video: HTMLVideoElement, private lm: PoseLandmarkerLike) {}

  static async create(video: HTMLVideoElement): Promise<PoseTracker> {
    const vision = await loadVision();
    const fileset = {
      wasmLoaderPath: `${BASE}/wasm/vision_wasm_internal.js`,
      wasmBinaryPath: `${BASE}/wasm/vision_wasm_internal.wasm`,
    };
    const make = (delegate: "GPU" | "CPU") =>
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_lite.task`, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let lm: PoseLandmarkerLike;
    try { lm = await make("GPU"); } catch { lm = await make("CPU"); }
    return new PoseTracker(video, lm);
  }

  update(nowMs: number): BodyRead | null {
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    let res: { landmarks: Landmark[][] } | null = null;
    try { res = this.lm.detectForVideo(v, nowMs); } catch { res = null; }
    this.last = res?.landmarks?.[0] ?? null;
    return this.reader.read(this.last, nowMs);
  }

  /** For tests and the sandbox: read a body that is not in front of the camera. */
  feed(lm: Landmark[] | null, nowMs: number): BodyRead {
    this.last = lm;
    return this.reader.read(lm, nowMs);
  }

  landmarks(): Landmark[] | null { return this.last; }
  recentre(): void { this.reader.recentre(); }
  dispose(): void { try { this.lm.close(); } catch { /* already closed */ } }
}

/**
 * The fallback: no model, just movement. Left half of the mirrored picture
 * moving hard is a left, right half a right.
 */
export class MotionTracker implements Tracker {
  readonly kind = "motion" as const;
  private cv = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private prev: Uint8ClampedArray | null = null;
  private lastVideoTime = -1;
  private base = { L: 0, R: 0 };
  private last = { L: -1e9, R: -1e9 };
  private readonly W = 48;
  private readonly H = 36;

  constructor(private video: HTMLVideoElement) {
    this.cv.width = this.W;
    this.cv.height = this.H;
    this.ctx = this.cv.getContext("2d", { willReadFrequently: true })!;
  }

  update(nowMs: number): BodyRead | null {
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    this.ctx.drawImage(v, 0, 0, this.W, this.H);
    const px = this.ctx.getImageData(0, 0, this.W, this.H).data;
    const out: BodyRead = {
      present: true, guard: false, lean: 0,
      fists: { L: { sx: 0.3, sy: 0.6, seen: false }, R: { sx: 0.7, sy: 0.6, seen: false } },
      head: { sx: 0.5, sy: 0.3 }, shoulderWidth: 0.25, punches: [],
    };
    if (this.prev) {
      const e = { L: 0, R: 0 };
      for (let y = 0; y < this.H; y++) {
        for (let x = 0; x < this.W; x++) {
          const i = (y * this.W + x) * 4;
          const d = Math.abs(px[i] - this.prev[i]) + Math.abs(px[i + 1] - this.prev[i + 1]) + Math.abs(px[i + 2] - this.prev[i + 2]);
          if (d > 60) {
            // unmirrored x < W/2 is the player's right, which is screen right
            if (x < this.W / 2) e.R++; else e.L++;
          }
        }
      }
      const half = (this.W * this.H) / 2;
      for (const h of ["L", "R"] as const) {
        const f = e[h] / half;
        this.base[h] += (f - this.base[h]) * 0.08;
        if (f > 0.12 && f > this.base[h] * 3 && nowMs - this.last[h] > 380) {
          this.last[h] = nowMs;
          out.punches.push({ hand: h, kind: "jab", power: Math.min(1, f * 2.5), sx: h === "L" ? 0.3 : 0.7, sy: 0.5 });
        }
      }
    }
    this.prev = new Uint8ClampedArray(px);
    return out;
  }

  landmarks(): Landmark[] | null { return null; }
  recentre(): void { /* nothing to centre */ }
  dispose(): void { this.prev = null; }
}
