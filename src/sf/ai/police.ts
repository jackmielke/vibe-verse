/**
 * ai/police.ts — the escalating response.
 *
 * The heat system decides *how much* trouble you are in; this decides what that
 * trouble looks like on the street. Five stages, each of which adds a new
 * silhouette rather than just more of the last one, because "the same cop, but
 * eight of him" is not escalation — it is a difficulty slider.
 *
 *   1  Two patrol cars. Sirens, a pair of officers with sidearms, cautious.
 *   2  More units, and *roadblocks*: cruisers parked nose-to-nose across the
 *      approaches to the search area, with officers behind them. The first
 *      stage where the map starts closing.
 *   3  SWAT vans. Squads with SMGs who actually flank, use the vans as cover,
 *      and do not back off when you shoot at them.
 *   4  Air support. A helicopter orbiting the search area with a searchlight
 *      that *is* the perception model — if the light is on you and the line is
 *      clear, they can see you, and the search circle stays pinned.
 *   5  The Guard. APCs and soldiers with rifles and grenades, and a cordon that
 *      does not care about traffic lights.
 *
 * Everything spawns *outside* your view and *converges*, never appears in front
 * of you. Everything despawns politely when heat falls. And every ground unit
 * is an ordinary `enemyForce` soldier with a police loadout, so the whole
 * utility AI — cover, flanking, suppression, reinforcement calls — applies to
 * the response without a second implementation.
 *
 * Public API
 * ----------
 *   police.update(dt, now, px, py, pz)
 *   police.render(heliBatch)
 *   police.reset()
 */
import { frame, useSfStore } from "../state/store";
import { makeRng, type Rng } from "../math/rng";
import { losPool, makeRayHit, raycast } from "../physics/raycast";
import { isPhysicsReady } from "../physics/world";
import { isWater } from "../geo/sfGeo";
import { roadNetwork, roadSurface } from "../world/street/roadNetwork";
import { enemyForce, type Enemy } from "./enemies";
import { heat } from "./heat";
import { navGraph } from "./navigation";
import { emitNoise } from "./perception";
import { trafficSim, type TrafficVehicle } from "./traffic";
import type { HelicopterBatch } from "./vehicleMeshes";
import { PLAYER_ENTITY_ID, losKey, type CharacterArchetype, type Faction } from "./types";

/* ================================================================== *
 * The response plan
 * ================================================================== */

interface ResponseTier {
  /** Ground units on foot. */
  footUnits: number;
  /** Squad size the foot units are grouped into. */
  squadSize: number;
  archetype: CharacterArchetype;
  loadout: "sidearm" | "smg" | "rifle" | "lmg";
  faction: Faction;
  /** Pursuing cruisers with sirens. */
  cruisers: number;
  /** Roadblock positions to establish. */
  roadblocks: number;
  helicopters: number;
  /** Armour on the street. */
  apcs: number;
  /** Seconds between waves. */
  waveInterval: number;
  /** Radius the response spawns at, metres. */
  spawnRadius: number;
}

const TIERS: ResponseTier[] = [
  // Level 0 — nothing.
  {
    footUnits: 0,
    squadSize: 2,
    archetype: "cop",
    loadout: "sidearm",
    faction: "police",
    cruisers: 0,
    roadblocks: 0,
    helicopters: 0,
    apcs: 0,
    waveInterval: 999,
    spawnRadius: 0,
  },
  {
    footUnits: 2,
    squadSize: 2,
    archetype: "cop",
    loadout: "sidearm",
    faction: "police",
    cruisers: 2,
    roadblocks: 0,
    helicopters: 0,
    apcs: 0,
    waveInterval: 16,
    spawnRadius: 150,
  },
  {
    footUnits: 6,
    squadSize: 3,
    archetype: "cop",
    loadout: "smg",
    faction: "police",
    cruisers: 4,
    roadblocks: 2,
    helicopters: 0,
    apcs: 0,
    waveInterval: 13,
    spawnRadius: 190,
  },
  {
    footUnits: 10,
    squadSize: 4,
    archetype: "swat",
    loadout: "smg",
    faction: "police",
    cruisers: 4,
    roadblocks: 3,
    helicopters: 0,
    apcs: 0,
    waveInterval: 11,
    spawnRadius: 210,
  },
  {
    footUnits: 14,
    squadSize: 4,
    archetype: "swat",
    loadout: "rifle",
    faction: "police",
    cruisers: 5,
    roadblocks: 3,
    helicopters: 1,
    apcs: 0,
    waveInterval: 10,
    spawnRadius: 230,
  },
  {
    footUnits: 18,
    squadSize: 5,
    archetype: "soldier",
    loadout: "rifle",
    faction: "military",
    cruisers: 4,
    roadblocks: 4,
    helicopters: 2,
    apcs: 2,
    waveInterval: 9,
    spawnRadius: 260,
  },
];

/* ================================================================== *
 * Air support
 * ================================================================== */

interface Helicopter {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  rotor: number;
  /** Orbit parameters around the search centre. */
  orbit: number;
  orbitRadius: number;
  altitude: number;
  /** 0..1 searchlight intensity. */
  light: number;
  /** Sim time it should leave. */
  leaveAt: number;
  alive: boolean;
}

/* ================================================================== *
 * The system
 * ================================================================== */

const _hit = makeRayHit();

class PoliceResponse {
  private rng: Rng = makeRng("sf-police");
  /** Units this system owns, so it can clean up its own mess. */
  private units = new Set<number>();
  private vehicles = new Set<number>();
  private helis: Helicopter[] = [];
  private blockades: { x: number; z: number; time: number }[] = [];

  private nextWave = 0;
  private nextBlockade = 0;
  private lastLevel = 0;
  private heliNoise = 0;

  stats = { units: 0, cruisers: 0, helis: 0, roadblocks: 0 };

  reset(): void {
    for (const id of this.units) enemyForce.despawn(id);
    for (const id of this.vehicles) trafficSim.despawn(id);
    this.units.clear();
    this.vehicles.clear();
    this.helis.length = 0;
    this.blockades.length = 0;
    this.nextWave = 0;
    this.lastLevel = 0;
    this.rng = makeRng("sf-police");
  }

  /* ---------------- main tick ---------------- */

  /**
   * Publish this frame's sightings into the heat system.
   *
   * Split out of `update` and called *between* the enemies' perception pass and
   * `heat.update` — heat consumes and then clears its `seen` flag, so reporting
   * after it would always be a frame late, and a frame late is exactly enough
   * for the search circle to twitch while a cop is looking straight at you.
   */
  observe(now: number, px: number, pz: number): void {
    this.reportSightings(now, px, pz);
  }

  update(dt: number, now: number, px: number, py: number, pz: number): void {
    const level = heat.level;

    if (level !== this.lastLevel) {
      this.onLevelChange(this.lastLevel, level, now, px, pz);
      this.lastLevel = level;
    }

    if (level === 0) {
      this.standDown(dt, now);
      this.updateHelis(dt, now, px, py, pz);
      this.pruneDead();
      return;
    }

    const tier = TIERS[Math.min(level, TIERS.length - 1)];

    // Waves converge on the *search* estimate, not on the player. That single
    // choice is the difference between a manhunt and a homing missile.
    if (now >= this.nextWave) {
      this.nextWave = now + tier.waveInterval;
      this.dispatchWave(tier, now, px, pz);
    }

    if (tier.roadblocks > 0 && now >= this.nextBlockade) {
      this.nextBlockade = now + 9;
      this.establishRoadblock(tier, now, px, pz);
    }

    this.maintainHelis(tier, now);
    this.updateHelis(dt, now, px, py, pz);
    this.steerCruisers(dt, now);
    this.pruneDead();

    // Distant sirens, so the response is audible before it is visible.
    this.heliNoise -= dt;
    if (this.heliNoise <= 0) {
      this.heliNoise = 2.6;
      heat.ambientSiren(now, heat.searchX, heat.searchZ);
    }

    this.stats.units = this.units.size;
    this.stats.cruisers = this.vehicles.size;
    this.stats.helis = this.helis.length;
    this.stats.roadblocks = this.blockades.length;
  }

  /** Any police/military unit with confirmed contact keeps the search pinned. */
  private reportSightings(now: number, px: number, pz: number): void {
    for (const e of enemyForce.enemies) {
      if (!e.alive) continue;
      if (e.faction !== "police" && e.faction !== "military") continue;
      if (!e.hasContact) continue;
      heat.notifySeen(px, pz, now);
      return;
    }
  }

  private onLevelChange(from: number, to: number, now: number, px: number, pz: number): void {
    if (to > from) {
      // A new tier arrives immediately; waiting a full wave interval after the
      // level-up notification makes the escalation feel disconnected from it.
      this.nextWave = now + 1.5;
      this.nextBlockade = now + 3;
      if (to >= 3) {
        useSfStore.getState().notify("Tactical units inbound", "damage");
      }
    }
  }

  /* ---------------- dispatch ---------------- */

  private dispatchWave(tier: ResponseTier, now: number, px: number, pz: number): void {
    const cx = heat.searchX;
    const cz = heat.searchZ;

    // Foot units, in squads, arriving from a direction the player is not
    // looking at where possible.
    const wantFoot = tier.footUnits - this.liveFootUnits();
    if (wantFoot > 0) {
      const size = Math.min(tier.squadSize, wantFoot);
      const p = this.pickApproach(cx, cz, tier.spawnRadius, px, pz);
      if (p) {
        const squad = enemyForce.spawnSquad(
          p.x,
          p.z,
          size,
          tier.faction,
          tier.archetype,
          tier.loadout,
          now,
        );
        if (squad) {
          for (const m of squad.members) {
            this.units.add(m.id);
            // They arrive already knowing roughly where to look.
            m.lkX = cx;
            m.lkZ = cz;
            m.lkValid = true;
            m.suspicion = 0.9;
            m.calledIn = true; // already the response; do not call for itself
          }
          squad.share(cx, cz, now);
        }
      }
    }

    // Pursuit cruisers.
    const wantCars = tier.cruisers - this.liveCruisers();
    if (wantCars > 0) {
      const p = this.pickApproach(cx, cz, tier.spawnRadius * 1.25, px, pz);
      if (p) {
        const kind =
          tier.faction === "military" ? "apc" : this.rng.chance(0.3) && heat.level >= 3 ? "swatvan" : "police";
        const v = trafficSim.spawnAt(kind, p.x, p.z, now, cx, cz);
        if (v) {
          v.sirenOn = true;
          v.desiredSpeed = v.spec.desiredSpeed * 1.25;
          this.vehicles.add(v.id);
        }
      }
    }

    // Armour, at the top of the ladder.
    if (tier.apcs > 0 && this.rng.chance(0.5)) {
      const p = this.pickApproach(cx, cz, tier.spawnRadius * 1.4, px, pz);
      if (p) {
        const v = trafficSim.spawnAt("apc", p.x, p.z, now, cx, cz);
        if (v) {
          v.sirenOn = true;
          this.vehicles.add(v.id);
        }
      }
    }
  }

  /**
   * A spawn point on a real street at roughly `radius` from the search centre,
   * preferring bearings the player is not currently facing. Never in water,
   * never within 60 m of the player.
   */
  private pickApproach(
    cx: number,
    cz: number,
    radius: number,
    px: number,
    pz: number,
  ): { x: number; z: number } | null {
    const facing = Math.atan2(frame.forward.z, frame.forward.x);
    for (let i = 0; i < 10; i++) {
      // Bias away from the view direction, but not exclusively — being flanked
      // from where you were looking a second ago is fair.
      const a = facing + Math.PI + (this.rng.next() - 0.5) * 2.6;
      const r = radius * (0.75 + this.rng.next() * 0.5);
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (isWater(x, z)) continue;
      if (Math.hypot(x - px, z - pz) < 60) continue;
      navGraph.ensure(x, z, 180);
      const hit = roadNetwork.nearestEdge(x, z, 80);
      if (!hit) continue;
      // Snap onto the carriageway. Without this the sample can be up to 80 m
      // off the street, which puts a squad inside a Victorian's front room.
      const sp = roadSurface(hit.edge, hit.s, 0);
      return { x: sp.x, z: sp.z };
    }
    return null;
  }

  /**
   * Park two cruisers nose-to-nose across a street on the far side of the
   * search area, with a squad behind them. A roadblock the player can simply
   * drive round is not a roadblock, so they go on the *arterials* first.
   */
  private establishRoadblock(tier: ResponseTier, now: number, px: number, pz: number): void {
    if (this.blockades.length >= tier.roadblocks) return;
    const cx = heat.searchX;
    const cz = heat.searchZ;
    const radius = Math.max(90, heat.searchRadius * 0.9);

    for (let i = 0; i < 8; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const x = cx + Math.cos(a) * radius;
      const z = cz + Math.sin(a) * radius;
      if (isWater(x, z)) continue;
      if (Math.hypot(x - px, z - pz) < 70) continue;
      // Do not stack blockades on top of each other.
      let tooClose = false;
      for (const b of this.blockades) {
        if (Math.hypot(b.x - x, b.z - z) < 110) tooClose = true;
      }
      if (tooClose) continue;

      navGraph.ensure(x, z, 160);
      const hit = roadNetwork.nearestEdge(x, z, 70);
      if (!hit) continue;
      const e = hit.edge;
      if (e.isAlley) continue;
      if (heat.level < 3 && e.cls === "street" && this.rng.chance(0.6)) continue;

      // Two cars set across the carriageway, offset either side of centre.
      const sp = e.samples;
      void sp;
      for (const side of [1, -1] as const) {
        const ox = x + e.rx * side * (e.carriageway * 0.5);
        const oz = z + e.rz * side * (e.carriageway * 0.5);
        const v = trafficSim.spawnAt(tier.faction === "military" ? "apc" : "police", ox, oz, now);
        if (!v) continue;
        v.state = "abandoned";
        v.speed = 0;
        v.hasDriver = false;
        v.sirenOn = true;
        // Rotate across the road: a blockade is broadside, not in lane.
        v.lateral = side * (e.carriageway * 0.45);
        this.vehicles.add(v.id);
      }

      const squad = enemyForce.spawnSquad(
        x - e.dx * 4,
        z - e.dz * 4,
        Math.min(3, tier.squadSize),
        tier.faction,
        tier.archetype,
        tier.loadout,
        now,
      );
      if (squad) {
        for (const m of squad.members) {
          this.units.add(m.id);
          m.lkX = cx;
          m.lkZ = cz;
          m.lkValid = true;
          m.suspicion = 0.7;
          m.calledIn = true;
          // Blockade units hold their ground rather than chasing.
          m.role = "anchor";
        }
      }
      this.blockades.push({ x, z, time: now });
      emitNoise("siren", x, 2, z, "police", 0, 200, 0.25);
      return;
    }
  }

  /* ---------------- helicopters ---------------- */

  private maintainHelis(tier: ResponseTier, now: number): void {
    while (this.helis.length < tier.helicopters) {
      const a = this.rng.next() * Math.PI * 2;
      const r = 420;
      this.helis.push({
        id: Math.floor(this.rng.next() * 1e9),
        x: heat.searchX + Math.cos(a) * r,
        y: 160 + this.rng.next() * 40,
        z: heat.searchZ + Math.sin(a) * r,
        yaw: a + Math.PI,
        pitch: 0,
        roll: 0,
        rotor: this.rng.next(),
        orbit: a,
        orbitRadius: 70 + this.rng.next() * 50,
        altitude: 95 + this.rng.next() * 45,
        light: 0,
        leaveAt: Infinity,
        alive: true,
      });
      useSfStore.getState().notify("Air support on station", "damage");
    }
    while (this.helis.length > tier.helicopters) {
      this.helis.pop();
    }
  }

  private updateHelis(dt: number, now: number, px: number, py: number, pz: number): void {
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      h.rotor += dt * 12;
      if (h.rotor > 1e6) h.rotor = 0;

      const targetX = heat.searchX;
      const targetZ = heat.searchZ;
      // Orbit the search estimate. The direction of the orbit and the radius
      // are per-machine so two helicopters do not fly in formation.
      h.orbit += (dt * 0.34 * (h.orbitRadius > 95 ? -1 : 1) * 40) / Math.max(30, h.orbitRadius);
      const wantX = targetX + Math.cos(h.orbit) * h.orbitRadius;
      const wantZ = targetZ + Math.sin(h.orbit) * h.orbitRadius;
      const wantY = h.altitude;

      const k = Math.min(1, dt * 0.55);
      const prevX = h.x;
      const prevZ = h.z;
      h.x += (wantX - h.x) * k;
      h.z += (wantZ - h.z) * k;
      h.y += (wantY - h.y) * Math.min(1, dt * 0.4);

      const vx = (h.x - prevX) / Math.max(dt, 1e-4);
      const vz = (h.z - prevZ) / Math.max(dt, 1e-4);
      const speed = Math.hypot(vx, vz);
      if (speed > 0.4) {
        let want = Math.atan2(vz, vx);
        let d = want - h.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d <= -Math.PI) d += Math.PI * 2;
        h.yaw += d * Math.min(1, dt * 2);
        // Bank into the turn, nose down with speed — the two things that make
        // a helicopter look flown rather than dragged.
        h.roll += (Math.max(-0.5, Math.min(0.5, -d * 2.4)) - h.roll) * Math.min(1, dt * 2);
        h.pitch += (Math.min(0.22, speed * 0.012) - h.pitch) * Math.min(1, dt * 2);
      }

      // Rotor wash, heard from a long way off.
      if (this.heliNoise <= 0.05) {
        emitNoise("siren", h.x, h.y, h.z, "police", 0, 300, 0.15);
      }

      // The searchlight *is* the perception model. Light on you + clear line =
      // you are seen and the search stays pinned.
      const dx = px - h.x;
      const dy = py - h.y;
      const dz = pz - h.z;
      const dist = Math.hypot(dx, dy, dz);
      const litRadius = 26 + (h.y - py) * 0.16;
      const groundD = Math.hypot(px - h.x, pz - h.z);
      let lit = 0;
      if (dist < 260 && groundD < litRadius) {
        let clear = true;
        if (isPhysicsReady()) {
          clear = !raycast(h.x, h.y, h.z, dx / dist, dy / dist, dz / dist, dist - 1.5, _hit, {
            skipSurface: true,
          });
        }
        if (clear) {
          lit = 1;
          heat.notifySeen(px, pz, now);
        }
      }
      // The beam brightens hard when it finds you and idles at a sweep glow.
      const wantLight = lit > 0 ? 1 : 0.45;
      h.light += (wantLight - h.light) * Math.min(1, dt * 3);
    }
  }

  /* ---------------- pursuit driving ---------------- */

  /**
   * Cruisers do not path — they are ordinary traffic agents with a siren and a
   * bias. What makes them read as a pursuit is that the traffic sim already
   * makes everyone else pull over for them.
   */
  private steerCruisers(dt: number, now: number): void {
    for (const id of this.vehicles) {
      const v = trafficSim.get(id);
      if (!v) continue;
      if (v.state === "abandoned" || v.state === "crashed") continue;
      // Close enough — stop and disembark, so a chase ends in a firefight
      // rather than in cars circling the block forever.
      const d = Math.hypot(v.x - heat.searchX, v.z - heat.searchZ);
      if (d < 34 && v.speed < 6) {
        this.disembark(v, now);
      }
    }
  }

  /** Turn a stopped cruiser into two officers behind an open door. */
  private disembark(v: TrafficVehicle, now: number): void {
    const tier = TIERS[Math.min(heat.level, TIERS.length - 1)];
    if (this.liveFootUnits() >= tier.footUnits + 4) return;
    v.state = "abandoned";
    v.speed = 0;
    v.hasDriver = false;
    const count = v.kind === "swatvan" ? 4 : v.kind === "apc" ? 4 : 2;
    const squad = enemyForce.spawnSquad(
      v.x - Math.cos(v.yaw) * 2.2,
      v.z - Math.sin(v.yaw) * 2.2,
      count,
      tier.faction,
      tier.archetype,
      tier.loadout,
      now,
    );
    if (!squad) return;
    for (const m of squad.members) {
      this.units.add(m.id);
      m.lkX = heat.searchX;
      m.lkZ = heat.searchZ;
      m.lkValid = true;
      m.suspicion = 0.95;
      m.calledIn = true;
      // The car they came out of is their first piece of cover.
      m.coverX = v.x;
      m.coverZ = v.z;
    }
  }

  /* ---------------- housekeeping ---------------- */

  private liveFootUnits(): number {
    let n = 0;
    for (const id of this.units) {
      const e = enemyForce.get(id);
      if (e && e.alive) n++;
    }
    return n;
  }

  private liveCruisers(): number {
    let n = 0;
    for (const id of this.vehicles) {
      const v = trafficSim.get(id);
      if (v && v.state !== "crashed" && v.state !== "abandoned") n++;
    }
    return n;
  }

  /** Forget ids whose entities have gone, so the sets do not grow forever. */
  private pruneDead(): void {
    for (const id of Array.from(this.units)) {
      const e = enemyForce.get(id);
      if (!e || !e.alive) this.units.delete(id);
    }
    for (const id of Array.from(this.vehicles)) {
      if (!trafficSim.get(id)) this.vehicles.delete(id);
    }
  }

  /**
   * Heat is gone. Units leave rather than evaporating: they lose interest, and
   * the streaming budget removes them once they are out of sight. Blockades
   * clear after a grace period so the player can see them stand down.
   */
  private standDown(dt: number, now: number): void {
    for (const id of Array.from(this.units)) {
      const e = enemyForce.get(id);
      if (!e) {
        this.units.delete(id);
        continue;
      }
      e.suspicion = 0;
      e.lkValid = false;
      e.hasContact = false;
      losPool.forget(losKey(e.id, PLAYER_ENTITY_ID));
    }
    for (const id of Array.from(this.vehicles)) {
      const v = trafficSim.get(id);
      if (!v) {
        this.vehicles.delete(id);
        continue;
      }
      v.sirenOn = false;
    }
    for (let i = this.blockades.length - 1; i >= 0; i--) {
      if (now - this.blockades[i].time > 25) this.blockades.splice(i, 1);
    }
    this.nextWave = now + 6;
  }

  /* ---------------- rendering ---------------- */

  render(batch: HelicopterBatch): void {
    batch.begin();
    for (const h of this.helis) {
      batch.push(h.x, h.y, h.z, h.yaw, h.pitch, h.roll, h.rotor, (h.rotor * 2.4) % 1, h.light);
    }
    batch.commit();
  }

  /** Is a point inside an active roadblock's stopping zone? */
  atRoadblock(x: number, z: number): boolean {
    for (const b of this.blockades) {
      if (Math.hypot(b.x - x, b.z - z) < 18) return true;
    }
    return false;
  }

  /** Helicopter positions, for the minimap and the audio system. */
  forEachHelicopter(cb: (x: number, y: number, z: number, light: number) => void): void {
    for (const h of this.helis) cb(h.x, h.y, h.z, h.light);
  }
}

export const police = new PoliceResponse();
export { PoliceResponse };
export type { Enemy };
