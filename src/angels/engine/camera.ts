/**
 * Cameras.
 *
 * Five rigs, and each one exists because it answers a question the others
 * cannot:
 *
 *  - **chase** — where am I and what is my jet doing? The default, and the only
 *    view in which formation flying is legible.
 *  - **cockpit** — what can I actually see? Narrow, locked to the airframe,
 *    with the canopy rail in the way. This is the one that makes a low pass
 *    feel fast.
 *  - **wing** — number 2's seat, looking at the leader across three feet of
 *    air. The view the team's own photographs are taken from.
 *  - **tower** — the crowd's view from Genesee Park, on a long lens that keeps
 *    the jet the same size as it goes past. This is what the show looks like
 *    to the people it is for.
 *  - **cinematic** — an automatic director that cuts between the others.
 *
 * The thing every rig shares is that the camera is *behind* the aircraft in
 * time, not glued to it. A rigidly parented camera makes a violent roll look
 * like the world is spinning around a static jet; a lagged one makes it look
 * like the jet rolled. That lag is the single most important number here.
 */
import * as THREE from "three";
import type { AngelsCtx, CameraMode, CameraService, System } from "../types";
import type { FleetService } from "../play/fleet";
import { SHOW_CENTRE, latToZ, lonToX } from "../world/geo";

const ORDER: CameraMode[] = ["chase", "cockpit", "wing", "tower", "cinematic"];

export function createCamera(ctx: AngelsCtx): System {
  const cam = ctx.camera;

  let mode: CameraMode = "chase";
  let trauma = 0;
  let posed: { position: THREE.Vector3; lookAt: THREE.Vector3 } | null = null;

  // Free-look, accumulated from the mouse or a touch drag, springing back.
  let lookYaw = 0;
  let lookPitch = 0;

  // Cinematic director state.
  let shotTime = 0;
  let shotIndex = 0;

  const smoothPos = new THREE.Vector3();
  const smoothLook = new THREE.Vector3();
  let initialised = false;

  // Wreck-cam state: which side of the fireball we ended up on, and whether
  // the shot has been struck yet.
  let wreckPosed = false;
  let wreckAngle = 0;

  /**
   * A crash pegs the shake and *holds* it.
   *
   * `trauma` decays in well under a second, which for an impact reads as a
   * flinch rather than a blow. This keeps it topped up for a second and a half
   * so the camera is still being thrown around while the fireball is climbing.
   */
  let crashShake = 0;

  /** Ground under a point, so the wreck cam never ends up inside a hill. */
  const groundNear = (c: AngelsCtx, p: THREE.Vector3): number => {
    const terrain = c.services.terrain;
    return terrain ? terrain.surfaceAt(p.x, p.z) : 0;
  };

  /**
   * Trauma shake, decaying. Shared by the flying rigs and the wreck cam —
   * being thrown around by your own explosion is most of what sells it.
   */
  function applyShake(c: AngelsCtx, dt: number): void {
    if (crashShake > 0) {
      crashShake = Math.max(0, crashShake - dt);
      trauma = Math.max(trauma, Math.min(1, crashShake / 1.6));
    }
    const amp = trauma * trauma * 1.9;
    if (amp > 0.0005) {
      const t = c.elapsed;
      cam.rotateX(Math.sin(t * 47.3) * amp * 0.026);
      cam.rotateY(Math.sin(t * 39.7 + 1.7) * amp * 0.026);
      cam.rotateZ(Math.sin(t * 53.1 + 3.1) * amp * 0.02);
    }
    trauma = Math.max(0, trauma - dt * 1.5);
  }

  const _desired = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const BODY_FWD = new THREE.Vector3(0, 0, -1);
  const BODY_UP = new THREE.Vector3(0, 1, 0);
  const BODY_RIGHT = new THREE.Vector3(1, 0, 0);

  // The crowd line at Genesee Park, on the west shore looking east across the
  // box. Its height is resolved against the terrain on first use, because the
  // camera system boots before it can ask how tall that bluff is.
  const towerPos = new THREE.Vector3(
    lonToX(SHOW_CENTRE[1]) - 1150,
    24,
    latToZ(SHOW_CENTRE[0]) + 260,
  );
  let towerPlaced = false;

  const service: CameraService = {
    get mode() {
      return mode;
    },
    setMode(next, opts) {
      mode = next;
      shotTime = 0;
      if (opts?.snap) initialised = false;
      ctx.emit("angels:camera", mode);
    },
    cycle() {
      const i = ORDER.indexOf(mode);
      service.setMode(ORDER[(i + 1) % ORDER.length]);
      return mode;
    },
    shake(amount) {
      trauma = Math.min(1, trauma + amount);
    },
    release() {
      posed = null;
      initialised = false;
    },
    pose(position, lookAt) {
      // Accepts anything with x/y/z, not just a Vector3 — the screenshot
      // harness poses the camera from `page.evaluate`, where the Three classes
      // it would need to construct are not in scope.
      posed = posed ?? { position: new THREE.Vector3(), lookAt: new THREE.Vector3() };
      posed.position.set(position.x, position.y, position.z);
      posed.lookAt.set(lookAt.x, lookAt.y, lookAt.z);
    },
  };
  ctx.services.camera = service;

  const offImpact = ctx.on("angels:impact", (v: number) => service.shake(Math.min(0.9, v * 0.5)));
  const offCrash = ctx.on("angels:crash", () => {
    service.shake(1);
    crashShake = 1.6;
  });

  return {
    lateUpdate(dt, c) {
      const fleet = c.services.fleet as FleetService | undefined;
      if (!fleet) return;

      if (posed) {
        cam.position.copy(posed.position);
        cam.lookAt(posed.lookAt);
        return;
      }

      // ---- the wreck cam ----------------------------------------------------
      // The rig you were flying is chase, which is anchored to a jet that no
      // longer exists — it would sit exactly where the fireball is and show
      // you the inside of it. So the camera steps back and watches, drifting
      // sideways and rising, which is both the only way to actually see what
      // you did and the shot every crash in every film is framed as.
      const wreck = fleet.wreck;
      if (wreck?.active) {
        const t = wreck.timer;
        if (!wreckPosed) {
          // Which side to watch from, decided before the shot is framed: the
          // side the chase camera was already on, so the cut does not jump the
          // line. Computing the frame first and *then* picking the angle put
          // the snap on the previous shot's bearing, which is a cut to a
          // camera that then slid sideways for three seconds.
          wreckPosed = true;
          wreckAngle = Math.atan2(cam.position.x - wreck.position.x, cam.position.z - wreck.position.z);
        }
        const ang = wreckAngle + t * 0.24;
        // Far enough back to hold a hundred-metre fireball in frame. The first
        // version stood off seventy metres and put the camera inside it.
        // Portrait is a narrow window with a narrower field of view, so the
        // same standoff puts the fireball through both edges of the frame.
        const back = (205 + t * 9) * (c.viewport.portrait ? 1.4 : 1);
        _desired.set(
          wreck.position.x + Math.sin(ang) * back,
          Math.max(wreck.position.y, groundNear(c, wreck.position)) + 40 + t * 7,
          wreck.position.z + Math.cos(ang) * back,
        );
        _look.copy(wreck.position);
        _look.y += 14 + t * 7;
        if (t <= 0) {
          // Snap on the first frame: easing into the shot from wherever the
          // chase camera happened to be means the first half second of the
          // explosion is spent flying through it.
          smoothPos.copy(_desired);
          smoothLook.copy(_look);
        }
        const k = 1 - Math.exp(-2.4 * dt);
        smoothPos.lerp(_desired, k);
        smoothLook.lerp(_look, k);
        cam.position.copy(smoothPos);
        cam.up.set(0, 1, 0);
        cam.lookAt(smoothLook);
        applyShake(c, dt);
        return;
      }
      if (wreckPosed) {
        // Coming back: the next frame is a fresh jet somewhere else entirely,
        // and a camera that lerps to it draws a line across the whole map.
        wreckPosed = false;
        initialised = false;
      }

      if (c.input.viewPressed) service.cycle();

      const player = fleet.player;
      const s = player.state;
      _fwd.copy(BODY_FWD).applyQuaternion(s.orientation);
      _up.copy(BODY_UP).applyQuaternion(s.orientation);
      _right.copy(BODY_RIGHT).applyQuaternion(s.orientation);

      // Free look decays back to centre — you always end up looking forward.
      lookYaw = (lookYaw + c.input.lookX) * Math.pow(0.06, dt);
      lookPitch = THREE.MathUtils.clamp(
        (lookPitch + c.input.lookY) * Math.pow(0.06, dt),
        -1.1,
        1.1,
      );

      let effectiveMode = mode;
      if (mode === "cinematic") {
        shotTime += dt;
        const SHOT = 7.5;
        if (shotTime > SHOT) {
          shotTime = 0;
          shotIndex++;
        }
        effectiveMode = (["chase", "tower", "wing", "cockpit"] as CameraMode[])[shotIndex % 4];
      }

      let lag = 6;
      let fov = c.viewport.portrait ? 62 : 70;

      switch (effectiveMode) {
        case "cockpit": {
          // Eye point: forward of the wing, up under the canopy.
          _desired
            .copy(s.position)
            .addScaledVector(_fwd, player.spec.length * 0.22)
            .addScaledVector(_up, player.spec.height * 0.34);
          _look.copy(_desired).addScaledVector(_fwd, 100);
          // Narrow, because a real canopy is narrow and the sense of speed
          // comes from the edges of the frame moving, not from the middle.
          fov = c.viewport.portrait ? 68 : 78;
          lag = 40; // effectively rigid — this seat is bolted to the jet
          break;
        }

        case "wing": {
          // Over number two's shoulder at the leader — the angle every
          // photograph of this team is taken from.
          //
          // Not from inside number two's cockpit, which is where this started:
          // an eye point on the wingman puts its own nose across most of the
          // frame, because the leader is only three metres ahead and the
          // wingman is eighteen metres long. Sit behind and above it instead,
          // and both jets are in shot.
          const wing = fleet.wingmen[0] ?? player;
          const ws = wing.state;
          _q.copy(ws.orientation);
          _desired
            .copy(ws.position)
            .add(
              _tmp
                .set(wing.spec.wingspan * 1.4, wing.spec.height * 2.2, wing.spec.length * 2.2)
                .applyQuaternion(_q),
            );
          // Aim between the two jets so neither sits on the edge of frame.
          _look.copy(s.position).lerp(ws.position, 0.3);
          fov = 52;
          lag = 14;
          break;
        }

        case "tower": {
          if (!towerPlaced) {
            const t = c.services.terrain as { surfaceAt(x: number, z: number): number } | undefined;
            if (t) towerPos.y = t.surfaceAt(towerPos.x, towerPos.z) + 14;
            towerPlaced = true;
          }
          _desired.copy(towerPos);
          _look.copy(s.position);
          // A long lens that holds the jet at a constant size — which is what
          // a photographer at an air show is doing all afternoon.
          const range = towerPos.distanceTo(s.position);
          fov = THREE.MathUtils.clamp((260 / Math.max(range, 120)) * 26, 3.5, 44);
          lag = 9;
          break;
        }

        default: {
          // Chase. The camera sits behind the jet's *velocity*, not its nose,
          // so at high alpha you see the belly and the jet visibly flies at an
          // angle to where it points. That one detail is most of the realism.
          const speed = Math.max(s.airspeed, 40);
          // Far enough back that the whole formation fits, not just the
          // leader. Thirty metres behind an eighteen-metre jet crops its own
          // tail, and the four jets flying off it are out of frame entirely.
          const back = 24 + player.spec.length * 0.95 + speed * 0.05;
          _tmp.copy(s.velocity).normalize();
          if (_tmp.lengthSq() < 0.5) _tmp.copy(_fwd);
          // Blend between the velocity vector and the nose, so the camera does
          // not swing wildly when the jet is nearly stationary.
          _tmp.lerp(_fwd, 0.35).normalize();

          _desired
            .copy(s.position)
            .addScaledVector(_tmp, -back)
            // High enough to read the formation's shape. From dead astern and
            // level, a diamond is a clump.
            .addScaledVector(_up, 6.5 + player.spec.height * 0.7);
          _look.copy(s.position).addScaledVector(_fwd, 14);
          // Widen with speed. Ten degrees of FOV between a slow pass and a
          // burner run is worth more than any post effect.
          fov = (c.viewport.portrait ? 60 : 68) + THREE.MathUtils.clamp((speed - 120) * 0.035, 0, 12);
          lag = 4.5;
          break;
        }
      }

      // Never let the camera end up underground or under the lake. A chase cam
      // that clips into a hillside during a low pass is the fastest way to
      // break the illusion at exactly the moment it matters most.
      const terrain = c.services.terrain as { surfaceAt(x: number, z: number): number } | undefined;
      if (terrain) {
        const floor = terrain.surfaceAt(_desired.x, _desired.z) + 3.5;
        if (_desired.y < floor) _desired.y = floor;
      }

      if (!initialised) {
        smoothPos.copy(_desired);
        smoothLook.copy(_look);
        initialised = true;
      } else {
        // Ride along with the jet *first*, then correct what is left.
        //
        // A first-order filter chasing a moving target trails it by v·tau for
        // ever — at 270 m/s and a 0.22 s time constant that is sixty metres of
        // permanent extra distance, so the faster you flew the smaller your
        // own aeroplane got. Feeding the velocity forward removes the ramp
        // error entirely and leaves the smoothing to do what it is for, which
        // is absorbing attitude changes.
        smoothPos.addScaledVector(s.velocity, dt);
        smoothLook.addScaledVector(s.velocity, dt);
        const k = 1 - Math.exp(-lag * dt);
        smoothPos.lerp(_desired, k);
        smoothLook.lerp(_look, Math.min(1, k * 1.6));
      }

      cam.position.copy(smoothPos);
      cam.lookAt(smoothLook);

      // Free look is applied after the base aim, so it is a head turn rather
      // than a change of rig.
      if (Math.abs(lookYaw) > 1e-4 || Math.abs(lookPitch) > 1e-4) {
        cam.rotateY(-lookYaw);
        cam.rotateX(-lookPitch);
      }

      // Roll the frame with the jet in cockpit and wing views. Without it the
      // horizon stays level and the aircraft appears to be the thing standing
      // still while the world tips — which is exactly backwards.
      if (effectiveMode === "cockpit" || effectiveMode === "wing") {
        const ref = effectiveMode === "cockpit" ? s.orientation : (fleet.wingmen[0] ?? player).state.orientation;
        _tmp.copy(BODY_UP).applyQuaternion(ref);
        cam.up.copy(_tmp);
        cam.lookAt(smoothLook);
        cam.up.set(0, 1, 0);
      }

      // Airframe buffet: growing with dynamic pressure, and much worse when
      // the wing is separated. You feel a stall before you read it.
      const buffet = s.stalled ? 0.5 : Math.max(0, s.liftDemand - 0.82) * 1.4;
      const q = Math.min(1, s.airspeed / 340);
      const buffetAmp = buffet * 0.5 * q;
      if (buffetAmp > 0.0005) {
        const t = c.elapsed;
        cam.rotateX(Math.sin(t * 61.7) * buffetAmp * 0.02);
        cam.rotateY(Math.sin(t * 44.3 + 0.9) * buffetAmp * 0.02);
      }
      applyShake(c, dt);

      if (Math.abs(cam.fov - fov) > 0.05) {
        cam.fov += (fov - cam.fov) * Math.min(1, dt * 5);
        cam.updateProjectionMatrix();
      }
    },

    dispose() {
      offImpact();
      offCrash();
      if (ctx.services.camera === service) delete ctx.services.camera;
    },
  };
}
