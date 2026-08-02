/**
 * Ordnance and everything it leaves behind.
 *
 * Phasers are *beams*, torpedoes are *objects*, and disruptors are *bolts*.
 * Keeping those three genuinely different in code is what keeps them different
 * on screen, and they need to be different on screen because a Star Trek
 * battle is read almost entirely by what colour is crossing the frame:
 *
 * - **Phaser** — orange, instant, sustained, and it *tracks*. It is the weapon
 *   of a ship that has a firing solution. It also fires from the emitters on
 *   the saucer's underside rather than from the middle of the model, which is
 *   the sort of thing nobody consciously notices and everybody notices.
 * - **Photon torpedo** — red, slow enough to watch, and it can miss. Every
 *   torpedo in the show is a held breath, and it is held because the thing is
 *   visibly in flight.
 * - **Disruptor** — green, bolted, and fast. The colour alone tells you which
 *   way the shot is going, which is the only thing you need to know at a
 *   glance in a fight with four ships in it.
 *
 * Nothing here allocates during a battle: beams, bolts and explosion cores are
 * pooled and re-armed, because a garbage collection pause in the middle of an
 * attack run is a stutter the player will read as their own mistake.
 */
import * as THREE from "three";
import { puffTexture } from "../world/space";
import { PALETTE, type Ship, type System, type TrekCtx, type WeaponsService } from "../types";

interface Beam {
  core: THREE.Mesh;
  glow: THREE.Mesh;
  from: Ship;
  to: Ship;
  port: THREE.Vector3;
  life: number;
  maxLife: number;
  dps: number;
  active: boolean;
}

interface Bolt {
  sprite: THREE.Sprite;
  light: THREE.PointLight | null;
  velocity: THREE.Vector3;
  target: Ship | null;
  from: Ship | null;
  damage: number;
  life: number;
  homing: number;
  kind: "torpedo" | "disruptor" | "plasma";
  active: boolean;
}

interface Blast {
  core: THREE.Sprite;
  flash: THREE.Sprite;
  light: THREE.PointLight | null;
  life: number;
  maxLife: number;
  size: number;
  active: boolean;
}

const FORWARD = new THREE.Vector3(0, 0, -1);

export function createWeapons(ctx: TrekCtx): System {
  const { space, rng } = ctx;
  const soft = puffTexture(0.05);
  const hard = puffTexture(0.35);

  const beams: Beam[] = [];
  const bolts: Bolt[] = [];
  const blasts: Blast[] = [];
  const debris: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();

  // -- Pools ---------------------------------------------------------------

  function makeBeam(): Beam {
    const coreGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: PALETTE.phaserCore, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    const glow = new THREE.Mesh(
      coreGeo.clone(),
      new THREE.MeshBasicMaterial({ color: PALETTE.phaser, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    core.visible = false;
    glow.visible = false;
    core.renderOrder = 8;
    glow.renderOrder = 7;
    core.frustumCulled = false;
    glow.frustumCulled = false;
    space.add(core, glow);
    const b: Beam = { core, glow, from: null!, to: null!, port: new THREE.Vector3(), life: 0, maxLife: 1, dps: 0, active: false };
    beams.push(b);
    return b;
  }

  /**
   * A bolt is a sprite and nothing else.
   *
   * It wanted a point light — a torpedo lighting the hull it is about to hit
   * is a lovely shot. It does not get one, and the reason is worth writing
   * down: three.js compiles a material variant per light count, so twelve
   * torpedo lights flickering on and off mid-battle means a shader recompile
   * every few frames, which reads to the player as the game stuttering when
   * things get busy. Additive sprites cost nothing and read almost as well.
   */
  function makeBolt(): Bolt {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: hard, color: PALETTE.torpedo, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    sprite.visible = false;
    sprite.renderOrder = 8;
    space.add(sprite);
    const b: Bolt = { sprite, light: null, velocity: new THREE.Vector3(), target: null, from: null, damage: 0, life: 0, homing: 0, kind: "torpedo", active: false };
    bolts.push(b);
    return b;
  }

  /** Three real lights, permanently in the scene, shared by every explosion. */
  let blastLights = 0;
  function makeBlast(): Blast {
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: soft, color: 0xffb066, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    const flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: hard, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    core.visible = false;
    flash.visible = false;
    core.renderOrder = 9;
    flash.renderOrder = 10;
    space.add(core, flash);
    let light: THREE.PointLight | null = null;
    if (blastLights < 3) {
      blastLights++;
      light = new THREE.PointLight(0xffa050, 0, 20000, 2);
      space.add(light);
    }
    const b: Blast = { core, flash, light, life: 0, maxLife: 1, size: 1, active: false };
    blasts.push(b);
    return b;
  }

  const freeBeam = () => beams.find((b) => !b.active) ?? makeBeam();
  const freeBolt = () => bolts.find((b) => !b.active) ?? makeBolt();
  // Prefer one of the three that carries a light: an explosion that lights the
  // hull next to it is worth much more than one that does not.
  const freeBlast = () =>
    blasts.find((b) => !b.active && b.light) ?? blasts.find((b) => !b.active) ?? makeBlast();

  for (let i = 0; i < 4; i++) makeBeam();
  for (let i = 0; i < 12; i++) makeBolt();
  for (let i = 0; i < 8; i++) makeBlast();

  // -- Muzzle points -------------------------------------------------------

  /** World position of one of a ship's weapon ports, alternating between them. */
  function portOf(ship: Ship, key: "phaserPorts" | "torpedoPorts", index: number): THREE.Vector3 {
    const ports = (ship.object.userData[key] ?? []) as THREE.Vector3[];
    if (!ports.length) return ship.position.clone();
    return ports[index % ports.length].clone().applyQuaternion(ship.quaternion).add(ship.position);
  }

  /** A point on the target's hull rather than its origin — hits should land on it. */
  function aimPoint(target: Ship, spread: number): THREE.Vector3 {
    return tmp2
      .set(rng.gauss(), rng.gauss(), rng.gauss())
      .multiplyScalar(target.radius * spread)
      .add(target.position)
      .clone();
  }

  // -- Public API ----------------------------------------------------------

  const service: WeaponsService = {
    firePhasers(from, target) {
      if (!from.alive || !target.alive || from.systems.phasers < 0.15) return false;
      if (from.cloakLevel > 0.05) return false;
      const range = from.position.distanceTo(target.position);
      if (range > 12000) return false;

      // Arc check: a starship's phasers do not shoot through its own hull.
      tmp.copy(target.position).sub(from.position).normalize();
      tmp2.copy(FORWARD).applyQuaternion(from.quaternion);
      if (tmp.dot(tmp2) < 0.28) return false;

      const klingon = from.allegiance === "klingon";
      const romulan = from.allegiance === "romulan";

      if (klingon || romulan) {
        // Disruptors: a burst of bolts, not a beam.
        const count = klingon ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const b = freeBolt();
          b.active = true;
          b.kind = romulan ? "plasma" : "disruptor";
          b.sprite.visible = true;
          b.sprite.position.copy(portOf(from, "phaserPorts", i));
          b.sprite.scale.setScalar(romulan ? 190 : 90);
          b.sprite.material.color.setHex(romulan ? PALETTE.plasma : PALETTE.disruptor);
          b.velocity.copy(aimPoint(target, 0.5)).sub(b.sprite.position).normalize().multiplyScalar(romulan ? 1500 : 2600);
          b.target = target;
          b.from = from;
          b.damage = romulan ? 190 : 70;
          b.homing = romulan ? 0.5 : 0;
          b.life = romulan ? 9 : 5;
          if (b.light) {
            b.light.color.setHex(romulan ? PALETTE.plasma : PALETTE.disruptor);
            b.light.intensity = romulan ? 900 : 300;
          }
        }
        ctx.services.audio?.cue(romulan ? "plasma" : "disruptor");
        return true;
      }

      // Starfleet: a tracking beam from each emitter, converging on the target.
      const ports = (from.object.userData.phaserPorts ?? []) as THREE.Vector3[];
      const n = Math.max(1, ports.length);
      for (let i = 0; i < n; i++) {
        const beam = freeBeam();
        beam.active = true;
        beam.from = from;
        beam.to = target;
        beam.port.copy(ports[i % ports.length] ?? new THREE.Vector3());
        beam.life = 0;
        beam.maxLife = 0.9;
        // Beams bleed off badly in a nebula: the discharge scatters them and
        // neither ship can hold a solution long enough to burn through. It is
        // why the Mutara duel is fought with torpedoes at knife range.
        const interference = ctx.services.space?.interference ?? 0;
        // The planet killer's beam is not a phaser. It cuts planets in half,
        // and it should feel like being hit by weather rather than by gunnery.
        const base = from === ctx.services.fleet?.player ? 150 : from.allegiance === "machine" ? 300 : 90;
        beam.dps = (base * from.systems.phasers * (1 - interference * 0.55)) / n;
        beam.core.visible = true;
        beam.glow.visible = true;
        // Re-arm the pooled beam completely. The antiproton beam parks a fixed
        // endpoint and a white colour on whichever slot it borrowed, and a
        // phaser that inherits either of those is a phaser firing at a point
        // in space the target left ten seconds ago.
        beam.core.userData.fixedEnd = undefined;
        (beam.core.material as THREE.MeshBasicMaterial).color.setHex(PALETTE.phaserCore);
        (beam.glow.material as THREE.MeshBasicMaterial).color.setHex(PALETTE.phaser);
      }
      return true;
    },

    fireTorpedo(from, target) {
      if (!from.alive || !target.alive) return false;
      if (from.torpedoes <= 0 || from.systems.torpedoes < 0.15) return false;
      if (from.cloakLevel > 0.05) return false;
      from.torpedoes--;

      const b = freeBolt();
      b.active = true;
      b.kind = "torpedo";
      b.sprite.visible = true;
      b.sprite.position.copy(portOf(from, "torpedoPorts", from.torpedoes));
      b.sprite.scale.setScalar(150);
      b.sprite.material.color.setHex(PALETTE.torpedo);
      // Launched forward, then it steers. A torpedo that homes perfectly from
      // the tube never *looks* like it might miss, and looking like it might
      // miss is the whole point of a torpedo.
      b.velocity.copy(FORWARD).applyQuaternion(from.quaternion).multiplyScalar(1150);
      b.target = target;
      b.from = from;
      b.damage = 260;
      b.homing = 1.5;
      b.life = 11;
      if (b.light) {
        b.light.color.setHex(PALETTE.torpedo);
        b.light.intensity = 1600;
      }
      ctx.services.audio?.cue("torpedo");
      ctx.emit("trek:torpedoAway", { from, target });
      return true;
    },

    fireAntiproton(from, at) {
      // The planet killer's beam. Not a weapon so much as a natural disaster:
      // it does not aim, it does not track, and being anywhere near it is the
      // mistake.
      const beam = freeBeam();
      beam.active = true;
      beam.from = from;
      beam.to = null!;
      beam.port.set(0, 0, 0);
      beam.life = 0;
      beam.maxLife = 2.6;
      beam.dps = 340;
      beam.core.visible = true;
      beam.glow.visible = true;
      (beam.core.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      (beam.glow.material as THREE.MeshBasicMaterial).color.setHex(0x9fd0ff);
      beam.core.userData.fixedEnd = at.clone();
      ctx.services.audio?.cue("plasma", { gain: 1.4 });
    },

    explode(at, size, colour = 0xffb066) {
      const b = freeBlast();
      b.active = true;
      b.life = 0;
      b.maxLife = 0.5 + size / 900;
      b.size = size;
      b.core.visible = true;
      b.flash.visible = true;
      b.core.position.copy(at);
      b.flash.position.copy(at);
      b.core.material.color.setHex(colour);
      if (b.light) {
        b.light.position.copy(at);
        b.light.color.setHex(colour);
        b.light.intensity = size * 60;
      }
      // Distance matters: a freighter going up twenty kilometres away is a
      // light on the horizon, not something that throws you out of the chair.
      const player = ctx.services.fleet?.player;
      const range = player ? player.position.distanceTo(at) : 0;
      const near = Math.max(0, 1 - range / 9000);
      ctx.services.audio?.cue("explosion", { gain: Math.min(1.6, (size / 250) * (0.25 + near)) });
      ctx.services.camera?.shake(Math.min(1, (size / 400) * near));
    },
  };
  ctx.services.weapons = service;

  // -- Wrecks --------------------------------------------------------------

  const off = ctx.on("trek:destroyed", (payload: never) => {
    const { ship } = payload as unknown as { ship: Ship };
    service.explode(ship.position.clone(), ship.radius * 2.4, 0xfff0c0);
    // A secondary a beat later, then the hull goes. Two explosions read as a
    // ship coming apart; one reads as a firework.
    setTimeout(() => {
      if (ship.object.parent) service.explode(ship.position.clone(), ship.radius * 1.6, 0xff8a3c);
    }, 420);

    for (let i = 0; i < 14; i++) {
      const size = ship.radius * rng.range(0.06, 0.24);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size, size * rng.range(0.3, 1), size * rng.range(0.4, 1.6)),
        new THREE.MeshStandardMaterial({ color: 0x8b9099, roughness: 0.9, metalness: 0.3, flatShading: true }),
      );
      mesh.position.copy(ship.position).add(tmp.set(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(ship.radius * 0.5));
      space.add(mesh);
      debris.push({
        mesh,
        vel: new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(rng.range(30, 160)).add(ship.velocity),
        spin: new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(1.4),
        life: 22,
      });
    }
  });

  // -------------------------------------------------------------------------

  return {
    update(dt) {
      const fleet = ctx.services.fleet;

      // -- Beams ------------------------------------------------------------
      for (const b of beams) {
        if (!b.active) continue;
        b.life += dt;
        const t = b.life / b.maxLife;
        if (t >= 1 || !b.from.alive) {
          b.active = false;
          b.core.visible = false;
          b.glow.visible = false;
          continue;
        }
        const start = tmp.copy(b.port).applyQuaternion(b.from.quaternion).add(b.from.position);
        const fixed = b.core.userData.fixedEnd as THREE.Vector3 | undefined;
        const end = fixed ?? (b.to?.alive ? b.to.position : null);
        if (!end) {
          b.active = false;
          b.core.visible = false;
          b.glow.visible = false;
          continue;
        }

        tmp2.copy(end).sub(start);
        const len = tmp2.length();
        const mid = start.clone().addScaledVector(tmp2, 0.5);
        q.setFromUnitVectors(up, tmp2.clone().normalize());

        // A phaser flickers: it is not a laser pointer, it is a discharge.
        const flicker = 0.72 + 0.28 * Math.sin(b.life * 61) * Math.sin(b.life * 23);
        const fade = t > 0.75 ? 1 - (t - 0.75) / 0.25 : Math.min(1, t / 0.06);
        const width = (fixed ? 90 : 7) * (0.7 + 0.3 * flicker);

        for (const [mesh, scale, alpha] of [
          [b.core, width, 0.95 * fade * flicker],
          [b.glow, width * 3.2, 0.42 * fade],
        ] as const) {
          mesh.position.copy(mid);
          mesh.quaternion.copy(q);
          mesh.scale.set(scale, len, scale);
          (mesh.material as THREE.MeshBasicMaterial).opacity = alpha;
        }

        if (b.to?.alive && fleet) {
          fleet.damage(b.to, b.dps * dt, start, "beam");
          if (rng.chance(dt * 8)) {
            const hit = freeBlast();
            hit.active = true;
            hit.life = 0;
            hit.maxLife = 0.22;
            hit.size = b.to.radius * 0.35;
            hit.core.visible = true;
            hit.flash.visible = true;
            hit.core.position.copy(b.to.position);
            hit.flash.position.copy(b.to.position);
            hit.core.material.color.setHex(b.to.shieldsUp && b.to.shields[0] > 0.02 ? 0x7fd8ff : 0xffc070);
            if (hit.light) {
              hit.light.position.copy(b.to.position);
              hit.light.intensity = 400;
            }
          }
        }
      }

      // -- Bolts and torpedoes ----------------------------------------------
      for (const b of bolts) {
        if (!b.active) continue;
        b.life -= dt;
        if (b.life <= 0) {
          b.active = false;
          b.sprite.visible = false;
          if (b.light) b.light.intensity = 0;
          continue;
        }

        if (b.homing > 0 && b.target?.alive) {
          tmp.copy(b.target.position).sub(b.sprite.position).normalize().multiplyScalar(b.velocity.length());
          b.velocity.lerp(tmp, Math.min(1, b.homing * dt));
        }
        b.sprite.position.addScaledVector(b.velocity, dt);
        if (b.light) b.light.position.copy(b.sprite.position);
        // Torpedoes pulse; disruptor bolts do not.
        if (b.kind === "torpedo") {
          b.sprite.scale.setScalar(150 * (0.85 + 0.25 * Math.sin(b.life * 24)));
        }

        // Hit test against every hull, not just the intended target — a
        // torpedo that passes through the ship it was not aimed at is a
        // torpedo the player will notice passing through a ship.
        if (!fleet) continue;
        let struck: Ship | null = null;
        for (const s of fleet.ships) {
          if (!s.alive || s === b.from) continue;
          if (s.cloakLevel > 0.5) continue;
          if (b.sprite.position.distanceTo(s.position) < s.radius) {
            struck = s;
            break;
          }
        }
        if (struck) {
          fleet.damage(struck, b.damage, b.sprite.position, b.kind === "torpedo" ? "torpedo" : "beam");
          service.explode(
            b.sprite.position.clone(),
            b.kind === "torpedo" ? 220 : 90,
            b.kind === "disruptor" ? PALETTE.disruptor : b.kind === "plasma" ? PALETTE.plasma : 0xffc070,
          );
          b.active = false;
          b.sprite.visible = false;
          if (b.light) b.light.intensity = 0;
        }
      }

      // -- Blasts ------------------------------------------------------------
      for (const b of blasts) {
        if (!b.active) continue;
        b.life += dt;
        const t = b.life / b.maxLife;
        if (t >= 1) {
          b.active = false;
          b.core.visible = false;
          b.flash.visible = false;
          if (b.light) b.light.intensity = 0;
          continue;
        }
        // Fast out, slow fade — the shape of every explosion ever filmed.
        const grow = 1 - (1 - t) ** 3;
        b.core.scale.setScalar(b.size * (0.6 + grow * 3.4));
        b.core.material.opacity = (1 - t) ** 1.6;
        b.flash.scale.setScalar(b.size * (1 + grow * 1.2));
        b.flash.material.opacity = Math.max(0, 1 - t * 4);
        if (b.light) b.light.intensity = b.size * 60 * (1 - t) ** 2;
      }

      // -- Debris ------------------------------------------------------------
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i];
        d.life -= dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        if (d.life <= 0) {
          space.remove(d.mesh);
          d.mesh.geometry.dispose();
          (d.mesh.material as THREE.Material).dispose();
          debris.splice(i, 1);
        }
      }

      // A wreck burns for six seconds, then it is gone. Leaving it in the
      // scene means the next episode inherits a graveyard.
      if (fleet) {
        for (const s of [...fleet.ships]) {
          if (!s.alive && s.dyingFor > 6 && s !== fleet.player) fleet.remove(s);
        }
      }
    },

    dispose() {
      off();
      soft.dispose();
      hard.dispose();
      for (const d of debris) {
        space.remove(d.mesh);
        d.mesh.geometry.dispose();
        (d.mesh.material as THREE.Material).dispose();
      }
      debris.length = 0;
    },
  };
}
