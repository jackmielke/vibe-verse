/**
 * The folk of Vibe City: ten pedestrians with routines you can talk to.
 *
 * Bodies are Oni's `createAvatar` (any roster character, idle and walk
 * blended by speed). Each person walks their loop from `cast.ts`, lingers,
 * pops an emoji, and stops to face you while you talk. What they say comes
 * from `talk.ts`; this file only moves them and draws the speech bubble.
 */
import * as THREE from "three";
import { createAvatar, type Avatar } from "@/oni/world/avatars";
import { FOLK, type FolkDef } from "./cast";

export interface Folk {
  group: THREE.Group;
  update(dt: number, player: THREE.Vector3): void;
  /** Whoever is close enough to talk to, or null. */
  near(): FolkDef | null;
  /** Hold them still and facing the player (or let them go with null). */
  engage(id: string | null): void;
  /** A speech bubble over their head for a few seconds. */
  say(id: string, text: string): void;
  /** Dev hook: everybody's position. */
  where(): Array<{ id: string; x: number; y: number; z: number; step: number }>;
  dispose(): void;
}

const TALK_RANGE = 3.6;
const FAR = 70;

function bubbleTexture(text: string, name: string): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const W = 640;
  const g = c.getContext("2d")!;
  g.font = "500 30px system-ui, sans-serif";
  // Wrap to the width.
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (g.measureText(next).width > W - 60 && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 5);
  if (lines.length > 5) shown[4] = shown[4].replace(/\s*\S*$/, "…");
  const H = 70 + shown.length * 38 + 26;
  c.width = W;
  c.height = H;
  g.fillStyle = "rgba(255,255,255,0.94)";
  g.beginPath();
  g.roundRect(6, 6, W - 12, H - 30, 26);
  g.fill();
  g.beginPath();
  g.moveTo(W / 2 - 16, H - 25);
  g.lineTo(W / 2, H - 4);
  g.lineTo(W / 2 + 16, H - 25);
  g.fill();
  g.fillStyle = "#7a4cff";
  g.font = "700 26px system-ui, sans-serif";
  g.fillText(name, 30, 44);
  g.fillStyle = "#1b1d26";
  g.font = "500 30px system-ui, sans-serif";
  shown.forEach((l, i) => g.fillText(l, 30, 84 + i * 38));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: W / H };
}

function nameTexture(name: string, role: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.font = "700 46px system-ui, sans-serif";
  const w = Math.min(500, g.measureText(name).width + 70);
  g.fillStyle = "rgba(122,76,255,0.85)";
  g.beginPath();
  g.roundRect(256 - w / 2, 10, w, 66, 33);
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(name, 256, 44);
  g.font = "500 24px system-ui, sans-serif";
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fillText(role.length > 34 ? role.slice(0, 33) + "…" : role, 256, 104);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Person {
  def: FolkDef;
  avatar: Avatar;
  tag: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleT: number;
  step: number;
  wait: number;
  yaw: number;
  speed: number;
  emoted: boolean;
}

export function createFolk(opts: { scene: THREE.Scene; ground: (x: number, z: number, y: number) => number; lowDetail?: boolean }): Folk {
  const group = new THREE.Group();
  group.name = "folk";
  opts.scene.add(group);
  let engaged: string | null = null;
  let nearest: Person | null = null;
  const P = new THREE.Vector3();

  const people: Person[] = FOLK.map((def, i) => {
    const avatar = createAvatar({ id: "folk-" + def.id, name: def.name, char: def.char, noTag: true });
    // Start somewhere along the route, so they are not all at step zero.
    const step = i % def.routine.length;
    const [x, z] = def.routine[step].to;
    avatar.group.position.set(x, def.y, z);
    group.add(avatar.group);
    const tagMat = new THREE.SpriteMaterial({ map: nameTexture(def.name, def.role), transparent: true, depthWrite: false });
    const tag = new THREE.Sprite(tagMat);
    tag.scale.set(1.9, 0.475, 1);
    tag.position.y = 2.25;
    avatar.group.add(tag);
    return { def, avatar, tag, bubble: null, bubbleT: 0, step, wait: 2 + i, yaw: 0, speed: 0, emoted: false };
  });

  const clearBubble = (p: Person) => {
    if (!p.bubble) return;
    p.avatar.group.remove(p.bubble);
    p.bubble.material.map?.dispose();
    p.bubble.material.dispose();
    p.bubble = null;
  };

  return {
    group,
    near: () => nearest?.def ?? null,
    engage(id) {
      engaged = id;
    },
    say(id, text) {
      const p = people.find((q) => q.def.id === id);
      if (!p) return;
      clearBubble(p);
      const { tex, aspect } = bubbleTexture(text, p.def.name);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      s.renderOrder = 12;
      const h = 3.4 / aspect;
      s.scale.set(3.4, h, 1);
      s.position.y = 2.6 + h / 2;
      p.avatar.group.add(s);
      p.bubble = s;
      p.bubbleT = Math.min(14, 4 + text.length / 14);
    },
    where: () => people.map((p) => ({ id: p.def.id, x: p.avatar.group.position.x, y: p.avatar.group.position.y, z: p.avatar.group.position.z, step: p.step })),
    update(dt, player) {
      let best: Person | null = null;
      let bestD = TALK_RANGE * TALK_RANGE;
      for (const p of people) {
        const g = p.avatar.group;
        const dx = player.x - g.position.x;
        const dz = player.z - g.position.z;
        const d2 = dx * dx + dz * dz;
        const far = d2 > FAR * FAR;
        g.visible = !far;
        if (d2 < bestD && Math.abs(player.y - g.position.y) < 2.5) {
          bestD = d2;
          best = p;
        }
        let moving = 0;
        if (engaged === p.def.id) {
          // Turn to face whoever is talking to them.
          const want = Math.atan2(dx, dz);
          let d = want - p.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          p.yaw += d * Math.min(1, dt * 6);
        } else if (p.wait > 0) {
          p.wait -= dt;
          const st = p.def.routine[p.step];
          if (!p.emoted && st.emote && p.wait < (st.wait ?? 0) - 1) {
            p.emoted = true;
            if (!far) p.avatar.emote(st.emote);
          }
        } else {
          const st = p.def.routine[p.step];
          P.set(st.to[0] - g.position.x, 0, st.to[1] - g.position.z);
          const dist = P.length();
          if (dist < 0.15) {
            p.wait = st.wait ?? 0;
            p.emoted = false;
            p.step = (p.step + 1) % p.def.routine.length;
          } else {
            const v = Math.min(dist / Math.max(dt, 1e-3), p.def.speed);
            g.position.addScaledVector(P.normalize(), v * dt);
            moving = v;
            const want = Math.atan2(P.x, P.z);
            let d = want - p.yaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            p.yaw += d * Math.min(1, dt * 5);
          }
        }
        // Personal space: step round the player instead of through them.
        if (d2 < 1.1 && engaged !== p.def.id) {
          const d = Math.sqrt(d2) || 1;
          g.position.x -= (dx / d) * (1.05 - d) * Math.min(1, dt * 4);
          g.position.z -= (dz / d) * (1.05 - d) * Math.min(1, dt * 4);
        }
        g.position.y = opts.ground(g.position.x, g.position.z, p.def.y);
        g.rotation.y = p.yaw;
        p.speed += (moving - p.speed) * Math.min(1, dt * 8);
        if (!far) p.avatar.update(dt, p.speed, false);
        if (p.bubble) {
          p.bubbleT -= dt;
          if (p.bubbleT <= 0) clearBubble(p);
        }
      }
      nearest = best;
    },
    dispose() {
      for (const p of people) {
        clearBubble(p);
        p.tag.material.map?.dispose();
        p.tag.material.dispose();
        p.avatar.dispose();
      }
      opts.scene.remove(group);
    },
  };
}
