/**
 * The other players in the valley, as whoever they picked.
 *
 * Each peer is their roster character (the same `createAvatar` Oni uses, so
 * a body, a name over the head, and horns during a game of tag). A player on
 * an older page that does not say who they are gets a character hashed from
 * their id, so they are still somebody rather than a capsule.
 *
 * Bodies ease toward the last presence heard, so eight packets a second
 * look like walking.
 */
import * as THREE from "three";
import { CHARACTERS } from "@/lib/characters";
import { createAvatar, type Avatar } from "@/oni/world/avatars";
import { hash } from "@/oni/rules";
import type { PeerPresence } from "../net";

export interface Peers {
  group: THREE.Group;
  sync(list: PeerPresence[]): void;
  update(dt: number, time: number, groundAt: (x: number, z: number) => number, isOni?: (id: string) => boolean): void;
  count(): number;
  /** Where everybody is drawn right now, for tag. */
  positions(): Array<{ id: string; x: number; y: number; z: number }>;
  emote(id: string, e: string): void;
  dispose(): void;
}

interface Ghost {
  avatar: Avatar;
  target: THREE.Vector3;
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
}

export function charFor(p: { id: string; char?: string }): string {
  if (p.char && CHARACTERS.some((c) => c.id === p.char)) return p.char;
  return CHARACTERS[hash(p.id) % CHARACTERS.length].id;
}

export function createPeers(): Peers {
  const group = new THREE.Group();
  const ghosts = new Map<string, Ghost>();

  return {
    group,
    sync(list) {
      const seen = new Set<string>();
      for (const p of list) {
        seen.add(p.id);
        let g = ghosts.get(p.id);
        if (!g) {
          const avatar = createAvatar({ id: p.id, name: p.name, char: charFor(p) });
          avatar.group.position.set(p.x, p.y, p.z);
          group.add(avatar.group);
          g = { avatar, target: new THREE.Vector3(p.x, p.y, p.z), pos: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw, speed: 0 };
          ghosts.set(p.id, g);
        }
        g.avatar.setName(p.name);
        g.avatar.setChar(charFor(p));
        g.target.set(p.x, p.y, p.z);
        g.yaw = p.yaw;
      }
      for (const [id, g] of ghosts) {
        if (seen.has(id)) continue;
        group.remove(g.avatar.group);
        g.avatar.dispose();
        ghosts.delete(id);
      }
    },
    update(dt, _time, groundAt, isOni) {
      for (const [id, g] of ghosts) {
        const before = g.pos.clone();
        g.pos.lerp(g.target, Math.min(1, dt * 8));
        const ground = groundAt(g.pos.x, g.pos.z);
        if (g.pos.y < ground - 0.5) g.pos.y = ground;
        const moved = Math.hypot(g.pos.x - before.x, g.pos.z - before.z) / Math.max(dt, 1e-3);
        g.speed += (moved - g.speed) * Math.min(1, dt * 6);
        g.avatar.group.position.copy(g.pos);
        // Presence yaw is the way the player looks (-z forward); the body faces +z.
        const want = g.yaw + Math.PI;
        let d = want - g.avatar.group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        g.avatar.group.rotation.y += d * Math.min(1, dt * 8);
        g.avatar.setOni(!!isOni?.(id));
        g.avatar.update(dt, g.speed, g.pos.y - ground > 0.25);
      }
    },
    count: () => ghosts.size,
    positions: () => [...ghosts.entries()].map(([id, g]) => ({ id, x: g.pos.x, y: g.pos.y, z: g.pos.z })),
    emote(id, e) { ghosts.get(id)?.avatar.emote(e); },
    dispose() {
      for (const g of ghosts.values()) g.avatar.dispose();
      ghosts.clear();
    },
  };
}
