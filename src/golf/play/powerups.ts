/**
 * Vibe Golf — power-up balls.
 *
 * `rules.ts` owns the inventory, the multi-ball split and the raw tuning
 * (`power`/`bounce`/`drag`/`sticky`/`ghost`/`split`). This module owns
 * everything you can *see and feel*: the per-type behaviours that need a
 * system tick, the pickups scattered around a hole, ball selection, and the
 * preview of what a special ball will actually do to your shot.
 *
 * Design rule for this file: if a player can't tell nitro from standard
 * without reading a label, it has failed. So every type gets a distinct
 * silhouette, a distinct colour, a distinct trail and a distinct sound of
 * landing.
 *
 * How the ball gets re-skinned without touching `render.ts`: the renderer
 * draws a plain white sphere at `LAYER.ball`. We park our own skin 0.3 m
 * closer to the (orthographic) camera and keep its silhouette at or above the
 * true ball radius under every squash, so it simply covers the white one.
 * Every skin is therefore opaque — a depth-only mask to hide the renderer's
 * ball behind a translucent shell was tried and does *not* survive the post
 * pipeline (the white ball comes through anyway), so ghost fakes its
 * see-through read in the shader instead. If you rewrite the renderer, the
 * only contract this relies on is "one opaque sphere of `ball.radius` at
 * `LAYER.ball`".
 *
 * Publishes no service. Emits `golf:pickup`, `golf:ballPreview`,
 * `golf:phase` and `golf:burn`; consumes `golf:selectBall`, `golf:shot`,
 * `golf:bounce`, `golf:stick`, `golf:hole`, `golf:ballType`.
 */
import * as THREE from "three";
import type {
  BallState,
  BallType,
  GolfCtx,
  Hole,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { BALL_TYPES, MATERIALS, v2 } from "../types";
import { LAYER } from "../engine/core";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Selection order — also the 1..8 keyboard order. */
const ORDER: BallType[] = ["standard", "sticky", "ice", "nitro", "super", "multi", "ghost", "heavy"];

/** Nitro: sustained thrust along the velocity for this long after launch. */
const NITRO_BURN = 0.42;
/** Peak thrust, m/s². Decays across the burn so the kick reads as a *kick*. */
const NITRO_THRUST = 46;

/** Ghost stops phasing once it has been ghosting this long, regardless. */
const GHOST_PHASE_MAX = 3.4;
/** A contact normal this upright counts as "floor" — ghost lands on floors. */
const GHOST_FLOOR_NY = 0.42;

/** Fraction of rolling resistance the ice ball (and its trail) cancels. */
const ICE_GLIDE = 0.62;
/** Ice trail sample spacing and the radius over which it stays slick. */
const SLICK_STEP = 0.42;
const SLICK_RADIUS = 0.95;
const SLICK_LIFE = 7.5;
const SLICK_MAX = 72;

/** How much bigger than the physics ball each skin draws. Never below 1. */
const SKIN_SCALE: Record<BallType, number> = {
  standard: 1.0,
  sticky: 1.1,
  ice: 1.14,
  nitro: 1.08,
  super: 1.3,
  multi: 1.08,
  ghost: 1.16,
  heavy: 1.14,
};

/** Squash-and-stretch amplitude on impact, per type. Super is the loud one. */
const SQUASH_AMP: Record<BallType, number> = {
  standard: 0, sticky: 0.1, ice: 0.06, nitro: 0.16,
  super: 0.44, multi: 0.12, ghost: 0, heavy: 0.1,
};

/** Pickup spawn weights — the fun-but-fair ones show up more often. */
const PICKUP_WEIGHTS: Partial<Record<BallType, number>> = {
  sticky: 1.0, ice: 1.15, nitro: 1.3, super: 1.25, multi: 0.75, ghost: 0.7, heavy: 1.0,
};

const INVENTORY_CAP = 9;
const BALL_R = 0.32;

// ---------------------------------------------------------------------------
// Procedural glyphs — one small canvas per ball type, drawn as paths so we
// never depend on a font being present.
// ---------------------------------------------------------------------------

function glyphTexture(type: BallType): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;

  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 12;
  g.lineCap = "round";
  g.lineJoin = "round";
  const cx = 64;
  const cy = 64;

  const chevron = (x: number, y: number, s: number, rot: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.beginPath();
    g.moveTo(-s, -s);
    g.lineTo(s, 0);
    g.lineTo(-s, s);
    g.stroke();
    g.restore();
  };

  switch (type) {
    case "sticky": {
      // A splat: fat centre plus a few thrown droplets.
      g.beginPath();
      g.arc(cx, cy - 4, 30, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.5;
        g.beginPath();
        g.arc(cx + Math.cos(a) * 42, cy - 4 + Math.sin(a) * 42, 7 + (i % 2) * 4, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "ice": {
      // Six-spoke snowflake with barbs.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI;
        g.beginPath();
        g.moveTo(cx - Math.cos(a) * 46, cy - Math.sin(a) * 46);
        g.lineTo(cx + Math.cos(a) * 46, cy + Math.sin(a) * 46);
        g.stroke();
      }
      g.lineWidth = 8;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = cx + Math.cos(a) * 30;
        const py = cy + Math.sin(a) * 30;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(a + 0.9) * 16, py + Math.sin(a + 0.9) * 16);
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(a - 0.9) * 16, py + Math.sin(a - 0.9) * 16);
        g.stroke();
      }
      break;
    }
    case "nitro":
      chevron(cx - 16, cy, 22, 0);
      chevron(cx + 18, cy, 22, 0);
      break;
    case "super":
      chevron(cx, cy - 18, 24, -Math.PI / 2);
      chevron(cx, cy + 18, 24, -Math.PI / 2);
      break;
    case "multi":
      for (const [dx, dy] of [[0, -26], [-26, 20], [26, 20]] as [number, number][]) {
        g.beginPath();
        g.arc(cx + dx, cy + dy, 15, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case "ghost": {
      g.beginPath();
      g.arc(cx, cy - 8, 34, Math.PI, 0);
      g.lineTo(cx + 34, cy + 30);
      for (let i = 0; i < 3; i++) {
        g.quadraticCurveTo(cx + 34 - (i * 2 + 1) * 11.3, cy + 12, cx + 34 - (i + 1) * 22.7, cy + 30);
      }
      g.closePath();
      g.fill();
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.arc(cx - 12, cy - 8, 8, 0, Math.PI * 2);
      g.arc(cx + 12, cy - 8, 8, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = "source-over";
      break;
    }
    case "heavy":
      g.beginPath();
      g.moveTo(cx, cy - 40);
      g.lineTo(cx, cy + 14);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 22, cy - 8);
      g.lineTo(cx, cy + 18);
      g.lineTo(cx + 22, cy - 8);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 30, cy + 40);
      g.lineTo(cx + 30, cy + 40);
      g.stroke();
      break;
    default:
      g.lineWidth = 14;
      g.beginPath();
      g.arc(cx, cy, 32, 0, Math.PI * 2);
      g.stroke();
      break;
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

/**
 * A single pooled additive point cloud used for every effect in this file:
 * nitro flame, ice frost, heavy dust, pickup confetti, wind shear. One draw
 * call, one CPU loop, no allocation after construction.
 *
 * Point size is computed against the orthographic frustum height in the
 * vertex shader — three's own `sizeAttenuation` is a no-op under an ortho
 * camera, so world-sized sprites have to be done by hand.
 */
interface ParticlePool {
  points: THREE.Points;
  spawn(
    x: number, y: number, vx: number, vy: number,
    life: number, size: number, color: THREE.Color, alpha: number,
    grav: number, drag: number, grow: number,
  ): void;
  update(dt: number, pxPerMetre: number): void;
  clear(): void;
  dispose(): void;
}

function makeParticlePool(max: number, blending: THREE.Blending): ParticlePool {
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const siz = new Float32Array(max);
  const alf = new Float32Array(max);

  const px = new Float32Array(max);
  const py = new Float32Array(max);
  const vx = new Float32Array(max);
  const vy = new Float32Array(max);
  const life = new Float32Array(max);
  const maxLife = new Float32Array(max);
  const size0 = new Float32Array(max);
  const grow = new Float32Array(max);
  const alpha0 = new Float32Array(max);
  const grav = new Float32Array(max);
  const drag = new Float32Array(max);
  let count = 0;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alf, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 40 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending,
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uPx;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = aColor; vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uPx, 1.0, 220.0);
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r2);
        gl_FragColor = vec4(vColor, vAlpha * a * a);
      }`,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 24;
  points.position.z = LAYER.fx;

  return {
    points,
    spawn(x, y, ivx, ivy, l, size, color, alpha, g, d, grw) {
      if (count >= max) return;
      const i = count++;
      px[i] = x; py[i] = y;
      vx[i] = ivx; vy[i] = ivy;
      life[i] = l; maxLife[i] = l;
      size0[i] = size; grow[i] = grw;
      alpha0[i] = alpha; grav[i] = g; drag[i] = d;
      col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
    },
    update(dt, pxPerMetre) {
      (mat.uniforms.uPx.value as number) = pxPerMetre;
      for (let i = 0; i < count; i++) {
        life[i] -= dt;
        if (life[i] <= 0) {
          // Swap-remove keeps the live set dense with no allocation.
          const j = --count;
          if (j !== i) {
            px[i] = px[j]; py[i] = py[j]; vx[i] = vx[j]; vy[i] = vy[j];
            life[i] = life[j]; maxLife[i] = maxLife[j];
            size0[i] = size0[j]; grow[i] = grow[j];
            alpha0[i] = alpha0[j]; grav[i] = grav[j]; drag[i] = drag[j];
            col[i * 3] = col[j * 3]; col[i * 3 + 1] = col[j * 3 + 1]; col[i * 3 + 2] = col[j * 3 + 2];
          }
          i--;
          continue;
        }
        vy[i] += grav[i] * dt;
        const k = Math.max(0, 1 - drag[i] * dt);
        vx[i] *= k; vy[i] *= k;
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;

        const t = life[i] / maxLife[i];
        pos[i * 3] = px[i];
        pos[i * 3 + 1] = py[i];
        pos[i * 3 + 2] = 0;
        siz[i] = size0[i] * (1 + grow[i] * (1 - t));
        alf[i] = alpha0[i] * t * t;
      }
      geo.setDrawRange(0, count);
      const a = geo.attributes;
      (a.position as THREE.BufferAttribute).needsUpdate = true;
      (a.aColor as THREE.BufferAttribute).needsUpdate = true;
      (a.aSize as THREE.BufferAttribute).needsUpdate = true;
      (a.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    },
    clear() {
      count = 0;
      geo.setDrawRange(0, 0);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-ball runtime state
// ---------------------------------------------------------------------------

interface BallRuntime {
  /** The type the ball was *launched* as — ghost mutates `ball.type`. */
  type: BallType;
  /** False until `golf:shot` claims this ball; pre-shot balls stay inert. */
  launched: boolean;
  age: number;
  burn: number;
  phase: number;
  solid: boolean;
  /** Signed squash-stretch and its spring velocity. */
  s: number;
  sv: number;
  /** World angle the squash axis is measured along. */
  axis: number;
  impact: number;
  prev: Vec2;
  trailAcc: number;
  slickAcc: number;
  emitAcc: number;
  phaseAcc: number;
}

interface Skin {
  group: THREE.Group;
  core: THREE.Mesh;
  acc: THREE.Mesh;
  sats: THREE.Mesh[];
  glow: THREE.Mesh;
  glowMat: THREE.ShaderMaterial;
}

interface Pickup {
  group: THREE.Group;
  core: THREE.Mesh;
  cage: THREE.LineSegments;
  glyph: THREE.Mesh;
  glow: THREE.Mesh;
  type: BallType;
  base: Vec2;
  phase: number;
  taken: number;
  alive: boolean;
}

interface Splat {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
}

interface Slick {
  x: number;
  y: number;
  life: number;
}

// ---------------------------------------------------------------------------

const createPowerups: SystemFactory = (ctx: GolfCtx) => {
  const low = ctx.quality === "low";
  const root = new THREE.Group();
  root.name = "powerups";
  ctx.scene.add(root);

  // --- shared resources ---------------------------------------------------
  const sphereGeo = new THREE.SphereGeometry(1, low ? 14 : 22, low ? 10 : 16);
  const crystalGeo = new THREE.IcosahedronGeometry(1, 0);
  const bandGeo = new THREE.TorusGeometry(1.02, 0.17, 6, 20);
  const coneGeo = new THREE.ConeGeometry(0.62, 1.5, 10, 1, true);
  const satGeo = new THREE.SphereGeometry(0.3, 8, 6);
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const pickupCoreGeo = new THREE.IcosahedronGeometry(0.52, 0);
  const pickupCageGeo = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.98, 0));
  const ringGeo = new THREE.TorusGeometry(0.92, 0.1, 6, 26);

  const tintOf = (t: BallType) => new THREE.Color(BALL_TYPES[t]?.tint ?? 0xffffff);

  /** Radial additive glow — used by ball auras and pickup halos. */
  const glowShader = {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(uColor, a * a * uAlpha);
      }`,
  };
  const makeGlowMat = (color: THREE.Color) =>
    new THREE.ShaderMaterial({ ...glowShader, uniforms: { uColor: { value: color.clone() }, uAlpha: { value: 0.6 } } });

  /**
   * The ghost shell. Note this is *opaque*: a depth-only mask that hides the
   * renderer's white ball so a translucent shell could show the world behind
   * it was tried and does not survive the post pipeline — the ball came
   * through regardless. So the spectral read is done in the shader instead:
   * a near-black indigo body, a hot fresnel rim, and scan bands racing across
   * it. It covers the ball reliably and, at the size a ball occupies on a
   * phone, reads as "not solid" more clearly than real alpha did.
   */
  const ghostMat = new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    uniforms: {
      uColor: { value: tintOf("ghost") },
      uTime: { value: 0 },
      /** 1 while phasing, 0 once it has materialised. */
      uPhase: { value: 1 },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vP;
      void main(){
        vN = normalize(normalMatrix * normal);
        vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vN; varying vec3 vP;
      uniform vec3 uColor; uniform float uTime; uniform float uPhase;
      void main(){
        float f = pow(1.0 - abs(vN.z), 1.8);
        float band = 0.5 + 0.5 * sin(vP.y * 11.0 - uTime * (3.0 + uPhase * 5.0));
        vec3 body = uColor * mix(0.34, 0.07, uPhase);
        vec3 c = body
               + uColor * (0.9 + uPhase * 0.9) * f
               + uColor * 0.28 * band * (1.0 - f) * (0.35 + uPhase * 0.65);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  /** Standard-material cache, one per ball type. */
  const coreMats = new Map<BallType, THREE.Material>();
  function coreMatFor(t: BallType): THREE.Material {
    let m = coreMats.get(t);
    if (m) return m;
    if (t === "ghost") {
      coreMats.set(t, ghostMat);
      return ghostMat;
    }
    const tint = tintOf(t);
    const std = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: t === "ice" ? 0.1 : t === "heavy" ? 0.42 : t === "sticky" ? 0.85 : 0.3,
      metalness: t === "heavy" ? 0.78 : t === "ice" ? 0.05 : 0.05,
      emissive: tint.clone().multiplyScalar(t === "nitro" ? 0.55 : t === "super" ? 0.3 : t === "multi" ? 0.32 : 0.12),
      transparent: t === "ice",
      opacity: t === "ice" ? 0.86 : 1,
      flatShading: t === "ice",
    });
    coreMats.set(t, std);
    return std;
  }

  const accMats = {
    band: new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.9 }),
    flame: new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
    ghostCore: new THREE.MeshBasicMaterial({ color: 0xe6ecff }),
  };
  const satMat = new THREE.MeshStandardMaterial({
    color: tintOf("multi"), emissive: tintOf("multi").multiplyScalar(0.5), roughness: 0.3,
  });

  // --- particles ----------------------------------------------------------
  const sparks = makeParticlePool(low ? 180 : 420, THREE.AdditiveBlending);
  const smoke = makeParticlePool(low ? 90 : 200, THREE.NormalBlending);
  root.add(sparks.points, smoke.points);

  // --- ball skins ---------------------------------------------------------
  // Five is enough: multi splits into three and rules retires the rest.
  const SKIN_COUNT = 5;
  const skins: Skin[] = [];
  for (let i = 0; i < SKIN_COUNT; i++) {
    const group = new THREE.Group();
    group.visible = false;

    const core = new THREE.Mesh(sphereGeo, coreMatFor("standard"));
    core.renderOrder = 4;
    core.castShadow = false;

    const acc = new THREE.Mesh(bandGeo, accMats.band);
    acc.renderOrder = 5;
    acc.visible = false;

    const sats: THREE.Mesh[] = [];
    for (let s = 0; s < 2; s++) {
      const m = new THREE.Mesh(satGeo, satMat);
      m.visible = false;
      m.renderOrder = 5;
      sats.push(m);
    }

    const glowMat = makeGlowMat(new THREE.Color(0xffffff));
    const glow = new THREE.Mesh(quadGeo, glowMat);
    glow.renderOrder = 20;
    glow.position.z = 0.4;
    glow.visible = false;

    group.add(core, acc, glow, ...sats);
    root.add(group);
    skins.push({ group, core, acc, sats, glow, glowMat });
  }

  // --- sticky splats ------------------------------------------------------
  const splatShader = {
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor; uniform float uAlpha; uniform float uSeed;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float a = atan(p.y, p.x);
        float r = length(p);
        float edge = 0.54 + 0.15 * sin(a * 3.0 + uSeed)
                   + 0.09 * sin(a * 7.0 - uSeed * 1.7)
                   + 0.05 * sin(a * 11.0 + uSeed * 2.3);
        float m = smoothstep(edge, edge - 0.1, r);
        if (m < 0.02) discard;
        float sheen = smoothstep(0.0, 0.85, 1.0 - r);
        gl_FragColor = vec4(uColor * (0.7 + 0.65 * sheen), m * uAlpha);
      }`,
  };
  const splats: Splat[] = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.ShaderMaterial({
      ...splatShader,
      uniforms: {
        uColor: { value: tintOf("sticky").multiplyScalar(0.9) },
        uAlpha: { value: 0 },
        uSeed: { value: 0 },
      },
    });
    const mesh = new THREE.Mesh(quadGeo, mat);
    mesh.visible = false;
    mesh.renderOrder = 6;
    root.add(mesh);
    splats.push({ mesh, mat, life: 0 });
  }
  let splatNext = 0;

  // --- pickups ------------------------------------------------------------
  const pickups: Pickup[] = [];
  const glyphTex = new Map<BallType, THREE.CanvasTexture | null>();
  const glyphMats = new Map<BallType, THREE.MeshBasicMaterial>();
  function glyphMatFor(t: BallType): THREE.MeshBasicMaterial {
    let m = glyphMats.get(t);
    if (m) return m;
    if (!glyphTex.has(t)) glyphTex.set(t, glyphTexture(t));
    m = new THREE.MeshBasicMaterial({
      map: glyphTex.get(t) ?? null,
      transparent: true,
      depthWrite: false,
      opacity: 0.95,
      color: 0xffffff,
    });
    glyphMats.set(t, m);
    return m;
  }
  const cageMats = new Map<BallType, THREE.LineBasicMaterial>();
  function cageMatFor(t: BallType): THREE.LineBasicMaterial {
    let m = cageMats.get(t);
    if (m) return m;
    m = new THREE.LineBasicMaterial({ color: tintOf(t).lerp(new THREE.Color(0xffffff), 0.45), transparent: true, opacity: 0.9 });
    cageMats.set(t, m);
    return m;
  }
  const pickupGlowMats = new Map<BallType, THREE.ShaderMaterial>();
  function pickupGlowFor(t: BallType): THREE.ShaderMaterial {
    let m = pickupGlowMats.get(t);
    if (m) return m;
    m = makeGlowMat(tintOf(t));
    (m.uniforms.uAlpha.value as number) = 0.5;
    pickupGlowMats.set(t, m);
    return m;
  }

  // --- shot preview -------------------------------------------------------
  // The renderer's dotted arc is computed from the raw drag power, so it is
  // wrong the moment a power-up multiplies launch speed. Rather than fight it,
  // we draw the *truth*: where this ball actually lands, in the ball's colour.
  const PREVIEW_DOTS = 40;
  const previewGeo = new THREE.BufferGeometry();
  previewGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PREVIEW_DOTS * 3), 3));
  previewGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(PREVIEW_DOTS * 3), 3));
  previewGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(PREVIEW_DOTS), 1));
  previewGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(PREVIEW_DOTS), 1));
  previewGeo.setDrawRange(0, 0);
  previewGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const previewMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 40 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uPx;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = aColor; vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uPx, 1.0, 90.0);
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.25, 0.02, r2));
      }`,
  });
  const previewDots = new THREE.Points(previewGeo, previewMat);
  previewDots.frustumCulled = false;
  previewDots.renderOrder = 25;
  previewDots.position.z = LAYER.fx + 1;
  previewDots.visible = false;
  const landingRing = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
  );
  landingRing.renderOrder = 26;
  landingRing.visible = false;
  root.add(previewDots, landingRing);

  // --- state --------------------------------------------------------------
  const runtimes = new WeakMap<BallState, BallRuntime>();
  const slicks: Slick[] = [];
  let slickHead = 0;
  let aim: { aiming: boolean; power: number; from?: Vec2; dir?: Vec2 } = { aiming: false, power: 0 };
  let previewTick = 0;
  let hole: Hole | null = null;
  const tmpV = v2(0, 0);
  const tmpColor = new THREE.Color();
  const dbSize = new THREE.Vector2();

  function ballsList(): BallState[] {
    return ctx.services.physics?.balls ?? [];
  }

  function runtimeFor(b: BallState): BallRuntime {
    let rt = runtimes.get(b);
    if (!rt) {
      rt = {
        type: b.type,
        launched: false,
        age: 0,
        burn: 0,
        phase: 0,
        solid: false,
        s: 0, sv: 0, axis: 0, impact: 0,
        prev: v2(b.pos.x, b.pos.y),
        trailAcc: 0, slickAcc: 0, emitAcc: 0, phaseAcc: 0,
      };
      runtimes.set(b, rt);
    }
    return rt;
  }

  // -------------------------------------------------------------------------
  // Selection + preview publishing
  // -------------------------------------------------------------------------

  function publishPreview(denied = false): void {
    const rules = ctx.services.rules;
    const type = rules?.ballType ?? "standard";
    const p = BALL_TYPES[type];
    if (!p) return;

    // Range under vacuum scales with launch speed squared; it's the honest
    // way to tell the player "this goes ~2× further", not "+42% power".
    const range = p.power * p.power;
    const tags: string[] = [];
    if (p.power !== 1) tags.push(`${p.power > 1 ? "+" : ""}${Math.round((p.power - 1) * 100)}% launch`);
    if (p.bounce !== 1) tags.push(`${p.bounce > 1 ? "+" : ""}${Math.round((p.bounce - 1) * 100)}% bounce`);
    if (p.drag > 1.3) tags.push("wind-proof");
    if (p.sticky) tags.push("sticks on contact");
    if (p.ghost) tags.push("phases through walls");
    if (p.split) tags.push(`${p.split} balls, best counts`);
    if (type === "ice") tags.push("slick trail");
    if (type === "nitro") tags.push("afterburner");

    ctx.emit("golf:ballPreview", {
      type,
      name: p.name,
      blurb: p.blurb,
      tint: p.tint,
      power: p.power,
      bounce: p.bounce,
      drag: p.drag,
      sticky: Boolean(p.sticky),
      ghost: Boolean(p.ghost),
      split: p.split ?? 1,
      powerScale: p.power,
      rangeScale: range,
      launchSpeedFull: 6 + 46 * p.power,
      count: type === "standard" ? -1 : ctx.services.rules?.inventory?.[type] ?? 0,
      inventory: { ...(ctx.services.rules?.inventory ?? {}) },
      order: ORDER,
      tags,
      denied,
    });
  }

  function select(type: BallType): void {
    const rules = ctx.services.rules;
    if (!rules || !BALL_TYPES[type]) return;
    // Swapping mid-flight would rewrite the ball under the player; only allow
    // it when a shot is actually pending.
    const stock = type === "standard" ? 1 : rules.inventory?.[type] ?? 0;
    if (!rules.canShoot || stock <= 0) {
      ctx.services.audio?.play("deny", { volume: 0.35 });
      publishPreview(true);
      return;
    }
    if (rules.ballType === type) return;
    rules.setBallType(type);
    ctx.services.audio?.play("select", { volume: 0.4 });
    // A quick puff of the new colour off the ball so the swap is felt on a
    // phone where the picker sits under a thumb.
    const b = ballsList().find((x) => x.active);
    if (b) {
      tmpColor.set(BALL_TYPES[type].tint);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        sparks.spawn(b.pos.x, b.pos.y, Math.cos(a) * 3.2, Math.sin(a) * 3.2 + 1, 0.3, 0.16, tmpColor, 0.7, -3, 3.4, 0.4);
      }
    }
    publishPreview();
  }

  // -------------------------------------------------------------------------
  // Pickups
  // -------------------------------------------------------------------------

  function clearPickups(): void {
    for (const p of pickups) {
      root.remove(p.group);
      p.group.clear();
    }
    pickups.length = 0;
  }

  function weightedType(): BallType {
    let total = 0;
    for (const t of ORDER) total += PICKUP_WEIGHTS[t] ?? 0;
    let r = ctx.rng() * total;
    for (const t of ORDER) {
      const w = PICKUP_WEIGHTS[t] ?? 0;
      if (w <= 0) continue;
      r -= w;
      if (r <= 0) return t;
    }
    return "nitro";
  }

  /** Walk downwards until the broadphase finds something to stand on. */
  function groundBelow(x: number, topY: number, botY: number): { y: number; material: SurfaceMaterial } | null {
    const phys = ctx.services.physics;
    if (!phys) return null;
    for (let y = topY; y > botY; y -= 0.9) {
      tmpV.x = x;
      tmpV.y = y;
      const hit = phys.probe(tmpV, 1.0);
      if (hit) return { y: hit.point.y, material: hit.material };
    }
    return null;
  }

  function makePickup(type: BallType, at: Vec2): Pickup {
    const group = new THREE.Group();
    group.position.set(at.x, at.y, LAYER.props + 1.2);

    const core = new THREE.Mesh(pickupCoreGeo, coreMatFor(type));
    core.renderOrder = 3;

    const cage = new THREE.LineSegments(pickupCageGeo, cageMatFor(type));
    cage.renderOrder = 4;

    const glyph = new THREE.Mesh(quadGeo, glyphMatFor(type));
    glyph.scale.setScalar(0.95);
    glyph.position.z = 1.1;
    glyph.renderOrder = 21;

    const glow = new THREE.Mesh(quadGeo, pickupGlowFor(type));
    glow.scale.setScalar(5.4);
    glow.position.z = -0.6;
    glow.renderOrder = 19;

    group.add(glow, core, cage, glyph);
    root.add(group);
    return { group, core, cage, glyph, glow, type, base: v2(at.x, at.y), phase: ctx.rng() * 6.283, taken: 0, alive: true };
  }

  function buildPickups(h: Hole): void {
    clearPickups();
    const span = h.cup.x - h.tee.x;
    if (span < 20) return;
    const n = 2 + Math.floor(ctx.rng() * 2.4);
    const topY = Math.max(h.tee.y, h.cup.y) + 26;
    const botY = h.bounds.min.y + 1;

    for (let i = 0; i < n; i++) {
      const f = (i + 0.55 + (ctx.rng() - 0.5) * 0.4) / n;
      const x = h.tee.x + 12 + (span - 20) * Math.min(0.96, Math.max(0.04, f));
      if (Math.abs(x - h.cup.x) < 7) continue;
      const g = groundBelow(x, topY, botY);
      if (!g) continue;
      const lethal = MATERIALS[g.material]?.lethal;
      let y = g.y + (lethal ? 5.2 : 3.4 + ctx.rng() * 3.6);
      // Never bury a pickup inside a block; lift once and give up gracefully.
      tmpV.x = x; tmpV.y = y;
      if (ctx.services.physics?.probe(tmpV, 1.7)) y += 2.8;
      pickups.push(makePickup(weightedType(), v2(x, y)));
    }
  }

  function grant(p: Pickup, at: Vec2): void {
    const rules = ctx.services.rules;
    const props = BALL_TYPES[p.type];
    p.alive = false;
    p.taken = 0.45;

    let count = 0;
    if (rules?.inventory) {
      count = Math.min(INVENTORY_CAP, (rules.inventory[p.type] ?? 0) + 1);
      rules.inventory[p.type] = count;
    }

    tmpColor.set(props.tint);
    for (let i = 0; i < (low ? 16 : 34); i++) {
      const a = ctx.rng() * Math.PI * 2;
      const sp = 3 + ctx.rng() * 11;
      sparks.spawn(p.base.x, p.base.y, Math.cos(a) * sp, Math.sin(a) * sp + 2, 0.5 + ctx.rng() * 0.5,
        0.24 + ctx.rng() * 0.22, tmpColor, 1, -7, 1.4, 0.5);
    }
    ctx.services.vfx?.ring(v2(p.base.x, p.base.y), 2.4, props.tint);
    ctx.services.vfx?.screenShake(0.16);
    ctx.services.audio?.play("pickup", { volume: 0.6 });
    ctx.emit("golf:pickup", {
      type: p.type,
      name: props.name,
      blurb: props.blurb,
      tint: props.tint,
      count,
      at: { x: at.x, y: at.y },
    });
    publishPreview();
  }

  // -------------------------------------------------------------------------
  // Per-type behaviours
  // -------------------------------------------------------------------------

  function addSlick(x: number, y: number): void {
    const s = { x, y, life: SLICK_LIFE };
    if (slicks.length < SLICK_MAX) slicks.push(s);
    else {
      slicks[slickHead] = s;
      slickHead = (slickHead + 1) % SLICK_MAX;
    }
  }

  function onSlick(x: number, y: number): boolean {
    for (let i = 0; i < slicks.length; i++) {
      const s = slicks[i];
      if (s.life <= 0) continue;
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy < SLICK_RADIUS * SLICK_RADIUS) return true;
    }
    return false;
  }

  function splat(at: Vec2, nx: number, ny: number): void {
    const s = splats[splatNext];
    splatNext = (splatNext + 1) % splats.length;
    s.life = 14;
    s.mesh.visible = true;
    s.mesh.position.set(at.x + nx * 0.06, at.y + ny * 0.06, LAYER.props + 0.8);
    s.mesh.rotation.z = Math.atan2(ny, nx) - Math.PI / 2;
    s.mesh.scale.set(2.1, 1.7, 1);
    (s.mat.uniforms.uSeed.value as number) = ctx.rng() * 6.283;
    (s.mat.uniforms.uAlpha.value as number) = 0.92;

    tmpColor.set(BALL_TYPES.sticky.tint);
    for (let i = 0; i < 12; i++) {
      const a = Math.atan2(ny, nx) + (ctx.rng() - 0.5) * 2.2;
      const sp = 1.5 + ctx.rng() * 5;
      sparks.spawn(at.x, at.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.5, 0.2, tmpColor, 0.85, -12, 1.2, 0.3);
    }
  }

  function heavyThump(at: Vec2, speed: number): void {
    const k = Math.min(1, speed / 26);
    ctx.services.vfx?.screenShake(0.25 + k * 0.7);
    ctx.services.vfx?.ring(v2(at.x, at.y), 1.6 + k * 2.2, 0xb9c2cf);
    ctx.services.audio?.play("thump", { volume: 0.45 + k * 0.55, rate: 0.7 });
    tmpColor.set(0xcbd5e1);
    const n = low ? 12 : 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI + (ctx.rng() - 0.5) * 0.5;
      const sp = (2 + ctx.rng() * 7) * (0.5 + k);
      smoke.spawn(at.x, at.y + 0.15, Math.cos(a) * sp * 1.6, Math.abs(Math.sin(a)) * sp * 0.5,
        0.55 + ctx.rng() * 0.5, 0.5 + ctx.rng() * 0.5, tmpColor, 0.3, -1.5, 2.6, 1.6);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const offs: Array<() => void> = [];

  offs.push(ctx.on("golf:hole", (payload) => {
    const d = payload as { hole: Hole };
    hole = d?.hole ?? null;
    slicks.length = 0;
    slickHead = 0;
    sparks.clear();
    smoke.clear();
    for (const s of splats) {
      s.life = 0;
      s.mesh.visible = false;
    }
    if (hole) buildPickups(hole);
    publishPreview();
  }));

  offs.push(ctx.on("golf:shot", () => {
    // Balls were rebuilt by `takeShot`; prime their runtimes now so the burn
    // and phase windows start on the exact frame of launch.
    for (const b of ballsList()) {
      runtimes.delete(b);
      const rt = runtimeFor(b);
      rt.launched = true;
      rt.type = b.type;
      rt.solid = b.type !== "ghost";
      if (b.type === "nitro") rt.burn = NITRO_BURN;
      if (b.type === "ghost") rt.phase = GHOST_PHASE_MAX;
      rt.prev.x = b.pos.x;
      rt.prev.y = b.pos.y;
      if (rt.type === "nitro") {
        ctx.services.vfx?.screenShake(0.5);
        ctx.services.audio?.play("nitro", { volume: 0.7 });
        ctx.emit("golf:burn", { on: true, duration: NITRO_BURN });
      }
    }
    previewDots.visible = false;
    landingRing.visible = false;
  }));

  offs.push(ctx.on("golf:ballType", () => publishPreview()));
  offs.push(ctx.on("golf:ready", () => publishPreview()));

  offs.push(ctx.on("golf:selectBall", (payload) => {
    const t = typeof payload === "string"
      ? payload
      : (payload as { type?: string; ball?: string })?.type ?? (payload as { ball?: string })?.ball;
    if (t && (BALL_TYPES as Record<string, unknown>)[t]) select(t as BallType);
  }));

  offs.push(ctx.on("golf:aim", (payload) => {
    aim = (payload as typeof aim) ?? { aiming: false, power: 0 };
  }));

  offs.push(ctx.on("golf:stick", (payload) => {
    const at = (payload as { at?: Vec2 })?.at;
    if (!at) return;
    const hit = ctx.services.physics?.probe(v2(at.x, at.y), BALL_R + 0.5);
    splat(v2(at.x, at.y), hit?.normal.x ?? 0, hit?.normal.y ?? 1);
  }));

  offs.push(ctx.on("golf:bounce", (payload) => {
    const d = payload as { at?: Vec2; material?: SurfaceMaterial; speed?: number };
    if (!d?.at) return;
    const speed = d.speed ?? 0;
    const b = nearestBall(d.at);
    if (!b) return;
    const rt = runtimeFor(b);
    const amp = SQUASH_AMP[rt.type] ?? 0;

    const hit = ctx.services.physics?.probe(v2(d.at.x, d.at.y), BALL_R + 0.6);
    const nx = hit?.normal.x ?? 0;
    const ny = hit?.normal.y ?? 1;

    if (amp > 0) {
      // Pancake against the contact plane: shrink along the normal, bulge
      // across it. The spring in `update` handles the rebound wobble.
      rt.axis = Math.atan2(ny, nx);
      rt.impact = 0.14;
      rt.s = -amp * Math.min(1, 0.35 + speed / 22);
      rt.sv = 0;
    }

    if (rt.type === "super" && speed > 3) {
      ctx.services.audio?.play("boing", { volume: Math.min(1, 0.3 + speed / 26), rate: 0.9 + Math.min(0.8, speed / 30) });
      ctx.services.vfx?.ring(v2(d.at.x, d.at.y), 1.1 + Math.min(2, speed / 12), BALL_TYPES.super.tint);
      tmpColor.set(BALL_TYPES.super.tint);
      for (let i = 0; i < 10; i++) {
        const a = Math.atan2(ny, nx) + (ctx.rng() - 0.5) * 2.4;
        const sp = 2 + ctx.rng() * 6;
        sparks.spawn(d.at.x, d.at.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.34, 0.22, tmpColor, 0.9, -10, 1.5, 0.5);
      }
    }
    if (rt.type === "heavy" && speed > 5) heavyThump(d.at, speed);
    if (rt.type === "ice" && speed > 2) {
      tmpColor.set(BALL_TYPES.ice.tint);
      for (let i = 0; i < 8; i++) {
        const a = Math.atan2(ny, nx) + (ctx.rng() - 0.5) * 2.0;
        sparks.spawn(d.at.x, d.at.y, Math.cos(a) * (2 + ctx.rng() * 5), Math.sin(a) * (2 + ctx.rng() * 5),
          0.5, 0.18, tmpColor, 0.8, -8, 1.1, 0.4);
      }
    }
  }));

  function nearestBall(at: Vec2): BallState | null {
    let best: BallState | null = null;
    let bd = 4;
    for (const b of ballsList()) {
      if (!b.active) continue;
      const d = Math.hypot(b.pos.x - at.x, b.pos.y - at.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Landing preview
  // -------------------------------------------------------------------------

  function updatePreview(): void {
    const rules = ctx.services.rules;
    const phys = ctx.services.physics;
    const type = rules?.ballType ?? "standard";
    if (!phys || !rules || type === "standard" || !aim.aiming || !aim.from || !aim.dir) {
      previewDots.visible = false;
      landingRing.visible = false;
      return;
    }
    // Only every third frame — it's a dozen sweeps and the arc barely moves.
    if (previewTick++ % 3 !== 0 && previewDots.visible) return;

    const props = BALL_TYPES[type];
    const speed = 6 + aim.power * 46 * props.power;
    const windScale = props.drag > 1.3 ? 0.15 : 1;
    let px = aim.from.x;
    let py = aim.from.y;
    let vx = aim.dir.x * speed;
    let vy = aim.dir.y * speed;

    const posArr = previewGeo.attributes.position.array as Float32Array;
    const colArr = previewGeo.attributes.aColor.array as Float32Array;
    const sizArr = previewGeo.attributes.aSize.array as Float32Array;
    const alfArr = previewGeo.attributes.aAlpha.array as Float32Array;
    tmpColor.set(props.tint);

    const h = 0.035;
    const from = v2(0, 0);
    const to = v2(0, 0);
    let dots = 0;
    let landed: Vec2 | null = null;

    for (let step = 0; step < 132 && dots < PREVIEW_DOTS; step++) {
      from.x = px;
      from.y = py;
      vx += phys.gravity.x * h + phys.wind.x * h * windScale * 0.6;
      vy += phys.gravity.y * h + phys.wind.y * h * windScale * 0.6;
      const sp = Math.hypot(vx, vy);
      const air = Math.exp(-0.055 * props.drag * h * Math.max(1, sp * 0.06));
      vx *= air;
      vy *= air;
      px += vx * h;
      py += vy * h;
      to.x = px;
      to.y = py;

      // Ignore the ground the ball is already sitting on — at rest the centre
      // is a hair over one radius from the surface, so a naive sweep from the
      // lie reports an immediate "landing" under the player's feet.
      const dx0 = to.x - aim.from.x;
      const dy0 = to.y - aim.from.y;
      const hit = dx0 * dx0 + dy0 * dy0 < BALL_R * BALL_R * 6 ? null : phys.sweep(from, to, BALL_R);
      if (hit) {
        // The ghost ball only stops on non-lethal floors — walls and water
        // are things it goes through, so the preview must ignore them too.
        const isFloor = hit.normal.y > GHOST_FLOOR_NY && !MATERIALS[hit.material]?.lethal;
        if (!props.ghost || isFloor) {
          landed = v2(hit.point.x + hit.normal.x * BALL_R, hit.point.y + hit.normal.y * BALL_R);
          break;
        }
      }
      if (hole && (px < hole.bounds.min.x || px > hole.bounds.max.x || py < hole.bounds.min.y)) break;

      // Every fourth integration step becomes a dot — dense enough to read as
      // an arc, sparse enough not to fight the renderer's own preview.
      if (step % 4 === 3) {
        const i = dots++;
        posArr[i * 3] = px;
        posArr[i * 3 + 1] = py;
        posArr[i * 3 + 2] = 0;
        colArr[i * 3] = tmpColor.r;
        colArr[i * 3 + 1] = tmpColor.g;
        colArr[i * 3 + 2] = tmpColor.b;
        sizArr[i] = 0.26 + 0.16 * (i / PREVIEW_DOTS);
        alfArr[i] = 0.4 + 0.55 * (i / PREVIEW_DOTS);
      }
    }

    previewGeo.setDrawRange(0, dots);
    (previewGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (previewGeo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (previewGeo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (previewGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    previewDots.visible = dots > 0;

    if (landed) {
      landingRing.visible = true;
      landingRing.position.set(landed.x, landed.y, LAYER.fx + 1);
      landingRing.scale.setScalar(1 + 0.12 * Math.sin(ctx.elapsed * 7));
      (landingRing.material as THREE.MeshBasicMaterial).color.set(props.tint);
    } else {
      landingRing.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  // Skin rendering
  // -------------------------------------------------------------------------

  function dressSkin(skin: Skin, b: BallState, rt: BallRuntime, dt: number): void {
    const type = rt.type;
    const props = BALL_TYPES[type];
    const isGhostPhasing = type === "ghost" && !rt.solid;

    skin.group.visible = true;
    skin.group.position.set(b.pos.x, b.pos.y, LAYER.ball + 0.3);

    // Squash-and-stretch spring. Airborne stretch tracks the velocity; the
    // bounce handler kicks `s` negative and this rings it back out.
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const amp = SQUASH_AMP[type] ?? 0;
    if (rt.impact > 0) rt.impact -= dt;
    else if (speed > 1) rt.axis = Math.atan2(b.vel.y, b.vel.x);
    const target = rt.impact > 0 ? rt.s : Math.min(amp * 0.7, speed * 0.006 * (amp > 0 ? 1 : 0));
    rt.sv += (target - rt.s) * 150 * dt - rt.sv * 13 * dt;
    rt.s += rt.sv * dt;
    rt.s = Math.max(-0.5, Math.min(0.5, rt.s));

    // Volume-ish preserving squash: one axis by `k`, the other by `1/k`. The
    // skin must never shrink below the renderer's own ball or the white
    // sphere underneath peeks out, so a hard squash grows the whole ball
    // instead of thinning it — which is also exactly how a squash *should*
    // look: wider and flatter, not smaller.
    const k = 1 + rt.s;
    const kmin = Math.min(k, 1 / k);
    const base = Math.max(BALL_R * (SKIN_SCALE[type] ?? 1.05), (BALL_R * 1.09) / kmin);
    skin.core.rotation.z = rt.axis;
    skin.core.geometry = type === "ice" ? crystalGeo : sphereGeo;
    skin.core.material = coreMatFor(type);
    skin.core.renderOrder = 4;
    skin.core.scale.set(base * k, base / k, base);
    // The ice crystal tumbles so its facets catch the key light.
    skin.core.rotation.x = type === "ice" ? ctx.elapsed * 1.4 : 0;
    skin.core.visible = true;

    if (type === "ghost") {
      (ghostMat.uniforms.uTime.value as number) = ctx.elapsed;
      // Ease the phase flag so materialising is a visible half-second event
      // rather than a single-frame pop.
      const u = ghostMat.uniforms.uPhase.value as number;
      const want = isGhostPhasing ? 1 : 0;
      ghostMat.uniforms.uPhase.value = u + (want - u) * Math.min(1, dt * 6);
    }

    // Accessory: heavy's belt, nitro's thruster, ghost's core spark.
    skin.acc.visible = false;
    if (type === "heavy") {
      skin.acc.geometry = bandGeo;
      skin.acc.material = accMats.band;
      skin.acc.scale.setScalar(base * 0.98);
      skin.acc.rotation.set(0, 0, rt.axis + Math.PI / 2);
      skin.acc.position.set(0, 0, 0.02);
      skin.acc.visible = true;
    } else if (type === "nitro" && rt.burn > 0) {
      const t = rt.burn / NITRO_BURN;
      const ang = Math.atan2(b.vel.y, b.vel.x);
      skin.acc.geometry = coneGeo;
      skin.acc.material = accMats.flame;
      skin.acc.scale.set(base * 1.15, base * (1.7 + t * 2.4), base * 1.15);
      // Cone points +Y by default; aim it backwards down the velocity.
      skin.acc.rotation.set(0, 0, ang + Math.PI / 2);
      skin.acc.position.set(
        -Math.cos(ang) * base * (1.3 + t * 1.2),
        -Math.sin(ang) * base * (1.3 + t * 1.2),
        -0.1,
      );
      (accMats.flame as THREE.MeshBasicMaterial).opacity = 0.3 + t * 0.35;
      skin.acc.visible = true;
    } else if (isGhostPhasing) {
      skin.acc.geometry = sphereGeo;
      skin.acc.material = accMats.ghostCore;
      skin.acc.scale.setScalar(BALL_R * 0.3);
      skin.acc.position.set(0, 0, 0.15);
      skin.acc.rotation.set(0, 0, 0);
      skin.acc.visible = true;
    }

    // Multi advertises itself before you shoot: two orbiting shadows of the
    // balls that are about to exist.
    const showSats = type === "multi";
    for (let i = 0; i < skin.sats.length; i++) {
      const s = skin.sats[i];
      s.visible = showSats;
      if (!showSats) continue;
      const a = ctx.elapsed * 2.6 + (i / skin.sats.length) * Math.PI * 2;
      s.position.set(Math.cos(a) * base * 2.1, Math.sin(a) * base * 1.15, 0.2);
      s.scale.setScalar(base * 0.85);
    }

    // Aura. Kept deliberately faint — this is additive, and anything above
    // ~0.3 blows the ball itself out to white and destroys the one thing the
    // player most needs to read.
    const burning = type === "nitro" && rt.burn > 0;
    const auraAlpha =
      burning ? 0.34 + 0.1 * Math.sin(ctx.elapsed * 26) :
      type === "nitro" ? 0.15 :
      type === "super" ? 0.13 + Math.abs(rt.s) * 0.4 :
      type === "ghost" ? 0.2 + 0.06 * Math.sin(ctx.elapsed * 3.4) :
      type === "ice" ? 0.14 :
      type === "multi" ? 0.16 :
      type === "heavy" ? 0.07 : 0.1;
    skin.glow.visible = type !== "standard";
    if (skin.glow.visible) {
      (skin.glowMat.uniforms.uColor.value as THREE.Color).set(props.tint);
      (skin.glowMat.uniforms.uAlpha.value as number) = auraAlpha;
      skin.glow.scale.setScalar(base * (burning ? 5.4 : 3.4));
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  let published = false;

  const sys: System = {
    name: "powerups",
    update(dt) {
      const phys = ctx.services.physics;
      const rules = ctx.services.rules;
      if (!phys) return;

      if (!published && rules) {
        published = true;
        publishPreview();
      }

      // --- desktop shortcuts: 1..8 pick a ball ----------------------------
      const pressed = ctx.input?.pressed;
      if (pressed && pressed.size) {
        for (let i = 0; i < ORDER.length; i++) {
          if (pressed.has(`Digit${i + 1}`) || pressed.has(`Numpad${i + 1}`)) select(ORDER[i]);
        }
      }

      // --- slick decay ----------------------------------------------------
      for (let i = 0; i < slicks.length; i++) if (slicks[i].life > 0) slicks[i].life -= dt;

      // --- per-ball behaviour ---------------------------------------------
      const live = phys.balls.filter((b) => b.active);
      for (let i = 0; i < live.length; i++) {
        const b = live[i];
        const rt = runtimeFor(b);
        rt.age += dt;

        // A ball that hasn't been struck yet must behave like a plain ball no
        // matter what is selected: `setBallType` stamps the choice onto the
        // resting ball, and a resting *ghost* would sink through the tee while
        // a resting *sticky* would glue itself down before the swing. The skin
        // still previews the selection — only the physics stays neutral.
        if (!rt.launched) {
          rt.type = rules?.ballType ?? "standard";
          if (b.type !== "standard") b.type = "standard";
        }

        const type = rt.type;
        const speed = Math.hypot(b.vel.x, b.vel.y);

        // NITRO — sustained thrust down the velocity, then normal flight.
        if (type === "nitro" && rt.burn > 0 && !b.stuck) {
          const t = rt.burn / NITRO_BURN;
          if (speed > 0.5) {
            const f = NITRO_THRUST * (0.45 + 0.55 * t) * dt;
            b.vel.x += (b.vel.x / speed) * f;
            b.vel.y += (b.vel.y / speed) * f;
            b.resting = false;
            b.restTimer = 0;
          }
          rt.burn -= dt;
          rt.emitAcc += dt;
          const ang = Math.atan2(b.vel.y, b.vel.x);
          while (rt.emitAcc > 0.012) {
            rt.emitAcc -= 0.012;
            const jitter = (ctx.rng() - 0.5) * 0.7;
            const sp = 4 + ctx.rng() * 12;
            const bx = b.pos.x - Math.cos(ang) * 0.5;
            const by = b.pos.y - Math.sin(ang) * 0.5;
            tmpColor.setHSL(0.02 + ctx.rng() * 0.08, 1, 0.5 + ctx.rng() * 0.2);
            sparks.spawn(bx, by, -Math.cos(ang + jitter) * sp, -Math.sin(ang + jitter) * sp,
              0.2 + ctx.rng() * 0.16, 0.2 + ctx.rng() * 0.2, tmpColor, 0.85, 4, 3.5, 1.1);
            if (!low && ctx.rng() < 0.4) {
              tmpColor.setRGB(0.4, 0.38, 0.42);
              smoke.spawn(bx, by, -Math.cos(ang) * sp * 0.4, -Math.sin(ang) * sp * 0.4 + 1,
                0.6 + ctx.rng() * 0.5, 0.36, tmpColor, 0.2, 1.5, 1.6, 2.2);
            }
          }
          if (rt.burn <= 0) {
            ctx.emit("golf:burn", { on: false });
            ctx.services.audio?.play("nitroOut", { volume: 0.35 });
          }
        }

        // GHOST — phases through walls and hazards, but still lands on floors.
        // (Physics alone would let it fall straight through the fairway; the
        // swept floor test below is what makes the ball actually playable.)
        if (type === "ghost" && !rt.solid && rt.launched) {
          rt.phase -= dt;
          const hit = phys.sweep(rt.prev, b.pos, b.radius + 0.1);
          const insideSolid = hit != null;
          if (insideSolid) {
            rt.phaseAcc += dt;
            if (rt.phaseAcc > 0.05) {
              rt.phaseAcc = 0;
              tmpColor.set(BALL_TYPES.ghost.tint);
              for (let k = 0; k < 4; k++) {
                const a = ctx.rng() * Math.PI * 2;
                sparks.spawn(b.pos.x, b.pos.y, Math.cos(a) * 3, Math.sin(a) * 3, 0.32, 0.3, tmpColor, 0.75, 0, 2.2, 1.4);
              }
              ctx.emit("golf:phase", { at: { x: b.pos.x, y: b.pos.y }, material: hit?.material });
            }
          }
          const landing = hit && hit.normal.y > GHOST_FLOOR_NY && !MATERIALS[hit.material]?.lethal && b.vel.y < 0;
          if (landing && hit) {
            // Rewind to the contact so the solver resolves a real bounce.
            b.pos.x = hit.point.x + hit.normal.x * (b.radius + 0.01);
            b.pos.y = hit.point.y + hit.normal.y * (b.radius + 0.01);
            solidify(b, rt);
          } else if (rt.phase <= 0 && !phys.probe(b.pos, b.radius + 0.1)) {
            solidify(b, rt);
          }
        }

        // ICE — cancels most of the rolling resistance, and paints a slick
        // trail that keeps doing so for anything that follows.
        const supported = speed < 24 ? phys.probe(b.pos, b.radius + 0.08) : null;
        const rolling = supported != null && supported.normal.y > 0.25;
        if (rolling && speed > 0.55 && speed < 22) {
          const mat = MATERIALS[supported!.material];
          // The glide fades out across the shot. Without that a ball in a
          // bowl trades height for speed forever, never settles, and the
          // rules layer never hands control back to the player.
          const fade = Math.max(0, 1 - rt.age / 9);
          const glide = (type === "ice" ? ICE_GLIDE : onSlick(b.pos.x, b.pos.y) ? ICE_GLIDE * 0.75 : 0) * fade;
          if (glide > 0 && mat && !mat.lethal) {
            const push = mat.rollDrag * 9.81 * glide * dt;
            const inv = 1 / speed;
            b.vel.x += b.vel.x * inv * push;
            b.vel.y += b.vel.y * inv * push;
          }
        }
        if (type === "ice" && rolling && speed > 1) {
          rt.slickAcc += speed * dt;
          while (rt.slickAcc > SLICK_STEP) {
            rt.slickAcc -= SLICK_STEP;
            const cx = supported!.point.x;
            const cy = supported!.point.y;
            addSlick(cx, cy);
            tmpColor.set(BALL_TYPES.ice.tint);
            sparks.spawn(cx, cy + 0.08, (ctx.rng() - 0.5) * 0.6, 0.2, SLICK_LIFE * 0.55,
              0.45 + ctx.rng() * 0.3, tmpColor, 0.3, 0, 3, 0.5);
          }
        }

        // Airborne frost sparkle so the ice ball reads mid-flight too.
        if (type === "ice" && !rolling && speed > 6) {
          rt.trailAcc += dt;
          if (rt.trailAcc > 0.05) {
            rt.trailAcc = 0;
            tmpColor.set(BALL_TYPES.ice.tint);
            sparks.spawn(b.pos.x, b.pos.y, (ctx.rng() - 0.5) * 2, (ctx.rng() - 0.5) * 2, 0.5, 0.22, tmpColor, 0.7, -2, 1.4, 0.6);
          }
        }

        // MULTI — a violet thread of sparkle so three balls stay legible.
        if (type === "multi" && speed > 4) {
          rt.trailAcc += dt;
          if (rt.trailAcc > 0.06) {
            rt.trailAcc = 0;
            tmpColor.set(BALL_TYPES.multi.tint);
            sparks.spawn(b.pos.x, b.pos.y, 0, 0, 0.4, 0.24, tmpColor, 0.7, 0, 2, 0.4);
          }
        }

        // HEAVY — wind shear streaming past and refusing to move it. Physics
        // already scales wind down for the heavy ball; this makes it visible.
        if (type === "heavy" && !low) {
          const wsp = Math.hypot(phys.wind.x, phys.wind.y);
          if (wsp > 0.4 && speed > 1) {
            rt.trailAcc += dt;
            if (rt.trailAcc > 0.07) {
              rt.trailAcc = 0;
              const wx = phys.wind.x / wsp;
              const wy = phys.wind.y / wsp;
              const side = ctx.rng() < 0.5 ? 1 : -1;
              tmpColor.setRGB(0.72, 0.79, 0.88);
              smoke.spawn(
                b.pos.x - wx * 2.2 - wy * side * 0.9,
                b.pos.y - wy * 2.2 + wx * side * 0.9,
                wx * (wsp * 2 + 6) - wy * side * 5,
                wy * (wsp * 2 + 6) + wx * side * 5,
                0.4, 0.28, tmpColor, 0.28, 0, 1.2, 0.8,
              );
            }
          }
        }

        rt.prev.x = b.pos.x;
        rt.prev.y = b.pos.y;
      }

      // --- pickups --------------------------------------------------------
      for (const p of pickups) {
        if (p.taken > 0) {
          p.taken -= dt;
          const t = Math.max(0, p.taken / 0.45);
          p.group.scale.setScalar(t * t);
          p.group.visible = t > 0.01;
          continue;
        }
        if (!p.alive) {
          p.group.visible = false;
          continue;
        }
        p.phase += dt;
        const bob = Math.sin(p.phase * 1.7) * 0.34;
        p.group.position.y = p.base.y + bob;
        p.core.rotation.x += dt * 0.9;
        p.core.rotation.y += dt * 1.5;
        p.cage.rotation.z -= dt * 0.7;
        p.cage.rotation.y += dt * 0.5;
        const pulse = 0.42 + 0.18 * Math.sin(p.phase * 3.1);
        (p.glow.material as THREE.ShaderMaterial).uniforms.uAlpha.value = pulse;
        p.glyph.position.y = 1.25 + Math.sin(p.phase * 2.2) * 0.06;

        // Overlap test against every live ball.
        for (const b of live) {
          const dx = b.pos.x - p.group.position.x;
          const dy = b.pos.y - p.group.position.y;
          const r = 1.25 + b.radius;
          if (dx * dx + dy * dy < r * r) {
            grant(p, v2(b.pos.x, b.pos.y));
            break;
          }
        }
      }

      // --- splats fade ----------------------------------------------------
      for (const s of splats) {
        if (s.life <= 0) continue;
        s.life -= dt;
        (s.mat.uniforms.uAlpha.value as number) = Math.max(0, Math.min(0.92, s.life * 0.4));
        if (s.life <= 0) s.mesh.visible = false;
      }

      // --- skins ----------------------------------------------------------
      for (let i = 0; i < skins.length; i++) {
        const b = live[i];
        if (!b) {
          skins[i].group.visible = false;
          continue;
        }
        const rt = runtimeFor(b);
        if (rt.type === "standard") {
          skins[i].group.visible = false;
          continue;
        }
        dressSkin(skins[i], b, rt, dt);
      }

      updatePreview();

      // --- particles ------------------------------------------------------
      const cam = ctx.camera;
      ctx.renderer.getDrawingBufferSize(dbSize);
      const pxPerMetre = dbSize.y / Math.max(0.001, cam.top - cam.bottom);
      (previewMat.uniforms.uPx.value as number) = pxPerMetre;
      sparks.update(dt, pxPerMetre);
      smoke.update(dt, pxPerMetre);
    },

    dispose() {
      for (const off of offs) off();
      clearPickups();
      ctx.scene.remove(root);
      sparks.dispose();
      smoke.dispose();
      sphereGeo.dispose();
      crystalGeo.dispose();
      bandGeo.dispose();
      coneGeo.dispose();
      satGeo.dispose();
      quadGeo.dispose();
      pickupCoreGeo.dispose();
      pickupCageGeo.dispose();
      ringGeo.dispose();
      previewGeo.dispose();
      previewMat.dispose();
      (landingRing.material as THREE.Material).dispose();
      satMat.dispose();
      // `ghostMat` lives in `coreMats`, so it is covered by this loop.
      for (const m of coreMats.values()) m.dispose();
      for (const m of cageMats.values()) m.dispose();
      for (const m of pickupGlowMats.values()) m.dispose();
      for (const m of glyphMats.values()) m.dispose();
      for (const t of glyphTex.values()) t?.dispose();
      for (const s of splats) s.mat.dispose();
      for (const s of skins) s.glowMat.dispose();
      accMats.band.dispose();
      accMats.flame.dispose();
      accMats.ghostCore.dispose();
    },
  };

  /** Ghost stops phasing: swap the physics type back and flash a materialise. */
  function solidify(b: BallState, rt: BallRuntime): void {
    if (rt.solid) return;
    rt.solid = true;
    b.type = "standard";
    tmpColor.set(BALL_TYPES.ghost.tint);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      sparks.spawn(b.pos.x, b.pos.y, Math.cos(a) * 6, Math.sin(a) * 6, 0.36, 0.26, tmpColor, 0.95, -4, 3, 0.8);
    }
    ctx.services.vfx?.ring(v2(b.pos.x, b.pos.y), 1.6, BALL_TYPES.ghost.tint);
    ctx.services.audio?.play("phaseOut", { volume: 0.4 });
    ctx.emit("golf:phase", { at: { x: b.pos.x, y: b.pos.y }, solid: true });
  }

  return sys;
};

export default createPowerups;
