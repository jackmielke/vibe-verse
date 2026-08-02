/**
 * Trans American 209 — a Boeing 707-320B, from the outside.
 *
 * Built parametrically from the dimensions in `airframe.ts`, so the aeroplane
 * the chase camera sees is the same size as the one the flight model is
 * flying. That sounds obvious and is routinely got wrong: a model scaled by
 * eye to "look right" next to a runway built to spec puts the wingtip fifteen
 * metres from where the physics thinks it is, and the first time you scrape
 * one on a crosswind landing the game appears to be lying to you.
 *
 * The livery is the film's: a white crown, a bare-metal belly, and a red-over-
 * orange cheatline running the length of the fuselage and up the fin. That
 * cheatline is doing an unreasonable amount of work — it is the only thing in
 * the frame that says *airliner, 1980* rather than *aeroplane*.
 *
 * Everything that moves — the gear, the flaps, the control surfaces, the
 * spinning fans — is a named node updated from the flight state each frame.
 */
import * as THREE from "three";
import { AIRFRAME } from "../flight/airframe";
import { ENGINE_X } from "../flight/dynamics";
import { createSurfaceMaterial } from "../world/surface";
import {
  createLightField,
  setViewportHeight,
  type LightField,
  type LightSpec,
} from "../world/lights";
import type { EnvUniforms } from "../world/env";
import { PALETTE, type PlaneCtx, type System } from "../types";
import type { AircraftService } from "../play/aircraft";

/**
 * The livery, as a function of where you are on the fuselage.
 *
 * `vUv.y` runs around the circumference of the lathe and `vWorld` is no use
 * because the aeroplane moves, so the paint is driven by the *object-space*
 * height, passed through as the second UV. Painting in world space is a
 * mistake that only shows up once the aeroplane starts flying, at which point
 * the cheatline slides along the fuselage like a barber's pole.
 */
const FUSELAGE_BODY = /* glsl */ `
  // vUv.x runs nose (0) to tail (1); vUv.y runs around the barrel, 0 at the
  // bottom, 0.5 at the top.
  float around = vUv.y;
  float along = vUv.x;
  float height = cos((around - 0.5) * 6.2831853) * -0.5 + 0.5; // 0 belly, 1 crown

  albedo = vec3(0.80, 0.80, 0.815);            // white crown
  rough = 0.34;
  metal = 0.05;

  // Bare metal below the cheatline — the 707's whole lower fuselage was
  // polished aluminium, and it is why the underside catches the city.
  if (height < 0.30) {
    albedo = vec3(0.52, 0.55, 0.58);
    rough = 0.22;
    metal = 0.85;
  }

  // The cheatline: red over orange, just above the window line.
  float band = smoothstep(0.36, 0.38, height) * (1.0 - smoothstep(0.455, 0.475, height));
  float split = step(0.418, height);
  vec3 stripe = mix(uTaOrange, uTaRed, split);
  albedo = mix(albedo, stripe, band * step(0.03, along) * (1.0 - smoothstep(0.93, 0.99, along)));
  if (band > 0.5) { rough = 0.30; metal = 0.1; }

  // Cabin windows: a row of them, lit, because there are 187 people back there.
  float wRow = 1.0 - smoothstep(0.012, 0.03, abs(height - 0.545));
  float wPitch = fract(along * 118.0);
  float wOn = step(0.30, wPitch) * step(wPitch, 0.72);
  float wLit = step(0.18, hash11(floor(along * 118.0)));
  float win = wRow * wOn * step(0.10, along) * (1.0 - step(0.88, along));
  albedo = mix(albedo, vec3(0.05), win);
  emission += vec3(1.0, 0.86, 0.62) * win * wLit * 0.5;

  // The flight-deck windows, which are much bigger and much further forward.
  float fd = (1.0 - smoothstep(0.014, 0.030, abs(height - 0.70)))
           * (1.0 - smoothstep(0.036, 0.058, abs(along - 0.075)));
  albedo = mix(albedo, vec3(0.02, 0.03, 0.04), fd);
  emission += vec3(0.9, 0.35, 0.10) * fd * 0.55;

  // The radome is grey, not white, on every 707 ever painted.
  albedo = mix(albedo, vec3(0.24, 0.24, 0.26), 1.0 - smoothstep(0.010, 0.030, along));

  // The titles. Not legible from a chase camera, and that is fine — what
  // matters is that there is *something* dark along the crown where an
  // airline's name goes, because a blank white fuselage reads as a model.
  float titles = (1.0 - smoothstep(0.006, 0.016, abs(height - 0.80)))
               * (1.0 - smoothstep(0.10, 0.16, abs(along - 0.26)))
               * step(0.45, hash11(floor(along * 260.0)));
  albedo = mix(albedo, vec3(0.10, 0.11, 0.30), titles * 0.9);
`;

const PAINTED_BODY = /* glsl */ `
  albedo = uColor;
  rough = uRough;
  metal = uMetal;
`;

export function createAirliner(ctx: PlaneCtx): System {
  const env = ctx.services.skyEnv as EnvUniforms | undefined;
  if (!env) throw new Error("the airliner needs the sky's env uniforms");

  const air = ctx.services.flight as AircraftService | undefined;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;

  const materials: THREE.ShaderMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  const painted = (color: number, rough = 0.4, metal = 0.1) => {
    const m = createSurfaceMaterial(env, {
      body: PAINTED_BODY,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uRough: { value: rough },
        uMetal: { value: metal },
      },
    });
    materials.push(m);
    return m;
  };

  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  const L = AIRFRAME.length;
  const R = 1.88; // fuselage radius

  // --- fuselage ------------------------------------------------------------
  // A lathe, so the nose and tail cones are real shapes rather than cylinders
  // with cones stuck on. The profile is the 707's: a long pointed radome, a
  // constant barrel for two thirds of the length, and a tailcone that sweeps
  // up towards the fin.
  const profile: THREE.Vector2[] = [];
  const SEG = 44;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    let r: number;
    if (t < 0.09) r = R * Math.pow(Math.sin((t / 0.09) * Math.PI * 0.5), 0.62);
    else if (t < 0.70) r = R;
    else r = R * Math.pow(Math.max(0, 1 - (t - 0.70) / 0.34), 0.72);
    profile.push(new THREE.Vector2(Math.max(r, 0.02), -t * L));
  }
  const fuselageMat = createSurfaceMaterial(env, {
    body: FUSELAGE_BODY,
    uniforms: {
      uTaRed: { value: new THREE.Color(PALETTE.taRed) },
      uTaOrange: { value: new THREE.Color(PALETTE.taOrange) },
    },
  });
  materials.push(fuselageMat);
  const fuselage = new THREE.Mesh(track(new THREE.LatheGeometry(profile, 40)), fuselageMat);
  // The lathe is built around +Y; stand it up along the fuselage axis and put
  // the CG where the flight model thinks it is — 22 m aft of the nose.
  fuselage.rotation.x = -Math.PI / 2;
  fuselage.position.z = -22;
  // The tail sweeps up; a straight barrel sits too low at the back.
  root.add(fuselage);

  const white = painted(0xe9e9ea, 0.34, 0.05);
  const metalMat = painted(0x8d97a5, 0.25, 0.8);
  const dark = painted(0x22242a, 0.55, 0.2);
  const redMat = painted(PALETTE.taRed, 0.32, 0.05);

  // --- wing ----------------------------------------------------------------
  // A swept, tapered planform with real dihedral. Built as an extruded shape
  // so the sweep and taper are one description rather than four boxes.
  const halfSpan = AIRFRAME.span / 2;
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 3.6);
  wingShape.lineTo(0, -4.2);
  wingShape.lineTo(halfSpan * 0.42, -4.2 - halfSpan * 0.42 * 0.62);
  wingShape.lineTo(halfSpan, -1.4 - halfSpan * 0.62);
  wingShape.lineTo(halfSpan, -0.1 - halfSpan * 0.62);
  wingShape.lineTo(halfSpan * 0.42, 1.5 - halfSpan * 0.42 * 0.62);
  wingShape.closePath();
  const wingGeo = track(
    new THREE.ExtrudeGeometry(wingShape, { depth: 0.55, bevelEnabled: false, curveSegments: 2 }),
  );
  wingGeo.rotateX(Math.PI / 2);
  wingGeo.computeVertexNormals();

  const wings = new THREE.Group();
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, white);
    w.scale.x = side;
    w.position.set(0, -0.55, 1.5);
    w.rotation.z = -side * 0.12; // seven degrees of dihedral
    wings.add(w);
  }
  root.add(wings);

  // --- flaps, as a separate surface that hinges down ------------------------
  const flapGroup = new THREE.Group();
  for (const side of [1, -1]) {
    const flap = new THREE.Mesh(track(new THREE.BoxGeometry(halfSpan * 0.46, 0.3, 3.2)), white);
    flap.position.set(side * halfSpan * 0.32, -0.7, 4.6);
    flap.rotation.z = -side * 0.12;
    flap.geometry.translate(0, 0, 1.6); // hinge at the leading edge of the flap
    flapGroup.add(flap);
  }
  root.add(flapGroup);

  // --- tail ----------------------------------------------------------------
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(0, -7.2);
  finShape.lineTo(8.6, -5.4);
  finShape.lineTo(8.6, -1.6);
  finShape.closePath();
  const finGeo = track(
    new THREE.ExtrudeGeometry(finShape, { depth: 0.5, bevelEnabled: false, curveSegments: 2 }),
  );
  finGeo.rotateY(Math.PI / 2);
  finGeo.computeVertexNormals();
  const fin = new THREE.Mesh(finGeo, redMat);
  fin.position.set(-0.25, 1.6, 20.0);
  root.add(fin);

  const stabShape = new THREE.Shape();
  stabShape.moveTo(0, 1.9);
  stabShape.lineTo(0, -2.4);
  stabShape.lineTo(6.4, -2.0 - 3.2);
  stabShape.lineTo(6.4, -0.6 - 3.2);
  stabShape.closePath();
  const stabGeo = track(
    new THREE.ExtrudeGeometry(stabShape, { depth: 0.35, bevelEnabled: false, curveSegments: 2 }),
  );
  stabGeo.rotateX(Math.PI / 2);
  stabGeo.computeVertexNormals();
  for (const side of [1, -1]) {
    const s = new THREE.Mesh(stabGeo, white);
    s.scale.x = side;
    s.position.set(0, 1.0, 21.2);
    s.rotation.z = -side * 0.06;
    root.add(s);
  }

  // --- engines -------------------------------------------------------------
  const fans: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const x = ENGINE_X[i];
    const outboard = Math.abs(x) > 9;
    // The pylons rake forward and down, which is why a 707's pods hang so far
    // ahead of the wing and so close to the ground.
    const z = 1.5 - (outboard ? 2.4 : 5.0);
    const y = -2.5 - Math.abs(x) * 0.115;

    const pod = new THREE.Mesh(
      track(new THREE.CylinderGeometry(1.34, 1.16, 5.4, 18, 1, true)),
      metalMat,
    );
    pod.rotation.x = Math.PI / 2;
    pod.position.set(x, y, z);
    root.add(pod);

    const inlet = new THREE.Mesh(track(new THREE.TorusGeometry(1.32, 0.13, 8, 20)), metalMat);
    inlet.position.set(x, y, z - 2.7);
    root.add(inlet);

    const fan = new THREE.Mesh(track(new THREE.CircleGeometry(1.2, 16)), dark);
    fan.position.set(x, y, z - 2.5);
    fan.rotation.y = Math.PI;
    fans.push(fan);
    root.add(fan);

    const nozzle = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.92, 0.78, 1.5, 14)),
      painted(0x3a3f47, 0.7, 0.6),
    );
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, y, z + 3.2);
    root.add(nozzle);

    const pylon = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 2.6, 3.4)), white);
    pylon.position.set(x, y + 1.6, z + 1.4);
    pylon.rotation.x = -0.22;
    root.add(pylon);
  }

  // --- undercarriage --------------------------------------------------------
  const gearGroup = new THREE.Group();
  const legMat = painted(0x6a7078, 0.4, 0.7);
  const tyreMat = painted(0x101114, 0.9, 0.0);
  const makeLeg = (x: number, z: number, wheels: number, spread: number) => {
    const g = new THREE.Group();
    const strut = new THREE.Mesh(track(new THREE.CylinderGeometry(0.19, 0.22, 3.6, 8)), legMat);
    strut.position.y = -1.8;
    g.add(strut);
    const tyre = track(new THREE.CylinderGeometry(0.62, 0.62, 0.42, 14));
    tyre.rotateZ(Math.PI / 2);
    for (let w = 0; w < wheels; w++) {
      for (const side of wheels > 2 ? [-1, 1] : [0]) {
        const t = new THREE.Mesh(tyre, tyreMat);
        t.position.set(side * 0.55, -3.55, (w % 2 === 0 ? -1 : 1) * spread);
        g.add(t);
      }
    }
    g.position.set(x, -1.6, z);
    gearGroup.add(g);
    return g;
  };
  makeLeg(0, -16.98, 2, 0.5);
  makeLeg(-3.37, 1.0, 4, 0.7);
  makeLeg(3.37, 1.0, 4, 0.7);
  root.add(gearGroup);

  // --- lights ---------------------------------------------------------------
  // Position lights, strobes, beacons, landing lights and the logo light. On
  // a night approach these are the aeroplane, as far as anyone outside it is
  // concerned.
  const specs: LightSpec[] = [
    { position: new THREE.Vector3(-halfSpan, -3.2, 1.5), color: 0xff2418, intensity: 2.4, size: 1.44 },
    { position: new THREE.Vector3(halfSpan, -3.2, 1.5), color: 0x2bff70, intensity: 2.4, size: 1.44 },
    { position: new THREE.Vector3(0, 1.4, 22.4), color: 0xffffff, intensity: 2.0, size: 1.44 },
    // Anti-collision beacons, top and bottom, red, blinking.
    { position: new THREE.Vector3(0, 2.0, 2.0), color: 0xff2418, intensity: 4, size: 1.92, flash: 0 },
    { position: new THREE.Vector3(0, -2.0, 2.0), color: 0xff2418, intensity: 4, size: 1.92, flash: 0 },
    // Wingtip strobes.
    { position: new THREE.Vector3(-halfSpan, -3.0, 2.4), color: 0xffffff, intensity: 7, size: 2.16 },
    { position: new THREE.Vector3(halfSpan, -3.0, 2.4), color: 0xffffff, intensity: 7, size: 2.16 },
    // Landing lights, in the wing roots, pointing where you are going.
    {
      position: new THREE.Vector3(-4.4, -1.6, -1.0),
      color: 0xfff4dc,
      intensity: 9,
      size: 2.88,
      axis: new THREE.Vector3(0, -0.06, -1).normalize(),
      focus: 3,
    },
    {
      position: new THREE.Vector3(4.4, -1.6, -1.0),
      color: 0xfff4dc,
      intensity: 9,
      size: 2.88,
      axis: new THREE.Vector3(0, -0.06, -1).normalize(),
      focus: 3,
    },
  ];
  const lights: LightField = createLightField(env, specs, {
    viewportHeight: ctx.viewport.height * ctx.viewport.dpr,
  });
  root.add(lights.points);
  const lightParams = lights.points.geometry.getAttribute("aParams") as THREE.BufferAttribute;

  ctx.scene.add(root);

  let strobePhase = 0;
  let fanSpin = 0;

  return {
    lateUpdate(dt, c) {
      const flight = (c.services.flight as AircraftService | undefined) ?? air;
      if (!flight) return;
      const s = flight.state;

      // From the left seat you are *inside* this mesh, and the inside of a
      // fuselage lathe is a white wall four metres from the lens with two
      // wingtip strobes going off behind it. Hiding the exterior when the
      // camera is in the cockpit is not an optimisation — the first version of
      // this world rendered a cockpit correctly and put a beige tunnel over it,
      // and the panel was the only thing in the frame that was not the
      // aeroplane's own paint.
      const inside = (c.services.camera as { inCockpit?: boolean } | undefined)?.inCockpit ?? false;
      root.visible = !inside;
      if (inside) return;

      root.position.copy(s.position);
      root.quaternion.copy(s.orientation);
      root.updateMatrix();
      root.updateMatrixWorld(true);

      // The gear: down and locked at 1, folded into the wells at 0. Sliding
      // them up into the fuselage is a cheat, but at any range where you can
      // tell, they are down anyway.
      const g = s.gear.position;
      gearGroup.visible = g > 0.02;
      gearGroup.scale.setScalar(0.15 + 0.85 * g);
      gearGroup.position.y = -1.6 + (1 - g) * 1.9;

      // The flaps hinge down to 50°, which on a 707 is a startling amount.
      flapGroup.children.forEach((f) => {
        f.rotation.x = (s.flapAngle * Math.PI) / 180;
      });

      // The fans spin with N1 — and are motion-blurred to a disc long before
      // they would strobe, which is what actually happens to your eye.
      fanSpin += dt * (2 + s.n1[0] * 60);
      for (const fan of fans) fan.rotation.z = fanSpin;

      // Strobes: a double flash roughly once a second, out of phase with the
      // beacons, which is what an airliner does.
      strobePhase = (strobePhase + dt) % 1.15;
      const strobeOn = strobePhase < 0.045 || (strobePhase > 0.12 && strobePhase < 0.165);
      lightParams.setX(5, strobeOn ? 9 : 0);
      lightParams.setX(6, strobeOn ? 9 : 0);
      const beaconOn = strobePhase % 0.62 < 0.09;
      lightParams.setX(3, beaconOn ? 5 : 0);
      lightParams.setX(4, beaconOn ? 5 : 0);
      // Landing lights come on with the gear, as they should.
      const landing = s.gear.position > 0.6 ? 9 : 0;
      lightParams.setX(7, landing);
      lightParams.setX(8, landing);
      lightParams.needsUpdate = true;

      lights.update(dt);
    },
    resize(_w, h) {
      setViewportHeight(lights, h, ctx.viewport.dpr);
    },
    dispose() {
      ctx.scene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      lights.dispose();
    },
  };
}
