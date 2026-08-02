/**
 * Vibe Golf — jetpack traversal.
 *
 * Between shots you can fly the golfer around the hole to scout the line —
 * the Super Stickman Golf move. The ball is still the only thing that is
 * *played*; the golfer is a camera with a personality, so flying costs you
 * nothing but fuel and never moves the lie.
 *
 * Phone-first control: **hold anywhere to rise, and the golfer drifts toward
 * your thumb's X**. That's the whole scheme. Desktop gets WASD / arrows +
 * Space, and `J` (or the HUD button) toggles the mode.
 *
 * Two things in here are worth knowing before you edit it:
 *
 * 1. **Aim suppression.** `aim.ts` turns any canvas drag into a shot, and it
 *    updates *before* this system. Rather than mutate `rules.canShoot` — which
 *    `rules.update` would immediately set back to true, spraying `golf:ready`
 *    every frame — we swallow pointer events at the *capture* phase on
 *    `window` while flying, so the input system never sees them and the aim
 *    system stays inert. Pinch-zoom is therefore also parked while in flight;
 *    that's deliberate, the gesture is the flight control.
 * 2. **Camera hand-off.** While flying (and through the return glide) this
 *    emits `golf:cameraTarget` {x, y} every frame, and `null` when it lets go.
 *    `camera.ts` already consumes it as an override.
 *
 * **Returning is cosmetic.** The lie never moves: exiting either glides the
 * golfer back to the ball (a short hop) or simply cuts him back when he's more
 * than 16 m away. Either way the next shot is played from the ball, so a
 * scouting flight can't be a mistake.
 *
 * `character.ts` is still a stub, so the golfer drawn here is a self-contained
 * placeholder rig: it is only ever visible while flying or gliding home, so
 * whenever the character module lands there is exactly one golfer on screen.
 *
 * Emits `golf:jetpackState` {active, fuel, fuelMax, throttle, thrusting,
 * grounded, empty, dry, x, y} and `golf:cameraTarget`. Consumes `golf:jetpack`
 * (toggle / {on}), `golf:jetpackThrust` ({on} — for a HUD hold button),
 * `golf:hole`, `golf:holed`, `golf:shot`, `golf:penalty`.
 */
import * as THREE from "three";
import type { GolfCtx, Hole, System, SystemFactory, Vec2 } from "../types";
import { MATERIALS, v2 } from "../types";
import { LAYER } from "../engine/core";

// ---------------------------------------------------------------------------
// Tuning — all of it lives here so the feel can be dialled in one place.
// ---------------------------------------------------------------------------

/** Gravity on the golfer. Lighter than the ball's -22: he should float. */
const GRAVITY = 17.5;
/** Peak thrust, m/s². Net climb is THRUST - GRAVITY. */
const THRUST = 31;
/** Comfortable cruise speed sideways, m/s. */
const CRUISE = 11;
/** Lateral acceleration cap, m/s². */
const ACCEL = 34;
const MAX_UP = 14;
const MAX_DOWN = -23;

/** Seconds of continuous full thrust in a full tank. */
const BURN_SECONDS = 3.4;
const DRAIN = 1 / BURN_SECONDS;
/** Tank refills this fast once you're stood on something. */
const REFILL = 0.6;
/** Once dry, the pack won't relight until it has recovered this much. */
const RELIGHT = 0.14;

/** Collision proxy: two circles, hips and chest/head. */
const BODY: Array<{ oy: number; r: number }> = [
  { oy: -0.13, r: 0.42 },
  { oy: 0.45, r: 0.40 },
];
/** Feet, relative to the rig origin. */
const FOOT_Y = -0.55;

/** Return glide back to the ball on exit, seconds. */
const RETURN_TIME = 0.55;

/** Nozzle offsets in rig space (x is "behind" the golfer, he faces +X). */
const NOZZLE_X = -0.26;
const NOZZLE_Y = -0.08;
const NOZZLE_Z = 0.12;

const MAX_PARTICLES = 220;

// ---------------------------------------------------------------------------
// Exhaust particles — one pooled additive point cloud, no allocation per spawn.
//
// Point size is computed against the ortho frustum height in the vertex shader:
// three's `sizeAttenuation` is a no-op under an orthographic camera, so
// world-sized sprites have to be sized by hand.
// ---------------------------------------------------------------------------

interface Plume {
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

function makePlume(max: number): Plume {
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
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uPx;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = aColor; vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uPx, 1.0, 180.0);
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
  points.renderOrder = 23;
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

const createJetpack: SystemFactory = (ctx: GolfCtx) => {
  const low = ctx.quality === "low";
  const canvas = ctx.renderer?.domElement ?? null;

  // -------------------------------------------------------------------------
  // Scene graph
  // -------------------------------------------------------------------------

  const root = new THREE.Group();
  root.name = "jetpack";
  root.visible = false;
  ctx.scene?.add(root);

  /** Owned geometries/materials, disposed together at the end. */
  const owned: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  const quadGeo = keep(new THREE.PlaneGeometry(1, 1));
  const capsuleGeo = keep(new THREE.CapsuleGeometry(1, 1, low ? 2 : 4, low ? 6 : 10));
  const sphereGeo = keep(new THREE.SphereGeometry(1, low ? 10 : 18, low ? 8 : 12));
  const boxGeo = keep(new THREE.BoxGeometry(1, 1, 1));
  const cylGeo = keep(new THREE.CylinderGeometry(1, 1, 1, low ? 6 : 12, 1, false));
  const coneGeo = keep(new THREE.ConeGeometry(1, 1, low ? 6 : 10, 1, true));
  const ringGeo = keep(new THREE.TorusGeometry(0.86, 0.075, 6, 22));

  // The golfer is 40-odd pixels tall on a phone against a deep blue-black
  // sky *and* bright grass. Readability wins over realism: he's built from
  // pale, self-lit values so he never sinks into either. Every material
  // carries its own emissive floor so an unlit corner of a hole can't swallow
  // him.
  const litMat = (color: number, emissive: number, opts?: { rough?: number; metal?: number }) =>
    keep(new THREE.MeshStandardMaterial({
      color,
      roughness: opts?.rough ?? 0.6,
      metalness: opts?.metal ?? 0.05,
      emissive: new THREE.Color(color).multiplyScalar(emissive),
    }));

  const matShirt = litMat(0xf4f7fb, 0.34, { rough: 0.65 });
  const matTrouser = litMat(0x0f9e8e, 0.26, { rough: 0.55 });
  const matTrim = litMat(0xfbbf24, 0.42, { rough: 0.4, metal: 0.15 });
  const matSkin = litMat(0xffd9b0, 0.3, { rough: 0.8 });
  const matPack = litMat(0x94a3b8, 0.22, { rough: 0.32, metal: 0.7 });
  const matSteel = litMat(0xcbd5e1, 0.2, { rough: 0.28, metal: 0.85 });

  /** Soft teal separation glow behind the figure — the readability backstop. */
  const auraMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0x2dd4bf) }, uAlpha: { value: 0.14 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.05, d);
        gl_FragColor = vec4(uColor, a * a * uAlpha);
      }`,
  }));

  /** Flame: white-hot at the nozzle, amber then ember at the tip. */
  const flameMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uThrottle: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime; uniform float uThrottle;
      void main(){
        // uv.y runs 0 at the nozzle collar to 1 at the tip.
        float t = vUv.y;
        float flick = 0.80 + 0.20 * sin(uTime * 47.0 + t * 13.0)
                           * sin(uTime * 31.0 + 1.7);
        vec3 hot  = vec3(1.00, 0.97, 0.90);
        vec3 mid  = vec3(1.00, 0.72, 0.26);
        vec3 cool = vec3(0.98, 0.30, 0.14);
        vec3 c = mix(hot, mid, smoothstep(0.02, 0.42, t));
        c = mix(c, cool, smoothstep(0.38, 1.0, t));
        float a = pow(1.0 - t, 1.35) * flick * uThrottle;
        gl_FragColor = vec4(c, a);
      }`,
  }));

  const glowMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0xffb347) }, uAlpha: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(uColor, a * a * uAlpha);
      }`,
  }));

  /** Contact shadow — sells altitude, which is the readability win here. */
  const shadowMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: { uAlpha: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uAlpha;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.15, d);
        gl_FragColor = vec4(0.02, 0.04, 0.08, a * uAlpha);
      }`,
  }));

  /** Amber marker left on the ball so "home" is never lost off-screen. */
  const homeMat = keep(new THREE.MeshBasicMaterial({
    color: 0xfbbf24, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending,
  }));

  /**
   * Flat dark ink for the sticker outline — an inverted hull, so it has to
   * cull front faces or it would simply swallow the part it's outlining.
   */
  const matInk = keep(new THREE.MeshBasicMaterial({ color: 0x0a1020, side: THREE.BackSide }));

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => new THREE.Mesh(geo, mat);

  /**
   * The readability trick: a slightly fatter dark copy behind each big part.
   * It costs a handful of draws and buys a hard silhouette that survives both
   * a night sky and a lit fairway — the same reason SSG3's stickman has a
   * black keyline.
   */
  const outline = (m: THREE.Mesh, grow = 0.04): THREE.Mesh => {
    const o = new THREE.Mesh(m.geometry, matInk);
    o.position.copy(m.position);
    o.rotation.copy(m.rotation);
    o.scale.set(m.scale.x + grow, m.scale.y + grow * 0.7, m.scale.z + grow);
    o.renderOrder = -1;
    return o;
  };

  // --- the rig ------------------------------------------------------------
  const pilot = new THREE.Group();       // world position + lean
  const body = new THREE.Group();        // facing flip + squash
  pilot.add(body);
  pilot.position.z = LAYER.character;
  // A shade over life-size against a 0.64 m ball — the golfer has to be
  // legible at a glance, not anatomically fair.
  pilot.scale.setScalar(1.45);

  const aura = mesh(quadGeo, auraMat);
  aura.scale.set(2.2, 2.7, 1);
  aura.position.set(0, 0.2, -0.6);
  aura.renderOrder = 1;
  pilot.add(aura);

  const legs = new THREE.Group();
  legs.position.y = -0.06;
  for (const z of [-0.1, 0.1]) {
    const leg = mesh(capsuleGeo, matTrouser);
    leg.scale.set(0.075, 0.34, 0.075);
    leg.position.set(0, -0.24, z);
    legs.add(outline(leg, 0.04), leg);
    const shoe = mesh(capsuleGeo, matTrim);
    shoe.scale.set(0.085, 0.06, 0.085);
    shoe.position.set(0.03, -0.44, z);
    legs.add(outline(shoe, 0.03), shoe);
  }
  body.add(legs);

  const torso = mesh(capsuleGeo, matShirt);
  torso.scale.set(0.18, 0.38, 0.16);
  torso.position.y = 0.16;
  body.add(outline(torso, 0.05), torso);

  const belt = mesh(cylGeo, matTrim);
  belt.scale.set(0.185, 0.055, 0.17);
  belt.position.y = -0.14;
  body.add(belt);

  const collar = mesh(cylGeo, matTrim);
  collar.scale.set(0.155, 0.06, 0.145);
  collar.position.y = 0.5;
  body.add(collar);

  const head = mesh(sphereGeo, matSkin);
  head.scale.setScalar(0.17);
  head.position.set(0.02, 0.7, 0);
  body.add(outline(head, 0.05), head);

  const capDome = mesh(sphereGeo, matTrim);
  capDome.scale.set(0.175, 0.13, 0.175);
  capDome.position.set(0.02, 0.76, 0);
  body.add(capDome);

  const capBrim = mesh(cylGeo, matTrim);
  capBrim.scale.set(0.2, 0.022, 0.18);
  capBrim.position.set(0.14, 0.75, 0);
  body.add(capBrim);

  const arms: THREE.Mesh[] = [];
  for (const z of [-0.17, 0.17]) {
    const arm = mesh(capsuleGeo, matShirt);
    arm.scale.set(0.06, 0.3, 0.06);
    arm.position.set(0.04, 0.24, z);
    arm.rotation.z = 0.35;
    body.add(arm);
    arms.push(arm);
  }

  const pack = mesh(boxGeo, matPack);
  pack.scale.set(0.2, 0.44, 0.34);
  pack.position.set(NOZZLE_X, 0.22, 0);
  body.add(outline(pack, 0.05), pack);

  const packTrim = mesh(boxGeo, matTrim);
  packTrim.scale.set(0.075, 0.075, 0.36);
  packTrim.position.set(NOZZLE_X - 0.08, 0.32, 0);
  body.add(packTrim);

  const flames: THREE.Mesh[] = [];
  for (const z of [-NOZZLE_Z, NOZZLE_Z]) {
    const nozzle = mesh(cylGeo, matSteel);
    nozzle.scale.set(0.072, 0.14, 0.072);
    nozzle.position.set(NOZZLE_X, NOZZLE_Y + 0.06, z);
    body.add(nozzle);

    // Cone points +Y by default; flip it so the apex trails downward. After
    // the flip the base sits at +0.5·scaleY from the mesh origin.
    const flame = mesh(coneGeo, flameMat);
    flame.rotation.z = Math.PI;
    flame.renderOrder = 12;
    flame.position.set(NOZZLE_X, NOZZLE_Y, z);
    body.add(flame);
    flames.push(flame);
  }

  const glow = mesh(quadGeo, glowMat);
  glow.position.set(NOZZLE_X, NOZZLE_Y - 0.25, 0.3);
  glow.renderOrder = 22;
  body.add(glow);

  const shadow = mesh(quadGeo, shadowMat);
  shadow.renderOrder = 3;
  shadow.position.z = LAYER.props + 0.4;
  shadow.scale.set(1.4, 0.4, 1);

  const home = mesh(ringGeo, homeMat);
  home.renderOrder = 22;
  home.position.z = LAYER.fx;

  const plume = makePlume(low ? 110 : MAX_PARTICLES);
  root.add(pilot, shadow, home, plume.points);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let active = false;
  /** Return glide progress, > 0 while sliding the golfer home. */
  let returning = 0;
  const retFrom = v2(0, 0);

  const pos = v2(0, 0);
  const vel = v2(0, 0);
  let fuel = 1;
  let throttle = 0;
  let dry = false;
  let grounded = false;
  let facing = 1;
  let lean = 0;
  let squash = 0;
  let squashV = 0;
  let walkPhase = 0;
  let groundY = -Infinity;
  let groundTick = 0;
  let emitAcc = 0;
  let smokeAcc = 0;
  let audioAcc = 0;
  let stateAcc = 0;
  let lastFuelSent = -1;
  let hole: Hole | null = null;

  /** HUD hold-button override for thrust, independent of the canvas pointer. */
  let hudThrust = false;

  const tmpColor = new THREE.Color();
  const tmpV = v2(0, 0);
  const dbSize = new THREE.Vector2();

  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
  const liveBall = () => ctx.services.physics?.balls.find((b) => b.active) ?? null;

  // -------------------------------------------------------------------------
  // Pointer capture — see the header note. Attached once; only ever swallows
  // canvas-targeted pointer events, and only while flying, so HUD buttons and
  // the rest of the page keep working normally.
  // -------------------------------------------------------------------------

  let ptrDown = false;
  let ptrId: number | null = null;
  let ptrClientX = 0;

  const ownsEvent = (e: PointerEvent) => active && canvas !== null && e.target === canvas;

  const onDownCap = (e: PointerEvent) => {
    if (!ownsEvent(e)) return;
    e.stopPropagation();
    if (ptrId !== null && ptrId !== e.pointerId) return; // second finger: ignore
    ptrId = e.pointerId;
    ptrDown = true;
    ptrClientX = e.clientX;
  };
  const onMoveCap = (e: PointerEvent) => {
    if (!ownsEvent(e)) return;
    e.stopPropagation();
    if (ptrId === e.pointerId) ptrClientX = e.clientX;
  };
  const onUpCap = (e: PointerEvent) => {
    if (!ownsEvent(e)) return;
    e.stopPropagation();
    if (ptrId === e.pointerId) {
      ptrId = null;
      ptrDown = false;
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", onDownCap, true);
    window.addEventListener("pointermove", onMoveCap, true);
    window.addEventListener("pointerup", onUpCap, true);
    window.addEventListener("pointercancel", onUpCap, true);
  }

  /** Pointer X in world metres, read straight off the ortho frustum. */
  function pointerWorldX(): number {
    const cam = ctx.camera;
    if (!cam) return pos.x;
    const w = typeof window !== "undefined" ? Math.max(1, window.innerWidth) : 1;
    const nx = (ptrClientX / w) * 2 - 1;
    return cam.position.x + nx * (cam.right - cam.left) * 0.5;
  }

  // -------------------------------------------------------------------------
  // Mode transitions
  // -------------------------------------------------------------------------

  function publishState(force = false): void {
    if (!force && Math.abs(fuel - lastFuelSent) < 0.01) return;
    lastFuelSent = fuel;
    ctx.emit("golf:jetpackState", {
      active,
      fuel,
      fuelMax: 1,
      throttle,
      thrusting: throttle > 0.05,
      grounded,
      empty: fuel <= 0.001,
      /** True while the tank is too low to relight — HUD should say "refuel". */
      dry,
      x: pos.x,
      y: pos.y,
    });
  }

  function canEnter(): boolean {
    const rules = ctx.services.rules;
    const ball = liveBall();
    if (active || returning > 0) return false;
    // `canShoot` is the authority — it already means "ball settled, hole still
    // live". Don't second-guess it with `ball.resting`: a ball creeping on a
    // slope can read as not-resting for a frame at a time and the button would
    // feel broken.
    if (!rules || !rules.canShoot || rules.holeComplete) return false;
    if (!ball) return false;
    // Entering mid-drag would strand the aim system holding a live gesture.
    if (ctx.input?.dragging) return false;
    return true;
  }

  function enter(): void {
    if (!canEnter()) {
      ctx.services.audio?.play("deny", { volume: 0.3 });
      return;
    }
    const ball = liveBall();
    if (!ball) return;

    active = true;
    returning = 0;
    pos.x = ball.pos.x;
    pos.y = ball.pos.y + 0.62;
    vel.x = 0;
    vel.y = 0;
    throttle = 0;
    dry = fuel <= RELIGHT;
    lean = 0;
    squash = 0;
    squashV = 0;
    grounded = false;
    ptrDown = false;
    ptrId = null;
    groundTick = 0;
    root.visible = true;
    pilot.visible = true;

    resolveContacts(1 / 60);
    ctx.services.vfx?.burst(v2(pos.x, pos.y - 0.4), 14, { color: 0xfbbf24, speed: 6, spread: 3.1, life: 0.5 });
    ctx.services.vfx?.ring(v2(pos.x, pos.y - 0.4), 1.4, 0x2dd4bf);
    ctx.services.audio?.play("jetpackOn", { volume: 0.55 });
    publishState(true);
  }

  /**
   * Leaving the mode. The ball is what gets played, always — so the golfer
   * simply glides back to the lie over half a second and the camera rides
   * home with him. He never affects the shot, and the shot is never taken
   * from wherever he happened to land.
   */
  function exit(instant = false): void {
    if (!active && returning <= 0) return;
    const ball = liveBall();
    active = false;
    ptrDown = false;
    ptrId = null;
    hudThrust = false;
    throttle = 0;
    (flameMat.uniforms.uThrottle.value as number) = 0;
    (glowMat.uniforms.uAlpha.value as number) = 0;

    // A short hop home reads as the golfer strolling back. Half a hole away it
    // would read as a superhero flying at 80 m/s, so from range we simply cut:
    // the camera's own damped follow does the travelling.
    const far = ball ? Math.hypot(ball.pos.x - pos.x, ball.pos.y - pos.y) > 16 : true;

    if (!instant) ctx.services.audio?.play("jetpackOff", { volume: 0.4 });

    if (instant || far || !ball) {
      returning = 0;
      root.visible = false;
      plume.clear();
      ctx.emit("golf:cameraTarget", null);
    } else {
      returning = RETURN_TIME;
      retFrom.x = pos.x;
      retFrom.y = pos.y;
    }
    publishState(true);
  }

  function toggle(): void {
    if (active) exit();
    else enter();
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  /**
   * Push the two body circles out of anything solid, kill the inward velocity
   * and note whether we're stood on something. Lethal surfaces don't kill the
   * golfer — he just gets fished out and walked back to the ball.
   */
  function resolveContacts(dt: number): boolean {
    const phys = ctx.services.physics;
    if (!phys) return false;
    grounded = false;

    for (let iter = 0; iter < 3; iter++) {
      let touched = false;
      for (const part of BODY) {
        tmpV.x = pos.x;
        tmpV.y = pos.y + part.oy;
        const hit = phys.probe(tmpV, part.r);
        if (!hit) continue;

        if (MATERIALS[hit.material]?.lethal) {
          ctx.services.vfx?.splash(v2(tmpV.x, tmpV.y), hit.material);
          ctx.services.audio?.play("splash", { volume: 0.45 });
          exit();
          return true;
        }

        const dx = tmpV.x - hit.point.x;
        const dy = tmpV.y - hit.point.y;
        const d = Math.hypot(dx, dy);
        const nx = d > 1e-5 ? dx / d : hit.normal.x;
        const ny = d > 1e-5 ? dy / d : hit.normal.y;
        const pen = part.r - d + 0.008;
        if (pen <= 0) continue;

        pos.x += nx * pen;
        pos.y += ny * pen;
        touched = true;

        const vn = vel.x * nx + vel.y * ny;
        if (vn < 0) {
          // Land, don't bounce — a golfer is not a rubber ball.
          vel.x -= nx * vn;
          vel.y -= ny * vn;
        }
        if (ny > 0.45) {
          grounded = true;
          const k = Math.min(1, 7 * dt);
          vel.x *= 1 - k;
        }
      }
      if (!touched) break;
    }
    return false;
  }

  /** Walk down from the golfer until the broadphase finds a floor. */
  function findGround(): void {
    const phys = ctx.services.physics;
    if (!phys) return;
    const floor = hole ? hole.bounds.min.y : pos.y - 20;
    groundY = -Infinity;
    for (let y = pos.y + FOOT_Y; y > Math.max(floor, pos.y - 20); y -= 1.05) {
      tmpV.x = pos.x;
      tmpV.y = y;
      const hit = phys.probe(tmpV, 1.1);
      if (hit && hit.normal.y > 0.2) {
        groundY = hit.point.y;
        return;
      }
    }
  }

  function flight(dt: number): void {
    const input = ctx.input;
    const held = input?.held;

    // --- what does the player want? ---------------------------------------
    const keyUp = Boolean(held?.has("Space") || held?.has("KeyW") || held?.has("ArrowUp"));
    const keyDown = Boolean(held?.has("KeyS") || held?.has("ArrowDown"));
    const keyLeft = Boolean(held?.has("KeyA") || held?.has("ArrowLeft"));
    const keyRight = Boolean(held?.has("KeyD") || held?.has("ArrowRight"));
    const wantThrust = keyUp || ptrDown || hudThrust;

    // --- fuel + throttle ---------------------------------------------------
    if (fuel <= 0.001) dry = true;
    if (dry && fuel > RELIGHT) dry = false;
    const canBurn = wantThrust && !dry && fuel > 0;
    const wantThrottle = canBurn ? 1 : 0;
    // Ramp up fast, ramp down a touch slower — that lag is the "sputter" when
    // the tank empties, and it's why running dry drops you rather than
    // switching you off like a light.
    const rate = wantThrottle > throttle ? 17 : 8;
    throttle += (wantThrottle - throttle) * (1 - Math.exp(-dt * rate));
    if (throttle < 0.002) throttle = 0;

    const wasEmpty = fuel <= 0.001;
    fuel = Math.max(0, fuel - DRAIN * throttle * dt);
    if (!wasEmpty && fuel <= 0.001) {
      // Cough, don't teleport.
      ctx.services.audio?.play("jetpackOut", { volume: 0.5, rate: 0.8 });
      ctx.services.vfx?.trailPuff(v2(pos.x, pos.y - 0.5), 0x94a3b8);
    }
    if (grounded && throttle < 0.05) fuel = Math.min(1, fuel + REFILL * dt);

    // --- integrate ---------------------------------------------------------
    const phys = ctx.services.physics;
    let targetVx = 0;
    if (keyLeft !== keyRight) {
      targetVx = (keyRight ? 1 : -1) * CRUISE;
    } else if (ptrDown) {
      // Touch: the golfer chases the thumb's X. Dead zone keeps him from
      // buzzing when your thumb is already over him.
      const dx = pointerWorldX() - pos.x;
      targetVx = Math.abs(dx) < 0.45 ? 0 : clamp(dx * 2.6, -CRUISE, CRUISE);
    }

    const ax = clamp((targetVx - vel.x) * 6.5, -ACCEL, ACCEL);
    vel.x += ax * dt;
    if (targetVx === 0) vel.x *= 1 - Math.min(1, 1.1 * dt);

    vel.y += (THRUST * throttle - GRAVITY) * dt;
    if (keyDown) vel.y -= 16 * dt;
    // A whisper of the global wind so flying feels like it's in the same
    // world the ball is flying through.
    if (phys) {
      vel.x += phys.wind.x * dt * 0.3;
      vel.y += phys.wind.y * dt * 0.3;
    }
    vel.x = clamp(vel.x, -CRUISE * 1.6, CRUISE * 1.6);
    vel.y = clamp(vel.y, MAX_DOWN, MAX_UP);

    const wasGrounded = grounded;
    const impactVy = vel.y;

    // Substep so a fast dive can't step past a thin ledge in one frame.
    const step = Math.hypot(vel.x, vel.y) * dt;
    const n = Math.max(1, Math.min(6, Math.ceil(step / 0.2)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      pos.x += vel.x * h;
      pos.y += vel.y * h;
      if (resolveContacts(h)) return; // drowned; already exited
      if (!active) return;
    }

    // Hard bounds: a wall, not a death. Losing the golfer off the edge of the
    // level would be a bug the player can't undo.
    if (hole) {
      const { min, max } = hole.bounds;
      const lo = min.x + 0.6;
      const hi = max.x - 0.6;
      if (pos.x < lo) { pos.x = lo; vel.x = Math.max(0, vel.x); }
      if (pos.x > hi) { pos.x = hi; vel.x = Math.min(0, vel.x); }
      const ceil = max.y - 0.9;
      if (pos.y > ceil) { pos.y = ceil; vel.y = Math.min(0, vel.y); }
      if (pos.y < min.y + 0.8) {
        pos.y = min.y + 0.8;
        vel.y = Math.max(0, vel.y);
        grounded = true;
      }
    }

    // --- touchdown ---------------------------------------------------------
    if (grounded && !wasGrounded && impactVy < -4) {
      const k = Math.min(1, -impactVy / 18);
      squashV -= 2.6 * k;
      ctx.services.audio?.play("land", { volume: 0.3 + k * 0.5, rate: 0.85 + k * 0.3 });
      ctx.services.vfx?.screenShake(0.12 + k * 0.35);
      tmpColor.set(0xcbd5e1);
      const puffs = low ? 6 : 14;
      for (let i = 0; i < puffs; i++) {
        const a = (i / puffs) * Math.PI + (ctx.rng() - 0.5) * 0.4;
        const sp = (1.4 + ctx.rng() * 4) * (0.5 + k);
        plume.spawn(pos.x, pos.y + FOOT_Y + 0.05, Math.cos(a) * sp * 1.5, Math.abs(Math.sin(a)) * sp * 0.5,
          0.4 + ctx.rng() * 0.3, 0.28 + ctx.rng() * 0.2, tmpColor, 0.35, -2, 3.0, 1.4);
      }
    }

    // --- exhaust -----------------------------------------------------------
    if (throttle > 0.04) {
      const c = Math.cos(lean);
      const s = Math.sin(lean);
      const ox = facing < 0 ? -NOZZLE_X : NOZZLE_X;
      const oy = NOZZLE_Y - 0.12;
      const nx = pos.x + ox * c - oy * s;
      const ny = pos.y + ox * s + oy * c;

      emitAcc += dt * (low ? 42 : 96) * throttle;
      while (emitAcc >= 1) {
        emitAcc -= 1;
        const spread = (ctx.rng() - 0.5) * 2.6;
        const hot = ctx.rng();
        tmpColor.setRGB(1, 0.58 + hot * 0.36, 0.18 + hot * 0.34);
        plume.spawn(
          nx + spread * 0.05, ny,
          vel.x * 0.25 + spread, -6 - 9 * throttle + vel.y * 0.2,
          0.16 + ctx.rng() * 0.2,
          0.16 + ctx.rng() * 0.14,
          tmpColor, 0.95, 3.5, 4.2, 1.8,
        );
      }

      // Smoke goes through the shared vfx service so it grades with every
      // other puff in the game rather than looking like a separate effect.
      smokeAcc += dt * 15 * throttle;
      while (smokeAcc >= 1) {
        smokeAcc -= 1;
        ctx.services.vfx?.trailPuff(v2(nx + (ctx.rng() - 0.5) * 0.2, ny - 0.35), 0x9aa7bd);
      }

      // No loop API on the audio service, so the "loop" is a fast retrigger
      // whose rate rides the throttle.
      audioAcc -= dt;
      if (audioAcc <= 0) {
        audioAcc = 0.1;
        ctx.services.audio?.play("jetpack", {
          volume: 0.14 + 0.4 * throttle,
          rate: 0.78 + 0.55 * throttle,
        });
      }
    } else {
      emitAcc = 0;
      smokeAcc = 0;
      audioAcc = 0;
    }

    // --- camera ------------------------------------------------------------
    ctx.emit("golf:cameraTarget", {
      x: pos.x + vel.x * 0.28,
      y: pos.y + vel.y * 0.18 + 0.6,
    });
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  function dress(dt: number): void {
    // Lean into the direction of travel, and flip to face it.
    if (vel.x > 1.2) facing = 1;
    else if (vel.x < -1.2) facing = -1;
    const wantLean = clamp(-vel.x * 0.026, -0.42, 0.42) + (throttle > 0.1 ? 0.05 * facing : 0);
    lean += (wantLean - lean) * (1 - Math.exp(-dt * 9));

    // Squash spring: kicked negative on touchdown, rings back out.
    squashV += (0 - squash) * 120 * dt - squashV * 12 * dt;
    squash += squashV * dt;
    squash = clamp(squash, -0.3, 0.3);

    pilot.position.set(pos.x, pos.y, LAYER.character);
    pilot.rotation.z = lean;
    body.rotation.y = facing < 0 ? Math.PI : 0;
    body.scale.set(1 - squash * 0.5, 1 + squash, 1 - squash * 0.5);

    // Legs trail when flying, take a walk cycle when jogging on the ground.
    if (grounded && Math.abs(vel.x) > 0.6) {
      walkPhase += dt * Math.min(14, Math.abs(vel.x) * 1.6);
      legs.rotation.z = Math.sin(walkPhase) * 0.25;
      legs.rotation.x = 0;
    } else {
      walkPhase = 0;
      const trail = clamp(vel.x * 0.05 * facing, -0.5, 0.5);
      legs.rotation.z += (trail * -facing - legs.rotation.z) * (1 - Math.exp(-dt * 6));
      legs.rotation.x = 0;
    }

    // Arms come up as the pack lights, like you're steadying yourself.
    const armUp = 0.35 - throttle * 0.85;
    for (const a of arms) a.rotation.z += (armUp - a.rotation.z) * (1 - Math.exp(-dt * 10));

    // Flame length rides the throttle with a little flutter.
    const flutter = 0.9 + 0.1 * Math.sin(ctx.elapsed * 39);
    const len = (0.18 + throttle * 1.25) * flutter;
    for (const f of flames) {
      f.visible = throttle > 0.02;
      f.scale.set(0.115 + throttle * 0.055, len, 0.115 + throttle * 0.055);
      // Base at the nozzle, apex trailing below.
      f.position.y = NOZZLE_Y + len * 0.5;
    }
    (flameMat.uniforms.uTime.value as number) = ctx.elapsed;
    (flameMat.uniforms.uThrottle.value as number) = Math.min(1, throttle * 1.15);

    glow.scale.setScalar(1.6 + throttle * 2.6);
    (glowMat.uniforms.uAlpha.value as number) = throttle * 0.5;

    // Contact shadow. The ground search is the only per-frame query worth
    // budgeting for, so it runs at a quarter rate and holds between samples.
    if (groundTick-- <= 0) {
      groundTick = 3;
      findGround();
    }
    if (groundY > -Infinity) {
      const h = Math.max(0, pos.y + FOOT_Y - groundY);
      const fade = clamp(1 - h / 11, 0, 1);
      shadow.visible = fade > 0.02;
      shadow.position.set(pos.x, groundY + 0.06, LAYER.props + 0.4);
      const w = 1.25 + h * 0.16;
      shadow.scale.set(w, w * 0.34, 1);
      (shadowMat.uniforms.uAlpha.value as number) = 0.46 * fade * fade;
    } else {
      shadow.visible = false;
    }

    // Home marker on the ball, so the line back is always legible.
    const ball = liveBall();
    if (ball) {
      const pulse = 0.5 + 0.5 * Math.sin(ctx.elapsed * 3.4);
      home.visible = true;
      home.position.set(ball.pos.x, ball.pos.y, LAYER.fx);
      home.scale.setScalar(0.75 + pulse * 0.16);
      homeMat.opacity = 0.3 + pulse * 0.3;
    } else {
      home.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const offs: Array<() => void> = [];

  const readOn = (payload: unknown): boolean | null => {
    if (payload === undefined || payload === null) return null;
    if (typeof payload === "boolean") return payload;
    if (typeof payload === "string") return payload === "on" || payload === "true";
    const o = payload as { on?: boolean; active?: boolean; enabled?: boolean };
    if (typeof o.on === "boolean") return o.on;
    if (typeof o.active === "boolean") return o.active;
    if (typeof o.enabled === "boolean") return o.enabled;
    return null;
  };

  offs.push(ctx.on("golf:jetpack", (payload) => {
    const want = readOn(payload);
    if (want === null) toggle();
    else if (want) enter();
    else exit();
  }));

  offs.push(ctx.on("golf:jetpackThrust", (payload) => {
    const want = readOn(payload);
    hudThrust = want === null ? !hudThrust : want;
  }));

  offs.push(ctx.on("golf:hole", (payload) => {
    hole = (payload as { hole?: Hole })?.hole ?? null;
    fuel = 1;
    dry = false;
    exit(true);
    publishState(true);
  }));

  // Anything that means "the ball is doing something" takes the camera back.
  offs.push(ctx.on("golf:holed", () => exit(true)));
  offs.push(ctx.on("golf:shot", () => exit(true)));
  offs.push(ctx.on("golf:penalty", () => exit(true)));

  // -------------------------------------------------------------------------

  const sys: System = {
    name: "jetpack",

    update(dt: number) {
      const pressed = ctx.input?.pressed;
      if (pressed?.has("KeyJ")) toggle();
      if (active && pressed?.has("Escape")) exit();

      if (!hole) hole = ctx.services.course?.current ?? null;

      if (active) {
        flight(dt);
      } else if (returning > 0) {
        // Glide home. Position is purely cosmetic from here — the shot is
        // taken from the ball no matter where the golfer was standing.
        returning = Math.max(0, returning - dt);
        const ball = liveBall();
        const t = 1 - returning / RETURN_TIME;
        const e = t * t * (3 - 2 * t);
        if (ball) {
          pos.x = retFrom.x + (ball.pos.x - retFrom.x) * e;
          pos.y = retFrom.y + (ball.pos.y + 0.55 - retFrom.y) * e + Math.sin(e * Math.PI) * 0.9;
          vel.x = (ball.pos.x - retFrom.x) * 0.9;
          vel.y = 0;
          ctx.emit("golf:cameraTarget", { x: pos.x, y: pos.y });
        }
        if (returning <= 0) {
          root.visible = false;
          plume.clear();
          ctx.emit("golf:cameraTarget", null);
          publishState(true);
        }
      }

      if (root.visible) dress(dt);

      // Fuel gauge: nudge the HUD on meaningful change, plus a heartbeat so a
      // gauge that mounted late still fills itself in. The heartbeat is lazy
      // while parked — there's nothing to animate when nobody's flying.
      stateAcc -= dt;
      if (stateAcc <= 0) {
        stateAcc = active || returning > 0 ? 0.2 : 1;
        publishState(true);
      } else {
        publishState();
      }
    },

    lateUpdate(dt: number) {
      if (!root.visible) return;
      const cam = ctx.camera;
      if (!cam || !ctx.renderer) return;
      ctx.renderer.getDrawingBufferSize(dbSize);
      const pxPerMetre = dbSize.y / Math.max(0.001, cam.top - cam.bottom);
      plume.update(dt, pxPerMetre);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerdown", onDownCap, true);
        window.removeEventListener("pointermove", onMoveCap, true);
        window.removeEventListener("pointerup", onUpCap, true);
        window.removeEventListener("pointercancel", onUpCap, true);
      }
      if (active || returning > 0) ctx.emit("golf:cameraTarget", null);
      active = false;
      returning = 0;
      ctx.scene?.remove(root);
      plume.dispose();
      for (const o of owned) o.dispose();
      owned.length = 0;
    },
  };

  publishState(true);
  return sys;
};

export default createJetpack;
