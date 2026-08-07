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
import { surfaced } from "../gfx/surfacing";
import type { Atmosphere } from "../gfx/post";
import { createNpc, type Npc } from "./npc";
import { createScatter, type Scatter } from "./scatter";
import { createWater, type Water } from "./water";
import { characterByKey, type Character } from "../crew/characters";

const EYE = 1.68;
const WALK = 4.6;
const RUN = 8.4;
const WORLD_R = 300;

export interface SurfaceScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** What the post pass needs to build this world's aerial perspective.
   *  Null until an away team is actually on a surface. */
  atmosphere(): Atmosphere | null;
  /** The person you can talk to, if you are close enough to. */
  nearby(): Npc | null;
  enter(system: TrekSystem): void;
  leave(): void;
  update(dt: number, input: Input, opts: { frozen: boolean; talking: boolean }): void;
  playerPosition(): THREE.Vector3;
  dispose(): void;
}

export function createSurfaceScene(aspect: number, renderer?: THREE.WebGLRenderer): SurfaceScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, aspect, SURFACE_NEAR, SURFACE_FAR);

  /* Image-based lighting, built from each world's own sky.
   *
   * This is what stopped every surface being one hue. A `HemisphereLight` is
   * two colours lerped by the y component of the normal; it cannot put a warm
   * bounce on a west-facing wall and a cold one on the east face of the pillar
   * beside it, so a red world lit that way comes out uniformly red and reads
   * as a flat-shaded diorama no matter what the textures are doing.
   *
   * A PMREM probe of the actual sky dome does exactly that, and it also gives
   * every metal in the scene something to reflect. It is rendered once per
   * arrival, from the same sky shader the player is looking at, so the ambient
   * can never disagree with the horizon. */
  const pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
  pmrem?.compileEquirectangularShader();
  let envRT: THREE.WebGLRenderTarget | null = null;

  let built: {
    root: THREE.Group;
    kit: BuiltKit;
    npc: Npc | null;
    extras: Npc[];
    height: (x: number, z: number) => number;
    weather: Weather | null;
    scatter: Scatter | null;
    water: Water | null;
    spec: SurfaceSpec;
    flickers: THREE.Object3D[];
    sun: THREE.DirectionalLight;
    sunDir: THREE.Vector3;
    sea: { level: number } | null;
  } | null = null;

  /** Last position the away team was standing on dry ground. */
  const lastDry = new THREE.Vector3();

  const pos = new THREE.Vector3(0, 0, 10);
  let yaw = Math.PI;
  let pitch = -0.05;
  let vy = 0;
  let bob = 0;
  let near: Npc | null = null;
  let air: Atmosphere | null = null;
  let t = 0;

  function teardown(): void {
    if (!built) return;
    built.npc?.dispose();
    built.extras.forEach((e) => e.dispose());
    built.kit.dispose();
    built.scatter?.dispose();
    built.water?.dispose();
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
    scene.environment = null;
    envRT?.dispose();
    envRT = null;
    built = null;
    near = null;
    air = null;
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
    const height = makeHeightField(
      kitSpec.terrain.relief,
      kitSpec.terrain.scale,
      seed,
      kitSpec.shore,
      kitSpec.sea ? 6 : 14,
      kitSpec.sea ? 10 : 22,
    );

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
    /* The ground carries the same baked, triplanar surfacing as everything
       standing on it, with `vertexColors` doing the large-scale variation the
       height ramp computed above. A 900 m plane of one flat colour is the
       single largest object in frame and was the loudest thing saying "this is
       a mesh, not a place". */
    const groundMat = surfaced({
      color: 0xffffff,
      family: kitSpec.ground ?? "rock",
      tile: kitSpec.ground === "sand" ? 1.5 : 2.0,
      bump: 1.0,
      macro: 0.16,
    });
    groundMat.vertexColors = true;
    const ground = new THREE.Mesh(geo, groundMat);
    ground.receiveShadow = true;
    root.add(ground);

    /* --- sky, light ---------------------------------------------------------- */
    /* No `scene.fog`.
     *
     * The haze is done once in the post composite off the depth buffer — see
     * `gfx/post.ts` — which buys height falloff and inscattering that a
     * per-material FogExp2 cannot express. Leaving three's fog on as well
     * double-hazes everything and the two disagree about the colour at the
     * horizon, which shows up as a band. */
    scene.fog = null;
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
    /* The probe does the ambient now, so what is left here is a *trim*: a
       small hemisphere to keep the darkest faces from going to pure black, and
       a soft bounce from behind the beam-in point so the side of everything
       the player is looking at is never a silhouette. Both were carrying the
       whole ambient load before the probe existed and both were far too
       strong for it — a flat 0.55 ambient in the fog's colour is precisely
       what made every world monochrome. */
    root.add(new THREE.HemisphereLight(spec.sky.zenith, kitSpec.terrain.tint, 0.28));
    const bounce = new THREE.DirectionalLight(kitSpec.terrain.tint, 0.3);
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

    /* --- the light probe ----------------------------------------------------- */
    if (pmrem) {
      envRT?.dispose();
      // A throwaway scene holding only what the sky contributes: the dome, the
      // sun's disc, and a ground plane in the terrain's own colour so the
      // bounce from below is the colour of the actual dirt.
      const probe = new THREE.Scene();
      const domeMat = (sky.material as THREE.ShaderMaterial).clone();
      domeMat.side = THREE.BackSide;
      domeMat.depthWrite = false;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 24, 16), domeMat);
      probe.add(dome);
      const bounce2 = new THREE.Mesh(
        new THREE.CircleGeometry(58, 24),
        new THREE.MeshBasicMaterial({ color: kitSpec.terrain.tint, side: THREE.DoubleSide }),
      );
      bounce2.rotation.x = Math.PI / 2;
      bounce2.position.y = -1;
      probe.add(bounce2);
      const sunDisc = new THREE.Mesh(
        new THREE.SphereGeometry(2.4, 12, 10),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(spec.sun.color).multiplyScalar(spec.sun.intensity * 6),
        }),
      );
      sunDisc.position.copy(sunDir).multiplyScalar(50);
      probe.add(sunDisc);

      try {
        envRT = pmrem.fromScene(probe, 0.04, 0.1, 200);
        scene.environment = envRT.texture;
      } catch (err) {
        console.error("[SNW] light probe failed; falling back to hemisphere only", err);
        scene.environment = null;
      }
      dome.geometry.dispose();
      domeMat.dispose();
      bounce2.geometry.dispose();
      (bounce2.material as THREE.Material).dispose();
      sunDisc.geometry.dispose();
      (sunDisc.material as THREE.Material).dispose();
    }

    /* --- structures --------------------------------------------------------- */
    const kit = buildKit(spec.kit, seed, height, kitSpec.sea?.level);
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

    /* --- loose ground cover -------------------------------------------------- */
    let scatter: Scatter | null = null;
    if (kitSpec.scatter) {
      scatter = createScatter({
        height,
        color: kitSpec.scatter.color,
        family: kitSpec.ground ?? "rock",
        seed,
        density: kitSpec.scatter.density,
        accent: kitSpec.scatter.accent,
      });
      root.add(scatter.group);
    }

    /* --- standing water ------------------------------------------------------ */
    let water: Water | null = null;
    if (kitSpec.sea) {
      water = createWater({
        sea: kitSpec.sea,
        height,
        span: SPAN,
        sunDir,
        sunColor: spec.sun.color,
        skyColor: spec.sky.zenith,
        horizonColor: spec.sky.horizon,
      });
      root.add(water.mesh);
    }

    const weather = spec.weather && spec.weather !== "none" ? createWeather(spec.weather, root) : null;

    built = { root, kit, npc, extras, height, weather, spec, flickers, sun, sunDir, scatter, water, sea: kitSpec.sea ?? null };

    /* Density is per metre, and the registry's old FogExp2 numbers were tuned
       for a squared falloff — so they are re-based here rather than reused. A
       clear desert is about 1/1200 m; Ferenginar in the rain is six times that.
       Scale height is low on the thin-aired worlds and high on the soupy ones. */
    air = {
      color: new THREE.Color(spec.fog.color),
      density: spec.fog.density * 0.62,
      height: 60 + 22000 * spec.fog.density,
      sunDir: sunDir.clone(),
      sunColor: new THREE.Color(spec.sun.color),
      inscatter: 0.9 + spec.sun.intensity * 0.5,
    };

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
    lastDry.set(0, 0, 0);
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

    // The waterline is a wall, not a swimming pool. An away team that can walk
    // to the bottom of Suraya Bay and stand there looking up is funnier than it
    // is convincing.
    const kitSea = built.sea;
    if (kitSea && height(pos.x, pos.z) < kitSea.level - 0.35) {
      const bx = Math.atan2(pos.z, pos.x);
      for (let i = 0; i < 12; i++) {
        const back = 0.6 * (i + 1);
        const nx = pos.x - Math.cos(bx) * 0 + (lastDry.x - pos.x) * (back / 7);
        const nz = pos.z + (lastDry.z - pos.z) * (back / 7);
        if (height(nx, nz) >= kitSea.level - 0.3) {
          pos.x = nx;
          pos.z = nz;
          break;
        }
      }
    } else {
      lastDry.set(pos.x, 0, pos.z);
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

    built.water?.update(dt, camera);
    built.weather?.update(dt, camera.position);
  }

  return {
    scene,
    camera,
    atmosphere: () => air,
    nearby: () => near,
    enter,
    leave: teardown,
    update,
    playerPosition: () => camera.position,
    dispose() {
      teardown();
      scene.fog = null;
      pmrem?.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */

const fract = (x: number) => x - Math.floor(x);
const smooth01 = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/**
 * Value-noise fbm, seeded, plus a flat disc at the origin.
 *
 * Value noise rather than gradient noise on purpose: this is sampled per
 * vertex on a 150² grid *and* per prop *and* once per frame under the player's
 * feet, and the visible difference at this scale is nil.
 */
export function makeHeightField(
  relief: number,
  scale: number,
  seed: number,
  shore?: { dir: [number, number]; start: number; drop: number; span?: number },
  /** Radius of the levelled beam-in pad, and how far the level blends out.
   *  Small on a coast — see the note on the shore. */
  flatR = 14,
  flatBlend = 22,
): (x: number, z: number) => number {
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
    let h = (sum / norm) * relief * 2;
    const d = Math.hypot(x, z);

    /* The shore, computed first, because it has to *win*.
     *
     * A sea level alone does not give you a coast: the terrain around a
     * beam-in site is a bowl of noise centred on zero, so a waterline a metre
     * and a half down is buried and Suraya Bay renders as a damp patch you
     * cannot find. Past `start` metres in one direction the ground ramps down —
     * smoothstepped, so there is a beach rather than a cliff, with the noise
     * still riding on top so the waterline stays ragged.
     *
     * `shoreK` then *suppresses the distant hills below*. That order is the
     * whole fix: on the first attempt the two ran independently, the far ridge
     * added up to nineteen metres of relief and the shore subtracted twelve, so
     * the coast came out as a range of hills with a slight dip in it and no
     * water anywhere. A coast is where the country stops.
     *
     * The drops are large — fifteen to thirty metres — and that is a geometry
     * fact rather than a stylistic one. A flat sea seen from a 1.7 m eye height
     * occupies a *sliver*: the horizon is four kilometres off and a waterline
     * eighty metres away sits one degree below it, so the whole bay renders as
     * a four-pixel band you cannot find. Every beam-in site with water is
     * therefore on a shelf above it — the resort terrace on Risa, the Presidio
     * bluff on Earth, the Kendra terraces over the river — which is both what
     * the catalogue entries already said and the only way the water is visible
     * at all. */
    let shoreK = 0;
    if (shore) {
      const len = Math.hypot(shore.dir[0], shore.dir[1]) || 1;
      const along = (x * shore.dir[0] + z * shore.dir[1]) / len;
      /* A bay, not a tilted world.
       *
       * Projecting onto the shore direction alone drops *everything* on that
       * side of the origin, which on Risa put the entire resort under water —
       * the arches, both domes and half the palms simply stopped being placed.
       * Restricting the drop to a sector around the bearing gives a bay with
       * headlands either side of it, which is both what a resort is built on
       * and what leaves somewhere to put the buildings. */
      const cos = d > 0.001 ? along / d : 1;
      const sector = smooth01((cos - 0.1) / 0.55);
      const k = Math.min(1, Math.max(0, (along - shore.start) / (shore.span ?? 110))) * sector;
      shoreK = k * k * (3 - 2 * k);
      /* Calm the noise *first*, then drop.
       *
       * The other order multiplies the drop by the same factor, so a 36 m
       * shelf attenuated by 0.45 bottoms out at 16 m — which happened to be
       * exactly the sea level, and the bay rendered as four centimetres of
       * water that the alpha ramp then discarded entirely. The attenuation is
       * meant to smooth the sea bed, not to undo the coast. */
      h *= 1 - shoreK * 0.55;
      h -= shore.drop * shoreK;
    }

    /* Distant relief.
     *
     * The player is walled in at 300 m but the mesh runs to 450, and a
     * perfectly flat band between the two is a horizon with nothing on it —
     * which says "this is a plane" more loudly than anything else in frame.
     * Past 190 m the relief ramps up hard and gains a longer wavelength, so the
     * away team is always standing in a bowl with country around it.
     *
     * Wavelength matters more than amplitude: the first pass used 0.28× the
     * base frequency, which on Vulcan is a six-hundred-metre wavelength — less
     * than one cycle inside the visible ring, so it raised the far ground
     * smoothly and produced exactly the flat horizon it was added to fix. */
    const far = Math.min(1, Math.max(0, (d - 190) / 170)) * (1 - shoreK);
    if (far > 0) {
      const ridge = 1 - Math.abs(noise(x * scale * 1.1, z * scale * 1.1) * 2 - 1);
      h += Math.pow(ridge, 1.7) * relief * 8.5 * far * far;
      h += (noise(x * scale * 2.6, z * scale * 2.6) - 0.5) * relief * 3.0 * far;
    }

    /* Level the beam-in site, and blend the level out so the join is not a step.
     *
     * The radius has to shrink on a coast, and the reason is pure sightlines.
     * A standing eye is 1.68 m up; to see water three metres below, the ray
     * leaves at about 10°, and *any* level ground further out than about ten
     * metres is above that ray and hides everything beyond it. Risa's bay was
     * rendering as a 30-pixel strip at the horizon for exactly this reason —
     * not because the water was missing, but because a 14 m level pad was
     * standing in front of it. */
    const flat = 1 - Math.min(1, Math.max(0, (d - flatR) / flatBlend));
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
