/**
 * engine.ts — the renderer, the loop, and the teardown.
 *
 * One `mount()` builds everything and returns a handle; one `dispose()` gives
 * every byte of it back. That second half is not boilerplate: browsers cap the
 * number of live WebGL contexts at around sixteen, and a world that leaks one
 * breaks the *next* world the visitor opens, which is a miserable thing to
 * debug from a bug report that says "the shop is black now".
 *
 * The loop is deliberately plain — no post-processing stack, no render targets,
 * no temporal anything. A flat-shaded city with no textures does not need help
 * looking good, and every effect not present is an effect that cannot flicker.
 */
import * as THREE from "three";
import { CityAudio } from "./audio";
import { createCableCars, type CableCarLine } from "./cablecar";
import { buildCity, disposeCity, type CityBuild } from "./city";
import { CityCollision } from "./collision";
import { createInput, type FriscoInput } from "./input";
import { CityLife } from "./life";
import { disposeLook } from "./look";
import {
  SPAWNS, VIEW, isWater, landmarkPositions, ll, snapToStreet, walkHeight, type Spawn,
} from "./map";
import { Player } from "./player";
import { Playground, type PlayEvent } from "./play";
import { createSky, type SkyRig } from "./sky";

export interface FriscoHandle {
  player: Player;
  city: CityBuild;
  collision: CityCollision;
  sky: SkyRig;
  play: Playground;
  life: CityLife;
  cable: CableCarLine;
  audio: CityAudio;
  input: FriscoInput;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Frames per second, refreshed once a second. */
  fps: number;
  /** Swap the player's character at runtime. */
  setCharacter(id: string): void;
  /** Jump to a named spawn. */
  goTo(key: string): void;
  /** Hand the camera to the attract path — what `?shot` does. */
  setAttract(on: boolean): void;
  /** Called every frame after the world has stepped, for the HUD and the game. */
  onFrame?: (dt: number, elapsed: number) => void;
  /** Called whenever the play layer has something to say — a coin, a landmark. */
  onPlay?: (events: PlayEvent[]) => void;
  dispose(): void;
}

export interface MountOptions {
  canvas: HTMLCanvasElement;
  charId: string;
  spawn?: string;
  /** Reports build progress so the loading screen can say something true. */
  onProgress?: (label: string) => void;
  /** Start in attract mode — no input, camera on rails. `?shot`. */
  attract?: boolean;
}

/** Spawns are stored as real lat/lon; `map.ts` owns the projection. */
function resolveSpawn(key: string | undefined): { spawn: Spawn; x: number; z: number; y: number } {
  const s = SPAWNS.find((v) => v.key === key) ?? SPAWNS[0];
  // Snapped to the street unless the spawn is deliberately in the air — the
  // top of the Transamerica is not supposed to be on a road.
  const raw = ll(s.lat, s.lon);
  const p = s.up > 0 ? raw : snapToStreet(raw.x, raw.z);
  return { spawn: s, x: p.x, z: p.z, y: walkHeight(p.x, p.z) + s.up + 0.4 };
}

export function mountFrisco(o: MountOptions): FriscoHandle {
  const { canvas } = o;

  /* ---- renderer ---- */
  // Acquire the context ourselves so a refusal is a clean failure rather than
  // a crash inside three's highp probe.
  const gl =
    (canvas.getContext("webgl2", { antialias: true, powerPreference: "high-performance" }) as
      | WebGL2RenderingContext
      | null) ??
    (canvas.getContext("webgl", { antialias: true, powerPreference: "high-performance" }) as
      | WebGLRenderingContext
      | null);
  if (!gl) throw new Error("WebGL unavailable");

  /**
   * `logarithmicDepthBuffer` is not optional here, and finding that out cost a
   * day.
   *
   * A 2.4 km world seen from a jetpack wants a near plane close enough for a
   * third-person camera and a far plane past the far shore. At near 0.4 and far
   * 4200 that is a ratio of ten thousand to one, and a conventional depth
   * buffer spends almost all of its precision in the first few metres: a point
   * three hundred metres away lands at an NDC depth of 0.9975, and everything
   * from there to the horizon shares the last quarter of one percent of the
   * range. On a desktop GPU with a 24-bit buffer you get away with it. On
   * anything with less — SwiftShader, some mobile drivers — the entire city
   * collapses into the same depth value and disappears, and what you see is a
   * black screen with a few slivers of geometry in it.
   *
   * That failure is indistinguishable from "the city was never built", which
   * is where the day went: the geometry, the camera, the materials, the culling
   * and the lights were all measured and all correct. `/sf` next door has
   * carried `logarithmicDepthBuffer: true` since the beginning for the same
   * reason, over a bigger map.
   */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // No tone mapping. ACES rolls the top end off, which is exactly right for a
  // photoreal world and exactly wrong here: it desaturates the flat colours
  // that ARE the art direction, and there are no highlights to roll off.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    62,
    Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1),
    VIEW.near,
    VIEW.far,
  );

  o.onProgress?.("Laying out the streets");
  const city = buildCity();
  scene.add(city.group);
  const collision = new CityCollision(city.colliders);

  o.onProgress?.("Painting the sky");
  const sky = createSky(scene);

  o.onProgress?.("Letting the traffic out");
  const life = new CityLife();
  scene.add(life.group);

  o.onProgress?.("Winding the cable");
  const cable = createCableCars(scene, collision);

  o.onProgress?.("Hiding the coins");
  const play = new Playground(city.colliders, collision);
  scene.add(play.group);

  const input = createInput(canvas);
  const audio = new CityAudio();

  o.onProgress?.("Finding your character");
  const sp = resolveSpawn(o.spawn);
  const player = new Player({
    charId: o.charId,
    scene,
    camera,
    collision,
    input,
    spawn: { x: sp.x, z: sp.z, y: sp.y, heading: sp.spawn.heading },
  });

  /* ---- loop ---- */
  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let acc = 0;
  let frames = 0;
  let disposed = false;
  let wasGrounded = true;
  let frozen = false;

  const handle: FriscoHandle = {
    player, city, collision, sky, play, life, cable, audio, input, scene, camera, renderer,
    fps: 0,
    setCharacter(id) {
      void player.loadCharacter(id);
    },
    setAttract(on) {
      attract = on;
      input.setEnabled(!on);
      /* Shadows off while the camera is on rails.
         Not a quality decision — a measurement one. The shadow pass draws the
         city a second time, and the offline recorder runs on a software
         renderer where that is the difference between four rendered frames in
         three seconds and enough to make a clip out of. `route-gif.mjs` counts
         *distinct* frames and rejects anything under eight, so a world this
         heavy simply cannot be filmed with the second pass on, however good it
         looks in it. Nobody sees attract mode with shadows on anyway: it exists
         for the card. */
      renderer.shadowMap.enabled = !on;
      sky.sun.castShadow = !on;
    },
    goTo(key) {
      const s = SPAWNS.find((v) => v.key === key);
      if (!s) return;
      const raw = ll(s.lat, s.lon);
      const p = s.up > 0 ? raw : snapToStreet(raw.x, raw.z);
      player.teleport(p.x, p.z, s.heading);
      if (s.up > 0) player.state.position.y = walkHeight(p.x, p.z) + s.up;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      input.dispose();
      player.dispose();
      play.dispose();
      life.dispose();
      cable.dispose();
      audio.dispose();
      sky.dispose();
      disposeCity(city);
      disposeLook();
      renderer.dispose();
      // Hand the context back explicitly. `renderer.dispose()` releases three's
      // own resources but the context can outlive it, and the cap is on
      // contexts.
      renderer.forceContextLoss?.();
      scene.clear();
    },
  };

  const onResize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);
  onResize();

  /**
   * The attract mode `?shot` puts the world into: a slow crane over downtown
   * with nobody at the controls.
   *
   * It exists for `route-gif.mjs`, which records a few seconds of a route and
   * refuses to keep anything under eight distinct frames — the repo's rule for
   * "this world plays itself" is measured, not decided. A city that sits
   * perfectly still because it has no simulation in it would fail that test on
   * the merits, and it should: what moves in Vibe Francisco is the camera, so
   * the camera is what has to move.
   *
   * The path is an arc around the Financial District rather than a full orbit.
   * Three seconds of a full orbit is a smear; three seconds of a slow arc past
   * the Transamerica with the bay opening up behind it is a place.
   */
  let attract = false;
  const runAttract = (t: number) => {
    const a = 1.15 + t * 0.14;
    const radius = 620 - t * 26;
    const height = 300 - t * 12;
    const cx = -120;
    const cz = -160;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    player.state.position.set(x, height, z);
    player.state.velocity.set(0, 0, 0);
    player.state.yaw = a + Math.PI;
    player.state.pitch = -0.34;
  };

  if (o.attract === true) handle.setAttract(true);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    // Clamped so a backgrounded tab does not resume with a two-second step and
    // fling the player through the map.
    /* `frozen` is for the capture harnesses. Everything in this world that
       moves — traffic, walkers, boats, the cable cars, the coins — moves on
       `dt`, so setting it to zero holds the entire city still while a pose is
       set and a frame is taken. Photographing a moving object by posing the
       camera and waiting has a race in it that no amount of waiting fixes. */
    const dt = frozen ? 0 : Math.min((now - last) / 1000, 1 / 15);
    last = now;
    elapsed += dt;

    if (attract) runAttract(elapsed);
    /* The cars move BEFORE the player steps, so `supportAt` sees them where
       they now are; then `carry` adds their movement to a rider afterwards.
       The other order works right up until you stand still on a moving deck,
       at which point the deck slides out from under you every frame. */
    cable.update(dt);
    player.update(dt, elapsed);
    if (player.state.grounded) cable.carry(player.state.position);
    if (attract) runAttract(elapsed);
    life.update(dt, elapsed);
    sky.update(dt, elapsed, camera);
    const events = play.update(dt, elapsed, player.state.position);
    if (events.length) {
      for (const e of events) {
        if (e.kind === "coin") audio.cue("coin");
        else if (e.kind === "landmark") audio.cue("landmark");
        else if (e.kind === "ring") audio.cue("ring");
        else if (e.kind === "course" || e.kind === "tour-done") audio.cue("finish");
        else if (e.kind === "tour") audio.cue("landmark");
      }
      handle.onPlay?.(events);
    }
    /* The audio reads the same state the HUD does, one frame later, and knows
       nothing about the world beyond it. Six numbers is the entire interface,
       which is what keeps a synthesiser from growing opinions about geometry. */
    const ps = player.state;
    if (!attract) {
      audio.update(dt, {
        speed: ps.speed,
        altitude: ps.altitude,
        grounded: ps.grounded,
        burning: ps.stance === "jet",
        fuel: ps.fuel,
        inWater: ps.position.y <= 0.6 && isWater(ps.position.x, ps.position.z),
      });
      if (ps.grounded && !wasGrounded) audio.cue("land");
      else if (!ps.grounded && wasGrounded && ps.velocity.y > 1) audio.cue("jump");
      wasGrounded = ps.grounded;
    }
    handle.onFrame?.(dt, elapsed);

    renderer.render(scene, camera);

    acc += dt;
    frames++;
    if (acc >= 1) {
      handle.fps = Math.round(frames / acc);
      acc = 0;
      frames = 0;
    }
  };
  raf = requestAnimationFrame(tick);

  /**
   * The debug surface the offline harnesses drive this world through.
   *
   * Same idea as `window.__sf` next door, and installed for the same reason:
   * "the city is black" is not a question a screenshot can answer, and the
   * difference between geometry that was never built, geometry that was culled
   * and geometry that is unlit is three numbers.
   */
  if (typeof window !== "undefined") {
    window.__frisco = {
      stats: () => ({
        fps: handle.fps,
        camera: {
          near: camera.near, far: camera.far, fov: camera.fov,
          aspect: Number(camera.aspect.toFixed(3)),
          pos: [camera.position.x, camera.position.y, camera.position.z].map((v) => Math.round(v)),
        },
        canvas: { w: canvas.clientWidth, h: canvas.clientHeight, bw: canvas.width, bh: canvas.height },
        triangles: city.stats.triangles,
        buildings: city.stats.buildings,
        furniture: city.stats.furniture,
        life: life.stats(),
        buildMs: Math.round(city.stats.ms),
        drawCalls: renderer.info.render.calls,
        drawnTriangles: renderer.info.render.triangles,
        meshes: city.group.children.map((c) => {
          const m = c as THREE.Mesh;
          const g = m.geometry as THREE.BufferGeometry | undefined;
          return {
            name: m.name,
            visible: m.visible,
            verts: g?.getAttribute("position")?.count ?? 0,
          };
        }),
      }),
      player: () => ({
        x: player.state.position.x,
        y: player.state.position.y,
        z: player.state.position.z,
        fuel: player.state.fuel,
        stance: player.state.stance,
        altitude: player.state.altitude,
        grounded: player.state.grounded,
      }),
      setPose: (x: number, y: number, z: number, yaw: number, pitch: number) => {
        player.state.position.set(x, y, z);
        player.state.velocity.set(0, 0, 0);
        player.state.yaw = yaw;
        player.state.pitch = pitch;
      },
      goTo: (k: string) => handle.goTo(k),
      startCourse: (k = "market") => { handle.onPlay?.(play.start(k)); },
      audioRunning: () => audio.isRunning,
      nextRing: () => { const v = play.nextRingPosition(); return v ? { x: v.x, y: v.y, z: v.z } : null; },
      playState: () => play.snapshot(),
      landmarks: () =>
        landmarkPositions().map((l) => ({
          key: l.key, name: l.name, x: l.x, z: l.z, height: l.height,
          ground: walkHeight(l.x, l.z),
        })),
      raw: () => ({ scene, camera, renderer, sky }),
      show: (name: string, on: boolean) => {
        if (name === "sky") { sky.group.visible = on; return; }
        if (name === "dome") { sky.group.children[0].visible = on; return; }
        if (name === "clouds" || name === "fog") {
          // Everything in the sky group after the dome that is not a light.
          for (let i = 1; i < sky.group.children.length; i++) {
            const c = sky.group.children[i];
            if ((c as THREE.Light).isLight) continue;
            c.visible = on;
          }
          return;
        }
        for (const c of city.group.children) {
          if (c.name === `frisco-${name}` || name === "*") c.visible = on;
        }
      },
      setFog: (a: number) => sky.setFog(a),
      freeze: (on: boolean) => { frozen = on; },
      setTime: (k: string) => sky.setTime(k),
      setShadows: (on: boolean) => { renderer.shadowMap.enabled = on; sky.sun.castShadow = on; },
      setLights: (sunI: number, hemiI: number) => { sky.sun.intensity = sunI; sky.hemi.intensity = hemiI; },
    };
  }

  return handle;
}

declare global {
  interface Window {
    __frisco?: {
      stats: () => unknown;
      player: () => unknown;
      setPose: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
      goTo: (k: string) => void;
      startCourse: (k?: string) => void;
      audioRunning: () => boolean;
      nextRing: () => { x: number; y: number; z: number } | null;
      playState: () => unknown;
      landmarks: () => Array<{
        key: string; name: string; x: number; z: number; height: number; ground: number;
      }>;
      raw: () => { scene: unknown; camera: unknown; renderer: unknown; sky: unknown };
      show: (name: string, on: boolean) => void;
      setFog: (a: number) => void;
      freeze: (on: boolean) => void;
      setTime: (k: string) => void;
      setShadows: (on: boolean) => void;
      setLights: (s: number, h: number) => void;
    };
  }
}
