/**
 * islandSpawns — render + manage the player-spawned 3D primitives that
 * live around the Vibe Maker portal on Cardboard Island.
 *
 * Rows live in public.island_spawns (see migration). Everyone reads,
 * authenticated users create, only the creator deletes. Realtime is
 * enabled on the table, so spawns appear/disappear live for all peers.
 */
import * as THREE from "three";

export type SpawnKind =
  | "cube"
  | "sphere"
  | "torus"
  | "cone"
  | "pyramid"
  | "tetra";

export interface IslandSpawnRow {
  id: string;
  user_id: string;
  kind: SpawnKind;
  color: string;
  label: string | null;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  rot_y: number;
  scale: number;
  created_at: string;
}

export const SPAWN_KINDS: { id: SpawnKind; emoji: string; label: string }[] = [
  { id: "cube", emoji: "🟦", label: "Cube" },
  { id: "sphere", emoji: "🟢", label: "Sphere" },
  { id: "torus", emoji: "🍩", label: "Torus" },
  { id: "cone", emoji: "🔺", label: "Cone" },
  { id: "pyramid", emoji: "🔻", label: "Pyramid" },
  { id: "tetra", emoji: "🔷", label: "Tetra" },
];

export const SPAWN_PALETTE = [
  "#2dd4a8",
  "#b78aff",
  "#ffd166",
  "#e85d75",
  "#5db8e8",
  "#8cd16a",
  "#ff9f5a",
  "#ffffff",
];

const KIND_WORDS: Array<[RegExp, SpawnKind]> = [
  [/cube|box|block/i, "cube"],
  [/sphere|ball|orb|moon/i, "sphere"],
  [/torus|donut|doughnut|ring/i, "torus"],
  [/cone|tower|spike/i, "cone"],
  [/pyramid|tri\b/i, "pyramid"],
  [/tetra|diamond|crystal|gem/i, "tetra"],
];

const COLOR_WORDS: Array<[RegExp, string]> = [
  [/mint|teal|cyan/i, "#2dd4a8"],
  [/purple|violet|magenta/i, "#b78aff"],
  [/yellow|gold|amber/i, "#ffd166"],
  [/red|pink|coral|crimson/i, "#e85d75"],
  [/blue|sky|azure/i, "#5db8e8"],
  [/green|lime|leaf/i, "#8cd16a"],
  [/orange/i, "#ff9f5a"],
  [/white|cream/i, "#ffffff"],
  [/black|dark|shadow/i, "#222831"],
];

export function parsePrompt(
  text: string,
  fallbackKind: SpawnKind,
  fallbackColor: string,
): { kind: SpawnKind; color: string; label: string | null } {
  const clean = text.trim();
  let kind = fallbackKind;
  let color = fallbackColor;
  for (const [re, k] of KIND_WORDS) if (re.test(clean)) { kind = k; break; }
  for (const [re, c] of COLOR_WORDS) if (re.test(clean)) { color = c; break; }
  return { kind, color, label: clean ? clean.slice(0, 80) : null };
}

function geomFor(kind: SpawnKind): THREE.BufferGeometry {
  switch (kind) {
    case "cube":
      return new THREE.BoxGeometry(1, 1, 1);
    case "sphere":
      return new THREE.SphereGeometry(0.6, 24, 18);
    case "torus":
      return new THREE.TorusGeometry(0.55, 0.2, 14, 28);
    case "cone":
      return new THREE.ConeGeometry(0.55, 1.2, 20);
    case "pyramid":
      return new THREE.ConeGeometry(0.7, 1, 4);
    case "tetra":
      return new THREE.TetrahedronGeometry(0.75);
  }
}

/** Build the three.js group for a single spawn row, positioned relative
 *  to the portal anchor (caller adds it to a group at the portal world
 *  position). Label floats above the shape as a small sprite. */
export function createSpawnMesh(row: IslandSpawnRow): THREE.Group {
  const group = new THREE.Group();
  group.userData.spawnId = row.id;
  group.userData.userId = row.user_id;

  const mat = new THREE.MeshStandardMaterial({
    color: row.color,
    emissive: row.color,
    emissiveIntensity: 0.45,
    roughness: 0.4,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(geomFor(row.kind), mat);
  mesh.position.y = 0.6 * row.scale;
  mesh.scale.setScalar(row.scale);
  mesh.rotation.y = row.rot_y;
  group.add(mesh);
  group.userData.bobMesh = mesh;
  group.userData.bobBaseY = mesh.position.y;
  group.userData.spin = 0.4 + Math.random() * 0.6;

  if (row.label) {
    const sprite = makeLabelSprite(row.label);
    sprite.position.y = 1.4 * row.scale + 0.3;
    group.add(sprite);
  }

  group.position.set(row.pos_x, row.pos_y, row.pos_z);
  return group;
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 96);
  ctx.font = "bold 38px 'Manrope', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#f0fff8";
  const shown = text.length > 32 ? text.slice(0, 30) + "…" : text;
  ctx.fillText(shown, 256, 48);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.4, 0.45, 1);
  return sprite;
}

/** Animate the spawn-cluster: each child bobs + slowly rotates. */
export function updateSpawns(spawnsGroup: THREE.Group, dt: number, now: number): void {
  spawnsGroup.children.forEach((child, i) => {
    const bob = child.userData.bobMesh as THREE.Mesh | undefined;
    if (bob) {
      const base = child.userData.bobBaseY as number;
      bob.position.y = base + Math.sin(now * 0.002 + i) * 0.15;
      bob.rotation.y += dt * (child.userData.spin as number);
    }
  });
}

/** Pick a deterministic offset around the portal for a fresh spawn so
 *  new things don't all stack on the same spot. Caller picks position
 *  randomly; this just gives a sane default. */
export function pickSpawnOffset(): { pos_x: number; pos_y: number; pos_z: number; rot_y: number } {
  const angle = Math.random() * Math.PI * 2;
  const radius = 2.4 + Math.random() * 3.5;
  return {
    pos_x: Math.cos(angle) * radius,
    pos_y: 0,
    pos_z: Math.sin(angle) * radius,
    rot_y: Math.random() * Math.PI * 2,
  };
}
