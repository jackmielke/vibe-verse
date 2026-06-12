import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useGame } from "./store";
import { AnimalCreature, PlantCreature, PredatorCreature, ApexCreature, HerbivoreCreature, DragonCreature, GoatCreature } from "./Creature";
import { input } from "./input";
import { clampToIsland, clampToWorld, isInWater } from "./island";
import { spawnFireball } from "./fireballs";

const keys: Record<string, boolean> = {};
function clearKeys() {
  for (const k of Object.keys(keys)) keys[k] = false;
}
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
  });
  // If the tab/window loses focus mid-keypress, the keyup never arrives —
  // clear everything so the player doesn't keep walking forever.
  window.addEventListener("blur", clearKeys);
  document.addEventListener("visibilitychange", clearKeys);
}

function isDown(...k: string[]) {
  return k.some((x) => keys[x]);
}

export function Player() {
  const kind = useGame((s) => s.kind);
  const species = useGame((s) => s.species);
  const traits = useGame((s) => s.traits);
  const pos = useGame((s) => s.pos);
  const setPos = useGame((s) => s.setPos);
  const food = useGame((s) => s.food);
  const npcs = useGame((s) => s.npcs);
  const consume = useGame((s) => s.consume);
  const killNpc = useGame((s) => s.killNpc);
  const eatNpc = useGame((s) => s.eatNpc);
  const damage = useGame((s) => s.damage);
  const addEnergy = useGame((s) => s.addEnergy);
  const spawnSeedFood = useGame((s) => s.spawnSeedFood);
  const mode = useGame((s) => s.mode);

  const ref = useRef<THREE.Group>(null!);
  const camTarget = useRef(new THREE.Vector3(...pos));
  const { camera } = useThree();
  const tmpHeading = useRef(0);
  const facing = useRef<{ dx: number; dz: number }>({ dx: 0, dz: -1 });
  const fireCd = useRef(0);

  useEffect(() => {
    camTarget.current.set(pos[0], pos[1], pos[2]);
  }, [pos[0], pos[2]]);

  useFrame((_, dt) => {
    if (mode !== "playing") return;
    const cur = ref.current;
    if (!cur) return;
    let [x, , z] = pos;

    if (kind === "animal") {
      let dx = 0;
      let dz = 0;
      if (isDown("w", "arrowup")) dz -= 1;
      if (isDown("s", "arrowdown")) dz += 1;
      if (isDown("a", "arrowleft")) dx -= 1;
      if (isDown("d", "arrowright")) dx += 1;
      // Touch joystick input (analog)
      if (Math.abs(input.x) > 0.05 || Math.abs(input.z) > 0.05) {
        dx += input.x;
        dz += input.z;
      }
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        dx /= len;
        dz /= len;
        const sp = traits.speed * dt;
        x += dx * sp;
        z += dz * sp;
        tmpHeading.current = Math.atan2(-dx, -dz);
        facing.current.dx = dx;
        facing.current.dz = dz;
      }
      // Swimmers (otter) can travel through water out to outer islets;
      // everyone else is clamped to the main island shore.
      if (species === "otter") {
        [x, z] = clampToWorld(x, z, 1.5);
      } else {
        [x, z] = clampToIsland(x, z, 1.5);
      }
      const swimming = species === "otter" && isInWater(x, z, 0.5);
      const py = swimming ? -0.25 + Math.sin(performance.now() * 0.004) * 0.08 : 0;
      setPos([x, py, z]);
    }

    // Dragon: breathe fire
    if (fireCd.current > 0) fireCd.current -= dt;
    if (species === "dragon") {
      const wantsFire = isDown(" ", "f", "spacebar") || input.fire;
      input.fire = false;
      if (wantsFire && fireCd.current <= 0) {
        const f = facing.current;
        const muzzleX = x + f.dx * 1.4;
        const muzzleZ = z + f.dz * 1.4;
        spawnFireball(muzzleX, muzzleZ, f.dx, f.dz);
        fireCd.current = 0.35;
      }
    }

    // Eat food in range
    const reach = (kind === "plant" ? 1.2 + traits.roots * 0.5 : 0.9) * traits.size;
    for (const f of food) {
      if (!f.alive) continue;
      const dx = f.pos[0] - x;
      const dz = f.pos[2] - z;
      if (dx * dx + dz * dz < reach * reach) {
        if (f.type === "prey" && traits.carnivore < 0.3 && kind === "animal") continue;
        if (kind === "plant" && f.type === "prey") continue;
        // Pure carnivores (wolves, grizzly, dragon, fanged) don't graze on plants
        const isPlantFood = f.type === "berry" || f.type === "seed" || f.type === "nutrient";
        if (kind === "animal" && traits.carnivore >= 0.8 && isPlantFood) continue;
        consume(f.id);
      }
    }

    // NPC interaction (+ soft collision so player can't go inside bodies)
    for (const n of npcs) {
      if (!n.alive) continue;
      const dx = n.pos[0] - x;
      const dz = n.pos[2] - z;
      const d2 = dx * dx + dz * dz;
      const playerR = 0.5 + traits.size * 0.45;
      const npcR = n.size * (n.kind === "apex" ? 1.1 : n.kind === "predator" ? 0.7 : 0.6);
      const sep = playerR + npcR;
      const touch = sep * sep;
      if (d2 >= touch) continue;

      // Push player out so they never end up inside (especially under apex)
      const dist = Math.sqrt(Math.max(d2, 1e-6));
      const push = sep - dist;
      if (push > 0) {
        const nx = dx / dist;
        const nz = dz / dist;
        x -= nx * push;
        z -= nz * push;
      }

      const playerBigger = traits.size >= n.size * 1.15;

      if (kind === "animal") {
        if (n.kind === "herbivore") {
          // Player can eat smaller herbivores if any meat in diet
          if (traits.carnivore >= 0.3 && playerBigger) {
            eatNpc(n.id);
          } else if (traits.defense >= 1) {
            // herbivores don't really hurt; tiny brush
            damage(0.5 * dt * 10);
          }
        } else if (n.kind === "predator") {
          if (traits.carnivore >= 0.5 && traits.size >= 1.1) {
            killNpc(n.id);
          } else if (traits.defense >= 2) {
            killNpc(n.id);
            damage(5);
          } else {
            damage((10 - traits.defense * 2) * dt * 10);
          }
        } else if (n.kind === "apex") {
          // Apex: very deadly. Only killable if you're a true monster.
          if (traits.carnivore >= 0.8 && traits.size >= 1.5) {
            killNpc(n.id);
            damage(20);
          } else if (traits.defense >= 3) {
            damage((18 - traits.defense * 2) * dt * 10);
          } else {
            damage(28 * dt * 10);
          }
        }
      } else {
        // Plant being grazed
        if (n.kind === "herbivore" || n.kind === "apex") {
          if (traits.defense >= 2) {
            // Thorns — grazers take damage and retreat
            killNpc(n.id);
            damage(2);
          } else if (traits.spread > 0) {
            // Seed dispersal: light damage, grazer carries a seed
            damage(1.2 * dt * 10);
            if (!n.seeded && Math.random() < dt * 1.2) {
              n.seeded = true;
              n.seedTimer = 0;
            }
          } else {
            damage(6 * dt * 10);
          }
        } else if (n.kind === "predator") {
          // Carnivores ignore plants mostly
          damage(0.4 * dt * 10);
        }
      }
    }

    // Commit any collision-corrected position
    if (species === "otter") {
      [x, z] = clampToWorld(x, z, 1.5);
    } else {
      [x, z] = clampToIsland(x, z, 1.5);
    }
    const swimming2 = species === "otter" && isInWater(x, z, 0.5);
    const py2 = swimming2 ? -0.25 + Math.sin(performance.now() * 0.004) * 0.08 : 0;
    if (kind === "animal") setPos([x, py2, z]);

    cur.position.set(x, py2 + 0.4 + traits.size * 0.3, z);
    cur.rotation.y = THREE.MathUtils.lerp(cur.rotation.y, tmpHeading.current, 0.2);
    cur.scale.setScalar(traits.size);

    const camDist = 12 + traits.size * 2;
    const camHeight = 10 + traits.size * 1.5;
    const desired = new THREE.Vector3(x, camHeight, z + camDist);
    camera.position.lerp(desired, 0.08);
    camera.lookAt(x, 0.5, z);

    if (kind === "plant") addEnergy(0);

    // Process seeded grazers — when far enough, they "plant" the seed
    for (const n of npcs) {
      if (!n.seeded || !n.alive) continue;
      n.seedTimer = (n.seedTimer ?? 0) + dt;
      const fdx = n.pos[0] - pos[0];
      const fdz = n.pos[2] - pos[2];
      const far = fdx * fdx + fdz * fdz > 64;
      if (n.seedTimer > 4 && far) {
        spawnSeedFood([n.pos[0], 0, n.pos[2]]);
        n.seeded = false;
        n.seedTimer = 0;
      }
    }
  });

  const [moving, setMoving] = useState(false);
  useFrame(() => {
    if (kind !== "animal") return;
    const m = isDown("w", "arrowup", "s", "arrowdown", "a", "arrowleft", "d", "arrowright")
      || Math.abs(input.x) > 0.05 || Math.abs(input.z) > 0.05;
    if (m !== moving) setMoving(m);
  });

  return (
    <group ref={ref} position={pos}>
      {kind === "plant" ? (
        <PlantCreature traits={traits} />
      ) : species === "stalker" ? (
        <PredatorCreature moving={moving} />
      ) : species === "grizzly" ? (
        <ApexCreature moving={moving} />
      ) : species === "fawn" ? (
        <HerbivoreCreature moving={moving} />
      ) : species === "dragon" ? (
        <DragonCreature moving={moving} />
      ) : species === "goat" ? (
        <GoatCreature moving={moving} />
      ) : species === "armored" ? (
        <AnimalCreature traits={{ ...traits, size: Math.max(traits.size, 1.2), defense: Math.max(traits.defense, 3), color: [0.45, 0.5, 0.6] }} moving={moving} isPlayer />
      ) : species === "fanged" ? (
        <AnimalCreature traits={{ ...traits, carnivore: 1, color: [0.55, 0.25, 0.25] }} moving={moving} isPlayer hostile />
      ) : (
        <AnimalCreature traits={traits} moving={moving} isPlayer />
      )}
    </group>
  );
}
