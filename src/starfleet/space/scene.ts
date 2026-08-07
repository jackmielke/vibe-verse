/**
 * The space scene: one star system at a time, and the ship inside it.
 *
 * Only ever one system exists. Warping does not load a second one beside the
 * first — `enter()` disposes the planet, the star and the nebula and builds the
 * next set in their place, and the starfield and the ship persist across the
 * jump because they are the two things that are the same everywhere. Twelve
 * systems in a session on a browser with a hard cap on live WebGL contexts is
 * exactly the shape of problem that leaks look like, so nothing here is kept
 * "in case we come back".
 *
 * ## Flight
 *
 * Two modes, and the split is the reason the world is playable rather than
 * merely flyable.
 *
 * **Standard orbit** is the default, and it is on rails: the ship rides a
 * circle at 1.9 planetary radii with the world under her keel. It is not a
 * cutscene — you can break out of it with the throttle at any moment — but it
 * means that arriving somewhere always *looks* like arriving somewhere, and
 * that a player who touches nothing is still looking at the best shot in the
 * game. Every screenshot this world will ever take is taken from here.
 *
 * **Free flight** is what you get the moment you touch the throttle. Newtonian
 * enough to be satisfying, damped enough to be steerable with a mouse, and
 * hard-floored at 1.06 R so that "fly at the planet" ends in a very close pass
 * rather than in the middle of the terrain shader.
 */
import * as THREE from "three";
import {
  ORBIT_R,
  PLANET_R,
  SPACE_FAR,
  SPACE_NEAR,
  clamp,
  damp,
  hashString,
  type Input,
} from "../types";
import type { TrekSystem } from "../galaxy/systems";
import { createPlanet, type Planet } from "./planet";
import { createShip, type Ship } from "./ship";
import { createNebula, createStar, createStarfield, createStreaks, type Star, type Starfield, type Streaks } from "./sky";

export interface SpaceScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ship: Ship;
  /** Swap the whole system out. Safe to call repeatedly. */
  enter(system: TrekSystem): void;
  update(dt: number, input: Input, opts: { warp: number; frozen: boolean }): void;
  /** Distance from the planet's surface, kilometres as the HUD reports them. */
  altitude(): number;
  orbiting(): boolean;
  setOrbit(on: boolean): void;
  /** Chase camera or the view from the bridge. */
  toggleView(): void;
  view: "chase" | "bridge";
  dispose(): void;
}

const MAX_IMPULSE = 420; // units/s at full throttle
const FLOOR = PLANET_R * 1.06;

export function createSpaceScene(canvasAspect: number): SpaceScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x01030a);

  const camera = new THREE.PerspectiveCamera(58, canvasAspect, SPACE_NEAR, SPACE_FAR);

  scene.add(new THREE.AmbientLight(0x2a3648, 0.9));
  // A dim fill from below so the ship's underside is not a silhouette when the
  // star is behind her. One light, permanently present — see the note in the
  // trek README about three recompiling per light count.
  const fill = new THREE.DirectionalLight(0x33507a, 0.35);
  fill.position.set(-1, -0.6, -0.4);
  scene.add(fill);

  const starfield = createStarfield();
  scene.add(starfield.points);

  const streaks = createStreaks();
  scene.add(streaks.lines);

  const ship = createShip();
  scene.add(ship.group);

  let planet: Planet | null = null;
  let star: Star | null = null;
  let nebula: { group: THREE.Group; dispose(): void } | null = null;
  let current: TrekSystem | null = null;

  /* --- ship state --- */
  const pos = new THREE.Vector3(0, PLANET_R * 0.35, ORBIT_R);
  const vel = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  let throttle = 0;
  let orbitLock = true;
  let orbitAngle = 0;
  let view: "chase" | "bridge" = "chase";
  /** 0-1, how far the orbit look-down is blended in. Damped so that taking the
   *  con is a swing rather than a cut. */
  let lookTilt = 1;

  const camPos = new THREE.Vector3().copy(pos);
  const camLook = new THREE.Vector3();

  const fwd = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function enter(system: TrekSystem): void {
    planet?.dispose();
    star?.dispose();
    nebula?.dispose();

    current = system;
    const seed = hashString(system.key);

    // 128 segments, not 96: at 400 km the limb is close enough that 3.75° of
    // arc per quad reads as a visibly faceted horizon.
    planet = createPlanet(system.planet, system.key, 128);
    scene.add(planet.group);

    star = createStar(system.star.class, system.star.kelvin, ((seed % 360) / 360) * Math.PI * 2);
    scene.add(star.group);
    scene.add(star.light);

    nebula = createNebula(system.accent, seed);
    scene.add(nebula.group);

    // Arrive in orbit, on the day side, a little above the equator. Arriving
    // on the night side of a world you have flown eighty light years to see is
    // technically fine and dramatically inert.
    orbitLock = true;
    orbitAngle = Math.atan2(star.direction.z, star.direction.x) - 0.45;
    placeOnOrbit(0);
    camPos.copy(pos).addScaledVector(fwd, -14);
    vel.set(0, 0, 0);
    throttle = 0;
  }

  /** Put the ship on the rail at the current orbit angle, nose along track. */
  function placeOnOrbit(dt: number): void {
    orbitAngle += dt * 0.045;
    const tilt = 0.22;
    pos.set(
      Math.cos(orbitAngle) * ORBIT_R,
      Math.sin(orbitAngle * 1.0) * ORBIT_R * tilt,
      Math.sin(orbitAngle) * ORBIT_R,
    );
    // Along-track heading, keel toward the planet.
    //
    // Build the basis from the *outward* radial as +Y and derive the rest, in
    // three's order: local +X is right, +Y is up, +Z is backward, and
    // `makeBasis` wants exactly that. The first version crossed forward with
    // the *downward* radial and produced a left-handed frame — which flew the
    // ship inverted, and since the chase camera takes its `up` from the same
    // quaternion, it put the planet at the top of every frame and the
    // look-down tilt pushed it further off the screen rather than into it.
    tmpV.set(-Math.sin(orbitAngle), Math.cos(orbitAngle) * tilt, Math.cos(orbitAngle)).normalize();
    const upV = pos.clone().normalize();
    const zAxis = tmpV.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(upV, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    rot.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    fwd.copy(tmpV);
  }

  function update(dt: number, input: Input, opts: { warp: number; frozen: boolean }): void {
    const warp = opts.warp;

    if (!opts.frozen && !input.typing) {
      // Any throttle input drops the rail. That is the whole "take the con"
      // gesture and it needs no key of its own.
      const fwdKey = input.held("w") || input.held("arrowup");
      const backKey = input.held("s") || input.held("arrowdown");
      const stick = input.move.y;
      const wants = (fwdKey ? 1 : 0) - (backKey ? 1 : 0) + stick;
      if (Math.abs(wants) > 0.08) {
        orbitLock = false;
        throttle = clamp(throttle + wants * dt * 1.6, -0.45, 1);
      } else {
        throttle = damp(throttle, 0, 2.2, dt);
      }

      if (!orbitLock) {
        // Look steers. Yaw and pitch are applied in the ship's own frame so
        // that a rolled ship pitches into its own "up", which is the only
        // behaviour that does not feel broken once you are inverted.
        const sens = input.pointerLocked ? 0.0022 : 0.0016;
        const yaw = -input.look.x * sens - (input.held("arrowleft") ? dt * 0.8 : 0) + (input.held("arrowright") ? dt * 0.8 : 0);
        const pitch = -input.look.y * sens;
        const roll =
          (input.held("q") ? 1 : 0) - (input.held("e") ? 1 : 0) + input.move.x * 0.9;

        tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        rot.multiply(tmpQ);
        tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
        rot.multiply(tmpQ);
        tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * dt * 1.5);
        rot.multiply(tmpQ);
        rot.normalize();
      }
    }

    if (orbitLock) {
      placeOnOrbit(opts.frozen ? 0 : dt);
      vel.set(0, 0, 0);
    } else {
      fwd.set(0, 0, -1).applyQuaternion(rot);
      // Thrust plus heavy damping. True Newtonian drift is unflyable with a
      // mouse; this keeps the momentum you can feel and throws away the part
      // that makes people motion-sick.
      vel.addScaledVector(fwd, throttle * MAX_IMPULSE * dt * 2.4);
      vel.multiplyScalar(Math.exp(-1.1 * dt));
      pos.addScaledVector(vel, dt);

      const d = pos.length();
      if (d < FLOOR) {
        // Skim rather than stop: push back out along the radius and kill the
        // inward component of the velocity.
        pos.setLength(FLOOR);
        const n = pos.clone().normalize();
        const into = vel.dot(n);
        if (into < 0) vel.addScaledVector(n, -into);
      }
      if (d > ORBIT_R * 14) pos.setLength(ORBIT_R * 14);
    }

    ship.group.position.copy(pos);
    ship.group.quaternion.copy(rot);
    ship.update(dt, throttle, warp);

    /* --- camera --- */
    fwd.set(0, 0, -1).applyQuaternion(rot);
    if (view === "chase") {
      // On the rail, the camera climbs above the ship and tips down at the
      // planet; under manual conn it drops back to a level chase, because
      // there the player is aiming rather than being shown something.
      //
      // The two numbers are one composition. Camera nine behind and eight
      // above puts the ship 42° below the along-track axis; dropping the
      // look-at 23 units toward the planet aims the view at almost exactly
      // that angle, so the ship sits mid-frame — and the planet's limb, 41°
      // below the track at this orbit, lands just under it and fills the
      // bottom half. Move either one alone and you lose the ship off the top
      // or the planet off the bottom.
      lookTilt = damp(lookTilt, orbitLock ? 1 : 0, 3.2, dt);
      const back = 9 + Math.abs(throttle) * 5 + warp * 8;
      tmpV.copy(pos).addScaledVector(fwd, -back);
      tmpV.addScaledVector(up.set(0, 1, 0).applyQuaternion(rot), 2.8 + 5.2 * lookTilt);
      camPos.lerp(tmpV, 1 - Math.exp(-7 * dt));
      camLook.copy(pos).addScaledVector(fwd, 26);
      if (lookTilt > 0.001) camLook.addScaledVector(pos.clone().normalize(), -23 * lookTilt);
    } else {
      // From the bridge: on the saucer's centreline, just ahead of the dome.
      tmpV.copy(pos).addScaledVector(fwd, -0.55);
      tmpV.addScaledVector(up.set(0, 1, 0).applyQuaternion(rot), 0.2);
      camPos.copy(tmpV);
      camLook.copy(pos).addScaledVector(fwd, 60);
    }
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0).applyQuaternion(rot);
    camera.lookAt(camLook);
    camera.fov = 58 + warp * 26;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // The planet's shaders light in view space, and the view matrix is
    // otherwise only refreshed inside `renderer.render` — which runs *after*
    // this. Left stale, the first frame of every arrival is lit by an identity
    // matrix, which is why the terminator used to flick on the frame after a
    // jump completed.
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    /* --- world --- */
    if (!opts.frozen) planet?.update(dt);
    star?.update(dt, camera);
    if (planet && star) planet.setSun(star.direction, star.tint, camera);
    if (nebula) nebula.group.position.copy(camera.position);
    starfield.update(camera, warp);
    streaks.update(camera, warp, dt);
  }

  return {
    scene,
    camera,
    ship,
    enter,
    update,
    altitude: () => Math.max(0, pos.length() - PLANET_R),
    orbiting: () => orbitLock,
    setOrbit(on) {
      orbitLock = on;
      if (on) {
        // Re-enter the rail at the angle we are actually at, so establishing
        // orbit does not teleport the ship round to the far side.
        orbitAngle = Math.atan2(pos.z, pos.x);
        placeOnOrbit(0);
        vel.set(0, 0, 0);
        throttle = 0;
      }
    },
    get view() {
      return view;
    },
    toggleView() {
      view = view === "chase" ? "bridge" : "chase";
    },
    dispose() {
      planet?.dispose();
      star?.dispose();
      nebula?.dispose();
      starfield.dispose();
      streaks.dispose();
      ship.dispose();
      scene.clear();
      current = null;
      void current;
    },
  };
}
