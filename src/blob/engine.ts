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
import { aimForCourse, steerCourse, STOPPED, type Course } from "./course";
import { BlobNet, makePeerId, normalizeRoomCode, seedForRoom } from "./net/session";
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
  /** Room code you are in, or null when playing alone. */
  room: string | null;
  /** Joining, joined, or tried and could not reach anybody. */
  netState: "off" | "joining" | "online" | "failed";
  /** People in the room, you included. */
  players: number;
  /** Whether this client is the one simulating the bots. */
  host: boolean;
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
  private stick = { ox: 0, oy: 0, x: 0, y: 0, active: false, id: -1, moved: false };
  private usingTouch = false;
  /**
   * The course a phone player is on — see `course.ts`.
   *
   * It outlives the finger that set it, which is the whole point. A tap with no
   * drag is the brake.
   */
  private drift: Course = STOPPED;
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

  // --- the room ------------------------------------------------------------
  private net: BlobNet | null = null;
  private room: string | null = null;
  private netState: BlobStatus["netState"] = "off";
  private readonly peerId = makePeerId();
  /** Bumped on every join/leave so a slow handshake that resolves after the
   *  player has moved on cannot install itself over the newer one. */
  private joinToken = 0;

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
      room: this.room,
      netState: this.netState,
      players: this.net ? this.net.size : 1,
      host: !this.net || this.net.isHost,
    };
  }

  // -------------------------------------------------------------------------
  // The room
  // -------------------------------------------------------------------------

  /**
   * Join a room, or leave the one you are in by passing null.
   *
   * The dish is rebuilt on the way in, because a room shares its seed: the
   * pellets and the viruses have to be in the same places on every screen or
   * two people are playing different games. Everything else — your name, the
   * mode, the skill — survives.
   */
  async joinRoom(code: string | null): Promise<boolean> {
    /* Leave first, *then* take the token. The other order looks identical and
       is not: `leaveRoom` bumps the counter itself, so a token taken before it
       never matches afterwards, every join bailed out at the guard below, and
       the panel sat on "joining…" forever without a single error anywhere. */
    this.leaveRoom();
    const token = ++this.joinToken;
    const room = code ? normalizeRoomCode(code) : null;
    if (!room) {
      this.rebuild();
      this.publish(true);
      return false;
    }

    this.room = room;
    this.netState = "joining";
    /* A room plays one way, and the page greys the pickers out to say so.
       The roster has to match — bots are addressed by player id, and a client
       that chose Chill would have sixteen where the host has twenty-four — and
       a shared Blitz clock would need a synchronised start nobody has asked
       for yet. Free for All on Standard is what a room is. */
    this.mode = "ffa";
    this.skill = "standard";
    this.best = readBest(this.mode);
    this.publish(true);

    // Dynamic, so a visitor who never opens a room never downloads a socket.
    const { connectRoom } = await import("./net/supabase");
    const transport = await connectRoom(room);
    if (token !== this.joinToken) {
      // They typed another code, or left, while the handshake was in flight.
      transport?.close();
      return false;
    }
    if (!transport) {
      this.netState = "failed";
      this.room = null;
      this.publish(true);
      return false;
    }

    this.rebuild(seedForRoom(room));
    this.net = new BlobNet({
      transport,
      room,
      peerId: this.peerId,
      identity: () => ({ name: this.playerName, hue: this.sim.you.hue }),
    });
    this.netState = "online";
    this.publish(true);
    return true;
  }

  leaveRoom(): void {
    this.joinToken++;
    if (this.net) {
      this.net.dispose();
      this.net = null;
      this.sim.setBotsRemote(false);
      this.sim.virusesFromWire = false;
    }
    this.room = null;
    this.netState = "off";
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
  private rebuild(seed?: number): void {
    // In a room the seed is the room: everyone has to lay out the same pellets
    // and the same viruses, including after a "play again".
    const s = seed ?? (this.room ? seedForRoom(this.room) : undefined);
    this.sim = new BlobSim({ mode: this.mode, skill: this.skill, name: this.playerName, seed: s });
    if (this.net) {
      this.sim.setBotsRemote(!this.net.isHost);
      this.sim.virusesFromWire = !this.net.isHost;
    }
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

  /**
   * Where the player actually is, for the capture and check scripts.
   *
   * `scripts/blob-check.mjs` uses this to prove the phone control keeps you
   * moving after your thumb leaves the glass, which is a thing no screenshot
   * and no unit test can show: the maths is covered in `course.ts`, but only a
   * real browser can tell you the maths is wired to the pointer events.
   */
  probe(): { x: number; y: number; mass: number; cells: number; course: Course } {
    const you = this.sim.you;
    const c = this.sim.centroid(you);
    return {
      x: c.x,
      y: c.y,
      mass: this.sim.massOf(you),
      cells: you.cells.length,
      course: this.drift,
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
    this.leaveRoom();
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
        this.stick = { ox: x, oy: y, x, y, active: true, id: e.pointerId, moved: false };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
      this.publish(true);
      return;
    }
    this.mouse = { x, y };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stick.id) return;
    this.stick.active = false;
    this.stick.id = -1;
    // Lifting off holds the course. A tap that never became a drag is the one
    // way to ask for a full stop — otherwise there is no brake at all, and
    // "nudge yourself still next to a virus" is a real thing to want to do.
    if (!this.stick.moved) this.drift = STOPPED;
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
      /* Networking sits between the sim and the drain on purpose: it reads the
         same event list the effects read, before that list is cleared, so the
         thing that decides a cell was eaten and the thing that puts it on the
         wire are never two different pieces of bookkeeping. */
      this.net?.pump(this.sim, 0);
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
    if (this.usingTouch) {
      if (this.stick.active) {
        const next = steerCourse(
          this.drift,
          this.stick.x - this.stick.ox,
          this.stick.y - this.stick.oy,
        );
        if (next !== this.drift) this.stick.moved = true;
        this.drift = next;
      }
      const c = this.sim.centroid(you);
      const aim = aimForCourse(this.drift, c.x, c.y);
      this.sim.setAim(0, aim.x, aim.y);
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
          // Everybody has to drop the same virus, or one client keeps rendering
          // a mine that is no longer there.
          if (this.sim.owns(e.by)) this.net?.reportPop(e.virus);
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
      heading: this.usingTouch && you.alive ? this.drift : null,
      dimmed: this.phase !== "playing",
    });
  }
}

/** Re-exported so the page can label its own menus without importing config. */
export { MODES, SKILLS };
