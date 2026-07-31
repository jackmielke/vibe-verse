/**
 * Vibe Kart — things in the air.
 *
 * Hot-air balloons, a blimp and circling birds. This is the cheapest scale cue
 * in the whole game: a static sky reads as a painted backdrop no matter how good
 * the scattering is, and three slow-moving objects at different distances turn
 * the same backdrop into a volume the track sits inside.
 *
 * Everything here moves on the CPU because there are fewer than a hundred
 * transforms in total and they follow real paths — a balloon drifts with the
 * same wind vector the trees sway to, so the world agrees with itself. The
 * birds are the one exception: their flock positions are CPU, but the wing
 * flap is a vertex-shader rotation off a baked hinge attribute, because forty
 * birds × two wings × per-frame matrix work is exactly the kind of thing that
 * shows up in a profile for no visual gain.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import {
  TAU,
  at,
  gBox,
  gCyl,
  gIco,
  gSphere,
  merge,
  rand,
  setConst,
  strut,
  type Part,
  type Rng,
} from "./util";
import type { SceneryUniforms } from "./wind";

/**
 * Balloon envelope: a lathe of the classic teardrop, banded in two colours.
 * Built as a lathe rather than a sphere because the profile — wide shoulders,
 * a pinched throat — is the whole recognisable silhouette.
 */
function balloonGeometry(rng: Rng, a: number, b: number): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  const gores = 12 + Math.floor(rng() * 5) * 2;
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    // r(f): 0 at the throat, bulging to 1 at 0.62, closing at the crown.
    const r = Math.sin(Math.pow(f, 0.78) * Math.PI) * 4.6 + 0.35;
    profile.push(new THREE.Vector2(Math.max(0.05, r), f * 9.2));
  }
  const lathe = new THREE.LatheGeometry(profile, gores);
  // Gore banding: colour by angle so the envelope has the sewn panels a real
  // balloon has, straight out of the vertex colours.
  const pos = lathe.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const ang = Math.atan2(arr[i * 3 + 2], arr[i * 3]);
    const gore = Math.floor(((ang + Math.PI) / TAU) * gores);
    c.setHex(gore % 2 === 0 ? a : b, THREE.SRGBColorSpace);
    // Crown highlight: the top of a balloon is always brighter than its skirt.
    const up = arr[i * 3 + 1] / 9.2;
    c.multiplyScalar(0.78 + up * 0.34);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  lathe.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  if (!lathe.getAttribute("uv")) {
    lathe.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
  }

  const parts: Part[] = [{ geo: lathe }];
  // Basket, burner frame and the four load ropes.
  parts.push({ geo: at(gBox(1.7, 1.3, 1.7), 0, -2.4, 0), color: 0xb07c3f });
  parts.push({ geo: at(gBox(1.8, 0.16, 1.8), 0, -1.78, 0), color: 0x8a5d2c });
  parts.push({ geo: at(gCyl(0.22, 0.22, 0.7, 6), 0, -1.35, 0), color: 0xd8b45a });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({
        geo: strut(gBox(1, 1, 1), sx * 0.75, -1.9, sz * 0.75, sx * 1.5, 0.35, sz * 1.5, 0.07),
        color: 0x4a4238,
      });
    }
  }
  return merge(parts);
}

/** Blimp: ellipsoid hull, cruciform tail, gondola, a livery stripe. */
function blimpGeometry(): THREE.BufferGeometry {
  const hull = gSphere(1, 16, 10);
  hull.scale(6.5, 6.5, 21);
  const parts: Part[] = [{ geo: hull, color: 0xf4f2ec }];
  // Livery band. A plain white sausage is a balloon; the stripe is the advert.
  const band = gSphere(1, 16, 6);
  band.scale(6.62, 3.0, 12);
  parts.push({ geo: at(band, 0, 0, 1.5), color: 0x1b57c4 });
  const nose = gSphere(1, 12, 8);
  nose.scale(3.0, 3.0, 3.0);
  parts.push({ geo: at(nose, 0, 0, -20.4), color: 0xd8dde4 });
  // Tail fins: vertical pair plus horizontal pair.
  for (const [ax, ay] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    parts.push({
      geo: at(gBox(ax === 0 ? 0.32 : 8.4, ay === 0 ? 0.32 : 8.4, 5.2), ax * 4.6, ay * 4.6, 17.4),
      color: 0xe8402a,
    });
  }
  parts.push({ geo: at(gBox(3.0, 1.9, 7.6), 0, -6.6, -1.5), color: 0xdfe3e9 });
  parts.push({ geo: at(gBox(2.6, 0.9, 5.0), 0, -6.4, -2.6), color: 0x2a3442 });
  for (const sx of [-1, 1]) {
    parts.push({ geo: at(gCyl(0.5, 0.5, 1.4, 8), sx * 2.0, -6.4, 1.2, 0, 0, Math.PI / 2), color: 0x3a4450 });
  }
  return merge(parts);
}

/**
 * A bird: body plus two wings, with the hinge line baked into `aArm` so the
 * crowd shader's arm rotation doubles as a wing flap. Reusing that patch means
 * one more instanced kind and no new shader program.
 */
function birdGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const body = at(gIco(0.16), 0, 0, 0);
  body.scale(1, 0.7, 2.4);
  setConst(body, "aArm", [0, 0, 0, 0]);
  setConst(body, "aTint", [0, 0]);
  parts.push({ geo: body, color: 0x2c3038 });

  for (const sx of [-1, 1]) {
    const wing = gBox(0.9, 0.035, 0.34);
    wing.translate(sx * 0.52, 0.02, 0);
    setConst(wing, "aArm", [sx * 0.06, 0.02, 0, 1]);
    setConst(wing, "aTint", [0, 0]);
    parts.push({ geo: wing, color: 0x3c424c });
  }
  return merge(parts);
}

export function buildSkyLife(b: BuildCtx): SceneryPiece {
  const { sampler, mats, res, density, root } = b;
  const rng: Rng = b.rng("skylife");
  const u: SceneryUniforms = b.uniforms;

  const ceiling = sampler.maxY;
  const group = new THREE.Group();
  group.name = "scenery/sky-life";
  root.add(group);

  // --- balloons ------------------------------------------------------------
  const palettes: Array<[number, number]> = [
    [0xe8402a, 0xffe14d],
    [0x1b57c4, 0xf2f2ef],
    [0x2c8c3f, 0xffd54a],
    [0x8a2be2, 0xff8c1a],
    [0xff4fa3, 0xfff2b0],
    [0x0f8bd6, 0xf6faff],
  ];

  interface Balloon {
    object: THREE.Object3D;
    /** Orbit centre, radius, phase and drift rate. */
    radius: number;
    phase: number;
    speed: number;
    baseY: number;
    bobPhase: number;
  }
  const balloons: Balloon[] = [];
  for (let i = 0; i < density.balloons; i++) {
    const [a, c] = palettes[i % palettes.length];
    const geo = res.geo(balloonGeometry(rng, a, c));
    const mesh = new THREE.Mesh(geo, mats.painted);
    mesh.name = `scenery/balloon${i}`;
    // A balloon nearby and a balloon far away are the parallax that sells the
    // distance to the horizon, so spread the radii hard.
    const scale = rand(rng, 1.0, 2.3);
    mesh.scale.setScalar(scale);
    group.add(mesh);
    balloons.push({
      object: mesh,
      radius: sampler.radius * rand(rng, 0.55, 1.9) + rand(rng, 40, 260),
      phase: rng() * TAU,
      speed: rand(rng, 0.008, 0.021) * (rng() < 0.5 ? 1 : -1),
      baseY: ceiling + rand(rng, 45, 165),
      bobPhase: rng() * TAU,
    });
  }

  // --- blimp ---------------------------------------------------------------
  const blimpGeo = res.geo(blimpGeometry());
  const blimp = new THREE.Mesh(blimpGeo, mats.painted);
  blimp.name = "scenery/blimp";
  blimp.scale.setScalar(1.6);
  group.add(blimp);
  const blimpRadius = sampler.radius * 1.25 + 190;
  const blimpY = ceiling + 210;
  let blimpPhase = rng() * TAU;

  // --- birds ---------------------------------------------------------------
  // Two flocks on lazy circles at different altitudes. The wing flap comes from
  // the crowd shader's arm hinge, so the whole flock is one draw call.
  const birdCount = density.birds;
  let birds: THREE.InstancedMesh | null = null;
  const flocks: Array<{ cx: number; cz: number; r: number; y: number; speed: number; phase: number }> = [];
  if (birdCount > 0) {
    const birdGeo = res.geo(birdGeometry());
    birds = new THREE.InstancedMesh(birdGeo, mats.bird, birdCount);
    birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    birds.frustumCulled = false;
    birds.castShadow = false;
    // instanceColor doubles as the flap-phase carrier — see BIRD_GLSL. The
    // green and blue channels stay fixed so the tint reads as nothing more
    // than a warm/cool variation across the flock.
    const tints = new Float32Array(birdCount * 3);
    for (let i = 0; i < birdCount; i++) {
      tints[i * 3] = 0.8 + (i * 0.618034 % 1) * 0.2;
      tints[i * 3 + 1] = 0.92;
      tints[i * 3 + 2] = 0.94;
    }
    birds.instanceColor = new THREE.InstancedBufferAttribute(tints, 3);
    group.add(birds);
    const flockCount = 2;
    for (let f = 0; f < flockCount; f++) {
      const a = rng() * TAU;
      const d = sampler.radius * rand(rng, 0.4, 1.1);
      flocks.push({
        cx: sampler.centre.x + Math.cos(a) * d,
        cz: sampler.centre.z + Math.sin(a) * d,
        r: rand(rng, 55, 130),
        y: ceiling + rand(rng, 34, 92),
        speed: rand(rng, 0.16, 0.3) * (f % 2 === 0 ? 1 : -1),
        phase: rng() * TAU,
      });
    }
  }

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const birdJitter: number[] = [];
  for (let i = 0; i < birdCount; i++) birdJitter.push(rng(), rng(), rng());

  return {
    update(dt, elapsed) {
      void dt;
      const windAngle = Math.atan2(u.uWind.value.y, u.uWind.value.x);

      for (const bal of balloons) {
        // Balloons do not steer; they go where the wind goes. Drifting them
        // along the same vector the trees bend to is what makes the sky and the
        // ground feel like one weather system.
        const a = bal.phase + elapsed * bal.speed + windAngle * 0.12;
        bal.object.position.set(
          sampler.centre.x + Math.cos(a) * bal.radius,
          bal.baseY + Math.sin(elapsed * 0.21 + bal.bobPhase) * 5.5,
          sampler.centre.z + Math.sin(a) * bal.radius,
        );
        // A gentle pendulum under the envelope, lagging the drift.
        bal.object.rotation.set(
          Math.sin(elapsed * 0.33 + bal.bobPhase) * 0.045,
          a * 0.4,
          Math.cos(elapsed * 0.27 + bal.bobPhase * 1.7) * 0.05,
        );
      }

      blimpPhase += dt * 0.021;
      const bx = sampler.centre.x + Math.cos(blimpPhase) * blimpRadius;
      const bz = sampler.centre.z + Math.sin(blimpPhase) * blimpRadius;
      blimp.position.set(bx, blimpY + Math.sin(elapsed * 0.14) * 7, bz);
      // Nose along the tangent, plus a little bank into the turn. The hull is
      // authored nose-down -Z, which is the engine's forward convention.
      blimp.rotation.set(0, -blimpPhase - Math.PI * 0.5, Math.sin(elapsed * 0.19) * 0.03, "YXZ");

      if (birds) {
        for (let i = 0; i < birdCount; i++) {
          const f = flocks[i % flocks.length];
          const j0 = birdJitter[i * 3];
          const j1 = birdJitter[i * 3 + 1];
          const j2 = birdJitter[i * 3 + 2];
          const a = f.phase + elapsed * f.speed + j0 * TAU;
          const r = f.r * (0.62 + j1 * 0.55);
          p.set(
            f.cx + Math.cos(a) * r,
            f.y + j2 * 26 + Math.sin(elapsed * 0.9 + j0 * 9) * 2.4,
            f.cz + Math.sin(a) * r,
          );
          // Face the direction of travel and bank into the circle.
          e.set(0, -a - Math.PI * 0.5 * Math.sign(f.speed), f.speed > 0 ? -0.32 : 0.32, "YXZ");
          q.setFromEuler(e);
          m.compose(p, q, one);
          birds.setMatrixAt(i, m);
        }
        birds.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
