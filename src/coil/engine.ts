/**
 * COIL — the loop, the input, and the wire to React.
 *
 * Same shape as BLOB's engine, and for the same reasons: React never sees a
 * frame, it subscribes to a status object published about ten times a second
 * while the canvas does the other fifty behind its back. Fixed 60 Hz
 * accumulator, interpolation-free (the head moves at a constant speed, so a
 * frame of lag is invisible), and `MAX_FRAME` throws away the two-minute delta
 * a backgrounded tab comes back with.
 *
 * The input is where this differs. A snake has no aim point, only a heading, so
 * every control here resolves to an angle:
 *
 *  - **mouse**: the direction from the head to the cursor, every frame.
 *  - **touch**: a drag sets a heading and *keeps* it after the thumb lifts,
 *    which is the same course control BLOB grew and matters even more here —
 *    you cannot stop, so a control that means "stop when I let go" is a control
 *    that cannot be let go of.
 *  - **boost**: held, not tapped. Mouse down, space, or the button.
 */
import { CoilAudio } from "./audio";
import { releaseRenderer } from "@/lib/quality";
import {
  BOOST_MIN_SCORE,
  MAX_FRAME,
  SKILLS,
  TICK,
  VIEW_SPAN,
  radiusOf,
  type SkillId,
} from "./config";
import { Renderer } from "./render";
import { lookFor, playerLook } from "./roster";
import { think } from "./ai";
import { CoilSim } from "./sim";
import type { Standing } from "./types";

export type Phase = "attract" | "playing" | "dead";

export interface FeedItem {
  id: number;
  text: string;
  color: string;
  at: number;
}

export interface CoilStatus {
  phase: Phase;
  score: number;
  peak: number;
  best: number;
  rank: number;
  alive: number;
  kills: number;
  standings: Standing[];
  feed: FeedItem[];
  muted: boolean;
  fps: number;
  skill: SkillId;
  name: string;
  /** The character riding the front, so the page can show the same face. */
  charId: string;
  color: string;
  boosting: boolean;
  canBoost: boolean;
  touch: boolean;
  /** Who you last ran into, for the death card. */
  lastKiller: string | null;
}

export interface EngineOptions {
  skill?: SkillId;
  name?: string;
  seed?: number;
  /** Hand the controls to the bot brain — used by `?shot`. */
  demo?: boolean;
}

/** Thumb travel, in css pixels, below which a touch is a tap not a drag. */
const DEADZONE = 9;

const bestKey = () => "coil:best";

const readBest = (): number => {
  try {
    return Number(localStorage.getItem(bestKey()) || 0) || 0;
  } catch {
    // Private-mode Safari throws. A missing high score does not stop a game.
    return 0;
  }
};

const writeBest = (v: number): void => {
  try {
    localStorage.setItem(bestKey(), String(Math.round(v)));
  } catch {
    /* see readBest */
  }
};

export class CoilEngine {
  private readonly renderer: Renderer;
  private readonly audio = new CoilAudio();
  private sim: CoilSim;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private phase: Phase = "attract";
  private disposed = false;

  private skill: SkillId;
  private playerName: string;
  private readonly demo: boolean;

  // --- input ---------------------------------------------------------------
  private mouse: { x: number; y: number } | null = null;
  private stick = { ox: 0, oy: 0, x: 0, y: 0, active: false, id: -1, moved: false };
  private usingTouch = false;
  /** The heading a phone player set, which outlives the finger that set it. */
  private course: { dx: number; dy: number; power: number } = { dx: 0, dy: 0, power: 0 };
  private boostHeld = false;
  private boostButton = false;

  // --- published -----------------------------------------------------------
  private listeners = new Set<(s: CoilStatus) => void>();
  private feed: FeedItem[] = [];
  private feedId = 1;
  private publishAt = 0;
  private best = readBest();
  private runPeak = 0;
  private lastKiller: string | null = null;
  private status: CoilStatus;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: EngineOptions = {},
  ) {
    this.skill = opts.skill ?? "standard";
    this.demo = !!opts.demo;
    const look = playerLook();
    this.playerName = opts.name || look.name;
    this.renderer = new Renderer(canvas);
    this.sim = new CoilSim({ skill: this.skill, name: this.playerName, seed: opts.seed });
    this.status = this.snapshot();

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  // -------------------------------------------------------------------------

  subscribe(fn: (s: CoilStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private publish(force = false): void {
    const now = performance.now();
    if (!force && now - this.publishAt < 100) return;
    this.publishAt = now;
    this.status = this.snapshot();
    for (const fn of this.listeners) fn(this.status);
  }

  private snapshot(): CoilStatus {
    const you = this.sim.you;
    return {
      phase: this.phase,
      score: Math.round(you.score),
      peak: Math.round(this.runPeak),
      best: this.best,
      rank: this.sim.rankOf(0),
      alive: this.sim.aliveCount(),
      kills: you.kills,
      standings: this.sim.standings(10),
      feed: this.feed,
      muted: this.audio.isMuted,
      fps: Math.round(this.renderer.fps),
      skill: this.skill,
      name: this.playerName,
      charId: you.charId,
      color: you.color,
      boosting: you.boosting,
      canBoost: you.alive && you.score > BOOST_MIN_SCORE,
      touch: this.usingTouch,
      lastKiller: this.lastKiller,
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  play(): void {
    this.audio.resume();
    if (this.phase === "playing") return;
    this.runPeak = 0;
    this.lastKiller = null;
    this.feed = [];
    this.sim.respawnYou();
    this.phase = "playing";
    this.publish(true);
  }

  quit(): void {
    const you = this.sim.you;
    you.alive = false;
    this.phase = "attract";
    this.publish(true);
  }

  setName(name: string): void {
    this.playerName = name.slice(0, 14) || playerLook().name;
    this.sim.you.name = this.playerName;
    this.publish(true);
  }

  /** Swap the character on the front. The body colour follows the head, which
   *  is the point of tying this to the wardrobe at all. */
  setCharacter(charId: string): void {
    const look = lookFor(charId);
    this.sim.setPlayerLook(look, this.playerName);
    this.publish(true);
  }

  /** Re-read the equipped character — the wardrobe reconciles with the server
   *  a moment after boot, and the snake should follow it. */
  syncLook(): void {
    const look = playerLook();
    if (look.charId === this.sim.you.charId) return;
    this.sim.setPlayerLook(look, this.playerName);
    this.publish(true);
  }

  setSkill(skill: SkillId): void {
    if (skill === this.skill) return;
    this.skill = skill;
    this.sim = new CoilSim({ skill, name: this.playerName });
    this.phase = "attract";
    this.feed = [];
    this.runPeak = 0;
    this.publish(true);
  }

  setBoostButton(on: boolean): void {
    this.boostButton = on;
  }

  toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted);
    this.publish(true);
  }

  resize(): void {
    this.renderer.resize();
  }

  /** For the check scripts — where the head is and what it is doing. */
  probe(): { x: number; y: number; score: number; alive: boolean; angle: number } {
    const s = this.sim.you;
    return {
      x: Math.round(s.body.headX),
      y: Math.round(s.body.headY),
      score: Math.round(s.score),
      alive: s.alive,
      angle: s.angle,
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.listeners.clear();
    /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
       leaves the GL context to the garbage collector. See docs/performance.md. */
    releaseRenderer(this.renderer);
    this.audio.dispose();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.pointerType === "touch") {
      if (this.stick.active && e.pointerId === this.stick.id) {
        this.stick.x = x;
        this.stick.y = y;
      }
      return;
    }
    this.mouse = { x, y };
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.audio.resume();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.pointerType === "touch") {
      this.usingTouch = true;
      if (!this.stick.active) {
        this.stick = { ox: x, oy: y, x, y, active: true, id: e.pointerId, moved: false };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
      this.publish(true);
      return;
    }
    this.mouse = { x, y };
    // Holding the mouse down is the desktop boost, which is what the genre
    // trained everybody to expect.
    if (e.button === 0 || e.button === 2) this.boostHeld = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") {
      this.boostHeld = false;
      return;
    }
    if (e.pointerId !== this.stick.id) return;
    this.stick.active = false;
    this.stick.id = -1;
    // A drag sets a course that outlives the finger. A tap does not steer at
    // all — there is no "stop" in this game, so a tap that reset the heading
    // would be a control with a mode nobody wants.
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === " " || e.code === "Space" || k === "shift") {
      e.preventDefault();
      this.boostHeld = true;
      return;
    }
    if (k === "m") this.toggleMute();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (k === " " || e.code === "Space" || k === "shift") this.boostHeld = false;
  };

  private onBlur = (): void => {
    // A boost held when the window loses focus never sends its keyup, and a
    // stuck boost burns your whole length while you read an email.
    this.boostHeld = false;
    this.stick.active = false;
  };

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  private tick = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const wall = Math.min(MAX_FRAME, (now - this.last) / 1000);
    this.last = now;

    if (this.phase === "playing" || this.phase === "attract") {
      this.steer();
      this.acc += wall;
      let steps = 0;
      while (this.acc >= TICK && steps < 6) {
        this.sim.step(TICK, think);
        this.acc -= TICK;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      if (this.phase === "playing") {
        const s = this.sim.you.score;
        if (s > this.runPeak) this.runPeak = s;
      }
      this.drain();
    }

    this.render(wall);
    this.publish();
  };

  private steer(): void {
    const you = this.sim.you;
    if (!you.alive) return;

    if (this.demo) {
      if (!you.brain) {
        you.brain = {
          wit: 0.9,
          daring: 0.5,
          greed: 0.7,
          nextThink: 0,
          want: you.angle,
          wantBoost: false,
          commitUntil: 0,
          nextCut: 0,
        };
      }
      if (this.sim.time >= you.brain.nextThink) {
        you.brain.nextThink = this.sim.time + 0.1;
        think(this.sim, you);
      }
      this.sim.steerAngle(0, you.brain.want);
      this.sim.setBoost(0, you.brain.wantBoost);
      return;
    }

    const boosting = this.boostHeld || this.boostButton;
    this.sim.setBoost(0, boosting);
    this.audio.setBoosting(boosting && you.score > BOOST_MIN_SCORE);

    if (this.usingTouch) {
      if (this.stick.active) {
        const dx = this.stick.x - this.stick.ox;
        const dy = this.stick.y - this.stick.oy;
        const d = Math.hypot(dx, dy);
        /* Inside the dead zone the heading is left alone rather than zeroed: a
           thumb resting near where it landed should hold the course, not spin
           the snake around whatever jitter the digitiser reports. */
        if (d >= DEADZONE) {
          this.stick.moved = true;
          this.course = { dx: dx / d, dy: dy / d, power: 1 };
        }
      }
      if (this.course.power > 0) {
        this.sim.steerAngle(0, Math.atan2(this.course.dy, this.course.dx));
      }
      return;
    }

    if (!this.mouse) return;
    const w = this.renderer.screenToWorld(this.mouse.x, this.mouse.y);
    this.sim.steerTo(0, w.x, w.y);
  }

  private drain(): void {
    const events = this.sim.events;
    if (!events.length) return;
    for (const e of events) {
      switch (e.type) {
        case "eat":
          if (e.by === 0) {
            this.audio.eat(e.value);
            if (e.value > 2) {
              this.renderer.burst(e.x, e.y, this.sim.you.color, 4, 70);
            }
          }
          break;
        case "boost":
          break;
        case "crash": {
          const snake = this.sim.snakes[e.by];
          const colour = snake ? snake.color : "#ffffff";
          this.renderer.ring(e.x, e.y, colour, 40);
          this.renderer.burst(e.x, e.y, colour, 26, 220);
          if (e.by === 0) {
            const into = this.sim.snakes[e.into];
            this.lastKiller = e.into < 0 ? "the wall" : (into?.name ?? null);
            this.onDeath();
          }
          break;
        }
        case "kill":
          this.pushFeed(`${e.victim} ran into ${e.killer}`, e.color);
          if (e.killer === this.sim.you.name && this.sim.you.alive) this.audio.kill();
          break;
      }
    }
    events.length = 0;
  }

  private pushFeed(text: string, color: string): void {
    this.feed = [{ id: this.feedId++, text, color, at: this.sim.time }, ...this.feed].slice(0, 5);
  }

  private onDeath(): void {
    if (this.phase !== "playing") {
      // In demo mode nobody is watching to press "again", and an empty arena is
      // not a card shot.
      if (this.demo) this.sim.respawnYou();
      return;
    }
    this.phase = "dead";
    this.audio.setBoosting(false);
    this.audio.crash();
    this.renderer.jolt(18);
    if (this.runPeak > this.best) {
      this.best = this.runPeak;
      writeBest(this.runPeak);
      this.audio.fanfare();
    }
    this.publish(true);
  }

  private render(dt: number): void {
    const you = this.sim.you;
    const watching = you.alive ? you : this.sim.leader();
    const focusX = watching ? watching.body.headX : 0;
    const focusY = watching ? watching.body.headY : 0;
    const span = watching ? radiusOf(watching.score) * VIEW_SPAN : 400;

    this.renderer.draw(this.sim, {
      alpha: 1,
      youId: 0,
      focusX,
      focusY,
      span,
      dt,
      stick: this.usingTouch ? this.stick : null,
      heading: this.usingTouch && you.alive ? this.course : null,
      dimmed: this.phase !== "playing",
    });
  }
}

export { SKILLS };
