/**
 * The away team: what happens after the transporter finishes.
 *
 * One surface exists at a time and it is torn down completely on beam-up. That
 * is not tidiness for its own sake — a session that visits eight worlds builds
 * eight terrains, eight kits and eight sets of people, and a browser will run
 * out of WebGL context long before a player runs out of curiosity.
 *
 * ## The terrain, and the one thing it has to get right
 *
 * `heightAt(x, z)` is the whole ground truth. The mesh is displaced by it, the
 * kit places its props with it, the weather lands on it and the player's feet
 * stand on it. There is exactly one implementation and everything asks it
 * rather than approximating it, because the failure mode of two slightly
 * different heightfields is a monastery floating four centimetres above a
 * mountain, and that is a bug you can see from the transporter pad.
 *
 * It is flattened to a disc around the origin. The beam-in site has to be
 * level: a transporter that puts the captain down on a 30° slope on Vulcan
 * starts the visit with a slide.
 *
 * ## The horizon
 *
 * `SURFACE_FAR` is 3,500 m and the terrain mesh is 900 m across, so the edge of
 * the world would be visible if the fog did not close first. Every kit's fog
 * density is tuned so that the ground fades into the sky's horizon colour
 * before it runs out — which is why the fog colour and the sky's horizon colour
 * are the same number in `systems.ts` on every world, and why they must stay
 * the same number.
 */
import * as THREE from "three";
import { SURFACE_FAR, SURFACE_NEAR, clamp, damp, hashString, makeRng, type Input } from "../types";
import type { SurfaceSpec, TrekSystem } from "../galaxy/systems";
import { KITS, buildKit, type BuiltKit } from "./kits";
import { createNpc, type Npc } from "./npc";
import { characterByKey, type Character } from "../crew/characters";

const EYE = 1.68;
const WALK = 4.6;
const RUN = 8.4;
const WORLD_R = 300;

export interface SurfaceScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The person you can talk to, if you are close enough to. */
  nearby(): Npc | null;
  enter(system: TrekSystem): void;
  leave(): void;
  update(dt: number, input: Input, opts: { frozen: boolean; talking: boolean }): void;
  playerPosition(): THREE.Vector3;
  dispose(): void;
}

export function createSurfaceScene(aspect: number): SurfaceScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, aspect, SURFACE_NEAR, SURFACE_FAR);

  let built: {
    root: THREE.Group;
    kit: BuiltKit;
    npc: Npc | null;
    extras: Npc[];
    height: (x: number, z: number) => number;
    weather: Weather | null;
    spec: SurfaceSpec;
    flickers: THREE.Object3D[];
    sun: THREE.DirectionalLight;
    sunDir: THREE.Vector3;
  } | null = null;

  const pos = new THREE.Vector3(0, 0, 10);
  let yaw = Math.PI;
  let pitch = -0.05;
  let vy = 0;
  let bob = 0;
  let near: Npc | null = null;
  let t = 0;

  function teardown(): void {
    if (!built) return;
    built.npc?.dispose();
    built.extras.forEach((e) => e.dispose());
    built.kit.dispose();
    built.weather?.dispose();
    built.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    scene.remove(built.root);
    scene.clear();
    built = null;
    near = null;
  }

  function enter(system: TrekSystem): void {
    teardown();
    const spec = system.surface;
    if (!spec) return;
    const seed = hashString(system.key + ":surface");
    const kitSpec = KITS[spec.kit] ?? KITS["dead-world"];
    const root = new THREE.Group();
    scene.add(root);

    /* --- height field ------------------------------------------------------ */
    const height = makeHeightField(kitSpec.terrain.relief, kitSpec.terrain.scale, seed);

    /* --- terrain ----------------------------------------------------------- */
    const SEG = 150;
    const SPAN = 900;
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    const lo = new THREE.Color(kitSpec.terrain.tint).multiplyScalar(0.72);
    const hi = new THREE.Color(kitSpec.terrain.tint).lerp(new THREE.Color(kitSpec.stone), 0.55);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const y = height(x, z);
      p.setY(i, y);
      // Colour by height, then break it up with a fine noise so the ground is
      // not a smooth gradient — the eye reads any smooth gradient as plastic.
      const k = clamp(y / (kitSpec.terrain.relief * 2.2) + 0.5, 0, 1);
      c.copy(lo).lerp(hi, k * kitSpec.terrain.rock);
      const grain = 0.9 + 0.2 * fract(Math.sin((x * 12.9898 + z * 78.233) * 0.5) * 43758.5453);
      colors[i * 3] = c.r * grain;
      colors[i * 3 + 1] = c.g * grain;
      colors[i * 3 + 2] = c.b * grain;
    }
    p.needsUpdate = true;
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0.0 }),
    );
    ground.receiveShadow = true;
    root.add(ground);

    /* --- sky, fog, light ---------------------------------------------------- */
    scene.fog = new THREE.FogExp2(spec.fog.color, spec.fog.density);
    scene.background = new THREE.Color(spec.sky.horizon);

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(SURFACE_FAR * 0.9, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: {
          uHorizon: { value: new THREE.Color(spec.sky.horizon) },
          uZenith: { value: new THREE.Color(spec.sky.zenith) },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          uniform vec3 uHorizon, uZenith;
          void main(){
            // pow() rather than a linear ramp: the sky's brightness falls off
            // fast just above the horizon and slowly near the zenith, and a
            // linear blend gets that visibly wrong.
            float k = pow(clamp(vP.y * 0.5 + 0.5, 0.0, 1.0), 0.55);
            gl_FragColor = vec4(mix(uHorizon, uZenith, k), 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    root.add(sky);

    const el = (spec.sun.elevation * Math.PI) / 180;
    const az = (spec.sun.azimuth * Math.PI) / 180;
    const sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

    const sun = new THREE.DirectionalLight(spec.sun.color, spec.sun.intensity);
    sun.position.copy(sunDir).multiplyScalar(600);
    // The shadow box is 190 m across and follows the player each frame. Sized
    // to the plaza rather than to the 900 m terrain: a box that covers the
    // whole mesh spends its 2048 texels on empty ground and gives the pillars
    // four each, which is worse than no shadows at all.
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 95;
    sun.shadow.camera.bottom = -95;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 1400;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.04;
    root.add(sun);
    root.add(sun.target);

    /* Three fills, and they are not decoration.
     *
     * With a key light alone every vertical surface in the kit renders as a
     * black cut-out: the terrain's normals all point at the sun and go bright,
     * and a pillar's normals are all within a few degrees of grazing. On
     * Vulcan that turned a monastery into a row of silhouettes at midday,
     * which is not what midday looks like anywhere.
     *
     * A real sky is a hemisphere of light and a real ground bounces a
     * substantial part of the key straight back up. So: a hemisphere for the
     * sky, an ambient floor for the fog, and a bounce from the anti-sun
     * direction tinted the colour of the dirt. Together they lift the shaded
     * faces to something you can read the shape of without touching the key. */
    root.add(new THREE.HemisphereLight(spec.sky.zenith, kitSpec.terrain.tint, 1.0));
    root.add(new THREE.AmbientLight(spec.fog.color, 0.55));
    // The bounce comes from behind the beam-in point rather than from the
    // anti-sun direction. Anti-sun is a guess that depends on where the key
    // happens to be; behind the away team is where the player is looking from,
    // every time, on every world.
    const bounce = new THREE.DirectionalLight(kitSpec.terrain.tint, 0.45);
    bounce.position.set(60, 90, 300);
    root.add(bounce);

    // The sun's disc. Sprites in a fogged scene need fog off or they turn the
    // colour of the haze and vanish.
    const disc = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: discTexture(),
        color: spec.sun.color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    disc.position.copy(sunDir).multiplyScalar(2600);
    disc.scale.setScalar(320);
    root.add(disc);

    if (spec.skyBody) {
      const b = spec.skyBody;
      const bel = (b.elevation * Math.PI) / 180;
      const baz = (b.azimuth * Math.PI) / 180;
      const body = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: bodyTexture(b.tint),
          depthWrite: false,
          depthTest: false,
          fog: false,
          opacity: 0.92,
        }),
      );
      body.position.set(Math.cos(bel) * Math.sin(baz), Math.sin(bel), Math.cos(bel) * Math.cos(baz)).multiplyScalar(2400);
      body.scale.setScalar(900 * b.size);
      root.add(body);
    }

    /* --- structures --------------------------------------------------------- */
    const kit = buildKit(spec.kit, seed, height);
    kit.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Glowing things are light sources in the fiction; a brazier flame that
      // casts a hard shadow of itself onto its own bowl looks broken.
      const basic = (mesh.material as THREE.Material | undefined)?.type === "MeshBasicMaterial";
      mesh.castShadow = !basic;
      mesh.receiveShadow = !basic;
    });
    root.add(kit.group);

    const flickers: THREE.Object3D[] = [];
    kit.group.traverse((o) => {
      if (o.name === "flicker") flickers.push(o);
    });

    /* --- people -------------------------------------------------------------- */
    let npc: Npc | null = null;
    const extras: Npc[] = [];
    const ch = system.character ? characterByKey(system.character) : undefined;
    if (ch) {
      const at = new THREE.Vector3(0, 0, -7.5);
      at.y = height(at.x, at.z);
      npc = createNpc(ch, at, 0);
      npc.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = true;
      });
      root.add(npc.group);

      // Two or three silent extras of the same species, further out, so the
      // place is inhabited rather than staffed by exactly one person. They are
      // not hailable and carry no nameplate — the moment a background figure
      // can be talked to, the one who matters stops mattering.
      const rng = makeRng(seed ^ 0x5f3a);
      const count = ch.where === "ship" ? 0 : 3;
      for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2;
        const r = 24 + rng() * 34;
        const ex = createNpc(
          { ...ch, look: { ...ch.look, cloth: shade(ch.look.cloth, 0.7 + rng() * 0.5) } },
          new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
          rng() * Math.PI * 2,
        );
        ex.group.position.y = height(ex.group.position.x, ex.group.position.z);
        ex.setNameplate(false);
        ex.group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.castShadow = true;
        });
        root.add(ex.group);
        extras.push(ex);
      }
    }

    const weather = spec.weather && spec.weather !== "none" ? createWeather(spec.weather, root) : null;

    built = { root, kit, npc, extras, height, weather, spec, flickers, sun, sunDir };

    // Put the captain on the pad, facing whoever is waiting.
    //
    // Yaw 0 is looking down -Z, which is the same convention the movement
    // block below uses and the direction every kit's centrepiece is laid out
    // along. The first build spawned at yaw π and put the away team's nose
    // against the boundary wall six metres behind the pad, with the person
    // they had come to meet directly at their back.
    // On the pad, not eight metres off it. Every kit puts a `beacon` at the
    // origin and that is where the beam lands — standing beside your own
    // transporter pad looking at it edge-on is both wrong and, from eye
    // height, a wall of glowing ring across the bottom of the frame.
    pos.set(0, height(0, 0) + EYE, 0);
    yaw = 0;
    pitch = -0.04;
    vy = 0;
    near = null;
  }

  function update(dt: number, input: Input, opts: { frozen: boolean; talking: boolean }): void {
    t += dt;
    if (!built) return;
    const { height, kit, npc, extras, spec } = built;

    if (!opts.frozen && !input.typing) {
      const sens = input.pointerLocked ? 0.0022 : 0.004;
      yaw -= input.look.x * sens;
      pitch = clamp(pitch - input.look.y * sens, -1.35, 1.35);
    }

    let speed = 0;
    if (!opts.frozen && !input.typing && !opts.talking) {
      const f = (input.held("w") ? 1 : 0) - (input.held("s") ? 1 : 0) + input.move.y;
      const r = (input.held("d") ? 1 : 0) - (input.held("a") ? 1 : 0) + input.move.x;
      const len = Math.hypot(f, r);
      if (len > 0.01) {
        const run = input.held("shift") || input.held("ShiftLeft");
        speed = (run ? RUN : WALK) * Math.min(1, len);
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        // Forward is -Z rotated by yaw, which is the same convention the
        // camera quaternion below uses. Getting these two out of step is the
        // classic "W walks sideways" bug.
        const dx = (-sin * f + cos * r) / Math.max(len, 1);
        const dz = (-cos * f - sin * r) / Math.max(len, 1);
        pos.x += dx * speed * dt;
        pos.z += dz * speed * dt;
      }
      if (input.pressed(" ") && Math.abs(vy) < 0.01) vy = 4.4 / Math.sqrt(spec.gravity);
    }

    // Blockers: push straight out along the radius. Cheap, and correct enough
    // for cylinders that are never adjacent.
    for (const b of kit.blockers) {
      const dx = pos.x - b.x;
      const dz = pos.z - b.z;
      const d = Math.hypot(dx, dz);
      const want = b.r + 0.5;
      if (d < want && d > 0.001) {
        pos.x = b.x + (dx / d) * want;
        pos.z = b.z + (dz / d) * want;
      }
    }

    // The soft wall. Past 300 m there is nothing but terrain, and a captain
    // who walks to the edge of the mesh has found the seam.
    const rad = Math.hypot(pos.x, pos.z);
    if (rad > WORLD_R) {
      pos.x *= WORLD_R / rad;
      pos.z *= WORLD_R / rad;
    }

    const ground = height(pos.x, pos.z) + EYE;
    vy -= 9.81 * spec.gravity * dt;
    pos.y += vy * dt;
    if (pos.y <= ground) {
      pos.y = ground;
      vy = 0;
    }

    // Head bob, on the walk cycle only. Always-on bob is nausea.
    bob = damp(bob, speed > 0.1 ? 1 : 0, 8, dt);
    const bobY = Math.sin(t * (speed > 6 ? 13 : 9)) * 0.045 * bob;

    camera.position.set(pos.x, pos.y + bobY, pos.z);
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));

    /* --- who is in range --------------------------------------------------- */
    near = null;
    if (npc) {
      npc.update(dt, camera.position, opts.talking);
      const d = npc.group.position.distanceTo(camera.position);
      npc.setNameplate(d < 26);
      // 6.5 m. Tuned by walking at it: 5 m is close enough that the captain is
      // standing on the character's feet before the prompt appears.
      if (d < 6.5) near = npc;
    }
    for (const e of extras) e.update(dt, camera.position, false);

    // Flicker: braziers, pools and the pad ring. Two sines at incommensurable
    // rates so it never settles into a visible loop.
    const fl = 1 + Math.sin(t * 7.3) * 0.12 + Math.sin(t * 3.1) * 0.07;
    for (const f of built.flickers) f.scale.setScalar(fl);

    // Carry the shadow box with the away team, snapped to whole metres so the
    // shadow texels do not crawl as the player walks.
    built.sun.target.position.set(Math.round(pos.x), 0, Math.round(pos.z));
    built.sun.position.copy(built.sunDir).multiplyScalar(600).add(built.sun.target.position);
    built.sun.target.updateMatrixWorld();

    built.weather?.update(dt, camera.position);
  }

  return {
    scene,
    camera,
    nearby: () => near,
    enter,
    leave: teardown,
    update,
    playerPosition: () => camera.position,
    dispose() {
      teardown();
      scene.fog = null;
    },
  };
}

/* -------------------------------------------------------------------------- */

const fract = (x: number) => x - Math.floor(x);

/**
 * Value-noise fbm, seeded, plus a flat disc at the origin.
 *
 * Value noise rather than gradient noise on purpose: this is sampled per
 * vertex on a 150² grid *and* per prop *and* once per frame under the player's
 * feet, and the visible difference at this scale is nil.
 */
function makeHeightField(relief: number, scale: number, seed: number): (x: number, z: number) => number {
  const s = seed >>> 0;
  const hash = (xi: number, zi: number): number => {
    let h = (xi * 374761393 + zi * 668265263 + s) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x: number, z: number): number => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  return (x: number, z: number): number => {
    let amp = 1;
    let freq = scale;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < 5; i++) {
      sum += (noise(x * freq, z * freq) - 0.5) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    const h = (sum / norm) * relief * 2;
    // Level the beam-in site, and blend out over 22 m so the join is not a step.
    const d = Math.hypot(x, z);
    const flat = 1 - Math.min(1, Math.max(0, (d - 14) / 22));
    return h * (1 - flat * flat);
  };
}

function shade(hex: number, k: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c.getHex();
}

function discTexture(): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S * 0.5);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  return new THREE.CanvasTexture(cv);
}

/** A lit disc with a terminator — the gas giant Andoria hangs under, the
 *  sister planet over Vulcan, the debris ring over Qo'noS. */
function bodyTexture(tint: number): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  if (ctx) {
    const c = new THREE.Color(tint);
    const rgb = (k: number) =>
      `rgb(${Math.round(c.r * 255 * k)},${Math.round(c.g * 255 * k)},${Math.round(c.b * 255 * k)})`;
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.44, 0, Math.PI * 2);
    ctx.clip();
    const g = ctx.createLinearGradient(S * 0.1, 0, S * 0.95, 0);
    g.addColorStop(0, rgb(1.25));
    g.addColorStop(0.55, rgb(0.75));
    g.addColorStop(1, rgb(0.14));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    // Belts. Four bands is enough to say "gas giant" and not enough to say
    // "somebody drew Jupiter".
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#000";
    for (let i = 0; i < 4; i++) ctx.fillRect(0, S * (0.28 + i * 0.13), S, S * 0.045);
    ctx.restore();
  }
  return new THREE.CanvasTexture(cv);
}

/* --- weather --------------------------------------------------------------- */

interface Weather {
  update(dt: number, at: THREE.Vector3): void;
  dispose(): void;
}

/**
 * Rain, snow, ash and dust, all one particle box carried by the camera.
 *
 * The box is 60 m on a side and wraps: a particle that falls out of the bottom
 * reappears at the top with the same x and z. Nobody can tell, and it means
 * three thousand particles cover a world instead of covering thirty metres of
 * it.
 */
function createWeather(kind: "rain" | "snow" | "ash" | "dust", parent: THREE.Object3D): Weather {
  const N = kind === "rain" ? 2600 : 1500;
  const BOX = 60;
  const rng = makeRng(kind.length * 977 + 13);
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rng() - 0.5) * BOX;
    pos[i * 3 + 1] = rng() * BOX;
    pos[i * 3 + 2] = (rng() - 0.5) * BOX;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const settings = {
    rain: { color: 0xa8c4d8, size: 0.055, fall: 26, drift: 0.4, opacity: 0.5 },
    snow: { color: 0xffffff, size: 0.13, fall: 1.9, drift: 1.5, opacity: 0.85 },
    ash: { color: 0xd8b088, size: 0.1, fall: 1.2, drift: 2.2, opacity: 0.55 },
    dust: { color: 0xe0b077, size: 0.09, fall: 0.5, drift: 3.4, opacity: 0.4 },
  }[kind];

  const mat = new THREE.PointsMaterial({
    color: settings.color,
    size: settings.size,
    transparent: true,
    opacity: settings.opacity,
    depthWrite: false,
    sizeAttenuation: true,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  parent.add(points);

  let t = 0;
  return {
    update(dt, at) {
      t += dt;
      points.position.set(Math.round(at.x), Math.round(at.y) - BOX / 2, Math.round(at.z));
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < N; i++) {
        let y = p.getY(i) - settings.fall * dt;
        let x = p.getX(i) + Math.sin(t * 0.6 + i) * settings.drift * dt;
        if (y < 0) {
          y += BOX;
          x = (rng() - 0.5) * BOX;
        }
        if (x > BOX / 2) x -= BOX;
        if (x < -BOX / 2) x += BOX;
        p.setXY(i, x, y);
      }
      p.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      points.parent?.remove(points);
    },
  };
}

export type { Character };
