/**
 * Vibe Kart — integration, walls and kart-on-kart contact.
 *
 * Two rules drive everything here:
 *
 * 1. **A kart never ends a step inside geometry.** The position integration is
 *    substepped whenever a step would move further than `substepDistance`, and
 *    the wall query runs inside the substep loop. `track.wallAt` is analytic,
 *    so resolving a contact is a projection rather than a search: push out
 *    along the normal by the reported depth and the penetration is gone, this
 *    step, exactly. No iteration, no jitter, no karts wedged in a barrier.
 *
 * 2. **Impacts cost you what they should.** A glancing scrape along a wall
 *    barely slows you — that is the racing line at Sunset Bluff. A head-on hit
 *    takes almost everything. The difference is the sine of the impact angle,
 *    squared, so the penalty curve is gentle where players live and brutal
 *    where they made a mistake.
 */
import * as THREE from "three";
import { TUNING, type TrackService } from "../types";
import { clamp, clamp01, finite } from "./math";
import { PHYS } from "./tuning";
import type { Sim } from "./state";
import type { DriveWorld } from "./drive";

export interface SimWorld extends DriveWorld {
  track: TrackService | undefined;
  applyHit(sim: Sim, kind: "spin" | "squash" | "shock" | "bump", seconds?: number): void;
}

const delta = new THREE.Vector3();
const normal = new THREE.Vector3();
const tangent = new THREE.Vector3();

/**
 * Advance position, resolving walls as we go. Kept separate from the force
 * integration so the substep loop stays cheap: forces are computed once per
 * fixed step, only the sweep is subdivided.
 */
export function integrate(sim: Sim, world: SimWorld, dt: number): void {
  const r = sim.racer;
  if (!finite(r.velocity)) r.velocity.set(0, 0, 0);

  const speed = r.velocity.length();
  const steps = clamp(Math.ceil((speed * dt) / PHYS.substepDistance), 1, PHYS.maxSubsteps);
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    r.position.addScaledVector(r.velocity, h);
    resolveWall(sim, world);
  }
}

function resolveWall(sim: Sim, world: SimWorld): void {
  const track = world.track;
  if (!track) return;
  const r = sim.racer;
  const hit = track.wallAt(r.position, TUNING.collisionRadius, sim.hint);
  if (!hit) return;
  // A "contact" a metre and a half deep is not a contact — the kart is outside
  // the course entirely, and snapping it back in would teleport a racer who is
  // about to be respawned properly.
  if (hit.depth > TUNING.collisionRadius * 1.7) return;

  r.position.addScaledVector(hit.normal, hit.depth + 1e-3);

  const vn = r.velocity.dot(hit.normal);
  if (vn >= 0) return;

  const speed = r.velocity.length();
  const sinA = clamp01(-vn / Math.max(0.05, speed));
  const restitution = hit.solid ? PHYS.wallRestitutionSolid : PHYS.wallRestitutionSoft;

  // Kill the approach and bounce a little of it back.
  r.velocity.addScaledVector(hit.normal, -vn * (1 + restitution));

  // Then scrub what is left along the wall by how square the hit was.
  const scrub = PHYS.wallScrub * sinA * sinA * (hit.solid ? 1 : 0.6);
  if (scrub > 0.001) {
    tangent.copy(r.velocity).addScaledVector(hit.normal, -r.velocity.dot(hit.normal));
    r.velocity.addScaledVector(tangent, -clamp01(scrub));
  }

  const impact = -vn;
  if (impact > PHYS.wallEventSpeed && sim.wallCooldown <= 0) {
    sim.wallCooldown = PHYS.wallEventGap;
    world.emit("kart:hit", { racer: r.id, by: "wall", spin: false });
    // Slamming a barrier squarely also ends any drift you were holding.
    if (sinA > 0.5 && hit.solid) world.applyHit(sim, "bump", PHYS.bumpTime);
  }
}

// ---------------------------------------------------------------------------
// Kart on kart
// ---------------------------------------------------------------------------

/**
 * Weighted sphere impulses over the whole field. Eight racers is 28 pairs a
 * step, which at 120 Hz is nothing — no broadphase needed, and a brute-force
 * loop is deterministic in a way a spatial hash quietly is not.
 */
export function resolveKartPairs(sims: Sim[], world: SimWorld, pairClock: Float32Array, dt: number): void {
  const n = sims.length;
  const minDist = TUNING.collisionRadius * 2;
  const minSq = minDist * minDist;

  for (let i = 0; i < pairClock.length; i++) {
    if (pairClock[i] > 0) pairClock[i] = Math.max(0, pairClock[i] - dt);
  }

  for (let i = 0; i < n; i++) {
    const a = sims[i];
    if (a.racer.respawning) continue;
    for (let j = i + 1; j < n; j++) {
      const b = sims[j];
      if (b.racer.respawning) continue;

      delta.subVectors(b.racer.position, a.racer.position);
      // Karts bump, they do not climb over each other: flattening the vertical
      // term keeps a kart landing on a rival from being launched into orbit.
      delta.y *= PHYS.contactFlatten;
      const distSq = delta.lengthSq();
      if (distSq >= minSq) continue;

      const dist = Math.sqrt(Math.max(1e-6, distSq));
      normal.copy(delta).multiplyScalar(1 / dist);

      const ma = a.stats.mass;
      const mb = b.stats.mass;
      const wa = 1 / ma;
      const wb = 1 / mb;
      const wsum = wa + wb;

      // De-overlap, weighted — the feather gets shoved, the heavy barely moves.
      const push = (minDist - dist) * PHYS.separationBias;
      a.racer.position.addScaledVector(normal, (-push * wa) / wsum);
      b.racer.position.addScaledVector(normal, (push * wb) / wsum);

      const rel = normal.dot(delta.subVectors(b.racer.velocity, a.racer.velocity));
      if (rel < 0) {
        const impulse = (-(1 + PHYS.kartRestitution) * rel) / wsum;
        a.racer.velocity.addScaledVector(normal, -impulse * wa);
        b.racer.velocity.addScaledVector(normal, impulse * wb);

        // A cruiser leaning on a feather should visibly move it, even at a
        // closing speed of nearly nothing. This is the "weight class matters"
        // term, and it is what makes the heavies worth picking.
        const bias = (mb - ma) / (ma + mb);
        if (bias > 0.02) a.racer.velocity.addScaledVector(normal, -PHYS.kartShove * bias * dt * 12);
        else if (bias < -0.02) b.racer.velocity.addScaledVector(normal, -PHYS.kartShove * bias * dt * 12);

        // Reported in m/s of velocity change on the lighter kart, which is the
        // number a spark emitter or a rumble curve actually wants.
        const felt = impulse * Math.max(wa, wb);
        const key = i * n + j;
        if (felt > PHYS.collideEventImpulse && pairClock[key] <= 0) {
          pairClock[key] = PHYS.collideEventGap;
          world.emit("kart:collide", { a: a.racer.id, b: b.racer.id, impulse: felt });
        }
      }

      // Star power turns a bump into a spin-out.
      const aStar = a.racer.star > 0;
      const bStar = b.racer.star > 0;
      if (aStar !== bStar) {
        const victim = aStar ? b : a;
        if (victim.racer.invuln <= 0 && victim.racer.star <= 0) {
          world.emit("kart:hit", { racer: victim.racer.id, by: "star", spin: true });
          world.applyHit(victim, "spin");
        }
      }
    }
  }
}
