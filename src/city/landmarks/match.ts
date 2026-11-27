/**
 * The Vibe Commons Cup: a real three-a-side match on the park's pitch.
 *
 * Press E by the scoreboard and two little teams run out: Vibe Commons FC
 * (teal, attacking the east goal, which is you, a keeper and one outfield
 * teammate) against Harbour Rovers (orange, a keeper and two outfielders).
 * Two minutes on the clock, kick-off after every goal, a final whistle.
 *
 * Everything works on the park's own ball (`MatchBall`, pitch space), so the
 * physics, the posts, the nets and the goal line stay in park.ts and this
 * file only decides what the people on the pitch do:
 *
 *  - The outfield player of each team nearest the ball goes to it, coming
 *    round behind it so the touch sends it the right way, and then dribbles,
 *    passes or shoots depending on how far out it is and who is open.
 *  - Everybody else on the team takes a supporting spot: ahead of the ball
 *    when the team has it, between the ball and goal when it does not.
 *  - Keepers shadow the ball across the goal mouth, read where a shot will
 *    cross the line, and either save it or are beaten, with a chance that
 *    depends on how hard it was hit. A save that always happens is a wall.
 *
 * The human is never moved by this file except at kick-off (the `place` the
 * update returns), and is never pushed: AI bodies step round you.
 */
import * as THREE from "three";

export interface MatchBall {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface MatchDims {
  PL: number;
  PW: number;
  GOAL_W: number;
  BALL_R: number;
}

export type Side = "home" | "away";

export interface MatchHuman {
  /** Pitch space. */
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Able to play (on foot, on the pitch's level). */
  present: boolean;
}

export interface MatchEvent {
  kind: "kickoff" | "goal" | "full-time" | "abandoned" | "save" | "half";
  title: string;
  description?: string;
}

export interface MatchUi {
  home: number;
  away: number;
  clock: string;
  homeName: string;
  awayName: string;
  phase: Phase;
}

type Phase = "kickoff" | "play" | "goal" | "over";

export const HOME_NAME = "Vibe Commons FC";
export const AWAY_NAME = "Harbour Rovers";
/** Match length, seconds of game clock. */
export const MATCH_SECONDS = 120;

interface Body {
  side: Side;
  keeper: boolean;
  name: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  cool: number;
  stride: number;
  /** Where the formation puts them at kick-off. */
  hx: number;
  hz: number;
  /** A keeper's dive, seconds left. */
  dive: number;
  diveDir: number;
  obj: Figure;
}

interface Figure {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
}

const FIELD_SPEED = 6.4;
const CHASE_SPEED = 7.1;
const KEEPER_SPEED = 4.2;
const TOUCH_R = 0.62;
/** Speed a human dribble may run at during a match (m/s); see speedCap. */
export const MATCH_RUN_CAP = 8.2;

export function buildMatch(opts: {
  parent: THREE.Object3D;
  dims: MatchDims;
  keep: <T extends { dispose(): void }>(t: T) => T;
  rand?: () => number;
}) {
  const { PL, PW, GOAL_W, BALL_R } = opts.dims;
  const keep = opts.keep;
  const rand = opts.rand ?? Math.random;
  const HX = PL / 2;
  const HZ = PW / 2;

  // ---- Figures ----------------------------------------------------------------
  const skinTones = ["#f1c7a5", "#d9a27c", "#a86f4c", "#7b4a2e", "#ffd9b8", "#c68a62"].map((c) => keep(new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })));
  const kit = (shirt: string, shorts: string, socks: string) => ({
    shirt: keep(new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.6 })),
    shorts: keep(new THREE.MeshStandardMaterial({ color: shorts, roughness: 0.7 })),
    socks: keep(new THREE.MeshStandardMaterial({ color: socks, roughness: 0.7 })),
  });
  const kits = {
    home: kit("#22c7a0", "#0f3d36", "#e9fffa"),
    away: kit("#ff7a2e", "#ffffff", "#ff7a2e"),
    homeKeeper: kit("#ffd23f", "#1d1d1d", "#ffd23f"),
    awayKeeper: kit("#9b6bff", "#1d1d1d", "#9b6bff"),
  };
  const hairMat = keep(new THREE.MeshStandardMaterial({ color: "#2b1d14", roughness: 0.9 }));
  const bootMat = keep(new THREE.MeshStandardMaterial({ color: "#151515", roughness: 0.5 }));
  const torsoGeo = keep(new THREE.BoxGeometry(0.46, 0.56, 0.26));
  const hipGeo = keep(new THREE.BoxGeometry(0.44, 0.22, 0.26));
  const legGeo = keep(new THREE.BoxGeometry(0.15, 0.5, 0.16));
  legGeo.translate(0, -0.25, 0);
  const sockGeo = keep(new THREE.BoxGeometry(0.13, 0.3, 0.14));
  sockGeo.translate(0, -0.6, 0);
  const bootGeo = keep(new THREE.BoxGeometry(0.14, 0.09, 0.26));
  bootGeo.translate(0, -0.78, 0.05);
  const armGeo = keep(new THREE.BoxGeometry(0.11, 0.5, 0.12));
  armGeo.translate(0, -0.24, 0);
  const headGeo = keep(new THREE.SphereGeometry(0.15, 12, 10));
  const hairGeo = keep(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2));
  const numberTex = (n: number, ink: string) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d")!;
    x.fillStyle = ink;
    x.font = "900 46px ui-sans-serif, system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(String(n), 32, 35);
    const t = keep(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const numGeo = keep(new THREE.PlaneGeometry(0.3, 0.3));

  const figure = (k: ReturnType<typeof kit>, skin: THREE.Material, num: number, ink: string): Figure => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const torso = new THREE.Mesh(torsoGeo, k.shirt);
    torso.position.y = 1.18;
    const hip = new THREE.Mesh(hipGeo, k.shorts);
    hip.position.y = 0.84;
    const head = new THREE.Mesh(headGeo, skin);
    head.position.y = 1.62;
    const hair = new THREE.Mesh(hairGeo, hairMat);
    hair.position.y = 1.64;
    const back = new THREE.Mesh(numGeo, keep(new THREE.MeshBasicMaterial({ map: numberTex(num, ink), transparent: true })));
    back.position.set(0, 1.2, -0.135);
    back.rotation.y = Math.PI;
    body.add(torso, hip, head, hair, back);
    const limb = (x: number, y: number, geo: THREE.BufferGeometry, mat: THREE.Material, extra?: Array<[THREE.BufferGeometry, THREE.Material]>) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      pivot.add(m);
      for (const [g, mm] of extra ?? []) pivot.add(new THREE.Mesh(g, mm));
      body.add(pivot);
      return pivot;
    };
    const legL = limb(-0.11, 0.78, legGeo, skin, [
      [sockGeo, k.socks],
      [bootGeo, bootMat],
    ]);
    const legR = limb(0.11, 0.78, legGeo, skin, [
      [sockGeo, k.socks],
      [bootGeo, bootMat],
    ]);
    const armL = limb(-0.3, 1.42, armGeo, k.shirt);
    const armR = limb(0.3, 1.42, armGeo, k.shirt);
    torso.castShadow = hip.castShadow = head.castShadow = true;
    root.visible = false;
    opts.parent.add(root);
    return { root, body, legL, legR, armL, armR };
  };

  // Home attacks +x and defends the -x goal.
  const goalX = (attacking: Side) => (attacking === "home" ? HX : -HX);
  const ownGoalX = (s: Side) => (s === "home" ? -HX : HX);
  const bodies: Body[] = [];
  const add = (side: Side, keeper: boolean, name: string, num: number, hx: number, hz: number) => {
    const k = keeper ? (side === "home" ? kits.homeKeeper : kits.awayKeeper) : side === "home" ? kits.home : kits.away;
    const ink = side === "away" && !keeper ? "#ffffff" : "#10221e";
    bodies.push({
      side,
      keeper,
      name,
      x: hx,
      z: hz,
      vx: 0,
      vz: 0,
      yaw: 0,
      cool: 0,
      stride: rand() * 6,
      hx,
      hz,
      dive: 0,
      diveDir: 0,
      obj: figure(k, skinTones[bodies.length % skinTones.length], num, ink),
    });
  };
  add("home", true, "Gloves", 1, -HX + 0.7, 0);
  add("home", false, "Pip", 8, -4.5, 3.6);
  add("away", true, "Big Sal", 1, HX - 0.7, 0);
  add("away", false, "Dizzy", 9, 3.2, -2.6);
  add("away", false, "Marlo", 7, 4.8, 3.2);
  const HUMAN_SPOT = { x: -2.4, z: -1.6 };

  // ---- State ----------------------------------------------------------------------
  let phase: Phase | null = null;
  let clock = 0;
  let phaseT = 0;
  let score: [number, number] = [0, 0];
  let last: Side = "home";
  /** Nobody but the human may touch the ball for this long (a fresh first touch). */
  let humanTouch = 0;
  let farFor = 0;
  let kickoffTeam: Side = "home";

  const clockText = () => {
    const left = Math.max(0, Math.ceil(MATCH_SECONDS - clock));
    const m = Math.floor(left / 60);
    const s = left % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const resetFormation = (ball: MatchBall) => {
    for (const b of bodies) {
      b.x = b.hx;
      b.z = b.hz;
      b.vx = b.vz = 0;
      b.cool = 0.4;
      b.dive = 0;
      // The team kicking off may stand at the ball; the other waits outside the circle.
      if (!b.keeper && b.side === kickoffTeam && b.side === "away" && b.name === "Dizzy") {
        b.x = 0.8;
        b.z = 0.2;
      }
      b.yaw = b.side === "home" ? Math.PI / 2 : -Math.PI / 2;
      b.obj.root.visible = true;
    }
    Object.assign(ball, { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0 });
  };

  /** Kick toward a point, with a little error that grows with distance. */
  const kickTo = (ball: MatchBall, tx: number, tz: number, speed: number, loft: number, err = 0) => {
    const dx = tx - ball.x;
    const dz = tz - ball.z;
    const l = Math.hypot(dx, dz) || 1;
    const a = Math.atan2(dz, dx) + (rand() - 0.5) * err;
    ball.vx = Math.cos(a) * speed;
    ball.vz = Math.sin(a) * speed;
    ball.vy = loft;
    void l;
  };

  /** Where a ball moving toward `x = gx` will cross it, or null if it will not. */
  const crossing = (ball: MatchBall, gx: number) => {
    const dx = gx - ball.x;
    if (Math.abs(ball.vx) < 0.5 || Math.sign(ball.vx) !== Math.sign(dx)) return null;
    const t = dx / ball.vx;
    return { z: ball.z + ball.vz * t, t };
  };

  const teamHasBall = (side: Side, ball: MatchBall, human: MatchHuman) => {
    // Whoever is nearest the ball, roughly.
    let best = Infinity;
    let owner: Side | null = null;
    for (const b of bodies) {
      const d = Math.hypot(b.x - ball.x, b.z - ball.z);
      if (d < best) {
        best = d;
        owner = b.side;
      }
    }
    if (human.present) {
      const d = Math.hypot(human.x - ball.x, human.z - ball.z);
      if (d < best) {
        best = d;
        owner = "home";
      }
    }
    return best < 2.2 && owner === side;
  };

  const step = (b: Body, tx: number, tz: number, speed: number, dt: number) => {
    const dx = tx - b.x;
    const dz = tz - b.z;
    const d = Math.hypot(dx, dz);
    const want = d > 0.05 ? Math.min(speed, d * 4) : 0;
    const wx = d > 0.05 ? (dx / d) * want : 0;
    const wz = d > 0.05 ? (dz / d) * want : 0;
    const k = Math.min(1, dt * 7);
    b.vx += (wx - b.vx) * k;
    b.vz += (wz - b.vz) * k;
  };

  const AI_STEP = (ball: MatchBall, human: MatchHuman, dt: number, events: MatchEvent[]) => {
    const frozen = phase !== "play";
    for (const side of ["home", "away"] as Side[]) {
      const field = bodies.filter((b) => b.side === side && !b.keeper);
      // Who goes to the ball: the nearest of this team's outfielders, the
      // human included for home. A body already chasing keeps it for a metre.
      let chaser: Body | "human" | null = null;
      let best = Infinity;
      for (const b of field) {
        const d = Math.hypot(b.x - ball.x, b.z - ball.z) - (b.cool < 0 ? 0 : 0);
        if (d < best) {
          best = d;
          chaser = b;
        }
      }
      if (side === "home" && human.present) {
        const d = Math.hypot(human.x - ball.x, human.z - ball.z);
        if (d < best + 1.5) chaser = "human";
      }
      const ours = teamHasBall(side, ball, human);
      const atk = goalX(side);
      const dir = Math.sign(atk);
      for (const b of field) {
        b.cool -= dt;
        if (frozen) {
          step(b, b.x, b.z, 0, dt);
          continue;
        }
        if (b === chaser) {
          // Approach from behind the ball, relative to the goal it is going at.
          const gx = atk - ball.x;
          const gz = -ball.z * 0.6;
          const gl = Math.hypot(gx, gz) || 1;
          const behindX = ball.x - (gx / gl) * 0.42;
          const behindZ = ball.z - (gz / gl) * 0.42;
          const along = ((b.x - ball.x) * gx + (b.z - ball.z) * gz) / gl;
          // On the wrong side: swing round wide first.
          const tz = along > -0.1 ? behindZ + (b.z > ball.z ? 0.9 : -0.9) : behindZ;
          const lead = Math.min(0.35, Math.hypot(ball.vx, ball.vz) * 0.06);
          step(b, behindX + ball.vx * lead, tz + ball.vz * lead, CHASE_SPEED, dt);
        } else {
          // Support: ahead of the ball and wide when we have it, goal-side when we do not.
          let tx: number;
          let tz: number;
          if (ours) {
            tx = THREE.MathUtils.clamp(ball.x + dir * 5, -HX + 2, HX - 2);
            tz = ball.z > 0 ? -HZ * 0.45 : HZ * 0.45;
          } else {
            const own = ownGoalX(side);
            tx = THREE.MathUtils.clamp(ball.x + (own - ball.x) * 0.45, -HX + 1.5, HX - 1.5);
            tz = ball.z * 0.55 + (field.indexOf(b) ? 1.2 : -1.2);
          }
          step(b, tx, tz, FIELD_SPEED * 0.8, dt);
        }
        // The touch.
        const d = Math.hypot(b.x - ball.x, b.z - ball.z);
        if (b.cool <= 0 && humanTouch <= 0 && d < TOUCH_R && ball.y < 0.9) {
          b.cool = 0.45;
          last = side;
          const toGoal = Math.abs(atk - ball.x);
          const mates = (side === "home" && human.present ? [{ x: human.x, z: human.z }] : []).concat(field.filter((o) => o !== b).map((o) => ({ x: o.x, z: o.z })));
          const ahead = mates.filter((m) => (m.x - ball.x) * dir > 1.5);
          const press = bodies.some((o) => o.side !== side && !o.keeper && Math.hypot(o.x - ball.x, o.z - ball.z) < 2.2);
          if (toGoal < 9.5) {
            const keeper = bodies.find((o) => o.keeper && o.side !== side)!;
            const corner = keeper.z > 0 ? -1 : 1;
            kickTo(ball, atk + dir * 0.5, corner * GOAL_W * (0.25 + rand() * 0.2), 13 + rand() * 4, 1 + rand() * 2.6, 0.12 + toGoal * 0.012);
          } else if (ahead.length && (press || rand() < 0.35)) {
            const m = ahead[Math.floor(rand() * ahead.length)];
            kickTo(ball, m.x + dir * 1.2, m.z, 8.5 + rand() * 2, 0.6, 0.12);
          } else {
            // Dribble: a push toward goal, away from whoever is closing in.
            const dodge = press ? (ball.z > 0 ? -1 : 1) * 2.5 : 0;
            kickTo(ball, atk, ball.z * 0.4 + dodge, 5.2 + rand() * 1.4, 0.15, 0.3);
          }
        }
      }
    }

    // Keepers.
    for (const k of bodies.filter((b) => b.keeper)) {
      k.cool -= dt;
      const own = ownGoalX(k.side);
      const out = -Math.sign(own);
      if (frozen) {
        step(k, k.x, k.z, 0, dt);
        continue;
      }
      if (k.dive > 0) {
        k.dive -= dt;
        k.vz = k.diveDir * 5.5;
        k.vx *= 0.9;
      } else {
        const cr = crossing(ball, own);
        const threat = cr && cr.t < 1.2 && Math.abs(cr.z) < GOAL_W / 2 + 0.6;
        let tz = THREE.MathUtils.clamp(ball.z * 0.5, -GOAL_W / 2 + 0.4, GOAL_W / 2 - 0.4);
        let tx = own + out * 0.7;
        if (threat) tz = THREE.MathUtils.clamp(cr!.z, -GOAL_W / 2, GOAL_W / 2);
        // Come out for a loose ball in the box.
        const near = Math.abs(ball.x - own) < 3.6 && Math.abs(ball.z) < 3.4 && Math.hypot(ball.vx, ball.vz) < 6;
        if (near) {
          tx = ball.x;
          tz = ball.z;
        }
        step(k, tx, tz, near ? 5.5 : KEEPER_SPEED, dt);
        // Dive for a shot that is going past.
        if (threat && Math.abs(cr!.z - k.z) > 0.8 && cr!.t < 0.45) {
          k.dive = 0.45;
          k.diveDir = Math.sign(cr!.z - k.z);
        }
      }
      // A hand (or a boot) on it.
      const reach = k.dive > 0 ? 1.35 : 0.85;
      const d = Math.hypot(k.x - ball.x, k.z - ball.z);
      if (k.cool <= 0 && d < reach && ball.y < 2.1) {
        const sp = Math.hypot(ball.vx, ball.vz);
        const chance = sp > 15 ? 0.42 : sp > 12 ? 0.62 : sp > 8 ? 0.85 : 0.97;
        k.cool = 0.6;
        if (rand() < chance) {
          const towardGoal = Math.sign(ball.vx) === Math.sign(own);
          last = k.side;
          kickTo(ball, own + out * 12, (rand() - 0.5) * PW * 0.8, 9 + rand() * 3, 2.5 + rand() * 2, 0.2);
          if (towardGoal && sp > 9) events.push({ kind: "save", title: `🧤 Save by ${k.name}!` });
        } else {
          // Fingertips: it carries on, a little slower.
          ball.vx *= 0.8;
          ball.vz *= 0.8;
        }
      }
    }

    // Bodies step round each other and round you.
    for (const b of bodies) {
      for (const o of bodies) {
        if (o === b) continue;
        const dx = b.x - o.x;
        const dz = b.z - o.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.6 && d > 1e-4) {
          b.x += (dx / d) * (0.6 - d) * 0.5;
          b.z += (dz / d) * (0.6 - d) * 0.5;
        }
      }
      if (human.present) {
        const dx = b.x - human.x;
        const dz = b.z - human.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.65 && d > 1e-4) {
          b.x += (dx / d) * (0.65 - d);
          b.z += (dz / d) * (0.65 - d);
        }
      }
      b.x = THREE.MathUtils.clamp(b.x + b.vx * dt, -HX - 0.6, HX + 0.6);
      b.z = THREE.MathUtils.clamp(b.z + b.vz * dt, -HZ - 0.6, HZ + 0.6);
    }
  };

  const pose = (dt: number, ball: MatchBall) => {
    for (const b of bodies) {
      const sp = Math.hypot(b.vx, b.vz);
      const want = sp > 0.4 ? Math.atan2(b.vx, b.vz) : Math.atan2(ball.x - b.x, ball.z - b.z);
      let dy = want - b.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      b.yaw += dy * Math.min(1, dt * 10);
      b.stride += dt * (2 + sp * 1.9);
      const swing = Math.sin(b.stride) * Math.min(0.9, sp * 0.14);
      const f = b.obj;
      f.root.position.set(b.x, 0.03, b.z);
      f.root.rotation.y = b.yaw;
      f.legL.rotation.x = swing;
      f.legR.rotation.x = -swing;
      f.armL.rotation.x = -swing * 0.8;
      f.armR.rotation.x = swing * 0.8;
      f.body.position.y = Math.abs(Math.sin(b.stride)) * Math.min(0.06, sp * 0.01);
      // A keeper's dive: tip over sideways, arms up.
      const tilt = b.dive > 0 ? -b.diveDir * 1.1 : 0;
      f.body.rotation.z += (tilt * (b.side === "home" ? 1 : 1) - f.body.rotation.z) * Math.min(1, dt * 12);
      if (b.dive > 0) {
        f.armL.rotation.z = f.armR.rotation.z = 0;
        f.armL.rotation.x = f.armR.rotation.x = -2.8;
      }
      // Celebrate a goal.
      if (phase === "goal" && b.side === last && !b.keeper) {
        f.armL.rotation.x = f.armR.rotation.x = -2.9;
        f.body.position.y = Math.abs(Math.sin(phaseT * 9)) * 0.25;
      }
    }
  };

  return {
    live: () => phase !== null,
    phase: () => phase,
    score: () => score,
    clock: clockText,
    ui(): MatchUi | null {
      if (!phase) return null;
      return { home: score[0], away: score[1], clock: clockText(), homeName: HOME_NAME, awayName: AWAY_NAME, phase };
    },
    start(ball: MatchBall): MatchEvent {
      phase = "kickoff";
      phaseT = 0;
      clock = 0;
      score = [0, 0];
      kickoffTeam = "home";
      farFor = 0;
      resetFormation(ball);
      return {
        kind: "kickoff",
        title: `⚽ Kick-off: ${HOME_NAME} v ${AWAY_NAME}`,
        description: "You are teal, shooting at the east goal. Run into the ball to dribble, press E (or tap Shoot) to shoot. Two minutes on the clock.",
      };
    },
    stop() {
      phase = null;
      for (const b of bodies) b.obj.root.visible = false;
    },
    /** A ball crossed a goal line between the posts. */
    goal(side: Side): MatchEvent | null {
      if (phase !== "play") return null;
      score = side === "home" ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
      last = side;
      phase = "goal";
      phaseT = 0;
      kickoffTeam = side === "home" ? "away" : "home";
      const name = side === "home" ? HOME_NAME : AWAY_NAME;
      return { kind: "goal", title: `⚽ GOAL! ${name}`, description: `${HOME_NAME} ${score[0]}, ${AWAY_NAME} ${score[1]} · ${clockText()} left` };
    },
    /** E pressed during play: a shot if the ball is at your feet. */
    shoot(ball: MatchBall, human: MatchHuman): boolean {
      if (phase !== "play" && phase !== "kickoff") return false;
      if (!human.present) return false;
      const d = Math.hypot(human.x - ball.x, human.z - ball.z);
      if (d > 1.6 || ball.y > 1.2) return false;
      if (phase === "kickoff") phase = "play";
      const keeper = bodies.find((b) => b.keeper && b.side === "away")!;
      const dist = HX - ball.x;
      // Aim away from the keeper, nudged by which way you were running.
      const lean = THREE.MathUtils.clamp(human.vz * 0.12, -0.8, 0.8);
      const corner = Math.abs(lean) > 0.25 ? Math.sign(lean) : keeper.z > 0 ? -1 : 1;
      const tz = corner * GOAL_W * 0.33 + (rand() - 0.5) * 0.6;
      const power = THREE.MathUtils.clamp(11 + dist * 0.35, 12, 19);
      kickTo(ball, HX + 0.5, tz, power, 1.4 + Math.min(3, dist * 0.12), Math.min(0.35, dist * 0.012));
      humanTouch = 0.2;
      last = "home";
      return true;
    },
    canShoot(ball: MatchBall, human: MatchHuman) {
      return (phase === "play" || phase === "kickoff") && human.present && Math.hypot(human.x - ball.x, human.z - ball.z) < 1.6 && ball.y < 1.2;
    },
    /** The human touched the ball (a dribble), so the AI waits a beat. */
    touched() {
      humanTouch = 0.25;
      last = "home";
      if (phase === "kickoff") phase = "play";
    },
    /**
     * Run the match. Returns where to put the human (pitch space) when a
     * kick-off needs them back in their own half, and anything to announce.
     */
    update(dt: number, ball: MatchBall, human: MatchHuman, farFromPitch: boolean): { place: { x: number; z: number } | null; events: MatchEvent[]; hold: boolean } {
      const events: MatchEvent[] = [];
      let place: { x: number; z: number } | null = null;
      if (!phase) return { place, events, hold: false };
      phaseT += dt;
      humanTouch -= dt;
      farFor = farFromPitch ? farFor + dt : 0;
      if (farFor > 5) {
        this.stop();
        events.push({ kind: "abandoned", title: "⚽ Match abandoned", description: "You walked off the pitch. Press E by the scoreboard for a rematch." });
        return { place, events, hold: false };
      }
      let hold = false;
      if (phase === "kickoff") {
        // The ball sits on the spot until somebody plays it, or a second and a half.
        hold = phaseT < 1.5;
        if (phaseT >= 1.5 && kickoffTeam === "away") {
          phase = "play";
          const d = bodies.find((b) => b.name === "Dizzy")!;
          kickTo(ball, d.x - 6, (rand() - 0.5) * 6, 6, 0.2, 0.2);
          d.cool = 0.5;
        } else if (phaseT >= 1.5) phase = "play";
      } else if (phase === "play") {
        clock += dt;
        if (clock >= MATCH_SECONDS) {
          phase = "over";
          phaseT = 0;
          const [h, a] = score;
          const result = h > a ? `${HOME_NAME} win ${h}–${a}! You lift the Vibe Commons Cup. 🏆` : h < a ? `${AWAY_NAME} win ${a}–${h}. Press E by the scoreboard for a rematch.` : `A ${h}–${a} draw. Press E by the scoreboard to settle it.`;
          events.push({ kind: "full-time", title: "📣 Full time!", description: result });
        }
      } else if (phase === "goal") {
        if (phaseT > 2.6) {
          phase = "kickoff";
          phaseT = 0;
          resetFormation(ball);
          place = { ...HUMAN_SPOT };
          events.push({ kind: "kickoff", title: `⚽ ${kickoffTeam === "home" ? "Your" : "Their"} kick-off`, description: `${HOME_NAME} ${score[0]}, ${AWAY_NAME} ${score[1]} · ${clockText()} left` });
        }
      } else if (phase === "over") {
        if (phaseT > 6) this.stop();
      }
      if (phase) {
        AI_STEP(ball, human, dt, events);
        pose(dt, ball);
      }
      return { place, events, hold };
    },
    /** Kick-off puts the human here, pitch space. */
    humanSpot: HUMAN_SPOT,
    /** Dev: where everybody is. */
    dev() {
      return {
        phase,
        clock: clockText(),
        score,
        bodies: bodies.map((b) => ({ name: b.name, side: b.side, keeper: b.keeper, x: +b.x.toFixed(2), z: +b.z.toFixed(2) })),
      };
    },
    /** Dev: skip the clock forward. */
    devClock(t: number) {
      clock = t;
    },
  };
}

export type Match = ReturnType<typeof buildMatch>;
