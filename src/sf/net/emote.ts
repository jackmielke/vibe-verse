/**
 * emote.ts — a wave you can see from across the street.
 *
 * The character rigs expose a gait and nothing else: no bones, no clips, no
 * pose control. Reaching in to animate an arm would mean changing
 * `characterRig.ts`, which the lobby, /city and the profile turntable all load
 * through, to add a gesture only one world uses. Not worth it — and honestly
 * not better, because these characters are round and armless-looking and a
 * carefully keyframed wave on one would read as a twitch.
 *
 * So the wave is a symbol that pops above your head, rises, and fades. It
 * reads instantly at any distance, in any character, on any device, and it is
 * one sprite and one number on the wire.
 *
 * The textures are cached per glyph and never freed: there are a handful of
 * emotes and a page will use each of them many times, so the cache is bounded
 * by the emote table rather than by how sociable anybody is.
 */
import * as THREE from "three";

/** Emote ids. On the wire as a number, so adding one never breaks an old peer. */
export const EMOTE_WAVE = 0;
export const EMOTE_COUNT = 1;

const GLYPH: Record<number, string> = {
  [EMOTE_WAVE]: "👋",
};

/**
 * What to draw when the emoji does not exist on this device.
 *
 * Not a hypothetical: a headless Linux Chromium ships no colour emoji font at
 * all, and plenty of real Linux and older Android installs do not either. The
 * failure is silent — `fillText` draws nothing, no error — so the wave simply
 * never appeared and everything downstream reported success, because the
 * sprite, the material and the network message were all perfectly fine.
 */
const FALLBACK: Record<number, string> = {
  [EMOTE_WAVE]: "HI!",
};

/** Seconds from pop to gone. */
export const EMOTE_SECONDS = 1.8;

const PX = 128;
const cache = new Map<number, THREE.Texture>();

function textureFor(id: number): THREE.Texture | null {
  const hit = cache.get(id);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = PX;
  canvas.height = PX;
  const ctx = canvas.getContext("2d");
  // No 2D context (a locked-down browser, a headless capture path) means no
  // emote rather than no world.
  if (!ctx) return null;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(PX * 0.78)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.fillText(GLYPH[id] ?? "👋", PX / 2, PX * 0.54);

  // Did anything actually land? Cheaper than font enumeration, exact rather
  // than a guess, and it runs once per glyph for the life of the page.
  if (isBlank(ctx)) {
    ctx.clearRect(0, 0, PX, PX);
    const label = FALLBACK[id] ?? "HI!";
    ctx.font = `800 ${Math.round(PX * 0.4)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    // A filled disc behind it, so the word reads against a bright facade as
    // well as against asphalt.
    ctx.fillStyle = "rgba(255,176,64,0.92)";
    ctx.beginPath();
    ctx.arc(PX / 2, PX / 2, PX * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(24,16,6,0.95)";
    ctx.fillText(label, PX / 2, PX * 0.54);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  cache.set(id, tex);
  return tex;
}

/** One playing emote, owned by whichever body raised it. */
export interface Emote {
  sprite: THREE.Sprite;
  /** Seconds since it started. */
  age: number;
}

/** True when every pixel is still fully transparent. */
function isBlank(ctx: CanvasRenderingContext2D): boolean {
  try {
    const data = ctx.getImageData(0, 0, PX, PX).data;
    // Alpha only, and in strides: a glyph that covers less than one pixel in
    // sixteen is not a glyph anybody was going to see anyway.
    for (let i = 3; i < data.length; i += 4 * 16) {
      if (data[i] !== 0) return false;
    }
    return true;
  } catch {
    // A browser that refuses `getImageData` (canvas fingerprinting defences)
    // tells us nothing, so assume the emoji drew and leave it alone.
    return false;
  }
}

export function startEmote(id: number): Emote | null {
  const tex = textureFor(id);
  if (!tex) return null;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    // Visible through the body it belongs to and through a car roof. A wave
    // you cannot see because somebody turned round is not a wave.
    depthTest: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 950;
  return { sprite, age: 0 };
}

/**
 * Advance one emote. Returns false once it is finished and should be removed.
 *
 * The motion is the whole readability: a fast overshooting pop so it catches
 * the eye, then a slow rise and a late fade so it is legible for most of its
 * life rather than being a flash.
 */
export function stepEmote(e: Emote, dt: number, baseY: number): boolean {
  e.age += dt;
  const t = e.age / EMOTE_SECONDS;
  if (t >= 1) return false;

  // Pop: overshoot 1.0 in the first fifth, settle back.
  const pop = t < 0.2 ? 1.35 * Math.sin((t / 0.2) * (Math.PI / 2)) : 1 + 0.35 * (1 - (t - 0.2) / 0.8);
  const scale = 0.42 * Math.min(pop, 1.35);
  e.sprite.scale.set(scale, scale, 1);
  e.sprite.position.y = baseY + 0.18 + t * 0.55;

  // Hold full opacity for the first two thirds, then go.
  const mat = e.sprite.material as THREE.SpriteMaterial;
  mat.opacity = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
  return true;
}

export function disposeEmote(e: Emote): void {
  e.sprite.removeFromParent();
  // The texture is shared and cached; only the per-emote material is ours.
  (e.sprite.material as THREE.SpriteMaterial).dispose();
}
