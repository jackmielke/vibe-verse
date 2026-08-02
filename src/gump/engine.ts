/**
 * The engine: one renderer, one scene, one camera, six chapters, and the bench
 * they are all told from.
 *
 * The engine deliberately knows nothing about any chapter's rules. It owns the
 * things a chapter must not own twice — the WebGL context, the clock, the
 * input state, the sky — hands over a `THREE.Group` and asks for a HUD back.
 * Swapping chapters is `dispose()`, `root.clear()`, build the next one. That
 * is the only reason a boat race, a table tennis match and a run across
 * America can share a page without any of them leaking into the others.
 *
 * The sky is lerped rather than set, because three of the beats change the
 * light mid-run — dusk falling on the highway is a mood, and a hard cut is a
 * bug report.
 */
import * as THREE from "three";
import { GumpAudio } from "./audio";
import { CHAPTERS, makeChapter } from "./chapters";
import { benchProp, busStopSign, chocolateBox, driftFeather, feather, oakTree, disposePropCache } from "./props";
import { disposeRigCache, LOOKS, makeHuman, type Human } from "./rig";
import { disposeTextureCache } from "./textures";
import type { Chapter, ChapterHud, GumpInput, GumpSnapshot } from "./types";

const IDLE_HUD: ChapterHud = {
  progress: 0,
  stat: "0",
  statLabel: "",
  outcome: "running",
};

/**
 * Late afternoon in Greenbow, which is the light the whole framing device is
 * lit by: warm, low, and about an hour off dusk. Top, bottom, fog, density.
 */
const BENCH_SKY: [number, number, number, number] = [0x63a8d8, 0xf0d8b0, 0xdcd0b8, 0.004];

/** A deterministic generator, so a chapter looks the same twice running. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export class GumpEngine {
  readonly audio = new GumpAudio();

  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;

  private chapterRoot = new THREE.Group();
  private benchRoot = new THREE.Group();
  private chapter: Chapter | null = null;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  private listeners = new Set<(s: GumpSnapshot) => void>();

  /* --- sky ------------------------------------------------------------- */
  private skyTop = new THREE.Color(0x7fc0e8);
  private skyBottom = new THREE.Color(0xd8e4d0);
  private skyTargetTop = new THREE.Color(0x7fc0e8);
  private skyTargetBottom = new THREE.Color(0xd8e4d0);
  private fogColor = new THREE.Color(0xc6d6c0);
  private fogTarget = new THREE.Color(0xc6d6c0);
  private fogDensity = 0.006;
  private fogDensityTarget = 0.006;
  private skyDirty = true;

  /* --- input ----------------------------------------------------------- */
  readonly input: GumpInput = {
    steer: 0,
    jump: false,
    jumpPressed: false,
    boost: false,
    actionPressed: false,
  };
  private keys = new Set<string>();
  private touchId: number | null = null;
  private touchOrigin = 0;
  private touchStart = 0;
  private touchMoved = 0;
  private touchSteer = 0;
  private touchBoost = false;
  private queuedAction = false;

  /* --- run state -------------------------------------------------------- */
  private phase: GumpSnapshot["phase"] = "bench";
  private index = 0;
  private hud: ChapterHud = IDLE_HUD;
  private toast: string | null = null;
  private toastUntil = 0;
  private narration: string | null = null;
  private money = 0;
  private chocolates = 0;
  private miles = 0;
  private cleared = 0;
  private time = 0;

  /* --- the bench -------------------------------------------------------- */
  private benchVibey: Human | null = null;
  private benchFeather: THREE.Object3D | null = null;
  private featherT = 0;
  private featherOrigin = new THREE.Vector3(2.4, 7, 1.5);

  /**
   * Takes a container, and makes its own canvas inside it.
   *
   * This is not a style preference. Teardown calls `forceContextLoss()` to
   * hand the GPU back straight away rather than waiting for a collector — and
   * a canvas whose context has been force-lost will never give out another
   * one. Hand the engine a canvas that outlives it (a React ref, say) and the
   * *second* mount gets `null` back from `getContext` and a world that says it
   * failed to boot. Owning the element means teardown takes it with it and
   * every mount starts on a clean one.
   */
  constructor(host: HTMLElement) {
    this.host = host;
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full touch-none select-none outline-none";
    host.appendChild(canvas);
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !matchMedia("(pointer: coarse)").matches,
      powerPreference: "high-performance",
    });
    // A phone will happily render this at 3× and then run it at 20 fps. The
    // cap costs nothing anybody can see and is the difference between the
    // finale being playable on a phone and not.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, matchMedia("(pointer: coarse)").matches ? 1.6 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
    this.camera.position.set(0, 3.1, 7.4);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x5a5240, 1.15);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 1.5);
    this.sun.position.set(-40, 60, 30);
    this.scene.add(this.hemi, this.sun, this.chapterRoot, this.benchRoot);
    this.scene.fog = new THREE.FogExp2(this.fogColor.getHex(), this.fogDensity);

    this.skyCanvas.width = 2;
    this.skyCanvas.height = 256;
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.skyTex.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = this.skyTex;
    this.paintSky();

    this.buildBench();
    this.setSky(...BENCH_SKY);
    this.snapSky();
    this.resize();
    this.bindInput();
  }

  /* ================================================================ input */

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
    if (this.keys.has(e.code)) return; // held: no repeat presses
    this.keys.add(e.code);
    if (["Space", "ArrowUp", "KeyW"].includes(e.code)) this.queuedAction = true;
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.touchId = null;
    this.touchSteer = 0;
    this.touchBoost = false;
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.touchId !== null) {
      // A second finger anywhere is the boost. Nobody has to be told, and it
      // beats a button that sits on top of the thing you are steering with.
      this.touchBoost = true;
      return;
    }
    this.touchId = e.pointerId;
    this.touchOrigin = e.clientX;
    this.touchStart = performance.now();
    this.touchMoved = 0;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.touchId) return;
    const dx = e.clientX - this.touchOrigin;
    this.touchMoved = Math.max(this.touchMoved, Math.abs(dx));
    // Normalised against a thumb's worth of travel, not the screen — a phone
    // in one hand cannot reach across the display and should not have to.
    const reach = Math.min(150, window.innerWidth * 0.28);
    this.touchSteer = THREE.MathUtils.clamp(dx / reach, -1, 1);
    // The origin follows the finger back in, so you can re-centre without
    // lifting off: at full lock the anchor is dragged along with you.
    if (Math.abs(dx) > reach) this.touchOrigin = e.clientX - Math.sign(dx) * reach;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.touchId) {
      this.touchBoost = false;
      return;
    }
    const quick = performance.now() - this.touchStart < 260 && this.touchMoved < 14;
    if (quick) this.queuedAction = true;
    this.touchId = null;
    this.touchSteer = 0;
    this.touchBoost = false;
  };

  /**
   * Wall-clock multiplier. Only ever moved by the screenshot harness, which
   * has to reach a beat at 80% of a five-kilometre chapter without anybody
   * sitting there for four minutes to watch it happen.
   */
  timeScale = 1;

  /** Paired with `timeScale`, and equally only ever touched by the harness. */
  readonly debug = { immortal: false };

  /** The HUD's on-screen buttons come through here. */
  tap() {
    this.queuedAction = true;
  }

  setBoost(on: boolean) {
    this.touchBoost = on;
  }

  private pollInput() {
    const k = this.keys;
    const keySteer =
      (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
    this.input.steer = THREE.MathUtils.clamp(keySteer + this.touchSteer, -1, 1);
    this.input.jump = k.has("Space") || k.has("ArrowUp") || k.has("KeyW");
    this.input.boost = k.has("ShiftLeft") || k.has("ShiftRight") || this.touchBoost;
    this.input.jumpPressed = this.queuedAction;
    this.input.actionPressed = this.queuedAction;
    this.queuedAction = false;
  }

  /* ================================================================== sky */

  private setSky = (top: number, bottom: number, fog: number, density: number) => {
    this.skyTargetTop.setHex(top);
    this.skyTargetBottom.setHex(bottom);
    this.fogTarget.setHex(fog);
    this.fogDensityTarget = density;
  };

  /**
   * Jump straight to the target. Used when a chapter loads, where there is no
   * continuity to preserve — a two-second fade from the last chapter's noon
   * into this chapter's jungle just looks like the lighting is broken.
   */
  private snapSky() {
    this.skyTop.copy(this.skyTargetTop);
    this.skyBottom.copy(this.skyTargetBottom);
    this.fogColor.copy(this.fogTarget);
    this.fogDensity = this.fogDensityTarget;
    this.skyDirty = true;
  }

  /**
   * One 2×256 canvas, repainted in place.
   *
   * The obvious version of this — ask a cache for the texture matching the
   * current colour pair — leaks a gradient per frame while the sky is moving,
   * because a lerp visits a new colour pair every single frame. Owning one
   * canvas and setting `needsUpdate` is both cheaper and impossible to leak.
   */
  private skyCanvas = document.createElement("canvas");
  private skyTex: THREE.CanvasTexture;

  private paintSky() {
    const c = this.skyCanvas.getContext("2d")!;
    const grad = c.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, `#${this.skyTop.getHexString()}`);
    grad.addColorStop(1, `#${this.skyBottom.getHexString()}`);
    c.fillStyle = grad;
    c.fillRect(0, 0, 2, 256);
    this.skyTex.needsUpdate = true;
  }

  private stepSky(dt: number) {
    const k = Math.min(1, dt * 1.6);
    const before = this.skyTop.getHex() + this.skyBottom.getHex();
    this.skyTop.lerp(this.skyTargetTop, k);
    this.skyBottom.lerp(this.skyTargetBottom, k);
    this.fogColor.lerp(this.fogTarget, k);
    this.fogDensity += (this.fogDensityTarget - this.fogDensity) * k;

    if (this.skyDirty || before !== this.skyTop.getHex() + this.skyBottom.getHex()) {
      this.skyDirty = false;
      this.paintSky();
    }
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.fogColor);
    fog.density = this.fogDensity;

    // The light follows the sky. Without this, dusk is a blue backdrop behind
    // a world that is still lit like noon.
    this.hemi.color.copy(this.skyTop).lerp(new THREE.Color(0xffffff), 0.35);
    this.hemi.groundColor.copy(this.fogColor).multiplyScalar(0.5);
    this.sun.color.copy(this.skyBottom).lerp(new THREE.Color(0xffffff), 0.55);
    const bright = (this.skyTop.r + this.skyTop.g + this.skyTop.b) / 3;
    this.sun.intensity = 0.5 + bright * 1.5;
    this.hemi.intensity = 0.6 + bright * 0.9;
  }

  /* ================================================================ bench */

  /**
   * The bus stop. It is the title screen, and it is also the answer to "what
   * do you look at between chapters" — the story is told from this bench, so
   * coming back to it after every beat is not decoration, it is the framing
   * device the film is built on.
   */
  private buildBench() {
    const root = this.benchRoot;
    const rng = makeRng(7);

    const walk = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshLambertMaterial({ color: 0x6f8a4a }),
    );
    walk.rotation.x = -Math.PI / 2;
    root.add(walk);

    const pave = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 60),
      new THREE.MeshLambertMaterial({ color: 0xcfc8b4 }),
    );
    pave.rotation.x = -Math.PI / 2;
    pave.position.set(0, 0.01, 0);
    root.add(pave);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 60),
      new THREE.MeshLambertMaterial({ color: 0x4a4d52 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(10.5, 0.005, 0);
    root.add(road);

    const bench = benchProp();
    bench.position.set(0, 0, 0);
    root.add(bench);

    const sign = busStopSign();
    sign.position.set(2.4, 0, 0.4);
    root.add(sign);

    const v = makeHuman(LOOKS.plaid);
    v.sit();
    /*
     * Negative. The rig's origin is the floor under a *standing* man, with the
     * hips 0.92 m above it — so seating him on a 0.5 m bench means dropping
     * the whole group by the difference, not raising it to the seat. Raising
     * it, which is the obvious thing to type, stands him on the bench.
     */
    v.group.position.set(-0.25, -0.37, 0.04);
    v.group.rotation.y = 0.12;
    root.add(v.group);
    this.benchVibey = v;

    const box = chocolateBox();
    box.position.set(0.72, 0.52, 0.05);
    box.rotation.y = -0.3;
    root.add(box);

    for (let i = 0; i < 9; i++) {
      const t = oakTree(rng);
      const a = (i / 9) * Math.PI * 2;
      t.position.set(Math.cos(a) * (14 + rng() * 16) - 6, 0, Math.sin(a) * (14 + rng() * 16) - 8);
      t.scale.setScalar(0.9 + rng() * 0.5);
      root.add(t);
    }

    const f = feather();
    root.add(f);
    this.benchFeather = f;
  }

  private updateBench(dt: number) {
    this.featherT += dt;
    if (this.benchFeather) {
      driftFeather(this.benchFeather, this.featherT, this.featherOrigin, 1.3);
      // Let it land, rest a moment, and go again. A feather that loops the
      // instant it touches down reads as a looping animation; one that waits
      // reads as the wind picking it back up.
      if (this.featherT > 13) this.featherT = -1.5;
    }
    this.benchVibey?.sit();

    /*
     * A slow drift around the bench.
     *
     * The aim point is deliberately *not* the bench. Orbiting a thing while
     * looking at it pins it dead centre, which is exactly where the title
     * goes — two attempts at this had Vibey sitting behind his own name.
     * Aiming a metre and a half to one side slides him left of frame and
     * leaves the middle as sky and grass for the type to sit on.
     */
    const t = this.time * 0.09;
    const r = 6.6 + Math.sin(this.time * 0.13) * 0.6;
    this.camera.position.set(
      Math.sin(t) * r + 0.6,
      2.6 + Math.sin(this.time * 0.2) * 0.16,
      Math.cos(t) * r + 2.2,
    );
    this.camera.fov += (46 - this.camera.fov) * Math.min(1, 2 * dt);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(1.7, 0.7, 0);
  }

  /* ============================================================== chapters */

  /** Build a chapter and hold it on its title card until the player says go. */
  begin(index: number) {
    this.index = THREE.MathUtils.clamp(index, 0, CHAPTERS.length - 1);
    this.teardownChapter();
    this.benchRoot.visible = false;
    this.audio.resume();

    const meta = CHAPTERS[this.index];
    this.chapter = makeChapter(meta.id, {
      root: this.chapterRoot,
      scene: this.scene,
      camera: this.camera,
      audio: this.audio,
      input: this.input,
      rng: makeRng(1000 + this.index * 977),
      setSky: this.setSky,
      debug: this.debug,
      say: (line) => {
        this.toast = line;
        this.toastUntil = this.time + 4.2;
      },
    });
    this.snapSky();
    this.phase = "card";
    this.narration = meta.card;
    this.toast = null;
    this.hud = IDLE_HUD;
    this.emit();
  }

  /** Leave the card. */
  go() {
    if (this.phase !== "card") return;
    this.audio.resume();
    this.phase = "playing";
    this.narration = null;
    this.emit();
  }

  retry() {
    this.begin(this.index);
  }

  next() {
    if (this.index + 1 < CHAPTERS.length) this.begin(this.index + 1);
    else this.finale();
  }

  toBench() {
    this.teardownChapter();
    this.benchRoot.visible = true;
    this.phase = "bench";
    this.narration = null;
    this.setSky(...BENCH_SKY);
    this.audio.music(196, 0.5);
    this.emit();
  }

  /** Start again from the top, totals cleared. */
  restart() {
    this.money = 0;
    this.chocolates = 0;
    this.miles = 0;
    this.cleared = 0;
    this.toBench();
  }

  private finale() {
    this.teardownChapter();
    this.benchRoot.visible = true;
    this.featherT = 0;
    this.phase = "finale";
    this.narration =
      "He ran because he felt like running. Then one day he stopped, and went home.";
    this.audio.music(262, 0.44);
    this.audio.fanfare();
    this.emit();
  }

  private teardownChapter() {
    this.chapter?.dispose();
    this.chapter = null;
    this.chapterRoot.clear();
    this.audio.stopAllLoops();
  }

  /**
   * The chapter has ended. Fold its takings into the run, and — for the one
   * chapter where the joke is the money — apply Lieutenant Dan's investment.
   */
  private settle(hud: ChapterHud) {
    this.chocolates += hud.chocolates ?? 0;
    this.miles += (hud.metres ?? 0) / 1609.34;
    const meta = CHAPTERS[this.index];
    let earned = hud.earned ?? 0;
    let extra: string | null = null;
    if (hud.outcome === "won" && meta.id === "shrimp" && earned > 0) {
      earned *= 18;
      extra = `Lieutenant Dan invested it in some kind of fruit company. $${earned.toLocaleString()}.`;
    }
    this.money += earned;
    if (hud.outcome === "won") this.cleared = Math.max(this.cleared, this.index + 1);
    this.phase = "beat";
    this.narration = hud.outcome === "won" ? meta.outro : meta.fail;
    if (extra) this.narration = extra;
    this.emit();
  }

  /* ================================================================== loop */

  start() {
    if (this.raf) return;
    this.clock.start();
    const tick = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      this.frame();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private frame() {
    // A tab that has been in the background hands back a delta of eleven
    // seconds. Clamping it is the difference between "welcome back" and
    // "you are dead and the world has scrolled past you".
    const dt = Math.min(0.05, this.clock.getDelta()) * this.timeScale;
    this.time += dt;
    this.pollInput();
    this.audio.tickMusic();
    this.stepSky(dt);

    if (this.phase === "playing" && this.chapter) {
      const hud = this.chapter.update(dt);
      this.hud = hud;
      if (hud.outcome !== "running") this.settle(hud);
      else this.emit();
    } else if (this.chapter && (this.phase === "card" || this.phase === "beat")) {
      // Keep the world alive underneath the card: everything runs, but the
      // player's inputs are neutralised so nothing can be lost while reading.
      const held = this.input.steer;
      this.input.steer = 0;
      this.input.jumpPressed = false;
      this.input.actionPressed = false;
      // Deliberately discarding the HUD here. The chapter keeps running under
      // the card — he crosses the line and carries on, which is the whole
      // joke — but the tally on the card is the tally at the moment it ended.
      // Letting it keep climbing while you read meant the yards you were
      // congratulated for were not the yards you ran.
      this.chapter.update(this.phase === "card" ? dt * 0.35 : dt);
      this.input.steer = held;
    } else {
      this.updateBench(dt);
      this.emit();
    }

    if (this.toast && this.time > this.toastUntil) {
      this.toast = null;
      this.emit();
    }

    this.renderer.render(this.scene, this.camera);
  }

  /* ================================================================== glue */

  on(cb: (s: GumpSnapshot) => void) {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => this.listeners.delete(cb);
  }

  private emit() {
    const s = this.snapshot();
    for (const cb of this.listeners) cb(s);
  }

  snapshot(): GumpSnapshot {
    return {
      phase: this.phase,
      chapter: this.index,
      hud: this.hud,
      chocolates: this.chocolates + (this.phase === "playing" ? (this.hud.chocolates ?? 0) : 0),
      money: this.money,
      miles: this.miles,
      toast: this.toast,
      narration: this.narration,
      cleared: this.cleared,
      muted: this.audio.isMuted,
    };
  }

  setMuted(m: boolean) {
    this.audio.setMuted(m);
    this.emit();
  }

  resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.teardownChapter();
    this.benchVibey?.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (!o.userData.shared) o.geometry?.dispose?.();
      }
    });
    this.benchRoot.clear();
    disposePropCache();
    disposeRigCache();
    disposeTextureCache();
    this.audio.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    // And take the canvas with it — see the constructor.
    this.canvas.remove();
    this.listeners.clear();
  }
}

export { CHAPTERS };
