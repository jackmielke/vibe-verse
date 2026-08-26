/**
 * nameTag.ts — a legible name above a head.
 *
 * A canvas texture on a sprite. Two details do most of the work:
 *
 *  • **It is drawn at 2× and shown at 1×.** A name rendered at its display
 *    size and then filtered is mush at any angle; supersampling costs a few
 *    hundred kilobytes of texture per distinct name and is the difference
 *    between reading somebody's name and knowing they have one.
 *
 *  • **The text has a dark halo, not a drop shadow.** These float over a city
 *    that is white stucco in one direction and black asphalt in the other, and
 *    a single-sided shadow disappears against half of it.
 *
 * `sizeAttenuation` stays on, so a name genuinely recedes with the person
 * rather than following them around at a constant size, which reads as a
 * marker rather than as a label on somebody.
 */
import * as THREE from "three";

/** Display height of the tag in metres. */
const TAG_HEIGHT = 0.26;
const FONT_PX = 44;
const PAD_X = 18;
const SS = 2; // supersample factor

export function makeNameTag(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // A context is not guaranteed — a headless capture path or a browser with
  // canvas blocked returns null — and an unnamed peer is better than a crash.
  if (!ctx) {
    const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0 });
    return new THREE.Sprite(mat);
  }

  const font = `600 ${FONT_PX * SS}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(name).width;
  canvas.width = Math.ceil(textW + PAD_X * 2 * SS);
  canvas.height = Math.ceil((FONT_PX + 18) * SS);

  // Setting width/height resets the context, so everything below has to come
  // after the resize. This is the single most common way a canvas texture ends
  // up blank.
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Pill behind the text: enough to hold the letters off a busy facade without
  // becoming a UI element in its own right.
  const r = canvas.height * 0.34;
  ctx.fillStyle = "rgba(10,14,20,0.42)";
  roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, r);
  ctx.fill();

  ctx.lineJoin = "round";
  ctx.lineWidth = 6 * SS;
  ctx.strokeStyle = "rgba(6,9,14,0.85)";
  ctx.strokeText(name, cx, cy);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(name, cx, cy);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    // Names read *through* the person they belong to rather than being
    // swallowed by a shoulder, and through a car when somebody is driving.
    depthTest: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Drawn late, so a tag never fights the world's depth sort.
  sprite.renderOrder = 900;
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(TAG_HEIGHT * aspect, TAG_HEIGHT, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
