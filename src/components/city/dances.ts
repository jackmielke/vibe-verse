/**
 * dances — real body movement, for every character in the city.
 *
 * The emote wheel could already throw an emoji over somebody's head, which is
 * a *label* for a feeling rather than a performance of it: press 💃 and a
 * little pink sprite bobs above a character standing perfectly still. Nobody
 * is dancing. This module is the other half — the body actually moves.
 *
 * ## Why this is procedural rather than a pile of clips
 *
 * Fifty-six of the city's characters are Quaternius GLBs, and their clip list
 * is Idle / Walk / Run / Jump / Punch / SwordSlash / Victory / SitDown. There
 * is no Dance in there, on any of them. The ~50 code-built pilots have no
 * clips at all — they are solved from motion every frame. So a dance that
 * only works for one of those two families would be a dance almost nobody in
 * the city can do, and buying animation packs for both is not a thing that can
 * happen inside one commit.
 *
 * What every one of them *does* share is a skeleton with the same shape: hips,
 * a spine, a head, two arms with an elbow, two legs with a knee. So a dance
 * here is not keyframes — it is a function of the beat that returns a pose in
 * **character space** (+X is the character's left, +Y up, +Z the way they are
 * facing), and two thin adapters push that pose onto a GLB skeleton and onto
 * the procedural rig. Add a dance and every character in the city can do it.
 *
 * ## The one piece of maths worth reading
 *
 * A GLB bone's local rotation is expressed in its *parent's* frame, and the
 * parent's frame is whatever Blender happened to bake — UpperArm.L on a
 * Quaternius rig sits at a quaternion with every component non-zero. So
 * "raise the arm out to the side" is not `rotation.z += x` on that bone; it is
 * some rig-specific mess that would need re-deriving for every skeleton.
 *
 * Instead each bound joint remembers its parent's *bind-pose* rotation `Wp`
 * (measured relative to the model root, so it is the character's own frame),
 * and a character-space rotation `R` is pushed onto the bone as
 *
 *     local = Wp⁻¹ · R · Wp · rest
 *
 * which is exactly "rotate this bone by R about the character's own axes",
 * whatever the rig's bind pose looks like. Because `Wp` is the *bind* parent
 * and not the live one, a child's rotation composes on top of its parent's
 * current rotation the way a real joint does: bend the elbow and the forearm
 * folds relative to the upper arm, wherever the shoulder has swung to.
 *
 * The procedural pilot's joints are already built facing +Z with no bind
 * rotation at all, so for that rig `Wp` and `rest` are both identity and the
 * same code path collapses to "write the rotation".
 *
 * ## Everybody is on the same beat
 *
 * The clock is `Date.now()`, not a per-dancer timer, so two people who start
 * the same dance ten seconds apart are still in step — which is the entire
 * difference between a crowd dancing and a crowd of individuals dancing.
 * It also means peers only need to be told *which* dance, never the phase.
 */
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A limb: shoulder+elbow, or hip+knee, plus a tip.
 *
 * `tip` is the foot on a leg and is unused on an arm — the hand is never bound,
 * because no two rigs in the city agree on what a hand is (Quaternius has a
 * `Fist`, the alien has fifteen finger bones, several pilots have no hand at
 * all) and nothing a dance does reads at hand scale anyway.
 */
export interface LimbPose {
  upper: Vec3;
  lower: Vec3;
  tip: Vec3;
}

/**
 * One frame of a dance, in character space: +X is the character's LEFT, +Y is
 * up, +Z is the way they are facing. Angles are radians, `rootY` is metres.
 *
 * Euler triples are read in `ZYX` order — the limb swings fore/aft first, then
 * twists, then lifts away from the body. That ordering is what makes "arm
 * forward AND overhead" land where you meant rather than folding into the
 * chest.
 */
export interface DancePose {
  /** Whole-body lift. Hops and bounces live here. */
  rootY: number;
  /** Whole-body spin, lean and roll. */
  rootYaw: number;
  rootPitch: number;
  rootRoll: number;
  hips: Vec3;
  torso: Vec3;
  head: Vec3;
  armL: LimbPose;
  armR: LimbPose;
  legL: LimbPose;
  legR: LimbPose;
}

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const limb = (): LimbPose => ({ upper: v3(), lower: v3(), tip: v3() });

export function createDancePose(): DancePose {
  return {
    rootY: 0,
    rootYaw: 0,
    rootPitch: 0,
    rootRoll: 0,
    hips: v3(),
    torso: v3(),
    head: v3(),
    armL: limb(),
    armR: limb(),
    legL: limb(),
    legR: limb(),
  };
}

const zero = (v: Vec3) => {
  v.x = 0;
  v.y = 0;
  v.z = 0;
};

/** Back to a neutral stand, so a dance only has to write what it cares about. */
export function resetDancePose(p: DancePose): DancePose {
  p.rootY = 0;
  p.rootYaw = 0;
  p.rootPitch = 0;
  p.rootRoll = 0;
  zero(p.hips);
  zero(p.torso);
  zero(p.head);
  for (const l of [p.armL, p.armR, p.legL, p.legR]) {
    zero(l.upper);
    zero(l.lower);
    zero(l.tip);
  }
  return p;
}

/**
 * Pose one arm in the terms a person would describe it in.
 *
 * `sd` is +1 for the character's left arm and −1 for the right, so a move
 * written once is symmetric by construction. `swing` is positive toward the
 * front, `raise` is positive away from the body on that arm's own side, and
 * `cross` is an absolute character-space shift (positive = toward the
 * character's left) for the moves where both arms go the *same* way rather
 * than mirroring — the floss being the obvious one.
 */
function setArm(
  l: LimbPose,
  sd: number,
  swing: number,
  raise: number,
  bend: number,
  cross = 0,
  twist = 0,
) {
  l.upper.x = -swing;
  l.upper.y = twist * sd;
  l.upper.z = raise * sd + cross;
  // Elbows fold the hand toward the front; knees fold the foot toward the
  // back. Same axis, opposite sign — hence two setters rather than one.
  l.lower.x = -bend;
  l.lower.y = 0;
  l.lower.z = 0;
}

/**
 * Pose one leg. `swing` positive lifts the knee forward, `bend` folds the heel
 * back, and `level` keeps the sole flat.
 *
 * That last one matters more than it sounds. There is no foot IK here — bend a
 * knee and the foot rotates with the shin, so a character in a half-crouch
 * ends up balanced on its toes with the soles pointing backwards, which is the
 * single thing that made every early version of these read as "broken rig"
 * rather than "dancing". Cancelling the accumulated pitch at the ankle costs
 * one subtraction and puts the feet back on the floor. Pass a lower `level`
 * where the feet genuinely should hang — mid-jump, mostly.
 */
function setLeg(
  l: LimbPose,
  sd: number,
  swing: number,
  spread: number,
  bend: number,
  level = 1,
) {
  l.upper.x = -swing;
  l.upper.y = 0;
  l.upper.z = spread * sd;
  l.lower.x = bend;
  l.lower.y = 0;
  l.lower.z = 0;
  // Undo the hip and knee pitch the ankle inherited: -(upper.x + lower.x).
  l.tip.x = (swing - bend) * level;
  l.tip.y = 0;
  l.tip.z = 0;
}

// ---------------------------------------------------------------------------
// The moves
// ---------------------------------------------------------------------------

export interface DanceDef {
  id: string;
  label: string;
  emoji: string;
  /** One-liner for the wheel. */
  blurb: string;
  /** The pose function is fed beats, not seconds — tempo lives here. */
  bpm: number;
  pose: (b: number, out: DancePose) => void;
}

const PI = Math.PI;
/** Ramp 0→1 over `beats`, then snap back. The sprinkler's whole joke. */
const sawtooth = (b: number, beats: number) => (b % beats) / beats;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const DANCE_LIST: DanceDef[] = [
  {
    id: "floss",
    label: "The Floss",
    emoji: "🕺",
    blurb: "Arms one way, hips the other. Badly, on purpose.",
    bpm: 128,
    pose(b, p) {
      const s = Math.sin(b * PI); // one full swing every two beats
      p.rootY = 0.03 * Math.abs(s) - 0.015;
      p.rootRoll = 0.1 * s;
      p.hips.y = 0.22 * s;
      p.hips.z = -0.3 * s;
      p.torso.y = -0.3 * s;
      p.torso.z = 0.16 * s;
      p.head.y = 0.14 * s;
      // Both arms travel the same way (`cross`) while one passes behind the
      // hips and the other in front — that alternation is the whole move.
      // Elbows stay nearly straight: a floss with bent arms is a shrug.
      setArm(p.armL, 1, -0.62 * s, 0.1, 0.14, 0.95 * s);
      setArm(p.armR, -1, 0.62 * s, 0.1, 0.14, 0.95 * s);
      setLeg(p.legL, 1, 0, 0.05, 0.1 + 0.06 * s);
      setLeg(p.legR, -1, 0, 0.05, 0.1 - 0.06 * s);
    },
  },
  {
    id: "robot",
    label: "The Robot",
    emoji: "🤖",
    blurb: "Eight poses, no interpolation, one servo buzz.",
    bpm: 104,
    pose(b, p) {
      // Deliberately NOT smoothed: the rig writes whatever it is handed, so
      // flooring the beat gives the hard snap the move is made of.
      const step = Math.floor(b) % 8;
      const buzz = Math.sin(b * 47) * 0.014;
      // [Lswing, Lraise, Lbend, Rswing, Rraise, Rbend, headY, torsoY]
      const K = [
        [1.45, 0.22, 1.5, 0.15, 0.95, 0.15, 0.45, 0.0],
        [0.15, 0.95, 0.15, 1.45, 0.22, 1.5, -0.45, 0.0],
        [1.5, 0.28, 0.1, 1.5, 0.28, 0.1, 0.0, 0.3],
        [0.1, 2.35, 1.15, -0.3, 0.2, 0.95, -0.2, -0.3],
        [0.15, 0.95, 0.15, 1.45, 0.22, 1.5, -0.45, 0.0],
        [1.45, 0.22, 1.5, 0.15, 0.95, 0.15, 0.45, 0.0],
        [0.2, 1.55, 1.65, 0.2, 1.55, 1.65, 0.0, 0.0],
        [-0.3, 0.2, 0.95, 0.1, 2.35, 1.15, 0.2, 0.3],
      ][step];
      p.rootY = step % 2 === 0 ? 0 : -0.03;
      p.rootYaw = (step === 2 ? 0.22 : step === 6 ? -0.22 : 0) + buzz;
      p.torso.y = K[7];
      p.torso.x = 0.05;
      p.head.y = K[6];
      p.head.x = buzz * 2;
      setArm(p.armL, 1, K[0] + buzz, K[1], K[2]);
      setArm(p.armR, -1, K[3] - buzz, K[4], K[5]);
      setLeg(p.legL, 1, 0, 0.07, 0.1);
      setLeg(p.legR, -1, 0, 0.07, 0.1);
    },
  },
  {
    id: "disco",
    label: "Disco Point",
    emoji: "🪩",
    blurb: "Point at the ceiling. Point at the floor. Repeat until the lights come up.",
    bpm: 118,
    pose(b, p) {
      const flip = Math.floor(b / 2) % 2 === 0; // swaps arms every two beats
      const pulse = Math.sin(b * PI);
      const jab = Math.max(0, Math.sin(b * PI * 2)); // punch on every beat
      p.rootY = 0.03 * Math.abs(pulse) - 0.015;
      p.hips.z = 0.18 * pulse;
      p.torso.y = -0.2 * pulse;
      p.torso.z = -0.08 * pulse;
      p.head.y = 0.18 * pulse;
      p.head.x = flip ? -0.16 : 0.1;
      const up: LimbPose = flip ? p.armL : p.armR;
      const down: LimbPose = flip ? p.armR : p.armL;
      const upSd = flip ? 1 : -1;
      /* Travolta, both halves: one arm points up and across, the other points
         down across the opposite hip, and they swap every two beats. Both
         elbows stay straight — the bent-elbow version of this reads as a
         shrug, which is what the first pass of it looked like. */
      setArm(up, upSd, 0.45 + jab * 0.18, 2.2 + jab * 0.25, 0.05);
      setArm(down, -upSd, 0.42, -0.28, 0.12);
      setLeg(p.legL, 1, 0.06 * pulse, 0.09, 0.14 + 0.08 * pulse);
      setLeg(p.legR, -1, -0.06 * pulse, 0.09, 0.14 - 0.08 * pulse);
    },
  },
  {
    id: "twist",
    label: "The Twist",
    emoji: "🌀",
    blurb: "Feet planted, everything above them going the other way.",
    bpm: 124,
    pose(b, p) {
      const s = Math.sin(b * PI);
      const a = Math.abs(s);
      p.rootY = -0.05 - 0.02 * a;
      p.rootYaw = 0.3 * s;
      p.hips.y = 0.3 * s;
      p.torso.y = -0.6 * s;
      p.torso.x = 0.06;
      p.head.y = 0.34 * s;
      // Elbows in, forearms up: the towel-drying arms the move is named for.
      setArm(p.armL, 1, 0.5, 0.45, 1.45, -0.45 * s);
      setArm(p.armR, -1, 0.5, 0.45, 1.45, -0.45 * s);
      setLeg(p.legL, 1, 0.05, 0.12, 0.24 + 0.1 * s);
      setLeg(p.legR, -1, 0.05, 0.12, 0.24 - 0.1 * s);
    },
  },
  {
    id: "runningman",
    label: "Running Man",
    emoji: "🏃",
    blurb: "Sprinting, going nowhere.",
    bpm: 126,
    pose(b, p) {
      const s = Math.sin(b * PI);
      const hop = Math.abs(s);
      p.rootY = 0.045 * hop - 0.03;
      p.torso.x = 0.15;
      p.torso.y = 0.22 * s;
      p.hips.y = -0.14 * s;
      /* One knee drives up while the other slides back and straightens. The
         driving knee gets the bend; the leg carrying the weight stays close to
         straight, because a character with two bent knees and no foot IK is
         standing on its toes rather than dancing on the floor. */
      const drive = (x: number) => Math.max(0, x);
      setLeg(p.legL, 1, 0.9 * drive(s) - 0.35 * drive(-s), 0.06, 0.15 + 1.05 * drive(s));
      setLeg(p.legR, -1, 0.9 * drive(-s) - 0.35 * drive(s), 0.06, 0.15 + 1.05 * drive(-s));
      setArm(p.armL, 1, -0.75 * s, 0.16, 1.3);
      setArm(p.armR, -1, 0.75 * s, 0.16, 1.3);
    },
  },
  {
    id: "sprinkler",
    label: "The Sprinkler",
    emoji: "💦",
    blurb: "One arm out, sweep slowly, snap back. Nobody has ever improved on it.",
    bpm: 108,
    pose(b, p) {
      // Six beats of slow sweep, then a hard reset — the timing IS the joke,
      // so the return is a jump cut rather than an ease.
      const u = sawtooth(b, 6);
      const sweep = u < 0.86 ? (u / 0.86) * 1.55 - 0.78 : 0.77 - ((u - 0.86) / 0.14) * 1.55;
      const ratchet = Math.sin(b * PI * 2) * 0.05;
      p.rootYaw = sweep;
      p.rootY = -0.03;
      p.torso.x = 0.06;
      p.torso.y = sweep * 0.3;
      p.head.y = sweep * 0.35;
      // Right arm is the hose; left is crooked behind the head holding it up.
      setArm(p.armR, -1, 0.12 + ratchet, 1.6, 0.05);
      setArm(p.armL, 1, -0.2, 1.5, 2.35);
      setLeg(p.legL, 1, 0.04, 0.14, 0.18);
      setLeg(p.legR, -1, 0.04, 0.14, 0.18);
    },
  },
  {
    id: "roof",
    label: "Raise the Roof",
    emoji: "🙌",
    blurb: "Both hands, straight up, on every beat.",
    bpm: 112,
    pose(b, p) {
      // Abs, not clamp: clamping puts the push on every OTHER beat and leaves
      // the character standing still through the one in between.
      const push = Math.abs(Math.sin(b * PI));
      const sway = Math.sin(b * PI * 0.5);
      p.rootY = 0.05 * push - 0.025;
      p.rootRoll = -0.07 * sway;
      p.hips.z = 0.14 * sway;
      p.torso.z = -0.06 * sway;
      p.head.x = -0.2 * push;
      setArm(p.armL, 1, 0.3, 2.15 + 0.55 * push, 0.95 - 0.8 * push, 0.1 * sway);
      setArm(p.armR, -1, 0.3, 2.15 + 0.55 * push, 0.95 - 0.8 * push, 0.1 * sway);
      setLeg(p.legL, 1, 0, 0.1, 0.24 - 0.16 * push);
      setLeg(p.legR, -1, 0, 0.1, 0.24 - 0.16 * push);
    },
  },
  {
    id: "hype",
    label: "Hype Jump",
    emoji: "🔥",
    blurb: "Off the floor on every beat, fists up.",
    bpm: 136,
    pose(b, p) {
      const air = clamp01(Math.sin(b * PI));
      // The beat you are NOT in the air is not a rest — it is the wind-up.
      // Without it the second half of every bar was a character standing
      // still, which is exactly what a still frame is merciless about.
      const load = clamp01(-Math.sin(b * PI));
      const tuck = air * air;
      p.rootY = 0.19 * air - 0.09 * load;
      p.rootYaw = 0.14 * Math.sin(b * PI * 0.5);
      p.torso.x = 0.1 - 0.16 * air + 0.22 * load;
      p.head.x = -0.14 * air;
      setArm(p.armL, 1, 0.2 - 0.75 * load, 0.3 + 2.15 * air, 1.15 - 0.95 * air + 0.35 * load);
      setArm(p.armR, -1, 0.2 - 0.75 * load, 0.3 + 2.15 * air, 1.15 - 0.95 * air + 0.35 * load);
      // Knees come up under the body in the air, absorb on the way down. The
      // feet are allowed to hang here — this is the one move where a dangling
      // sole is the correct read rather than a rig error.
      setLeg(p.legL, 1, 0.5 * tuck, 0.13, 0.22 + 0.85 * tuck + 0.3 * load, 1 - 0.8 * tuck);
      setLeg(p.legR, -1, 0.5 * tuck, 0.13, 0.22 + 0.85 * tuck + 0.3 * load, 1 - 0.8 * tuck);
    },
  },
  {
    id: "sidestep",
    label: "Step & Clap",
    emoji: "👏",
    blurb: "Two steps and a clap. Everybody can do this one.",
    bpm: 116,
    pose(b, p) {
      const s = Math.sin(b * PI * 0.5); // four-beat cycle: step, step, back, back
      const clap = Math.abs(Math.sin(b * PI)); // one clap per beat, not per bar
      p.rootY = 0.025 * clap - 0.015;
      p.hips.z = 0.16 * s;
      p.torso.z = -0.08 * s;
      p.torso.y = 0.12 * s;
      p.head.y = 0.16 * s;
      // Hands meet in front of the chest on the beat and open on the offbeat.
      // Elbows stay open: fold them further and the hands clap into the face.
      /* `open` goes NEGATIVE at the top of the clap, i.e. each arm crosses its
         own midline — which is what actually brings two hands together. Simply
         reducing the outward angle toward zero (the obvious version) just
         returns the arms to the character's sides, and the clap reads as a
         shrug with no contact in it. */
      const open = 0.45 - clap * 0.78;
      setArm(p.armL, 1, 0.75 + clap * 0.25, open, 0.7);
      setArm(p.armR, -1, 0.75 + clap * 0.25, open, 0.7);
      // A real step: the trailing leg reaches, the loaded one stays under you.
      setLeg(p.legL, 1, 0.06 * s, 0.06 + 0.3 * clamp01(s), 0.12);
      setLeg(p.legR, -1, -0.06 * s, 0.06 + 0.3 * clamp01(-s), 0.12);
    },
  },
];

export const DANCES: readonly DanceDef[] = DANCE_LIST;

const BY_ID = new Map(DANCE_LIST.map((d) => [d.id, d]));

export const findDance = (id: string | null | undefined): DanceDef | null =>
  (id && BY_ID.get(id)) || null;

/** A dance other than `exclude`, so pressing the key twice always changes something. */
export function randomDanceId(exclude?: string | null): string {
  const pool = DANCE_LIST.filter((d) => d.id !== exclude);
  const list = pool.length ? pool : DANCE_LIST;
  return list[Math.floor(Math.random() * list.length)].id;
}

/**
 * Wall-clock beats for a dance.
 *
 * Deliberately absolute rather than "seconds since this dancer started": two
 * people who hit the same dance at different moments are then on the same
 * beat, and a peer who joins mid-song falls straight into step. It is also why
 * the network only has to carry a dance *id*.
 */
export function danceBeats(def: DanceDef, nowMs = Date.now()): number {
  return (nowMs / 1000) * (def.bpm / 60);
}

/** Fill `out` with this dance's pose for the shared clock. */
export function evalDance(def: DanceDef, out: DancePose, nowMs = Date.now()): DancePose {
  resetDancePose(out);
  def.pose(danceBeats(def, nowMs), out);
  return out;
}

// ---------------------------------------------------------------------------
// Applying a pose to a skeleton
// ---------------------------------------------------------------------------

/**
 * One bound joint: the object to write, its bind-pose local rotation, and its
 * parent's bind rotation in character space (see the header for the algebra).
 */
export interface DanceJoint {
  obj: THREE.Object3D;
  rest: THREE.Quaternion;
  wp: THREE.Quaternion;
  wpInv: THREE.Quaternion;
  /** Scales this joint's share of the pose — the lower spine takes a fraction of the torso's. */
  gain: number;
}

export interface DanceSkeleton {
  /** Takes the whole-body motion. Its base transform is captured at bind time. */
  root: THREE.Object3D | null;
  rootBaseY: number;
  hips: DanceJoint | null;
  /** Lower spine, if the rig has one — takes a share of the torso rotation. */
  spine: DanceJoint | null;
  torso: DanceJoint | null;
  head: DanceJoint | null;
  armL: { upper: DanceJoint | null; lower: DanceJoint | null };
  armR: { upper: DanceJoint | null; lower: DanceJoint | null };
  legL: { upper: DanceJoint | null; lower: DanceJoint | null; tip: DanceJoint | null };
  legR: { upper: DanceJoint | null; lower: DanceJoint | null; tip: DanceJoint | null };
  /** How many joints actually bound — under ~4 and the rig only gets root motion. */
  bound: number;
}

const _euler = new THREE.Euler(0, 0, 0, "ZYX");
const _q = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();

/**
 * Bind one object as a dance joint.
 *
 * `rootInv` is the inverse of the character root's world rotation, which turns
 * the parent's world rotation into a *character-space* one — without it the
 * dance axes would follow whatever the player's yaw happened to be when the
 * model loaded.
 */
function bindJoint(obj: THREE.Object3D | null, rootInv: THREE.Quaternion, gain = 1): DanceJoint | null {
  if (!obj) return null;
  const wp = new THREE.Quaternion();
  if (obj.parent) obj.parent.getWorldQuaternion(wp);
  wp.premultiply(rootInv);
  return {
    obj,
    rest: obj.quaternion.clone(),
    wp,
    wpInv: wp.clone().invert(),
    gain,
  };
}

function writeJoint(j: DanceJoint | null, v: Vec3, weight: number) {
  if (!j || weight <= 0) return;
  const g = j.gain;
  _euler.set(v.x * g, v.y * g, v.z * g, "ZYX");
  _q.setFromEuler(_euler);
  _target.copy(j.wpInv).multiply(_q).multiply(j.wp).multiply(j.rest);
  // Slerp rather than copy so the dance blends out of (and back into) whatever
  // the mixer or the gait solver last wrote onto this bone.
  j.obj.quaternion.slerp(_target, weight);
}

/**
 * Push a pose onto a skeleton at `weight` (0 = leave it alone, 1 = full dance).
 * Safe to call every frame, and safe to call with weight 0 while fading out.
 */
export function applyDancePose(sk: DanceSkeleton, pose: DancePose, weight: number) {
  const w = weight <= 0 ? 0 : weight > 1 ? 1 : weight;
  if (sk.root) {
    sk.root.position.y = sk.rootBaseY + pose.rootY * w;
    sk.root.rotation.set(pose.rootPitch * w, pose.rootYaw * w, pose.rootRoll * w);
  }
  if (w <= 0) return;
  writeJoint(sk.hips, pose.hips, w);
  writeJoint(sk.spine, pose.torso, w);
  writeJoint(sk.torso, pose.torso, w);
  writeJoint(sk.head, pose.head, w);
  writeJoint(sk.armL.upper, pose.armL.upper, w);
  writeJoint(sk.armL.lower, pose.armL.lower, w);
  writeJoint(sk.armR.upper, pose.armR.upper, w);
  writeJoint(sk.armR.lower, pose.armR.lower, w);
  writeJoint(sk.legL.upper, pose.legL.upper, w);
  writeJoint(sk.legL.lower, pose.legL.lower, w);
  writeJoint(sk.legL.tip, pose.legL.tip, w);
  writeJoint(sk.legR.upper, pose.legR.upper, w);
  writeJoint(sk.legR.lower, pose.legR.lower, w);
  writeJoint(sk.legR.tip, pose.legR.tip, w);
}

/** Put the root back where it was found. Bones are left to the mixer/gait. */
export function releaseDanceSkeleton(sk: DanceSkeleton) {
  if (!sk.root) return;
  sk.root.position.y = sk.rootBaseY;
  sk.root.rotation.set(0, 0, 0);
}

// ---------------------------------------------------------------------------
// GLB rigs
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-|:]/g, "");

/** First bone whose normalised name matches a pattern, tried in priority order. */
function pick(bones: Map<string, THREE.Object3D>, patterns: RegExp[]): THREE.Object3D | null {
  for (const re of patterns) {
    for (const [name, obj] of bones) {
      if (re.test(name)) return obj;
    }
  }
  return null;
}

/**
 * Bind a GLB character for dancing.
 *
 * Every skeleton in this repo — the 56 Quaternius characters, the alien, and
 * Vibey — uses the same Blender naming (`Hips`, `Abdomen`, `Torso`, `Head`,
 * `UpperArm.L`, `LowerArm.L`, `UpperLeg.R`…), so the patterns below hit all of
 * them. The Mixamo and generic-humanoid spellings are in there too, because
 * the next character somebody drops in probably will not be a Quaternius one,
 * and a rig that binds nothing still gets the root bounce rather than standing
 * dead still.
 *
 * `root` is the object that carries whole-body motion — the fitted model
 * itself, whose position/rotation nothing else in the city writes.
 */
export function bindGltfDanceSkeleton(root: THREE.Object3D): DanceSkeleton {
  root.updateWorldMatrix(true, true);
  const rootInv = root.getWorldQuaternion(_worldQ).clone().invert();

  // Bones only: Quaternius exports name meshes after the bone they cover
  // ("Torso" is both a bone and a mesh), and posing the mesh does nothing.
  const bones = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const n = norm(o.name);
    if (n.endsWith("end")) return; // leaf tips carry no geometry
    if (!bones.has(n)) bones.set(n, o);
  });

  const L = (base: string) => new RegExp(`^${base}(l|left)$|^left${base}$`);
  const R = (base: string) => new RegExp(`^${base}(r|right)$|^right${base}$`);

  const shinL = pick(bones, [L("lowerleg"), L("shin"), L("calf")]);
  const shinR = pick(bones, [R("lowerleg"), R("shin"), R("calf")]);

  /**
   * The ankle, but only when it is genuinely on the end of the leg.
   *
   * Quaternius rigs were authored with IK and exported as-is: `Foot.L` is a
   * SIBLING of the leg chain, hanging off the armature root as the old IK
   * target, not a child of `LowerLeg.L`. On that topology the foot does not
   * inherit the knee's rotation, so the ankle-levelling term would be
   * correcting a pitch the foot never picked up — and would swing the foot out
   * from under the character instead of keeping it flat. The parentage test is
   * the whole check: level the ankle where the ankle actually follows the shin.
   */
  function ankleUnder(shin: THREE.Object3D | null, foot: THREE.Object3D | null) {
    if (!shin || !foot) return null;
    for (let p = foot.parent; p; p = p.parent) if (p === shin) return foot;
    return null;
  }

  const sk: DanceSkeleton = {
    root,
    rootBaseY: root.position.y,
    hips: bindJoint(pick(bones, [/^hips$/, /^pelvis$/, /hips/, /pelvis/]), rootInv),
    // The lower spine takes a share of the torso's rotation, which is what
    // turns a rigid twist at one joint into a bend through a back.
    spine: bindJoint(pick(bones, [/^abdomen$/, /^spine$/, /^spine1$/]), rootInv, 0.45),
    torso: bindJoint(pick(bones, [/^torso$/, /^chest$/, /^spine2$/, /^upperchest$/, /^spine$/]), rootInv),
    head: bindJoint(pick(bones, [/^head$/, /^neck$/, /head/]), rootInv),
    armL: {
      upper: bindJoint(pick(bones, [L("upperarm"), L("arm"), L("shoulder")]), rootInv),
      lower: bindJoint(pick(bones, [L("lowerarm"), L("forearm")]), rootInv),
    },
    armR: {
      upper: bindJoint(pick(bones, [R("upperarm"), R("arm"), R("shoulder")]), rootInv),
      lower: bindJoint(pick(bones, [R("lowerarm"), R("forearm")]), rootInv),
    },
    legL: {
      upper: bindJoint(shinL?.parent ?? pick(bones, [L("upperleg"), L("thigh")]), rootInv),
      lower: bindJoint(shinL, rootInv),
      tip: bindJoint(ankleUnder(shinL, pick(bones, [L("foot"), L("ankle")])), rootInv),
    },
    legR: {
      upper: bindJoint(shinR?.parent ?? pick(bones, [R("upperleg"), R("thigh")]), rootInv),
      lower: bindJoint(shinR, rootInv),
      tip: bindJoint(ankleUnder(shinR, pick(bones, [R("foot"), R("ankle")])), rootInv),
    },
    bound: 0,
  };
  sk.bound = [
    sk.hips, sk.spine, sk.torso, sk.head,
    sk.armL.upper, sk.armL.lower, sk.armR.upper, sk.armR.lower,
    sk.legL.upper, sk.legL.lower, sk.legR.upper, sk.legR.lower,
  ].filter(Boolean).length;
  return sk;
}

/**
 * Bind a rig that is already built in character space — the procedural pilot,
 * whose joints are plain Groups with no bind rotation. `Wp` and `rest` are both
 * identity here, so this is the same code path with the algebra collapsed.
 */
export function bindDirectDanceSkeleton(parts: {
  root: THREE.Object3D | null;
  /**
   * Rest rotation per joint, for the joints that have one.
   *
   * Most of this rig's joints are built at zero and its solver writes absolute
   * angles onto them, so their neutral IS identity and they can be left out.
   * Some are not: a digitigrade leg is *constructed* folded (thigh forward
   * 0.62, knee back 1.24) and the gait writes around those numbers. Treating
   * those as identity would straighten a kangaroo's legs the moment it danced.
   *
   * This has to be a snapshot taken at construction, not read off the live
   * joint — the skeleton binds on the first frame anybody dances, by which
   * time the solver has been writing gait poses onto these joints for minutes.
   */
  rest?: Map<THREE.Object3D, THREE.Quaternion>;
  hips?: THREE.Object3D | null;
  torso?: THREE.Object3D | null;
  head?: THREE.Object3D | null;
  armL?: { upper?: THREE.Object3D | null; lower?: THREE.Object3D | null };
  armR?: { upper?: THREE.Object3D | null; lower?: THREE.Object3D | null };
  legL?: { upper?: THREE.Object3D | null; lower?: THREE.Object3D | null; tip?: THREE.Object3D | null };
  legR?: { upper?: THREE.Object3D | null; lower?: THREE.Object3D | null; tip?: THREE.Object3D | null };
}): DanceSkeleton {
  const I = new THREE.Quaternion();
  /**
   * Rest comes from the snapshot, defaulting to IDENTITY — never from
   * `obj.quaternion`, which by bind time is a mid-stride gait pose.
   */
  const direct = (obj: THREE.Object3D | null | undefined, gain = 1): DanceJoint | null =>
    obj
      ? { obj, rest: (parts.rest?.get(obj) ?? I).clone(), wp: I.clone(), wpInv: I.clone(), gain }
      : null;
  const sk: DanceSkeleton = {
    root: parts.root ?? null,
    rootBaseY: parts.root?.position.y ?? 0,
    hips: direct(parts.hips),
    spine: null,
    torso: direct(parts.torso),
    head: direct(parts.head),
    armL: { upper: direct(parts.armL?.upper), lower: direct(parts.armL?.lower) },
    armR: { upper: direct(parts.armR?.upper), lower: direct(parts.armR?.lower) },
    legL: {
      upper: direct(parts.legL?.upper),
      lower: direct(parts.legL?.lower),
      tip: direct(parts.legL?.tip),
    },
    legR: {
      upper: direct(parts.legR?.upper),
      lower: direct(parts.legR?.lower),
      tip: direct(parts.legR?.tip),
    },
    bound: 0,
  };
  sk.bound = [
    sk.hips, sk.torso, sk.head,
    sk.armL.upper, sk.armL.lower, sk.armR.upper, sk.armR.lower,
    sk.legL.upper, sk.legL.lower, sk.legR.upper, sk.legR.lower,
  ].filter(Boolean).length;
  return sk;
}

/**
 * Fade a dance in and out.
 *
 * Kept here rather than at each call site because three different things — the
 * local player, a GLB peer and a procedural peer — all need exactly the same
 * quarter-second ramp, and a peer whose fade-out ran at a different rate reads
 * as a stutter when a crowd stops dancing together.
 */
export const DANCE_FADE = 0.22;

export function stepDanceWeight(weight: number, dancing: boolean, dt: number): number {
  const target = dancing ? 1 : 0;
  const step = dt / DANCE_FADE;
  if (weight < target) return Math.min(target, weight + step);
  if (weight > target) return Math.max(target, weight - step);
  return weight;
}
