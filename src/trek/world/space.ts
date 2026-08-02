/**
 * Everything outside the hull: the star, the starfield, the planets, the
 * nebula, and the rocks.
 *
 * The whole file is in service of one problem. Space on television is not
 * space — it is a black cyclorama with a bright key light off one side and
 * just enough fill that the hull never goes fully black, because an audience
 * cannot follow a battle between two silhouettes. So the lighting here is
 * deliberately theatrical rather than physical: a hard key, a cold rim from
 * behind, and an ambient floor that is far too high to be honest and exactly
 * right to be legible.
 *
 * The six backdrops are the six places the episodes happen. Switching between
 * them swaps the background, the fog, the planet and the rocks in one call, so
 * a mission script never touches a material.
 */
import * as THREE from "three";
import { createNoise3D } from "simplex-noise";
import type { SpaceSceneName, SpaceService, System, TrekCtx } from "../types";

interface PlanetLook {
  ocean: string;
  land: string;
  highland: string;
  ice: string;
  cloud: number;
  /** City lights on the night side — a colony has them, an unclaimed world does not. */
  lights: boolean;
  atmosphere: number;
}

const LOOKS: Record<string, PlanetLook> = {
  earthlike: { ocean: "#123a63", land: "#3d6b3a", highland: "#8b7c56", ice: "#e8f0f6", cloud: 0.55, lights: true, atmosphere: 0x5fa8ff },
  colony: { ocean: "#1d4a58", land: "#6a7a41", highland: "#9c8a5c", ice: "#dfe8ee", cloud: 0.38, lights: true, atmosphere: 0x6ec6c0 },
  dead: { ocean: "#3a2f28", land: "#5a4a3a", highland: "#7c6a52", ice: "#9a9086", cloud: 0.06, lights: false, atmosphere: 0x8a6a4a },
  outpost: { ocean: "#2b2f38", land: "#4a4f58", highland: "#6d727c", ice: "#c9d2da", cloud: 0.12, lights: false, atmosphere: 0x6a7f9a },
};

/**
 * A planet, painted once into an equirectangular canvas.
 *
 * Sampling 3D simplex noise on the unit sphere rather than 2D noise on the
 * rectangle is what stops the seam at 180° and the pinch at the poles, which
 * are the two things that give a procedural planet away instantly.
 */
function planetTextures(look: PlanetLook, seed: number, size = 768) {
  const noise = createNoise3D(mulberry(seed));
  const w = size;
  const h = size / 2;

  const surface = document.createElement("canvas");
  surface.width = w;
  surface.height = h;
  const sg = surface.getContext("2d")!;
  const img = sg.createImageData(w, h);

  const night = document.createElement("canvas");
  night.width = w;
  night.height = h;
  const ng = night.getContext("2d")!;
  ng.fillStyle = "#000000";
  ng.fillRect(0, 0, w, h);

  const ocean = hex(look.ocean);
  const land = hex(look.land);
  const highland = hex(look.highland);
  const ice = hex(look.ice);

  const fbm = (x: number, y: number, z: number, octaves: number) => {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      v += noise(x * f, y * f, z * f) * amp;
      f *= 2.07;
      amp *= 0.5;
    }
    return v;
  };

  for (let j = 0; j < h; j++) {
    const phi = (j / (h - 1)) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let i = 0; i < w; i++) {
      const theta = (i / w) * Math.PI * 2;
      const x = sp * Math.cos(theta);
      const y = cp;
      const z = sp * Math.sin(theta);

      const e = fbm(x * 1.8, y * 1.8, z * 1.8, 5) + 0.06;
      const lat = Math.abs(cp);
      const polar = Math.max(0, (lat - 0.72) / 0.28);

      let c: [number, number, number];
      if (e < 0) {
        // Shelf shading: shallow water at the coast reads as a coastline.
        const depth = Math.min(1, -e * 4);
        c = mix(mix(ocean, [90, 150, 190], 0.35), ocean, depth);
      } else if (e < 0.22) {
        c = mix(land, highland, Math.min(1, e / 0.22));
      } else {
        c = mix(highland, [232, 228, 218], Math.min(1, (e - 0.22) / 0.3));
      }
      if (polar > 0) c = mix(c, ice, Math.min(1, polar * (0.6 + e)));

      const k = (j * w + i) * 4;
      img.data[k] = c[0];
      img.data[k + 1] = c[1];
      img.data[k + 2] = c[2];
      img.data[k + 3] = 255;

      // City lights: only on land, only away from the poles, and clustered by
      // a second noise field so they form regions instead of a spray.
      if (look.lights && e > 0.005 && e < 0.3 && polar < 0.3) {
        const density = fbm(x * 6 + 40, y * 6, z * 6, 3);
        if (density > 0.16 && Math.random() < (density - 0.16) * 1.2) {
          ng.fillStyle = Math.random() < 0.25 ? "rgba(255,220,150,0.9)" : "rgba(255,190,110,0.75)";
          ng.fillRect(i, j, 1, 1);
        }
      }
    }
  }
  sg.putImageData(img, 0, 0);

  // Clouds, on their own transparent canvas so the shell can rotate.
  const clouds = document.createElement("canvas");
  clouds.width = w;
  clouds.height = h;
  const cg = clouds.getContext("2d")!;
  const cimg = cg.createImageData(w, h);
  if (look.cloud > 0.01) {
    for (let j = 0; j < h; j++) {
      const phi = (j / (h - 1)) * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      for (let i = 0; i < w; i++) {
        const theta = (i / w) * Math.PI * 2;
        // Stretched horizontally: weather on a spinning ball forms bands.
        const x = sp * Math.cos(theta) * 2.6;
        const y = cp * 5.5;
        const z = sp * Math.sin(theta) * 2.6;
        const v = fbm(x, y, z, 4);
        const a = Math.max(0, v - (0.62 - look.cloud * 0.6)) * 3.4;
        const k = (j * w + i) * 4;
        cimg.data[k] = 255;
        cimg.data[k + 1] = 255;
        cimg.data[k + 2] = 255;
        cimg.data[k + 3] = Math.min(235, a * 255);
      }
    }
  }
  cg.putImageData(cimg, 0, 0);

  const mk = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return { map: mk(surface, true), lights: mk(night, true), clouds: mk(clouds, true) };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(s: string): [number, number, number] {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The starfield, as an equirectangular background.
 *
 * Weighted hard toward faint stars: a sky of evenly bright points looks like
 * a screensaver. The galactic band across the middle is what makes it look
 * like a photograph of somewhere rather than a noise field.
 */
function starTexture(seed: number): THREE.Texture {
  const rnd = mulberry(seed);
  const w = 2048;
  const h = 1024;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#02030a";
  g.fillRect(0, 0, w, h);

  // The band: soft, dusty, slightly warm, drawn as a few hundred blurred
  // blobs along a great circle.
  for (let i = 0; i < 420; i++) {
    const t = rnd();
    const x = t * w;
    const y = h * 0.5 + Math.sin(t * Math.PI * 2) * h * 0.16 + (rnd() - 0.5) * h * 0.13;
    const r = 40 + rnd() * 160;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() < 0.5;
    grad.addColorStop(0, warm ? "rgba(90,80,110,0.09)" : "rgba(70,90,120,0.08)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  for (let i = 0; i < 9000; i++) {
    const bandPull = rnd() < 0.45;
    const x = rnd() * w;
    const y = bandPull
      ? h * 0.5 + (rnd() - 0.5) * h * 0.34 + Math.sin((x / w) * Math.PI * 2) * h * 0.14
      : rnd() * h;
    const b = rnd() ** 3.2;
    const size = b > 0.86 ? 2.2 : b > 0.55 ? 1.4 : 0.9;
    const tint = rnd();
    const col =
      tint < 0.1 ? [190, 205, 255] : tint < 0.2 ? [255, 220, 190] : tint < 0.27 ? [255, 190, 160] : [235, 240, 255];
    g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.22 + b * 0.78})`;
    g.beginPath();
    g.arc(x, y, size, 0, Math.PI * 2);
    g.fill();
  }

  // A dozen bright ones with a cross flare, because the eye looks for them.
  for (let i = 0; i < 14; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 5 + rnd() * 4;
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 4);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.3, "rgba(200,220,255,0.35)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    g.strokeStyle = "rgba(255,255,255,0.3)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x - r * 3.4, y);
    g.lineTo(x + r * 3.4, y);
    g.moveTo(x, y - r * 3.4);
    g.lineTo(x, y + r * 3.4);
    g.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round puff, for nebula billboards and explosion cores. */
export function puffTexture(hard = 0.0): THREE.Texture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(Math.max(0.02, hard), "rgba(255,255,255,0.82)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.24)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createSpace(ctx: TrekCtx): System {
  const { space, rng, quality } = ctx;

  // -- Lighting. See the header: theatrical, not physical. ------------------
  const key = new THREE.DirectionalLight(0xfff2e0, 3.0);
  key.position.set(-0.55, 0.42, -0.72).normalize().multiplyScalar(1e5);
  space.add(key);
  const rim = new THREE.DirectionalLight(0xa8c4e8, 0.85);
  rim.position.set(0.7, -0.2, 0.68).normalize().multiplyScalar(1e5);
  space.add(rim);
  // Desaturated on purpose. A saturated blue fill is the default look of every
  // amateur space render, and it turns a light grey hull — which is what a
  // Constitution class is — into navy. The shadow side of the Enterprise on
  // film is *grey*, not blue, because the fill on that stage was white card.
  const fill = new THREE.HemisphereLight(0x9aa4b4, 0x2a2c33, 1.15);
  space.add(fill);
  const ambient = new THREE.AmbientLight(0x6a7080, 0.85);
  space.add(ambient);

  const sunDirection = key.position.clone().normalize();

  // -- The star itself, as a billboard. -------------------------------------
  const puff = puffTexture(0.16);
  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: puff, color: 0xfff4d8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  sun.scale.setScalar(150000);
  sun.position.copy(sunDirection).multiplyScalar(1.5e6);
  space.add(sun);

  // -- Starfield. ------------------------------------------------------------
  const stars = starTexture(0x1701);
  space.background = stars;

  // -- Planet. --------------------------------------------------------------
  // Not to scale, and deliberately so. A real class-M world at a real orbital
  // distance is either a marble or a wall, and neither is the shot the show
  // uses: the planet is always a third of the frame, close enough to feel like
  // somewhere and far enough to be scenery. 14 km across at 65 km out gives
  // that framing — and keeps the whole backdrop inside the depth band the
  // near/far planes can actually resolve. See NEAR_PLANE in types.ts.
  const PLANET_R = 14000;
  const planetGroup = new THREE.Group();
  planetGroup.visible = false;
  space.add(planetGroup);

  let planetTex: ReturnType<typeof planetTextures> | null = null;
  const planetMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R, 64, 40), planetMat);
  planetGroup.add(planet);

  const cloudMat = new THREE.MeshStandardMaterial({ transparent: true, roughness: 1, metalness: 0, depthWrite: false });
  const cloudShell = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.012, 48, 30), cloudMat);
  planetGroup.add(cloudShell);

  // Atmospheric limb — a rim of scattered light that only shows where the
  // surface curves away. Without it a planet is a sticker.
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColour: { value: new THREE.Color(0x5fa8ff) }, uSun: { value: sunDirection.clone() } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp; }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      uniform vec3 uColour; uniform vec3 uSun;
      void main(){
        vec3 v = normalize(cameraPosition - vW);
        float f = pow(clamp(1.0 - abs(dot(vN, v)), 0.0, 1.0), 3.0);
        float lit = clamp(dot(normalize(-vN), normalize(uSun)) * 0.5 + 0.55, 0.0, 1.0);
        gl_FragColor = vec4(uColour, f * lit * 0.9);
      }
    `,
  });
  planetGroup.add(new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.045, 48, 30), atmoMat));

  const nightMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 });
  const nightShell = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.001, 64, 40), nightMat);
  planetGroup.add(nightShell);

  function setPlanet(lookName: keyof typeof LOOKS | null, position: THREE.Vector3, radiusScale = 1): void {
    if (!lookName) {
      planetGroup.visible = false;
      return;
    }
    const look = LOOKS[lookName];
    planetTex?.map.dispose();
    planetTex?.clouds.dispose();
    planetTex?.lights.dispose();
    planetTex = planetTextures(look, 0xbeef ^ lookName.length * 977, quality === "low" ? 384 : 768);
    planetMat.map = planetTex.map;
    planetMat.needsUpdate = true;
    cloudMat.map = planetTex.clouds;
    cloudMat.alphaMap = planetTex.clouds;
    cloudMat.needsUpdate = true;
    nightMat.map = planetTex.lights;
    nightMat.needsUpdate = true;
    nightShell.visible = look.lights;
    (atmoMat.uniforms.uColour.value as THREE.Color).setHex(look.atmosphere);
    planetGroup.position.copy(position);
    planetGroup.scale.setScalar(radiusScale);
    planetGroup.visible = true;
  }

  // -- Nebula. --------------------------------------------------------------
  // Sprites rather than volumetrics: fifty additive billboards drifting past
  // the camera is what the Mutara Nebula actually was on film, and it reads
  // better than any amount of ray-marching at a fraction of the cost.
  const nebula = new THREE.Group();
  nebula.visible = false;
  space.add(nebula);
  const nebulaSprites: THREE.Sprite[] = [];
  {
    const count = quality === "low" ? 26 : 60;
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: puff,
          color: new THREE.Color().setHSL(rng.range(0.52, 0.98), 0.7, 0.45),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: rng.range(0.08, 0.26),
        }),
      );
      s.position.set(rng.gauss() * 9000, rng.gauss() * 5000, rng.gauss() * 9000);
      s.scale.setScalar(rng.range(4000, 14000));
      nebula.add(s);
      nebulaSprites.push(s);
    }
  }
  const nebulaFlash = new THREE.PointLight(0xff88cc, 0, 40000, 2);
  nebula.add(nebulaFlash);
  let flashAt = 3;

  // -- Rocks. ---------------------------------------------------------------
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(
    rockGeo,
    new THREE.MeshStandardMaterial({ color: 0x6a6259, roughness: 1, metalness: 0.15, flatShading: true }),
    260,
  );
  rocks.visible = false;
  rocks.frustumCulled = false;
  space.add(rocks);
  const rockSpin: { axis: THREE.Vector3; rate: number; m: THREE.Matrix4 }[] = [];
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < 260; i++) {
      // A belt with a hole in it. Scattered around the origin, the rocks end
      // up parked in front of the viewscreen and between the two ships — and
      // a boulder filling the main viewer during a battle is not atmosphere,
      // it is an obstruction. Everything is pushed outside 5 km.
      const a2 = rng.range(0, Math.PI * 2);
      const r2 = 5000 + Math.abs(rng.gauss()) * 5200;
      p.set(Math.cos(a2) * r2, rng.gauss() * 1500, Math.sin(a2) * r2);
      q.setFromEuler(new THREE.Euler(rng.range(0, 7), rng.range(0, 7), rng.range(0, 7)));
      const size = rng.range(12, 190) * (rng.chance(0.08) ? 3.5 : 1);
      s.set(size, size * rng.range(0.6, 1.2), size * rng.range(0.6, 1.3));
      m.compose(p, q, s);
      rocks.setMatrixAt(i, m);
      rockSpin.push({ axis: new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).normalize(), rate: rng.range(-0.2, 0.2), m: m.clone() });
    }
    rocks.instanceMatrix.needsUpdate = true;
  }

  // -- Station. -------------------------------------------------------------
  // A spacedock: a core spindle, a habitat ring, and the running lights that
  // make it read as inhabited from ten kilometres out.
  const station = new THREE.Group();
  station.visible = false;
  space.add(station);
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8afb8, roughness: 0.6, metalness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3d444d, roughness: 0.8, metalness: 0.4 });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 420, 24), mat);
    station.add(core);
    const capTop = new THREE.Mesh(new THREE.SphereGeometry(70, 24, 14), mat);
    capTop.position.y = 210;
    station.add(capTop);
    const capBottom = capTop.clone();
    capBottom.position.y = -210;
    station.add(capBottom);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(340, 34, 14, 48), mat);
    ring.rotation.x = Math.PI / 2;
    station.add(ring);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(270, 18, 18), dark);
      spoke.position.set(Math.cos(a) * 205, 0, Math.sin(a) * 205);
      spoke.rotation.y = -a;
      station.add(spoke);
    }
    for (let i = 0; i < 90; i++) {
      const a = rng.range(0, Math.PI * 2);
      const lamp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: puff,
          color: rng.chance(0.2) ? 0xff5a4a : rng.chance(0.4) ? 0x8fd8ff : 0xffdca0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        }),
      );
      const onRing = rng.chance(0.6);
      lamp.position.set(
        Math.cos(a) * (onRing ? 340 : 74),
        onRing ? rng.range(-30, 30) : rng.range(-210, 210),
        Math.sin(a) * (onRing ? 340 : 74),
      );
      lamp.scale.setScalar(rng.range(26, 52));
      station.add(lamp);
    }
  }

  // -------------------------------------------------------------------------

  let current: SpaceSceneName = "deepSpace";
  const service: SpaceService = {
    interference: 0,
    sunDirection,
    setScene(name) {
      current = name;
      nebula.visible = false;
      rocks.visible = false;
      station.visible = false;
      space.fog = null;
      space.background = stars;
      service.interference = 0;

      switch (name) {
        case "spacedock":
          setPlanet("earthlike", new THREE.Vector3(-16000, -22000, -62000));
          station.visible = true;
          station.position.set(2600, 400, -5200);
          break;
        case "neutralZone":
          setPlanet(null, new THREE.Vector3());
          rocks.visible = true;
          break;
        case "colony":
          setPlanet("colony", new THREE.Vector3(20000, -18000, -66000));
          break;
        case "l374":
          setPlanet("dead", new THREE.Vector3(-26000, -12000, -74000), 0.7);
          rocks.visible = true;
          break;
        case "mutara":
          setPlanet(null, new THREE.Vector3());
          nebula.visible = true;
          // The nebula is the reason the finale works: sensors are useless,
          // shields will not hold, and both ships are reduced to listening.
          space.fog = new THREE.FogExp2(0x6a2f5e, 0.000085);
          space.background = new THREE.Color(0x2a0f2a);
          service.interference = 1;
          break;
        default:
          setPlanet(null, new THREE.Vector3());
          break;
      }
    },
  };
  service.setScene("deepSpace");
  ctx.services.space = service;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  return {
    update(dt, c) {
      if (planetGroup.visible) {
        planet.rotation.y += dt * 0.004;
        nightShell.rotation.y = planet.rotation.y;
        cloudShell.rotation.y += dt * 0.0055;
      }
      if (rocks.visible) {
        for (let i = 0; i < rockSpin.length; i++) {
          const r = rockSpin[i];
          r.m.decompose(p, q, s);
          q.multiply(new THREE.Quaternion().setFromAxisAngle(r.axis, r.rate * dt));
          m.compose(p, q, s);
          r.m.copy(m);
          rocks.setMatrixAt(i, m);
        }
        rocks.instanceMatrix.needsUpdate = true;
      }
      if (nebula.visible) {
        nebula.rotation.y += dt * 0.008;
        // Static discharge. In the film it is what lights the ships at all.
        flashAt -= dt;
        if (flashAt <= 0) {
          flashAt = rng.range(1.4, 5.5);
          nebulaFlash.position.set(rng.gauss() * 6000, rng.gauss() * 3000, rng.gauss() * 6000);
          nebulaFlash.color.setHSL(rng.range(0.55, 0.95), 0.8, 0.6);
          nebulaFlash.intensity = rng.range(60, 220);
        }
        nebulaFlash.intensity *= Math.exp(-dt * 6);
        for (const sp of nebulaSprites) sp.material.rotation += dt * 0.05;
      }
      // The star sits at a fixed direction from wherever the action is, so it
      // never slides off as the ships manoeuvre across the system.
      sun.position.copy(c.viewCam.position).addScaledVector(sunDirection, 1.5e6);
      void current;
    },

    dispose() {
      stars.dispose();
      puff.dispose();
      planetTex?.map.dispose();
      planetTex?.clouds.dispose();
      planetTex?.lights.dispose();
      rockGeo.dispose();
    },
  };
}
