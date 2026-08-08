/**
 * BLOB — the engine: the loop, the input, and the wire to React.
 *
 * React never sees a frame. It subscribes to a `BlobStatus` — mass, rank,
 * leaderboard, kill feed — which is published about ten times a second, and the
 * canvas does the other fifty behind its back. Re-rendering a component tree at
 * 60 Hz to move a number is how a 2D game ends up dropping frames on a phone
 * that could have run it twice over.
 *
 * ## The loop
 *
 * Fixed 60 Hz accumulator, rendered with interpolation. Two consequences worth
 * knowing about:
 *
 * - A backgrounded tab comes back with a delta measured in minutes. `MAX_FRAME`
 *   throws that away rather than simulating it, which is the difference between
 *   "you were away" and "the page hung for nine seconds and then you were dead".
 * - Every visual is interpolated between the last two sim states, so the motion
 *   is smooth on a 144 Hz display without the sim ever running faster.
 */
import { neutralBrain, think } from "./ai";
import { BlobAudio } from "./audio";
import {
  MAX_CELLS,
  MAX_FRAME,
  MIN_SPLIT_MASS,
  MODES,
  SKILLS,
  TICK,
  VIEW_SPAN,
  WORLD,
  radiusOf,
  type ModeId,
  type SkillId,
} from "./config";
import { Renderer } from "./render";
import { BlobSim } from "./sim";
import type { Standing } from "./types";

export type Phase = "attract" | "playing" | "dead" | "over";

export interface FeedItem {
  id: number;
  text: string;
  hue: number;
  at: number;
}

export interface BlobStatus {
  phase: Phase;
  /** Your total mass right now. */
  mass: number;
  /** The biggest you have been this run — the Blitz score. */
  peak: number;
  cells: number;
  rank: number;
  alive: number;
  kills: number;
  /** Seconds remaining in a timed mode, or 0 in Free for All. */
  timeLeft: number;
  best: number;
  standings: Standing[];
  feed: FeedItem[];
  muted: boolean;
  fps: number;
  mode: ModeId;
  skill: SkillId;
  name: string;
  canSplit: boolean;
  canEject: boolean;
  /** True once the player has touched the screen: the page swaps the control
   *  hints for buttons rather than guessing from the user agent. */
  touch: boolean;
}

export interface EngineOptions {
  mode?: ModeId;
  skill?: SkillId;
  name?: string;
  seed?: number;
  /**
   * Hand the player's controls to the bot brain.
   *
   * This is what `?shot` uses. A capture script can click a canvas but it
   * cannot play, so without this the world card would be a frame of a starting
   * cell sitting still where the cursor was parked, five seconds before being
   * eaten — a picture that is technically from the running game and still lies
   * about what the game is.
   */
  demo?: boolean;
}

const bestKey = (mode: ModeId) => `blob:best:${mode}`;

const readBest = (mode: ModeId): number => {
  try {
    return Number(localStorage.getItem(bestKey(mode)) || 0) || 0;
  } catch {
    // Private-mode Safari throws on localStorage. A missing high score is not
    // a reason for the game not to start.
    return 0;
  }
};

const writeBest = (mode: ModeId, value: number): void => {
  try {
    localStorage.setItem(bestKey(mode), String(Math.round(value)));
  } catch {
    /* see readBest */
  }
};

export class BlobEngine {
  private readonly renderer: Renderer;
  private readonly audio = new BlobAudio();
  private sim: BlobSim;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private phase: Phase = "attract";
  private disposed = false;

  private mode: ModeId;
  private skill: SkillId;
  private playerName: string;
  private readonly demo: boolean;

  // --- input state ---------------------------------------------------------
  /** Cursor in css pixels, or null when a pointer has never moved. */
  private mouse: { x: number; y: number } | null = null;
  private stick = { ox: 0, oy: 0, x: 0, y: 0, active: false, id: -1 };
  private usingTouch = false;
  private keys = new Set<string>();
  private ejectHeldSince = 0;

  // --- published state -----------------------------------------------------
  private listeners = new Set<(s: BlobStatus) => void>();
  private feed: FeedItem[] = [];
  private feedId = 1;
  private publishAt = 0;
  private best: number;
  private status: BlobStatus;
  /** Biggest you have been *this run*, which is not the same as this life in a
   *  timed mode — see `play`. */
  private runPeak = 0;
  /** Sim time the current round's clock started. Blitz's three minutes begin
   *  when you press play, not when the title screen started simulating. */
  private roundStartedAt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: EngineOptions = {},
  ) {
    this.mode = opts.mode ?? "ffa";
    this.skill = opts.skill ?? "standard";
    this.playerName = opts.name || "you";
    this.demo = !!opts.demo;
    this.best = readBest(this.mode);
    this.renderer = new Renderer(canvas);
    this.sim = new BlobSim({
      mode: this.mode,
      skill: this.skill,
      name: this.playerName,
      seed: opts.seed,
    });
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
  // React's side of the wall
  // -------------------------------------------------------------------------

  subscribe(fn: (s: BlobStatus) => void): () => void {
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

  private snapshot(): BlobStatus {
    const you = this.sim.you;
    const standings = this.sim.standings(10);
    const mass = this.sim.massOf(you);
    let rank = 0;
    let alive = 0;
    for (const p of this.sim.players) {
      if (!p.alive) continue;
      alive++;
      if (this.sim.massOf(p) > mass) rank++;
    }
    const duration = MODES[this.mode].duration;
    return {
      phase: this.phase,
      mass,
      peak: this.runPeak,
      cells: you.cells.length,
      rank: you.alive ? rank + 1 : 0,
      alive,
      kills: you.kills,
      timeLeft: duration ? Math.max(0, duration - (this.sim.time - this.roundStartedAt)) : 0,
      best: this.best,
      standings,
      feed: this.feed,
      muted: this.audio.isMuted,
      fps: Math.round(this.renderer.fps),
      mode: this.mode,
      skill: this.skill,
      name: this.playerName,
      canSplit:
        you.alive &&
        you.cells.length < MAX_CELLS &&
        you.cells.some((c) => c.mass >= MIN_SPLIT_MASS),
      canEject: you.alive && you.cells.some((c) => c.mass >= 40),
      touch: this.usingTouch,
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Drop into the dish. Also the first user gesture, so audio wakes up here. */
  play(): void {
    this.audio.resume();
    if (this.phase === "playing") return;
    // A finished Blitz round gets a fresh dish. A death in Free for All does
    // not: sliding back into a match already in progress, with the same giant
    // still out there wearing the mass it took off you, is half the appeal.
    const newRound = this.phase === "over" || this.phase === "attract";
    if (this.phase === "over") this.rebuild();
    if (newRound) {
      this.roundStartedAt = this.sim.time;
      this.feed = [];
    }
    // In a timed mode the round is the run, so dying and coming back does not
    // wipe the number you are playing for.
    if (newRound || this.mode === "ffa") this.runPeak = 0;
    this.sim.respawnYou();
    this.phase = "playing";
    this.publish(true);
  }

  /** Back to the title screen, leaving the dish running behind it. */
  quit(): void {
    const you = this.sim.you;
    you.cells.length = 0;
    you.alive = false;
    this.phase = "attract";
    this.publish(true);
  }

  setName(name: string): void {
    this.playerName = name.slice(0, 14) || "you";
    this.sim.you.name = this.playerName;
    this.publish(true);
  }

  setMode(mode: ModeId): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.best = readBest(mode);
    this.rebuild();
  }

  setSkill(skill: SkillId): void {
    if (skill === this.skill) return;
    this.skill = skill;
    this.rebuild();
  }

  /** New dish, same engine. Cheaper and less jarring than tearing the canvas
   *  down, and it keeps the title screen's live background alive throughout. */
  private rebuild(): void {
    this.sim = new BlobSim({ mode: this.mode, skill: this.skill, name: this.playerName });
    this.phase = "attract";
    this.feed = [];
    this.runPeak = 0;
    this.roundStartedAt = 0;
    this.publish(true);
  }

  splitNow(): void {
    if (this.phase !== "playing") return;
    this.sim.requestSplit(0);
  }

  ejectNow(): void {
    if (this.phase !== "playing") return;
    this.sim.requestEject(0);
  }

  toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted);
    this.publish(true);
  }

  resize(): void {
    this.renderer.resize();
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
    this.renderer.dispose();
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
      // The stick is wherever the thumb lands, not a fixed circle in a corner.
      // On a phone held one-handed, a fixed stick is either out of reach or in
      // the way, and which one depends on the hand.
      if (!this.stick.active) {
        this.stick = { ox: x, oy: y, x, y, active: true, id: e.pointerId };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
      this.publish(true);
      return;
    }
    this.mouse = { x, y };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.id) {
      this.stick.active = false;
      this.stick.id = -1;
    }
  };

  /** Right-click is a split on desktop, and the menu it would otherwise open
   *  sits directly on top of the fight you are having. */
  private onContextMenu = (e: Event): void => {
    e.preventDefault();
    this.splitNow();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === " " || e.code === "Space") {
      e.preventDefault();
      this.splitNow();
      return;
    }
    if (k === "w") {
      this.ejectNow();
      this.ejectHeldSince = performance.now();
      this.keys.add("w");
      return;
    }
    if (k === "m") this.toggleMute();
    this.keys.add(k);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = (): void => {
    // Keys held when the window loses focus never send their keyup, and a stuck
    // W spits your whole mass into the dish while you are reading an email.
    this.keys.clear();
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
      if (this.keys.has("w") && now - this.ejectHeldSince > 120) {
        this.ejectHeldSince = now;
        this.ejectNow();
      }
      this.acc += wall;
      let steps = 0;
      // Cap the catch-up: better to run slightly slow for a frame than to
      // spiral, where each long frame schedules more work than the next frame
      // has time for.
      while (this.acc >= TICK && steps < 6) {
        this.sim.step(TICK, think);
        this.acc -= TICK;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      this.drain();
      if (this.phase === "playing") {
        const mass = this.sim.massOf(this.sim.you);
        if (mass > this.runPeak) this.runPeak = mass;
      }
      this.checkEnd();
    }

    this.render(wall);
    this.publish();
  };

  /** Turn whatever the player is doing into a point in the dish. */
  private steer(): void {
    const you = this.sim.you;
    if (!you.alive) {
      // In demo mode nobody is watching to press "again", and a card shot of an
      // empty slot is not a card shot.
      if (this.demo && this.phase === "dead") this.play();
      return;
    }
    if (this.demo) {
      if (!you.brain) you.brain = neutralBrain();
      if (this.sim.time >= you.brain.nextThink) {
        you.brain.nextThink = this.sim.time + 0.12;
        think(this.sim, you);
      }
      this.sim.setAim(0, you.brain.tx, you.brain.ty);
      if (you.brain.wantSplit) {
        you.brain.wantSplit = false;
        this.splitNow();
      }
      return;
    }
    if (this.stick.active) {
      const dx = this.stick.x - this.stick.ox;
      const dy = this.stick.y - this.stick.oy;
      const d = Math.hypot(dx, dy);
      const c = this.sim.centroid(you);
      if (d < 6) {
        // A thumb that has not moved means "stop", not "drift north".
        this.sim.setAim(0, c.x, c.y);
        return;
      }
      // Deflection is throttle: a small push is a slow crawl, which is what
      // makes threading a gap on a phone possible at all.
      const k = Math.min(1, d / 62);
      const reach = 40 + 520 * k;
      this.sim.setAim(0, c.x + (dx / d) * reach, c.y + (dy / d) * reach);
      return;
    }
    if (this.usingTouch) {
      const c = this.sim.centroid(you);
      this.sim.setAim(0, c.x, c.y);
      return;
    }
    if (!this.mouse) return;
    const w = this.renderer.screenToWorld(this.mouse.x, this.mouse.y);
    this.sim.setAim(0, w.x, w.y);
  }

  /** Turn this frame's sim events into pictures and noises. */
  private drain(): void {
    const events = this.sim.events;
    if (!events.length) return;
    for (const e of events) {
      switch (e.type) {
        case "eat": {
          const mine = e.by === 0;
          if (e.mass > 6 || (mine && Math.random() < 0.4)) {
            this.renderer.burst(e.x, e.y, e.hue, e.mass > 40 ? 12 : 4, e.mass > 40 ? 190 : 90);
          }
          if (mine || e.mass > 60) this.audio.eat(e.mass);
          if (mine) {
            // Dent whichever of your cells is nearest the bite.
            const you = this.sim.you;
            let near = you.cells[0];
            let bestD = Infinity;
            for (const c of you.cells) {
              const d = Math.hypot(c.x - e.x, c.y - e.y);
              if (d < bestD) {
                bestD = d;
                near = c;
              }
            }
            if (near) this.renderer.dent(near, e.x, e.y, Math.min(1.4, 0.25 + e.mass * 0.02));
          }
          break;
        }
        case "split":
          if (e.by === 0) {
            this.audio.split();
            this.renderer.ring(e.x, e.y, this.sim.you.hue, 40);
          }
          break;
        case "eject":
          if (e.by === 0) this.audio.eject();
          break;
        case "pop": {
          const hue = this.sim.players[e.by]?.hue ?? 120;
          this.renderer.ring(e.x, e.y, 130, 90);
          this.renderer.burst(e.x, e.y, hue, 22, 260);
          if (e.by === 0) {
            this.audio.pop();
            this.renderer.jolt(14);
          }
          break;
        }
        case "kill": {
          this.pushFeed(`${e.killer} ate ${e.victim}`, e.hue);
          if (e.killer === this.sim.you.name) this.audio.kill();
          break;
        }
        case "death":
          if (e.id === 0) this.onDeath();
          break;
      }
    }
    events.length = 0;
  }

  private pushFeed(text: string, hue: number): void {
    this.feed = [{ id: this.feedId++, text, hue, at: this.sim.time }, ...this.feed].slice(0, 5);
  }

  private onDeath(): void {
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.audio.death();
    this.renderer.jolt(18);
    this.bankScore();
    this.publish(true);
  }

  /** The score is the biggest you ever were, in both modes: the number you
   *  reached and then gambled is more interesting than the one you died at. */
  private bankScore(): void {
    if (this.runPeak > this.best) {
      this.best = this.runPeak;
      writeBest(this.mode, this.runPeak);
      this.audio.fanfare();
    }
  }

  private checkEnd(): void {
    const duration = MODES[this.mode].duration;
    if (!duration || this.phase !== "playing") return;
    if (this.sim.time - this.roundStartedAt < duration) return;
    this.phase = "over";
    this.bankScore();
    this.audio.fanfare();
    this.publish(true);
  }

  private render(dt: number): void {
    const you = this.sim.you;
    const watching = you.alive ? you : this.sim.leader();
    const focus = watching ? this.sim.centroid(watching, this.acc / TICK) : { x: WORLD / 2, y: WORLD / 2 };

    // How much dish to show: keyed to the radius this player would have if all
    // their mass were one cell, then widened if their cells are actually spread
    // out, so a sixteen-way split does not run off the edge of the screen.
    let span = 420;
    if (watching) {
      let mass = 0;
      let spread = 0;
      for (const c of watching.cells) mass += c.mass;
      for (const c of watching.cells) {
        spread = Math.max(spread, Math.hypot(c.x - focus.x, c.y - focus.y) + c.r);
      }
      span = Math.max(radiusOf(mass) * VIEW_SPAN, spread * 1.35, 300);
    }

    this.renderer.draw(this.sim, {
      alpha: Math.min(1, this.acc / TICK),
      youId: 0,
      focusX: focus.x,
      focusY: focus.y,
      span,
      dt,
      stick: this.usingTouch ? this.stick : null,
      dimmed: this.phase !== "playing",
    });
  }
}

/** Re-exported so the page can label its own menus without importing config. */
export { MODES, SKILLS };
