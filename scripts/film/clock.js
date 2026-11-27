/*
 * Virtual clock for filming a world one frame at a time.
 *
 * Injected before any page script by `scripts/world-film.mjs`. Until
 * `__film.freeze()` is called it does nothing at all. After it, time stops:
 * `performance.now()` and `Date.now()` only move when `__film.step(dt)` moves
 * them, and `requestAnimationFrame` callbacks wait for the next step. So a world
 * that renders at half a frame a second on the software renderer still films
 * at a smooth 30, because it never learns how slow the machine is.
 *
 * Plain JS (no TypeScript, no imports) because it runs as an init script.
 */
(() => {
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);

  let frozen = false;
  let vt = 0;
  let dateBase = 0;
  let vtBase = 0;
  let seq = 0;
  /** @type {Map<number, FrameRequestCallback>} */
  let queue = new Map();

  performance.now = () => (frozen ? vt : realNow());
  Date.now = () => (frozen ? dateBase + (vt - vtBase) : realDateNow());

  window.requestAnimationFrame = (cb) => {
    if (!frozen) return realRAF(cb);
    seq += 1;
    const id = -seq;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (id < 0) queue.delete(id);
    else realCAF(id);
  };

  /** The canvases worth filming: visible, bigger than an icon, in paint order. */
  function canvases() {
    return [...document.querySelectorAll("canvas")].filter((c) => {
      const r = c.getBoundingClientRect();
      if (r.width < 64 || r.height < 64) return false;
      const s = getComputedStyle(c);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
    });
  }

  const out = document.createElement("canvas");
  const ctx = out.getContext("2d");

  /**
   * Composite every visible canvas into one picture, at the viewport's aspect.
   * Has to run in the same task as the render: a WebGL canvas without
   * `preserveDrawingBuffer` is cleared once the frame is presented.
   */
  function grab(width, quality) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const k = width / vw;
    out.width = width;
    out.height = Math.round(vh * k);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    const list = canvases();
    for (const c of list) {
      const r = c.getBoundingClientRect();
      try {
        ctx.globalAlpha = Number(getComputedStyle(c).opacity) || 1;
        ctx.drawImage(c, r.left * k, r.top * k, r.width * k, r.height * k);
      } catch {
        /* a tainted or lost canvas; skip it */
      }
    }
    ctx.globalAlpha = 1;
    return { url: out.toDataURL("image/jpeg", quality), canvases: list.length };
  }

  window.__film = {
    get frozen() {
      return frozen;
    },
    freeze() {
      if (frozen) return;
      vt = realNow();
      vtBase = vt;
      dateBase = realDateNow();
      frozen = true;
    },
    /**
     * Advance the clock by `dt` seconds, run one animation frame, and, when
     * `width` is given, return the composited picture as a JPEG data URL.
     * `sub` runs extra frames first for worlds that clamp their step size.
     */
    step(dt, width, quality = 0.9, sub = 1) {
      let last = null;
      for (let s = 0; s < sub; s++) {
        vt += (dt * 1000) / sub;
        const due = queue;
        queue = new Map();
        for (const cb of due.values()) {
          try {
            cb(vt);
          } catch (e) {
            console.error("film frame error", e);
          }
        }
      }
      if (width) last = grab(width, quality);
      return last;
    },
    canvasCount: () => canvases().length,
  };
})();
