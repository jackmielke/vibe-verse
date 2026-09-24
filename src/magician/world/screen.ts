/**
 * The Magic Screen: a big framed screen at the edge of the square that
 * Vibey programs by voice.
 *
 * This file is the object in the world and what is drawn on it. The
 * program itself runs in the sandbox in `screen/runtime.ts`; frames come
 * back as ImageBitmaps and are copied onto one canvas that is the screen's
 * texture. While a new program is being written, the same canvas shows the
 * code arriving, line by line, so everybody watching sees it being made.
 */
import * as THREE from "three";
import { createScreenRuntime, NO_INPUT, SCREEN_H, SCREEN_W, type ScreenInput } from "../screen/runtime";
import type { PropObject } from "./props";

export interface MagicScreen {
  prop: PropObject;
  /** Centre of the picture, in world space. */
  centre: THREE.Vector3;
  /** Unit vector the screen faces. */
  normal: THREE.Vector3;
  /** Run a program; null shows the idle card. */
  run(code: string | null, startedAt: number, title: string): void;
  /** Show code being written (null to stop). */
  writing(w: { request: string; code: string } | null): void;
  input(i: ScreenInput): void;
  /** Where a ray from `origin` along `dir` hits the picture, 0-1, or null. */
  hit(origin: THREE.Vector3, dir: THREE.Vector3): { x: number; y: number } | null;
  /** The last error the running program threw, if it is the current one. */
  onError?: (message: string) => void;
  update(dt: number, time: number, viewer: THREE.Vector3): void;
  title(): string;
  dispose(): void;
}

const PIC_W = 6.4, PIC_H = 3.6, LIFT = 0.85;

export function createMagicScreen(opts: {
  x: number; z: number; y: number; yaw: number;
  fps: number;
  onBeep?(freq: number, seconds: number, type: OscillatorType, volume: number): void;
}): MagicScreen {
  const group = new THREE.Group();
  group.name = "magic-screen";
  group.position.set(opts.x, opts.y, opts.z);
  group.rotation.y = opts.yaw;
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  // ---- the picture -----------------------------------------------------------
  const cv = document.createElement("canvas");
  cv.width = SCREEN_W; cv.height = SCREEN_H;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#120c22";
  g.fillRect(0, 0, SCREEN_W, SCREEN_H);
  const tex = keep(new THREE.CanvasTexture(cv));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const picMat = keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  const pic = new THREE.Mesh(keep(new THREE.PlaneGeometry(PIC_W, PIC_H)), picMat);
  pic.position.set(0, LIFT + PIC_H / 2, 0.06);
  group.add(pic);

  // ---- the frame: dark wood, gold trim, a little tiled roof, two posts --------
  const wood = keep(new THREE.MeshStandardMaterial({ color: "#2b1c14", roughness: 0.8 }));
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#d4a640", roughness: 0.35, metalness: 0.7 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: "#2f3540", roughness: 0.6 }));
  const stone = keep(new THREE.MeshStandardMaterial({ color: "#8d887e", roughness: 0.95 }));
  const piece = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const fw = PIC_W + 0.5, fh = PIC_H + 0.5, cy = LIFT + PIC_H / 2;
  piece(new THREE.BoxGeometry(fw, fh, 0.14), wood, 0, cy, -0.04); // backboard
  for (const s of [-1, 1]) {
    piece(new THREE.BoxGeometry(0.22, fh + 0.1, 0.24), wood, s * (fw / 2 - 0.05), cy, 0.02);
    piece(new THREE.BoxGeometry(0.05, PIC_H + 0.08, 0.05), gold, s * (PIC_W / 2 + 0.05), cy, 0.1);
  }
  piece(new THREE.BoxGeometry(fw + 0.1, 0.24, 0.24), wood, 0, cy + fh / 2, 0.02);
  piece(new THREE.BoxGeometry(fw + 0.1, 0.24, 0.24), wood, 0, cy - fh / 2, 0.02);
  piece(new THREE.BoxGeometry(PIC_W + 0.18, 0.05, 0.05), gold, 0, cy + PIC_H / 2 + 0.05, 0.1);
  piece(new THREE.BoxGeometry(PIC_W + 0.18, 0.05, 0.05), gold, 0, cy - PIC_H / 2 - 0.05, 0.1);
  // Roof: two sloped planes with a ridge, the shape of a shrine notice board.
  const roofY = cy + fh / 2 + 0.25;
  for (const s of [-1, 1]) {
    const r = piece(new THREE.BoxGeometry(fw + 1.0, 0.08, 0.8), roofMat, 0, roofY + 0.14, s * 0.3);
    r.rotation.x = s * 0.42;
  }
  piece(new THREE.BoxGeometry(fw + 1.1, 0.12, 0.14), wood, 0, roofY + 0.3, 0);
  for (const s of [-1, 1]) {
    piece(new THREE.CylinderGeometry(0.16, 0.19, roofY + 0.2, 10), wood, s * (fw / 2 + 0.1), (roofY + 0.2) / 2, -0.12);
    piece(new THREE.CylinderGeometry(0.34, 0.4, 0.3, 10), stone, s * (fw / 2 + 0.1), 0.15, -0.12);
  }
  // A step to stand on.
  piece(new THREE.BoxGeometry(fw * 0.7, 0.14, 1.2), stone, 0, 0.07, 1.1);

  // ---- the program --------------------------------------------------------------
  let currentTitle = "The Magic Screen";
  let runId = 0;
  let framesSinceRun = 0;
  let writingState: { request: string; code: string } | null = null;
  let errorText: string | null = null;
  let errorAt = 0;
  const runtime = createScreenRuntime({
    fps: opts.fps,
    onFrame(bm) {
      if (!writingState && !errorText) {
        g.drawImage(bm, 0, 0);
        tex.needsUpdate = true;
      }
      bm.close();
      framesSinceRun++;
    },
    onError(message) {
      errorText = message;
      errorAt = performance.now();
      screen.onError?.(message);
    },
    onBeep: opts.onBeep,
  });

  const normal = new THREE.Vector3(Math.sin(opts.yaw), 0, Math.cos(opts.yaw));
  const centre = new THREE.Vector3(opts.x, opts.y + cy, opts.z).addScaledVector(normal, 0.06);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, centre);
  const tmp = new THREE.Vector3();
  const right = new THREE.Vector3(Math.cos(opts.yaw), 0, -Math.sin(opts.yaw));

  const lamp = { glow: picMat as unknown as THREE.Material, at: new THREE.Vector3(0, cy, 1.4), color: new THREE.Color("#c8d8ff"), power: 1.1, level: 0.6 };
  let paused = false;
  let lastDraw = 0;

  const screen: MagicScreen = {
    prop: {
      group,
      lamp,
      solid: [fw / 2 + 0.3, 0.45],
      dispose() { /* the screen disposes itself */ },
    },
    centre,
    normal,
    run(code, startedAt, title) {
      runId++;
      framesSinceRun = 0;
      errorText = null;
      currentTitle = title;
      if (code) runtime.load(code, startedAt);
    },
    writing(w) { writingState = w; if (!w) lastDraw = 0; },
    input(i) { runtime.input(i); },
    hit(origin, dir) {
      const ray = new THREE.Ray(origin, dir);
      if (!ray.intersectPlane(plane, tmp)) return null;
      if (dir.dot(normal) > 0) return null;
      tmp.sub(centre);
      const x = tmp.dot(right) / PIC_W + 0.5;
      const y = 0.5 - tmp.y / PIC_H;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { x, y };
    },
    update(dt, time, viewer) {
      const far = viewer.distanceTo(centre) > 70;
      if (far !== paused) { paused = far; runtime.pause(far); }
      if (writingState) {
        if (time - lastDraw > 0.1) { lastDraw = time; drawWriting(g, writingState, time); tex.needsUpdate = true; }
      } else if (errorText) {
        if (time - lastDraw > 0.12) { lastDraw = time; drawError(g, errorText, performance.now() - errorAt); tex.needsUpdate = true; }
      }
      lamp.level = paused ? 0 : 0.6;
      void runId; void framesSinceRun;
    },
    title: () => currentTitle,
    dispose() {
      runtime.dispose();
      for (const d of disposables) d.dispose();
    },
  };
  screen.input(NO_INPUT);
  return screen;
}

/** The code arriving: a request at the top and the lines scrolling in. */
function drawWriting(g: CanvasRenderingContext2D, w: { request: string; code: string }, time: number): void {
  const grad = g.createLinearGradient(0, 0, 0, SCREEN_H);
  grad.addColorStop(0, "#150d2c");
  grad.addColorStop(1, "#24123a");
  g.fillStyle = grad;
  g.fillRect(0, 0, SCREEN_W, SCREEN_H);
  g.fillStyle = "#ffd6a0";
  g.font = "bold 15px serif";
  g.textAlign = "left";
  g.textBaseline = "top";
  const dots = ".".repeat(1 + (Math.floor(time * 3) % 3));
  g.fillText(`✦ Vibey is writing${dots}`, 14, 10);
  g.font = "italic 13px serif";
  g.fillStyle = "rgba(255,230,200,0.8)";
  g.fillText(`“${w.request.slice(0, 64)}${w.request.length > 64 ? "…" : ""}”`, 14, 30);
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(10, 52, SCREEN_W - 20, 1);
  const lines = w.code.split("\n");
  const shown = lines.slice(-15);
  g.font = "11px monospace";
  shown.forEach((l, i) => {
    const kw = /^\s*(function|const|let|if|for|return|while)\b/.test(l);
    g.fillStyle = kw ? "#b9a7ff" : /^\s*\/\//.test(l) ? "#7fbf9a" : "#e8e2f5";
    g.fillText(l.slice(0, 74), 14, 58 + i * 13.5);
  });
  if (Math.floor(time * 2) % 2 === 0) {
    const last = shown[shown.length - 1] ?? "";
    g.fillStyle = "#ffd6a0";
    g.fillRect(14 + Math.min(74, last.length) * 6.6, 58 + (shown.length - 1) * 13.5, 6, 12);
  }
}

/** A program that fell over: soft static and the reason, until it is fixed. */
function drawError(g: CanvasRenderingContext2D, message: string, ms: number): void {
  const img = g.createImageData(SCREEN_W / 4, SCREEN_H / 4);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 30 + Math.random() * 50;
    img.data[i] = v; img.data[i + 1] = v * 0.9; img.data[i + 2] = v * 1.2; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.drawImage(g.canvas, 0, 0, SCREEN_W / 4, SCREEN_H / 4, 0, 0, SCREEN_W, SCREEN_H);
  g.fillStyle = "rgba(10,6,20,0.72)";
  g.fillRect(20, SCREEN_H / 2 - 44, SCREEN_W - 40, 88);
  g.fillStyle = "#ffd6a0";
  g.font = "bold 16px serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(ms < 8000 ? "The spell fizzled. Vibey is fixing it…" : "The spell fizzled.", SCREEN_W / 2, SCREEN_H / 2 - 18);
  g.font = "11px monospace";
  g.fillStyle = "rgba(255,240,230,0.8)";
  g.fillText(message.split("\n")[0].slice(0, 70), SCREEN_W / 2, SCREEN_H / 2 + 12);
}
