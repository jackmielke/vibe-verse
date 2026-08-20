/**
 * Photo mode.
 *
 * A screenshot feature has one catastrophic failure and it is silent: the
 * WebGL drawing buffer is cleared the moment the browser composites it, so a
 * capture that reads the canvas on any tick but the one that drew it writes a
 * black PNG and reports success. No test can look at a picture — that part is
 * done by opening the route and opening the file — but the *ordering* that
 * makes the picture possible is testable, and it is asserted here: the frame
 * is drawn between the two resizes, and the renderer is put back exactly as it
 * was even when the composite fails.
 *
 * The rest is the arithmetic the viewfinder and the file have to agree on. The
 * mask the player frames with is CSS pixels in the panel; the crop is device
 * pixels in the engine; they are two implementations of the same centred fit,
 * and a photograph that is not the shape of the rectangle you framed it in is
 * the bug that arithmetic has.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  captureScale,
  createPhotoMode,
  cropRect,
  MAX_CAPTURE_PIXELS,
  PHOTO_DEFAULTS,
  shotName,
  type PhotoHost,
} from "@/empyrean/capture";
import { liveRect, focalLength, PHOTO_ASPECTS } from "@/components/EmpyreanPhotoPanel";

/* -------------------------------------------------------------------------
 * The crop
 * ---------------------------------------------------------------------- */

describe("cropRect", () => {
  it("leaves the buffer alone when no aspect is asked for", () => {
    expect(cropRect(1920, 1080, null)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it("takes a centred square out of a landscape buffer", () => {
    const r = cropRect(1920, 1080, 1);
    expect(r).toEqual({ sx: 420, sy: 0, sw: 1080, sh: 1080 });
    expect(r.sx * 2 + r.sw).toBe(1920);
  });

  it("takes a centred band out of a portrait buffer", () => {
    const r = cropRect(1080, 1920, 16 / 9);
    expect(r.sw).toBe(1080);
    expect(r.sh).toBe(608);
    expect(r.sy * 2 + r.sh).toBeCloseTo(1920, 0);
  });

  it("keeps a 4:5 crop taller than it is wide", () => {
    const r = cropRect(1600, 900, 4 / 5);
    expect(r.sw / r.sh).toBeCloseTo(0.8, 3);
    expect(r.sh).toBe(900);
  });

  it("never returns a zero-sized picture", () => {
    for (const a of [0.0001, 10000]) {
      const r = cropRect(800, 600, a);
      expect(r.sw).toBeGreaterThan(0);
      expect(r.sh).toBeGreaterThan(0);
    }
  });

  /* The one that matters: the bars the player frames with and the pixels the
     file gets are the same rectangle, or photo mode is lying to them. */
  it("agrees with the viewfinder's mask at every preset", () => {
    for (const { value } of PHOTO_ASPECTS) {
      for (const [w, h] of [
        [1440, 810],
        [390, 844],
        [1024, 1024],
      ]) {
        const mask = liveRect(w, h, value);
        const crop = cropRect(w, h, value);
        expect(mask.w).toBe(crop.sw);
        expect(mask.h).toBe(crop.sh);
        expect(mask.x).toBe(crop.sx);
        expect(mask.y).toBe(crop.sy);
      }
    }
  });
});

/* -------------------------------------------------------------------------
 * The supersample
 * ---------------------------------------------------------------------- */

describe("captureScale", () => {
  it("gives a desktop the 2× it asked for", () => {
    expect(captureScale(1440, 810, 1, 2, 8192)).toBe(2);
  });

  it("refuses to exceed the driver's maximum texture size", () => {
    // 1440 CSS at ratio 2 is 2880 across; doubling it is 5760, past a very
    // common 4096 limit.
    expect(captureScale(1440, 810, 2, 2, 4096)).toBe(1);
  });

  it("steps down rather than failing", () => {
    const s = captureScale(1000, 600, 2, 2, 4096);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(2);
    expect(2000 * s).toBeLessThanOrEqual(4096);
  });

  it("stays inside the pixel budget on a tall phone at ratio 3", () => {
    const s = captureScale(390, 844, 3, 2, 16384);
    expect(390 * 3 * s * (844 * 3 * s)).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS);
  });

  it("never goes below 1, whatever it is handed", () => {
    expect(captureScale(4000, 4000, 4, 2, 1024)).toBe(1);
    expect(captureScale(1440, 810, 1, 0, 8192)).toBe(1);
    expect(captureScale(1440, 810, 1, Number.NaN, 8192)).toBe(1);
  });
});

describe("shotName", () => {
  it("is a sortable PNG name", () => {
    const n = shotName(new Date(2026, 7, 20, 18, 42, 7));
    expect(n).toBe("empyrean-20260820-184207.png");
  });
});

describe("focalLength", () => {
  it("reads as a lens a photographer would recognise", () => {
    // A 50° vertical field on 35 mm is a normal lens; 12° is a long one.
    expect(focalLength(50)).toBeGreaterThan(20);
    expect(focalLength(50)).toBeLessThan(30);
    expect(focalLength(12)).toBeGreaterThan(100);
    expect(focalLength(110)).toBeLessThan(12);
  });
});

/* -------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------- */

interface Harness {
  host: PhotoHost;
  camera: THREE.PerspectiveCamera;
  body: THREE.Object3D;
  canvas: HTMLCanvasElement;
  log: string[];
  ratio: () => number;
}

function harness(): Harness {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 26000);
  const body = new THREE.Object3D();
  const canvas = document.createElement("canvas");
  canvas.width = 1440;
  canvas.height = 810;
  const log: string[] = [];
  let ratio = 1;

  const renderer = {
    getPixelRatio: () => ratio,
    setPixelRatio: (r: number) => {
      ratio = r;
      log.push(`ratio:${r}`);
    },
    getSize: (v: THREE.Vector2) => v.set(1440, 810),
    setSize: () => log.push("size"),
    capabilities: { maxTextureSize: 8192 },
  } as unknown as THREE.WebGLRenderer;

  const host: PhotoHost = {
    renderer,
    camera,
    canvas,
    body,
    draw: () => log.push("draw"),
    resize: () => log.push("resize"),
    onShutter: () => log.push("shutter"),
  };
  return { host, camera, body, canvas, log, ratio: () => ratio };
}

describe("the free camera", () => {
  it("does nothing at all until it is entered", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    h.camera.position.set(1, 2, 3);
    photo.update(0.016, new Set(["KeyW"]), { x: 0, y: 0, jet: false, boost: false });
    expect(photo.active).toBe(false);
    expect(h.camera.position.toArray()).toEqual([1, 2, 3]);
  });

  it("opens on exactly the shot that was on screen", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    h.camera.position.set(120, 640, -40);
    h.camera.lookAt(0, 700, 0);
    const before = new THREE.Vector3();
    h.camera.getWorldDirection(before);

    photo.enter();
    photo.update(0.016, new Set(), { x: 0, y: 0, jet: false, boost: false });

    expect(h.camera.position.distanceTo(new THREE.Vector3(120, 640, -40))).toBeLessThan(0.01);
    const after = new THREE.Vector3();
    h.camera.getWorldDirection(after);
    expect(after.angleTo(before)).toBeLessThan(0.01);
  });

  it("flies where the lens is pointing, not along the ground", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    h.camera.position.set(0, 600, 0);
    h.camera.lookAt(0, 900, -100); // up and away
    photo.enter();
    const dir = new THREE.Vector3();
    h.camera.getWorldDirection(dir);

    for (let i = 0; i < 60; i++) {
      photo.update(1 / 60, new Set(["KeyW"]), { x: 0, y: 0, jet: false, boost: false });
    }
    const moved = h.camera.position.clone().sub(new THREE.Vector3(0, 600, 0));
    expect(moved.length()).toBeGreaterThan(4);
    expect(moved.y).toBeGreaterThan(1); // it climbed, because the lens was
    expect(moved.clone().normalize().angleTo(dir)).toBeLessThan(0.05);
  });

  it("climbs on Space and drops on C", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    h.camera.position.set(0, 600, 0);
    photo.enter();
    for (let i = 0; i < 30; i++) {
      photo.update(1 / 60, new Set(["Space"]), { x: 0, y: 0, jet: false, boost: false });
    }
    const up = h.camera.position.y;
    expect(up).toBeGreaterThan(600);
    for (let i = 0; i < 60; i++) {
      photo.update(1 / 60, new Set(["KeyC"]), { x: 0, y: 0, jet: false, boost: false });
    }
    expect(h.camera.position.y).toBeLessThan(up);
  });

  it("flies from the touch stick too, so a phone can move the lens", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    h.camera.position.set(0, 600, 0);
    photo.enter();
    for (let i = 0; i < 60; i++) {
      photo.update(1 / 60, new Set(), { x: 0, y: -1, jet: false, boost: false });
    }
    expect(h.camera.position.distanceTo(new THREE.Vector3(0, 600, 0))).toBeGreaterThan(4);
  });

  it("looks with the world's own drag rate and never rolls over the top", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    for (let i = 0; i < 200; i++) photo.look(0, -60);
    photo.update(0.016, new Set(), { x: 0, y: 0, jet: false, boost: false });
    const dir = new THREE.Vector3();
    h.camera.getWorldDirection(dir);
    expect(dir.y).toBeLessThan(1);
    expect(dir.y).toBeGreaterThan(0.9);
    expect(Number.isFinite(dir.x)).toBe(true);
  });

  it("applies the lens, and only when it changes", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ fov: 24 });
    photo.update(0.016, new Set(), { x: 0, y: 0, jet: false, boost: false });
    expect(h.camera.fov).toBe(24);
    // Out of range is clamped rather than accepted: a zero FOV is a black frame.
    photo.set({ fov: 999 });
    expect(photo.options.fov).toBeLessThanOrEqual(110);
    photo.set({ fov: -20 });
    expect(photo.options.fov).toBeGreaterThanOrEqual(12);
  });

  it("takes the body out of the shot and puts it back", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    expect(h.body.visible).toBe(true);
    photo.enter();
    photo.set({ showBody: false });
    expect(h.body.visible).toBe(false);
    photo.exit();
    expect(h.body.visible).toBe(true);
  });

  it("previews the look on the canvas and clears it on the way out", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ filter: "grayscale(1)" });
    expect(h.canvas.style.filter).toBe("grayscale(1)");
    photo.exit();
    expect(h.canvas.style.filter).toBe("");
  });

  it("hands everything back on dispose", () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ showBody: false, filter: "invert(1)" });
    photo.dispose();
    expect(photo.active).toBe(false);
    expect(h.body.visible).toBe(true);
    expect(h.canvas.style.filter).toBe("");
  });
});

/* -------------------------------------------------------------------------
 * The shutter
 * ---------------------------------------------------------------------- */

describe("the shutter", () => {
  it("draws the frame between the two resizes, and only once", async () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ scale: 2 });
    await photo.shoot();

    const draws = h.log.filter((l) => l === "draw");
    expect(draws).toHaveLength(1);
    const at = h.log.indexOf("draw");
    // Up before, down after: the buffer is big while the frame is drawn and
    // read, and normal again by the time anybody sees another frame.
    expect(h.log.slice(0, at)).toContain("ratio:2");
    expect(h.log.slice(at)).toContain("ratio:1");
    expect(h.log.slice(0, at).filter((l) => l === "resize")).toHaveLength(1);
    expect(h.log.slice(at).filter((l) => l === "resize")).toHaveLength(1);
  });

  it("puts the renderer back even when the composite fails", async () => {
    /* jsdom has no 2D context, so `compose` returns null here — which is
     * exactly the case that matters: a capture that throws or bails must not
     * leave the world rendering at twice its resolution forever. */
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ scale: 2 });
    expect(await photo.shoot()).toBeNull();
    expect(h.ratio()).toBe(1);
    expect(h.log).not.toContain("shutter");
  });

  it("does not touch the renderer at all at 1×", async () => {
    const h = harness();
    const photo = createPhotoMode(h.host);
    photo.enter();
    photo.set({ scale: 1 });
    await photo.shoot();
    expect(h.log.filter((l) => l.startsWith("ratio:"))).toHaveLength(0);
    expect(h.log.filter((l) => l === "resize")).toHaveLength(0);
    expect(h.log).toContain("draw");
  });
});

describe("the defaults", () => {
  it("open on a normal lens, the whole screen, and no grade", () => {
    expect(PHOTO_DEFAULTS.aspect).toBeNull();
    expect(PHOTO_DEFAULTS.filter).toBe("none");
    expect(PHOTO_DEFAULTS.fov).toBeGreaterThan(35);
    expect(PHOTO_DEFAULTS.fov).toBeLessThan(70);
  });
});
