/**
 * I SPY — the engine.
 *
 * Owns the canvas, the clock, the input and the run. React never sees a frame:
 * it subscribes to `ISpyStatus` and re-renders the HUD when something it cares
 * about changes, which is a few times a second rather than sixty.
 *
 * The loop is a fixed 240 Hz accumulator. That matters more here than in most
 * worlds: this is a memorisation game, and a level that behaves differently on
 * a 144 Hz monitor than on a 60 Hz laptop is not memorisable.
 */
import { ISpyAudio } from "./audio";
import { botDecision, corridorAt, DECISION_DT } from "./bot";
import { buildISpy, CHAPTERS } from "./level";
import { clonePlayer, initialState, step, World } from "./physics";
import { Renderer, VIEW_H, type Particle, type RenderState } from "./render";
import type { Level, PlayerState } from "./types";

const TICK = 1 / 240;
const MAX_FRAME = 0.25;
const PULSES_PER_ATTEMPT = 3;
const BEST_KEY = "ispy:best";

export type Phase = "attract" | "playing" | "dead" | "won";

export interface ISpyStatus {
  phase: Phase;
  /** 0..100. */
  percent: number;
  best: number;
  attempts: number;
  pulses: number;
  practice: boolean;
  muted: boolean;
  chapter: string;
  /** Seconds into the current attempt. */
  time: number;
}

export class ISpyEngine {
  readonly level: Level;
  private readonly world: World;
  private readonly renderer: Renderer;
  readonly audio = new ISpyAudio();

  private player: PlayerState;
  private phase: Phase = "attract";
  private attempts = 0;
  private best = 0;
  private practice = false;
  private pulses = PULSES_PER_ATTEMPT;

  private raf = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private attemptTime = 0;
  private deathAge = 0;
  private pulseAge: number | null = null;

  private hold = false;
  private tapPending = false;
  private camY = -0.6;
  private particles: Particle[] = [];

  /** Practice checkpoints: a rolling window of recent safe states. */
  private snapshots: Array<{ p: PlayerState; t: number }> = [];
  private sinceSnapshot = 0;

  /** Attract mode drives the same input the player would. */
  private botHold = false;
  private botClock = 0;
  private autopilot = false;
  private paused = false;

  private listeners = new Set<(s: ISpyStatus) => void>();
  private lastStatus = "";
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.level = buildISpy();
    this.world = new World(this.level);
    this.renderer = new Renderer(canvas, this.level);
    this.player = initialState(this.level);
    try {
      this.best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      this.best = 0;
    }
    this.bindInput();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ── public surface ─────────────────────────────────────────────────────

  subscribe(fn: (s: ISpyStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status());
    return () => this.listeners.delete(fn);
  }

  status(): ISpyStatus {
    return {
      phase: this.phase,
      percent: Math.min(100, (this.player.x / this.level.length) * 100),
      best: this.best,
      attempts: this.attempts,
      pulses: this.pulses,
      practice: this.practice,
      muted: this.audio.isMuted,
      chapter: chapterAt(this.player.x),
      time: this.attemptTime,
    };
  }

  /** Start (or restart) a real attempt. */
  play() {
    this.phase = "playing";
    this.attempts += 1;
    this.restartFrom(initialState(this.level));
    this.audio.start();
    this.audio.restart();
    this.emit(true);
  }

  /** Back to the title screen, where the bot plays it for you. */
  attract() {
    this.phase = "attract";
    this.restartFrom(initialState(this.level));
    this.emit(true);
  }

  setPractice(on: boolean) {
    this.practice = on;
    this.snapshots = [];
    this.emit(true);
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.isMuted);
    this.emit(true);
  }

  /** Spend a pulse: for a second and a half, the level stops lying. */
  firePulse() {
    if (this.phase !== "playing" || this.pulses <= 0) return;
    this.pulses -= 1;
    this.pulseAge = 0;
    this.audio.pulse();
    this.emit(true);
  }

  resize() {
    this.renderer.resize();
  }

  /**
   * Freeze the simulation but keep drawing. `scripts/ispy-shot.mjs` needs it:
   * grabbing a PNG out of a headless browser and re-encoding it takes seconds,
   * and without this the level has run on — and usually died and restarted —
   * by the time the shutter closes.
   */
  debugPause(on: boolean) {
    this.paused = on;
    this.lastFrame = performance.now();
  }

  /**
   * Hand a real attempt over to the bot. `scripts/ispy-shot.mjs --run` uses it
   * to play the level through the actual playing phase — menus, HUD, death,
   * the finish — which the attract loop deliberately does not exercise.
   */
  debugAutopilot(on: boolean) {
    this.autopilot = on;
  }

  /**
   * Drop the player at `x`, in whatever mode the portals before `x` would
   * have given them, floating in the middle of whatever gap is there.
   *
   * Only used by `scripts/ispy-shot.mjs`, which needs a real frame from each
   * of the six movements without playing through to them. It is a teleport,
   * not a cheat: it is unreachable from the running game.
   */
  debugSeek(x: number) {
    const p = initialState(this.level);
    for (const o of this.level.objects) {
      if (o.kind !== "portal" || o.x > x) continue;
      if (o.to) p.mode = o.to;
      if (o.grav !== undefined) p.grav = o.grav;
      if (o.speed !== undefined) p.speed = o.speed;
    }
    p.x = x;
    if (p.mode === "cube") p.y = 0;
    else {
      // Widest gap, not the gap nearest some arbitrary height — a wave tube
      // whose centreline has wandered up to y = 6 is not near y = 3, and
      // dropping the player under its floor photographs a death, not a level.
      let best: [number, number] = [0, 4];
      for (let y = 0.5; y < 14; y += 0.5) {
        const gap = corridorAt(this.world, x, y);
        // Bounded gaps only. The open sky above a tunnel roof is the widest
        // gap at every x in the ship section, and it is not where the level is.
        if (gap[1] > 20) continue;
        if (gap[1] - gap[0] > best[1] - best[0]) best = gap;
      }
      p.y = Math.min(best[0] + (best[1] - best[0]) / 2, 30);
    }
    this.restartFrom(p);
    this.emit(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbindInput();
    this.audio.dispose();
    this.listeners.clear();
  }

  // ── input ──────────────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      this.press();
    } else if (e.code === "KeyE" || e.code === "KeyQ") {
      e.preventDefault();
      this.firePulse();
    } else if (e.code === "KeyR") {
      if (this.phase !== "attract") this.play();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") this.release();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) {
      this.firePulse();
      return;
    }
    this.canvas.setPointerCapture?.(e.pointerId);
    this.press();
  };

  private onPointerUp = () => this.release();
  private onContextMenu = (e: Event) => e.preventDefault();
  private onBlur = () => this.release();

  private press() {
    if (this.phase === "attract") return;
    // Dying and pressing again is the whole loop of this genre — no menu.
    // Order matters: `play` clears the button, so claim it afterwards, or a
    // player who never let go loses their first jump of the new attempt.
    if (this.phase === "dead") this.play();
    this.hold = true;
    this.tapPending = true;
  }

  private release() {
    this.hold = false;
  }

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  private unbindInput() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  // ── the run ────────────────────────────────────────────────────────────

  private restartFrom(p: PlayerState) {
    this.player = clonePlayer(p);
    this.attemptTime = 0;
    this.deathAge = 0;
    this.pulseAge = null;
    this.particles = [];
    this.pulses = PULSES_PER_ATTEMPT;
    this.snapshots = [];
    this.sinceSnapshot = 0;
    this.camY = Math.max(-0.6, this.player.y - VIEW_H * 0.34);
    this.hold = false;
    this.botHold = false;
    this.botClock = 0;
  }

  private die() {
    this.phase = "dead";
    this.deathAge = 0;
    this.audio.death();
    const pct = (this.player.x / this.level.length) * 100;
    if (pct > this.best) {
      this.best = pct;
      try {
        localStorage.setItem(BEST_KEY, String(pct));
      } catch {
        /* private browsing — the run still counts, it just will not persist */
      }
    }
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 12;
      this.particles.push({
        x: this.player.x, y: this.player.y + 0.5,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s + 4,
        life: 0.55 + Math.random() * 0.5, max: 1, size: 0.12 + Math.random() * 0.3,
        color: Math.random() < 0.5 ? "#ffffff" : "#ff2f5e",
      });
    }
    this.emit(true);
  }

  private win() {
    this.phase = "won";
    this.best = 100;
    try {
      localStorage.setItem(BEST_KEY, "100");
    } catch {
      /* nothing to do */
    }
    this.audio.win();
    this.emit(true);
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.lastFrame) / 1000, MAX_FRAME);
    this.lastFrame = now;

    if (this.paused) {
      this.renderer.draw(this.renderState());
      return;
    }
    if (this.phase === "playing" || this.phase === "attract") this.simulate(dt);
    else if (this.phase === "dead") {
      this.deathAge += dt;
      // Practice mode rewinds instead of restarting: back to where you were
      // about a second ago, which is what a checkpoint is for.
      if (this.practice && this.deathAge > 0.45) {
        const snap = this.snapshots[0];
        if (snap) {
          this.phase = "playing";
          const t = this.attemptTime;
          this.restartFrom(snap.p);
          this.attemptTime = Math.max(0, t - 1);
          this.emit(true);
        } else {
          this.play();
        }
      }
    }

    this.stepParticles(dt);
    if (this.pulseAge !== null) this.pulseAge += dt;

    this.renderer.draw(this.renderState());
    this.emit(false);
  };

  private simulate(dt: number) {
    this.accumulator = Math.min(this.accumulator + dt, 0.3);
    const attract = this.phase === "attract";
    const useBot = attract || this.autopilot;

    while (this.accumulator >= TICK) {
      this.accumulator -= TICK;
      this.attemptTime += TICK;

      if (useBot) {
        this.botClock += TICK;
        if (this.botClock >= DECISION_DT) {
          this.botClock -= DECISION_DT;
          this.botHold = botDecision(this.player, this.world).hold;
        }
      }

      // `tap` is the rising edge of the button — orbs and the ball's gravity
      // flip want the press, not the hold.
      const hold = useBot ? this.botHold : this.hold;
      const tap = useBot ? this.botHold && this.botClock < TICK * 1.5 : this.tapPending;
      this.tapPending = false;

      step(this.player, this.world, TICK, { hold, tap });

      if (this.player.dead) {
        if (attract) {
          this.restartFrom(initialState(this.level));
          return;
        }
        this.die();
        return;
      }
      if (this.player.x >= this.level.length) {
        if (attract) {
          this.restartFrom(initialState(this.level));
          return;
        }
        this.win();
        return;
      }

      // Rolling checkpoints. Kept even outside practice mode so that turning
      // it on mid-run does something sensible.
      this.sinceSnapshot += TICK;
      if (this.sinceSnapshot >= 0.4) {
        this.sinceSnapshot = 0;
        this.snapshots.unshift({ p: clonePlayer(this.player), t: this.attemptTime });
        if (this.snapshots.length > 4) this.snapshots.pop();
      }
    }

    // Camera. Cube sections sit the ground low in frame; the flying modes
    // centre on you, because there is no ground to anchor to.
    const anchor = this.player.mode === "cube" || this.player.mode === "ball" ? 0.34 : 0.46;
    const target = Math.max(-0.6, this.player.y - VIEW_H * anchor);
    const k = 1 - Math.pow(0.0008, dt);
    this.camY += (target - this.camY) * k;

    // Trail.
    if (this.player.mode !== "cube" || !this.player.onGround) {
      if (Math.random() < 0.55) {
        this.particles.push({
          x: this.player.x - 0.4, y: this.player.y + 0.5,
          vx: -2 - Math.random() * 3, vy: (Math.random() - 0.5) * 2,
          life: 0.3, max: 0.3, size: 0.14 + Math.random() * 0.12,
          color: "#ffffff",
        });
      }
    }
  }

  private stepParticles(dt: number) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 26 * dt;
    }
    if (this.particles.length > 260) this.particles.splice(0, this.particles.length - 260);
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private renderState(): RenderState {
    return {
      player: this.player,
      camX: this.player.x,
      camY: this.camY,
      time: this.attemptTime,
      beat: this.audio.beatPhase(),
      particles: this.particles,
      pulseAge: this.pulseAge,
      dead: this.phase === "dead",
      deathAge: this.deathAge,
      dim: this.phase === "attract" ? 0.55 : 0,
    };
  }

  private emit(force: boolean) {
    const s = this.status();
    const key = `${s.phase}|${Math.round(s.percent)}|${s.attempts}|${s.pulses}|${
      s.practice
    }|${s.muted}|${s.chapter}|${Math.round(s.best)}`;
    if (!force && key === this.lastStatus) return;
    this.lastStatus = key;
    for (const fn of this.listeners) fn(s);
  }
}

function chapterAt(x: number): string {
  let name = CHAPTERS[0].name;
  for (const c of CHAPTERS) if (x >= c.at) name = c.name;
  return name;
}
