/**
 * moonGolf — kick-golf on the lunar landing pad.
 *
 * No clubs, no new controls: RUN INTO THE BALL to whack it. Your speed
 * and direction become the shot. Lunar gravity (about a sixth of the
 * island's) turns every kick into a glorious slow-motion arc. Sink the
 * ball in the glowing hole across the pad in as few kicks as you can.
 *
 * The module owns the ball physics; City feeds it the player's live
 * position/velocity each tick and pays out on onSink(strokes).
 */
import * as THREE from "three";

const MOON_G = 4.5; // m/s² — floaty, but the ball still comes home
const KICK_RANGE = 1.4;
const MIN_KICK_SPEED = 1.8;
const SINK_RADIUS = 1.05;

export interface MoonGolf {
  group: THREE.Group;
  update(dt: number, now: number, playerPos: THREE.Vector3, playerVel: THREE.Vector3): void;
  /** One-line HUD status, or null when the player is far from the pad. */
  hudLine(playerPos: THREE.Vector3): string | null;
  onSink: ((strokes: number) => void) | null;
  onKick: ((strokes: number) => void) | null;
  onOut: (() => void) | null;
}

export function buildMoonGolf(opts: {
  cx: number;
  cz: number;
  topY: number;
  padHalf: number;
}): MoonGolf {
  const { cx, cz, topY, padHalf } = opts;
  const group = new THREE.Group();

  const TEE = new THREE.Vector3(cx - padHalf + 3.5, topY + 0.35, cz - padHalf + 3.5);
  const HOLE = new THREE.Vector3(cx + padHalf - 4, topY, cz + padHalf - 4);

  // Tee mat.
  const tee = new THREE.Mesh(
    new THREE.CircleGeometry(1.3, 20),
    new THREE.MeshStandardMaterial({ color: "#3fae63", roughness: 0.85 }),
  );
  tee.rotation.x = -Math.PI / 2;
  tee.position.set(TEE.x, topY + 0.03, TEE.z);
  group.add(tee);

  // The hole: dark disc + pulsing ring + flag.
  const holeDisc = new THREE.Mesh(
    new THREE.CircleGeometry(SINK_RADIUS, 20),
    new THREE.MeshBasicMaterial({ color: "#05070c" }),
  );
  holeDisc.rotation.x = -Math.PI / 2;
  holeDisc.position.set(HOLE.x, topY + 0.035, HOLE.z);
  group.add(holeDisc);
  const holeRingMat = new THREE.MeshBasicMaterial({
    color: "#ffd166", transparent: true, opacity: 0.75,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const holeRing = new THREE.Mesh(new THREE.RingGeometry(SINK_RADIUS, SINK_RADIUS + 0.28, 24), holeRingMat);
  holeRing.rotation.x = -Math.PI / 2;
  holeRing.position.set(HOLE.x, topY + 0.045, HOLE.z);
  group.add(holeRing);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8),
    new THREE.MeshStandardMaterial({ color: "#e8e8f0", roughness: 0.5 }),
  );
  pole.position.set(HOLE.x, topY + 1.3, HOLE.z);
  group.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.6),
    new THREE.MeshBasicMaterial({ color: "#e04444", side: THREE.DoubleSide }),
  );
  flag.position.set(HOLE.x + 0.55, topY + 2.25, HOLE.z);
  group.add(flag);

  // The ball.
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 14, 12),
    new THREE.MeshStandardMaterial({ color: "#f4f6ff", roughness: 0.35, metalness: 0.05 }),
  );
  ball.position.copy(TEE);
  group.add(ball);
  const ballGlow = new THREE.PointLight(0xbfe0ff, 4, 6, 2);
  ballGlow.position.copy(TEE);
  group.add(ballGlow);

  const vel = new THREE.Vector3();
  let strokes = 0;
  let kickCooldown = 0;
  let sunkUntil = 0; // hide/celebrate window after a sink

  const api: MoonGolf = {
    group,
    onSink: null,
    onKick: null,
    onOut: null,
    hudLine(playerPos) {
      const near =
        Math.abs(playerPos.x - cx) < padHalf + 8 &&
        Math.abs(playerPos.z - cz) < padHalf + 8 &&
        Math.abs(playerPos.y - topY) < 20;
      if (!near) return null;
      if (strokes === 0) return "⛳ MOON GOLF · run into the ball to tee off";
      return `⛳ MOON GOLF · stroke ${strokes} — sink the glowing hole`;
    },
    update(dt, now, playerPos, playerVel) {
      holeRingMat.opacity = 0.5 + Math.sin(now * 0.004) * 0.3;
      flag.rotation.y = Math.sin(now * 0.002) * 0.35;
      if (kickCooldown > 0) kickCooldown -= dt;

      if (sunkUntil > 0) {
        if (now >= sunkUntil) {
          sunkUntil = 0;
          strokes = 0;
          ball.visible = true;
          ball.position.copy(TEE);
          vel.set(0, 0, 0);
        }
        return;
      }

      // Kick: your run becomes the club.
      const hSpeed = Math.hypot(playerVel.x, playerVel.z);
      if (
        kickCooldown <= 0 &&
        hSpeed > MIN_KICK_SPEED &&
        playerPos.distanceTo(ball.position) < KICK_RANGE
      ) {
        const dir = new THREE.Vector3(
          ball.position.x - playerPos.x,
          0,
          ball.position.z - playerPos.z,
        );
        if (dir.lengthSq() < 0.001) dir.set(playerVel.x, 0, playerVel.z);
        dir.normalize();
        vel.x = dir.x * (4 + hSpeed * 1.5);
        vel.z = dir.z * (4 + hSpeed * 1.5);
        vel.y = 1.6 + hSpeed * 0.5;
        strokes++;
        kickCooldown = 0.5;
        api.onKick?.(strokes);
      }

      // Lunar flight.
      vel.y -= MOON_G * dt;
      ball.position.x += vel.x * dt;
      ball.position.y += vel.y * dt;
      ball.position.z += vel.z * dt;
      const onPad =
        Math.abs(ball.position.x - cx) <= padHalf + 0.4 &&
        Math.abs(ball.position.z - cz) <= padHalf + 0.4;
      const groundY = onPad ? topY + 0.34 : -Infinity;
      if (ball.position.y <= groundY && vel.y <= 0) {
        ball.position.y = groundY;
        if (vel.y < -1.2) {
          vel.y = -vel.y * 0.42; // moon bounce
        } else {
          vel.y = 0;
          const roll = Math.pow(0.35, dt);
          vel.x *= roll;
          vel.z *= roll;
        }
      }
      // Rolled off the pad → lost to the void, back to the tee.
      if (ball.position.y < topY - 40) {
        ball.position.copy(TEE);
        vel.set(0, 0, 0);
        strokes++; // penalty stroke
        api.onOut?.();
      }
      // Sink check: on the ground, over the hole, not screaming past.
      const dHole = Math.hypot(ball.position.x - HOLE.x, ball.position.z - HOLE.z);
      const speed = vel.length();
      if (dHole < SINK_RADIUS && ball.position.y <= topY + 0.4 && speed < 11) {
        ball.visible = false;
        sunkUntil = now + 2600;
        api.onSink?.(strokes);
      }
      ballGlow.position.copy(ball.position);
    },
  };
  return api;
}
