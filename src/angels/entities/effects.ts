/**
 * Smoke, vapour and the things air does when you hurry it.
 *
 * Four effects, and every one of them is a *cue* rather than a decoration:
 *
 *  - **Smoke oil.** The team's paraffin trail. It is the only thing that makes
 *    a formation's shape visible from the ground, which is the entire reason
 *    the real jets carry it, and it does the same job here.
 *  - **Wingtip vortices.** Condensation off the tips when the wing is working
 *    hard in damp air. They are how you *see* G — the harder you pull, the
 *    more the jet writes on the sky behind it.
 *  - **Contrails.** Above about 8 km the air is cold enough. Nowhere near the
 *    show, and that is the point: they tell you that you have left it.
 *  - **The vapour cone.** Transonic. Rare, earned, and the best-looking thing
 *    in the world when it happens.
 *
 * All four are ribbons or shells built on the CPU each frame. A ribbon is two
 * hundred vertices; six jets is twelve hundred; that is nothing next to the
 * shader work it would take to do the same job on the GPU with neighbour
 * lookups, and this way the ribbon can be camera-facing exactly rather than
 * approximately.
 */
import * as THREE from "three";
import type { AngelsCtx, System } from "../types";
import type { FleetService, Aircraft } from "../play/fleet";
import { contrailFactor } from "../flight/atmosphere";
import { OUTPUT_GLSL } from "../world/env";

/** Samples per ribbon. At 30 Hz this is about six seconds of trail. */
const TRAIL_SAMPLES = 190;
const SAMPLE_HZ = 34;

interface Ribbon {
  positions: Float32Array;
  ages: Float32Array;
  head: number;
  count: number;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  posAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
  timer: number;
}

function makeRibbon(material: THREE.Material, samples = TRAIL_SAMPLES): Ribbon {
  const geometry = new THREE.BufferGeometry();
  const verts = samples * 2;
  const posAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  const alphaAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aAlpha", alphaAttr);

  const idx = new Uint16Array((samples - 1) * 6);
  for (let i = 0; i < samples - 1; i++) {
    const a = i * 2;
    idx[i * 6] = a;
    idx[i * 6 + 1] = a + 1;
    idx[i * 6 + 2] = a + 2;
    idx[i * 6 + 3] = a + 1;
    idx[i * 6 + 4] = a + 3;
    idx[i * 6 + 5] = a + 2;
  }
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.setDrawRange(0, 0);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;

  return {
    positions: new Float32Array(samples * 3),
    ages: new Float32Array(samples),
    head: 0,
    count: 0,
    geometry,
    mesh,
    posAttr,
    alphaAttr,
    timer: 0,
  };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();

/**
 * Rebuild a ribbon's triangle strip, facing the camera.
 *
 * The width grows with age because smoke disperses, and the whole thing is
 * built from the newest sample backwards so the freshest end is always the
 * tight one at the nozzle.
 */
function updateRibbon(
  r: Ribbon,
  camera: THREE.Camera,
  life: number,
  widthStart: number,
  widthEnd: number,
): void {
  const n = r.count;
  if (n < 2) {
    r.geometry.setDrawRange(0, 0);
    return;
  }
  const samples = r.ages.length;
  const pos = r.posAttr.array as Float32Array;
  const alpha = r.alphaAttr.array as Float32Array;
  const camPos = camera.position;

  let written = 0;
  for (let k = 0; k < n; k++) {
    // Walk from the newest sample backwards through the ring buffer.
    const i = (r.head - 1 - k + samples * 2) % samples;
    const age = r.ages[i];
    if (age > life) break;

    _a.fromArray(r.positions, i * 3);
    const j = (i - 1 + samples) % samples;
    if (k + 1 < n) _b.fromArray(r.positions, j * 3);
    else _b.copy(_a);

    _dir.subVectors(_a, _b);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    _dir.normalize();
    _toCam.subVectors(camPos, _a).normalize();
    _side.crossVectors(_dir, _toCam);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();

    const t = age / life;
    const w = widthStart + (widthEnd - widthStart) * t;
    // Fade in over the first fraction so the ribbon does not start with a
    // hard edge at the nozzle, and out over the rest as it disperses.
    const fade = Math.min(1, t * 14) * (1 - t) * (1 - t);

    const o = written * 6;
    pos[o] = _a.x - _side.x * w;
    pos[o + 1] = _a.y - _side.y * w;
    pos[o + 2] = _a.z - _side.z * w;
    pos[o + 3] = _a.x + _side.x * w;
    pos[o + 4] = _a.y + _side.y * w;
    pos[o + 5] = _a.z + _side.z * w;
    alpha[written * 2] = fade;
    alpha[written * 2 + 1] = fade;
    written++;
  }

  r.posAttr.needsUpdate = true;
  r.alphaAttr.needsUpdate = true;
  r.geometry.setDrawRange(0, Math.max(0, (written - 1) * 6));
}

function pushSample(r: Ribbon, p: THREE.Vector3, dt: number): void {
  const samples = r.ages.length;
  for (let i = 0; i < samples; i++) r.ages[i] += dt;
  r.positions[r.head * 3] = p.x;
  r.positions[r.head * 3 + 1] = p.y;
  r.positions[r.head * 3 + 2] = p.z;
  r.ages[r.head] = 0;
  r.head = (r.head + 1) % samples;
  r.count = Math.min(r.count + 1, samples);
}

function resetRibbon(r: Ribbon): void {
  r.count = 0;
  r.head = 0;
  r.geometry.setDrawRange(0, 0);
}

const TRAIL_SHADER = {
  vertexShader: /* glsl */ `
    attribute float aAlpha;
    varying float vAlpha;
    varying float vDist;
    void main() {
      vAlpha = aAlpha;
      vec4 view = modelViewMatrix * vec4(position, 1.0);
      vDist = -view.z;
      gl_Position = projectionMatrix * view;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform vec3 uHazeColor;
    uniform float uFogDensity;
    varying float vAlpha;
    varying float vDist;
    ${OUTPUT_GLSL}
    void main() {
      // Smoke is lit by the sky more than by the sun, so it barely darkens —
      // but it does haze out with distance like everything else.
      float f = 1.0 - exp(-vDist * uFogDensity * 0.7);
      vec3 col = mix(uColor, uHazeColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(outputColor(col), vAlpha * uOpacity);
      if (gl_FragColor.a < 0.004) discard;
    }
  `,
};

export function createEffects(ctx: AngelsCtx): System {
  const fleet = ctx.services.fleet as FleetService | undefined;
  if (!fleet) return {};

  const env = ctx.services.env as { uniforms: Record<string, THREE.IUniform> } | undefined;
  const haze = env?.uniforms.uHazeColor ?? { value: new THREE.Color(0xa9c4d8) };
  const fogDensity = env?.uniforms.uFogDensity ?? { value: 0.000025 };
  const exposure = env?.uniforms.uExposure ?? { value: 0.66 };

  const group = new THREE.Group();
  group.name = "effects";
  ctx.scene.add(group);

  const makeMat = (color: number, opacity: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity },
        uHazeColor: haze,
        uFogDensity: fogDensity,
        uExposure: exposure,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...TRAIL_SHADER,
    });

  const smokeMat = makeMat(0xf4f7fc, 0.82);
  const vaporMat = makeMat(0xdfeaf6, 0.5);
  const contrailMat = makeMat(0xffffff, 0.42);

  interface Kit {
    smoke: Ribbon;
    tipL: Ribbon;
    tipR: Ribbon;
    contrail: Ribbon;
    cone: THREE.Mesh;
  }

  const coneGeo = new THREE.ConeGeometry(1, 1, 20, 1, true);
  coneGeo.rotateX(Math.PI / 2);
  const coneMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uStrength: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vNormal;
      void main() {
        vPos = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec3 vPos;
      varying vec3 vNormal;
      void main() {
        // Thickest at the shock front, dissolving downstream, and brightest at
        // grazing incidence — it is a shell of condensate, not a solid.
        float along = clamp(vPos.z * 0.5 + 0.5, 0.0, 1.0);
        float rim = pow(1.0 - abs(normalize(vNormal).z), 1.6);
        float a = uStrength * (1.0 - along) * (0.35 + rim * 0.9);
        gl_FragColor = vec4(vec3(0.92, 0.95, 1.0), a * 0.62);
      }
    `,
  });

  const kits: Kit[] = [];
  for (const _a2 of fleet.all) {
    void _a2;
    const smoke = makeRibbon(smokeMat);
    const tipL = makeRibbon(vaporMat, 70);
    const tipR = makeRibbon(vaporMat, 70);
    const contrail = makeRibbon(contrailMat);
    const cone = new THREE.Mesh(coneGeo, coneMat.clone());
    cone.visible = false;
    cone.frustumCulled = false;
    group.add(smoke.mesh, tipL.mesh, tipR.mesh, contrail.mesh, cone);
    kits.push({ smoke, tipL, tipR, contrail, cone });
  }

  const _p = new THREE.Vector3();

  /**
   * How much water the air will give up today.
   *
   * Seattle in early August runs 55–70% relative humidity in the afternoon,
   * which is right at the edge for wingtip condensation — so the vortices come
   * and go rather than being permanently on, and a hard pull that produces
   * them feels like it earned them.
   */
  const HUMIDITY = 0.66;

  return {
    update(dt, c) {
      const camera = c.camera;
      for (let i = 0; i < fleet.all.length; i++) {
        const a: Aircraft = fleet.all[i];
        const kit = kits[i];
        const s = a.state;
        const visible = a.rig.root.visible;

        if (!visible) {
          resetRibbon(kit.smoke);
          resetRibbon(kit.tipL);
          resetRibbon(kit.tipR);
          resetRibbon(kit.contrail);
          kit.cone.visible = false;
          continue;
        }

        // ---- smoke oil --------------------------------------------------
        kit.smoke.timer += dt;
        if (a.smoke && kit.smoke.timer > 1 / SAMPLE_HZ) {
          kit.smoke.timer = 0;
          _p.copy(a.rig.nozzles[0]).applyQuaternion(s.orientation).add(s.position);
          pushSample(kit.smoke, _p, 1 / SAMPLE_HZ);
        } else if (!a.smoke && kit.smoke.count > 0) {
          // Let the existing trail age out instead of vanishing mid-air.
          kit.smoke.timer += dt;
          if (kit.smoke.timer > 0.25) {
            kit.smoke.timer = 0;
            for (let k = 0; k < kit.smoke.ages.length; k++) kit.smoke.ages[k] += 0.6;
          }
        }
        updateRibbon(kit.smoke, camera, 13, 1.1, 26);
        kit.smoke.mesh.visible = kit.smoke.count > 1;

        // ---- wingtip vortices --------------------------------------------
        // Condensation needs suction and damp air: a loaded wing, low down.
        const load = Math.max(0, s.liftDemand - 0.42) / 0.58;
        const damp = Math.max(0, HUMIDITY - 0.5) / 0.5;
        const low = 1 - Math.min(1, Math.max(0, (s.altitude - 3500) / 2500));
        const vaporOn = load * damp * low > 0.16 && s.airspeed > 70;
        kit.tipL.timer += dt;
        if (vaporOn && kit.tipL.timer > 1 / 45) {
          kit.tipL.timer = 0;
          _p.copy(a.rig.tips[0]).applyQuaternion(s.orientation).add(s.position);
          pushSample(kit.tipL, _p, 1 / 45);
          _p.copy(a.rig.tips[1]).applyQuaternion(s.orientation).add(s.position);
          pushSample(kit.tipR, _p, 1 / 45);
        }
        updateRibbon(kit.tipL, camera, 1.5, 0.45, 3.4);
        updateRibbon(kit.tipR, camera, 1.5, 0.45, 3.4);
        const vaporVisible = vaporOn && kit.tipL.count > 1;
        kit.tipL.mesh.visible = vaporVisible;
        kit.tipR.mesh.visible = vaporVisible;

        // ---- contrails -----------------------------------------------------
        const trailing = contrailFactor(s.altitude) > 0.05 && s.power > 0.4;
        kit.contrail.timer += dt;
        if (trailing && kit.contrail.timer > 1 / 12) {
          kit.contrail.timer = 0;
          _p.copy(a.rig.nozzles[0]).applyQuaternion(s.orientation).add(s.position);
          pushSample(kit.contrail, _p, 1 / 12);
        }
        updateRibbon(kit.contrail, camera, 26, 2.5, 60);
        kit.contrail.mesh.visible = trailing && kit.contrail.count > 1;

        // ---- vapour cone ----------------------------------------------------
        // Transonic, low, and damp. All three at once is rare, which is why
        // getting one feels like something.
        const machTerm = Math.min(1, Math.max(0, (s.mach - 0.86) / 0.12));
        const coneStrength = machTerm * damp * low;
        kit.cone.visible = coneStrength > 0.02;
        if (kit.cone.visible) {
          const len = a.spec.length * 0.85;
          const rad = a.spec.wingspan * 0.36 * (0.7 + machTerm * 0.5);
          kit.cone.position.copy(s.position);
          kit.cone.quaternion.copy(s.orientation);
          kit.cone.scale.set(rad, rad, len);
          kit.cone.position.add(
            _p.set(0, 0, a.spec.length * 0.1).applyQuaternion(s.orientation),
          );
          (kit.cone.material as THREE.ShaderMaterial).uniforms.uStrength.value = coneStrength;
        }
      }
    },

    dispose() {
      ctx.scene.remove(group);
      for (const kit of kits) {
        kit.smoke.geometry.dispose();
        kit.tipL.geometry.dispose();
        kit.tipR.geometry.dispose();
        kit.contrail.geometry.dispose();
        (kit.cone.material as THREE.Material).dispose();
      }
      coneGeo.dispose();
      coneMat.dispose();
      smokeMat.dispose();
      vaporMat.dispose();
      contrailMat.dispose();
    },
  };
}
