/**
 * worldIndex — a tiny in-memory registry of named places, agents, and
 * players so agent residents can answer "what's around me?" and pathfind
 * with `/goto NAME` instead of dead-reckoning by seconds.
 *
 * Stage 1 of the Agent Embodiment Roadmap. Read-only from outside: modules
 * push their landmarks in via `registerPOI`, and `agentResidents` queries
 * `getSnapshot()` / `findPOI()` to drive perception + navigation.
 */
import * as THREE from "three";

export type POIKind = "landmark" | "agent" | "player";

export interface POI {
  key: string;
  name: string;
  aliases: string[]; // lowercase, includes name + key
  region: string;
  position: THREE.Vector3;
  kind: POIKind;
}

const pois = new Map<string, POI>();

export function registerPOI(input: {
  key: string;
  name: string;
  region: string;
  position: THREE.Vector3;
  kind?: POIKind;
  aliases?: string[];
}): void {
  const aliases = (input.aliases ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean);
  aliases.push(input.name.toLowerCase(), input.key.toLowerCase());
  pois.set(input.key, {
    key: input.key,
    name: input.name,
    aliases: Array.from(new Set(aliases)),
    region: input.region,
    position: input.position.clone(),
    kind: input.kind ?? "landmark",
  });
}

export function updatePOIPosition(key: string, x: number, y: number, z: number): void {
  const p = pois.get(key);
  if (p) p.position.set(x, y, z);
}

export function unregisterPOI(key: string): void {
  pois.delete(key);
}

export function listPOIs(kind?: POIKind): POI[] {
  const out: POI[] = [];
  for (const p of pois.values()) {
    if (!kind || p.kind === kind) out.push(p);
  }
  return out;
}

/** Fuzzy-match `query` against registered POI aliases. Higher score wins. */
export function findPOI(query: string): POI | null {
  const q = query.toLowerCase().trim().replace(/[_-]+/g, " ");
  if (!q) return null;
  let best: POI | null = null;
  let bestScore = 0;
  for (const p of pois.values()) {
    for (const a of p.aliases) {
      const an = a.replace(/[_-]+/g, " ");
      let score = 0;
      if (an === q) score = 100;
      else if (an.startsWith(q)) score = 70;
      else if (an.includes(q)) score = 50;
      else if (q.includes(an) && an.length >= 4) score = 35;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return bestScore > 0 ? best : null;
}

function compass(dx: number, dz: number): string {
  // World convention: +Z is south, -Z is north (matches three.js default cam)
  const ang = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = N, 90 = E
  const norm = (ang + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(norm / 45) % 8];
}

export interface SnapshotItem {
  name: string;
  region: string;
  direction: string;
  distance: number;
}

export interface Snapshot {
  region: string;
  facing?: string;
  landmarks: SnapshotItem[];
  agents: SnapshotItem[];
}

export function getSnapshot(
  pos: { x: number; y: number; z: number },
  opts: { yaw?: number; maxLandmarks?: number; maxAgents?: number; radius?: number; ignoreKey?: string } = {},
): Snapshot {
  const { yaw, maxLandmarks = 8, maxAgents = 6, radius = 120, ignoreKey } = opts;
  const items: { poi: POI; dist: number; dir: string }[] = [];
  let region = "the vibeverse";
  let bestRegionDist = Infinity;
  for (const p of pois.values()) {
    if (p.key === ignoreKey) continue;
    const dx = p.position.x - pos.x;
    const dz = p.position.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (p.kind === "landmark" && dist < bestRegionDist) {
      bestRegionDist = dist;
      region = p.region;
    }
    if (dist > radius) continue;
    items.push({ poi: p, dist, dir: compass(dx, dz) });
  }
  items.sort((a, b) => a.dist - b.dist);
  const toItem = (e: { poi: POI; dist: number; dir: string }): SnapshotItem => ({
    name: e.poi.name,
    region: e.poi.region,
    direction: e.dir,
    distance: Math.round(e.dist),
  });
  const landmarks = items.filter((e) => e.poi.kind === "landmark").slice(0, maxLandmarks).map(toItem);
  const agents = items.filter((e) => e.poi.kind === "agent").slice(0, maxAgents).map(toItem);
  const facing = yaw != null ? compass(Math.sin(yaw), Math.cos(yaw)) : undefined;
  return { region, facing, landmarks, agents };
}

/** Format a snapshot as compact human-readable lines for prompts/UI. */
export function formatSnapshot(s: Snapshot): string {
  const lines: string[] = [];
  lines.push(`You are in ${s.region}${s.facing ? `, facing ${s.facing}` : ""}.`);
  if (s.landmarks.length) {
    lines.push("Nearby landmarks:");
    for (const l of s.landmarks) lines.push(`  • ${l.name} — ${l.distance}m ${l.direction}`);
  }
  if (s.agents.length) {
    lines.push("Nearby agents:");
    for (const a of s.agents) lines.push(`  • ${a.name} — ${a.distance}m ${a.direction}`);
  }
  return lines.join("\n");
}
