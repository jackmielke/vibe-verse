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
import { HAT_ITEMS, FLAME_ITEMS, JETPACK_ITEMS } from "@/lib/cosmeticCatalog";
import { equip } from "@/lib/wardrobe";

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

function buildStickerHat(): THREE.Group {
  const g = new THREE.Group();
  // Holographic sticker-pack hat: chrome dome with rainbow emissive stickers.
  const chrome = new THREE.MeshStandardMaterial({
    color: "#f8fbff", roughness: 0.15, metalness: 0.95,
    emissive: "#7dfce0", emissiveIntensity: 0.25,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), chrome);
  dome.position.y = 0.05; g.add(dome);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 28), chrome);
  brim.position.y = 0.05; g.add(brim);
  // Glowing star stickers around the crown.
  const colors = ["#ff6ad5", "#c084fc", "#7dfce0", "#ffd166", "#5db8e8"];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const c = colors[i % colors.length];
    const star = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.06, 0),
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.4 }),
    );
    star.position.set(Math.cos(a) * 0.34, 0.18 + Math.sin(a * 2) * 0.06, Math.sin(a) * 0.34);
    g.add(star);
  }
  // Sparkle on top.
  const top = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09, 0),
    new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ff6ad5", emissiveIntensity: 1.8, roughness: 0.2, metalness: 0.6 }),
  );
  top.position.y = 0.46;
  g.add(top);
  return g;
}

/**
 * Hats, with their geometry attached.
 *
 * The list itself now lives in `@/lib/cosmeticCatalog` — ids, names and prices
 * are data the shop needs without a 3D engine, and money that is written down
 * twice drifts. This file's job is the half that genuinely needs Three: which
 * builder draws each one.
 */

/**
 * A bucket hat: a soft brim that flares rather than sticking straight out.
 *
 * Two truncated cones and a torus. The brim is the point — it has to droop, or
 * it reads as a bin lid, and a drooping brim is what makes a hat look like
 * fabric instead of like a primitive.
 */
function buildBucket(): THREE.Group {
  const g = new THREE.Group();
  const cloth = mkMat("#5b8c6e", { roughness: 0.95 });
  const dark = mkMat("#3d6350", { roughness: 0.95 });
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.26, 24, 1), cloth);
  crown.position.y = 0.15;
  g.add(crown);
  // Flared and tilted DOWN — a bucket brim points at the floor, not at the
  // horizon, and that silhouette is the whole hat.
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.52, 0.04, 24, 1, true), dark);
  brim.position.y = 0.03;
  g.add(brim);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.025, 6, 28), dark);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.015;
  g.add(lip);
  const seam = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.018, 6, 24), dark);
  seam.rotation.x = Math.PI / 2;
  seam.position.y = 0.09;
  g.add(seam);
  return g;
}

/**
 * Studio headphones — the one that most obviously proves the hat is on the
 * head rather than floating over it, because the cups sit at the sides and a
 * head turn swings them through the camera.
 */
function buildCans(): THREE.Group {
  const g = new THREE.Group();
  const shell = mkMat("#20242e", { roughness: 0.45 });
  const pad = mkMat("#12151c", { roughness: 0.95 });
  const trim = mkMat("#2dd4a8", { roughness: 0.3, emissive: "#0d6b53", emissiveIntensity: 0.6 });
  // The arc already runs +X to -X over the top — ear to ear, which is where a
  // headband goes. Rotating it a quarter turn stands it up front-to-back and
  // gives the character a fin.
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 22, Math.PI), shell);
  band.position.y = 0.02;
  g.add(band);
  const bandTrim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 6, 22, Math.PI), trim);
  bandTrim.position.y = 0.035;
  g.add(bandTrim);
  for (const side of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.08, 20), shell);
    cup.rotation.z = Math.PI / 2;
    cup.position.set(side * 0.3, -0.16, 0);
    g.add(cup);
    const ear = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.035, 8, 18), pad);
    ear.rotation.y = Math.PI / 2;
    ear.position.set(side * 0.26, -0.16, 0);
    g.add(ear);
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.09, 12), trim);
    dot.rotation.z = Math.PI / 2;
    dot.position.set(side * 0.335, -0.16, 0);
    g.add(dot);
  }
  return g;
}

/**
 * A wraparound visor. Transparent, which the rest of the catalogue is not, and
 * it is the reason the sheet is a separate mesh from the strap: one wants to be
 * see-through and lit, the other does not.
 */
function buildVisor(): THREE.Group {
  const g = new THREE.Group();
  // The mount sits at the CROWN, because that is where hats go. A visor goes
  // across the eyes, which on these characters is about twenty centimetres
  // further down — without this it reads as a headband and the sheet, which is
  // the whole item, is edge-on to the camera and invisible.
  g.position.y = -0.2;
  const strap = mkMat("#171b24", { roughness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({
    color: "#7dfce0",
    roughness: 0.12,
    metalness: 0.35,
    transparent: true,
    opacity: 0.55,
    emissive: "#0f5f52",
    emissiveIntensity: 0.7,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.04, 8, 26), strap);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);
  // A partial cylinder across the front, tipped forward so it follows a brow.
  const sheet = new THREE.Mesh(
    new THREE.CylinderGeometry(0.33, 0.33, 0.19, 26, 1, true, -1.15, 2.3),
    glass,
  );
  sheet.position.set(0, 0.0, 0);
  sheet.rotation.x = -0.12;
  g.add(sheet);
  const brow = new THREE.Mesh(new THREE.TorusGeometry(0.315, 0.02, 6, 26, 2.3), strap);
  brow.rotation.set(Math.PI / 2, 0, -1.15);
  brow.position.y = 0.1;
  g.add(brow);
  return g;
}

const HAT_BUILDERS: Record<string, () => THREE.Group> = {
  none: () => new THREE.Group(),
  cap: buildCap,
  beanie: buildBeanie,
  tophat: buildTopHat,
  party: buildPartyHat,
  propeller: buildPropeller,
  crown: buildCrown,
  halo: buildHalo,
  sticker: buildStickerHat,
  bucket: buildBucket,
  cans: buildCans,
  visor: buildVisor,
};

export const HAT_CATALOG: HatDef[] = HAT_ITEMS.map((i) => ({
  ...i,
  build: () => {
    const g = (HAT_BUILDERS[i.id] ?? (() => new THREE.Group()))();
    // A hat with no shadow is a hat sitting a centimetre off the head no
    // matter how well it is mounted — the contact shadow is what puts an
    // object ON another object, and the avatar has cast shadows since the day
    // the sun was added.
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    return g;
  },
}));

// ---- Unlocks (cosmetics earned via on-chain purchases) ------------------
const UNLOCK_STORAGE = "city.unlockedHats";

export function loadUnlockedHats(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(UNLOCK_STORAGE);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

export function unlockHat(id: string, account?: string | null) {
  if (typeof window === "undefined") return;
  try {
    const cur = new Set(loadUnlockedHats());
    cur.add(id);
    localStorage.setItem(UNLOCK_STORAGE, JSON.stringify([...cur]));
    if (account) {
      const key = `city.unlockedHats:${account.toLowerCase()}`;
      localStorage.setItem(key, JSON.stringify([...cur]));
    }
  } catch { /* ignore quota */ }
}

export const FLAME_CATALOG: FlameDef[] = FLAME_ITEMS;

export const JETPACK_CATALOG: JetpackDef[] = JETPACK_ITEMS;

/**
 * Equipping, from anywhere.
 *
 * These three used to be the whole persistence story: a localStorage write and
 * nothing else. Now that a hat can be *owned* they forward to the wardrobe,
 * which records the change against the wallet and re-checks that you actually
 * bought the thing — so City's in-world picker and the shop at /shop end up
 * telling the same story without City having to know the ledger exists.
 *
 * Fire-and-forget on purpose: putting a hat on should not wait on a network
 * round trip, and `equip()` rolls its own optimistic state back if the server
 * says no.
 */
export function loadEquippedHat(): string {
  if (typeof window === "undefined") return "none";
  return localStorage.getItem(HAT_STORAGE) || "none";
}

export function saveEquippedHat(id: string) {
  try { localStorage.setItem(HAT_STORAGE, id); } catch { /* ignore quota */ }
  void equip({ hat: id });
}

export function loadEquippedFlame(): string {
  if (typeof window === "undefined") return "mint";
  return localStorage.getItem(FLAME_STORAGE) || "mint";
}

export function saveEquippedFlame(id: string) {
  try { localStorage.setItem(FLAME_STORAGE, id); } catch { /* ignore quota */ }
  void equip({ flame: id });
}

export function loadEquippedJetpack(): string {
  if (typeof window === "undefined") return "stock";
  return localStorage.getItem(JETPACK_STORAGE) || "stock";
}

export function saveEquippedJetpack(id: string) {
  try { localStorage.setItem(JETPACK_STORAGE, id); } catch { /* ignore quota */ }
  void equip({ jetpack: id });
}
