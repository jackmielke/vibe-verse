/**
 * City cosmetics — purely procedural hats + jetpack flame colors that
 * can be equipped on the player. Everything is built from Three.js
 * primitives so there is no GLB to download and the catalog stays
 * easy to extend.
 *
 * Persistence: the equipped IDs live in localStorage so the look is
 * sticky across sessions. The shop in /city is where you change them.
 */
import * as THREE from "three";

export interface HatDef {
  id: string;
  name: string;
  emoji: string;
  /** Headline price in vibe coin (currently free during early access). */
  price: number;
  build(): THREE.Group;
}

export interface FlameDef {
  id: string;
  name: string;
  emoji: string;
  price: number;
  /** Plume color */
  color: string;
  /** Inner core / light tint */
  core: string;
}

export interface JetpackDef {
  id: string;
  name: string;
  emoji: string;
  price: number;
  /** When false the pack is hidden and thrust is disabled. */
  equipped: boolean;
  /** Main shell color (ignored when equipped=false). */
  body: string;
  /** Trim / collar accent. */
  trim: string;
}

const HAT_STORAGE = "city.hat";
const FLAME_STORAGE = "city.flame";
const JETPACK_STORAGE = "city.jetpack";

// ---- Hat factories ------------------------------------------------------
// All hats are sized for a head sitting at ~y = 1.65–1.75 above the
// player root. They get parented to `modelHolder` so they tilt with
// the pilot's flight pose.

const mkMat = (color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...opts });

function buildTopHat(): THREE.Group {
  const g = new THREE.Group();
  const black = mkMat("#1a1a22", { roughness: 0.45 });
  const band = mkMat("#d12a5b", { roughness: 0.5 });
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 24), black);
  brim.position.y = 0.02;
  g.add(brim);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.30, 0.55, 24), black);
  crown.position.y = 0.32;
  g.add(crown);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.305, 0.305, 0.07, 24), band);
  ring.position.y = 0.07;
  g.add(ring);
  return g;
}

function buildCap(): THREE.Group {
  const g = new THREE.Group();
  const mat = mkMat("#2dd4a8", { roughness: 0.7 });
  const trim = mkMat("#0f1722", { roughness: 0.6 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.position.y = 0.05;
  g.add(dome);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.34), trim);
  brim.position.set(0, 0.06, 0.24);
  g.add(brim);
  return g;
}

function buildBeanie(): THREE.Group {
  const g = new THREE.Group();
  const yarn = mkMat("#e85d75", { roughness: 0.9 });
  const cuff = mkMat("#ffd166", { roughness: 0.85 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), yarn);
  dome.position.y = 0.06;
  g.add(dome);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.05, 8, 24), cuff);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.04;
  g.add(rim);
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), cuff);
  pom.position.y = 0.4;
  g.add(pom);
  return g;
}

function buildCrown(): THREE.Group {
  const g = new THREE.Group();
  const gold = mkMat("#ffd166", { roughness: 0.25, metalness: 0.8, emissive: "#5a4400", emissiveIntensity: 0.3 });
  const gem = mkMat("#e85d75", { roughness: 0.2, emissive: "#7a1532", emissiveIntensity: 0.4 });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.16, 24, 1, true), gold);
  band.position.y = 0.1;
  g.add(band);
  // Five spikes
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 8), gold);
    spike.position.set(Math.cos(a) * 0.3, 0.28, Math.sin(a) * 0.3);
    g.add(spike);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), gem);
    ball.position.set(Math.cos(a) * 0.3, 0.41, Math.sin(a) * 0.3);
    g.add(ball);
  }
  return g;
}

function buildPartyHat(): THREE.Group {
  const g = new THREE.Group();
  const cone = mkMat("#7dd3fc", { roughness: 0.4, emissive: "#0a3b54", emissiveIntensity: 0.3 });
  const stripe = mkMat("#fde68a", { roughness: 0.5 });
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.65, 24), cone);
  c.position.y = 0.35;
  g.add(c);
  for (let i = 0; i < 3; i++) {
    const r = 0.27 - i * 0.07;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.022, 8, 32), stripe);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08 + i * 0.16;
    g.add(ring);
  }
  const pop = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), stripe);
  pop.position.y = 0.72;
  g.add(pop);
  return g;
}

function buildHalo(): THREE.Group {
  const g = new THREE.Group();
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, 0.035, 12, 48),
    new THREE.MeshStandardMaterial({
      color: "#fff7c2",
      emissive: "#fde68a",
      emissiveIntensity: 1.5,
      roughness: 0.2,
      metalness: 0.6,
    }),
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.5;
  g.add(halo);
  return g;
}

function buildPropeller(): THREE.Group {
  const g = new THREE.Group();
  const red = mkMat("#e85d75", { roughness: 0.5 });
  const blue = mkMat("#5db8e8", { roughness: 0.5 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), red);
  dome.position.y = 0.04;
  g.add(dome);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 6), mkMat("#222"));
  stick.position.y = 0.36;
  g.add(stick);
  const blade = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.018, 0.06), blue);
    b.position.x = 0.13;
    const arm = new THREE.Group();
    arm.add(b);
    arm.rotation.y = (i / 3) * Math.PI * 2;
    blade.add(arm);
  }
  blade.position.y = 0.45;
  blade.name = "spin";
  g.add(blade);
  return g;
}

export const HAT_CATALOG: HatDef[] = [
  { id: "none",       name: "No Hat",       emoji: "🙅", price: 0,   build: () => new THREE.Group() },
  { id: "cap",        name: "Mint Cap",     emoji: "🧢", price: 25,  build: buildCap },
  { id: "beanie",     name: "Pom Beanie",   emoji: "🤠", price: 35,  build: buildBeanie },
  { id: "tophat",     name: "Top Hat",      emoji: "🎩", price: 75,  build: buildTopHat },
  { id: "party",      name: "Party Cone",   emoji: "🥳", price: 60,  build: buildPartyHat },
  { id: "propeller",  name: "Propeller",    emoji: "🚁", price: 90,  build: buildPropeller },
  { id: "crown",      name: "Crown",        emoji: "👑", price: 250, build: buildCrown },
  { id: "halo",       name: "Halo",         emoji: "😇", price: 400, build: buildHalo },
];

export const FLAME_CATALOG: FlameDef[] = [
  { id: "mint",   name: "Mint Stock",   emoji: "🌿", price: 0,   color: "#7dfce0", core: "#7dfce0" },
  { id: "fire",   name: "Fire Boost",   emoji: "🔥", price: 50,  color: "#ff8a3d", core: "#ffd166" },
  { id: "violet", name: "Violet Pulse", emoji: "💜", price: 80,  color: "#c084fc", core: "#f0abfc" },
  { id: "magma",  name: "Magma Roar",   emoji: "🌋", price: 120, color: "#e85d75", core: "#ffd166" },
  { id: "ion",    name: "Ion Cyan",     emoji: "⚡", price: 150, color: "#5db8e8", core: "#baffe9" },
  { id: "rainbow",name: "Rainbow",      emoji: "🌈", price: 300, color: "#ffffff", core: "#ffffff" }, // animated upstream
];

export function loadEquippedHat(): string {
  if (typeof window === "undefined") return "none";
  return localStorage.getItem(HAT_STORAGE) || "none";
}

export function saveEquippedHat(id: string) {
  try { localStorage.setItem(HAT_STORAGE, id); } catch { /* ignore quota */ }
}

export function loadEquippedFlame(): string {
  if (typeof window === "undefined") return "mint";
  return localStorage.getItem(FLAME_STORAGE) || "mint";
}

export function saveEquippedFlame(id: string) {
  try { localStorage.setItem(FLAME_STORAGE, id); } catch { /* ignore quota */ }
}
