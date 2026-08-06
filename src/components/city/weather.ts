/**
 * weather — GOD MODE. Rain, snow and thunderstorms over the whole world.
 *
 * Two halves, and both matter. The particles are the obvious one: a box
 * of rain streaks or snowflakes that TRAVELS WITH YOU, wrapping each
 * particle back to the top of the volume when it falls out the bottom, so
 * a few thousand of them cover an entire city without ever being drawn
 * where nobody is looking.
 *
 * The other half is the atmosphere. Rain that leaves the sky a cheerful
 * blue reads as confetti; what actually sells weather is the light going
 * flat and grey, the fog closing in, and — in a storm — the whole world
 * going white for two frames while the thunder catches up. So this module
 * is handed the same sky/fog/light handles the day/night switch owns, and
 * it layers on top of whatever that has already set.
 */
import * as THREE from "three";

export type WeatherKind = "clear" | "rain" | "snow" | "storm";

export const WEATHERS: { kind: WeatherKind; label: string; emoji: string }[] = [
  { kind: "clear", label: "Clear", emoji: "☀️" },
  { kind: "rain", label: "Rain", emoji: "🌧️" },
  { kind: "snow", label: "Snow", emoji: "❄️" },
  { kind: "storm", label: "Storm", emoji: "⛈️" },
];

/** The scene handles the day/night switch already owns. */
export interface WeatherTargets {
  scene: THREE.Scene;
  fog: THREE.Fog;
  ambient: THREE.Light;
  hemi: THREE.HemisphereLight;
  sun: THREE.Light;
  skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uSunPower: { value: number };
  };
}

export interface WeatherSystem {
  group: THREE.Group;
  set(kind: WeatherKind): void;
  get(): WeatherKind;
  /** Call every frame with the player/camera position. */
  update(dt: number, center: THREE.Vector3): void;
  /**
   * Re-apply the weather tint. Call right after the day/night switch, which
   * resets every handle to its clear-sky value.
   */
  applyAtmosphere(day: boolean): void;
  /** Fires when lightning strikes, for thunder. */
  onFlash(cb: () => void): void;
  dispose(): void;
}

// The volume that follows the player. Big enough that you never see an
// edge, small enough that a few thousand particles feel dense inside it.
const BOX_XZ = 70;
const BOX_Y = 55;
const RAIN_COUNT = 2600;
const SNOW_COUNT = 1800;

export function createWeather(targets: WeatherTargets): WeatherSystem {
  const group = new THREE.Group();
  let kind: WeatherKind = "clear";
  let flashCb: (() => void) | null = null;
  let lastDay = true;

  // ---- Rain: line segments, because a streak reads as speed ----------
  const rainGeo = new THREE.BufferGeometry();
  const rainPos = new Float32Array(RAIN_COUNT * 2 * 3); // 2 verts per drop
  const rainSeed = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    const x = (Math.random() - 0.5) * BOX_XZ;
    const y = Math.random() * BOX_Y;
    const z = (Math.random() - 0.5) * BOX_XZ;
    rainPos.set([x, y, z, x, y - 0.9, z], i * 6);
    rainSeed[i] = 0.7 + Math.random() * 0.6;
  }
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({
    color: 0xbcd8ee, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  group.add(rain);

  // ---- Snow: soft round points that drift sideways -------------------
  const flake = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.85)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const snowGeo = new THREE.BufferGeometry();
  const snowPos = new Float32Array(SNOW_COUNT * 3);
  const snowSeed = new Float32Array(SNOW_COUNT);
  for (let i = 0; i < SNOW_COUNT; i++) {
    snowPos.set(
      [(Math.random() - 0.5) * BOX_XZ, Math.random() * BOX_Y, (Math.random() - 0.5) * BOX_XZ],
      i * 3,
    );
    snowSeed[i] = Math.random() * Math.PI * 2;
  }
  snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
  const snowMat = new THREE.PointsMaterial({
    size: 0.42, map: flake, transparent: true, opacity: 0.95,
    depthWrite: false, sizeAttenuation: true,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  snow.visible = false;
  group.add(snow);

  // ---- Storm: a light that fires the flash ---------------------------
  // A directional light rather than a fullscreen quad: it lights the tops
  // of the buildings for two frames, which is what makes it feel like it
  // came from the sky rather than from the camera.
  const bolt = new THREE.DirectionalLight(0xdcefff, 0);
  bolt.position.set(40, 120, 20);
  group.add(bolt);
  let nextStrike = 4 + Math.random() * 8;
  let flash = 0; // 0..1, decays

  let t = 0;
  const tmp = new THREE.Vector3();

  const applyAtmosphere = (day: boolean) => {
    lastDay = day;
    const { fog, ambient, hemi, sun, skyUniforms, scene } = targets;
    if (kind === "clear") return; // day/night already set the truth

    // Grey the light down and pull the fog in. Storm goes furthest; snow
    // stays brighter than rain because snow throws light back at you.
    const heavy = kind === "storm";
    const bright = kind === "snow";
    const gloom = heavy ? 0.42 : bright ? 0.86 : 0.62;

    ambient.intensity *= gloom * (bright ? 1.15 : 1);
    hemi.intensity *= gloom;
    sun.intensity *= heavy ? 0.28 : bright ? 0.62 : 0.45;

    const skyCol = new THREE.Color(
      day
        ? (heavy ? "#3a414d" : bright ? "#c3cede" : "#8c98a8")
        : (heavy ? "#05070c" : bright ? "#141c2a" : "#0a1017"),
    );
    (scene.background as THREE.Color).lerp(skyCol, 0.85);
    fog.color.lerp(skyCol, 0.85);
    // Weather is the only thing in the world that shortens sight lines.
    fog.near *= heavy ? 0.35 : bright ? 0.5 : 0.55;
    fog.far *= heavy ? 0.4 : bright ? 0.52 : 0.6;
    skyUniforms.uZenith.value.lerp(skyCol, 0.8);
    skyUniforms.uHorizon.value.lerp(skyCol, 0.7);
    skyUniforms.uSunPower.value *= heavy ? 0.15 : 0.5;
  };

  return {
    group,
    get: () => kind,
    set(next) {
      kind = next;
      rain.visible = next === "rain" || next === "storm";
      snow.visible = next === "snow";
      rainMat.opacity = next === "storm" ? 0.7 : 0.55;
      rainMat.color.set(next === "storm" ? 0xa8c4dd : 0xbcd8ee);
      if (next !== "storm") {
        bolt.intensity = 0;
        flash = 0;
      }
      nextStrike = 2 + Math.random() * 6;
    },
    update(dt, center) {
      if (kind === "clear") return;
      t += dt;
      // The volume rides with the player, so particles are only ever
      // simulated where somebody can see them.
      group.position.set(center.x, center.y - BOX_Y * 0.25, center.z);

      if (rain.visible) {
        const fall = (kind === "storm" ? 62 : 42) * dt;
        // Storms come in sideways; that slant is most of the drama.
        const slantX = (kind === "storm" ? 16 : 4) * dt;
        const p = rainGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < RAIN_COUNT; i++) {
          const o = i * 6;
          const d = fall * rainSeed[i];
          p[o + 1] -= d; p[o + 4] -= d;
          p[o] += slantX; p[o + 3] += slantX;
          if (p[o + 1] < 0) {
            const x = (Math.random() - 0.5) * BOX_XZ;
            const z = (Math.random() - 0.5) * BOX_XZ;
            const y = BOX_Y;
            const len = kind === "storm" ? 1.5 : 0.9;
            p[o] = x; p[o + 1] = y; p[o + 2] = z;
            p[o + 3] = x - slantX * 3; p[o + 4] = y - len; p[o + 5] = z;
          }
        }
        rainGeo.attributes.position.needsUpdate = true;
      }

      if (snow.visible) {
        const p = snowGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < SNOW_COUNT; i++) {
          const o = i * 3;
          // Flakes don't fall, they wander down — the sway is the whole
          // difference between snow and white rain.
          p[o] += Math.sin(t * 0.7 + snowSeed[i]) * dt * 1.6;
          p[o + 1] -= (2.4 + (i % 5) * 0.35) * dt;
          p[o + 2] += Math.cos(t * 0.55 + snowSeed[i] * 1.3) * dt * 1.3;
          if (p[o + 1] < 0) {
            p[o] = (Math.random() - 0.5) * BOX_XZ;
            p[o + 1] = BOX_Y;
            p[o + 2] = (Math.random() - 0.5) * BOX_XZ;
          }
        }
        snowGeo.attributes.position.needsUpdate = true;
      }

      if (kind === "storm") {
        nextStrike -= dt;
        if (nextStrike <= 0) {
          flash = 1;
          nextStrike = 5 + Math.random() * 12;
          flashCb?.();
        }
        if (flash > 0) {
          // Two quick pulses then a decay — a single ramp reads as a lamp
          // being switched on, not as lightning.
          flash = Math.max(0, flash - dt * 3.4);
          const pulse = flash > 0.72 ? 1 : flash > 0.55 ? 0.35 : flash;
          bolt.intensity = pulse * 14;
          targets.ambient.intensity += pulse * 1.1;
        } else {
          bolt.intensity = 0;
        }
      }
    },
    applyAtmosphere,
    onFlash(cb) { flashCb = cb; },
    dispose() {
      rainGeo.dispose(); rainMat.dispose();
      snowGeo.dispose(); snowMat.dispose(); flake.dispose();
      group.clear();
    },
  };
}
