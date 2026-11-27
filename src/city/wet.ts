/**
 * Wet streets: the asphalt and pavement turn dark and glossy while it rains,
 * and stay that way for a couple of minutes after it stops.
 *
 * Gloss on its own reads as nothing, because a smooth surface with nothing
 * to reflect is just a darker surface. So the two ground materials are given
 * a small environment map of their own: the current sky's gradient with a
 * band of warm windows and coloured neon round the horizon and a few hot
 * street lamps above. Rough and dim when dry, it is invisible; smooth and
 * strong when soaked, it is the city's lights smeared in the road. The neon
 * signs add their own long streaks on top (`neon.ts` `setWet`).
 *
 * Only these two materials get the map: `scene.environment` would put the
 * same sheen on every facade and car in the world.
 */
import * as THREE from "three";

export interface WetStreets {
  /** 0 dry .. 1 soaked. */
  wetness(): number;
  /** `raining` is the weather right now; the drying is this module's job. */
  update(dt: number, raining: boolean): void;
  /** Rebuild the reflection for a new sky. Cheap enough to call on every look change. */
  setSky(zenith: THREE.Color, horizon: THREE.Color, night: boolean): void;
  /** Soak or dry it at once, for screenshots and the dev hook. */
  force(w: number | null): void;
  dispose(): void;
}

const WET_IN = 1 / 18; // per second while raining: soaked in about 18 s
const DRY_OUT = 1 / 150; // and two and a half minutes to dry

export function createWetStreets(opts: {
  renderer: THREE.WebGLRenderer;
  road: THREE.MeshStandardMaterial;
  pave: THREE.MeshStandardMaterial;
}): WetStreets {
  const { road, pave } = opts;
  const base = {
    road: { rough: road.roughness, metal: road.metalness, color: road.color.clone() },
    pave: { rough: pave.roughness, metal: pave.metalness, color: pave.color.clone() },
  };
  const pmrem = new THREE.PMREMGenerator(opts.renderer);
  let env: THREE.WebGLRenderTarget | null = null;

  const envScene = new THREE.Scene();
  const domeGeo = new THREE.SphereGeometry(50, 32, 16);
  const domeCol = new Float32Array(domeGeo.attributes.position.count * 3);
  domeGeo.setAttribute("color", new THREE.BufferAttribute(domeCol, 3));
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  envScene.add(new THREE.Mesh(domeGeo, domeMat));
  // The horizon band: windows and neon, as a ring of small bright panels.
  const panels = new THREE.Group();
  envScene.add(panels);
  const panelGeo = new THREE.PlaneGeometry(1, 1);
  const panelMats: THREE.MeshBasicMaterial[] = [];
  const NEON = ["#ff3b6b", "#36e3ff", "#ffb02e", "#ff4fd8", "#7dff5a", "#c86bff"];
  {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + rand() * 0.08;
      const neon = rand() < 0.5;
      const m = new THREE.MeshBasicMaterial({ color: neon ? NEON[i % NEON.length] : "#8a7350", side: THREE.DoubleSide });
      panelMats.push(m);
      const p = new THREE.Mesh(panelGeo, m);
      const h = neon ? 1.2 + rand() * 1.5 : 3 + rand() * 9;
      p.scale.set(neon ? 2 + rand() * 2 : 0.8 + rand() * 1.2, h, 1);
      p.position.set(Math.cos(a) * 40, 1 + h / 2 + rand() * 4, Math.sin(a) * 40);
      p.lookAt(0, p.position.y, 0);
      panels.add(p);
    }
    // Street lamps overhead.
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshBasicMaterial({ color: "#fff1c9" });
      panelMats.push(m);
      const p = new THREE.Mesh(panelGeo, m);
      const a = (i / 8) * Math.PI * 2;
      p.scale.set(2.5, 2.5, 1);
      p.position.set(Math.cos(a) * 18, 14, Math.sin(a) * 18);
      p.lookAt(0, 0, 0);
      panels.add(p);
    }
  }

  const setSky = (zenith: THREE.Color, horizon: THREE.Color, night: boolean) => {
    const pos = domeGeo.attributes.position as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const up = pos.getY(i) / 50;
      if (up >= 0) c.copy(horizon).lerp(zenith, Math.pow(up, 0.5));
      else c.copy(horizon).multiplyScalar(0.4);
      domeCol.set([c.r, c.g, c.b], i * 3);
    }
    (domeGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    // By day the windows are not lit and the lamps are off; the reflection is
    // then mostly sky, which is right for a wet road at noon.
    panels.visible = night;
    env?.dispose();
    env = pmrem.fromScene(envScene, 0.02);
    road.envMap = env.texture;
    pave.envMap = env.texture;
    road.needsUpdate = true;
    pave.needsUpdate = true;
    apply();
  };

  let wet = 0;
  let forced: number | null = null;
  let applied = -1;
  const apply = () => {
    const w = forced ?? wet;
    if (Math.abs(w - applied) < 0.004) return;
    applied = w;
    road.roughness = THREE.MathUtils.lerp(base.road.rough, 0.1, w);
    road.metalness = THREE.MathUtils.lerp(base.road.metal, 0.25, w);
    road.color.copy(base.road.color).multiplyScalar(1 - 0.35 * w);
    road.envMapIntensity = 0.7 * w;
    pave.roughness = THREE.MathUtils.lerp(base.pave.rough, 0.3, w);
    pave.metalness = THREE.MathUtils.lerp(base.pave.metal, 0.12, w);
    pave.color.copy(base.pave.color).multiplyScalar(1 - 0.25 * w);
    pave.envMapIntensity = 0.45 * w;
  };

  return {
    wetness: () => forced ?? wet,
    update(dt, raining) {
      wet = THREE.MathUtils.clamp(wet + (raining ? WET_IN : -DRY_OUT) * dt, 0, 1);
      apply();
    },
    setSky,
    force(w) {
      forced = w;
      applied = -1;
      apply();
    },
    dispose() {
      env?.dispose();
      pmrem.dispose();
      domeGeo.dispose();
      domeMat.dispose();
      panelGeo.dispose();
      panelMats.forEach((m) => m.dispose());
    },
  };
}
