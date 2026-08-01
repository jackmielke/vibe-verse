/**
 * The night itself: renderer, clock, power, doors, cameras, and the loop that
 * ties the director to the geometry.
 *
 * The one structural decision worth calling out is that the security cameras
 * are `THREE.PerspectiveCamera`s standing in the same scene you are sitting in.
 * Putting the monitor up doesn't switch scenes, it switches which camera draws.
 * That is why Bonnie can be halfway down the west hall on 2A and then be at
 * your door eight seconds later without anything being faked in between: there
 * was only ever one building, and he walked across it.
 */
import * as THREE from "three";
import { Director, NIGHTS, type AiConfig } from "./ai";
import { makeAnimatronic, setGuitarVisible, type AnimKind, type Animatronic } from "./animatronics";
import { FnafAudio } from "./audio";
import { buildWorld, DOOR_CLOSED_Y, DOOR_OPEN_Y, type BuiltWorld, type ButtonId } from "./build";
import { CAMERA_ORDER, DESK_EYE, pathBetween, ROOMS, YAW_LIMIT, type RoomId } from "./rooms";
import { disposeTextures } from "./textures";

export type Phase = "title" | "playing" | "dead" | "won";
export type Side = "left" | "right";

export interface FnafSnapshot {
  phase: Phase;
  night: number;
  /** 0 = 12 AM … 6 = 6 AM. */
  hour: number;
  power: number;
  usage: number;
  monitorUp: boolean;
  camera: RoomId;
  doors: Record<Side, boolean>;
  lights: Record<Side, boolean>;
  killer: AnimKind | null;
  blackout: boolean;
  toast: string | null;
  /** Who is in which room, for the monitor's map. */
  occupancy: Partial<Record<RoomId, AnimKind[]>>;
  /** Ramps 0 → 1 during the lunge; the HUD uses it to flood the screen. */
  scare: number;
  /** The most recent charge, so the HUD can show what the last press cost. */
  lastSpend: { amount: number; label: string; at: number } | null;
}

/** Seconds of real time per in-game hour. Six of these is a night. */
const HOUR_SECONDS = 50;
/**
 * What each action costs, in percent, charged once at the moment you take it.
 *
 * Nothing drains over time — not while you idle, and not while a door is held
 * shut or the monitor is held up. Jack's rule, twice stated: the only time you
 * lose power is when you *do* something. So the battery is a budget of moves
 * rather than a clock, and the question the game asks changes from "can you
 * afford to keep this shut" to "was that check worth five percent".
 *
 * Only the *committing* half of each pair costs. Opening a door, killing a
 * light and dropping the monitor are all free, so nothing here punishes you
 * for undoing a decision — that would be a drain by another name.
 *
 * Rough budget at these numbers: twenty door closes, or fifty light flicks, or
 * fifty camera checks, or any mix. A busy night spends most of it.
 */
const COST = {
  /** Dropping a door. Raising it again is free. */
  door: 5,
  /** Striking a hall light. Switching it off is free. */
  light: 2,
  /**
   * Raising the monitor. Lowering it, and changing channel, are free — so a
   * check is one flat percent no matter how long you stay on it. Watching the
   * halls is meant to be the thing you can always afford; the doors are where
   * the budget goes.
   */
  monitor: 1,
} as const;

export class FnafEngine {
  readonly audio = new FnafAudio();

  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private world: BuiltWorld;
  private officeCam: THREE.PerspectiveCamera;
  private roomCams = new Map<RoomId, THREE.PerspectiveCamera>();
  private cast: Record<AnimKind, Animatronic>;
  private director!: Director;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private raf = 0;
  private disposed = false;
  private listeners = new Set<(s: FnafSnapshot) => void>();

  /* --- game state ------------------------------------------------------- */
  private phase: Phase = "title";
  private night = 1;
  private elapsed = 0;
  private hour = 0;
  private power = 100;
  private doorsClosed: Record<Side, boolean> = { left: false, right: false };
  private lightsOn: Record<Side, boolean> = { left: false, right: false };
  private monitorUp = false;
  private camera: RoomId = "stage";
  private killer: AnimKind | null = null;
  private blackout = false;
  private blackoutTimer = 0;
  private scare = 0;
  private lastSpend: FnafSnapshot["lastSpend"] = null;
  private toast: string | null = null;
  private toastTimer = 0;

  /* --- view state ------------------------------------------------------- */
  private yawTarget = 0;
  private yaw = 0;
  private pointerX = 0.5;
  private shake = 0;
  /** Gait phase of each character last frame, so we know when a foot lands. */
  private lastPhase: Record<string, number> = {};
  private foxyRunning = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.world = buildWorld();

    this.officeCam = new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 90);
    this.officeCam.position.set(...DESK_EYE);
    this.officeCam.rotation.order = "YXZ";

    for (const id of CAMERA_ORDER) {
      const r = ROOMS[id];
      if (!r.cam) continue;
      const c = new THREE.PerspectiveCamera(r.cam.fov, 16 / 9, 0.05, 90);
      c.position.set(...r.cam.pos);
      c.lookAt(new THREE.Vector3(...r.cam.look));
      this.roomCams.set(id, c);
      // A visible camera housing in the corner of every room, so the building
      // agrees with the monitor about being watched.
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.12, 0.24),
        new THREE.MeshStandardMaterial({ color: 0x16181e, roughness: 0.7 }),
      );
      housing.position.set(...r.cam.pos);
      housing.lookAt(new THREE.Vector3(...r.cam.look));
      this.world.scene.add(housing);
    }

    this.cast = {
      freddy: makeAnimatronic("freddy"),
      bonnie: makeAnimatronic("bonnie"),
      chica: makeAnimatronic("chica"),
      foxy: makeAnimatronic("foxy"),
    };
    for (const a of Object.values(this.cast)) this.world.scene.add(a.root);

    this.bindInput();
    this.resize();
  }

  /* ------------------------------------------------------------ listeners */

  on(cb: (s: FnafSnapshot) => void) {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => this.listeners.delete(cb);
  }

  private snapshot(): FnafSnapshot {
    const occupancy: Partial<Record<RoomId, AnimKind[]>> = {};
    if (this.director) {
      for (const a of Object.values(this.director.agents)) {
        const room = a.atDoor ? a.room : a.room;
        (occupancy[room] ??= []).push(a.kind);
      }
    }
    return {
      phase: this.phase,
      night: this.night,
      hour: this.hour,
      power: Math.max(0, this.power),
      usage: this.usage(),
      monitorUp: this.monitorUp,
      camera: this.camera,
      doors: { ...this.doorsClosed },
      lights: { ...this.lightsOn },
      killer: this.killer,
      blackout: this.blackout,
      toast: this.toast,
      occupancy,
      scare: this.scare,
      lastSpend: this.lastSpend,
    };
  }

  private emit() {
    const s = this.snapshot();
    this.listeners.forEach((l) => l(s));
  }

  private say(msg: string, seconds = 3.5) {
    this.toast = msg;
    this.toastTimer = seconds;
    this.emit();
  }

  /* ------------------------------------------------------------- lifecycle */

  async startNight(night: number) {
    this.night = night;
    this.elapsed = 0;
    this.hour = 0;
    this.power = 100;
    this.doorsClosed = { left: false, right: false };
    this.lightsOn = { left: false, right: false };
    this.monitorUp = false;
    this.camera = "stage";
    this.killer = null;
    this.blackout = false;
    this.blackoutTimer = 0;
    this.scare = 0;
    this.lastSpend = null;
    this.foxyRunning = false;
    this.yaw = this.yawTarget = 0;

    for (const a of Object.values(this.cast)) {
      a.scare = 0;
      a.eyeMats.forEach((m) => (m.emissiveIntensity = 1.35));
    }
    this.park("freddy", "stage");
    this.park("bonnie", "stage");
    this.park("chica", "stage");
    this.park("foxy", "cove");
    setGuitarVisible(this.cast.bonnie, true);
    this.world.coveCurtain.children.forEach((c) => {
      if (c.userData.side) c.position.x = c.userData.side * 1.3;
    });

    const cfg: AiConfig = NIGHTS[Math.min(night, NIGHTS.length) - 1];
    this.director = new Director(cfg, {
      watching: () => (this.monitorUp ? this.camera : null),
      doorClosed: (side) => this.doorsClosed[side],
      moveTo: (kind, room) => this.sendTo(kind, room),
      onArriveAtDoor: (kind, side) => this.arriveAtDoor(kind, side),
      onBlocked: (kind, side) => {
        this.audio.doorBang();
        this.say(
          side === "left" ? "Something heavy leaned on the west door." : "Something heavy leaned on the east door.",
          2.6,
        );
      },
      onKill: (kind) => this.kill(kind),
      onFoxyRun: () => this.startFoxyRun(),
      onFoxyBlocked: (penalty) => {
        // The one charge you do not press a button for — but it is the door
        // you chose to shut, doing the job you shut it for.
        this.audio.doorBang();
        this.spend(penalty, "Impact");
        this.say(`The west door held. It cost you ${penalty}% of the battery.`, 3.2);
      },
      isWalking: (kind) => this.cast[kind].moving(),
    });

    this.phase = "playing";
    await this.audio.resume();
    this.audio.startFan();
    this.audio.startAmbience();
    this.say("12 AM. Six hours. Watch the doors.", 4);
    this.emit();
  }

  start() {
    if (this.raf) return;
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unbindInput();
    this.audio.dispose();
    this.world.dispose();
    disposeTextures();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.listeners.clear();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.officeCam.aspect = aspect;
    this.officeCam.updateProjectionMatrix();
    this.roomCams.forEach((c) => {
      c.aspect = aspect;
      c.updateProjectionMatrix();
    });
  }

  /* ---------------------------------------------------------------- actions */

  toggleDoor(side: Side) {
    // The monitor is in the way. This is the whole reason checking the cameras
    // is a decision and not a free action.
    if (this.phase !== "playing" || this.blackout) return;
    if (this.monitorUp) {
      this.say("You can't reach the buttons with the monitor up.", 2);
      return;
    }
    this.doorsClosed[side] = !this.doorsClosed[side];
    if (this.doorsClosed[side]) {
      this.audio.doorClose();
      this.spend(COST.door, "Door");
    } else {
      this.audio.doorOpen();
    }
    this.emit();
  }

  toggleLight(side: Side) {
    if (this.phase !== "playing" || this.blackout) return;
    if (this.monitorUp) {
      this.say("You can't reach the buttons with the monitor up.", 2);
      return;
    }
    this.lightsOn[side] = !this.lightsOn[side];
    // Only one hall light at a time — there is only one of you.
    if (this.lightsOn[side]) {
      this.lightsOn[side === "left" ? "right" : "left"] = false;
      this.audio.lightOn();
      this.spend(COST.light, "Light");
    } else {
      this.audio.lightOff();
    }
    this.emit();
  }

  toggleMonitor() {
    if (this.phase !== "playing" || this.blackout) return;
    this.monitorUp = !this.monitorUp;
    if (this.monitorUp) {
      this.lightsOn = { left: false, right: false };
      this.audio.lightOff();
      this.audio.camUp();
      this.audio.startCamStatic();
      if (this.camera === "kitchen") this.audio.startKitchenAudio();
      this.spend(COST.monitor, "Cameras");
    } else {
      this.audio.camDown();
      this.audio.stopLoop("camstatic");
      this.audio.stopLoop("kitchen");
    }
    this.emit();
  }

  selectCamera(room: RoomId) {
    if (!this.roomCams.has(room)) return;
    if (this.camera !== room) this.audio.camSwitch();
    this.camera = room;
    this.audio.stopLoop("kitchen");
    if (this.monitorUp && room === "kitchen") this.audio.startKitchenAudio();
    this.emit();
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
  }

  /* ------------------------------------------------------------- placement */

  private slotFor(kind: AnimKind, room: RoomId): [number, number, number, number] {
    const s = this.world.slots.get(`${room}:${kind}`);
    if (s) return [s.position.x, s.position.z, s.rotation.y, s.position.y];
    const b = ROOMS[room].bounds;
    return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, Math.PI, 0];
  }

  private park(kind: AnimKind, room: RoomId) {
    const [x, z, yaw, y] = this.slotFor(kind, room);
    this.cast[kind].teleport(x, z, yaw, y);
    if (kind === "bonnie") setGuitarVisible(this.cast.bonnie, room === "stage");
  }

  /** The director asked for a move; walk them there through the doorways. */
  private sendTo(kind: AnimKind, room: RoomId) {
    const a = this.cast[kind];
    if (kind === "bonnie") setGuitarVisible(a, room === "stage");
    if (kind === "foxy" && room === "cove") {
      // Back behind the curtain, and you never see him do it.
      this.park("foxy", "cove");
      return;
    }
    const from = this.roomOf(a);
    const [x, z, yaw, y] = this.slotFor(kind, room);
    const way = pathBetween(from, room);
    a.walkPath([...way, [x, z]], yaw, kind === "foxy" ? 6.5 : 1.35, y);
  }

  /** Which room a character is standing in right now, by position. */
  private roomOf(a: Animatronic): RoomId {
    const p = a.root.position;
    for (const id of Object.keys(ROOMS) as RoomId[]) {
      const b = ROOMS[id].bounds;
      if (p.x >= b.x0 - 0.4 && p.x <= b.x1 + 0.4 && p.z >= b.z0 - 0.4 && p.z <= b.z1 + 0.4) return id;
    }
    return "dining";
  }

  private arriveAtDoor(kind: AnimKind, side: Side) {
    const room: RoomId = side === "left" ? "westCorner" : "eastCorner";
    this.sendTo(kind, room);
    this.audio.servo(6);
  }

  private startFoxyRun() {
    const foxy = this.cast.foxy;
    this.foxyRunning = true;
    // Out of the cove and straight into the far end of the west hall — the
    // one time in the game something moves faster than you can react.
    foxy.teleport(-4.95, -12.4, Math.PI);
    foxy.walkTo(-3.9, -1.45, Math.PI / 2, 6.5);
    this.audio.foxyRun();
    this.say("Something is running down the west hall.", 2.4);
  }

  private kill(kind: AnimKind) {
    if (this.phase !== "playing") return;
    this.killer = kind;
    this.phase = "dead";
    this.monitorUp = false;
    this.toast = null;
    this.toastTimer = 0;
    this.audio.stopLoop("camstatic");
    this.audio.stopLoop("kitchen");
    this.audio.stopLoop("toreador");
    this.audio.scream();

    // Put them in your face, at the height a person's face would be.
    const a = this.cast[kind];
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    a.teleport(
      this.officeCam.position.x + fwd.x * 1.3,
      this.officeCam.position.z + fwd.z * 1.3,
      this.yaw,
      // Dropped so the head lands at eye level. Standing him on the floor put
      // his jaw above the lens and the lunge became a shot of his chin. This
      // goes through teleport's own `y` so the walk update does not lerp it
      // straight back to the floor on the next frame.
      -0.3,
    );
    a.root.scale.setScalar(1.15);
    this.shake = 1;
    this.emit();
  }

  private win() {
    this.phase = "won";
    this.director?.stop();
    this.audio.stopAll();
    this.audio.sixAm();
    try {
      const best = Number(localStorage.getItem("fnaf:cleared") ?? "0");
      if (this.night > best) localStorage.setItem("fnaf:cleared", String(this.night));
    } catch {
      /* private browsing; the night still counts, just not tomorrow */
    }
    this.emit();
  }

  private usage() {
    return (
      1 +
      (this.doorsClosed.left ? 1 : 0) +
      (this.doorsClosed.right ? 1 : 0) +
      (this.lightsOn.left ? 1 : 0) +
      (this.lightsOn.right ? 1 : 0) +
      (this.monitorUp ? 1 : 0)
    );
  }

  /* ------------------------------------------------------------------ frame */

  private frame() {
    // Clamped so a backgrounded tab doesn't come back and advance the night by
    // a minute in one step. 0.1 rather than 0.05: at 0.05 anything rendering
    // below 20 fps ran the clock in slow motion, which is a strange thing for
    // a weak machine to do to a game about a countdown.
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) {
        this.toast = null;
        this.emit();
      }
    }

    if (this.phase === "playing") {
      this.tickClock(dt);
      if (!this.blackout) this.director.update(dt, this.monitorUp);
      else this.tickBlackout(dt);
    }

    this.tickCast(dt, t);
    this.tickDoorsAndLights(dt, t);
    this.tickView(dt, t);
    this.render(t);
  }

  private tickClock(dt: number) {
    this.elapsed += dt;
    const h = Math.floor(this.elapsed / HOUR_SECONDS);
    if (h !== this.hour) {
      this.hour = h;
      if (this.hour >= 6) {
        this.win();
        return;
      }
      this.director.escalate(this.hour);
      this.audio.click();
      this.emit();
    }
  }

  /**
   * Charge for an action. The only thing in the game that moves the battery —
   * there is no per-frame drain at all, which is why `tickPower` is gone.
   */
  private spend(amount: number, label: string) {
    if (this.blackout || this.phase !== "playing") return;
    this.power -= amount;
    this.lastSpend = { amount, label, at: this.clock.elapsedTime };
    if (this.power <= 0) {
      this.power = 0;
      this.emit();
      this.enterBlackout();
      return;
    }
    this.emit();
  }

  private enterBlackout() {
    this.blackout = true;
    this.blackoutTimer = 0;
    this.doorsClosed = { left: false, right: false };
    this.lightsOn = { left: false, right: false };
    this.monitorUp = false;
    this.world.poweredLights.forEach((l) => (l.intensity = 0));
    this.world.screens.forEach((m) => (m.emissiveIntensity = 0));
    this.audio.stopAll();
    this.audio.powerDown();
    this.say("Power out.", 3);
  }

  /**
   * Out of power. Freddy comes to the west doorway and plays you the Toreador
   * March until it stops, and you spend that time knowing exactly what happens
   * when it stops.
   */
  private tickBlackout(dt: number) {
    this.blackoutTimer += dt;
    const f = this.cast.freddy;
    if (this.blackoutTimer > 3 && this.blackoutTimer - dt <= 3) {
      f.teleport(-3.6, -1.4, Math.PI / 2);
      f.eyeMats.forEach((m) => (m.emissiveIntensity = 3.2));
      this.audio.toreador();
    }
    if (this.blackoutTimer > 3) {
      // Only his eyes. The rest of him is a shape you fill in yourself.
      const pulse = 2.6 + Math.sin(this.blackoutTimer * 3.1) * 0.9;
      f.eyeMats.forEach((m) => (m.emissiveIntensity = pulse));
    }
    if (this.blackoutTimer > 14 + Math.random() * 4) {
      this.audio.stopLoop("toreador");
      this.phase = "playing"; // so kill() takes
      this.kill("freddy");
    }
  }

  private tickCast(dt: number, t: number) {
    for (const a of Object.values(this.cast)) {
      const wasMoving = a.moving();
      a.update(dt, t);

      // A footstep every half gait cycle, scaled by how far away it is.
      const prev = this.lastPhase[a.kind] ?? 0;
      if (Math.floor(a.phase / Math.PI) !== Math.floor(prev / Math.PI) && a.moving()) {
        const d = a.root.position.distanceTo(this.officeCam.position);
        this.audio.step(d, a.kind === "foxy");
      }
      this.lastPhase[a.kind] = a.phase;

      if (this.phase === "dead" && a.kind === this.killer) {
        a.scare = Math.min(1, a.scare + dt * 5);
      }

      // Foxy's sprint ends the moment he stops moving.
      if (a.kind === "foxy" && this.foxyRunning && wasMoving && !a.moving()) {
        this.foxyRunning = false;
        this.director.foxyArrived();
      }
    }

    // Pirate Cove's curtain opens with Foxy's readiness. It is the only
    // warning the game gives you that is purely visual.
    if (this.director) {
      const stage = this.director.agents.foxy.coveStage;
      const open = Math.min(1, stage / 3.2);
      this.world.coveCurtain.children.forEach((c) => {
        const side = c.userData.side as number | undefined;
        if (side) c.position.x = side * (1.3 + open * 1.15);
      });
    }
  }

  private tickDoorsAndLights(dt: number, t: number) {
    for (const side of ["left", "right"] as const) {
      const door = this.world.doors[side];
      const want = this.doorsClosed[side] ? DOOR_CLOSED_Y : DOOR_OPEN_Y;
      door.position.y += (want - door.position.y) * Math.min(1, dt * 7);

      const spot = this.world.hallLights[side];
      const glow = this.world.doorGlow[side];
      // Fluorescents don't come on cleanly; the flicker is free tension.
      const flicker = this.lightsOn[side] ? 0.82 + Math.random() * 0.18 : 0;
      spot.intensity += (flicker * 90 - spot.intensity) * Math.min(1, dt * 14);
      glow.intensity += (flicker * 9 - glow.intensity) * Math.min(1, dt * 14);
      spot.castShadow = spot.intensity > 1;
    }

    // Button faces glow when their function is live.
    for (const b of this.world.buttons) {
      const on = this.isButtonActive(b.id);
      const target = on ? 2.4 : 0.05;
      b.mat.emissiveIntensity += (target - b.mat.emissiveIntensity) * Math.min(1, dt * 12);
      b.mat.emissive.setHex(on ? 0xff3b30 : 0x2a0705);
    }

    // The fan, and the office bulb's slow instability.
    this.world.fan.rotation.z -= dt * 22;
    if (!this.blackout) {
      this.world.officeLight.intensity = 12 * (0.94 + Math.sin(t * 9.3) * 0.03 + Math.random() * 0.03);
      const s = this.world.screens[0];
      if (s?.map) (s.map as THREE.Texture).offset.set(Math.random(), Math.random());
    }
  }

  private isButtonActive(id: ButtonId) {
    if (id === "leftDoor") return this.doorsClosed.left;
    if (id === "rightDoor") return this.doorsClosed.right;
    if (id === "leftLight") return this.lightsOn.left;
    return this.lightsOn.right;
  }

  private tickView(dt: number, t: number) {
    // The chair swivels; it does not get up. See the README.
    this.yawTarget = -(this.pointerX * 2 - 1) * YAW_LIMIT;
    this.yaw += (this.yawTarget - this.yaw) * Math.min(1, dt * 5);

    if (this.phase === "dead" && this.killer) {
      // Screen locked to the thing that got you, shaking.
      const head = new THREE.Vector3();
      this.cast[this.killer].head.getWorldPosition(head);
      this.officeCam.lookAt(head);
      this.shake = Math.max(0, this.shake - dt * 0.55);
      this.officeCam.rotation.x += (Math.random() - 0.5) * 0.09 * this.shake;
      this.officeCam.rotation.y += (Math.random() - 0.5) * 0.09 * this.shake;
      this.officeCam.rotation.z = (Math.random() - 0.5) * 0.06 * this.shake;
      // The lunge has to be *published*, not just rendered. Without this the
      // HUD keeps the snapshot taken at the instant of death, `scare` stays 0,
      // the death card is gated on it — and dying does visibly nothing.
      const before = this.scare;
      this.scare = this.cast[this.killer].scare;
      if (this.scare !== before) this.emit();
      return;
    }

    this.officeCam.rotation.set(
      -0.055 + Math.sin(t * 0.6) * 0.004,
      this.yaw,
      Math.sin(t * 0.43) * 0.003,
      "YXZ",
    );
    this.officeCam.position.set(
      DESK_EYE[0] + Math.sin(t * 0.5) * 0.012,
      DESK_EYE[1] + Math.sin(t * 0.9) * 0.008,
      DESK_EYE[2],
    );
  }

  private render(t: number) {
    let cam = this.officeCam;
    if (this.monitorUp) {
      const rc = this.roomCams.get(this.camera);
      if (rc) {
        // Cheap camera-shake so the feed reads as a feed, not a render.
        const r = ROOMS[this.camera].cam!;
        rc.position.set(
          r.pos[0] + Math.sin(t * 1.7) * 0.012,
          r.pos[1] + Math.sin(t * 2.3) * 0.009,
          r.pos[2],
        );
        rc.lookAt(new THREE.Vector3(...r.look));
        rc.rotation.z += Math.sin(t * 0.8) * 0.004;
        cam = rc;
      }
    }
    this.renderer.render(this.world.scene, cam);
  }

  /* ------------------------------------------------------------------ input */

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };

  private onPointerDown = () => {
    if (this.phase !== "playing" || this.monitorUp || this.blackout) return;
    this.raycaster.setFromCamera(this.pointer, this.officeCam);
    const hits = this.raycaster.intersectObjects(
      this.world.buttons.map((b) => b.mesh),
      false,
    );
    const id = hits[0]?.object.userData.button as ButtonId | undefined;
    if (!id) return;
    if (id === "leftDoor") this.toggleDoor("left");
    else if (id === "rightDoor") this.toggleDoor("right");
    else if (id === "leftLight") this.toggleLight("left");
    else this.toggleLight("right");
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.phase !== "playing") return;
    const k = e.key.toLowerCase();
    if (k === "a") this.toggleDoor("left");
    else if (k === "d") this.toggleDoor("right");
    else if (k === "q") this.toggleLight("left");
    else if (k === "e") this.toggleLight("right");
    else if (k === " ") {
      e.preventDefault();
      this.toggleMonitor();
    } else if (k === "w" || k === "s" || k === "arrowup" || k === "arrowdown") {
      // You asked. The answer is no, and the answer is the game.
      this.say("You don't leave the office. That's the whole job.", 2.6);
    } else if (this.monitorUp) {
      const idx = "1234567890-".indexOf(k);
      if (idx >= 0 && idx < CAMERA_ORDER.length) this.selectCamera(CAMERA_ORDER[idx]);
    }
  };

  private bindInput() {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("keydown", this.onKey);
  }

  private unbindInput() {
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("keydown", this.onKey);
  }
}
