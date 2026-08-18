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
/**
 * The pose vocabulary, shared with anything else that drives this rig.
 *
 * Angles are world-axis and get converted into each joint's bind frame by
 * `writeJoint`, so a caller only has to think in "swing the arm forward, raise
 * it out to the side, fold the elbow" — which is why swimming is written
 * against these too rather than reaching for bones directly.
 */
export function setArm(
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
export function setLeg(
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

/**
 * The city's tempo. Everything danced, and everything played, is this number.
 *
 * It used to be per-dance — the floss at 128, the robot at 104, the hype jump
 * at 136 — which was fine while dancing was silent and impossible the moment
 * it was not: no single track can be under nine dances at nine tempos. So the
 * house tempo moved here and each dance kept only a *multiplier* on it (see
 * `beat` below), which is how a DJ would have described it in the first place.
 */
export const CITY_BPM = 120;

export interface DanceDef {
  id: string;
  label: string;
  emoji: string;
  /** One-liner for the wheel. */
  blurb: string;
  /**
   * Subdivision, as a multiple of the house tempo. 1 is on the beat, 2 is
   * double time, 0.5 is half time.
   *
   * Because every move's period is a whole number of its own beats, and its
   * own beats are a whole multiple of the city's, every dance lands on the bar
   * — the sprinkler's slow sweep and the running man's sprint are the same
   * music at different subdivisions, which is what dancing to one track
   * actually is.
   */
  beat: number;
  /**
   * Seconds of follow-through, overriding `DANCE_LAG`.
   *
   * Almost nothing should set this. The robot must: its entire joke is that
   * the joints arrive instantly and hold, and 45ms of body lag turns a machine
   * back into a person doing an impression of one.
   */
  lag?: number;
  pose: (b: number, out: DancePose) => void;
}

/** Effective tempo of a move, for anything that wants to say it out loud. */
export const danceBpm = (def: DanceDef) => CITY_BPM * def.beat;

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
    beat: 1,
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
    beat: 0.5,
    // Zero, not merely small: a small lag is still a lag, and one 60fps frame
    // of even 8ms leaves the joint an eighth of the way short — which reads as
    // a robot with a loose bolt rather than as a robot.
    lag: 0,
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
    beat: 1,
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
    beat: 1,
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
    beat: 2,
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
    beat: 0.5,
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
    beat: 1,
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
    beat: 2,
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
    beat: 1,
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
  return (nowMs / 1000) * (danceBpm(def) / 60);
}

/**
 * Where the city's bar line is right now, in house beats since the epoch.
 *
 * The music reads this and so do the dances, which is the entire reason a
 * player who walks into a crowd is already on the beat rather than a
 * quarter-note behind it.
 */
export const cityBeats = (nowMs = Date.now()): number => (nowMs / 1000) * (CITY_BPM / 60);

/** Fill `out` with this dance's pose for the shared clock. */
export function evalDance(def: DanceDef, out: DancePose, nowMs = Date.now()): DancePose {
  resetDancePose(out);
  def.pose(danceBeats(def, nowMs), out);
  return out;
}

// ---------------------------------------------------------------------------
// Groove — the difference between a crowd and a set of animatronics
// ---------------------------------------------------------------------------

/**
 * One dancer's personal feel for the beat.
 *
 * Everything above this line is perfectly quantised: give two characters the
 * same dance and the same clock and they are frame-identical forever, which is
 * exactly right for keeping a room in time and exactly wrong for making it
 * look like people. Real dancers sit a few milliseconds either side of the
 * beat and never the same few; they are bigger or smaller with the same move;
 * and none of it holds still, because a person who is *consistently* 20ms
 * ahead is just a quantised dancer with an offset.
 *
 * So a groove is three numbers and a seed, and the seed drives a slow wander
 * on the first two. Deterministic from the seed, so a given dancer is always
 * the same person — the regular who rushes is always the regular who rushes.
 */
export interface DanceGroove {
  /** Timing, in beats. Negative pushes ahead of the beat; positive lays back. */
  push: number;
  /** Amplitude multiplier on every joint angle. */
  amp: number;
  /** Multiplier on the vertical, separately — some people bounce more. */
  lift: number;
  /**
   * How much `push` and `amp` wander over time. 0 holds them exactly.
   *
   * Separate from `seed` so that `STRAIGHT` can be a true no-op. It was not,
   * at first: the wander was unconditional, so the "groove switched off"
   * control render still had a moving target in it and the comparison it
   * existed to make was worthless — the control and the subject differed by
   * less than the control differed from itself.
   */
  drift: number;
  /** Drives the wander, and is what makes a dancer *that* dancer. */
  seed: number;
}

/** Cheap deterministic hash → 0..1. */
const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * A repeatable personality from an integer.
 *
 * The ranges are small but not tiny. ±0.065 beats is about ±33ms at the city's
 * tempo, which is roughly the spread of a room of people who can all hear the
 * same kick — past that it stops reading as feel and starts reading as
 * somebody who cannot dance. The first pass used half these numbers, and
 * against a control render with the groove switched off it was almost
 * impossible to tell the two apart, which is the same as not having built it.
 */
export function makeGroove(seed: number): DanceGroove {
  return {
    push: (hash01(seed * 3 + 1) - 0.5) * 0.13,
    amp: 0.78 + hash01(seed * 7 + 2) * 0.44,
    lift: 0.72 + hash01(seed * 11 + 3) * 0.6,
    drift: 1,
    seed,
  };
}

/** The neutral groove: dead on the beat at full size. */
export const STRAIGHT: DanceGroove = { push: 0, amp: 1, lift: 1, drift: 0, seed: 0 };

/**
 * Where this dancer's timing and size actually are right now.
 *
 * Two sines on periods that do not divide into each other, so the wander never
 * resolves into a loop of its own — which would just be a slower animatronic.
 */
function grooveNow(g: DanceGroove, seconds: number) {
  if (g.drift === 0) return { push: g.push, amp: g.amp };
  const a = Math.sin(seconds * 0.37 + g.seed * 1.7);
  const b = Math.sin(seconds * 0.23 + g.seed * 4.1);
  return {
    push: g.push + a * 0.025 * g.drift,
    amp: g.amp * (1 + b * 0.07 * g.drift),
  };
}

const scaleVec = (v: Vec3, k: number) => {
  v.x *= k;
  v.y *= k;
  v.z *= k;
};

/**
 * Evaluate a dance the way a particular body would perform it.
 *
 * The timing offset is applied to the *clock*, not to the output, so a dancer
 * who lays back is genuinely late rather than playing a distorted version of
 * the move — which matters for anything with a snap in it.
 */
export function evalDanceGrooved(
  def: DanceDef,
  out: DancePose,
  groove: DanceGroove,
  nowMs = Date.now(),
): DancePose {
  const seconds = nowMs / 1000;
  const { push, amp } = grooveNow(groove, seconds);
  // `push` is in house beats; convert to milliseconds before shifting the clock.
  evalDance(def, out, nowMs + push * (60_000 / CITY_BPM));
  if (amp !== 1) {
    scaleVec(out.hips, amp);
    scaleVec(out.torso, amp);
    scaleVec(out.head, amp);
    for (const l of [out.armL, out.armR, out.legL, out.legR]) {
      scaleVec(l.upper, amp);
      scaleVec(l.lower, amp);
      scaleVec(l.tip, amp);
    }
    out.rootYaw *= amp;
    out.rootPitch *= amp;
    out.rootRoll *= amp;
  }
  out.rootY *= groove.lift;
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
  /**
   * Where this joint actually is, as opposed to where the pose says it should
   * be. Chased toward the target rather than snapped to it — see `writeJoint`.
   */
  cur: THREE.Quaternion;
  /**
   * How much this joint trails, relative to the dance's base lag.
   *
   * Bodies are not rigid: the hips lead, the spine follows, and the hands
   * arrive last, because each joint is dragging the mass of everything below
   * it. Scaling the lag by distance from the root is the cheapest thing that
   * reproduces that, and it is the single change that most stopped these
   * reading as puppets — before it, a hand and a pelvis changed direction on
   * exactly the same frame, which nothing with bones in it does.
   */
  lagScale: number;
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
function bindJoint(
  obj: THREE.Object3D | null,
  rootInv: THREE.Quaternion,
  gain = 1,
  lagScale = 1,
): DanceJoint | null {
  if (!obj) return null;
  const wp = new THREE.Quaternion();
  if (obj.parent) obj.parent.getWorldQuaternion(wp);
  wp.premultiply(rootInv);
  const rest = obj.quaternion.clone();
  return {
    obj,
    rest,
    wp,
    wpInv: wp.clone().invert(),
    gain,
    cur: rest.clone(),
    lagScale,
  };
}

function writeJoint(j: DanceJoint | null, v: Vec3, weight: number, dt: number, lag: number) {
  if (!j || weight <= 0) return;
  const g = j.gain;
  _euler.set(v.x * g, v.y * g, v.z * g, "ZYX");
  _q.setFromEuler(_euler);
  _target.copy(j.wpInv).multiply(_q).multiply(j.wp).multiply(j.rest);

  const tau = lag * j.lagScale;
  if (dt > 0 && tau > 1e-4) {
    // Exponential chase, framerate-independent: at 30fps and at 144fps the
    // hand is the same distance behind the beat. A plain `slerp(k)` with a
    // constant k is neither, and would make the follow-through a property of
    // the machine rather than of the body.
    j.cur.slerp(_target, 1 - Math.exp(-dt / tau));
  } else {
    j.cur.copy(_target);
  }
  // Slerp rather than copy so the dance blends out of (and back into) whatever
  // the mixer or the gait solver last wrote onto this bone.
  j.obj.quaternion.slerp(j.cur, weight);
}

/**
 * Push a pose onto a skeleton at `weight` (0 = leave it alone, 1 = full dance).
 * Safe to call every frame, and safe to call with weight 0 while fading out.
 */
/**
 * How far behind the pose a body runs, in seconds, at `lagScale` 1.
 *
 * Small — 45ms is under three frames — because this is follow-through, not
 * sloppiness. Past about 90ms a dancer stops looking loose and starts looking
 * like they are hearing the music through a wall.
 */
export const DANCE_LAG = 0.045;

export function applyDancePose(
  sk: DanceSkeleton,
  pose: DancePose,
  weight: number,
  dt = 0,
  lag = DANCE_LAG,
) {
  const w = weight <= 0 ? 0 : weight > 1 ? 1 : weight;
  if (sk.root) {
    sk.root.position.y = sk.rootBaseY + pose.rootY * w;
    sk.root.rotation.set(pose.rootPitch * w, pose.rootYaw * w, pose.rootRoll * w);
  }
  if (w <= 0) return;
  writeJoint(sk.hips, pose.hips, w, dt, lag);
  writeJoint(sk.spine, pose.torso, w, dt, lag);
  writeJoint(sk.torso, pose.torso, w, dt, lag);
  writeJoint(sk.head, pose.head, w, dt, lag);
  writeJoint(sk.armL.upper, pose.armL.upper, w, dt, lag);
  writeJoint(sk.armL.lower, pose.armL.lower, w, dt, lag);
  writeJoint(sk.armR.upper, pose.armR.upper, w, dt, lag);
  writeJoint(sk.armR.lower, pose.armR.lower, w, dt, lag);
  writeJoint(sk.legL.upper, pose.legL.upper, w, dt, lag);
  writeJoint(sk.legL.lower, pose.legL.lower, w, dt, lag);
  writeJoint(sk.legL.tip, pose.legL.tip, w, dt, lag);
  writeJoint(sk.legR.upper, pose.legR.upper, w, dt, lag);
  writeJoint(sk.legR.lower, pose.legR.lower, w, dt, lag);
  writeJoint(sk.legR.tip, pose.legR.tip, w, dt, lag);
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
    hips: bindJoint(pick(bones, [/^hips$/, /^pelvis$/, /hips/, /pelvis/]), rootInv, 1, 0.35),
    // The lower spine takes a share of the torso's rotation, which is what
    // turns a rigid twist at one joint into a bend through a back.
    spine: bindJoint(pick(bones, [/^abdomen$/, /^spine$/, /^spine1$/]), rootInv, 0.45, 0.6),
    torso: bindJoint(pick(bones, [/^torso$/, /^chest$/, /^spine2$/, /^upperchest$/, /^spine$/]), rootInv, 1, 0.75),
    head: bindJoint(pick(bones, [/^head$/, /^neck$/, /head/]), rootInv, 1, 1.25),
    armL: {
      upper: bindJoint(pick(bones, [L("upperarm"), L("arm"), L("shoulder")]), rootInv, 1, 1),
      lower: bindJoint(pick(bones, [L("lowerarm"), L("forearm")]), rootInv, 1, 1.6),
    },
    armR: {
      upper: bindJoint(pick(bones, [R("upperarm"), R("arm"), R("shoulder")]), rootInv, 1, 1),
      lower: bindJoint(pick(bones, [R("lowerarm"), R("forearm")]), rootInv, 1, 1.6),
    },
    legL: {
      upper: bindJoint(shinL?.parent ?? pick(bones, [L("upperleg"), L("thigh")]), rootInv, 1, 0.7),
      lower: bindJoint(shinL, rootInv, 1, 1.1),
      tip: bindJoint(ankleUnder(shinL, pick(bones, [L("foot"), L("ankle")])), rootInv, 1, 1.4),
    },
    legR: {
      upper: bindJoint(shinR?.parent ?? pick(bones, [R("upperleg"), R("thigh")]), rootInv, 1, 0.7),
      lower: bindJoint(shinR, rootInv, 1, 1.1),
      tip: bindJoint(ankleUnder(shinR, pick(bones, [R("foot"), R("ankle")])), rootInv, 1, 1.4),
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
  const direct = (
    obj: THREE.Object3D | null | undefined,
    gain = 1,
    lagScale = 1,
  ): DanceJoint | null => {
    if (!obj) return null;
    const rest = (parts.rest?.get(obj) ?? I).clone();
    return { obj, rest, wp: I.clone(), wpInv: I.clone(), gain, cur: rest.clone(), lagScale };
  };
  const sk: DanceSkeleton = {
    root: parts.root ?? null,
    rootBaseY: parts.root?.position.y ?? 0,
    hips: direct(parts.hips, 1, 0.35),
    spine: null,
    torso: direct(parts.torso, 1, 0.75),
    head: direct(parts.head, 1, 1.25),
    armL: { upper: direct(parts.armL?.upper, 1, 1), lower: direct(parts.armL?.lower, 1, 1.6) },
    armR: { upper: direct(parts.armR?.upper, 1, 1), lower: direct(parts.armR?.lower, 1, 1.6) },
    legL: {
      upper: direct(parts.legL?.upper, 1, 0.7),
      lower: direct(parts.legL?.lower, 1, 1.1),
      tip: direct(parts.legL?.tip, 1, 1.4),
    },
    legR: {
      upper: direct(parts.legR?.upper, 1, 0.7),
      lower: direct(parts.legR?.lower, 1, 1.1),
      tip: direct(parts.legR?.tip, 1, 1.4),
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
