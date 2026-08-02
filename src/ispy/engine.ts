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
/** Sonar pings per attempt. See `fireSonar`. */
const PINGS_PER_ATTEMPT = 3;
const BEST_KEY = "ispy:best";
const COINS_KEY = "ispy:coins";

export type Phase = "attract" | "playing" | "dead" | "won";

export interface ISpyStatus {
  phase: Phase;
  /** 0..100. */
  percent: number;
  best: number;
  attempts: number;
  /** Sonar pings left this attempt. */
  pings: number;
  /**
   * Practice mode. Checkpoints only exist here, exactly as in the original —
   * a normal attempt is the whole level or nothing.
   */
  practice: boolean;
  muted: boolean;
  chapter: string;
  /** Seconds into the current attempt. */
  time: number;
  /** Checkpoints banked this run, and how many the level has. */
  banked: number;
  checkpoints: number;
  /** Coins picked up on this attempt, and coins ever earned by finishing. */
  coins: number;
  coinsEarned: number;
  totalCoins: number;
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
  private pings = PINGS_PER_ATTEMPT;

  /** Sorted x of every checkpoint, and how far through them this run is. */
  private readonly checkpointXs: number[];
  private nextCheckpoint = 0;
  private banked: { p: PlayerState; coins: Set<number> } | null = null;

  /** The three secret coins, by x, and which of them this attempt has. */
  private readonly coinXs: number[];
  private got = new Set<number>();
  private earned = new Set<number>();

  private raf = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private attemptTime = 0;
  private deathAge = 0;
  private sonarAge: number | null = null;

  private hold = false;
  private tapPending = false;
  private camY = -1.7;
  private particles: Particle[] = [];
  private shake = 0;
  private wasGrounded = true;
  /** Reused every frame — the renderer reads it, nobody keeps it. */
  private readonly spectrum = new Float32Array(30);
  private spectrumLive = false;

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
    this.checkpointXs = this.level.objects
      .filter((o) => o.kind === "checkpoint")
      .map((o) => o.x)
      .sort((a, b) => a - b);
    this.coinXs = this.level.objects
      .filter((o) => o.kind === "coin")
      .map((o) => o.x)
      .sort((a, b) => a - b);
    try {
      this.best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
      const saved = JSON.parse(localStorage.getItem(COINS_KEY) ?? "[]");
      if (Array.isArray(saved)) this.earned = new Set(saved.filter((n) => typeof n === "number"));
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
      pings: this.pings,
      practice: this.practice,
      muted: this.audio.isMuted,
      chapter: chapterAt(this.player.x),
      time: this.attemptTime,
      banked: this.nextCheckpoint,
      checkpoints: this.checkpointXs.length,
      coins: this.got.size,
      coinsEarned: this.earned.size,
      totalCoins: this.coinXs.length,
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
    if (!on) this.banked = null;
    this.emit(true);
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.isMuted);
    this.emit(true);
  }

  /**
   * Send a sonar ping. Three per attempt.
   *
   * The mechanic is a *sound*: a pulse goes out, and for a second and a half
   * what comes back is the shape of what is really there — decoys fade, real
   * hazards outline. It used to be an eye, which was the wrong idea for a
   * level about not being able to trust your eyes.
   */
  fireSonar() {
    if (this.phase !== "playing" || this.pings <= 0) return;
    this.pings -= 1;
    this.sonarAge = 0;
    this.audio.sonar();
    this.emit(true);
  }

  /** Where the checkpoints sit, as percentages, for the HUD's progress bar. */
  get checkpointPercents(): number[] {
    return this.checkpointXs.map((x) => (x / this.level.length) * 100);
  }

  resize() {
    this.renderer.resize();
  }

  /** Kill the player on the spot. Used to test that dying resumes correctly. */
  debugKill() {
    if (this.phase !== "playing") return;
    this.player.dead = true;
    this.die();
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
      this.fireSonar();
    } else if (e.code === "KeyR") {
      if (this.phase !== "attract") this.play();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") this.release();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) {
      this.fireSonar();
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

  private restartFrom(p: PlayerState, keepProgress = false) {
    this.player = clonePlayer(p);
    this.attemptTime = 0;
    this.deathAge = 0;
    this.sonarAge = null;
    this.particles = [];
    this.pings = PINGS_PER_ATTEMPT;
    this.camY = Math.max(-1.7, this.player.y - VIEW_H * 0.34);
    this.hold = false;
    this.botHold = false;
    this.botClock = 0;
    this.shake = 0;
    this.wasGrounded = true;
    if (keepProgress && this.banked) {
      // Coins taken after the checkpoint are lost with the run that took them.
      this.got = new Set(this.banked.coins);
    } else {
      this.banked = null;
      this.nextCheckpoint = 0;
      this.got = new Set();
    }
  }

  private die() {
    this.phase = "dead";
    this.deathAge = 0;
    this.shake = 1;
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
    this.burst(38, "#ff2f5e", 13);
    this.emit(true);
  }

  /** A puff of squares at the player. Death, landings, checkpoints. */
  private burst(n: number, color: string, speed: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * speed;
      this.particles.push({
        x: this.player.x, y: this.player.y + 0.5,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s + 3,
        life: 0.4 + Math.random() * 0.5, max: 1, size: 0.1 + Math.random() * 0.24,
        color: Math.random() < 0.45 ? "#ffffff" : color,
      });
    }
  }

  private win() {
    this.phase = "won";
    this.best = 100;
    // Coins are earned by *finishing*, and not in practice — both of those
    // are the original's rules and both are right. A detour you did not
    // survive did not happen, and a run with checkpoints in it is not a run.
    if (!this.practice) for (const c of this.got) this.earned.add(c);
    try {
      localStorage.setItem(BEST_KEY, "100");
      localStorage.setItem(COINS_KEY, JSON.stringify([...this.earned]));
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
      // With a checkpoint banked, dying costs half a second, not a minute.
      if (this.banked && this.practice && this.deathAge > 0.5) {
        this.phase = "playing";
        this.attempts += 1;
        const at = movementAt(this.banked.p.x);
        this.restartFrom(this.banked.p, true);
        // Put the score where the level is. Resuming at 80% should not drop
        // you back into the filtered intro.
        this.audio.seekToMovement(at);
        this.emit(true);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 3.2);

    this.stepParticles(dt);
    if (this.sonarAge !== null) this.sonarAge += dt;
    this.readSpectrum();

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

      // Checkpoints, in practice mode only — the original puts them there and
      // it is the right place for them: a normal attempt is the whole level.
      while (
        this.nextCheckpoint < this.checkpointXs.length &&
        this.player.x >= this.checkpointXs[this.nextCheckpoint]
      ) {
        this.nextCheckpoint += 1;
        if (!attract && this.practice) {
          this.banked = { p: clonePlayer(this.player), coins: new Set(this.got) };
          this.audio.checkpoint();
          this.burst(10, "#7dffd0", 7);
        }
      }

      // Coins. Watched here rather than in the physics for the same reason
      // checkpoints are: picking one up must never be able to affect a
      // trajectory, and the solver must never have to reason about them.
      if (!attract) {
        for (const cx of this.coinXs) {
          if (this.got.has(cx)) continue;
          const o = this.level.objects.find((c) => c.kind === "coin" && c.x === cx);
          if (!o) continue;
          const px = this.player.x;
          const py = this.player.y + 0.5;
          if (px > o.x - 0.4 && px < o.x + o.w + 0.4 && py > o.y - 0.4 && py < o.y + o.h + 0.4) {
            this.got.add(cx);
            this.audio.coin();
            this.burst(16, "#ffd400", 9);
            this.emit(true);
          }
        }
      }

      // The arrangement follows the level through its movements.
      this.audio.setMovement(movementAt(this.player.x));

      // Landing dust, so a jump has a bottom to it.
      if (this.player.onGround && !this.wasGrounded) this.burst(7, "#ffffff", 5);
      this.wasGrounded = this.player.onGround;
    }

    // Camera. Cube sections sit the ground low in frame; the flying modes
    // centre on you, because there is no ground to anchor to.
    // The floor of the camera sits below the floor of the level, so the base
    // is a thing you can see rather than a line the world stops at.
    const anchor = this.player.mode === "cube" || this.player.mode === "ball" ? 0.34 : 0.46;
    const target = Math.max(-1.7, this.player.y - VIEW_H * anchor);
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

  /**
   * Fill the spectrum for this frame, or fake one.
   *
   * Before the first user gesture there is no audio context at all, and the
   * title screen would draw a flat line where the music should be. So when
   * there is nothing real to show, the bars breathe on the beat clock instead
   * — which is honest enough for a menu and much better than a dead graph.
   */
  private readSpectrum() {
    this.spectrumLive = this.audio.spectrum(this.spectrum);
    if (this.spectrumLive) {
      // Silence counts as "nothing to show" too: a muted player, or a browser
      // with no audio sink at all, would otherwise get a dead graph where the
      // music should be. Fall through to the idle animation.
      let total = 0;
      for (const v of this.spectrum) total += v;
      if (total > 0.05) return;
      this.spectrumLive = false;
    }
    const phase = this.audio.beatPhase();
    const thump = Math.pow(1 - phase, 2.4);
    const t = performance.now() / 1000;
    for (let i = 0; i < this.spectrum.length; i++) {
      const tilt = 1 - i / this.spectrum.length;
      const wobble =
        0.55 + 0.45 * Math.sin(t * 1.9 + i * 0.8) * Math.cos(t * 0.7 + i * 0.31);
      this.spectrum[i] = Math.min(1, (0.18 + tilt * 0.62) * (0.4 + thump * 0.8) * wobble);
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
      sonarAge: this.sonarAge,
      dead: this.phase === "dead",
      deathAge: this.deathAge,
      shake: this.shake,
      spectrum: this.spectrum,
      spectrumLive: this.spectrumLive,
      banked: this.nextCheckpoint,
      // Checkpoint banners are a practice-mode object. In a normal attempt
      // they are not there, because in a normal attempt they do nothing.
      showCheckpoints: this.practice,
      collected: this.got,
      dim: this.phase === "attract" ? 0.55 : 0,
    };
  }

  private emit(force: boolean) {
    const s = this.status();
    const key = `${s.phase}|${Math.round(s.percent)}|${s.attempts}|${s.pings}|${
      s.practice
    }|${s.muted}|${s.chapter}|${Math.round(s.best)}|${s.banked}|${s.coins}`;
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

/** Which of the score's six movements belongs at x. */
function movementAt(x: number): number {
  let i = 0;
  CHAPTERS.forEach((c, n) => {
    if (x >= c.at) i = n;
  });
  return i;
}
