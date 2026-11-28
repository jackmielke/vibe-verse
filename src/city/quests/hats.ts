/**
 * Hats you cannot buy. Granny Mabel pays for each pet you bring home with one
 * of these, and they are kept on this device (`city.questHats`), outside the
 * shop's ledger: the shop sells things, this is a thank-you.
 */
import * as THREE from "three";

export interface QuestHat {
  id: string;
  name: string;
  emoji: string;
  build(): THREE.Group;
}

const STORE = "city.questHats";
const WORN = "city.questHat";

function m(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts });
}

function add(g: THREE.Group, geo: THREE.BufferGeometry, mt: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, mt);
  o.position.set(x, y, z);
  o.castShadow = true;
  g.add(o);
  return o;
}

/** A plum felt fedora with a band and a long pheasant feather. */
function fedora() {
  const g = new THREE.Group();
  const felt = m("#5b2a86", { roughness: 0.85 });
  add(g, new THREE.CylinderGeometry(0.42, 0.44, 0.03, 28), felt, 0, 0.0, 0);
  const crown = add(g, new THREE.CylinderGeometry(0.22, 0.27, 0.26, 24), felt, 0, 0.14, 0);
  crown.scale.z = 0.85;
  // The pinch in the crown.
  add(g, new THREE.BoxGeometry(0.04, 0.05, 0.3), m("#4a2070"), 0, 0.27, 0);
  add(g, new THREE.CylinderGeometry(0.272, 0.272, 0.06, 24, 1, true), m("#f2c14e", { metalness: 0.4 }), 0, 0.05, 0).scale.z = 0.86;
  const feather = new THREE.Group();
  feather.position.set(0.24, 0.08, -0.05);
  feather.rotation.set(-0.3, 0, -0.6);
  const vane = add(feather, new THREE.SphereGeometry(0.06, 10, 8), m("#c2410c", { side: THREE.DoubleSide }), 0, 0.22, 0);
  vane.scale.set(0.35, 4, 0.08);
  add(feather, new THREE.CylinderGeometry(0.006, 0.006, 0.5, 4), m("#fef3c7"), 0, 0.22, 0.01);
  add(feather, new THREE.SphereGeometry(0.035, 8, 6), m("#0e7490"), 0, 0.34, 0.01).scale.set(0.6, 1.4, 0.3);
  g.add(feather);
  return g;
}

/** A white captain's hat with a gold anchor and braid. */
function captain() {
  const g = new THREE.Group();
  const white = m("#f8fafc", { roughness: 0.5 });
  const navy = m("#1e2a4a", { roughness: 0.6 });
  const gold = m("#fbbf24", { metalness: 0.8, roughness: 0.25 });
  add(g, new THREE.CylinderGeometry(0.3, 0.29, 0.12, 24), navy, 0, 0.06, 0);
  const top = add(g, new THREE.CylinderGeometry(0.36, 0.3, 0.12, 24), white, 0, 0.18, 0);
  top.scale.z = 0.95;
  const peak = add(g, new THREE.CylinderGeometry(0.22, 0.22, 0.02, 20, 1, false, -Math.PI / 2, Math.PI), m("#0b0f1a", { roughness: 0.2 }), 0, 0.01, 0.12);
  peak.rotation.x = 0.2;
  add(g, new THREE.TorusGeometry(0.3, 0.012, 6, 28), gold, 0, 0.1, 0).rotation.x = Math.PI / 2;
  const anchor = new THREE.Group();
  anchor.position.set(0, 0.14, 0.3);
  add(anchor, new THREE.BoxGeometry(0.02, 0.09, 0.01), gold);
  add(anchor, new THREE.TorusGeometry(0.035, 0.008, 4, 12, Math.PI), gold, 0, -0.03, 0).rotation.z = Math.PI;
  add(anchor, new THREE.TorusGeometry(0.014, 0.006, 4, 10), gold, 0, 0.055, 0);
  g.add(anchor);
  return g;
}

/** A tall starry wizard's hat, slightly bent, with a glowing band. */
function wizard() {
  const g = new THREE.Group();
  const cloth = m("#1e3a8a", { roughness: 0.9 });
  add(g, new THREE.CylinderGeometry(0.44, 0.46, 0.03, 28), cloth, 0, 0, 0);
  const low = add(g, new THREE.ConeGeometry(0.27, 0.42, 22, 1, true), cloth, 0, 0.22, 0);
  low.material = cloth;
  const tip = add(g, new THREE.ConeGeometry(0.13, 0.36, 16), cloth, 0.06, 0.55, -0.02);
  tip.rotation.z = -0.45;
  add(g, new THREE.CylinderGeometry(0.25, 0.25, 0.05, 22, 1, true), m("#fde047", { emissive: "#facc15", emissiveIntensity: 0.9 }), 0, 0.06, 0);
  const star = m("#fef08a", { emissive: "#fde047", emissiveIntensity: 1.2 });
  for (const [x, y, z] of [[0.17, 0.2, 0.12], [-0.12, 0.3, 0.12], [0.05, 0.38, -0.12], [-0.16, 0.16, -0.1]]) {
    add(g, new THREE.OctahedronGeometry(0.03), star, x, y, z);
  }
  add(g, new THREE.OctahedronGeometry(0.05), star, 0.2, 0.68, -0.02);
  return g;
}

/** Vibe Arcade prize: a neon crown, glowing points and a jewel. */
function neonCrown() {
  const g = new THREE.Group();
  const gold = m("#fbbf24", { metalness: 0.7, roughness: 0.25, emissive: "#b45309", emissiveIntensity: 0.35 });
  const glow = m("#ff3fd1", { emissive: "#ff3fd1", emissiveIntensity: 1.4 });
  add(g, new THREE.CylinderGeometry(0.27, 0.28, 0.12, 24, 1, true), gold, 0, 0.06, 0).material = gold;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spike = add(g, new THREE.ConeGeometry(0.06, 0.16, 4), gold, Math.sin(a) * 0.26, 0.2, Math.cos(a) * 0.26);
    spike.rotation.y = a;
    add(g, new THREE.SphereGeometry(0.03, 8, 6), i % 2 ? glow : m("#38e8ff", { emissive: "#38e8ff", emissiveIntensity: 1.4 }), Math.sin(a) * 0.26, 0.3, Math.cos(a) * 0.26);
  }
  add(g, new THREE.TorusGeometry(0.275, 0.014, 6, 30), glow, 0, 0.01, 0).rotation.x = Math.PI / 2;
  add(g, new THREE.OctahedronGeometry(0.05), glow, 0, 0.08, 0.28);
  return g;
}

/** Vibe Arcade prize: a red and yellow propeller beanie. */
function propeller() {
  const g = new THREE.Group();
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.29, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), m("#d8283a"));
  g.add(cap);
  const stripe = new THREE.Mesh(new THREE.SphereGeometry(0.292, 22, 12, 0, Math.PI / 3, 0, Math.PI / 2), m("#ffe14d"));
  g.add(stripe);
  const stripe2 = stripe.clone();
  stripe2.rotation.y = Math.PI;
  g.add(stripe2);
  add(g, new THREE.CylinderGeometry(0.015, 0.015, 0.1, 6), m("#d8dde6", { metalness: 0.8, roughness: 0.3 }), 0, 0.33, 0);
  const blades = new THREE.Group();
  blades.position.y = 0.38;
  blades.name = "propeller";
  for (const [c, r] of [["#2c6cf0", 0], ["#7cff6b", Math.PI]] as const) {
    const b = add(blades, new THREE.BoxGeometry(0.26, 0.012, 0.06), m(c));
    b.position.x = Math.cos(r) * 0.13;
  }
  blades.rotation.y = 0.6;
  g.add(blades);
  return g;
}

/** Vibe Arcade prize: a wraparound neon visor that sits on the brow. */
function visor() {
  const g = new THREE.Group();
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.07, 26, 1, true, -1.2, 2.4), m("#15151c", { side: THREE.DoubleSide, metalness: 0.4, roughness: 0.3 }));
  band.position.y = -0.12;
  g.add(band);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.09, 26, 1, true, -1.05, 2.1),
    new THREE.MeshStandardMaterial({ color: "#38e8ff", emissive: "#38e8ff", emissiveIntensity: 0.9, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
  );
  lens.position.y = -0.2;
  g.add(lens);
  add(g, new THREE.TorusGeometry(0.3, 0.008, 4, 30, 2.1), m("#ff3fd1", { emissive: "#ff3fd1", emissiveIntensity: 1.4 }), 0, -0.155, 0).rotation.set(Math.PI / 2, 0, Math.PI / 2 - 1.05);
  return g;
}

export const QUEST_HATS: QuestHat[] = [
  { id: "fedora", name: "Mabel's Feathered Fedora", emoji: "🪶", build: fedora },
  { id: "captain", name: "Captain's Cap", emoji: "⚓", build: captain },
  { id: "wizard", name: "Starry Wizard Hat", emoji: "🧙", build: wizard },
  // Prizes from the Vibe Arcade's counter (src/arcade/tickets.ts).
  { id: "visor", name: "Arcade Visor", emoji: "🕶️", build: visor },
  { id: "propeller", name: "Propeller Beanie", emoji: "🧢", build: propeller },
  { id: "neon-crown", name: "Neon Crown", emoji: "👑", build: neonCrown },
];

/** The hats won at the Vibe Arcade's prize counter rather than from Granny. */
export const ARCADE_HAT_IDS = ["visor", "propeller", "neon-crown"];

export function questHat(id: string | null): QuestHat | null {
  return QUEST_HATS.find((h) => h.id === id) ?? null;
}

export function earnedQuestHats(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function earnQuestHat(id: string) {
  try {
    const s = new Set(earnedQuestHats());
    s.add(id);
    localStorage.setItem(STORE, JSON.stringify([...s]));
  } catch {
    /* quota */
  }
}

export function wornQuestHat(): string | null {
  try {
    const id = localStorage.getItem(WORN);
    return id && earnedQuestHats().includes(id) ? id : null;
  } catch {
    return null;
  }
}

export function setWornQuestHat(id: string | null) {
  try {
    if (id) localStorage.setItem(WORN, id);
    else localStorage.removeItem(WORN);
  } catch {
    /* quota */
  }
}
