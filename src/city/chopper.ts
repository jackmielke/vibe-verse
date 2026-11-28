/**
 * chopper — the police helicopter that comes out at five stars.
 *
 * Jack's spec (Nov 27 2026): "if there's 5 stars of heat, there should be a
 * helicopter cop that also can take you down and tries to shoot down at you.
 * Maybe even shoots bazookas at you."
 *
 * So it does three things, in a loop, for as long as you stay at five stars:
 *
 * - **Hunts.** It lifts off from over the police station, flies to you at
 *   rooftop height plus a margin, and circles at about twenty metres out with
 *   its searchlight on you. It climbs over anything tall underneath it.
 * - **Shoots.** Short door-gun bursts straight down at you. Every round is a
 *   roll: standing still is a bad idea, running is better, a building between
 *   you and it stops the round outright. That is the counterplay.
 * - **Fires rockets.** Every few seconds a rocket, led to where you are going,
 *   that blows up whatever it lands on: cars, trees, you.
 *
 * It can be shot down. It is a candidate for the assisted aim like a cruiser
 * is, takes about a dozen rifle rounds, spirals down trailing smoke and goes up
 * where it lands. If you are still at five stars another one comes out
 * CHOPPER_RESPAWN seconds later. Lose the stars and it peels off and leaves.
 *
 * This file only decides where it is and what it fires. Whether a hit hurts
 * you, your car or the bad guy you are riding with is `mayhem.ts`'s call.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import type { CrashFx } from "@/city/crashFx";

export const CHOPPER_HP = 300;
/** Seconds after one goes down before the next comes out, if you are still at five stars. */
export const CHOPPER_RESPAWN = 25;
/** How far out it circles, and the lowest it will fly. */
const ORBIT_R = 20;
const MIN_ALT = 30;
const TOP_SPEED = 30;
/** Door gun: a burst every BURST_EVERY seconds, BURST_ROUNDS rounds in it. */
const BURST_EVERY = 3.2;
const BURST_ROUNDS = 9;
const ROUND_GAP = 0.11;
const ROUND_DMG = 6;
/** Rockets. */
const ROCKET_EVERY = 6.5;
const ROCKET_SPEED = 34;
const ROCKET_R = 7.5;
/**
 * The big green laser (Jack, Nov 28: "like a Death Star laser"): it never aims
 * at you, only at the buildings around you. A charge you can see coming, then
 * a beam, then the wall goes up.
 */
const LASER_EVERY = 7.5;
const LASER_CHARGE = 1.4;
const LASER_FIRE = 0.7;

export interface ChopperTarget {
  x: number;
  y: number;
  z: number;
  /** Ground speed, m/s, for leading the rockets and spoiling the aim. */
  vx: number;
  vz: number;
  driving: boolean;
}

export interface ChopperOpts {
  group: THREE.Group;
  crashFx: CrashFx;
  boxes: WorldBox[];
  /** Where it lifts off from: the police station. */
  home: [number, number];
  /** The city's collision query, for cover. */
  blocked: () => ((x: number, z: number, y: number) => boolean) | null;
  /** A door-gun round hit you. (dx, dz) is the way it was going. */
  onRound(dmg: number, dx: number, dz: number): void;
  /** A rocket went off here. */
  onRocket(x: number, y: number, z: number, r: number): void;
  /** It hit the ground and exploded. */
  onCrash(x: number, z: number): void;
  /**
   * The laser wants a building near (x, z) to aim at: its id and the point on
   * its wall facing (fromX, fromZ), or null if there is none.
   */
  pickBuilding?(x: number, z: number, fromX: number, fromZ: number): { id: number; x: number; y: number; z: number } | null;
  /** The laser hit that building at that point. */
  onLaser?(id: number, x: number, y: number, z: number, fromX: number, fromZ: number): void;
  audio: () => AudioContext | null;
}

export interface Chopper {
  /** `want` is true while you are at five stars in the city. */
  update(dt: number, want: boolean, t: ChopperTarget | null): void;
  /** For the assisted aim: where it is, while it can be shot. */
  aimPoint(): { x: number; y: number; z: number } | null;
  /** Shot. True if that brought it down. */
  hurt(dmg: number): boolean;
  hud(): { hp: number } | null;
  debug(): {
    state: string; x: number; y: number; z: number; hp: number;
    rounds: number; roundHits: number; rockets: number; respawnIn: number;
    lasers: number; laser: string;
  };
  /** For harnesses: start a laser shot now (at the best building near the target). */
  fireLaser(): void;
  /** For harnesses: put one up right now, over (x, z). */
  spawnAt(x: number, z: number): void;
  dispose(): void;
}

type State = "none" | "hunt" | "leave" | "falling" | "wreck";

function buildChopper(): { group: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; red: THREE.MeshBasicMaterial; blue: THREE.MeshBasicMaterial; beam: THREE.Mesh; geos: THREE.BufferGeometry[]; mats: THREE.Material[] } {
  const g = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const mat = <M extends THREE.Material>(m: M) => (mats.push(m), m);
  const geo = <G extends THREE.BufferGeometry>(x: G) => (geos.push(x), x);
  const navy = mat(new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.45, metalness: 0.35 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.5 }));
  const dark = mat(new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6, metalness: 0.5 }));
  const glass = mat(new THREE.MeshStandardMaterial({ color: 0x7fb7e6, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.75 }));
  const add = (gm: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
    const mesh = new THREE.Mesh(gm, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  // Body: a fat capsule with a white belly stripe, nose along +z.
  const body = add(geo(new THREE.CapsuleGeometry(1.15, 2.4, 6, 14).rotateX(Math.PI / 2)), navy, 0, 0, 0);
  body.scale.set(1, 0.95, 1);
  add(geo(new THREE.BoxGeometry(2.36, 0.42, 3.4)), white, 0, -0.25, 0.1);
  // Windscreen.
  const ws = add(geo(new THREE.SphereGeometry(1.0, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2)), glass, 0, 0.1, 1.55);
  ws.rotation.x = Math.PI / 2.4;
  ws.scale.set(1.05, 0.9, 0.8);
  // Tail boom, fin and tail rotor.
  add(geo(new THREE.CylinderGeometry(0.22, 0.42, 4.6, 10).rotateX(Math.PI / 2)), navy, 0, 0.35, -3.9);
  add(geo(new THREE.BoxGeometry(0.12, 1.4, 0.8)), navy, 0, 0.95, -6.0);
  add(geo(new THREE.BoxGeometry(1.6, 0.1, 0.5)), navy, 0, 0.4, -5.9);
  const tail = new THREE.Group();
  tail.position.set(0.2, 1.0, -6.1);
  g.add(tail);
  add(geo(new THREE.BoxGeometry(0.05, 1.5, 0.16)), dark, 0, 0, 0, tail);
  // Mast and main rotor.
  add(geo(new THREE.CylinderGeometry(0.16, 0.22, 0.6, 8)), dark, 0, 1.35, 0);
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.7, 0);
  g.add(rotor);
  const blade = geo(new THREE.BoxGeometry(11, 0.06, 0.38));
  add(blade, dark, 0, 0, 0, rotor);
  add(blade, dark, 0, 0, 0, rotor).rotation.y = Math.PI / 2;
  add(geo(new THREE.CylinderGeometry(0.3, 0.3, 0.18, 10)), dark, 0, 0, 0, rotor);
  // Skids.
  for (const s of [-1, 1]) {
    add(geo(new THREE.CylinderGeometry(0.07, 0.07, 3.8, 6).rotateX(Math.PI / 2)), dark, s * 1.05, -1.45, 0.1);
    add(geo(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 6)), dark, s * 0.95, -1.05, 0.9).rotation.z = s * 0.25;
    add(geo(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 6)), dark, s * 0.95, -1.05, -0.7).rotation.z = s * 0.25;
    // Rocket pods on stub wings.
    add(geo(new THREE.BoxGeometry(0.9, 0.1, 0.4)), dark, s * 1.45, -0.35, 0.3);
    add(geo(new THREE.CylinderGeometry(0.2, 0.2, 1.3, 8).rotateX(Math.PI / 2)), dark, s * 1.85, -0.5, 0.35);
  }
  // Light bar: red and blue, strobed by update().
  const red = mat(new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
  const blue = mat(new THREE.MeshBasicMaterial({ color: 0x2a6bff }));
  add(geo(new THREE.BoxGeometry(0.35, 0.16, 0.35)), red, -0.35, -1.0, -0.8);
  add(geo(new THREE.BoxGeometry(0.35, 0.16, 0.35)), blue, 0.35, -1.0, -0.8);
  // Searchlight beam: a soft additive cone hanging under the nose. It is a
  // mesh, never a real light, so the whole city's materials do not recompile
  // when it appears.
  const beamMat = mat(new THREE.MeshBasicMaterial({
    color: 0xfff6d0, transparent: true, opacity: 0.13, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  // Unit cone, tip at the origin, opening down -y to length 1.
  const beam = new THREE.Mesh(geo(new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0)), beamMat);
  beam.renderOrder = 5;
  return { group: g, rotor, tail, red, blue, beam, geos, mats };
}

export function createChopper(opts: ChopperOpts): Chopper {
  const { crashFx } = opts;
  const m = buildChopper();
  m.group.visible = false;
  opts.group.add(m.group);
  m.beam.visible = false;
  opts.group.add(m.beam);
  // Where the searchlight lands.
  const spotMat = new THREE.MeshBasicMaterial({
    color: 0xfff3c0, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const spotGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  const spot = new THREE.Mesh(spotGeo, spotMat);
  spot.visible = false;
  spot.renderOrder = 4;
  opts.group.add(spot);

  // Door-gun tracers and rockets.
  const tracerGeo = new THREE.BoxGeometry(0.06, 0.06, 1).translate(0, 0, 0.5);
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd36b });
  const tracers = Array.from({ length: 6 }, () => {
    const mesh = new THREE.Mesh(tracerGeo, tracerMat);
    mesh.visible = false;
    opts.group.add(mesh);
    return { mesh, t: 1 };
  });
  let tracerNext = 0;
  const rocketGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.1, 8).rotateX(Math.PI / 2);
  const rocketMat = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.4, metalness: 0.5 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
  const flameGeo = new THREE.ConeGeometry(0.16, 0.7, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.85);
  // The laser: a charging orb under the nose, a core and a glow, and a shock ring.
  const laserGreen = new THREE.MeshBasicMaterial({
    color: 0x6bff7a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const laserCore = new THREE.MeshBasicMaterial({
    color: 0xeaffea, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
  const orbGeo = new THREE.SphereGeometry(1, 16, 12);
  const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
  const laserGlow = new THREE.Mesh(beamGeo, laserGreen);
  const laserBeam = new THREE.Mesh(beamGeo, laserCore);
  const laserOrb = new THREE.Mesh(orbGeo, laserGreen);
  for (const l of [laserGlow, laserBeam, laserOrb]) {
    l.visible = false;
    l.renderOrder = 6;
    opts.group.add(l);
  }
  interface Blast { flash: THREE.Mesh; ring: THREE.Mesh; t: number; size: number }
  const blasts: Blast[] = [];
  const blastMats: THREE.Material[] = [];
  const spawnBlast = (bx: number, by: number, bz: number, size: number, faceX: number, faceZ: number) => {
    const fm = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    const rm = new THREE.MeshBasicMaterial({ color: 0x9dff9a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    blastMats.push(fm, rm);
    const flash = new THREE.Mesh(orbGeo, fm);
    const ring = new THREE.Mesh(ringGeo, rm);
    flash.position.set(bx, by, bz);
    ring.position.set(bx, by, bz);
    // The ring stands on the wall, facing out toward whoever fired.
    ring.lookAt(bx + faceX, by, bz + faceZ);
    flash.renderOrder = ring.renderOrder = 7;
    opts.group.add(flash, ring);
    blasts.push({ flash, ring, t: 0, size });
  };
  type LaserPhase = "idle" | "charge" | "fire";
  let laserPhase: LaserPhase = "idle";
  let laserT = 0;
  let laserCool = 5;
  let lasers = 0;
  let laserAim: { id: number; x: number; y: number; z: number } | null = null;
  let laserWant = false;
  const zap = () => {
    const a = opts.audio();
    if (!a) return;
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(140, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(38, a.currentTime + 0.9);
    const g = a.createGain();
    g.gain.setValueAtTime(0.16, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 1.0);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 1.05);
  };
  const hum = () => {
    const a = opts.audio();
    if (!a) return;
    const o = a.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(90, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(620, a.currentTime + LASER_CHARGE);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, a.currentTime + LASER_CHARGE);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + LASER_CHARGE + 0.1);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + LASER_CHARGE + 0.15);
  };
  const hideLaser = () => {
    laserGlow.visible = laserBeam.visible = laserOrb.visible = false;
  };
  const updateBlasts = (dt: number) => {
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      b.t += dt;
      const k = b.t / 1.1;
      if (k >= 1) {
        opts.group.remove(b.flash, b.ring);
        (b.flash.material as THREE.Material).dispose();
        (b.ring.material as THREE.Material).dispose();
        blasts.splice(i, 1);
        continue;
      }
      b.flash.scale.setScalar(b.size * (0.4 + Math.sqrt(k) * 1.2));
      (b.flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k * 1.6);
      b.ring.scale.setScalar(b.size * (0.5 + k * 4.5));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    }
  };
  interface Rocket { mesh: THREE.Group; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number }
  const rockets: Rocket[] = [];

  let state: State = "none";
  let x = 0, y = 0, z = 0, yaw = 0;
  let vx = 0, vy = 0, vz = 0;
  let hp = CHOPPER_HP;
  let orbit = 0;
  let burstCool = 2.5;
  let burstLeft = 0;
  let roundCool = 0;
  let rocketCool = 4;
  let respawnIn = 0;
  let stateT = 0;
  let spin = 0;
  let clock = 0;
  let rounds = 0;
  let roundHits = 0;
  let rocketsFired = 0;

  // Rotor sound: looped noise through a low-pass, chopped at the blade rate.
  let rotorSnd: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  const rotorTo = (level: number) => {
    if (level <= 0.01 && !rotorSnd) return;
    const a = opts.audio();
    if (!a) return;
    if (!rotorSnd) {
      try {
        const buf = a.createBuffer(1, a.sampleRate, a.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = a.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const lp = a.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 320;
        const chop = a.createGain();
        chop.gain.value = 0.5;
        const lfo = a.createOscillator();
        lfo.type = "square";
        lfo.frequency.value = 13;
        const lfoGain = a.createGain();
        lfoGain.gain.value = 0.45;
        lfo.connect(lfoGain).connect(chop.gain);
        const gain = a.createGain();
        gain.gain.value = 0;
        src.connect(lp).connect(chop).connect(gain).connect(a.destination);
        src.start();
        lfo.start();
        rotorSnd = { src, gain, lfo };
      } catch {
        return;
      }
    }
    rotorSnd.gain.gain.setTargetAtTime(level * 0.35, a.currentTime, 0.2);
  };
  const gunSnd = () => {
    const a = opts.audio();
    if (!a) return;
    const o = a.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(180, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(60, a.currentTime + 0.05);
    const g = a.createGain();
    g.gain.setValueAtTime(0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.06);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.07);
  };
  const whoosh = () => {
    const a = opts.audio();
    if (!a) return;
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(900, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(200, a.currentTime + 0.5);
    const g = a.createGain();
    g.gain.setValueAtTime(0.06, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.55);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.6);
  };

  /** The highest roof within `r` metres of (px, pz). */
  const roofNear = (px: number, pz: number, r: number) => {
    let top = 0;
    for (const b of opts.boxes) {
      if (b.height <= top) continue;
      if (px < b.minX - r || px > b.maxX + r || pz < b.minZ - r || pz > b.maxZ + r) continue;
      top = b.height;
    }
    return top;
  };

  const spawn = (sx: number, sz: number) => {
    state = "hunt";
    stateT = 0;
    hp = CHOPPER_HP;
    x = sx;
    z = sz;
    y = Math.max(MIN_ALT, roofNear(sx, sz, 8) + 10);
    vx = vy = vz = 0;
    burstCool = 3;
    rocketCool = 5;
    burstLeft = 0;
    m.group.visible = true;
    m.group.rotation.set(0, 0, 0);
  };

  const hideAll = () => {
    m.group.visible = false;
    m.beam.visible = false;
    spot.visible = false;
  };

  const fireRound = (t: ChopperTarget) => {
    rounds++;
    // Spoiled by moving fast, and worse from further away.
    const sp = Math.hypot(t.vx, t.vz);
    const dist = Math.hypot(t.x - x, t.y - y, t.z - z);
    const p = THREE.MathUtils.clamp((t.driving ? 0.55 : 0.5) - sp * 0.018 - Math.max(0, dist - 30) * 0.008, 0.08, 0.6);
    const hit = Math.random() < p;
    const miss = hit ? 0 : 1.2 + Math.random() * 2.5;
    const a = Math.random() * Math.PI * 2;
    const ex = t.x + Math.cos(a) * miss;
    const ez = t.z + Math.sin(a) * miss;
    const ey = hit ? t.y + (t.driving ? 1 : 1.1) : 0.05;
    // A building in the way takes the round.
    const ox = x + Math.sin(yaw) * 1.3;
    const oy = y - 1.1;
    const oz = z + Math.cos(yaw) * 1.3;
    let fx = ex, fy = ey, fz = ez;
    let covered = false;
    const blocked = opts.blocked();
    if (blocked) {
      const len = Math.hypot(ex - ox, ey - oy, ez - oz);
      for (let s = 2; s < len - 1; s += 1.5) {
        const k = s / len;
        const px = ox + (ex - ox) * k, py = oy + (ey - oy) * k, pz = oz + (ez - oz) * k;
        if (blocked(px, pz, py)) {
          fx = px; fy = py; fz = pz;
          covered = true;
          break;
        }
      }
    }
    const tr = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % tracers.length;
    tr.t = 0;
    tr.mesh.visible = true;
    tr.mesh.position.set(ox, oy, oz);
    tr.mesh.scale.set(1.4, 1.4, Math.hypot(fx - ox, fy - oy, fz - oz));
    tr.mesh.lookAt(fx, fy, fz);
    gunSnd();
    if (covered) {
      crashFx.sparks(fx, fy, fz, 0, 0, 4);
      return;
    }
    if (hit) {
      roundHits++;
      const d = Math.hypot(ex - ox, ez - oz) || 1;
      opts.onRound(ROUND_DMG, (ex - ox) / d, (ez - oz) / d);
      crashFx.sparks(ex, ey, ez, 0, 0, 5);
    } else {
      crashFx.debris(ex, 0.1, ez, 2, 0x8a8f96, 3);
    }
  };

  const fireRocket = (t: ChopperTarget) => {
    rocketsFired++;
    const lead = 0.9;
    const tx = t.x + t.vx * lead + (Math.random() - 0.5) * 3;
    const tz = t.z + t.vz * lead + (Math.random() - 0.5) * 3;
    const side = rocketsFired % 2 ? 1 : -1;
    const ox = x + Math.cos(yaw) * side * 1.85;
    const oz = z - Math.sin(yaw) * side * 1.85;
    const oy = y - 0.5;
    const dx = tx - ox, dy = t.y - oy, dz = tz - oz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(rocketGeo, rocketMat));
    mesh.add(new THREE.Mesh(flameGeo, flameMat));
    mesh.position.set(ox, oy, oz);
    opts.group.add(mesh);
    rockets.push({ mesh, x: ox, y: oy, z: oz, vx: (dx / d) * ROCKET_SPEED, vy: (dy / d) * ROCKET_SPEED, vz: (dz / d) * ROCKET_SPEED, age: 0 });
    whoosh();
  };

  const updateRockets = (dt: number, groundY: number) => {
    const blocked = opts.blocked();
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.age += dt;
      r.vy -= 2 * dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.z += r.vz * dt;
      r.mesh.position.set(r.x, r.y, r.z);
      r.mesh.lookAt(r.x + r.vx, r.y + r.vy, r.z + r.vz);
      crashFx.smoulder(dt, r.x, r.y, r.z, 0.5, 0);
      const hit = r.y <= groundY + 0.2 || r.age > 4 || (blocked?.(r.x, r.z, r.y) ?? false);
      if (hit) {
        opts.group.remove(r.mesh);
        rockets.splice(i, 1);
        crashFx.explode(r.x, Math.max(groundY, r.y), r.z, 1.1, 0x5a5f66);
        crashFx.kick(0.4);
        opts.onRocket(r.x, Math.max(groundY, r.y), r.z, ROCKET_R);
      }
    }
  };

  const api: Chopper = {
    update(dt, want, t) {
      clock += dt;
      for (const tr of tracers) {
        if (!tr.mesh.visible) continue;
        tr.t += dt;
        if (tr.t > 0.05) tr.mesh.visible = false;
      }
      updateRockets(dt, 0);
      updateBlasts(dt);

      if (state === "none") {
        respawnIn = Math.max(0, respawnIn - dt);
        if (want && t && respawnIn <= 0) {
          // Up from over the police station, or from 120 m off if that is a
          // long way from you: it should arrive inside the chase, not after it.
          const [hx, hz] = opts.home;
          const far = Math.hypot(hx - t.x, hz - t.z) > 160;
          const a = Math.random() * Math.PI * 2;
          spawn(far ? t.x + Math.cos(a) * 120 : hx, far ? t.z + Math.sin(a) * 120 : hz);
        }
        rotorTo(0);
        return;
      }

      stateT += dt;
      spin += dt * (state === "falling" ? 18 : 32);
      m.rotor.rotation.y = spin;
      m.tail.rotation.x = spin * 1.6;
      const strobe = Math.sin(clock * 14) > 0;
      m.red.color.setHex(strobe ? 0xff2a2a : 0x300808);
      m.blue.color.setHex(strobe ? 0x08122e : 0x2a6bff);

      if (state === "hunt" && (!want || !t)) {
        state = "leave";
        stateT = 0;
      }

      if (state === "hunt" && t) {
        // Circle the target, with the nose on it.
        orbit += dt * 0.32;
        const alt = Math.max(MIN_ALT, roofNear(x, z, 10) + 10, t.y + 16);
        const gx = t.x + Math.cos(orbit) * ORBIT_R;
        const gz = t.z + Math.sin(orbit) * ORBIT_R;
        let dx = gx - x, dz = gz - z;
        const d = Math.hypot(dx, dz);
        const spd = Math.min(TOP_SPEED, d * 0.9);
        dx = d > 0.01 ? (dx / d) * spd : 0;
        dz = d > 0.01 ? (dz / d) * spd : 0;
        const k = 1 - Math.exp(-dt * 1.6);
        vx += (dx - vx) * k;
        vz += (dz - vz) * k;
        vy += ((alt - y) * 0.8 - vy) * k;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        let face = Math.atan2(t.x - x, t.z - z) - yaw;
        while (face > Math.PI) face -= Math.PI * 2;
        while (face < -Math.PI) face += Math.PI * 2;
        yaw += face * Math.min(1, dt * 2.5);

        // Weapons, only once it is close enough to mean it.
        const reach = Math.hypot(t.x - x, t.z - z);
        if (reach < 45 && stateT > 2) {
          burstCool -= dt;
          if (burstCool <= 0 && burstLeft <= 0) {
            burstLeft = BURST_ROUNDS;
            burstCool = BURST_EVERY;
          }
          if (burstLeft > 0) {
            roundCool -= dt;
            if (roundCool <= 0) {
              fireRound(t);
              burstLeft--;
              roundCool = ROUND_GAP;
            }
          }
          rocketCool -= dt;
          if (rocketCool <= 0 && laserPhase === "idle") {
            fireRocket(t);
            rocketCool = ROCKET_EVERY * (0.8 + Math.random() * 0.4);
          }
          laserCool -= dt;
          if ((laserCool <= 0 || laserWant) && laserPhase === "idle") {
            laserWant = false;
            laserAim = opts.pickBuilding?.(t.x, t.z, x, z) ?? null;
            laserCool = LASER_EVERY * (0.8 + Math.random() * 0.4);
            if (laserAim) {
              laserPhase = "charge";
              laserT = 0;
              hum();
            }
          }
        }
        if (laserPhase !== "idle" && laserAim) {
          laserT += dt;
          // Nose on the building, not on you, while it charges and fires.
          let lf = Math.atan2(laserAim.x - x, laserAim.z - z) - yaw;
          while (lf > Math.PI) lf -= Math.PI * 2;
          while (lf < -Math.PI) lf += Math.PI * 2;
          yaw += lf * Math.min(1, dt * 6);
          const nx = x + Math.sin(yaw) * 2.2;
          const ny = y - 0.9;
          const nz = z + Math.cos(yaw) * 2.2;
          laserOrb.visible = true;
          laserOrb.position.set(nx, ny, nz);
          if (laserPhase === "charge") {
            const k = Math.min(1, laserT / LASER_CHARGE);
            laserOrb.scale.setScalar(0.2 + k * 1.1 + Math.sin(clock * 40) * 0.08);
            // A thin flickering aiming line while it charges.
            laserBeam.visible = Math.sin(clock * 30) > 0;
            laserBeam.position.set(nx, ny, nz);
            laserBeam.lookAt(laserAim.x, laserAim.y, laserAim.z);
            laserBeam.scale.set(0.04, 0.04, Math.hypot(laserAim.x - nx, laserAim.y - ny, laserAim.z - nz));
            laserGlow.visible = false;
            if (laserT >= LASER_CHARGE) {
              laserPhase = "fire";
              laserT = 0;
              lasers++;
              zap();
              spawnBlast(laserAim.x, laserAim.y, laserAim.z, 3.5, nx - laserAim.x, nz - laserAim.z);
              crashFx.kick(0.5);
              opts.onLaser?.(laserAim.id, laserAim.x, laserAim.y, laserAim.z, x, z);
            }
          } else {
            const k = laserT / LASER_FIRE;
            const w = (1 - k) * 0.9 + 0.25;
            const len = Math.hypot(laserAim.x - nx, laserAim.y - ny, laserAim.z - nz);
            for (const [mesh, r] of [[laserGlow, w * 1.6], [laserBeam, w * 0.5]] as Array<[THREE.Mesh, number]>) {
              mesh.visible = true;
              mesh.position.set(nx, ny, nz);
              mesh.lookAt(laserAim.x, laserAim.y, laserAim.z);
              mesh.scale.set(r, r, len);
            }
            laserOrb.scale.setScalar(1.3 * (1 - k) + 0.3);
            crashFx.smoulder(dt, laserAim.x, laserAim.y, laserAim.z, 1, 1);
            if (laserT >= LASER_FIRE) {
              laserPhase = "idle";
              laserAim = null;
              hideLaser();
            }
          }
        }

        // Searchlight.
        m.beam.visible = true;
        m.beam.position.set(x, y - 0.9, z);
        const look = new THREE.Vector3(t.x - x, t.y - (y - 0.9), t.z - z);
        const len = look.length();
        m.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), look.normalize());
        m.beam.scale.set(3.2, len, 3.2);
        spot.visible = true;
        spot.position.set(t.x, t.y + 0.06, t.z);
        spot.scale.setScalar(3.4);
      } else if (state === "leave") {
        if (laserPhase !== "idle") {
          laserPhase = "idle";
          laserAim = null;
          hideLaser();
        }
        // Climb and head home.
        const [hx, hz] = opts.home;
        let dx = hx - x, dz = hz - z;
        const d = Math.hypot(dx, dz) || 1;
        dx /= d;
        dz /= d;
        vx += (dx * TOP_SPEED - vx) * Math.min(1, dt);
        vz += (dz * TOP_SPEED - vz) * Math.min(1, dt);
        vy += (8 - vy) * Math.min(1, dt);
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        yaw = Math.atan2(vx, vz);
        m.beam.visible = false;
        spot.visible = false;
        if (stateT > 9 || d < 5) {
          state = "none";
          hideAll();
        }
      } else if (state === "falling") {
        // Spiralling down, trailing smoke and fire.
        vy -= 9.8 * dt;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        yaw += dt * 5;
        m.group.rotation.z = Math.min(0.7, stateT * 0.4);
        crashFx.smoulder(dt, x, y, z, 1, 1);
        const floor = Math.max(0, roofNear(x, z, 0));
        if (y <= floor + 1) {
          y = floor + 1;
          state = "wreck";
          stateT = 0;
          crashFx.explode(x, y, z, 1.8, 0x1b2a4a);
          crashFx.debris(x, y + 1, z, 12, 0x1b2a4a, 12);
          crashFx.kick(0.8);
          opts.onCrash(x, z);
        }
      } else if (state === "wreck") {
        crashFx.smoulder(dt, x, y, z, 1, Math.max(0, 1 - stateT / 10));
        if (stateT > 12) {
          state = "none";
          hideAll();
        }
      }

      if (m.group.visible) {
        m.group.position.set(x, y, z);
        m.group.rotation.y = yaw;
        if (state === "hunt") {
          // Nose down into the direction of travel, roll into the turn.
          const fwd = vx * Math.sin(yaw) + vz * Math.cos(yaw);
          const side = vx * Math.cos(yaw) - vz * Math.sin(yaw);
          m.group.rotation.x = THREE.MathUtils.clamp(fwd * 0.012, -0.3, 0.3);
          m.group.rotation.z = THREE.MathUtils.clamp(-side * 0.012, -0.3, 0.3);
        }
      }
      const near = t ? Math.hypot(t.x - x, t.y - y, t.z - z) : 999;
      rotorTo(state === "hunt" || state === "leave" || state === "falling" ? Math.max(0, 1 - near / 150) : 0);
    },
    aimPoint() {
      return state === "hunt" || state === "leave" ? { x, y, z } : null;
    },
    hurt(dmg) {
      if (state !== "hunt" && state !== "leave") return false;
      hp -= dmg;
      crashFx.sparks(x, y, z, 0, 0, 6);
      if (hp > 0) return false;
      hp = 0;
      laserPhase = "idle";
      laserAim = null;
      hideLaser();
      state = "falling";
      stateT = 0;
      vy = 2;
      m.beam.visible = false;
      spot.visible = false;
      respawnIn = CHOPPER_RESPAWN;
      crashFx.explode(x, y, z, 0.8, 0xff8a3a);
      return true;
    },
    hud() {
      return state === "hunt" || state === "leave" ? { hp: Math.max(0, Math.round((hp / CHOPPER_HP) * 100)) } : null;
    },
    debug() {
      return { state, x, y, z, hp, rounds, roundHits, rockets: rocketsFired, respawnIn, lasers, laser: laserPhase };
    },
    fireLaser() {
      laserWant = true;
    },
    spawnAt(sx, sz) {
      respawnIn = 0;
      spawn(sx, sz);
    },
    dispose() {
      for (const b of blasts.splice(0)) opts.group.remove(b.flash, b.ring);
      blastMats.forEach((mm) => mm.dispose());
      opts.group.remove(laserGlow, laserBeam, laserOrb);
      laserGreen.dispose();
      laserCore.dispose();
      beamGeo.dispose();
      orbGeo.dispose();
      ringGeo.dispose();
      for (const r of rockets.splice(0)) opts.group.remove(r.mesh);
      opts.group.remove(m.group, m.beam, spot);
      for (const tr of tracers) opts.group.remove(tr.mesh);
      m.geos.forEach((g) => g.dispose());
      m.mats.forEach((x) => x.dispose());
      spotGeo.dispose();
      spotMat.dispose();
      tracerGeo.dispose();
      tracerMat.dispose();
      rocketGeo.dispose();
      rocketMat.dispose();
      flameGeo.dispose();
      flameMat.dispose();
      try {
        rotorSnd?.src.stop();
        rotorSnd?.lfo.stop();
      } catch {
        /* already gone */
      }
    },
  };
  return api;
}
