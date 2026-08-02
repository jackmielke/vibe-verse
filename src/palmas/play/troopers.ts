/**
 * San Palmas — the troopers.
 *
 * Friendly soldiers who patrol the city with you. Kai's design, and the design
 * is the good part: they carry **exactly your rifle** and wear **exactly your
 * kit**, so the only way to tell a trooper from yourself is the steel helmet
 * with the spike on top. That is a real design idea rather than a shortcut —
 * when the friendlies are visibly *you*, the world stops feeling like a set
 * with props in it and starts feeling like you belong to something.
 *
 * What they do:
 *   - hold a loose formation around the player and follow at a respectful
 *     distance, jogging to catch up and falling back to a walk when close
 *   - avoid each other, the player, and the city, with real capsule collision
 *     between every trooper (no walking through your own squad)
 *   - look where they are going, and look at the player when idle
 *   - carry the rifle at low-ready, raising it when the player aims
 *
 * They are deliberately not hostile. The brief was "they're just gonna help
 * you and stuff like that, so we all live happily ever after", and a friendly
 * squad is also the fastest way to make an empty map feel inhabited.
 */
import * as THREE from "three";
import type { System, SystemFactory, WorldCtx } from "../types";

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

const SQUAD = {
  /** How many troopers exist at once, before quality scaling. */
  count: 10,
  /** Capsule radius used for trooper-vs-trooper and trooper-vs-player. */
  radius: 0.42,
  height: 1.8,
  walkSpeed: 2.6,
  jogSpeed: 5.4,
  /** Distance at which a trooper is happy and stops closing. */
  comfort: 7.0,
  /** Beyond this they jog. */
  chase: 13.0,
  /** Personal space between troopers. */
  separation: 1.9,
  /** How hard they push out of each other, m/s per metre of overlap. */
  separationForce: 7.5,
  /** Turn rate, rad/s. */
  turnRate: 5.0,
  /** Steps per second at walk — drives the leg swing. */
  cadence: 1.9,
} as const;

/** Squad-mate names, so the HUD can say who is with you. */
const NAMES = [
  "Vega", "Ruiz", "Okonkwo", "Lindqvist", "Marchetti",
  "Baptiste", "Cortez", "Nakamura", "Oyelaran", "Petrov",
  "Silva", "Haddad", "Novak", "Mbeki", "Ferreira", "Kowalski",
];

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

/**
 * One trooper mesh, built from primitives.
 *
 * Kit and rifle are identical to the player's; the helmet is the only tell.
 * Everything is parented into a small hierarchy so the legs, arms and head
 * can be animated without touching vertices — at squad size that matters,
 * because ten troopers each rebuilding geometry every frame would cost more
 * than the rest of the game put together.
 */
interface TrooperRig {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  rifle: THREE.Group;
}

function buildTrooper(mats: {
  fatigues: THREE.Material;
  webbing: THREE.Material;
  skin: THREE.Material;
  steel: THREE.Material;
  gun: THREE.Material;
}): TrooperRig {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);

  const box = (
    w: number, h: number, d: number, mat: THREE.Material,
    x = 0, y = 0, z = 0,
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };

  // Chest + webbing over it.
  torso.add(box(0.52, 0.62, 0.30, mats.fatigues, 0, 0.30, 0));
  torso.add(box(0.54, 0.30, 0.33, mats.webbing, 0, 0.34, 0));
  // Pouches, so the silhouette has some bulk at the waist.
  torso.add(box(0.16, 0.13, 0.10, mats.webbing, -0.17, 0.16, 0.17));
  torso.add(box(0.16, 0.13, 0.10, mats.webbing, 0.17, 0.16, 0.17));

  /* ---- head, and the helmet that identifies them ---- */
  const head = new THREE.Group();
  head.position.y = 0.72;
  torso.add(head);
  head.add(box(0.21, 0.24, 0.22, mats.skin, 0, 0.10, 0));

  // Steel dome.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.155, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.58),
    mats.steel,
  );
  dome.position.y = 0.16;
  dome.castShadow = true;
  head.add(dome);
  // Brim, so it reads as a helmet rather than a bald head from the side.
  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.152, 0.022, 6, 16), mats.steel);
  brim.rotation.x = Math.PI / 2;
  brim.position.y = 0.155;
  head.add(brim);
  // The spike. This is the whole identification system, so it is tall enough
  // to break the head's silhouette clearly at distance.
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.20, 8), mats.steel);
  spike.position.y = 0.35;
  spike.castShadow = true;
  head.add(spike);

  /* ---- limbs ---- */
  const limb = (w: number, len: number, mat: THREE.Material) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat);
    // Pivot at the top so rotating the group swings the limb from the joint.
    m.position.y = -len / 2;
    m.castShadow = true;
    g.add(m);
    return g;
  };

  const legL = limb(0.17, 0.88, mats.fatigues);
  const legR = limb(0.17, 0.88, mats.fatigues);
  legL.position.set(-0.14, 0, 0);
  legR.position.set(0.14, 0, 0);
  hips.add(legL, legR);

  const armL = limb(0.14, 0.60, mats.fatigues);
  const armR = limb(0.14, 0.60, mats.fatigues);
  armL.position.set(-0.33, 0.56, 0);
  armR.position.set(0.33, 0.56, 0);
  torso.add(armL, armR);

  /* ---- the rifle: the same weapon the player carries ---- */
  const rifle = new THREE.Group();
  rifle.add(box(0.075, 0.075, 0.62, mats.gun, 0, 0, 0.10)); // receiver
  rifle.add(box(0.045, 0.045, 0.40, mats.gun, 0, 0.004, 0.48)); // barrel
  rifle.add(box(0.070, 0.16, 0.13, mats.gun, 0, -0.11, -0.02)); // magazine
  rifle.add(box(0.065, 0.12, 0.20, mats.gun, 0, -0.05, -0.26)); // stock
  rifle.add(box(0.050, 0.05, 0.10, mats.gun, 0, 0.065, 0.02)); // optic
  // Held in front of the chest at low-ready, angled down and across.
  rifle.position.set(0.16, 0.34, 0.20);
  rifle.rotation.set(0.34, -0.20, 0);
  torso.add(rifle);

  return { root, hips, torso, head, legL, legR, armL, armR, rifle };
}

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

interface Trooper {
  name: string;
  rig: TrooperRig;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  /** Position in the formation, as an offset behind the player. */
  slot: THREE.Vector2;
  /** Accumulated gait phase, radians. */
  phase: number;
  /** 0..1, how fast they are moving relative to jog speed. Drives the gait. */
  gait: number;
}

const _desired = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _slotWorld = new THREE.Vector3();

const createTroopers: SystemFactory = (ctx: WorldCtx) => {
  const { scene, quality, rng } = ctx;

  const count =
    quality === "low" ? 4 : quality === "medium" ? 7 : quality === "ultra" ? 14 : SQUAD.count;

  const mats = {
    fatigues: new THREE.MeshStandardMaterial({ color: 0x4a5340, roughness: 0.92 }),
    webbing: new THREE.MeshStandardMaterial({ color: 0x2f3529, roughness: 0.95 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x9a6b4a, roughness: 0.78 }),
    // Bare steel, deliberately brighter and shinier than anything else on the
    // body so the helmet reads instantly against the fatigues.
    steel: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.30, metalness: 0.85 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.55, metalness: 0.42 }),
  };

  const group = new THREE.Group();
  group.name = "troopers";
  scene.add(group);

  const troopers: Trooper[] = [];
  for (let i = 0; i < count; i++) {
    const rig = buildTrooper(mats);
    group.add(rig.root);
    // A loose wedge behind the player: two ranks, alternating sides.
    const side = i % 2 === 0 ? -1 : 1;
    const rank = Math.floor(i / 2) + 1;
    troopers.push({
      name: NAMES[i % NAMES.length],
      rig,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: 0,
      slot: new THREE.Vector2(side * (1.8 + rank * 0.9), 2.4 + rank * 2.1),
      phase: rng() * Math.PI * 2,
      gait: 0,
    });
  }

  let placed = false;

  const sys: System = {
    name: "troopers",

    update(dt, c) {
      const player = c.services.player;
      const terrain = c.services.terrain;
      const collision = c.services.collision;
      if (!player) return;

      // First frame with a player: drop the squad into formation around them
      // rather than letting them fly in from the origin.
      if (!placed) {
        placed = true;
        for (const t of troopers) {
          t.pos.set(
            player.position.x + t.slot.x,
            player.position.y,
            player.position.z + t.slot.y,
          );
        }
      }

      const pyaw = Math.atan2(
        player.camera.getWorldDirection(_desired).x,
        _desired.z,
      );
      const cos = Math.cos(pyaw);
      const sin = Math.sin(pyaw);

      for (const t of troopers) {
        // --- where this trooper wants to be: their slot, rotated behind the
        // player's facing, so the formation turns with you.
        _slotWorld.set(
          player.position.x + (t.slot.x * cos - t.slot.y * sin),
          0,
          player.position.z + (t.slot.x * sin + t.slot.y * cos),
        );

        _delta.set(_slotWorld.x - t.pos.x, 0, _slotWorld.z - t.pos.z);
        const dist = _delta.length();

        // --- speed: hold station when close, jog when the player gets away.
        let speed = 0;
        if (dist > SQUAD.comfort) {
          speed = dist > SQUAD.chase ? SQUAD.jogSpeed : SQUAD.walkSpeed;
        }
        _desired.copy(_delta);
        if (dist > 0.001) _desired.multiplyScalar(speed / dist);

        // --- separation from every other trooper, and from the player. This
        // is the "collision between all troopers" part, and it is done as a
        // steering force *and* a hard positional resolve below: the force
        // stops them bunching, the resolve guarantees they never overlap.
        _sep.set(0, 0, 0);
        for (const o of troopers) {
          if (o === t) continue;
          const dx = t.pos.x - o.pos.x;
          const dz = t.pos.z - o.pos.z;
          const d2 = dx * dx + dz * dz;
          const min = SQUAD.separation;
          if (d2 > 0.0001 && d2 < min * min) {
            const d = Math.sqrt(d2);
            _sep.x += (dx / d) * (min - d);
            _sep.z += (dz / d) * (min - d);
          }
        }
        {
          const dx = t.pos.x - player.position.x;
          const dz = t.pos.z - player.position.z;
          const d2 = dx * dx + dz * dz;
          const min = SQUAD.separation * 1.15;
          if (d2 > 0.0001 && d2 < min * min) {
            const d = Math.sqrt(d2);
            _sep.x += (dx / d) * (min - d) * 1.6;
            _sep.z += (dz / d) * (min - d) * 1.6;
          }
        }
        _desired.x += _sep.x * SQUAD.separationForce;
        _desired.z += _sep.z * SQUAD.separationForce;

        // --- integrate, with a little inertia so they lean into turns.
        t.vel.lerp(_desired, Math.min(1, dt * 7));
        t.pos.x += t.vel.x * dt;
        t.pos.z += t.vel.z * dt;

        // --- hard collision. City geometry first, then a positional pass
        // against the other troopers so no two ever occupy the same space.
        if (collision) collision.resolveCapsule(t.pos, SQUAD.radius, SQUAD.height);
        for (const o of troopers) {
          if (o === t) continue;
          const dx = t.pos.x - o.pos.x;
          const dz = t.pos.z - o.pos.z;
          const d2 = dx * dx + dz * dz;
          const min = SQUAD.radius * 2;
          if (d2 > 1e-6 && d2 < min * min) {
            const d = Math.sqrt(d2);
            const push = (min - d) * 0.5;
            const nx = dx / d;
            const nz = dz / d;
            t.pos.x += nx * push;
            t.pos.z += nz * push;
            o.pos.x -= nx * push;
            o.pos.z -= nz * push;
          }
        }

        // --- stand on the ground.
        t.pos.y = terrain ? terrain.heightAt(t.pos.x, t.pos.z) : player.position.y;

        // --- facing: walk where you are going, otherwise look at the player.
        const moving = t.vel.lengthSq() > 0.6;
        const targetYaw = moving
          ? Math.atan2(t.vel.x, t.vel.z)
          : Math.atan2(player.position.x - t.pos.x, player.position.z - t.pos.z);
        let d = targetYaw - t.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        t.yaw += THREE.MathUtils.clamp(d, -SQUAD.turnRate * dt, SQUAD.turnRate * dt);

        // --- gait. Phase advances with distance travelled, not with time, so
        // the feet do not scoot when they slow down — the single most obvious
        // tell of a bad walk cycle.
        const speedNow = Math.hypot(t.vel.x, t.vel.z);
        t.gait = THREE.MathUtils.lerp(t.gait, Math.min(1, speedNow / SQUAD.jogSpeed), dt * 6);
        t.phase += speedNow * dt * SQUAD.cadence;

        const swing = Math.sin(t.phase) * (0.30 + t.gait * 0.55);
        const counter = Math.sin(t.phase) * (0.22 + t.gait * 0.35);
        const { rig } = t;
        rig.legL.rotation.x = swing;
        rig.legR.rotation.x = -swing;
        rig.armL.rotation.x = -counter;
        // The right arm holds the rifle, so it barely swings.
        rig.armR.rotation.x = counter * 0.18;
        // Bob the hips on each footfall, and breathe when standing still.
        rig.hips.position.y =
          0.92 + Math.abs(Math.cos(t.phase)) * 0.045 * t.gait + Math.sin(c.elapsed * 1.6) * 0.006;
        rig.torso.rotation.y = Math.sin(t.phase) * 0.06 * t.gait;
        // Head tracks the player when they are close enough to talk to.
        const toPlayer = Math.atan2(
          player.position.x - t.pos.x,
          player.position.z - t.pos.z,
        );
        let hd = toPlayer - t.yaw;
        while (hd > Math.PI) hd -= Math.PI * 2;
        while (hd < -Math.PI) hd += Math.PI * 2;
        rig.head.rotation.y = THREE.MathUtils.clamp(hd, -0.9, 0.9) * 0.75;

        rig.root.position.copy(t.pos);
        rig.root.rotation.y = t.yaw;
      }
    },

    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      for (const m of Object.values(mats)) m.dispose();
    },
  };

  return sys;
};

export default createTroopers;
