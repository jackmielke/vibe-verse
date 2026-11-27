/**
 * Vibe City's four skies: Day, Sunset, Night and Aurora.
 *
 * The world has always had one switch, day or night, and `applyMode` in
 * City.tsx owns every handle that crossing touches (sky dome, fog, three
 * lights, the sun disk, the facades, the sea). A look is layered on top of
 * that the same way the weather is: `applyMode` resets everything to plain
 * day or plain night, then calls `apply(look)`, then the weather tints the
 * result. So a look never has to remember what it changed; the next pass
 * rebuilds from scratch.
 *
 *  - Sunset is a day look. The sun drops to six degrees over the sea, the
 *    light goes amber, the horizon burns orange into a violet zenith, and the
 *    shadows run the length of a block.
 *  - Aurora is a night look. Curtains of green and violet light hang over
 *    the north sky and ripple, and the night picks up a little of their
 *    colour. They follow the camera, like the sky dome, so they are always
 *    on the horizon and never somewhere you can fly into.
 *
 * Pure presentation: nothing here touches collision or gameplay.
 */
import * as THREE from "three";

export type SkyLook = "day" | "sunset" | "night" | "aurora";

export const SKY_LOOKS: Array<{ look: SkyLook; label: string; emoji: string; day: boolean }> = [
  { look: "day", label: "Day", emoji: "☀️", day: true },
  { look: "sunset", label: "Sunset", emoji: "🌅", day: true },
  { look: "night", label: "Night", emoji: "🌙", day: false },
  { look: "aurora", label: "Aurora", emoji: "🌌", day: false },
];

export const isDayLook = (l: SkyLook) => l === "day" || l === "sunset";

/** The look a given day/night flag should show, keeping a compatible choice. */
export function lookFor(day: boolean, wanted: SkyLook): SkyLook {
  if (isDayLook(wanted) === day) return wanted;
  return day ? "day" : "night";
}

export function parseLook(v: unknown): SkyLook | null {
  return v === "day" || v === "sunset" || v === "night" || v === "aurora" ? v : null;
}

export interface SkyTargets {
  scene: THREE.Scene;
  /** The sea's colours, so the water goes copper at sunset. */
  setOcean?: (p: { shallow: string; deep: string; foam: string; cityGlow: string; sunStrength: number }) => void;
  fog: THREE.Fog;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  moon: THREE.Mesh;
  moonMat: THREE.MeshBasicMaterial;
  skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uSun: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uSunPower: { value: number };
  };
}

export interface CitySky {
  group: THREE.Group;
  /** Call at the end of the day/night pass, before the weather. */
  apply(look: SkyLook): void;
  get(): SkyLook;
  update(dt: number, camera: THREE.Vector3): void;
  /** Skip the fade, for screenshots. */
  snap(): void;
  dispose(): void;
}

// Where City.tsx puts the light and the disk for ordinary day and night.
const SUN_POS = new THREE.Vector3(300, 210, -170);
const MOON_POS = new THREE.Vector3(620, 430, -900);
// Sunset: over the Pacific, which is west (-x) past the marina, six degrees up.
// The shadows then run east down the avenues.
const SUNSET_DIR = new THREE.Vector3(-1, 0, 0.32).normalize().setY(0.105).normalize();

export function createCitySky(t: SkyTargets): CitySky {
  const group = new THREE.Group();
  group.name = "city-sky";
  let look: SkyLook = "night";

  // ---- Aurora curtains ------------------------------------------------------
  const auroraUniforms = { uTime: { value: 0 }, uStrength: { value: 0 } };
  const auroraMat = new THREE.ShaderMaterial({
    uniforms: auroraUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        vec3 p = position;
        // Slow folds along the curtain, so it billows rather than slides.
        float f = sin(uv.x * 9.0 + uTime * 0.11 + aSeed * 6.0) * 0.6
                + sin(uv.x * 23.0 - uTime * 0.07 + aSeed * 3.0) * 0.25;
        p += normal * f * 70.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uStrength;
      varying vec2 vUv;
      varying float vSeed;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float noise(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
      }
      void main() {
        float x = vUv.x * 120.0 + vSeed * 40.0;
        // Vertical rays: thin bright streaks that drift and breathe.
        float rays = noise(x + uTime * 0.35) * 0.65 + noise(x * 2.7 - uTime * 0.6) * 0.35;
        rays = pow(rays, 2.2) * 1.6 + 0.12;
        float v = vUv.y;
        // A sharp lower hem, a long fade upward.
        float body = smoothstep(0.0, 0.07, v) * pow(1.0 - v, 1.6);
        float ends = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float pulse = 0.75 + 0.25 * sin(uTime * 0.23 + vSeed * 5.0 + vUv.x * 4.0);
        vec3 green = vec3(0.18, 1.0, 0.55);
        vec3 teal = vec3(0.1, 0.75, 0.9);
        vec3 violet = vec3(0.75, 0.3, 1.0);
        vec3 col = mix(green, teal, smoothstep(0.1, 0.45, v) * 0.5);
        col = mix(col, violet, smoothstep(0.35, 0.9, v));
        float a = body * ends * rays * pulse * uStrength * 1.7;
        gl_FragColor = vec4(col * a, 1.0);
      }
    `,
  });
  const auroraGeos: THREE.BufferGeometry[] = [];
  const aurora = new THREE.Group();
  aurora.name = "aurora";
  const bands: Array<{ yaw: number; dist: number; base: number; tall: number; wide: number }> = [
    { yaw: -0.15, dist: 1500, base: 210, tall: 520, wide: 1900 },
    { yaw: 0.45, dist: 1700, base: 280, tall: 600, wide: 1600 },
    { yaw: -0.75, dist: 1350, base: 180, tall: 420, wide: 1300 },
    { yaw: 0.05, dist: 1100, base: 330, tall: 380, wide: 1100 },
  ];
  bands.forEach((b, i) => {
    // A shallow arc, so the curtain wraps the horizon instead of being a wall.
    const g = new THREE.PlaneGeometry(b.wide, b.tall, 96, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k);
      const bend = (x / b.wide) * 2;
      pos.setZ(k, bend * bend * 260);
    }
    g.computeVertexNormals();
    const seeds = new Float32Array(pos.count).fill(i * 1.37 + 0.2);
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    auroraGeos.push(g);
    const m = new THREE.Mesh(g, auroraMat);
    // North is -z. Face the curtain back toward the city.
    const dx = Math.sin(b.yaw) * b.dist;
    const dz = -Math.cos(b.yaw) * b.dist;
    m.position.set(dx, b.base + b.tall / 2, dz);
    m.rotation.y = -b.yaw;
    m.frustumCulled = false;
    m.renderOrder = -900;
    aurora.add(m);
  });
  aurora.visible = false;
  group.add(aurora);

  // ---- Sunset glow on the sea horizon ----------------------------------------
  // The sky dome's scatter term is broad and weak by design; a sunset also
  // wants a hot band right along the water under the disk.
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(128, 32, 0, 128, 32, 128);
    grad.addColorStop(0, "rgba(255,190,110,1)");
    grad.addColorStop(0.35, "rgba(255,120,70,0.55)");
    grad.addColorStop(1, "rgba(255,80,60,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 64);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  })();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2200, 420), glowMat);
  glow.visible = false;
  glow.renderOrder = -950;
  glow.frustumCulled = false;
  group.add(glow);

  const apply = (next: SkyLook) => {
    look = next;
    const { skyUniforms: u } = t;
    aurora.visible = look === "aurora";
    glow.visible = look === "sunset";
    if (look === "sunset") {
      u.uZenith.value.set("#34407a");
      u.uHorizon.value.set("#ff9b62");
      u.uGround.value.set("#5a3f52");
      u.uSunColor.value.set("#ffb066");
      u.uSunPower.value = 1.7;
      u.uSun.value.copy(SUNSET_DIR);
      t.fog.color.set("#f0a47e");
      t.fog.near = 150;
      t.fog.far = 950;
      t.ambient.color.set(0xffd0b0);
      t.ambient.intensity = 0.5;
      t.hemi.color.set(0xffc49c);
      t.hemi.groundColor.set(0x5b4763);
      t.hemi.intensity = 1.55;
      t.sun.color.set(0xffa25a);
      t.sun.intensity = 3.0;
      // The light keeps its distance from the district; only its angle moves.
      t.sun.position.copy(SUNSET_DIR).multiplyScalar(SUN_POS.length());
      t.moon.position.copy(SUNSET_DIR).multiplyScalar(MOON_POS.length());
      t.moon.scale.setScalar(1.25);
      t.moonMat.color.set(0xffa848);
      t.setOcean?.({ shallow: "#4d7f8c", deep: "#1b2442", foam: "#ffe0c8", cityGlow: "#000000", sunStrength: 1.6 });
    } else {
      u.uSun.value.copy(SUN_POS).normalize();
      t.sun.position.copy(SUN_POS);
      t.moon.position.copy(MOON_POS);
      t.moon.scale.setScalar(1);
    }
    if (look === "aurora") {
      u.uZenith.value.set("#03101a");
      u.uHorizon.value.set("#072019");
      t.fog.color.set("#06150f");
      t.hemi.color.set(0x2f6a5a);
      t.hemi.intensity = 1.5;
      t.ambient.color.set(0x88bbaa);
      t.setOcean?.({ shallow: "#0c2a2c", deep: "#010a0a", foam: "#a8e8cf", cityGlow: "#12402e", sunStrength: 0.25 });
    }
  };

  let time = 0;
  let strength = 0;
  return {
    group,
    apply,
    get: () => look,
    update(dt, cam) {
      time += dt;
      strength += ((look === "aurora" ? 1 : 0) - strength) * Math.min(1, dt * 1.2);
      auroraUniforms.uTime.value = time;
      auroraUniforms.uStrength.value = strength;
      if (look === "aurora" && strength < 0.02) aurora.visible = true;
      aurora.position.set(cam.x, 0, cam.z);
      if (glow.visible) {
        glow.position.set(cam.x + SUNSET_DIR.x * 2000, 40 + SUNSET_DIR.y * 2000 * 0.5, cam.z + SUNSET_DIR.z * 2000);
        glow.lookAt(cam.x, glow.position.y, cam.z);
      }
    },
    snap() {
      strength = look === "aurora" ? 1 : 0;
      auroraUniforms.uStrength.value = strength;
    },
    dispose() {
      auroraGeos.forEach((g) => g.dispose());
      auroraMat.dispose();
      glow.geometry.dispose();
      glowMat.dispose();
      glowTex.dispose();
    },
  };
}
