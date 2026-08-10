/**
 * Emotes for the shop stage.
 *
 * The preview used to drive every character at 3.8 m/s with a weaving yaw — a
 * permanent jog on the spot. It was there to show off the gait solver, and it
 * does, but it is the wrong thing to look at when you are deciding whether to
 * spend 600 coins on a face: the head is bobbing, the arms are swinging, and
 * the whole silhouette is in motion before you have had a chance to read it.
 *
 * So the stage has poses now, and it opens on a still one.
 *
 * Every pose here is expressed in the rig's own language — the five numbers of
 * `PilotFrame` — rather than as new animation code. That is the whole bet the
 * procedural pilot makes: motion is a function of what the character is doing,
 * so "hover" is not a clip to author, it is `thrusting: true`. Nothing in this
 * file knows about a skeleton, and a new pose is a table entry.
 */
import type { PilotFrame } from "@/components/city/proceduralPilot";

export type PoseId = "idle" | "strut" | "dash" | "hover" | "leap" | "spin";

export interface Pose {
  id: PoseId;
  label: string;
  emoji: string;
  /** Turntable speed, rad/s. Zero means the character faces you. */
  spin: number;
  /** `t` is seconds since the pose was chosen. */
  frame(t: number): PilotFrame;
}

const still: PilotFrame = {
  speed: 0,
  grounded: true,
  verticalVel: 0,
  yawRate: 0,
  thrusting: false,
};

export const POSES: Pose[] = [
  {
    id: "idle",
    label: "Idle",
    emoji: "🧍",
    /* A slow turn rather than a locked front view. The rig's whole argument is
       silhouette, and half of these characters keep theirs on their back — a
       cape, a tail, a pair of wings. Fifteen seconds a revolution is slow
       enough to read a face and quick enough that you see the back of the
       character without deciding to. */
    spin: 0.42,
    frame: () => still,
  },
  {
    id: "strut",
    label: "Strut",
    emoji: "🚶",
    spin: 0,
    /* 1.5 m/s is a walk. The old preview ran at 3.8, which the solver turns
       into a jog: stride length grows with speed, so the difference between
       these two numbers is the difference between showing somebody a
       character and showing them a treadmill. */
    frame: () => ({ ...still, speed: 1.5 }),
  },
  {
    id: "dash",
    label: "Dash",
    emoji: "💨",
    spin: 0,
    /* Fast, and weaving, which is the one pose that shows the bank into turns
       and the cape or tail whipping through them. Kept as an option rather
       than the default: it is a good ten seconds and a bad ten minutes. */
    frame: (t) => ({ ...still, speed: 7, yawRate: Math.sin(t * 1.1) * 1.5 }),
  },
  {
    id: "hover",
    label: "Hover",
    emoji: "🚀",
    spin: 0.3,
    /* Jetpack held down. Aurora's and Emberwing's wings only open off the
       ground, so this is the only pose that shows what they bought. */
    frame: () => ({ ...still, grounded: false, verticalVel: 0.4, thrusting: true }),
  },
  {
    id: "leap",
    label: "Leap",
    emoji: "🤸",
    spin: 0,
    /* A real jump arc on a loop — up, over, down, land — so the squash on
       touchdown fires. `verticalVel` drives both the airborne pose and how
       hard the landing reads, and the rig scales the squash by impact, so a
       constant fake value would land the same way every time and look like a
       loop. This one does not. */
    frame: (t) => {
      const period = 1.6;
      const phase = (t % period) / period;
      const v = Math.cos(phase * Math.PI * 2) * 5.5;
      // Airborne for the middle of the cycle; the last beat is the landing.
      const airborne = phase < 0.82;
      return { ...still, grounded: !airborne, verticalVel: airborne ? v : -4.5, speed: 0.6 };
    },
  },
  {
    id: "spin",
    label: "Show off",
    emoji: "🌀",
    /* Fast turntable over a slow walk. The one that sells a cape. */
    spin: 1.5,
    frame: () => ({ ...still, speed: 1.1 }),
  },
];

export const poseById = (id: PoseId): Pose => POSES.find((p) => p.id === id) ?? POSES[0];

/** What the stage opens on. Still, front-on, turning slowly. */
export const DEFAULT_POSE: PoseId = "idle";
