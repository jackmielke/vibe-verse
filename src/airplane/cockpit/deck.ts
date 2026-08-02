/**
 * The flight deck of a Boeing 707, from the left seat.
 *
 * Everything in here lives in the **cockpit scene**, drawn as a second pass
 * with a near plane of three centimetres (see `engine/core.ts`). That is what
 * makes it possible to have a yoke forty centimetres from the lens and a
 * runway twelve kilometres away in the same frame without the depth buffer
 * giving up.
 *
 * ## The layout is the game's difficulty curve
 *
 * A 707 panel is not decoration. Where each instrument sits determines what
 * you can see at a glance, and the whole last minute of this game is a scan:
 * attitude, speed, altitude, back to attitude. The classic "basic T" — the
 * attitude indicator in the middle, airspeed to its left, altimeter to its
 * right, heading below — exists because that scan is a short one, and it is
 * laid out here exactly as it is on the real aeroplane. Rearranging it to look
 * better would make the game harder in a way that had nothing to do with
 * flying.
 *
 * ## The lighting is the nostalgia
 *
 * Almost everything you can feel about a 1979 flight deck at night is in the
 * light: warm red-orange flood lamps that leave the corners in shadow, the
 * pale green-white glow behind the instrument faces, and nothing else. It is
 * a very dark room with eleven small bright things in it, and if you light it
 * evenly it stops being a cockpit and becomes a dashboard.
 */
import * as THREE from "three";
import { EYE_POINT } from "../flight/dynamics";
import { dme, ilsFix } from "../flight/nav";
import { createSurfaceMaterial } from "../world/surface";
import { OUTPUT_GLSL, withEnv, type EnvUniforms } from "../world/env";
import { createGaugePanel, type GaugePanel } from "./gauges";
import { PALETTE, type PlaneCtx, type System } from "../types";
import type { AircraftService } from "../play/aircraft";

/** Positions are relative to the pilot's eye, which is where the camera is. */
const eyeRel = (dx: number, dy: number, dz: number) =>
  new THREE.Vector3(EYE_POINT.x + dx, EYE_POINT.y + dy, EYE_POINT.z + dz);

/**
 * The vertical layout, and the reason it is the way it is.
 *
 * Every number here is measured down from the pilot's eye, and the ordering
 * matters more than any individual value: **the glareshield has to be low
 * enough to see over.** The first version of this deck put its top surface
 * 5 cm below the eye — which is roughly where it looks right in a photograph
 * taken from behind the seats, and which from the seat itself is a slab across
 * the middle of the world that hides the entire instrument panel *and* the
 * bottom half of the windshield. In a real 707 the coaming is about 20 cm
 * below your eyeline and the panel starts just under it.
 */
const PANEL = {
  /** Panel centre: 79 cm forward, 46 cm down, raked back 12°. */
  dz: -0.75,
  dy: -0.45,
  rake: 0.21,
  /** The instruments, standing 13 mm proud of the panel face. */
  gaugeDy: -0.41,
  gaugeDz: -0.686,
  /** Top of the coaming, and how far forward the hood reaches. */
  glareDy: -0.20,
  glareDz: -0.73,
};

/**
 * Cockpit interior surfaces.
 *
 * `uTint` is the base colour, and the shading is deliberately flat with a
 * strong grazing term — a moulded plastic coaming under a flood lamp has
 * almost no specular and a great deal of edge.
 */
const INTERIOR_BODY = /* glsl */ `
  albedo = uTint;
  rough = uRough;
  metal = uMetal;

  // The flood lamps: two warm sources up under the glareshield, falling off
  // fast. Everything about the mood of this cockpit is in these six lines.
  vec3 lampA = uEyeA;
  vec3 lampB = uEyeB;
  vec3 lit = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 lp = (i == 0) ? lampA : lampB;
    vec3 d = lp - vWorld;
    float dist2 = max(dot(d, d), 0.01);
    vec3 ld = d * inversesqrt(dist2);
    float ndl = max(dot(n, ld), 0.0);
    // A wrapped diffuse term: a flood lamp on a curved plastic coaming half a
    // metre away is nothing like a point source, and a hard N·L leaves the
    // whole lower panel black. But the floor has to stay small — at 0.28 every
    // surface in the cockpit got lit regardless of which way it faced, and the
    // flight deck came out as one flat orange field with instruments on it
    // rather than as a dark room with two lamps in it.
    float wrap = ndl * 0.86 + 0.14;
    lit += uFloodColor * wrap / (1.0 + dist2 * 7.5);
  }
  emission += albedo * lit * uFlood * 5.2;
  // The panel is not only lit *by* the floods — the instruments throw their own
  // pale green light back onto everything around them, which is most of what
  // makes a night flight deck read as one.
  emission += vec3(0.45, 0.62, 0.50) * uFlood * 0.030;

  // A little wear along edges, so the mouldings are not perfectly clean.
  float grime = fbm(vUv * 30.0) * 0.16;
  albedo *= 1.0 - grime;
`;

export interface CockpitService {
  gauges: GaugePanel;
  /** 0..1 flood lamp brightness. The player can turn it up. */
  flood: number;
  setFlood(v: number): void;
  /** Instrument backlighting. */
  setPanelLights(v: number): void;
}

export function createCockpit(ctx: PlaneCtx): System {
  const env = ctx.services.skyEnv as EnvUniforms | undefined;
  if (!env) throw new Error("the cockpit needs the sky's env uniforms");

  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  ctx.cockpitScene.add(root);

  const materials: THREE.ShaderMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  const floodUniform = { value: 0.72 };
  const floodColor = { value: new THREE.Color(PALETTE.flood) };
  // The two flood lamps, in world space, updated each frame with the aeroplane.
  const eyeA = { value: new THREE.Vector3() };
  const eyeB = { value: new THREE.Vector3() };
  const lampLocalA = eyeRel(-0.55, 0.30, -0.45);
  const lampLocalB = eyeRel(0.55, 0.30, -0.45);

  const interior = (tint: number, rough = 0.85, metal = 0.02) => {
    const m = createSurfaceMaterial(env, {
      body: INTERIOR_BODY,
      interior: true,
      uniforms: {
        uTint: { value: new THREE.Color(tint) },
        uRough: { value: rough },
        uMetal: { value: metal },
        uFlood: floodUniform,
        uFloodColor: floodColor,
        uEyeA: eyeA,
        uEyeB: eyeB,
      },
    });
    materials.push(m);
    return m;
  };

  const panelMat = interior(0x39332c, 0.9);
  const coamingMat = interior(0x272320, 0.95);
  const trimMat = interior(0x413c35, 0.8);
  const metalMat = interior(0x6d7078, 0.35, 0.7);
  const blackMat = interior(0x0d0d10, 0.7);

  const put = (
    mesh: THREE.Mesh,
    pos: THREE.Vector3,
    rot?: THREE.Euler,
  ): THREE.Mesh => {
    mesh.position.copy(pos);
    if (rot) mesh.rotation.copy(rot);
    root.add(mesh);
    return mesh;
  };

  // --- the main instrument panel -------------------------------------------
  const panel = new THREE.Mesh(track(new THREE.BoxGeometry(1.34, 0.52, 0.09)), panelMat);
  put(panel, eyeRel(0.10, PANEL.dy, PANEL.dz), new THREE.Euler(PANEL.rake, 0, 0));

  // The glareshield: the hood over the panel that keeps daylight off the
  // instruments and, at night, hides the flood lamps that light them.
  const glare = new THREE.Mesh(track(new THREE.BoxGeometry(1.46, 0.055, 0.30)), coamingMat);
  put(glare, eyeRel(0.10, PANEL.glareDy, PANEL.glareDz), new THREE.Euler(-0.12, 0, 0));

  // --- the gauges ----------------------------------------------------------
  const gauges = createGaugePanel(env);
  // Sat on the face of the panel, in front of the left seat.
  gauges.group.position.copy(eyeRel(0.0, PANEL.gaugeDy, PANEL.gaugeDz));
  gauges.group.rotation.x = PANEL.rake;
  root.add(gauges.group);

  // The first officer's panel: the same instruments, unreadable at this angle,
  // and the reason the flight deck feels like a two-crew aeroplane rather than
  // a cockpit with one seat in it. Nobody is sitting there.
  const foPanel = new THREE.Mesh(track(new THREE.PlaneGeometry(0.42, 0.30)), blackMat);
  put(foPanel, eyeRel(0.90, PANEL.gaugeDy, PANEL.gaugeDz - 0.02), new THREE.Euler(PANEL.rake, -0.20, 0));

  // --- the windshield frame -------------------------------------------------
  // Five panes on a 707: two big front ones, two side "eyebrow" windows, and
  // the sliding clear-vision window on the left. The posts between them are
  // most of what makes the view read as a cockpit rather than a viewport.
  const postMat = trimMat;
  const post = (w: number, h: number, pos: THREE.Vector3, rot?: THREE.Euler) =>
    put(new THREE.Mesh(track(new THREE.BoxGeometry(w, h, 0.07)), postMat), pos, rot);

  post(0.07, 0.56, eyeRel(0.30, 0.10, -0.94));            // centre post
  post(0.09, 0.58, eyeRel(-0.62, 0.09, -0.86), new THREE.Euler(0, 0.42, 0));
  post(0.09, 0.58, eyeRel(1.04, 0.09, -0.80), new THREE.Euler(0, -0.42, 0));
  // Top rail, and the roof beyond it.
  post(1.9, 0.08, eyeRel(0.16, 0.40, -0.88));
  const roof = new THREE.Mesh(track(new THREE.BoxGeometry(2.1, 0.06, 1.5)), coamingMat);
  put(roof, eyeRel(0.16, 0.47, -0.20));

  // --- side walls and windows ------------------------------------------------
  const sideWall = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 1.5, 1.6)), trimMat);
  put(sideWall, eyeRel(-0.94, 0.02, -0.05));
  const sideWallR = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 1.5, 1.6)), trimMat);
  put(sideWallR, eyeRel(1.36, 0.02, -0.05));
  // The rear bulkhead, with the door the cabin crew keep coming through.
  const bulkhead = new THREE.Mesh(track(new THREE.BoxGeometry(2.3, 1.9, 0.08)), trimMat);
  put(bulkhead, eyeRel(0.20, 0.10, 0.70));

  // --- the centre pedestal --------------------------------------------------
  const pedestal = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.16, 0.72)), panelMat);
  put(pedestal, eyeRel(0.42, -0.72, -0.42), new THREE.Euler(-0.18, 0, 0));

  // Four thrust levers, a flap lever and the speedbrake. These move, and they
  // are the only controls in the cockpit you can watch working.
  const leverMat = interior(0x9aa0a8, 0.4, 0.6);
  const knobMat = interior(0x101215, 0.6);
  const thrustLevers: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    const arm = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.15, 0.020)), leverMat);
    arm.position.y = 0.075;
    g.add(arm);
    const knob = new THREE.Mesh(track(new THREE.SphereGeometry(0.026, 10, 8)), knobMat);
    knob.position.y = 0.155;
    knob.scale.set(1, 0.85, 1.25);
    g.add(knob);
    g.position.copy(eyeRel(0.33 + i * 0.052, -0.70, -0.55));
    root.add(g);
    thrustLevers.push(g);
  }
  const flapLever = new THREE.Group();
  {
    const arm = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.13, 0.018)), leverMat);
    arm.position.y = 0.065;
    flapLever.add(arm);
    const knob = new THREE.Mesh(track(new THREE.BoxGeometry(0.05, 0.030, 0.028)), knobMat);
    knob.position.y = 0.135;
    flapLever.add(knob);
    flapLever.position.copy(eyeRel(0.58, -0.70, -0.40));
    root.add(flapLever);
  }

  // --- the gear lever, with its little wheel-shaped knob ---------------------
  const gearLever = new THREE.Group();
  {
    const arm = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.10, 0.018)), leverMat);
    arm.position.y = 0.05;
    gearLever.add(arm);
    const wheel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.028, 0.028, 0.016, 12)), knobMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.y = 0.105;
    gearLever.add(wheel);
    gearLever.position.copy(eyeRel(0.34, PANEL.dy - 0.19, PANEL.dz + 0.12));
    root.add(gearLever);
  }

  // --- the yoke -------------------------------------------------------------
  // A 707 control column: a big two-horned wheel on a column that comes up out
  // of the floor. It moves fore-and-aft with pitch and rotates with roll, and
  // watching it move is how you know the aeroplane is being flown — by you, by
  // Otto, or, during a flashback, by nobody.
  const yoke = new THREE.Group();
  const column = new THREE.Mesh(track(new THREE.CylinderGeometry(0.028, 0.034, 0.42, 10)), metalMat);
  column.position.y = -0.21;
  yoke.add(column);
  const wheelGroup = new THREE.Group();
  const rim = new THREE.Mesh(track(new THREE.TorusGeometry(0.115, 0.014, 8, 22, Math.PI)), knobMat);
  rim.rotation.z = Math.PI;
  wheelGroup.add(rim);
  for (const side of [-1, 1]) {
    const horn = new THREE.Mesh(track(new THREE.CylinderGeometry(0.013, 0.013, 0.11, 8)), knobMat);
    horn.position.set(side * 0.115, 0.055, 0);
    wheelGroup.add(horn);
  }
  const hub = new THREE.Mesh(track(new THREE.BoxGeometry(0.10, 0.055, 0.028)), blackMat);
  wheelGroup.add(hub);
  yoke.add(wheelGroup);
  const yokeHome = eyeRel(-0.02, -0.50, -0.46);
  yoke.position.copy(yokeHome);
  root.add(yoke);

  // --- the windshield -------------------------------------------------------
  // A transparent plane across the front, carrying rain and the wipers. This
  // is the only thing between the cockpit and the storm, and it is what makes
  // the approach feel like it is happening through glass.
  const RAIN_FRAG = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    ${OUTPUT_GLSL}
    uniform float uRainAmount;
    uniform float uTime;
    uniform float uSpeed;
    uniform float uFlashLevel;
    uniform vec3  uGlowColor;
    uniform float uWiper;

    float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      // Drops are blown up and outwards from the centre of the screen by the
      // slipstream, which is exactly what rain on a windshield does at speed
      // and nothing like what it does when parked.
      vec2 uv = vUv;
      vec2 flow = normalize(vec2(uv.x - 0.5, uv.y - 0.35) + 1e-4);
      float drift = uTime * (0.25 + uSpeed * 0.9);

      float wet = 0.0;
      for (int i = 0; i < 3; i++) {
        float sc = 26.0 + float(i) * 22.0;
        vec2 p = (uv + flow * drift * (0.05 + float(i) * 0.03)) * sc;
        vec2 id = floor(p);
        vec2 f = fract(p) - 0.5;
        float h = hash12(id + float(i) * 37.0);
        if (h < 0.80) continue;
        // Streaks, not circles: stretched along the flow direction.
        vec2 s = vec2(f.x, f.y * (0.30 + h * 0.5));
        float d = length(s);
        wet += smoothstep(0.34, 0.0, d) * (0.4 + 0.6 * h);
      }
      wet = clamp(wet, 0.0, 1.0) * uRainAmount;

      // The wiper sweeps a wedge clear, and the wedge is centred on the
      // bottom-left of the screen the way a 707's left wiper is.
      vec2 wc = uv - vec2(0.18, -0.25);
      float ang = atan(wc.x, wc.y);
      float blade = abs(ang - (uWiper * 1.15 - 0.3));
      float wiped = smoothstep(0.34, 0.10, blade);
      wet *= 1.0 - wiped * 0.92;
      // The blade itself, a dark bar.
      float bladeMark = smoothstep(0.055, 0.03, blade) * step(length(wc), 1.25);

      // Water on glass is *dark* except where something is shining through it.
      // A bright white streak field reads as snow on a television.
      vec3 col = uGlowColor * wet * (0.10 + uFlashLevel * 1.1);
      float a = wet * 0.30 + bladeMark * 0.55;
      if (a < 0.006) discard;
      gl_FragColor = vec4(outputColor(col + vec3(0.02) * bladeMark), a);
    }
  `;

  const rainUniforms = {
    uRainAmount: { value: 0.6 },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uFlashLevel: { value: 0 },
    uGlowColor: { value: new THREE.Color(0.7, 0.75, 0.85) },
    uWiper: { value: 0 },
    uExposure: { value: 1 },
  };
  const rainMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: RAIN_FRAG,
    uniforms: rainUniforms,
    transparent: true,
    depthWrite: false,
  });
  materials.push(rainMat);
  const windshield = new THREE.Mesh(track(new THREE.PlaneGeometry(1.8, 0.62)), rainMat);
  put(windshield, eyeRel(0.16, 0.09, -0.92));
  windshield.renderOrder = 50;

  // --- the empty right seat -------------------------------------------------
  // Captain Oveur is on the floor of the galley with a plate of fish in front
  // of him, and the seat he is not in is a detail the whole game rests on.
  const seatMat = interior(0x1b2430, 0.95);
  const seat = new THREE.Group();
  const cushion = new THREE.Mesh(track(new THREE.BoxGeometry(0.48, 0.10, 0.46)), seatMat);
  seat.add(cushion);
  const back = new THREE.Mesh(track(new THREE.BoxGeometry(0.48, 0.72, 0.10)), seatMat);
  back.position.set(0, 0.38, 0.24);
  back.rotation.x = -0.12;
  seat.add(back);
  seat.position.copy(eyeRel(1.02, -0.72, 0.12));
  root.add(seat);

  ctx.services.cockpit = {
    gauges,
    flood: floodUniform.value,
    setFlood(v: number) {
      floodUniform.value = v;
    },
    setPanelLights(v: number) {
      gauges.setBrightness(v);
    },
  } satisfies CockpitService;

  const _v = new THREE.Vector3();
  let wiperPhase = 0;

  return {
    lateUpdate(dt, c) {
      const air = c.services.flight as AircraftService | undefined;
      if (!air) return;
      const s = air.state;

      // The whole flight deck rides with the aeroplane. Because the camera is
      // rigidly attached too (see engine/camera.ts) it appears perfectly
      // stationary — which is the correct and slightly eerie result.
      root.position.copy(s.position);
      root.quaternion.copy(s.orientation);
      root.updateMatrix();
      root.updateMatrixWorld(true);

      // The flood lamps have to be in world space for the interior shader.
      eyeA.value.copy(lampLocalA).applyQuaternion(s.orientation).add(s.position);
      eyeB.value.copy(lampLocalB).applyQuaternion(s.orientation).add(s.position);

      // Controls, moving. The yoke shows what the *aeroplane* is being given,
      // not what the player pressed, so Otto flying shows up as a yoke moving
      // by itself — which is the joke and the warning at the same time.
      const ctlPitch = air.model.controls.pitch;
      const ctlRoll = air.model.controls.roll;
      yoke.position.copy(yokeHome);
      yoke.position.z += -ctlPitch * 0.085;
      yoke.position.y += ctlPitch * 0.018;
      wheelGroup.rotation.z = -ctlRoll * 1.15;

      for (let i = 0; i < 4; i++) {
        thrustLevers[i].rotation.x = -0.55 + s.n1[i] * 0.95;
      }
      flapLever.rotation.x = -0.5 + (s.flapAngle / 50) * 1.0;
      gearLever.position.y = yokeHome.y + 0.06 + (s.gear.down ? -0.05 : 0.03);

      // Rain and the wipers. The wipers only run when it is actually raining,
      // and they are the single most atmospheric moving object in the game.
      const rain = (c.services.sky?.rain ?? 0) * (s.altitude < 4600 ? 1 : 0.15);
      rainUniforms.uRainAmount.value = rain;
      rainUniforms.uTime.value += dt;
      rainUniforms.uSpeed.value = Math.min(s.tas / 120, 1.4);
      rainUniforms.uFlashLevel.value = env.uFlash.value;
      if (rain > 0.05) {
        wiperPhase += dt * 1.7;
        rainUniforms.uWiper.value = Math.sin(wiperPhase) * 0.5 + 0.5;
      }
      windshield.visible = rain > 0.02;

      // The gauges. Everything they show is derived here and nowhere else.
      gauges.update(
        {
          ias: s.ias,
          altitude: s.altitude,
          vs: s.vs,
          heading: s.heading,
          pitch: s.pitchAngle,
          bank: s.bankAngle,
          slip: Math.max(-1, Math.min(1, -s.beta * 7)),
          n1: s.n1,
          locNeedle: air.ils.locNeedle,
          gsNeedle: air.ils.gsNeedle,
          ilsValid: air.ils.valid,
          radarAltitude: s.radarAltitude,
          flapAngle: s.flapAngle,
          gearPosition: s.gear.position,
          gearDown: s.gear.down,
          dme: dme(s.position),
          stalled: s.stalled,
          stallMargin: s.stallMargin,
          overspeed: s.overspeed,
          autopilotOn: air.ap.state.engaged,
        },
        dt,
      );
    },
    dispose() {
      ctx.cockpitScene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      gauges.dispose();
      delete ctx.services.cockpit;
    },
  };
}

/** Re-exported so the shot harness can find the eye point without importing dynamics. */
export { EYE_POINT };
/** Used by the intro, which walks the camera in from the cabin door. */
export const DECK_ORIGIN = eyeRel(0, 0, 0);
export { ilsFix };
