/**
 * Vibe Golf — the golfer.
 *
 * The game's personality: a jointed 2.5D figure who stands at the lie, settles
 * into a stance while you drag, swings for real when you release, then *turns
 * and watches the ball fly*. That last one is the cheap trick that does the
 * most work — a world where something is paying attention to the ball feels
 * alive in a way no amount of parallax does.
 *
 * Built entirely from five shared primitives (capsule, sphere, cylinder, box,
 * quad) instanced into a hierarchy of joint `Group`s. Nothing here is loaded;
 * the only generated asset is a 64² radial canvas for the contact shadow.
 *
 * Three things are worth knowing before you edit it:
 *
 * 1. **The ball's readability is sacred.** The golfer is always planted
 *    `STAND_OFFSET` metres *behind* the ball along the shot direction and
 *    never advances past it, so he cannot occlude the thing you're aiming.
 *    While the ball is in flight he stays at the lie — he does not chase it.
 * 2. **Animation is one damped pose.** Every state (idle / aim / swing /
 *    watch / cheer / slump / flinch / shrug) produces the *same* 16-number
 *    `Pose`; the rig damps toward it each frame and clips write keyframed
 *    values into it. There is no blend tree and no skinning — the damping
 *    rate is the whole transition system, and it costs 16 lerps a frame.
 * 3. **Facing is a Y rotation of the rig**, damped, so turning to track the
 *    ball reads as an actual turn rather than a sprite flip. Everything
 *    hanging off the rig (including the club, parented to the near forearm)
 *    comes along for free.
 *
 * Publishes no service. Emits `golf:character` once at boot and again on
 * `golf:hole` — payload `{ root, rig, head, hand }` — so the jetpack module
 * can drive the rig if it ever wants to; while nobody claims it, this system
 * keeps full control. Hides itself while the jetpack is flying so there is
 * only ever one golfer on screen.
 *
 * Consumes `golf:aim`, `golf:shot`, `golf:holed`, `golf:penalty`,
 * `golf:hazard`, `golf:ready`, `golf:hole`, `golf:jetpackState`.
 */
import * as THREE from "three";
import type { BallState, GolfCtx, Hole, System, SystemFactory } from "../types";
import { v2 } from "../types";
import { LAYER } from "../engine/core";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Metres behind the ball, along the shot line, that the golfer plants. */
const STAND_OFFSET = 1.18;
/** Overall rig scale. The rig is authored at 1.78 m; this makes him heroic. */
const RIG_SCALE = 1.16;
/** Walking speed cap, m/s. */
const WALK_SPEED = 3.6;
/** Beyond this the golfer walks rather than slides, and faces the walk. */
const WALK_TURN = 2.2;
/**
 * Beyond this he simply *is* at the new lie. A 40 m drive would otherwise put
 * him on an eleven-second stroll while the player is waiting to shoot — and
 * the camera is on the ball at that moment, so the cut is never seen.
 */
const TELEPORT_DIST = 14;
/** A settle further than this from the cup earns a shrug. */
const SHRUG_DIST = 26;
/** How far down to hunt for a floor, metres. */
const GROUND_REACH = 26;

const SWING_DUR = 0.92;
const CHEER_DUR = 1.8;
const SLUMP_DUR = 1.7;
const FLINCH_DUR = 0.6;
const SHRUG_DUR = 1.2;

// --- rig dimensions, metres, feet at y = 0 ---------------------------------
const HIP_Y = 0.90;
const THIGH_L = 0.44;
const SHIN_L = 0.42;
const LEG_Z = 0.115;
const SPINE_Y = 0.86;
/** Shoulder height in spine-local space. */
const SHOULDER_Y = 0.52;
const SHOULDER_Z = 0.175;
const UPPER_L = 0.32;
const FORE_L = 0.30;
/** Neck joint in spine-local space. */
const NECK_Y = 0.58;
const CLUB_L = 0.98;

// --- palette: warm amber + teal on a near-white kit -------------------------
const C_SHIRT = 0xf2f6fb;
const C_TROUSER = 0x0e9c8c;
const C_TRIM = 0xfbbf24;
const C_SKIN = 0xffd9b0;
const C_SHAFT = 0x1b2534;
const C_STEEL = 0xd8dee8;
const C_INK = 0x080f1c;
const C_AURA = 0x2dd4bf;

// ---------------------------------------------------------------------------
// Pose — every state produces one of these, the rig damps toward it.
// "N" = near limb (camera side), "F" = far limb.
// ---------------------------------------------------------------------------

interface Pose {
  /** Thigh swing, +ve forward. */
  hipN: number;
  hipF: number;
  /** Knee bend, +ve heel toward the backside. */
  kneeN: number;
  kneeF: number;
  /** Spine lean, +ve folding forward over the ball. */
  spine: number;
  /** Spine twist about Y — what makes the swing read as 3D. */
  twist: number;
  /** Head nod, +ve chin down. */
  neck: number;
  /** Head yaw about Y. */
  look: number;
  /** Upper arm swing, +ve forward. */
  armN: number;
  armF: number;
  /** Elbow bend. */
  elbN: number;
  elbF: number;
  /** Club angle at the wrist, relative to the forearm. */
  wrist: number;
  /** Shoulder lift — the shrug. */
  lift: number;
  /** Whole-body vertical offset: hops, slumps. */
  rise: number;
  /** Whole-body roll. */
  tilt: number;
}

const POSE_KEYS = [
  "hipN", "hipF", "kneeN", "kneeF", "spine", "twist", "neck", "look",
  "armN", "armF", "elbN", "elbF", "wrist", "lift", "rise", "tilt",
] as const;

const blankPose = (): Pose => ({
  hipN: 0, hipF: 0, kneeN: 0, kneeF: 0, spine: 0, twist: 0, neck: 0, look: 0,
  armN: 0, armF: 0, elbN: 0, elbF: 0, wrist: 0, lift: 0, rise: 0, tilt: 0,
});

/** Reset `p` to the neutral standing pose, then let a state overwrite it. */
function restPose(p: Pose): void {
  // A small stance split so both feet are readable in a side-on view — with
  // the legs stacked he reads as one-legged at phone size.
  p.hipN = 0.11; p.hipF = -0.09;
  p.kneeN = 0.06; p.kneeF = 0.06;
  p.spine = 0.04; p.twist = 0; p.neck = 0.02; p.look = 0;
  p.armN = 0.16; p.armF = 0.12;
  p.elbN = 0.30; p.elbF = 0.26;
  p.wrist = 0.45; p.lift = 0; p.rise = 0; p.tilt = 0;
}

type Key = readonly [number, number];

/** Smoothstep-interpolated keyframe lookup. Clamped at both ends. */
function sample(ks: readonly Key[], t: number): number {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (t > ks[i][0]) continue;
    const t0 = ks[i - 1][0];
    const v0 = ks[i - 1][1];
    const u = (t - t0) / Math.max(1e-5, ks[i][0] - t0);
    return v0 + (ks[i][1] - v0) * (u * u * (3 - 2 * u));
  }
  return ks[ks.length - 1][1];
}

// --- swing clip, normalised 0..1 over SWING_DUR -----------------------------
// Impact lands at ~0.14, which is a frame or two after `golf:shot` fires. The
// ball is already gone by then; the eye reads the club catching up to it as
// contact, not as lag.
const K_ARM: Key[] = [[0, -0.55], [0.14, 0.9], [0.3, 1.75], [0.55, 2.25], [1, 0.3]];
const K_ELB: Key[] = [[0, 0.55], [0.14, 0.1], [0.32, 0.55], [0.55, 1.5], [1, 0.34]];
const K_SPINE: Key[] = [[0, 0.2], [0.14, 0.12], [0.32, -0.14], [0.6, -0.22], [1, 0.04]];
const K_TWIST: Key[] = [[0, -0.5], [0.14, 0.12], [0.38, 0.55], [0.62, 0.42], [1, 0.06]];
const K_WRIST: Key[] = [[0, -1.05], [0.14, 0.05], [0.4, 0.85], [0.62, 1.1], [1, 0.45]];
const K_HIP: Key[] = [[0, -0.16], [0.14, 0.1], [0.4, 0.22], [1, 0.02]];
const K_RISE: Key[] = [[0, -0.02], [0.14, -0.03], [0.34, 0.03], [1, 0]];
const K_NECK: Key[] = [[0, 0.34], [0.14, 0.3], [0.34, -0.1], [0.6, -0.2], [1, 0.02]];

// ---------------------------------------------------------------------------
// Shadow texture — the one generated asset in this module.
// ---------------------------------------------------------------------------

function shadowTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  if (!g) return null;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.45, "rgba(255,255,255,0.72)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------

type CharState = "idle" | "aim" | "swing" | "watch" | "cheer" | "slump" | "flinch" | "shrug";

const createCharacter: SystemFactory = (ctx: GolfCtx) => {
  const low = ctx.quality === "low";
  const rng = ctx.rng;

  // -------------------------------------------------------------------------
  // Scene graph
  // -------------------------------------------------------------------------

  const group = new THREE.Group();
  group.name = "golfer";
  group.visible = false;
  ctx.scene?.add(group);

  const owned: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  // Unit primitives: capsule is 1 wide × 2 tall, sphere/cylinder/box are 1³,
  // so a `scale` reads as literal metres of the finished part.
  const CAP = keep(new THREE.CapsuleGeometry(0.5, 1, low ? 2 : 4, low ? 6 : 10));
  const SPH = keep(new THREE.SphereGeometry(0.5, low ? 10 : 16, low ? 7 : 12));
  const CYL = keep(new THREE.CylinderGeometry(0.5, 0.5, 1, low ? 6 : 12));
  const BOX = keep(new THREE.BoxGeometry(1, 1, 1));
  const QUAD = keep(new THREE.PlaneGeometry(1, 1));

  /**
   * Every material carries an emissive floor. The golfer is ~40 px tall on a
   * phone and has to survive both a bright fairway and a deep blue-black neon
   * sky, so he is lit but never fully at the mercy of the scene's key light.
   */
  const lit = (color: number, glow: number, rough = 0.6, metal = 0.04) =>
    keep(new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      emissive: new THREE.Color(color).multiplyScalar(glow),
    }));

  const mShirt = lit(C_SHIRT, 0.3, 0.66);
  const mTrouser = lit(C_TROUSER, 0.26, 0.58);
  const mTrim = lit(C_TRIM, 0.4, 0.42, 0.15);
  const mSkin = lit(C_SKIN, 0.28, 0.8);
  const mShaft = lit(C_SHAFT, 0.12, 0.4, 0.5);
  const mSteel = lit(C_STEEL, 0.2, 0.26, 0.85);
  const mFace = keep(new THREE.MeshBasicMaterial({ color: 0x14203a }));

  /**
   * Flat ink hull, front-face culled, worn one size up behind the four shapes
   * that define the silhouette. Same reason SSG3's stickman has a keyline:
   * it survives any background for the price of four extra draws.
   */
  const mInk = keep(new THREE.MeshBasicMaterial({ color: C_INK, side: THREE.BackSide }));

  const part = (
    geo: THREE.BufferGeometry, mat: THREE.Material,
    sx: number, sy: number, sz: number,
    x = 0, y = 0, z = 0,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    return m;
  };

  /**
   * Add `m` to `parent`, with an ink hull behind it if `grow` is given. Hulls
   * are worn only by the six shapes that carry the silhouette — every one is a
   * draw call, and this rig already costs ~37 of them. Low quality drops them
   * entirely and leans on the aura instead.
   */
  const attach = (parent: THREE.Object3D, m: THREE.Mesh, grow = 0): THREE.Mesh => {
    if (grow > 0 && !low) {
      const ink = new THREE.Mesh(m.geometry, mInk);
      ink.position.copy(m.position);
      ink.rotation.copy(m.rotation);
      ink.scale.set(m.scale.x + grow, m.scale.y + grow * 0.6, m.scale.z + grow);
      ink.renderOrder = -1;
      parent.add(ink);
    }
    parent.add(m);
    return m;
  };

  // --- root / rig -----------------------------------------------------------
  const root = new THREE.Group();          // world position of the feet
  root.position.z = LAYER.character;
  root.scale.setScalar(RIG_SCALE);

  const rig = new THREE.Group();           // facing (Y rotation) + rise + tilt
  root.add(rig);

  /** Teal separation glow behind the figure — the readability backstop. */
  const auraMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(C_AURA) }, uAlpha: { value: 0.13 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;
      void main(){
        float d = length(vUv - vec2(0.5)) * 2.0;
        float a = smoothstep(1.0, 0.05, d);
        gl_FragColor = vec4(uColor, a * a * uAlpha);
      }`,
  }));
  const aura = part(QUAD, auraMat, 1.5, 2.2, 1, 0, 0.95, -0.55);
  aura.renderOrder = 1;
  root.add(aura);

  // --- legs -----------------------------------------------------------------
  interface Leg { hip: THREE.Group; knee: THREE.Group }
  const makeLeg = (z: number): Leg => {
    const hip = new THREE.Group();
    hip.position.set(0, HIP_Y, z);
    attach(hip, part(CAP, mTrouser, 0.155, THIGH_L / 2, 0.155, 0, -THIGH_L / 2, 0), 0.05);

    const knee = new THREE.Group();
    knee.position.y = -THIGH_L;
    attach(knee, part(CAP, mTrouser, 0.128, SHIN_L / 2, 0.128, 0, -SHIN_L / 2, 0));
    // Amber sock cuff, then the shoe: two bright notes at the very bottom of
    // the silhouette, which is what stops the legs reading as sticks.
    attach(knee, part(CYL, mTrim, 0.15, 0.08, 0.15, 0, -SHIN_L + 0.05, 0));
    attach(knee, part(BOX, mTrim, 0.3, 0.1, 0.155, 0.085, -SHIN_L - 0.02, 0), 0.036);
    hip.add(knee);
    return { hip, knee };
  };
  const legN = makeLeg(LEG_Z);
  const legF = makeLeg(-LEG_Z);
  rig.add(legF.hip, legN.hip);

  // --- spine ----------------------------------------------------------------
  const spine = new THREE.Group();
  spine.position.set(0, SPINE_Y, 0);
  rig.add(spine);

  attach(spine, part(CAP, mShirt, 0.4, 0.28, 0.3, 0, 0.28, 0), 0.085);
  // Teal collar, amber belt. Two horizontal bands bracketing the shirt read as
  // a kit at any size; a vertical placket vanishes below ~60 px and only ever
  // pokes out of the capsule's silhouette on the near side.
  attach(spine, part(CYL, mTrouser, 0.37, 0.1, 0.29, 0, 0.5, 0));
  attach(spine, part(CYL, mTrim, 0.42, 0.09, 0.32, 0, 0.05, 0));

  const neck = new THREE.Group();
  neck.position.set(0, NECK_Y, 0);
  spine.add(neck);
  attach(neck, part(CYL, mSkin, 0.11, 0.09, 0.11, 0, 0.03, 0));

  const head = new THREE.Group();
  head.position.y = 0.07;
  neck.add(head);
  attach(head, part(SPH, mSkin, 0.3, 0.32, 0.29, 0, 0.15, 0), 0.075);
  // A dark visor band instead of a face: at 40 px a stripe reads as "looking
  // that way" far more reliably than eyes do. It sits a hair proud of the
  // skull so it survives being seen edge-on.
  attach(head, part(BOX, mFace, 0.085, 0.06, 0.27, 0.135, 0.1, 0));
  // The cap sits above the visor band, not over it — an amber dome down at
  // eye level simply swallows the face.
  attach(head, part(SPH, mTrim, 0.315, 0.2, 0.31, 0, 0.235, 0));
  attach(head, part(BOX, mTrim, 0.2, 0.032, 0.25, 0.2, 0.15, 0), 0.028);

  // --- arms -----------------------------------------------------------------
  interface Arm { shoulder: THREE.Group; elbow: THREE.Group }
  const makeArm = (z: number): Arm => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0, SHOULDER_Y, z);
    attach(shoulder, part(SPH, mShirt, 0.19, 0.19, 0.19, 0, 0.02, 0));
    attach(shoulder, part(CAP, mShirt, 0.115, UPPER_L / 2, 0.115, 0, -UPPER_L / 2, 0));

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_L;
    attach(elbow, part(CAP, mSkin, 0.1, FORE_L / 2, 0.1, 0, -FORE_L / 2, 0));
    attach(elbow, part(SPH, mShirt, 0.135, 0.135, 0.135, 0, -FORE_L - 0.03, 0));
    shoulder.add(elbow);
    return { shoulder, elbow };
  };
  const armN = makeArm(SHOULDER_Z);
  const armF = makeArm(-SHOULDER_Z);
  spine.add(armF.shoulder, armN.shoulder);

  // --- club, parented to the near hand --------------------------------------
  const club = new THREE.Group();
  club.position.y = -FORE_L - 0.04;
  armN.elbow.add(club);
  attach(club, part(CYL, mShaft, 0.038, CLUB_L, 0.038, 0, -CLUB_L / 2, 0));
  attach(club, part(CYL, mTrim, 0.055, 0.16, 0.055, 0, -0.07, 0));
  attach(club, part(BOX, mSteel, 0.2, 0.085, 0.1, 0.06, -CLUB_L + 0.02, 0), 0.038);

  // --- contact shadow, world space, unrotated -------------------------------
  const shadowTex = shadowTexture();
  if (shadowTex) owned.push(shadowTex);
  const shadowMat = keep(new THREE.MeshBasicMaterial({
    map: shadowTex ?? undefined,
    color: 0x060d18,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    fog: false,
  }));
  const shadow = new THREE.Mesh(QUAD, shadowMat);
  shadow.position.z = LAYER.props + 0.5;
  shadow.renderOrder = 4;

  group.add(shadow, root);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const pose = blankPose();
  const want = blankPose();
  restPose(pose);

  let state: CharState = "idle";
  /** Seconds into the current clip; clips own the pose until they expire. */
  let clipT = 0;
  let clipDur = 0;

  /** World position of the feet. */
  let x = 0;
  let y = 0;
  /** Where he is trying to stand; frozen at the lie while the ball flies. */
  let anchorX = 0;
  let groundY = 0;
  let groundTick = 0;
  let hasGround = false;

  /** -1 or +1 target, damped through `faceAngle` so turning reads as a turn. */
  let facing = 1;
  let faceAngle = 0;
  let walk = 0;
  let walkPhase = 0;
  let stepAcc = 0;

  let aiming = false;
  let aimPower = 0;
  let aimDirX = 1;
  let aimDirY = 0;
  let swingPower = 0.6;

  let breath = rng() * 6.28;
  let sway = rng() * 6.28;
  let lookTimer = 1 + rng() * 4;
  let lookTarget = 0;

  /** Fade-out while the jetpack owns the golfer, so there's only ever one. */
  let jetHide = 0;
  let jetActive = false;
  /** Starts fully present — nobody has claimed the rig at boot. */
  let shown = 1;

  let hole: Hole | null = null;

  const tmp = v2(0, 0);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const liveBall = (): BallState | null =>
    ctx.services.physics?.balls.find((b) => b.active) ?? null;

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Walk downward from the golfer's head height until the broadphase finds a
   * floor. The only per-frame query in this module, so it runs at a quarter
   * rate and holds its answer between samples.
   */
  function findGround(px: number, from: number): void {
    const phys = ctx.services.physics;
    if (!phys) return;
    const floor = hole ? hole.bounds.min.y : from - GROUND_REACH;
    for (let gy = from + 1.2; gy > Math.max(floor, from - GROUND_REACH); gy -= 1.0) {
      tmp.x = px;
      tmp.y = gy;
      const hit = phys.probe(tmp, 1.05);
      if (hit && hit.normal.y > 0.2) {
        groundY = hit.point.y;
        hasGround = true;
        return;
      }
    }
    hasGround = false;
  }

  /** Snap the whole rig to a position without a walk — hole loads, resets. */
  function placeAt(px: number, py: number, face: number): void {
    x = px;
    anchorX = px;
    findGround(px, py);
    y = hasGround ? groundY : py;
    facing = face >= 0 ? 1 : -1;
    faceAngle = facing > 0 ? 0 : Math.PI;
    walk = 0;
    clipT = 0;
    clipDur = 0;
    state = "idle";
    restPose(pose);
  }

  function beginClip(s: CharState, dur: number): void {
    state = s;
    clipT = 0;
    clipDur = dur;
  }

  // -------------------------------------------------------------------------
  // Pose authoring — one function per state, all writing into `want`.
  // -------------------------------------------------------------------------

  function poseIdle(dt: number): void {
    restPose(want);
    // Weight shifts slowly from one hip to the other; the knees take it.
    sway += dt * 0.55;
    const s = Math.sin(sway);
    want.tilt = s * 0.022;
    want.kneeN = 0.06 + Math.max(0, s) * 0.1;
    want.kneeF = 0.06 + Math.max(0, -s) * 0.1;
    want.hipN = 0.11 + s * 0.03;
    want.hipF = -0.09 - s * 0.03;
    want.look = lookTarget;
    want.neck = 0.02 - Math.abs(lookTarget) * 0.08;
    // Club grounded in front, the classic waiting-for-your-turn stance.
    want.armN = 0.24;
    want.wrist = 0.5;
  }

  function poseAim(): void {
    restPose(want);
    const p = aimPower;
    // A lofted shot gets a more upright, open stance; a flat drive gets a
    // low coiled one. `aimDirY` is normalised, so this is just the loft.
    const loft = clamp(aimDirY, 0, 1);
    // Athletic address: knees soft, spine folded over the ball, club drawn
    // back in proportion to the drag so the stance *is* the power meter.
    want.kneeN = 0.3;
    want.kneeF = 0.26;
    want.hipN = -0.14;
    want.hipF = 0.1;
    want.spine = 0.24 + p * 0.1 - loft * 0.14;
    want.twist = -0.18 - p * 0.42;
    want.neck = 0.34 - p * 0.12;
    want.look = 0;
    want.armN = -0.3 - p * 1.5;
    // The far arm shadows the near one — both hands are on the same club, and
    // letting it drift produces a disembodied glove floating past the chest.
    want.armF = want.armN - 0.07;
    want.elbN = 0.42 + p * 0.2;
    want.elbF = want.elbN + 0.05;
    want.wrist = -0.25 - p * 1.35 + loft * 0.3;
    want.rise = -0.02 - p * 0.03;
    want.tilt = -0.04 - loft * 0.05;
  }

  function poseSwing(t: number): void {
    restPose(want);
    const p = swingPower;
    const arm = sample(K_ARM, t);
    const elb = sample(K_ELB, t);
    want.spine = sample(K_SPINE, t);
    want.twist = sample(K_TWIST, t) * (0.7 + p * 0.6);
    want.wrist = sample(K_WRIST, t);
    want.neck = sample(K_NECK, t);
    want.rise = sample(K_RISE, t) * (0.6 + p);
    // Follow-through scales with power: a putt barely lifts the club, a
    // full drive wraps it over the shoulder.
    const reach = 0.55 + p * 0.75;
    want.armN = arm * (arm > 0 ? reach : 1 + p * 0.5);
    want.armF = want.armN - 0.07;
    want.elbN = elb;
    want.elbF = elb + 0.05;
    const hip = sample(K_HIP, t) * (0.6 + p * 0.7);
    want.hipN = hip;
    want.hipF = -hip * 0.7;
    want.kneeN = 0.28 - hip * 0.3;
    want.kneeF = 0.2 + Math.max(0, hip) * 0.7;
    want.tilt = -0.05 + sample(K_HIP, t) * 0.08;
  }

  /** Watching the ball fly: hand to the brow when it's high and far. */
  function poseWatch(ball: BallState): void {
    restPose(want);
    const dx = (ball.pos.x - x) * facing;
    const dy = ball.pos.y - (y + 1.55);
    const pitch = Math.atan2(dy, Math.max(1.2, Math.abs(dx)));
    const high = clamp(pitch / 0.7, 0, 1);
    want.spine = 0.04 - high * 0.24;
    want.neck = -clamp(pitch, -0.4, 0.95) * 0.85;
    want.twist = clamp(dx * 0.02, -0.3, 0.3);
    want.kneeN = 0.1;
    want.kneeF = 0.1;
    // Shading the eyes — only once the ball has really climbed.
    want.armN = 0.2 - high * 1.75;
    want.elbN = 0.3 + high * 1.75;
    want.armF = 0.14;
    want.elbF = 0.26;
    want.wrist = 0.5 - high * 0.4;
    want.rise = high * 0.02;
  }

  function poseCheer(t: number): void {
    restPose(want);
    // Two fist pumps and a couple of hops.
    const pump = Math.sin(t * Math.PI * 4.2);
    const hop = Math.abs(Math.sin(t * Math.PI * 3.1)) * (1 - t);
    // Arms punch up and slightly *forward* — swung back over the shoulder it
    // reads as a stretch, not a celebration.
    // Arms punch up and *forward* of vertical: swung back over the shoulder it
    // reads as a stretch, and dead vertical it hides the head.
    want.armN = 2.15 + pump * 0.28;
    want.armF = 1.78 + pump * 0.2;
    want.elbN = 0.9 - pump * 0.5;
    want.elbF = want.elbN + 0.2;
    want.wrist = -0.35;
    want.spine = -0.22;
    want.neck = -0.34;
    want.twist = pump * 0.2;
    want.rise = hop * 0.16;
    want.kneeN = 0.12 + hop * 0.5;
    want.kneeF = 0.12 + hop * 0.5;
    want.hipN = hop * 0.35;
    want.hipF = -hop * 0.2;
  }

  function poseSlump(t: number): void {
    restPose(want);
    const settle = Math.min(1, t * 4);
    want.spine = 0.06 + settle * 0.5;
    want.neck = 0.1 + settle * 0.5;
    want.lift = -settle * 0.05;
    want.armN = 0.05;
    want.armF = 0.02;
    want.elbN = 0.12;
    want.elbF = 0.1;
    want.wrist = 0.9;
    want.kneeN = 0.06 + settle * 0.22;
    want.kneeF = 0.06 + settle * 0.22;
    want.rise = -settle * 0.08;
    want.tilt = settle * 0.05;
  }

  function poseFlinch(t: number): void {
    restPose(want);
    const k = Math.max(0, 1 - t * 1.4);
    want.spine = -0.4 * k;
    want.neck = -0.2 * k;
    want.twist = -0.24 * k;
    want.armN = -0.85 * k;
    want.armF = -0.7 * k;
    want.elbN = 0.4 + 1.5 * k;
    want.elbF = 0.4 + 1.4 * k;
    want.kneeN = 0.06 + 0.34 * k;
    want.kneeF = 0.06 + 0.3 * k;
    want.rise = 0.03 * k;
    want.tilt = -0.12 * k;
  }

  function poseShrug(t: number): void {
    restPose(want);
    const k = Math.sin(Math.min(1, t * 1.6) * Math.PI) ;
    want.lift = k * 0.075;
    want.armN = 0.55 * k + 0.16;
    want.armF = 0.5 * k + 0.12;
    want.elbN = 0.3 + k * 1.25;
    want.elbF = 0.28 + k * 1.2;
    want.wrist = 0.5 + k * 0.5;
    want.neck = -0.12 * k;
    want.look = 0.35 * k;
    want.tilt = 0.07 * k;
    want.spine = 0.04 - 0.08 * k;
  }

  // -------------------------------------------------------------------------
  // Rig application
  // -------------------------------------------------------------------------

  function applyPose(dt: number): void {
    // Breathing rides on top of the damped pose so it never gets smoothed out.
    breath += dt * (state === "aim" ? 1.5 : 2.1);
    const br = Math.sin(breath);

    rig.rotation.y = faceAngle;
    rig.position.y = pose.rise;
    rig.rotation.z = pose.tilt;

    legN.hip.rotation.z = pose.hipN;
    legF.hip.rotation.z = pose.hipF;
    legN.knee.rotation.z = -pose.kneeN;
    legF.knee.rotation.z = -pose.kneeF;

    spine.rotation.z = pose.spine;
    spine.rotation.y = pose.twist;
    spine.scale.set(1, 1 + br * 0.012, 1 + br * 0.02);

    neck.rotation.z = pose.neck + br * 0.008;
    head.rotation.y = pose.look;

    armN.shoulder.position.y = SHOULDER_Y + pose.lift;
    armF.shoulder.position.y = SHOULDER_Y + pose.lift;
    armN.shoulder.rotation.z = pose.armN;
    armF.shoulder.rotation.z = pose.armF;
    armN.elbow.rotation.z = pose.elbN;
    armF.elbow.rotation.z = pose.elbF;
    club.rotation.z = pose.wrist;

    root.position.set(x, y, LAYER.character);
  }

  /** Walk cycle laid over the damped pose — crisp, never smoothed away. */
  function applyWalk(): void {
    if (walk < 0.02) return;
    const s = Math.sin(walkPhase);
    const c = Math.cos(walkPhase);
    legN.hip.rotation.z += s * 0.5 * walk;
    legF.hip.rotation.z += -s * 0.5 * walk;
    legN.knee.rotation.z -= Math.max(0, -c) * 0.6 * walk;
    legF.knee.rotation.z -= Math.max(0, c) * 0.6 * walk;
    armN.shoulder.rotation.z += -s * 0.42 * walk;
    armF.shoulder.rotation.z += s * 0.42 * walk;
    rig.position.y += Math.abs(Math.sin(walkPhase * 2)) * 0.035 * walk;
    rig.rotation.z += c * 0.02 * walk;
  }

  function updateShadow(): void {
    if (!hasGround) {
      shadow.visible = false;
      return;
    }
    const h = Math.max(0, y - groundY);
    const fade = clamp(1 - h / 9, 0, 1);
    shadow.visible = fade > 0.03 && shown > 0.05;
    shadow.position.set(x + 0.08 * facing, groundY + 0.04, LAYER.props + 0.5);
    const w = (1.32 + h * 0.22) * RIG_SCALE;
    shadow.scale.set(w, w * 0.3, 1);
    shadowMat.opacity = 0.62 * fade * fade * shown;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const offs: Array<() => void> = [];

  const characterPayload = () => ({ root, rig, head, hand: armN.elbow, club });

  offs.push(ctx.on("golf:hole", (payload) => {
    hole = (payload as { hole?: Hole })?.hole ?? null;
    const tee = hole?.tee;
    const cup = hole?.cup;
    if (tee) placeAt(tee.x - STAND_OFFSET, tee.y, cup ? Math.sign(cup.x - tee.x) || 1 : 1);
    aiming = false;
    aimPower = 0;
    // Re-announce for anything that booted after this system did.
    ctx.emit("golf:character", characterPayload());
  }));

  offs.push(ctx.on("golf:aim", (payload) => {
    const a = payload as { aiming?: boolean; power?: number; dir?: { x: number; y: number } };
    aiming = Boolean(a?.aiming);
    aimPower = clamp(a?.power ?? 0, 0, 1);
    if (a?.dir && Math.abs(a.dir.x) > 0.08) {
      aimDirX = a.dir.x;
      aimDirY = a.dir.y;
    }
  }));

  offs.push(ctx.on("golf:shot", (payload) => {
    const p = (payload as { power?: number })?.power;
    swingPower = clamp(typeof p === "number" ? p : aimPower, 0, 1);
    aiming = false;
    aimPower = 0;
    beginClip("swing", SWING_DUR);
    // The lie is frozen here: the golfer stays where he struck it.
    anchorX = x;
  }));

  offs.push(ctx.on("golf:holed", () => beginClip("cheer", CHEER_DUR)));
  offs.push(ctx.on("golf:penalty", () => beginClip("slump", SLUMP_DUR)));
  offs.push(ctx.on("golf:hazard", () => {
    // Don't step on a celebration — a ball can trip a hazard after it drops.
    if (state !== "cheer") beginClip("flinch", FLINCH_DUR);
  }));

  offs.push(ctx.on("golf:ready", () => {
    const ball = liveBall();
    const cup = ctx.services.course?.current?.cup;
    if (!ball || !cup) return;
    const d = Math.hypot(ball.pos.x - cup.x, ball.pos.y - cup.y);
    if (d > SHRUG_DIST && state !== "cheer") beginClip("shrug", SHRUG_DUR);
  }));

  offs.push(ctx.on("golf:jetpackState", (payload) => {
    jetActive = Boolean((payload as { active?: boolean })?.active);
    if (jetActive) jetHide = 1;
  }));

  // -------------------------------------------------------------------------

  const sys: System = {
    name: "character",

    update(dt: number) {
      const phys = ctx.services.physics;
      if (!hole) hole = ctx.services.course?.current ?? null;
      const ball = liveBall();
      if (!phys || !hole) {
        group.visible = false;
        return;
      }

      // --- visibility: the jetpack owns the golfer while it's flying --------
      if (jetActive) jetHide = 1;
      else if (jetHide > 0) jetHide = Math.max(0, jetHide - dt * 1.2);
      const wantShown = jetHide > 0.001 ? 0 : 1;
      shown += (wantShown - shown) * (1 - Math.exp(-dt * 6));
      group.visible = shown > 0.02;
      root.scale.setScalar(RIG_SCALE * (0.6 + 0.4 * shown));
      (auraMat.uniforms.uAlpha.value as number) = 0.13 * shown;

      // --- where should he be standing? -------------------------------------
      const rules = ctx.services.rules;
      const settled = !ball || ball.resting || Boolean(rules?.canShoot);
      if (ball && settled) {
        // Behind the ball along the shot line, so he can never occlude it.
        const cup = hole.cup;
        const towardCup = Math.sign(cup.x - ball.pos.x) || 1;
        const dirX = aiming ? aimDirX : towardCup;
        anchorX = ball.pos.x - Math.sign(dirX || 1) * STAND_OFFSET;
      }

      // --- facing ------------------------------------------------------------
      let wantFacing = facing;
      if (aiming) {
        wantFacing = aimDirX >= 0 ? 1 : -1;
      } else if (state === "watch" && ball) {
        // Turn the body to keep the ball in front — the touch that sells it.
        const hx = (ball.pos.x - x) * facing;
        if (hx < -2.2) wantFacing = -facing;
      } else if (state === "idle" || state === "shrug") {
        const dx = anchorX - x;
        if (Math.abs(dx) > WALK_TURN) wantFacing = dx >= 0 ? 1 : -1;
        else if (ball) wantFacing = (Math.sign(hole.cup.x - ball.pos.x) || 1) as 1 | -1;
      }
      if (state !== "swing" && state !== "cheer") facing = wantFacing >= 0 ? 1 : -1;
      const faceGoal = facing > 0 ? 0 : Math.PI;
      faceAngle += (faceGoal - faceAngle) * (1 - Math.exp(-dt * 9));

      // --- walk --------------------------------------------------------------
      const clipRunning = clipDur > 0;
      const dx = anchorX - x;
      const ad = Math.abs(dx);
      if (ad > TELEPORT_DIST) {
        x = anchorX;
        walk = 0;
        walkPhase = 0;
        groundTick = 0;
        findGround(x, ball ? ball.pos.y + 1.5 : y + 1.5);
        if (hasGround) y = groundY;
      } else if (!clipRunning && ad > 0.16) {
        const sp = Math.min(WALK_SPEED, ad * 4.2 + 0.6);
        x += Math.sign(dx) * Math.min(ad, sp * dt);
        walk += (Math.min(1, sp / WALK_SPEED) - walk) * (1 - Math.exp(-dt * 9));
        walkPhase += dt * (3.2 + sp * 1.7);
        // A little dust off the heels, through the shared vfx pool so it
        // grades with every other puff in the game.
        stepAcc += dt * sp * 0.9;
        if (stepAcc >= 1) {
          stepAcc = 0;
          ctx.services.vfx?.trailPuff(v2(x - facing * 0.2, y + 0.08), 0xbfc9d8);
        }
      } else {
        x += dx * Math.min(1, dt * 7);
        walk += (0 - walk) * (1 - Math.exp(-dt * 8));
        if (walk < 0.02) walkPhase = 0;
      }

      // --- ground ------------------------------------------------------------
      if (groundTick-- <= 0) {
        groundTick = 3;
        findGround(x, hasGround ? groundY + 0.6 : (ball ? ball.pos.y : y) + 1.5);
      }
      if (hasGround) y += (groundY - y) * (1 - Math.exp(-dt * 14));

      // --- state -------------------------------------------------------------
      if (clipDur > 0) {
        clipT += dt;
        if (clipT >= clipDur) {
          clipT = 0;
          clipDur = 0;
        }
      }
      if (clipDur <= 0) {
        state = aiming ? "aim" : ball && !ball.resting ? "watch" : "idle";
      }

      // --- pose --------------------------------------------------------------
      switch (state) {
        case "aim": poseAim(); break;
        case "swing": poseSwing(clipT / SWING_DUR); break;
        case "cheer": poseCheer(clipT / CHEER_DUR); break;
        case "slump": poseSlump(clipT / SLUMP_DUR); break;
        case "flinch": poseFlinch(clipT / FLINCH_DUR); break;
        case "shrug": poseShrug(clipT / SHRUG_DUR); break;
        case "watch": if (ball) { poseWatch(ball); break; } poseIdle(dt); break;
        default: poseIdle(dt); break;
      }

      // Idle look-around: a glance at the cup, or off at the scenery.
      if (state === "idle") {
        lookTimer -= dt;
        if (lookTimer <= 0) {
          lookTimer = 2.4 + rng() * 4.5;
          lookTarget = lookTarget !== 0 ? 0 : (rng() - 0.5) * 1.05;
        }
      } else {
        lookTarget = 0;
      }

      // Clips need to snap; idle and aim want to breathe into position.
      const rate = clipDur > 0 ? 26 : state === "aim" ? 15 : 8;
      const k = 1 - Math.exp(-dt * rate);
      for (const key of POSE_KEYS) pose[key] += (want[key] - pose[key]) * k;

      applyPose(dt);
      applyWalk();
      updateShadow();
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      ctx.scene?.remove(group);
      for (const o of owned) o.dispose();
      owned.length = 0;
    },
  };

  // Boot: place him somewhere sane in case a hole is already loaded, and
  // announce the rig so the jetpack can claim it if it ever wants to.
  const current = ctx.services.course?.current ?? null;
  if (current) {
    hole = current;
    placeAt(current.tee.x - STAND_OFFSET, current.tee.y, Math.sign(current.cup.x - current.tee.x) || 1);
  }
  ctx.emit("golf:character", characterPayload());

  return sys;
};

export default createCharacter;
