/**
 * miniIslands — a scattered archipelago of tiny landable floating rocks.
 *
 * Inspired by the Vibeverse poster: small grassy islets drifting between
 * the bigger landmarks (plaza, Cardboard Island, moons, Mars). Each is
 * landable via a flat top-pad collision box and slowly bobs in place.
 *
 * Themes:
 *   - "tree"    — a lone hero tree on a grassy rock
 *   - "pagoda"  — a tiny red pagoda (nod to the poster)
 *   - "arch"    — a stone archway (mini torii)
 *   - "grove"   — a cluster of little trees + boulders
 *   - "lantern" — a single glowing lantern rock (magical vibe)
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

export interface MiniIslandsWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Landing pad centers, in world coords — used for fast-travel + POIs. */
  pads: { key: string; name: string; pos: THREE.Vector3 }[];
}

type Theme = "tree" | "pagoda" | "arch" | "grove" | "lantern";

interface Spec {
  key: string;
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  theme: Theme;
}

// A ring of little islands drifting around the plaza, at varied altitudes,
// bridging the plaza with Cardboard Island and the moons.
const SPECS: Spec[] = [
  { key: "islet-lone-tree", name: "Lone Tree Islet", x: 120, y: 55, z: 90, radius: 10, theme: "tree" },
  { key: "islet-pagoda",    name: "Sky Pagoda",      x: -140, y: 80, z: 40, radius: 11, theme: "pagoda" },
  { key: "islet-arch",      name: "Torii Rock",      x: 60, y: 95, z: -140, radius: 9, theme: "arch" },
  { key: "islet-grove",     name: "Little Grove",    x: -80, y: 45, z: -120, radius: 12, theme: "grove" },
  { key: "islet-lantern",   name: "Lantern Rock",    x: 220, y: 120, z: -40, radius: 8, theme: "lantern" },
  { key: "islet-mini-1",    name: "Cloud Stone",     x: -220, y: 65, z: 160, radius: 7, theme: "tree" },
];

function makeRock(radius: number): THREE.Group {
  const g = new THREE.Group();
  // Grass cap
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.9, 1.2, 20),
    new THREE.MeshStandardMaterial({ color: 0x6fb04a, roughness: 0.9 }),
  );
  cap.position.y = 0;
  cap.receiveShadow = true;
  cap.castShadow = true;
  g.add(cap);
  // Dirt underside cone (upside-down chunk of floating land)
  const dirt = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.95, radius * 1.8, 14, 3, true),
    new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 }),
  );
  dirt.rotation.x = Math.PI;
  dirt.position.y = -radius * 0.95 - 0.5;
  dirt.castShadow = true;
  g.add(dirt);
  // A couple of dangling roots for that Vibeverse dangle
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.random();
    const r = radius * 0.75;
    const len = 2 + Math.random() * radius * 0.6;
    const root = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.05, len, 5),
      new THREE.MeshStandardMaterial({ color: 0x4e3520 }),
    );
    root.position.set(Math.cos(a) * r, -radius - len / 2, Math.sin(a) * r);
    g.add(root);
  }
  return g;
}

function addLoneTree(g: THREE.Group, radius: number) {
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.6, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x6a4a2a }),
  );
  trunk.position.y = 2.6;
  trunk.castShadow = true;
  g.add(trunk);
  const leaves = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.6, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x4f9d3a, roughness: 0.85 }),
  );
  leaves.position.y = 5.5;
  leaves.scale.y = 1.1;
  leaves.castShadow = true;
  g.add(leaves);
}

function addPagoda(g: THREE.Group) {
  const red = new THREE.MeshStandardMaterial({ color: 0xc03a2a, roughness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.9 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), wood);
  base.position.y = 2.1;
  base.castShadow = true;
  g.add(base);
  for (let i = 0; i < 3; i++) {
    const y = 3.8 + i * 2.2;
    const s = 5 - i * 1.1;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(s, 1.2, 4), red);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = y;
    roof.castShadow = true;
    g.add(roof);
    if (i < 2) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(s - 1.4, 1.4, s - 1.4),
        wood,
      );
      wall.position.y = y + 1;
      g.add(wall);
    }
  }
  const finial = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd66b, emissive: 0xffaa22, emissiveIntensity: 0.4 }),
  );
  finial.position.y = 10.4;
  g.add(finial);
}

function addArch(g: THREE.Group) {
  const stone = new THREE.MeshStandardMaterial({ color: 0xd6cfc0, roughness: 1 });
  const post1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 5, 0.8), stone);
  post1.position.set(-2, 3, 0);
  g.add(post1);
  const post2 = post1.clone();
  post2.position.x = 2;
  g.add(post2);
  const top = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, 1), stone);
  top.position.y = 5.8;
  g.add(top);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 0.6), stone);
  beam.position.y = 5;
  g.add(beam);
}

function addGrove(g: THREE.Group, radius: number) {
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const r = radius * 0.4;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.35, 2.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x6a4a2a }),
    );
    trunk.position.set(Math.cos(a) * r, 1.6, Math.sin(a) * r);
    g.add(trunk);
    const leaves = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x5aa440, roughness: 0.9 }),
    );
    leaves.position.set(Math.cos(a) * r, 3.5, Math.sin(a) * r);
    g.add(leaves);
  }
  // Center boulder
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(1.2, 0),
    new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 1 }),
  );
  rock.position.y = 1.4;
  g.add(rock);
}

function addLantern(g: THREE.Group): THREE.Object3D {
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.2, 3, 6),
    new THREE.MeshStandardMaterial({ color: 0x2a1e14 }),
  );
  post.position.y = 2;
  g.add(post);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 14, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffe6a0,
      emissive: 0xffb84a,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    }),
  );
  bulb.position.y = 3.9;
  g.add(bulb);
  const light = new THREE.PointLight(0xffb84a, 1.4, 24, 2);
  light.position.y = 3.9;
  g.add(light);
  return bulb;
}

export function buildMiniIslands({ boxes }: { boxes: WorldBox[] }): MiniIslandsWorld {
  const root = new THREE.Group();
  const bobbers: { obj: THREE.Object3D; baseY: number; phase: number; amp: number }[] = [];
  const pulsers: { mat: THREE.MeshStandardMaterial; base: number; phase: number }[] = [];
  const pads: MiniIslandsWorld["pads"] = [];

  for (const s of SPECS) {
    const island = new THREE.Group();
    island.position.set(s.x, s.y, s.z);
    root.add(island);

    const rock = makeRock(s.radius);
    island.add(rock);

    switch (s.theme) {
      case "tree":
        addLoneTree(rock, s.radius);
        break;
      case "pagoda":
        addPagoda(rock);
        break;
      case "arch":
        addArch(rock);
        break;
      case "grove":
        addGrove(rock, s.radius);
        break;
      case "lantern": {
        const bulb = addLantern(rock) as THREE.Mesh;
        const mat = bulb.material as THREE.MeshStandardMaterial;
        pulsers.push({ mat, base: 1.4, phase: Math.random() * Math.PI * 2 });
        break;
      }
    }

    // Collision box for the flat grass cap. Slightly smaller than radius so
    // you can't stand on the sloped edges.
    const half = s.radius * 0.75;
    boxes.push({
      minX: s.x - half,
      maxX: s.x + half,
      minZ: s.z - half,
      maxZ: s.z + half,
      base: s.y - 0.6,
      height: 1.2,
    });

    bobbers.push({
      obj: island,
      baseY: s.y,
      phase: Math.random() * Math.PI * 2,
      amp: 0.6 + Math.random() * 0.5,
    });

    pads.push({ key: s.key, name: s.name, pos: new THREE.Vector3(s.x, s.y + 0.6, s.z) });
  }

  return {
    group: root,
    pads,
    update(_dt, now) {
      const t = now * 0.001;
      for (const b of bobbers) {
        b.obj.position.y = b.baseY + Math.sin(t * 0.5 + b.phase) * b.amp;
        b.obj.rotation.y = Math.sin(t * 0.15 + b.phase) * 0.05;
      }
      for (const p of pulsers) {
        p.mat.emissiveIntensity = p.base + Math.sin(t * 2 + p.phase) * 0.4;
      }
    },
  };
}
