/**
 * Ping-pong diplomacy. The one chapter that is not a runner.
 *
 * The ball is real: position, velocity, gravity, a restitution off the table
 * and a net that will stop it. Nothing about the rally is scripted, which
 * matters more than it sounds — a faked rally has to decide in advance who
 * wins the point, and then every input you make is theatre. Here the ball
 * genuinely goes where it is hit, the opponent genuinely reaches for it or
 * does not, and a rally that goes twenty shots went twenty shots.
 *
 * What you actually do is two things at once: be where the ball is (steer) and
 * hit it at the right moment (tap). Placement comes out of the direction you
 * were moving as you made contact, so a good player is *already leaning* the
 * way they want the ball to go — which is exactly how the sport reads on TV,
 * and it is one input, which is all a phone has.
 */
import * as THREE from "three";
import {
  grandstand,
  paddleProp,
  pingPongBall,
  pingPongTable,
  boxGeo,
  m,
  blobShadow,
} from "./props";
import { gymFloor } from "./textures";
import { makeHuman, LOOKS, type Human } from "./rig";
import type { Chapter, ChapterCtx, ChapterHud, Outcome } from "./types";

/** The surface, in metres. Regulation table, so the numbers are the sport's. */
const TABLE_Y = 0.82;
const HALF_W = 0.7625;
const HALF_L = 1.37;
const NET_H = 0.1525;
/** Where your paddle lives, just off the end of your half. */
const PADDLE_Z = 1.95;
const OPP_Z = -1.95;
const GRAVITY = 11.5;
/** First to this many. It is a real match. */
const MATCH = 11;

type Ball = "serve" | "live" | "dead";

export class PingPongChapter implements Chapter {
  private ctx: ChapterCtx;

  private ball = new THREE.Group();
  private ballShadow: THREE.Mesh;
  private bp = new THREE.Vector3();
  private bv = new THREE.Vector3();
  private state: Ball = "serve";
  private serveTimer = 1.2;
  private lastHitter: "you" | "them" = "them";
  private bounces = 0;

  private paddle: THREE.Group;
  private paddleX = 0;
  private paddleVX = 0;
  private swing = 0;
  private swingCooldown = 0;

  private oppPaddle: THREE.Group;
  private oppX = 0;
  private oppTargetX = 0;
  private oppSwing = 0;
  private opp: Human;
  private you: Human;

  private mine = 0;
  private theirs = 0;
  private rally = 0;
  private bestRally = 0;
  private outcome: Outcome = "running";
  private endTimer = 0;
  private shake = 0;
  private time = 0;
  private floorTex: THREE.Texture;
  private floor: THREE.Mesh;

  constructor(ctx: ChapterCtx) {
    this.ctx = ctx;
    ctx.setSky(0x39404d, 0x1b1f27, 0x232833, 0.012);

    /* --- the hall ------------------------------------------------------ */
    this.floorTex = gymFloor();
    this.floorTex.wrapS = THREE.RepeatWrapping;
    this.floorTex.repeat.set(6, 6);
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshLambertMaterial({ map: this.floorTex }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    ctx.root.add(this.floor);

    // Back wall and banners: the room has to close behind the opponent or the
    // table reads as floating in a void, which is worse than any wall.
    const wall = new THREE.Mesh(boxGeo(60, 12, 0.4), m(0x3a3d47));
    wall.position.set(0, 6, -16);
    ctx.root.add(wall);
    for (const [i, c] of [0xb3261e, 0xe0b53a, 0xb3261e].entries()) {
      const banner = new THREE.Mesh(boxGeo(5, 1.6, 0.1), m(c));
      banner.position.set((i - 1) * 7, 6.5, -15.7);
      ctx.root.add(banner);
    }
    for (let i = 0; i < 6; i++) {
      const lamp = new THREE.Mesh(boxGeo(3, 0.25, 1), m(0xfff4d8));
      lamp.position.set(((i % 3) - 1) * 5, 8, i < 3 ? -4 : 4);
      ctx.root.add(lamp);
    }
    for (const side of [-1, 1]) {
      const stand = grandstand(ctx.rng, 6, 22);
      stand.position.set(side * 9, 0, -2);
      stand.rotation.y = (-side * Math.PI) / 2;
      ctx.root.add(stand);
    }

    const table = pingPongTable();
    ctx.root.add(table);

    /* The engine's sun and sky light the outdoor chapters, and a hall with a
       night sky over it comes out black. A chapter is allowed to add its own
       lights to its own root, so this one brings the roof lamps with it. */
    ctx.root.add(new THREE.AmbientLight(0xfff0d8, 0.6));
    const key = new THREE.DirectionalLight(0xfff4e2, 0.95);
    key.position.set(3, 9, 6);
    ctx.root.add(key);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.45);
    fill.position.set(-5, 7, -6);
    ctx.root.add(fill);

    /* --- the players --------------------------------------------------- */
    this.you = makeHuman(LOOKS.pingpong);
    this.you.group.position.set(0, 0, PADDLE_Z + 0.75);
    this.you.group.rotation.y = Math.PI;
    ctx.root.add(this.you.group);

    this.opp = makeHuman({ ...LOOKS.pingpong, shirt: 0xb3261e, pants: 0x1c2b4a, hair: 0x1c1815 });
    this.opp.group.position.set(0, 0, OPP_Z - 0.55);
    ctx.root.add(this.opp.group);

    this.paddle = paddleProp(0xb3261e);
    ctx.root.add(this.paddle);
    this.oppPaddle = paddleProp(0x1c1815);
    ctx.root.add(this.oppPaddle);

    ctx.root.add(this.ball);
    this.ball.add(pingPongBall());
    this.ballShadow = blobShadow(0.09);
    ctx.root.add(this.ballShadow);

    ctx.audio.music(294, 0.3);
    ctx.say("First to eleven. Keep your eye on the ball.");
  }

  /* ================================================================ rally */

  private serve() {
    this.state = "serve";
    this.serveTimer = 1.1;
    this.bounces = 0;
    this.rally = 0;
  }

  private launchServe() {
    const server = this.lastHitter === "you" ? "them" : "you";
    const from = server === "them" ? OPP_Z + 0.25 : PADDLE_Z - 0.25;
    const dir = server === "them" ? 1 : -1;
    this.bp.set((this.ctx.rng() * 2 - 1) * 0.45, TABLE_Y + 0.35, from);
    this.bv.set((this.ctx.rng() * 2 - 1) * 0.7, 2.4, dir * 5.6);
    this.lastHitter = server;
    this.state = "live";
    this.bounces = 0;
    this.ctx.audio.paddle(0.3);
    if (server === "them") this.oppSwing = 1;
    else this.swing = 1;
  }

  /** Somebody has lost the point. */
  private point(to: "you" | "them", why: string) {
    if (this.state === "dead") return;
    this.state = "dead";
    this.serveTimer = 1.05;
    this.bestRally = Math.max(this.bestRally, this.rally);
    if (to === "you") {
      this.mine += 1;
      this.ctx.audio.cheer(50, 0.8);
    } else {
      this.theirs += 1;
      this.shake = 0.6;
      this.ctx.audio.fail();
    }
    this.ctx.say(`${why}   ${this.mine} – ${this.theirs}`);
    if (this.mine >= MATCH) this.finish("won");
    else if (this.theirs >= MATCH) this.finish("lost");
  }

  private finish(o: Outcome) {
    if (this.outcome !== "running") return;
    this.outcome = o;
    this.ctx.audio.stopMusic();
    if (o === "won") this.ctx.audio.fanfare();
    else this.ctx.audio.fail();
  }

  /* =============================================================== update */

  update(dt: number): ChapterHud {
    const { ctx } = this;
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.swing = Math.max(0, this.swing - dt * 5);
    this.oppSwing = Math.max(0, this.oppSwing - dt * 5);
    this.swingCooldown = Math.max(0, this.swingCooldown - dt);

    if (this.outcome !== "running") {
      this.endTimer += dt;
      this.poseAll(dt);
      this.driveCamera(dt);
      return this.hud();
    }

    /* --- your paddle --------------------------------------------------- */
    const want = ctx.input.steer * 1.5;
    const nx = THREE.MathUtils.clamp(
      this.paddleX + (want - this.paddleX) * Math.min(1, 12 * dt),
      -1.05,
      1.05,
    );
    this.paddleVX = (nx - this.paddleX) / Math.max(dt, 1e-4);
    this.paddleX = nx;

    if (ctx.input.actionPressed && this.swingCooldown <= 0) {
      this.swingCooldown = 0.26;
      this.swing = 1;
      this.tryHit();
    }

    /* --- the ball ------------------------------------------------------ */
    if (this.state === "serve" || this.state === "dead") {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) {
        if (this.state === "dead") this.serve();
        else this.launchServe();
      }
      // Park the ball in the server's hand while they wait.
      const side = this.lastHitter === "you" ? OPP_Z : PADDLE_Z;
      this.bp.set(side === OPP_Z ? this.oppX : this.paddleX, TABLE_Y + 0.3, side * 0.92);
    } else {
      this.stepBall(dt);
    }

    this.ball.position.copy(this.bp);
    this.ballShadow.position.set(this.bp.x, TABLE_Y + 0.005, this.bp.z);
    this.ballShadow.visible =
      Math.abs(this.bp.x) < HALF_W + 0.3 && Math.abs(this.bp.z) < HALF_L + 0.3;
    const drop = THREE.MathUtils.clamp(1 - (this.bp.y - TABLE_Y) * 0.8, 0.35, 1);
    this.ballShadow.scale.setScalar(drop);

    this.updateOpponent(dt);
    this.poseAll(dt);
    this.driveCamera(dt);
    return this.hud();
  }

  private stepBall(dt: number) {
    this.bv.y -= GRAVITY * dt;
    this.bp.addScaledVector(this.bv, dt);

    const receiver = this.lastHitter === "you" ? "them" : "you";
    const overTable = Math.abs(this.bp.x) < HALF_W && Math.abs(this.bp.z) < HALF_L;

    /* The net. A ball into the net is the commonest way to lose a point in
       the real sport and it should be here too — it is what makes a smash a
       decision rather than a free action. */
    if (Math.abs(this.bp.z) < 0.04 && this.bp.y < TABLE_Y + NET_H && Math.abs(this.bp.x) < HALF_W + 0.15) {
      this.ctx.audio.paddle(0.1);
      this.point(receiver, "Into the net.");
      return;
    }

    if (this.bp.y <= TABLE_Y && this.bv.y < 0 && overTable) {
      this.bp.y = TABLE_Y;
      this.bv.y = -this.bv.y * 0.78;
      this.bv.x *= 0.96;
      this.bv.z *= 0.96;
      this.bounces += 1;
      this.ctx.audio.paddle(0.12);
      // Two bounces since the last stroke means the receiver never reached it.
      // That is the whole miss rule — no timers, no "you were too slow" flag.
      if (this.bounces >= 2) {
        this.point(this.lastHitter, receiver === "you" ? "Past you." : "Winner.");
      }
      return;
    }

    /* On the floor, or gone. Which way the point goes depends entirely on
       whether it had already bounced legally: no bounce means the stroke was
       out, one bounce means the receiver simply missed it. */
    if (this.bp.y < TABLE_Y - 0.5 || Math.abs(this.bp.z) > 7) {
      if (this.bounces >= 1) this.point(this.lastHitter, "Winner.");
      else this.point(receiver, this.lastHitter === "you" ? "Out." : "Theirs was long.");
    }
  }

  /**
   * A swing. Contact is a box around the paddle, and *where in that box* the
   * ball was decides how good the shot is: catch it early and out in front and
   * you get a flat fast one, catch it late and you get a loop back.
   */
  private tryHit() {
    if (this.state !== "live") return;
    const dz = this.bp.z - PADDLE_Z;
    const dx = this.bp.x - this.paddleX;
    const reach = Math.abs(dz) < 0.55 && Math.abs(dx) < 0.42 && this.bp.y > TABLE_Y - 0.35 && this.bp.y < TABLE_Y + 1.1;
    if (!reach || this.lastHitter === "you") {
      this.ctx.audio.paddle(0.05);
      return;
    }

    // Timing: 1.0 dead in the sweet spot, tailing off to the edges of reach.
    const timing = THREE.MathUtils.clamp(1 - Math.abs(dz + 0.12) / 0.55, 0, 1);
    const centred = THREE.MathUtils.clamp(1 - Math.abs(dx) / 0.42, 0, 1);
    const quality = timing * 0.65 + centred * 0.35;
    const smash = this.ctx.input.boost ? 1.25 : 1;

    const power = (0.5 + quality * 0.5) * smash;
    this.bv.z = -(6.5 + power * 6.5);
    this.bv.y = 2.5 - power * 1.1 + (this.bp.y - TABLE_Y) * 0.4;
    // Placement comes out of which way you were moving. Lean into the shot and
    // it goes that way; hit it flat-footed and it goes back down the middle.
    this.bv.x = THREE.MathUtils.clamp(this.paddleVX * 0.32 + dx * -2.2, -3.4, 3.4);
    this.bp.z = PADDLE_Z - 0.2;
    this.bounces = 0;
    this.lastHitter = "you";
    this.rally += 1;
    this.shake = power * 0.25;
    this.ctx.audio.paddle(power);
    if (this.rally === 12) this.ctx.say("You never blink.");
    if (this.rally === 25) this.ctx.say("Nobody has ever seen anything like it.");
  }

  /**
   * The opponent. They track where the ball will cross their end, move at a
   * finite speed to get there, and miss if it is further than they can reach.
   *
   * There is no dice roll for whether they return it — the reach is the whole
   * AI, so a shot into the corner beats them *because* it was into the corner.
   * Their speed climbs as the match goes on, which is the difficulty curve.
   */
  private updateOpponent(dt: number) {
    const skill = 0.55 + (this.mine + this.theirs) / (MATCH * 2) * 0.5;
    const reach = 4.2 + skill * 4.4;

    if (this.state === "live" && this.lastHitter === "you" && this.bv.z < 0) {
      // Predict the crossing, with a small error that shrinks as they warm up.
      const tt = Math.max(0.05, (OPP_Z - this.bp.z) / this.bv.z);
      this.oppTargetX = THREE.MathUtils.clamp(
        this.bp.x + this.bv.x * tt + (this.ctx.rng() - 0.5) * (1 - skill) * 0.9,
        -1.15,
        1.15,
      );
    }
    this.oppX += THREE.MathUtils.clamp(this.oppTargetX - this.oppX, -reach * dt, reach * dt);

    // They only play it after it has bounced on their half — a volley is a
    // fault in the real sport, and allowing one here would let the AI cut off
    // every deep ball before it ever landed.
    if (
      this.state === "live" &&
      this.lastHitter === "you" &&
      this.bounces >= 1 &&
      this.bp.z < OPP_Z + 0.35 &&
      this.bv.z < 0
    ) {
      const dx = Math.abs(this.bp.x - this.oppX);
      if (dx < 0.4) {
        const q = 1 - dx / 0.4;
        this.bv.z = 6.2 + skill * 5.2 + q * 2;
        this.bv.y = 2.6 - q * 0.8;
        this.bv.x = THREE.MathUtils.clamp(
          (this.ctx.rng() * 2 - 1) * (0.9 + skill * 2.4) - this.bp.x * 0.8,
          -3.6,
          3.6,
        );
        this.bp.z = OPP_Z + 0.3;
        this.bounces = 0;
        this.lastHitter = "them";
        this.rally += 1;
        this.oppSwing = 1;
        this.ctx.audio.paddle(0.5 + skill * 0.3);
      }
      // If they cannot reach it, nothing happens here — the ball carries on
      // and the two-bounce rule below gives you the point. No special case.
    }
  }

  private poseAll(dt: number) {
    void dt;
    const idle = Math.sin(this.time * 2.2) * 0.06;

    this.you.group.position.x = this.paddleX * 0.75;
    this.you.pose(this.time * 3, 0.14 + Math.abs(this.paddleVX) * 0.05);
    this.paddle.position.set(
      this.paddleX,
      TABLE_Y + 0.28 + this.swing * 0.16 + idle * 0.3,
      PADDLE_Z - this.swing * 0.5,
    );
    this.paddle.rotation.set(-0.5 - this.swing * 1.4, this.paddleVX * 0.08, this.swing * 0.6);

    this.opp.group.position.x = this.oppX * 0.75;
    this.opp.pose(this.time * 3 + 1, 0.14);
    this.oppPaddle.position.set(
      this.oppX,
      TABLE_Y + 0.28 + this.oppSwing * 0.16 - idle * 0.3,
      OPP_Z + this.oppSwing * 0.5,
    );
    this.oppPaddle.rotation.set(0.5 + this.oppSwing * 1.4, 0, -this.oppSwing * 0.6);
  }

  private driveCamera(dt: number) {
    const { camera } = this.ctx;
    // Over your shoulder, tracking the paddle a little so the table stays
    // square. A camera that follows the *ball* here is unplayable — you lose
    // the geometry of your own half the instant it swings away.
    // High and well back. The first pass sat it at head height a metre and a
    // half behind the player, and the player's own back filled the frame —
    // you could not see the table you were playing on.
    const wantX = this.paddleX * 0.42;
    camera.position.x += (wantX - camera.position.x) * Math.min(1, 7 * dt);
    camera.position.y += (4.6 - camera.position.y) * Math.min(1, 6 * dt);
    camera.position.z += (6.7 - camera.position.z) * Math.min(1, 6 * dt);
    camera.fov += (42 - camera.fov) * Math.min(1, 5 * dt);
    camera.updateProjectionMatrix();
    const s = this.shake * this.shake;
    camera.position.x += (Math.random() - 0.5) * s * 0.2;
    camera.lookAt(this.bp.x * 0.2, 0.55, -0.7);
  }

  private hud(): ChapterHud {
    return {
      progress: THREE.MathUtils.clamp(this.mine / MATCH, 0, 1),
      stat: `${this.mine} – ${this.theirs}`,
      statLabel: "YOU / THEM",
      extra: String(this.rally || this.bestRally),
      extraLabel: "RALLY",
      lives: MATCH - this.theirs,
      maxLives: MATCH,
      outcome: this.endTimer > 1.4 || this.outcome === "running" ? this.outcome : "running",
      earned: 0,
      chocolates: 0,
      shake: this.shake,
    };
  }

  dispose() {
    this.ctx.audio.stopMusic();
    this.ctx.audio.stopAllLoops();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    (this.ballShadow.userData.dispose as (() => void) | undefined)?.();
    this.you.dispose();
    this.opp.dispose();
    this.ctx.root.clear();
  }
}
