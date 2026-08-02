/**
 * Vibe Golf — the golfer.
 *
 * The game's personality: a jointed 2.5D figure who stands at the lie, coils
 * into a backswing while you drag, swings for real when you release, then
 * *turns and watches the ball fly*. That last one is the cheap trick that does
 * the most work — a world where something is paying attention to the ball
 * feels alive in a way no amount of parallax does.
 *
 * Built entirely from five shared primitives (capsule, sphere, cylinder, box,
 * quad) instanced into a hierarchy of joint `Group`s. Nothing here is loaded;
 * the only generated asset is a 64² radial canvas used for the shadows.
 *
 * Four things are worth knowing before you edit it:
 *
 * 1. **He is sized in *pixels*, not metres.** In portrait the ortho frustum is
 *    tall and narrow, so a hole that fits horizontally can make a 2 m figure
 *    35 px tall — invisible on a phone. `rigScale` is solved every frame from
 *    the live camera so the figure holds ~`TARGET_PX` of screen height, then
 *    clamped so he never out-grows the flagstick. Everything that has to stay
 *    in proportion with him (stand-off, shadow, halo) is derived from it.
 * 2. **The ball's readability is sacred.** The golfer plants *behind* the ball
 *    along the shot line, far enough back that the HUD's aim dial and its
 *    `100%  25°` readout — both anchored on the ball — never land on his body,
 *    and he is then clamped inside the frustum so the framing can never push
 *    him off the edge. While the ball is in flight he stays at the lie.
 * 3. **Animation is one damped pose.** Every state (idle / aim / swing /
 *    watch / cheer / slump / flinch / shrug) produces the *same* 16-number
 *    `Pose`; the rig damps toward it each frame and clips write keyframed
 *    values into it. The swing is authored as three *poses you can name* —
 *    windup, impact (held ~0.2 s so the contact reads as a frame, not a
 *    smear), follow-through — rather than one continuous sweep.
 * 4. **Readability is layered, not hoped for.** Ink hulls on every silhouette
 *    shape, a depth-tested dark halo that hugs the body (it is occluded by
 *    him, so only the rim survives) and a teal rim glow behind that, plus a
 *    two-part contact shadow. He has to hold against bright grass, dark water
 *    and a neon sky, at 40 px, with bloom blowing out the ball beside him.
 *
 * Publishes no service. Emits `golf:character` once at boot and again on
 * `golf:hole` — payload `{ root, rig, head, hand, club }` — so the jetpack
 * module can drive the rig if it ever wants to; while nobody claims it, this
 * system keeps full control. Hides itself while the jetpack is flying so there
 * is only ever one golfer on screen.
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

/** Authored height of the rig, feet to the top of the cap, in metres. */
const RIG_H = 1.85;
/**
 * How tall he should be on screen, in CSS pixels. ~10% of a 932 px phone —
 * below about 70 the arms stop reading and the swing becomes a smear.
 */
const TARGET_PX = 100;
/**
 * Scale clamps. The flagstick is 4.6 m, so `SCALE_MAX` puts him shoulder to
 * shoulder with the pin and no taller; `SCALE_MIN` is the floor for close-in
 * putts where the camera is already generous. (Was a flat 1.16 — a 2.1 m
 * figure, i.e. ~28 px at address and ~17 px on a long hole.)
 */
const SCALE_MIN = 1.85;
const SCALE_MAX = 2.7;

/**
 * Stand-off from the ball as a multiple of `rigScale`, and the screen-space
 * clearance that wins when the camera is zoomed in. The HUD's aim dial has a
 * 58 px radius centred on the ball and its readout runs to about +120 px, so
 * anything closer than ~62 px puts UI on his chest.
 */
const STAND_MIN_K = 0.92;
const STAND_MAX_K = 2.0;
const STAND_PX = 72;
/** Extra clearance when he is standing on the side the readout is drawn. */
const STAND_PX_LABEL = 30;

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

/** Long enough that windup → impact → follow-through are three *readings*. */
const SWING_DUR = 1.24;
/** Normalised clip time of contact, and of the end of the impact hold. */
const T_IMPACT = 0.1;
const T_HOLD = 0.28;
const CHEER_DUR = 1.8;
const SLUMP_DUR = 1.7;
const FLINCH_DUR = 0.6;
const SHRUG_DUR = 1.2;

// --- rig dimensions, metres, feet at y = 0 ---------------------------------
const HIP_Y = 0.90;
const THIGH_L = 0.44;
const SHIN_L = 0.42;
const LEG_Z = 0.13;
const SPINE_Y = 0.86;
/** Shoulder height in spine-local space. */
const SHOULDER_Y = 0.52;
const SHOULDER_Z = 0.185;
const UPPER_L = 0.32;
const FORE_L = 0.30;
/** Neck joint in spine-local space. */
const NECK_Y = 0.58;
const CLUB_L = 1.0;

// --- palette ---------------------------------------------------------------
// Three values, not three hues: a near-white torso, near-black legs and an
// amber cap. Whatever he is standing against — lit grass, dark water, sky —
// at least two of the three are in contrast with it.
const C_SHIRT = 0xf4f8fd;
const C_TROUSER = 0x141d33;
const C_TRIM = 0xfbbf24;
const C_TEAL = 0x14b8a6;
const C_SKIN = 0xffd9b0;
const C_SHAFT = 0x101827;
const C_STEEL = 0xdfe6f0;
const C_INK = 0x03070f;
const C_AURA = 0x2dd4bf;
/**
 * Halo behind the figure. This is a *multiplier*, not a paint: whatever is
 * behind him is scaled toward this cool blue-grey, so the ring reads as depth
 * on grass, sand or sky rather than as a black sticker.
 */
const C_HALO = 0x6b6e78;

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
  // A wide stance split so both feet are readable in a side-on view — with
  // the legs stacked he reads as one-legged at phone size.
  p.hipN = 0.17; p.hipF = -0.14;
  p.kneeN = 0.07; p.kneeF = 0.07;
  p.spine = 0.04; p.twist = 0; p.neck = 0.02; p.look = 0;
  p.armN = 0.18; p.armF = 0.13;
  p.elbN = 0.32; p.elbF = 0.27;
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

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// ---------------------------------------------------------------------------
// The swing, authored as three poses.
//
// `golf:shot` fires on release, so the backswing has *already happened* — it
// is the address pose, drawn back in proportion to the drag. The clip starts
// from exactly that pose (see `windup`), whips down to contact at T_IMPACT,
// *holds* the impact pose until T_HOLD so the eye gets a frame of it, then
// unwinds. The curves below are parameterised on u, the normalised time from
// the end of the hold to the end of the clip.
// ---------------------------------------------------------------------------

interface Windup {
  spine: number; twist: number; neck: number;
  arm: number; elb: number; wrist: number; rise: number;
}

/** Top of the backswing at power `p`. Shared by the address pose and the clip. */
function windup(p: number): Windup {
  return {
    spine: 0.26 + p * 0.08,
    twist: -(0.2 + p * 0.62),
    neck: 0.36 - p * 0.06,
    arm: -(0.34 + p * 1.62),
    elb: 0.44 + p * 0.4,
    wrist: -(0.3 + p * 1.45),
    rise: -0.02 - p * 0.035,
  };
}

/** Contact. Head down, hips open, club through the ball. */
const IMPACT = {
  spine: 0.11, twist: 0.16, neck: 0.28,
  arm: 0.96, elb: 0.05, wrist: 0.08, rise: -0.035,
  hip: 0.18,
};

const K_ARM: Key[] = [[0, IMPACT.arm], [0.3, 1.9], [0.62, 2.52], [1, 0.34]];
const K_ELB: Key[] = [[0, IMPACT.elb], [0.28, 0.5], [0.62, 1.6], [1, 0.36]];
const K_SPINE: Key[] = [[0, IMPACT.spine], [0.3, -0.14], [0.62, -0.28], [1, 0.03]];
const K_TWIST: Key[] = [[0, IMPACT.twist], [0.3, 0.58], [0.62, 0.76], [1, 0.08]];
const K_WRIST: Key[] = [[0, IMPACT.wrist], [0.3, 0.85], [0.62, 1.4], [1, 0.45]];
const K_HIP: Key[] = [[0, IMPACT.hip], [0.3, 0.28], [0.62, 0.32], [1, 0.03]];
const K_RISE: Key[] = [[0, IMPACT.rise], [0.3, 0.05], [0.62, 0.06], [1, 0]];
const K_NECK: Key[] = [[0, IMPACT.neck], [0.3, -0.14], [0.62, -0.32], [1, 0.02]];

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
   * Every material carries an emissive floor. The golfer is ~100 px tall on a
   * phone and has to survive both a bright fairway and a deep blue-black neon
   * sky, so he is lit but never fully at the mercy of the scene's key light.
   * The floor stays well under the bloom threshold — a blooming golfer is a
   * white blob, which is the problem, not the fix.
   */
  const lit = (color: number, glow: number, rough = 0.6, metal = 0.04) =>
    keep(new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      emissive: new THREE.Color(color).multiplyScalar(glow),
    }));

  const mShirt = lit(C_SHIRT, 0.24, 0.66);
  const mTrouser = lit(C_TROUSER, 0.16, 0.58);
  const mTrim = lit(C_TRIM, 0.42, 0.42, 0.15);
  const mTeal = lit(C_TEAL, 0.34, 0.5, 0.1);
  const mSkin = lit(C_SKIN, 0.3, 0.8);
  const mShaft = lit(C_SHAFT, 0.1, 0.4, 0.5);
  const mSteel = lit(C_STEEL, 0.22, 0.26, 0.85);
  const mFace = keep(new THREE.MeshBasicMaterial({ color: 0x0b1426 }));

  /**
   * Flat ink hull, front-face culled, worn one size up behind every shape that
   * defines the silhouette. Same reason a stickman gets a keyline: it survives
   * any background for the price of one extra draw per part.
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
   * Add `m` to `parent`, with an ink hull behind it if `grow` is given. Low
   * quality keeps the hulls on the six largest shapes only — the keyline is
   * the single cheapest readability win in the module, so it is the last thing
   * to be cut, not the first.
   */
  interface Ink { mesh: THREE.Mesh; sx: number; sy: number; sz: number; grow: number }
  const inks: Ink[] = [];

  const attach = (parent: THREE.Object3D, m: THREE.Mesh, grow = 0): THREE.Mesh => {
    if (grow > 0 && (!low || grow >= 0.07)) {
      const ink = new THREE.Mesh(m.geometry, mInk);
      ink.position.copy(m.position);
      ink.rotation.copy(m.rotation);
      ink.scale.set(m.scale.x + grow, m.scale.y + grow * 0.6, m.scale.z + grow);
      ink.renderOrder = -1;
      parent.add(ink);
      inks.push({ mesh: ink, sx: m.scale.x, sy: m.scale.y, sz: m.scale.z, grow });
    }
    parent.add(m);
    return m;
  };

  /**
   * Thicken the keyline as he shrinks. A hull authored in metres is 2 px at
   * address and half a pixel on a long hole — which is to say gone, exactly
   * when it is needed most. Held to whole-ish steps so it never shimmers.
   */
  let inkBoost = 1;
  const setInkBoost = (b: number) => {
    if (Math.abs(b - inkBoost) < 0.05) return;
    inkBoost = b;
    for (const i of inks) i.mesh.scale.set(i.sx + i.grow * b, i.sy + i.grow * 0.6 * b, i.sz + i.grow * b);
  };

  // --- root / rig -----------------------------------------------------------
  const root = new THREE.Group();          // world position of the feet
  root.position.z = LAYER.character;
  root.scale.setScalar(SCALE_MIN);

  const rig = new THREE.Group();           // facing (Y rotation) + rise + tilt
  root.add(rig);

  /**
   * Separation halo. Two quads sitting *behind* the body in Z with depth test
   * **on**: the opaque rig writes depth first, so both are punched out by his
   * own silhouette and only the rim survives. That is what turns him from a
   * flat decal into a figure with an edge, on grass or on water, for two
   * draws. The dark one does the work; the teal one is the neon accent.
   */
  type Blend = "add" | "multiply";
  const haloShader = (
    color: number, alpha: number, inner: number, mode: Blend,
    fadeLo = 0.1, fadeHi = 0.32,
  ) =>
    keep(new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: mode === "add" ? THREE.AdditiveBlending : THREE.MultiplyBlending,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uAlpha: { value: alpha },
        uInner: { value: inner },
        uFade: { value: new THREE.Vector2(fadeLo, fadeHi) },
        uMul: { value: mode === "multiply" ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec3 uColor; uniform float uAlpha; uniform float uInner;
        uniform vec2 uFade; uniform float uMul;
        void main(){
          // Ellipse inscribed in the quad, so the field reaches zero exactly at
          // the border in every direction — no straight cut anywhere. Flat out
          // to uInner, then a short ramp: the point is a dense collar hugging
          // the body, not a soft cloud that averages away to nothing.
          vec2 p = (vUv - vec2(0.5)) * 2.0;
          float d = length(p);
          float a = 1.0 - smoothstep(uInner, 1.0, d);
          // Kill it at the feet so it never reads as a stain on the turf.
          a *= smoothstep(uFade.x, uFade.y, vUv.y) * uAlpha;
          // Darkening has to *multiply*: the scene is HDR and the grade lifts
          // and tone-maps afterwards, so an alpha-blended black lays down a
          // 60% wash that comes back out of the curve as a 5% smudge. A
          // multiply scales whatever is underneath and survives the pipe.
          gl_FragColor = mix(vec4(uColor, a), vec4(mix(vec3(1.0), uColor, a), 1.0), uMul);
        }`,
    }));

  // Sized to *hug*: a wide soft cloud averages away to nothing behind bloom
  // and grade, so the dark pass is barely bigger than he is and dense.
  const haloDarkMat = haloShader(C_HALO, 0.55, 0.72, "multiply");
  const haloGlowMat = haloShader(C_AURA, 0.22, 0.3, "add");
  const haloGlow = part(QUAD, haloGlowMat, 1.7, 2.6, 1, 0.04, 0.95, -0.7);
  const haloDark = part(QUAD, haloDarkMat, 0.98, 2.05, 1, 0.02, 0.9, -0.45);
  haloGlow.renderOrder = 2;
  haloDark.renderOrder = 3;
  root.add(haloGlow, haloDark);

  // --- legs -----------------------------------------------------------------
  interface Leg { hip: THREE.Group; knee: THREE.Group }
  const makeLeg = (z: number): Leg => {
    const hip = new THREE.Group();
    hip.position.set(0, HIP_Y, z);
    attach(hip, part(CAP, mTrouser, 0.17, THIGH_L / 2, 0.17, 0, -THIGH_L / 2, 0), 0.075);

    const knee = new THREE.Group();
    knee.position.y = -THIGH_L;
    attach(knee, part(CAP, mTrouser, 0.14, SHIN_L / 2, 0.14, 0, -SHIN_L / 2, 0), 0.07);
    // Teal sock cuff, then an amber shoe: two bright notes at the very bottom
    // of the silhouette, which is what stops the legs reading as sticks.
    attach(knee, part(CYL, mTeal, 0.165, 0.1, 0.165, 0, -SHIN_L + 0.05, 0), 0.05);
    attach(knee, part(BOX, mTrim, 0.34, 0.12, 0.17, 0.095, -SHIN_L - 0.02, 0), 0.055);
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

  attach(spine, part(CAP, mShirt, 0.44, 0.29, 0.33, 0, 0.28, 0), 0.1);
  // Teal collar, amber belt. Two horizontal bands bracketing the shirt read as
  // a kit at any size; a vertical placket vanishes below ~60 px and only ever
  // pokes out of the capsule's silhouette on the near side.
  attach(spine, part(CYL, mTeal, 0.4, 0.11, 0.32, 0, 0.5, 0), 0.05);
  attach(spine, part(CYL, mTrim, 0.46, 0.1, 0.35, 0, 0.05, 0), 0.05);

  const neck = new THREE.Group();
  neck.position.set(0, NECK_Y, 0);
  spine.add(neck);
  attach(neck, part(CYL, mSkin, 0.12, 0.1, 0.12, 0, 0.03, 0));

  const head = new THREE.Group();
  head.position.y = 0.07;
  neck.add(head);
  attach(head, part(SPH, mSkin, 0.32, 0.34, 0.31, 0, 0.15, 0), 0.09);
  // A dark visor band instead of a face: at 40 px a stripe reads as "looking
  // that way" far more reliably than eyes do. It sits a hair proud of the
  // skull so it survives being seen edge-on.
  attach(head, part(BOX, mFace, 0.1, 0.075, 0.29, 0.14, 0.1, 0));
  // The cap sits above the visor band, not over it — an amber dome down at
  // eye level simply swallows the face. The brim is the single most
  // recognisable shape on the whole figure, so it is oversized on purpose.
  attach(head, part(SPH, mTrim, 0.34, 0.23, 0.33, 0, 0.24, 0), 0.075);
  attach(head, part(BOX, mTrim, 0.26, 0.042, 0.28, 0.23, 0.155, 0), 0.05);

  // --- arms -----------------------------------------------------------------
  interface Arm { shoulder: THREE.Group; elbow: THREE.Group }
  const makeArm = (z: number): Arm => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0, SHOULDER_Y, z);
    attach(shoulder, part(SPH, mShirt, 0.21, 0.21, 0.21, 0, 0.02, 0), 0.06);
    attach(shoulder, part(CAP, mShirt, 0.125, UPPER_L / 2, 0.125, 0, -UPPER_L / 2, 0), 0.06);

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_L;
    attach(elbow, part(CAP, mSkin, 0.11, FORE_L / 2, 0.11, 0, -FORE_L / 2, 0), 0.055);
    attach(elbow, part(SPH, mShirt, 0.15, 0.15, 0.15, 0, -FORE_L - 0.03, 0), 0.05);
    shoulder.add(elbow);
    return { shoulder, elbow };
  };
  const armN = makeArm(SHOULDER_Z);
  const armF = makeArm(-SHOULDER_Z);
  spine.add(armF.shoulder, armN.shoulder);

  // --- club, parented to the near hand --------------------------------------
  // Thicker than a real shaft by a wide margin: the club *is* the read on
  // "this is a golfer", and a 1 px line is not a read.
  const club = new THREE.Group();
  club.position.y = -FORE_L - 0.04;
  armN.elbow.add(club);
  attach(club, part(CYL, mShaft, 0.052, CLUB_L, 0.052, 0, -CLUB_L / 2, 0), 0.045);
  attach(club, part(CYL, mTrim, 0.075, 0.19, 0.075, 0, -0.08, 0), 0.045);
  attach(club, part(BOX, mSteel, 0.28, 0.115, 0.13, 0.085, -CLUB_L + 0.03, 0), 0.055);

  // --- contact shadow, world space, unrotated -------------------------------
  // Two quads: a dark core directly under the feet that plants him, and a long
  // soft cast raking down-right to match the pin's shadow (the key comes from
  // the upper left). Without the core he floats; without the cast he reads as
  // a sticker. Same ellipse shader as the halo, flat across most of its
  // radius — a canvas radial gradient concentrates its only opaque pixels
  // directly under his shoes, where nobody can see them.
  const coreMat = haloShader(0x22301f, 0.85, 0.42, "multiply", -1, -0.9);
  const castMat = haloShader(0x4a5a44, 0.75, 0.16, "multiply", -1, -0.9);
  const shadowCore = new THREE.Mesh(QUAD, coreMat);
  const shadowCast = new THREE.Mesh(QUAD, castMat);
  shadowCore.position.z = LAYER.props + 0.5;
  shadowCast.position.z = LAYER.props + 0.45;
  shadowCore.renderOrder = 4;
  shadowCast.renderOrder = 3;

  group.add(shadowCast, shadowCore, root);

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
  /** One dust puff per swing, fired the frame the club reaches the ball. */
  let struck = true;

  /** World position of the feet. */
  let x = 0;
  let y = 0;
  /** Where he is trying to stand; frozen at the lie while the ball flies. */
  let anchorX = 0;
  let groundY = 0;
  let groundTick = 0;
  let hasGround = false;

  /** Solved from the camera every frame; everything sizes off it. */
  let rigScale = SCALE_MIN;
  let standOff = SCALE_MIN;

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
  // Sizing — the whole readability story starts here.
  // -------------------------------------------------------------------------

  /**
   * Solve the rig scale and the stand-off from the live ortho frustum. In
   * portrait the frustum is derived from the *width* the camera wants, so the
   * visible height swings by a factor of three between a putt and a 60 m
   * corridor; a fixed metre scale is therefore a fixed-nothing scale.
   */
  function solveScale(dt: number): void {
    const cam = ctx.camera;
    const vh = Math.abs(cam.top - cam.bottom) / Math.max(1e-3, cam.zoom || 1);
    const pxH = typeof window === "undefined" ? 932 : Math.max(1, window.innerHeight);
    const mPerPx = vh / pxH;
    const wantScale = clamp((TARGET_PX * mPerPx) / RIG_H, SCALE_MIN, SCALE_MAX);
    // Damped, so a camera push never snaps his size.
    rigScale += (wantScale - rigScale) * (1 - Math.exp(-dt * 4));
    // How short of the target he actually came — the keyline makes up the rest.
    setInkBoost(clamp((TARGET_PX * mPerPx) / (RIG_H * rigScale), 1, 2.4));

    // Stand-off: whichever is larger of "in proportion with him" and "clear of
    // the HUD dial", capped so he never wanders half a hole away.
    const labelSide = aiming && aimDirX < 0;
    const pxWant = (STAND_PX + (labelSide ? STAND_PX_LABEL : 0)) * mPerPx;
    standOff = clamp(pxWant, rigScale * STAND_MIN_K, rigScale * STAND_MAX_K);
  }

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
    want.kneeN = 0.07 + Math.max(0, s) * 0.11;
    want.kneeF = 0.07 + Math.max(0, -s) * 0.11;
    want.hipN = 0.17 + s * 0.03;
    want.hipF = -0.14 - s * 0.03;
    want.look = lookTarget;
    want.neck = 0.02 - Math.abs(lookTarget) * 0.08;
    // Club grounded in front, the classic waiting-for-your-turn stance: the
    // three joints have to sum to about half a radian or the head floats.
    want.armN = 0.22;
    want.elbN = 0.18;
    want.wrist = 0.12;
  }

  /** Address = the top of the backswing, drawn back in proportion to the drag. */
  function poseAim(): void {
    restPose(want);
    const p = aimPower;
    const w = windup(p);
    // A lofted shot gets a more upright, open stance; a flat drive gets a
    // low coiled one. `aimDirY` is normalised, so this is just the loft.
    const loft = clamp(aimDirY, 0, 1);
    want.kneeN = 0.32;
    want.kneeF = 0.28;
    want.hipN = -0.16;
    want.hipF = 0.12;
    want.spine = w.spine - loft * 0.14;
    want.twist = w.twist;
    want.neck = w.neck;
    want.look = 0;
    want.armN = w.arm;
    // The far arm shadows the near one — both hands are on the same club, and
    // letting it drift produces a disembodied glove floating past the chest.
    want.armF = w.arm - 0.08;
    want.elbN = w.elb;
    want.elbF = w.elb + 0.05;
    want.wrist = w.wrist + loft * 0.3;
    want.rise = w.rise;
    want.tilt = -0.05 - loft * 0.05;
  }

  /**
   * Windup → impact → hold → follow-through. `t` is normalised over SWING_DUR.
   * The hold is real dead time: for 0.22 s the rig does not move except for a
   * brace wobble, which is the only way a swing reads as a *hit* rather than a
   * blur when the frame rate is anyone's guess.
   */
  function poseSwing(t: number): void {
    restPose(want);
    const p = swingPower;
    const w = windup(p);

    if (t < T_HOLD) {
      // Whip down from the top, then sit on the contact pose.
      const u = smooth(clamp(t / T_IMPACT, 0, 1));
      // A tiny brace shudder through the hold so it is held, not frozen.
      const held = clamp((t - T_IMPACT) / Math.max(1e-4, T_HOLD - T_IMPACT), 0, 1);
      const shake = Math.sin(held * Math.PI * 3) * (1 - held) * 0.035;
      const mix = (a: number, b: number) => a + (b - a) * u;
      want.spine = mix(w.spine, IMPACT.spine) + shake * 0.6;
      want.twist = mix(w.twist, IMPACT.twist) + shake;
      want.neck = mix(w.neck, IMPACT.neck);
      want.wrist = mix(w.wrist, IMPACT.wrist);
      want.rise = mix(w.rise, IMPACT.rise) * (0.7 + p * 0.6);
      const arm = mix(w.arm, IMPACT.arm);
      want.armN = arm * (arm > 0 ? 0.6 + p * 0.7 : 1);
      want.armF = want.armN - 0.08;
      want.elbN = mix(w.elb, IMPACT.elb);
      want.elbF = want.elbN + 0.05;
      const hip = IMPACT.hip * u * (0.6 + p * 0.7);
      want.hipN = mix(-0.16, hip);
      want.hipF = mix(0.12, -hip * 0.7);
      want.kneeN = 0.3 - hip * 0.3;
      want.kneeF = 0.26 + Math.max(0, hip) * 0.7;
      want.tilt = -0.05 + hip * 0.08;
      return;
    }

    const u = (t - T_HOLD) / Math.max(1e-4, 1 - T_HOLD);
    const arm = sample(K_ARM, u);
    const elb = sample(K_ELB, u);
    want.spine = sample(K_SPINE, u);
    want.twist = sample(K_TWIST, u) * (0.7 + p * 0.6);
    want.wrist = sample(K_WRIST, u);
    want.neck = sample(K_NECK, u);
    want.rise = sample(K_RISE, u) * (0.6 + p);
    // Follow-through scales with power: a putt barely lifts the club, a
    // full drive wraps it over the shoulder.
    const reach = 0.6 + p * 0.7;
    want.armN = arm * (arm > 0 ? reach : 1 + p * 0.5);
    want.armF = want.armN - 0.08;
    want.elbN = elb;
    want.elbF = elb + 0.05;
    const hip = sample(K_HIP, u) * (0.6 + p * 0.7);
    want.hipN = hip;
    want.hipF = -hip * 0.7;
    want.kneeN = 0.3 - hip * 0.3;
    want.kneeF = 0.22 + Math.max(0, hip) * 0.7;
    want.tilt = -0.05 + sample(K_HIP, u) * 0.08;
  }

  /** Watching the ball fly: hand to the brow when it's high and far. */
  function poseWatch(ball: BallState): void {
    restPose(want);
    const dx = (ball.pos.x - x) * facing;
    // Eye height rides the solved scale — he is 5 m tall now, not 2 m, and a
    // fixed 1.55 makes him crane at a ball that is level with his own head.
    const dy = ball.pos.y - (y + 0.84 * rigScale);
    const pitch = Math.atan2(dy, Math.max(1.2, Math.abs(dx)));
    const high = clamp(pitch / 0.7, 0, 1);
    want.spine = 0.04 - high * 0.3;
    want.neck = -clamp(pitch, -0.4, 0.95) * 0.9;
    want.twist = clamp(dx * 0.02, -0.3, 0.3);
    want.kneeN = 0.12;
    want.kneeF = 0.12;
    // Shading the eyes — only once the ball has really climbed. The near arm
    // crosses the head, which is a shape you can read at 40 px.
    want.armN = 0.22 - high * 2.0;
    want.elbN = 0.3 + high * 1.85;
    want.armF = 0.14;
    want.elbF = 0.26;
    want.wrist = 0.5 - high * 0.4;
    want.rise = high * 0.02;
    want.hipN = 0.2;
    want.hipF = -0.16;
  }

  function poseCheer(t: number): void {
    restPose(want);
    // Two fist pumps and a couple of hops.
    const pump = Math.sin(t * Math.PI * 4.2);
    const hop = Math.abs(Math.sin(t * Math.PI * 3.1)) * (1 - t);
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
    want.kneeN = 0.07 + settle * 0.22;
    want.kneeF = 0.07 + settle * 0.22;
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
    want.kneeN = 0.07 + 0.34 * k;
    want.kneeF = 0.07 + 0.3 * k;
    want.rise = 0.03 * k;
    want.tilt = -0.12 * k;
  }

  function poseShrug(t: number): void {
    restPose(want);
    const k = Math.sin(Math.min(1, t * 1.6) * Math.PI);
    want.lift = k * 0.075;
    want.armN = 0.55 * k + 0.18;
    want.armF = 0.5 * k + 0.13;
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

  /**
   * Contact shadow. Sized off `rigScale` so it grows with him, and drawn even
   * when the ground probe misses — the feet are the ground in that case, and a
   * missing shadow is what makes a figure look pasted on.
   */
  function updateShadow(): void {
    const gy = hasGround ? groundY : y;
    const h = Math.max(0, y - gy);
    const fade = clamp(1 - h / 9, 0, 1);
    const vis = fade > 0.03 && shown > 0.05 && group.visible;
    shadowCore.visible = vis;
    shadowCast.visible = vis && !low;
    if (!vis) return;
    const s = rigScale * (0.6 + 0.4 * shown);
    const w = (1.2 + h * 0.2) * s;
    shadowCore.position.set(x + 0.06 * s, gy + 0.02 * s, LAYER.props + 0.5);
    shadowCore.scale.set(w, w * 0.5, 1);
    (coreMat.uniforms.uAlpha.value as number) = 0.9 * fade * fade * shown;
    shadowCast.position.set(x + 0.72 * s, gy + 0.05 * s, LAYER.props + 0.45);
    shadowCast.scale.set(w * 1.7, w * 0.34, 1);
    (castMat.uniforms.uAlpha.value as number) = 0.5 * fade * fade * shown;
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
    if (tee) placeAt(tee.x - standOff, tee.y, cup ? Math.sign(cup.x - tee.x) || 1 : 1);
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
    struck = false;
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

      solveScale(dt);

      // --- visibility: the jetpack owns the golfer while it's flying --------
      if (jetActive) jetHide = 1;
      else if (jetHide > 0) jetHide = Math.max(0, jetHide - dt * 1.2);
      const wantShown = jetHide > 0.001 ? 0 : 1;
      shown += (wantShown - shown) * (1 - Math.exp(-dt * 6));
      group.visible = shown > 0.02;
      root.scale.setScalar(rigScale * (0.6 + 0.4 * shown));
      (haloDarkMat.uniforms.uAlpha.value as number) = 0.55 * shown;
      (haloGlowMat.uniforms.uAlpha.value as number) = (state === "aim" ? 0.3 : 0.22) * shown;

      // --- where should he be standing? -------------------------------------
      const rules = ctx.services.rules;
      const settled = !ball || ball.resting || Boolean(rules?.canShoot);
      if (ball && settled) {
        // Behind the ball along the shot line, so he can never occlude it, and
        // far enough that the ball-anchored HUD never lands on him.
        const cup = hole.cup;
        const towardCup = Math.sign(cup.x - ball.pos.x) || 1;
        const dirX = aiming ? aimDirX : towardCup;
        const side = Math.sign(dirX || 1) || 1;
        let a = ball.pos.x - side * standOff;
        // Clamp inside the frustum: the tee framing sits the ball hard against
        // one edge, and a golfer cropped in half is worse than a close one.
        const cam = ctx.camera;
        const halfW = Math.abs(cam.right - cam.left) * 0.5 / Math.max(1e-3, cam.zoom || 1);
        const margin = 0.62 * rigScale;
        a = clamp(a, cam.position.x - halfW + margin, cam.position.x + halfW - margin);
        // ...but never so close that he crowds the ball.
        const near = rigScale * 0.7;
        if ((ball.pos.x - a) * side < near) a = ball.pos.x - side * near;
        anchorX = a;
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
        const dx0 = anchorX - x;
        if (Math.abs(dx0) > WALK_TURN) wantFacing = dx0 >= 0 ? 1 : -1;
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
          ctx.services.vfx?.trailPuff(v2(x - facing * 0.12 * rigScale, y + 0.04 * rigScale), 0xbfc9d8);
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

      // Turf spray the instant the club reaches the ball — the contact needs a
      // punctuation mark, not just a pose.
      if (state === "swing" && !struck && clipT / SWING_DUR >= T_IMPACT) {
        struck = true;
        ctx.services.vfx?.trailPuff(v2(x + facing * 0.9 * rigScale, y + 0.1), 0xe8f2d8);
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

      // Clips need to snap; idle and aim want to breathe into position. The
      // impact hold damps hardest of all so the held pose is actually *held*
      // and not eased through.
      const holding = state === "swing" && clipT / SWING_DUR < T_HOLD;
      const rate = holding ? 40 : clipDur > 0 ? 26 : state === "aim" ? 15 : 8;
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
    placeAt(current.tee.x - standOff, current.tee.y, Math.sign(current.cup.x - current.tee.x) || 1);
  }
  ctx.emit("golf:character", characterPayload());

  return sys;
};

export default createCharacter;
