/**
 * The Magic Screen's program runner.
 *
 * A screen program is JavaScript written a moment ago by a model, from a
 * sentence somebody said out loud, and then broadcast to everybody in the
 * valley. So it runs as far from the page as a browser allows:
 *
 *   page ── postMessage ──▶ sandboxed iframe ── postMessage ──▶ worker
 *        ◀── ImageBitmap ──                   ◀── ImageBitmap ──
 *
 *  - The iframe is `sandbox="allow-scripts"` without `allow-same-origin`, so
 *    its origin is opaque: no cookies, no localStorage, no Supabase session,
 *    nothing of ours to read.
 *  - Its document carries a Content-Security-Policy of `default-src 'none'`,
 *    which the worker inherits: no fetch, no WebSocket, no importScripts, no
 *    eval. A program cannot phone anywhere.
 *  - The program itself runs in a worker inside that iframe, drawing to an
 *    OffscreenCanvas. An infinite loop hangs the worker, not the page; the
 *    iframe notices the frames stopped and terminates it.
 *
 * What comes back is pixels (an ImageBitmap per frame), an error string, or
 * a request for a beep, each checked for shape before the page touches it.
 */

export const SCREEN_W = 480;
export const SCREEN_H = 270;

export interface ScreenInput {
  left: boolean; right: boolean; up: boolean; down: boolean;
  a: boolean; b: boolean;
  /** Pointer on the screen, 0 to 1 from the top left. */
  x: number; y: number;
  pressed: boolean;
}

export const NO_INPUT: ScreenInput = { left: false, right: false, up: false, down: false, a: false, b: false, x: 0.5, y: 0.5, pressed: false };

export interface ScreenRuntime {
  /** Run a program. `startedAt` is wall-clock ms, so every viewer's `t` agrees. */
  load(code: string, startedAt: number): void;
  input(i: ScreenInput): void;
  pause(p: boolean): void;
  dispose(): void;
}

/**
 * What every program sees before its own code: the canvas, the input, a
 * seeded random, beep(), and the loop that calls its draw(). Kept as a
 * string because it is compiled inside the worker, never here.
 */
const PRELUDE = `
"use strict";
const W = ${SCREEN_W}, H = ${SCREEN_H};
const canvas = new OffscreenCanvas(W, H);
const ctx = canvas.getContext("2d");
let input = { left: false, right: false, up: false, down: false, a: false, b: false, x: 0.5, y: 0.5, pressed: false };
let __seed = 1234567;
function rand() { __seed = (__seed * 16807) % 2147483647; return (__seed - 1) / 2147483646; }
let __beeps = 0;
function beep(freq, seconds, type, volume) {
  if (__beeps > 12) return;
  __beeps++;
  postMessage({ beep: [Number(freq) || 440, Number(seconds) || 0.1, String(type || "square"), Number(volume == null ? 0.5 : volume)] });
}
const state = {};
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.input) input = m.input;
  if (m.pause !== undefined) __paused = !!m.pause;
};
let __paused = false;
`;

const LOOP = (fps: number, startedAt: number) => `
;(() => {
  const START = ${startedAt};
  let last = performance.now();
  let busy = false;
  let setupDone = false;
  let dead = false;
  setInterval(() => {
    __beeps = 0;
    if (dead || __paused) { postMessage({ alive: 1 }); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = Math.max(0, (Date.now() - START) / 1000);
    try {
      if (!setupDone) { setupDone = true; if (__program.setup) __program.setup(); }
      if (!__program.draw) throw new Error("The program has no draw(t, dt) function.");
      __program.draw(t, dt);
    } catch (err) {
      dead = true;
      postMessage({ err: String((err && (err.stack || err.message)) || err).slice(0, 600) });
      return;
    }
    if (busy) return;
    busy = true;
    createImageBitmap(canvas).then((bm) => { busy = false; postMessage({ f: bm }, [bm]); }, () => { busy = false; });
  }, ${Math.round(1000 / fps)});
})();
`;

/** The iframe's whole document: it relays, it watches, it never runs the program itself. */
function frameDocument(): string {
  const boot = `
    let worker = null, url = null, lastBeat = 0;
    function stop() { if (worker) { worker.terminate(); worker = null; } if (url) { URL.revokeObjectURL(url); url = null; } }
    window.addEventListener("message", (e) => {
      if (e.source !== parent) return;
      const m = e.data || {};
      if (m.load) {
        stop();
        try {
          url = URL.createObjectURL(new Blob([m.load], { type: "text/javascript" }));
          worker = new Worker(url);
        } catch (err) { parent.postMessage({ err: "The screen could not start a program here: " + err }, "*"); return; }
        lastBeat = Date.now();
        worker.onmessage = (ev) => {
          const d = ev.data || {};
          lastBeat = Date.now();
          if (d.f instanceof ImageBitmap) parent.postMessage({ f: d.f }, "*", [d.f]);
          else if (typeof d.err === "string") { parent.postMessage({ err: d.err.slice(0, 600) }, "*"); }
          else if (Array.isArray(d.beep)) parent.postMessage({ beep: d.beep.slice(0, 4) }, "*");
        };
        worker.onerror = (ev) => { ev.preventDefault(); parent.postMessage({ err: String(ev.message || "The program would not run.") + (ev.lineno ? " (line " + ev.lineno + ")" : "") }, "*"); stop(); };
      } else if (m.input || m.pause !== undefined) {
        if (worker) worker.postMessage(m);
        if (m.pause !== undefined) lastBeat = Date.now();
      } else if (m.stop) stop();
    });
    // A program that stops sending frames is stuck in a loop: end it. But if
    // this watchdog itself ran late, the page was busy (the frames may be
    // queued behind it), and a busy page is not a stuck program.
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const late = now - lastTick > 1200;
      lastTick = now;
      if (late) { lastBeat = Math.max(lastBeat, now - 1000); return; }
      if (worker && now - lastBeat > 3500) { stop(); parent.postMessage({ err: "The program froze (an endless loop?) and was stopped." }, "*"); }
    }, 500);
    parent.postMessage({ ready: 1 }, "*");
  `;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:">
</head><body><script>${boot}</` + `script></body></html>`;
}

export function createScreenRuntime(opts: {
  fps: number;
  onFrame(bitmap: ImageBitmap): void;
  onError(message: string): void;
  onBeep?(freq: number, seconds: number, type: OscillatorType, volume: number): void;
}): ScreenRuntime {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // On screen, one pixel, invisible: a display:none frame may be throttled.
  frame.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;z-index:-1;";
  frame.srcdoc = frameDocument();
  document.body.appendChild(frame);
  let ready = false;
  let pending: { code: string; startedAt: number } | null = null;
  let paused = false;
  const send = (m: unknown) => frame.contentWindow?.postMessage(m, "*");
  // The program gets a scope of its own: models redeclare W and H however
  // firmly they are told not to, and a const clash is a SyntaxError that
  // kills the whole worker. Inside a function they merely shadow.
  const start = (code: string, startedAt: number) => send({
    load: PRELUDE + "\nconst __program = (function () {\n" + code + "\n;return { setup: typeof setup === \"function\" ? setup : null, draw: typeof draw === \"function\" ? draw : null };\n})();\n" + LOOP(opts.fps, startedAt),
  });
  const beepTypes = new Set(["sine", "square", "sawtooth", "triangle"]);

  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as { f?: unknown; err?: unknown; beep?: unknown; ready?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.ready) {
      ready = true;
      if (pending) { start(pending.code, pending.startedAt); pending = null; }
      if (paused) send({ pause: true });
    } else if (typeof ImageBitmap !== "undefined" && d.f instanceof ImageBitmap) {
      if (d.f.width === SCREEN_W && d.f.height === SCREEN_H) opts.onFrame(d.f); else d.f.close();
    } else if (typeof d.err === "string") opts.onError(d.err.slice(0, 600));
    else if (Array.isArray(d.beep) && opts.onBeep) {
      const [f, s, t, v] = d.beep as unknown[];
      opts.onBeep(Number(f) || 440, Number(s) || 0.1, (beepTypes.has(String(t)) ? String(t) : "square") as OscillatorType, Math.max(0, Math.min(1, Number(v) || 0.5)));
    }
  };
  window.addEventListener("message", onMessage);

  return {
    load(code, startedAt) {
      if (!ready) { pending = { code, startedAt }; return; }
      start(code, startedAt);
    },
    input(i) { if (ready) send({ input: i }); },
    pause(p) { if (p === paused) return; paused = p; if (ready) send({ pause: p }); },
    dispose() {
      window.removeEventListener("message", onMessage);
      send({ stop: 1 });
      frame.remove();
    },
  };
}
