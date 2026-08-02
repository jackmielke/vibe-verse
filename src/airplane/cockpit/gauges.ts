/**
 * The instruments.
 *
 * Eleven working gauges on a 1979 flight deck, and the way they are built is
 * the whole reason they are readable at phone size and cost nothing per frame.
 *
 * ## Three kinds of thing, and never a fourth
 *
 * **Faces are drawn once.** Every dial's markings, numerals, arcs and bezel go
 * onto a canvas at boot and become a texture that is never touched again. The
 * obvious alternative — redraw each gauge every frame — is 2 MB of texture
 * upload per frame for this panel, which is 120 MB/s at 60 Hz and will melt a
 * phone for a picture nobody can tell apart.
 *
 * **Needles are geometry.** A needle is a rotating triangle, so it is a mesh
 * with `rotation.z` written each frame. That costs nothing, stays perfectly
 * sharp at any distance, and cannot alias.
 *
 * **Anything that is not a needle is a shader.** The attitude indicator is a
 * sphere seen through a window, which no amount of texture rotation gets
 * right, so it is drawn procedurally from pitch and bank; the rolling digit
 * drums on the altimeter are a digit strip with a UV offset per column. Both
 * are a handful of lines and both are exact.
 *
 * ## Why the numbers are in feet and knots
 *
 * Because the aeroplane is. The flight model works in metres and m/s
 * throughout and every conversion happens here, at the glass, which is the
 * only place either unit system is allowed to meet the other.
 */
import * as THREE from "three";
import { OUTPUT_GLSL, withEnv, type EnvUniforms } from "../world/env";
import { PALETTE, toFeet, toFpm, toKnots } from "../types";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Faces, drawn once onto canvases
// ---------------------------------------------------------------------------

const FACE_PX = 512;

function makeCanvas(size = FACE_PX): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  return { canvas, g };
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

/** The common dial: black face, a bezel, and a hairline of wear. */
function dialBase(g: CanvasRenderingContext2D, size = FACE_PX): void {
  const c = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = "#08090a";
  g.beginPath();
  g.arc(c, c, c * 0.97, 0, TAU);
  g.fill();
  // The bezel. Two rings, one light one dark, which is what makes a painted
  // metal rim read as metal rather than as a circle.
  g.strokeStyle = "#3a3d42";
  g.lineWidth = size * 0.045;
  g.beginPath();
  g.arc(c, c, c * 0.955, 0, TAU);
  g.stroke();
  g.strokeStyle = "#15171a";
  g.lineWidth = size * 0.018;
  g.beginPath();
  g.arc(c, c, c * 0.925, 0, TAU);
  g.stroke();
}

interface TickOpts {
  from: number;
  to: number;
  count: number;
  major: number;
  label?: (i: number) => string;
  inner?: number;
  color?: string;
}

/** Tick marks around an arc, with numerals on the majors. */
function ticks(g: CanvasRenderingContext2D, o: TickOpts, size = FACE_PX): void {
  const c = size / 2;
  const inner = o.inner ?? 0.7;
  g.save();
  g.translate(c, c);
  for (let i = 0; i <= o.count; i++) {
    const t = i / o.count;
    const a = o.from + (o.to - o.from) * t - Math.PI / 2;
    const isMajor = i % o.major === 0;
    const r0 = c * (isMajor ? inner : inner + 0.09);
    const r1 = c * 0.88;
    g.strokeStyle = o.color ?? "#e8e4d8";
    g.lineWidth = size * (isMajor ? 0.016 : 0.008);
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
    if (isMajor && o.label) {
      const text = o.label(i);
      if (text) {
        g.fillStyle = o.color ?? "#e8e4d8";
        g.font = `600 ${Math.round(size * 0.10)}px "Helvetica Neue", Arial, sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        const r = c * (inner - 0.10);
        g.fillText(text, Math.cos(a) * r, Math.sin(a) * r);
      }
    }
  }
  g.restore();
}

function title(g: CanvasRenderingContext2D, text: string, y = 0.30, size = FACE_PX): void {
  g.fillStyle = "#9a968a";
  g.font = `600 ${Math.round(size * 0.072)}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, size / 2, size * y);
}

/**
 * Airspeed. Knots, 40 through 400, with the colour bands a 707 carries.
 *
 * The white arc is the flap operating range and the red radial at the top is
 * Vmo. Both are load-bearing: the whole approach is flown by keeping the
 * needle in a band, and a dial with no bands on it is just a number you have
 * to remember a limit for.
 */
function airspeedFace(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas();
  const c = FACE_PX / 2;
  dialBase(g);
  // 40 kt at the top, sweeping clockwise through 400 over 320°.
  const from = 0.35;
  const to = 0.35 + TAU * 0.885;
  ticks(g, {
    from,
    to,
    count: 36,
    major: 4,
    label: (i) => {
      const kt = 40 + i * 10;
      return kt % 40 === 0 ? String(kt / 10) : "";
    },
  });

  const arc = (v0: number, v1: number, color: string, r: number, w: number) => {
    const a0 = from + ((v0 - 40) / 360) * (to - from) - Math.PI / 2;
    const a1 = from + ((v1 - 40) / 360) * (to - from) - Math.PI / 2;
    g.strokeStyle = color;
    g.lineWidth = FACE_PX * w;
    g.beginPath();
    g.arc(c, c, c * r, a0, a1);
    g.stroke();
  };
  arc(95, 230, "#e8e4d8", 0.90, 0.022);      // flap operating range
  arc(140, 356, "#2fbf5a", 0.83, 0.020);     // normal operating range
  arc(356, 400, "#e02020", 0.90, 0.030);     // the barber pole
  title(g, "AIRSPEED", 0.315);
  title(g, "KNOTS", 0.70);
  return canvas;
}

/** The three-pointer altimeter. Feet, hundreds on the long hand. */
function altimeterFace(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas();
  dialBase(g);
  ticks(g, {
    from: 0,
    to: TAU,
    count: 50,
    major: 5,
    label: (i) => (i % 5 === 0 && i < 50 ? String(i / 5) : ""),
    inner: 0.72,
  });
  title(g, "ALT", 0.30);
  title(g, "FEET", 0.745);
  return canvas;
}

/** Vertical speed, ±6,000 feet a minute, compressed at the ends as they are. */
function vsiFace(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas();
  const c = FACE_PX / 2;
  dialBase(g);
  g.save();
  g.translate(c, c);
  const marks = [0, 1, 2, 3, 4, 6];
  for (const m of marks) {
    for (const sign of m === 0 ? [1] : [1, -1]) {
      const a = vsiAngle(m * sign * 1000) - Math.PI / 2;
      g.strokeStyle = "#e8e4d8";
      g.lineWidth = FACE_PX * 0.014;
      g.beginPath();
      g.moveTo(Math.cos(a) * c * 0.72, Math.sin(a) * c * 0.72);
      g.lineTo(Math.cos(a) * c * 0.88, Math.sin(a) * c * 0.88);
      g.stroke();
      g.fillStyle = "#e8e4d8";
      g.font = `600 ${Math.round(FACE_PX * 0.095)}px Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(m), Math.cos(a) * c * 0.58, Math.sin(a) * c * 0.58);
    }
  }
  g.restore();
  title(g, "VERTICAL SPEED", 0.30);
  title(g, "1000 FT / MIN", 0.72);
  return canvas;
}

/**
 * The VSI's scale is not linear, and it matters.
 *
 * A real vertical-speed indicator devotes half its dial to the first 1,000
 * feet per minute and squeezes the rest in, because the difference between 200
 * and 400 fpm is what you fly an approach on and the difference between 4,000
 * and 5,000 is only interesting in an emergency.
 */
export function vsiAngle(fpm: number): number {
  const s = Math.sign(fpm);
  const a = Math.min(Math.abs(fpm), 6000) / 6000;
  return s * Math.pow(a, 0.55) * (TAU * 0.42);
}

/** Engine pressure ratio, the number a JT3D is actually set by. */
function engineFace(label: string): HTMLCanvasElement {
  const { canvas, g } = makeCanvas(256);
  dialBase(g, 256);
  ticks(
    g,
    {
      from: 0.55,
      to: 0.55 + TAU * 0.78,
      count: 10,
      major: 2,
      label: (i) => (i % 2 === 0 ? String(i * 10) : ""),
      inner: 0.66,
    },
    256,
  );
  title(g, label, 0.32, 256);
  return canvas;
}

/** The compass card of the HSI. Rotates as a whole. */
function compassCard(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas();
  const c = FACE_PX / 2;
  g.clearRect(0, 0, FACE_PX, FACE_PX);
  g.fillStyle = "#0a0b0c";
  g.beginPath();
  g.arc(c, c, c * 0.93, 0, TAU);
  g.fill();
  g.save();
  g.translate(c, c);
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180 - Math.PI / 2;
    const major = d % 30 === 0;
    g.strokeStyle = "#e8e4d8";
    g.lineWidth = FACE_PX * (major ? 0.014 : 0.007);
    g.beginPath();
    g.moveTo(Math.cos(a) * c * (major ? 0.72 : 0.79), Math.sin(a) * c * (major ? 0.72 : 0.79));
    g.lineTo(Math.cos(a) * c * 0.88, Math.sin(a) * c * 0.88);
    g.stroke();
    if (major) {
      const cardinal = ["N", "3", "6", "E", "12", "15", "S", "21", "24", "W", "30", "33"][d / 30];
      g.save();
      g.translate(Math.cos(a) * c * 0.60, Math.sin(a) * c * 0.60);
      g.rotate(a + Math.PI / 2);
      g.fillStyle = d % 90 === 0 ? "#ffd45e" : "#e8e4d8";
      g.font = `700 ${Math.round(FACE_PX * (d % 90 === 0 ? 0.12 : 0.095))}px Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(cardinal, 0, 0);
      g.restore();
    }
  }
  g.restore();
  return canvas;
}

/** A strip of digits 0–9, used by the rolling drums. */
function digitStrip(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 640;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#0c0d0e";
  g.fillRect(0, 0, 64, 640);
  g.fillStyle = "#f2efe6";
  g.font = `700 52px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let d = 0; d < 10; d++) g.fillText(String(d), 32, d * 64 + 32);
  const t = canvas;
  return t;
}

// ---------------------------------------------------------------------------
// The attitude director indicator, drawn in a shader
// ---------------------------------------------------------------------------

/**
 * A real ADI is a gimballed sphere painted sky-above/ground-below, seen
 * through a round window, with a fixed aeroplane symbol in front of it and the
 * ILS director bars laid across the whole thing.
 *
 * Rotating a texture cannot produce that, because the pitch scale has to
 * *translate* while the horizon *rotates*, and the two motions are about
 * different centres. Drawing it procedurally costs about thirty lines and is
 * exactly right at every attitude, including upside down — which, given who is
 * flying this aeroplane, is not a hypothetical.
 */
const ADI_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${OUTPUT_GLSL}
uniform float uPitch;     // radians
uniform float uBank;      // radians, positive right wing down
uniform float uSlip;      // −1..1, the ball
uniform float uLocNeedle; // −1..1
uniform float uGsNeedle;  // −1..1
uniform float uIlsAlpha;  // 0 when there is no ILS to show
uniform float uFlagAlpha; // the OFF flag
uniform vec3  uGlow;

float box(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  // Centred, ±1 across the instrument.
  vec2 uv = (vUv - 0.5) * 2.0;
  float r = length(uv);
  if (r > 1.0) discard;

  // Into the sphere's frame: unrotate by bank, then shift by pitch. Ten
  // degrees of pitch is a quarter of the visible ball, which is the standard
  // scale and the reason a 3° approach looks like a small deflection.
  float cb = cos(-uBank), sb = sin(-uBank);
  vec2 s = vec2(uv.x * cb - uv.y * sb, uv.x * sb + uv.y * cb);
  float horizon = s.y + uPitch * 2.6;

  vec3 sky = vec3(0.10, 0.30, 0.62);
  vec3 gnd = vec3(0.40, 0.24, 0.09);
  vec3 col = mix(gnd, sky, smoothstep(-0.012, 0.012, horizon));
  // The horizon line itself.
  col = mix(col, vec3(0.96), 1.0 - smoothstep(0.006, 0.016, abs(horizon)));

  // Pitch ladder: a rung every 5°, long ones every 10.
  for (int i = 1; i <= 6; i++) {
    float deg = float(i) * 5.0;
    float y = deg * 0.01745 * 2.6;
    float halfW = (mod(deg, 10.0) < 0.1) ? 0.34 : 0.18;
    for (int k = 0; k < 2; k++) {
      float yy = horizon - (k == 0 ? y : -y);
      float rung = 1.0 - smoothstep(0.004, 0.011, abs(yy));
      rung *= step(abs(s.x), halfW);
      col = mix(col, vec3(0.96), rung);
    }
  }

  // Bank scale around the top of the case, and the pointer that runs on it.
  float ang = atan(uv.x, uv.y);
  for (int i = 0; i < 7; i++) {
    float mark = (float(i) - 3.0) * 0.5236; // every 30°, ±90
    float d = abs(ang - mark);
    float tick = (1.0 - smoothstep(0.012, 0.03, d)) * smoothstep(0.80, 0.86, r);
    col = mix(col, vec3(0.95, 0.90, 0.70), tick);
  }
  float ptr = (1.0 - smoothstep(0.018, 0.045, abs(ang - uBank))) * smoothstep(0.70, 0.79, r)
            * (1.0 - smoothstep(0.79, 0.84, r));
  col = mix(col, vec3(1.0, 0.82, 0.20), ptr);

  // The fixed aeroplane: a centre dot and two wings that never move. This is
  // the reference everything else is read against.
  float wings = min(box(uv - vec2(0.30, 0.0), vec2(0.20, 0.012)),
                    box(uv + vec2(0.30, 0.0), vec2(0.20, 0.012)));
  wings = min(wings, box(uv, vec2(0.022, 0.022)));
  col = mix(col, vec3(1.0, 0.78, 0.10), 1.0 - smoothstep(0.0, 0.008, wings));

  // The flight director / ILS bars: one vertical for the localizer, one
  // horizontal for the glideslope. Fly towards them.
  if (uIlsAlpha > 0.01) {
    float v = box(vec2(uv.x - uLocNeedle * 0.55, uv.y), vec2(0.010, 0.60));
    float h = box(vec2(uv.x, uv.y - uGsNeedle * 0.55), vec2(0.60, 0.010));
    float bars = min(v, h);
    col = mix(col, vec3(0.85, 0.30, 0.85), (1.0 - smoothstep(0.0, 0.007, bars)) * uIlsAlpha);
  }

  // The slip ball, in its curved tube along the bottom.
  vec2 ballC = vec2(uSlip * 0.30, -0.80);
  float tube = abs(box(vec2(uv.x, uv.y + 0.80), vec2(0.34, 0.045)));
  col = mix(col, vec3(0.16), (1.0 - smoothstep(0.004, 0.012, tube)) * 0.9);
  float ball = length(uv - ballC) - 0.042;
  col = mix(col, vec3(0.92, 0.90, 0.84), 1.0 - smoothstep(0.0, 0.006, ball));

  // The OFF flag, when the instrument has nothing to tell you.
  if (uFlagAlpha > 0.01) {
    float flag = box(uv - vec2(-0.45, 0.45), vec2(0.20, 0.10));
    col = mix(col, vec3(0.75, 0.10, 0.08), (1.0 - smoothstep(0.0, 0.008, flag)) * uFlagAlpha);
  }

  // Vignette into the case, so the ball sits *inside* something.
  col *= 1.0 - smoothstep(0.86, 1.0, r) * 0.85;
  gl_FragColor = vec4(outputColor(col * uGlow), 1.0);
}
`;

const FLAT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A rolling digit drum: N columns of a digit strip, offset by the value. */
const DRUM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${OUTPUT_GLSL}
uniform sampler2D uDigits;
uniform float uValue;
uniform float uColumns;
uniform vec3  uGlow;
uniform float uRollLast;   // 1 if the last column rolls continuously

void main() {
  float col = floor(vUv.x * uColumns);
  // Most significant digit on the left.
  float place = pow(10.0, uColumns - 1.0 - col);
  float v = uValue / place;
  float digit = floor(mod(v, 10.0));
  // The lowest column rolls rather than snapping, the way a real drum does.
  float frac = (uRollLast > 0.5 && col == uColumns - 1.0) ? fract(max(v, 0.0)) : 0.0;

  float inCol = fract(vUv.x * uColumns);
  float y = (1.0 - vUv.y) + frac;
  float strip = (digit + y) / 10.0;
  vec4 tex = texture2D(uDigits, vec2(inCol * 0.7 + 0.15, fract(strip)));
  // Blank leading zeros above the first significant digit.
  float sig = step(place, max(abs(uValue), 1.0)) ;
  vec3 c = mix(vec3(0.05), tex.rgb, max(sig, step(uColumns - 1.5, col)));
  gl_FragColor = vec4(outputColor(c * uGlow), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface GaugeInputs {
  ias: number;          // m/s
  altitude: number;     // m MSL
  vs: number;           // m/s
  heading: number;      // radians
  pitch: number;
  bank: number;
  slip: number;         // −1..1
  n1: readonly number[];
  locNeedle: number;
  gsNeedle: number;
  ilsValid: boolean;
  radarAltitude: number; // m
  flapAngle: number;
  gearPosition: number;
  gearDown: boolean;
  dme: number;           // nautical miles
  stalled: boolean;
  /** 0..1 — how close to the stall. Below 0.12 the shaker is running. */
  stallMargin: number;
  overspeed: boolean;
  autopilotOn: boolean;
}

export interface GaugePanel {
  /** Everything, parented into the flight deck. */
  group: THREE.Group;
  update(v: GaugeInputs, dt: number): void;
  /** Turn the instrument backlighting up or down. */
  setBrightness(v: number): void;
  dispose(): void;
}

const _needleGeoCache: THREE.BufferGeometry[] = [];

/** A needle: a long thin triangle with a counterweight, pointing at 12 o'clock. */
function needleGeometry(length: number, width: number, tail: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-width, -tail);
  shape.lineTo(width, -tail);
  shape.lineTo(width * 0.35, length);
  shape.lineTo(-width * 0.35, length);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  _needleGeoCache.push(geo);
  return geo;
}

export function createGaugePanel(env: EnvUniforms): GaugePanel {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const glow = { value: new THREE.Color(0.85, 0.95, 0.88) };

  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  /** A dial: a lit face on a plane, with a black case ring behind it. */
  const dial = (
    face: HTMLCanvasElement,
    size: number,
    position: THREE.Vector3,
  ): THREE.Group => {
    const g = new THREE.Group();
    const tex = track(toTexture(face));
    const mat = track(
      new THREE.ShaderMaterial({
        vertexShader: FLAT_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          ${OUTPUT_GLSL}
          uniform sampler2D uMap;
          uniform vec3 uGlow;
          void main() {
            vec4 t = texture2D(uMap, vUv);
            if (t.a < 0.02) discard;
            gl_FragColor = vec4(outputColor(t.rgb * uGlow), t.a);
          }
        `,
        uniforms: { uMap: { value: tex }, uGlow: glow, uExposure: { value: 1 } },
        transparent: true,
      }),
    );
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(size, size)), mat);
    g.add(mesh);
    g.position.copy(position);
    group.add(g);
    return g;
  };

  const needleMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        ${OUTPUT_GLSL}
        uniform vec3 uColor;
        uniform vec3 uGlow;
        void main() { gl_FragColor = vec4(outputColor(uColor * uGlow), 1.0); }
      `,
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.needle) },
        uGlow: glow,
        uExposure: { value: 1 },
      },
    }),
  );

  const needle = (parent: THREE.Object3D, len: number, w: number, tail: number, z = 0.002) => {
    const mesh = new THREE.Mesh(needleGeometry(len, w, tail), needleMat);
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
  };

  // --- attitude director ---------------------------------------------------
  const adiUniforms = {
    uPitch: { value: 0 },
    uBank: { value: 0 },
    uSlip: { value: 0 },
    uLocNeedle: { value: 0 },
    uGsNeedle: { value: 0 },
    uIlsAlpha: { value: 0 },
    uFlagAlpha: { value: 0 },
    uGlow: glow,
    uExposure: { value: 1 },
  };
  const adiMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: ADI_FRAG,
      uniforms: adiUniforms,
      transparent: true,
    }),
  );
  const adi = new THREE.Mesh(track(new THREE.PlaneGeometry(0.146, 0.146)), adiMat);
  adi.position.set(0, 0.052, 0);
  group.add(adi);

  // --- airspeed, altimeter, VSI --------------------------------------------
  const asi = dial(airspeedFace(), 0.122, new THREE.Vector3(-0.156, 0.056, 0));
  const asiNeedle = needle(asi, 0.040, 0.0045, 0.010);

  const alt = dial(altimeterFace(), 0.122, new THREE.Vector3(0.156, 0.056, 0));
  const altHundreds = needle(alt, 0.042, 0.004, 0.010);
  const altThousands = needle(alt, 0.026, 0.006, 0.010);

  const vsi = dial(vsiFace(), 0.100, new THREE.Vector3(0.156, -0.086, 0));
  const vsiNeedle = needle(vsi, 0.034, 0.004, 0.008);

  // --- the altimeter's thousands drum --------------------------------------
  const digitTex = track(toTexture(digitStrip()));
  digitTex.generateMipmaps = false;
  digitTex.minFilter = THREE.LinearFilter;
  const drumUniforms = {
    uDigits: { value: digitTex },
    uValue: { value: 0 },
    uColumns: { value: 3 },
    uGlow: glow,
    uRollLast: { value: 0 },
    uExposure: { value: 1 },
  };
  const drumMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: DRUM_FRAG,
      uniforms: drumUniforms,
    }),
  );
  const drum = new THREE.Mesh(track(new THREE.PlaneGeometry(0.036, 0.015)), drumMat);
  drum.position.set(0.010, 0.006, 0.003);
  alt.add(drum);

  // --- horizontal situation indicator ---------------------------------------
  const hsi = new THREE.Group();
  hsi.position.set(0, -0.098, 0);
  group.add(hsi);
  const cardTex = track(toTexture(compassCard()));
  const cardMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        ${OUTPUT_GLSL}
        uniform sampler2D uMap;
        uniform vec3 uGlow;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          if (t.a < 0.02) discard;
          gl_FragColor = vec4(outputColor(t.rgb * uGlow), t.a);
        }
      `,
      uniforms: { uMap: { value: cardTex }, uGlow: glow, uExposure: { value: 1 } },
      transparent: true,
    }),
  );
  const card = new THREE.Mesh(track(new THREE.PlaneGeometry(0.134, 0.134)), cardMat);
  hsi.add(card);

  // The course arrow and the localizer bar that slides across it. On an HSI
  // the deviation bar is *part of* the course arrow, which is what makes the
  // instrument a picture of where you are rather than two numbers.
  const courseMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        ${OUTPUT_GLSL}
        uniform vec3 uColor;
        uniform vec3 uGlow;
        void main() { gl_FragColor = vec4(outputColor(uColor * uGlow), 1.0); }
      `,
      uniforms: {
        uColor: { value: new THREE.Color(0xffd45e) },
        uGlow: glow,
        uExposure: { value: 1 },
      },
    }),
  );
  const courseArrow = new THREE.Mesh(track(new THREE.PlaneGeometry(0.004, 0.086)), courseMat);
  courseArrow.position.z = 0.002;
  hsi.add(courseArrow);
  const locBar = new THREE.Mesh(track(new THREE.PlaneGeometry(0.0045, 0.050)), courseMat);
  locBar.position.z = 0.003;
  hsi.add(locBar);
  // Aircraft symbol, fixed at the centre.
  const hsiPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(0.030, 0.004)), needleMat);
  hsiPlane.position.z = 0.004;
  hsi.add(hsiPlane);
  // The glideslope pointer, up the right-hand side.
  const gsPointer = new THREE.Mesh(track(new THREE.PlaneGeometry(0.014, 0.004)), courseMat);
  gsPointer.position.set(0.070, 0, 0.003);
  hsi.add(gsPointer);

  // --- engines --------------------------------------------------------------
  const engines: THREE.Mesh[] = [];
  const engineFaceTex = engineFace("N1 %");
  for (let i = 0; i < 4; i++) {
    const e = dial(engineFaceTex, 0.056, new THREE.Vector3(-0.087 + i * 0.058, -0.200, 0));
    engines.push(needle(e, 0.018, 0.003, 0.005));
  }

  // --- radio altimeter, DME, flaps -----------------------------------------
  const raUniforms = {
    uDigits: { value: digitTex },
    uValue: { value: 0 },
    uColumns: { value: 4 },
    uGlow: glow,
    uRollLast: { value: 0 },
    uExposure: { value: 1 },
  };
  const raMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: DRUM_FRAG,
      uniforms: raUniforms,
    }),
  );
  const ra = new THREE.Mesh(track(new THREE.PlaneGeometry(0.052, 0.017)), raMat);
  ra.position.set(0, -0.032, 0.001);
  group.add(ra);

  const dmeUniforms = {
    uDigits: { value: digitTex },
    uValue: { value: 0 },
    uColumns: { value: 3 },
    uGlow: glow,
    uRollLast: { value: 1 },
    uExposure: { value: 1 },
  };
  const dmeMat = track(
    new THREE.ShaderMaterial({
      vertexShader: FLAT_VERT,
      fragmentShader: DRUM_FRAG,
      uniforms: dmeUniforms,
    }),
  );
  const dmeMesh = new THREE.Mesh(track(new THREE.PlaneGeometry(0.040, 0.017)), dmeMat);
  dmeMesh.position.set(0.156, -0.176, 0.001);
  group.add(dmeMesh);

  // --- annunciators: three greens, and the ones you never want lit ---------
  const lampMat = (color: number) =>
    track(
      new THREE.ShaderMaterial({
        vertexShader: FLAT_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          ${OUTPUT_GLSL}
          uniform vec3 uColor;
          uniform float uOn;
          void main() {
            vec2 p = abs(vUv - 0.5);
            float lens = 1.0 - smoothstep(0.34, 0.46, max(p.x, p.y));
            vec3 c = uColor * (0.045 + uOn * 2.6) * lens;
            gl_FragColor = vec4(outputColor(c), lens);
          }
        `,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uOn: { value: 0 },
          uExposure: { value: 1 },
        },
        transparent: true,
      }),
    );

  const lampGeo = track(new THREE.PlaneGeometry(0.016, 0.010));
  const makeLamp = (color: number, x: number, y: number) => {
    const m = lampMat(color);
    const mesh = new THREE.Mesh(lampGeo, m);
    mesh.position.set(x, y, 0.001);
    group.add(mesh);
    return m;
  };
  const gearLamps = [
    makeLamp(PALETTE.ok, -0.258, -0.064),
    makeLamp(PALETTE.ok, -0.258, -0.081),
    makeLamp(PALETTE.ok, -0.258, -0.099),
  ];
  const gearTransit = makeLamp(PALETTE.warn, -0.258, -0.041);
  const stallLamp = makeLamp(PALETTE.danger, -0.258, 0.157);
  const overspeedLamp = makeLamp(PALETTE.danger, 0.258, 0.157);
  const apLamp = makeLamp(0x3aa0ff, 0.258, 0.133);

  // --- flap position indicator ---------------------------------------------
  const flapPointer = new THREE.Mesh(track(new THREE.PlaneGeometry(0.014, 0.004)), courseMat);
  flapPointer.position.set(0.258, 0.023, 0.001);
  group.add(flapPointer);

  let markerBlink = 0;

  return {
    group,
    setBrightness(v: number) {
      glow.value.setRGB(0.85 * v, 0.95 * v, 0.88 * v);
    },
    update(v, dt) {
      markerBlink += dt;

      // Airspeed: 40 kt at the top, 320° of sweep to 400.
      const kt = toKnots(v.ias);
      const asiT = (Math.min(Math.max(kt, 40), 400) - 40) / 360;
      asiNeedle.rotation.z = -(0.35 + asiT * TAU * 0.885);

      // The three-pointer altimeter: one revolution per thousand feet on the
      // long hand, one per ten thousand on the short one.
      const ft = toFeet(v.altitude);
      altHundreds.rotation.z = -((ft % 1000) / 1000) * TAU;
      altThousands.rotation.z = -((ft % 10000) / 10000) * TAU;
      drumUniforms.uValue.value = Math.max(0, Math.floor(ft / 100));

      vsiNeedle.rotation.z = -vsiAngle(toFpm(v.vs));

      adiUniforms.uPitch.value = v.pitch;
      adiUniforms.uBank.value = v.bank;
      adiUniforms.uSlip.value = Math.max(-1, Math.min(1, v.slip));
      adiUniforms.uLocNeedle.value = -v.locNeedle;
      adiUniforms.uGsNeedle.value = v.gsNeedle;
      adiUniforms.uIlsAlpha.value = v.ilsValid ? 1 : 0;

      // The compass card turns so that the heading you are on sits under the
      // lubber line at the top — which means it rotates *against* you.
      card.rotation.z = v.heading;
      // The course arrow is set to the runway, so it stands still in space
      // while the card turns underneath it.
      const course = Math.PI / 2;
      courseArrow.rotation.z = v.heading - course;
      locBar.rotation.z = courseArrow.rotation.z;
      locBar.position.set(
        Math.cos(courseArrow.rotation.z + Math.PI / 2) * -v.locNeedle * 0.030,
        Math.sin(courseArrow.rotation.z + Math.PI / 2) * -v.locNeedle * 0.030,
        0.003,
      );
      gsPointer.position.y = v.ilsValid ? -v.gsNeedle * 0.040 : 0;
      gsPointer.visible = v.ilsValid;

      for (let i = 0; i < 4; i++) {
        engines[i].rotation.z = -(0.55 + Math.min(v.n1[i], 1) * TAU * 0.78);
      }

      raUniforms.uValue.value = Math.max(0, Math.round(toFeet(v.radarAltitude)));
      ra.visible = v.radarAltitude < 762; // the radio altimeter only reads to 2,500 ft
      dmeUniforms.uValue.value = Math.max(0, Math.min(v.dme * 10, 999));

      // Three greens: each leg gets its own lamp, and they come on as the
      // gear reaches the locks — not when the lever moves.
      const locked = v.gearPosition > 0.985 ? 1 : 0;
      for (const l of gearLamps) l.uniforms.uOn.value = locked;
      const inTransit = v.gearPosition > 0.01 && v.gearPosition < 0.985;
      gearTransit.uniforms.uOn.value = inTransit ? (Math.sin(markerBlink * 9) > 0 ? 1 : 0.2) : 0;

      flapPointer.position.y = 0.045 - (v.flapAngle / 50) * 0.05;

      // Annunciators, not gauges. They are either off, or they are the only
      // thing in the cockpit you are looking at. Both warnings flash rather
      // than glow: a steady red lamp in the corner of a dark flight deck is
      // remarkably easy not to notice, which is the entire reason real ones
      // flash and make a noise.
      const blink = Math.sin(markerBlink * 11) > -0.2 ? 1 : 0.1;
      stallLamp.uniforms.uOn.value = v.stalled ? blink : v.stallMargin < 0.12 ? 0.45 * blink : 0;
      overspeedLamp.uniforms.uOn.value = v.overspeed ? blink : 0;
      apLamp.uniforms.uOn.value = v.autopilotOn ? 1 : 0;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const g of _needleGeoCache.splice(0)) g.dispose();
    },
  };
}
