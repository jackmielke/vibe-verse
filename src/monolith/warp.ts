/**
 * The warp: a tunnel of coloured light streaks, drawn on a 2D canvas over
 * whatever world is underneath. It belongs to no engine, so every host and
 * /beyond use the same one.
 *
 * `warpIn` accelerates out of the scene, through a white-out, into black, and
 * resolves while the screen is still covered (that is when to navigate).
 * `warpOut` starts covered and decelerates back into a world. Between them a
 * page can reload: the hand-off is a sessionStorage flag, not a live canvas,
 * so a full navigation between two worlds still looks like one journey.
 */

const ID = "monolith-warp";
const ARRIVE_KEY = "monolith.arrive";

interface Streak { a: number; z: number; v: number; hue: number; w: number }

function overlay(): { el: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  let el = document.getElementById(ID) as HTMLCanvasElement | null;
  if (!el) {
    el = document.createElement("canvas");
    el.id = ID;
    Object.assign(el.style, {
      position: "fixed", inset: "0", width: "100vw", height: "100dvh",
      zIndex: "2147483000", pointerEvents: "none",
    } as CSSStyleDeclaration);
    document.body.appendChild(el);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.width = Math.round(window.innerWidth * dpr);
  el.height = Math.round(window.innerHeight * dpr);
  return { el, g: el.getContext("2d")! };
}

function makeStreaks(n: number): Streak[] {
  const out: Streak[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      a: Math.random() * Math.PI * 2,
      z: Math.random(),
      v: 0.6 + Math.random() * 0.8,
      hue: Math.random() * 360,
      w: 0.6 + Math.random() * 1.8,
    });
  }
  return out;
}

/** A rising, then rushing, sound. Best effort: no audio is fine. */
function whoosh(seconds: number, rising: boolean) {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const t0 = ac.currentTime;
    const len = Math.ceil(ac.sampleRate * seconds);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(rising ? 220 : 2400, t0);
    bp.frequency.exponentialRampToValueAtTime(rising ? 3200 : 180, t0 + seconds);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + seconds * (rising ? 0.85 : 0.15));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    const tone = ac.createOscillator();
    tone.type = "sine";
    tone.frequency.setValueAtTime(rising ? 55 : 220, t0);
    tone.frequency.exponentialRampToValueAtTime(rising ? 220 : 55, t0 + seconds);
    const tg = ac.createGain();
    tg.gain.setValueAtTime(0.0001, t0);
    tg.gain.exponentialRampToValueAtTime(0.18, t0 + seconds * 0.5);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    src.connect(bp).connect(gain).connect(ac.destination);
    tone.connect(tg).connect(ac.destination);
    src.start(t0);
    tone.start(t0);
    src.stop(t0 + seconds + 0.05);
    tone.stop(t0 + seconds + 0.05);
    window.setTimeout(() => void ac.close().catch(() => undefined), (seconds + 0.5) * 1000);
  } catch { /* no audio */ }
}

/**
 * One frame of the tunnel. `speed` 0..1 stretches the streaks, `cover` 0..1
 * is how much of the world behind is hidden, `white` 0..1 the flash.
 */
function draw(g: CanvasRenderingContext2D, w: number, h: number, streaks: Streak[], dt: number, speed: number, cover: number, white: number, time: number) {
  g.globalCompositeOperation = "source-over";
  g.fillStyle = `rgba(2,1,10,${cover})`;
  g.clearRect(0, 0, w, h);
  g.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.hypot(cx, cy);
  g.globalCompositeOperation = "lighter";
  g.lineCap = "round";
  for (const s of streaks) {
    s.z += dt * s.v * (0.15 + speed * 2.2);
    if (s.z > 1) { s.z -= 1; s.a = Math.random() * Math.PI * 2; }
    // Perspective: things near the eye race outward.
    const r1 = R * Math.pow(s.z, 2.2);
    const r0 = R * Math.pow(Math.max(0, s.z - 0.02 - speed * 0.22), 2.2);
    const ca = Math.cos(s.a), sa = Math.sin(s.a);
    const hue = (s.hue + time * 40) % 360;
    g.strokeStyle = `hsla(${hue},95%,${62 + speed * 18}%,${Math.min(1, 0.25 + s.z) * (0.4 + speed * 0.6)})`;
    g.lineWidth = s.w * (1 + s.z * 3) * (w / 1200 + 0.5);
    g.beginPath();
    g.moveTo(cx + ca * r0, cy + sa * r0);
    g.lineTo(cx + ca * r1, cy + sa * r1);
    g.stroke();
  }
  // A glow at the vanishing point.
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * (0.12 + speed * 0.2));
  core.addColorStop(0, `rgba(255,255,255,${0.25 + speed * 0.6})`);
  core.addColorStop(1, "rgba(160,120,255,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, w, h);
  if (white > 0) {
    g.globalCompositeOperation = "source-over";
    g.fillStyle = `rgba(255,255,255,${white})`;
    g.fillRect(0, 0, w, h);
  }
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** Into the tunnel. Resolves covered in black; navigate then. */
export function warpIn(seconds = 2.6, sound = true): Promise<void> {
  const { el, g } = overlay();
  const streaks = makeStreaks(window.innerWidth < 700 ? 260 : 420);
  if (sound) whoosh(seconds, true);
  try { sessionStorage.setItem(ARRIVE_KEY, String(Date.now())); } catch { /* ignore */ }
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = Math.min(1, (now - t0) / 1000 / seconds);
      const speed = ease(Math.min(1, t * 1.25));
      const cover = Math.min(1, 0.15 + t * 1.4);
      // White-out near the end, then black.
      const white = t < 0.78 ? 0 : t < 0.9 ? (t - 0.78) / 0.12 : 1 - (t - 0.9) / 0.1;
      draw(g, el.width, el.height, streaks, dt, speed, cover, Math.max(0, white), now / 1000);
      if (t < 1) requestAnimationFrame(frame);
      else {
        g.globalCompositeOperation = "source-over";
        g.fillStyle = "#02010a";
        g.fillRect(0, 0, el.width, el.height);
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

/** Out of the tunnel, into whatever has rendered underneath. */
export function warpOut(seconds = 2.2, sound = true): Promise<void> {
  const { el, g } = overlay();
  const streaks = makeStreaks(window.innerWidth < 700 ? 260 : 420);
  if (sound) whoosh(seconds, false);
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = Math.min(1, (now - t0) / 1000 / seconds);
      const speed = 1 - ease(t);
      const cover = 1 - ease(Math.min(1, Math.max(0, (t - 0.25) / 0.75)));
      const white = t < 0.12 ? 1 - t / 0.12 : 0;
      draw(g, el.width, el.height, streaks, dt, speed, cover, white * 0.8, now / 1000);
      if (t < 1) requestAnimationFrame(frame);
      else { el.remove(); resolve(); }
    };
    requestAnimationFrame(frame);
  });
}

/** Did this page load at the far end of a warp (within the last half minute)? */
export function arrivedByWarp(): boolean {
  try {
    const v = Number(sessionStorage.getItem(ARRIVE_KEY));
    sessionStorage.removeItem(ARRIVE_KEY);
    return !!v && Date.now() - v < 30_000;
  } catch {
    return false;
  }
}

/** Cover the screen at once (for the very first frame after a reload). */
export function coverNow(): void {
  const { el, g } = overlay();
  g.fillStyle = "#02010a";
  g.fillRect(0, 0, el.width, el.height);
}
