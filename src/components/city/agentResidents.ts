/**
 * agentResidents — every row in `world_agents` becomes a little
 * Quaternius character living on Edge Island.
 *
 * What's wired up:
 *   • Each agent gets a deterministic character (hashed from agent_key)
 *     so the same agent always looks the same.
 *   • Position is driven by the `world_agents.x,y` grid that the
 *     `vibe-world` edge function maintains. When an external agent
 *     (Telegram, OpenClaw, anything) calls `action:"move"`, the
 *     resident on the island walks to the new tile.
 *   • New rows from realtime INSERT pop in without a reload; UPDATEs
 *     re-target the wanderer; DELETE / status="offline" removes them.
 *   • New rows in `world_messages` show a Club-Penguin-style speech
 *     bubble above the matching agent for a few seconds.
 *   • Recognised slash commands in the message body trigger a visible
 *     emote in 3D:
 *       /jet  /jetpack    → a quick boost into the sky
 *       /jump             → small hop
 *       /wave             → spin in place + 👋 bubble
 *       /dance            → wiggly spin for a couple seconds
 *     Anything else just shows as a normal speech bubble.
 *
 * The grid is mapped onto a disc around `center` with `radius`, so the
 * 12×8 lobby fits neatly on the island top.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface AgentResidents {
  group: THREE.Group;
  update(dt: number, playerPos: THREE.Vector3): void;
  /** Visit every resident position. Used for soft player–agent collision. */
  forEachOccupant(cb: (x: number, y: number, z: number) => void): void;
  /** Shove nearby residents away from a moving player. */
  pushFrom(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dt: number): void;
  dispose(): void;
}

interface Resident {
  key: string;
  agentId: string | null;
  name: string;
  wrapper: THREE.Group;
  inner: THREE.Group;        // the character mesh — we bob/rotate this for emotes
  mixer: THREE.AnimationMixer | null;
  target: THREE.Vector3;
  bumpVel: THREE.Vector3;
  speed: number;
  yaw: number;
  idleT: number;
  // Emote state
  emote: "none" | "jet" | "jump" | "wave" | "dance";
  emoteT: number;            // seconds into the current emote
  baseLift: number;          // resting Y for the inner mesh
  // Bubble
  bubble: THREE.Sprite | null;
  bubbleT: number;           // seconds remaining
}

const ANIM_CULL_DIST_SQ = 200 * 200;
const BUBBLE_DURATION = 5.0;
const ROOM_WIDTH = 12;
const ROOM_HEIGHT = 8;

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Map a grid tile (0..w-1, 0..h-1) onto a disc of `radius` around (0,0). */
function tileToOffset(x: number, y: number, radius: number, out: THREE.Vector3) {
  const nx = (x + 0.5) / ROOM_WIDTH - 0.5;   // -0.5..0.5
  const ny = (y + 0.5) / ROOM_HEIGHT - 0.5;
  out.set(nx * 2 * radius * 0.85, 0, ny * 2 * radius * 0.85);
}

function makeBubble(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  // Rounded panel
  const pad = 28;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2 - 24;
  const r = 36;
  ctx.fillStyle = "rgba(15, 18, 28, 0.92)";
  ctx.strokeStyle = "rgba(120, 220, 180, 0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(pad + r, pad);
  ctx.arcTo(pad + w, pad, pad + w, pad + h, r);
  ctx.arcTo(pad + w, pad + h, pad, pad + h, r);
  ctx.arcTo(pad, pad + h, pad, pad, r);
  ctx.arcTo(pad, pad, pad + w, pad, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Tail
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 22, pad + h);
  ctx.lineTo(canvas.width / 2, pad + h + 28);
  ctx.lineTo(canvas.width / 2 + 22, pad + h);
  ctx.closePath();
  ctx.fill();
  // Text (wrap to 2 lines max)
  ctx.fillStyle = "#e8fff5";
  ctx.font = "bold 44px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const trimmed = text.length > 80 ? text.slice(0, 77) + "…" : text;
  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > w - 32 && line) {
      lines.push(line);
      line = word;
      if (lines.length === 2) break;
    } else line = test;
  }
  if (line && lines.length < 3) lines.push(line);
  const startY = pad + h / 2 - ((lines.length - 1) * 28);
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, startY + i * 56));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.renderOrder = 999;
  sprite.scale.set(5.4, 1.8, 1);
  sprite.position.y = 3.6;
  return sprite;
}

function makeNameLabel(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#c4b5fd";
  ctx.fillText(`🤖 ${name.slice(0, 16)}`, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(3.6, 0.9, 1);
  sprite.position.y = 2.4;
  return sprite;
}

/**
 * Detect a slash-command emote anywhere in the message and map it to a
 * 3D animation. Tolerant of leading whitespace, mixed case, and a few
 * common aliases so agents don't have to memorise exact spelling.
 *
 * Supported:
 *   /jet, /jetpack, /fly, /boost     → quick boost into the sky
 *   /jump, /hop                       → small hop
 *   /wave, /hi, /hello                → spin in place + 👋 bubble
 *   /dance, /party, /vibe             → wiggly spin
 */
function parseEmote(body: string): { emote: Resident["emote"]; text: string } {
  // Look for the first /word token; allow it anywhere, not just leading.
  const m = body.match(/(^|\s)\/([a-zA-Z]+)\b\s*(.*)$/);
  if (!m) return { emote: "none", text: body };
  const cmd = m[2].toLowerCase();
  const rest = (body.slice(0, m.index ?? 0) + " " + (m[3] || "")).trim();
  if (cmd === "jet" || cmd === "jetpack" || cmd === "fly" || cmd === "boost")
    return { emote: "jet", text: rest || "🚀" };
  if (cmd === "jump" || cmd === "hop")
    return { emote: "jump", text: rest || "⬆️" };
  if (cmd === "wave" || cmd === "hi" || cmd === "hello")
    return { emote: "wave", text: rest || "👋" };
  if (cmd === "dance" || cmd === "party" || cmd === "vibe")
    return { emote: "dance", text: rest || "💃" };
  return { emote: "none", text: body };
}

export function createAgentResidents(opts: {
  scene: THREE.Scene;
  characters: { name: string; url: string }[];
  /** World-space ground center the agents live on (e.g. the island top). */
  center?: { x: number; y?: number; z: number };
  /** Radius of the wander/grid disc. */
  radius?: number;
  /** Optional filter by world_agents.room_id (defaults to "vibe-lobby"). */
  roomId?: string;
}): AgentResidents {
  const { scene, characters } = opts;
  const centerX = opts.center?.x ?? 0;
  const centerY = opts.center?.y ?? 0;
  const centerZ = opts.center?.z ?? 0;
  const radius = opts.radius ?? 38;
  const roomId = opts.roomId ?? "vibe-lobby";
  const group = new THREE.Group();
  scene.add(group);

  const residents = new Map<string, Resident>();
  const byAgentId = new Map<string, string>(); // agent_id (uuid) -> key
  const baseCache = new Map<
    string,
    Promise<{ scene: THREE.Group; clip: THREE.AnimationClip | null; fit: number; lift: number }>
  >();
  const loader = new GLTFLoader();
  let disposed = false;

  const loadBase = (url: string) => {
    let entry = baseCache.get(url);
    if (!entry) {
      entry = new Promise((resolve, reject) => {
        loader.load(
          url,
          (gltf) => {
            const base = gltf.scene;
            base.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(base);
            const size = new THREE.Vector3();
            box.getSize(size);
            const fit = 1.75 / Math.max(size.x, size.y, size.z, 0.0001);
            base.scale.setScalar(fit);
            base.updateMatrixWorld(true);
            const scaled = new THREE.Box3().setFromObject(base);
            base.scale.setScalar(1);
            const walk =
              gltf.animations.find((c) => /walk/i.test(c.name) && !/carry/i.test(c.name)) ??
              gltf.animations[0] ??
              null;
            resolve({ scene: base, clip: walk, fit, lift: -scaled.min.y });
          },
          undefined,
          reject,
        );
      });
      baseCache.set(url, entry);
    }
    return entry;
  };

  const setTargetFromTile = (r: Resident, x: number | null, y: number | null) => {
    if (x == null || y == null) return;
    const tmp = new THREE.Vector3();
    tileToOffset(x, y, radius, tmp);
    r.target.set(centerX + tmp.x, centerY, centerZ + tmp.z);
  };

  const spawn = async (row: {
    key: string;
    agentId: string | null;
    name: string;
    x: number | null;
    y: number | null;
  }) => {
    if (disposed || residents.has(row.key) || characters.length === 0) return;
    const idx = hashString(row.key) % characters.length;
    const ch = characters[idx];
    try {
      const { scene: base, clip, fit, lift } = await loadBase(ch.url);
      if (disposed || residents.has(row.key)) return;
      const inst = cloneSkinned(base);
      inst.scale.setScalar(fit);
      inst.position.y = lift;
      const inner = new THREE.Group();
      inner.add(inst);
      const wrapper = new THREE.Group();
      wrapper.add(inner);
      wrapper.add(makeNameLabel(row.name));
      // Start at the agent's tile if we have one, else a stable hash spot.
      const tmp = new THREE.Vector3();
      if (row.x != null && row.y != null) {
        tileToOffset(row.x, row.y, radius, tmp);
      } else {
        const a = (hashString(row.key + "spawn") / 0xffffffff) * Math.PI * 2;
        const r = ((hashString(row.key + "r") / 0xffffffff) * 0.7 + 0.2) * radius;
        tmp.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
      wrapper.position.set(centerX + tmp.x, centerY, centerZ + tmp.z);
      let mixer: THREE.AnimationMixer | null = null;
      if (clip) {
        mixer = new THREE.AnimationMixer(inst);
        const action = mixer.clipAction(clip);
        action.timeScale = 0.9 + ((hashString(row.key) % 5) * 0.08);
        action.play();
        mixer.update((hashString(row.key + "phase") % 100) / 100);
      }
      const resident: Resident = {
        key: row.key,
        agentId: row.agentId,
        name: row.name,
        wrapper,
        inner,
        mixer,
        target: wrapper.position.clone(),
        bumpVel: new THREE.Vector3(),
        speed: 1.6 + (hashString(row.key + "spd") % 100) / 100 * 1.0,
        yaw: 0,
        idleT: 0.4,
        emote: "none",
        emoteT: 0,
        baseLift: lift,
        bubble: null,
        bubbleT: 0,
      };
      setTargetFromTile(resident, row.x, row.y);
      group.add(wrapper);
      residents.set(row.key, resident);
      if (row.agentId) byAgentId.set(row.agentId, row.key);
    } catch (err) {
      console.warn("[agentResidents] failed to load", ch.url, err);
    }
  };

  const remove = (key: string) => {
    const r = residents.get(key);
    if (!r) return;
    group.remove(r.wrapper);
    r.wrapper.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
      const spr = o as THREE.Sprite;
      if (spr.isSprite) {
        (spr.material.map as THREE.Texture | null)?.dispose();
        spr.material.dispose();
      }
    });
    if (r.agentId) byAgentId.delete(r.agentId);
    residents.delete(key);
  };

  const showBubble = (r: Resident, text: string) => {
    if (r.bubble) {
      r.wrapper.remove(r.bubble);
      (r.bubble.material.map as THREE.Texture | null)?.dispose();
      r.bubble.material.dispose();
    }
    const sprite = makeBubble(text);
    r.wrapper.add(sprite);
    r.bubble = sprite;
    r.bubbleT = BUBBLE_DURATION;
  };

  const startEmote = (r: Resident, emote: Resident["emote"]) => {
    r.emote = emote;
    r.emoteT = 0;
  };

  // Initial fetch
  (async () => {
    const { data, error } = await supabase
      .from("world_agents")
      .select("id, agent_key, name, status, room_id, x, y")
      .eq("room_id", roomId);
    if (error) {
      console.warn("[agentResidents] fetch failed", error);
      return;
    }
    const rows = (data ?? []).filter((r) => r.status !== "offline");
    console.log(`[agentResidents] spawning ${rows.length} agents on the island`, rows);
    for (const row of rows) {
      void spawn({
        key: (row.agent_key as string) || (row.id as string),
        agentId: (row.id as string) ?? null,
        name: (row.name as string) || "agent",
        x: row.x as number | null,
        y: row.y as number | null,
      });
    }
  })();

  // Realtime
  const channel: RealtimeChannel = supabase
    .channel("agent-residents")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "world_agents", filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = payload.new as { id?: string; agent_key?: string; name?: string; status?: string; x?: number; y?: number };
        if (row.status === "offline") return;
        const key = row.agent_key || row.id;
        if (!key) return;
        void spawn({
          key,
          agentId: row.id ?? null,
          name: row.name || "agent",
          x: row.x ?? null,
          y: row.y ?? null,
        });
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "world_agents", filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = payload.new as { id?: string; agent_key?: string; status?: string; x?: number; y?: number };
        const key = row.agent_key || row.id;
        if (!key) return;
        if (row.status === "offline") { remove(key); return; }
        const r = residents.get(key);
        if (!r) {
          // Wasn't loaded yet (e.g. just transitioned out of offline) — spawn now.
          void spawn({
            key,
            agentId: row.id ?? null,
            name: (payload.new as { name?: string }).name || "agent",
            x: row.x ?? null,
            y: row.y ?? null,
          });
          return;
        }
        setTargetFromTile(r, row.x ?? null, row.y ?? null);
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "world_agents" },
      (payload) => {
        const row = payload.old as { agent_key?: string; id?: string };
        const key = row.agent_key || row.id || "";
        if (key) remove(key);
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "world_messages", filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = payload.new as { agent_id?: string; speaker?: string; body?: string; kind?: string };
        if (!row.body) return;
        // Match by agent_id first, then by speaker name as a fallback.
        let key: string | undefined;
        if (row.agent_id) key = byAgentId.get(row.agent_id);
        if (!key && row.speaker) {
          for (const r of residents.values()) {
            if (r.name === row.speaker) { key = r.key; break; }
          }
        }
        if (!key) return;
        const r = residents.get(key);
        if (!r) return;
        const { emote, text } = parseEmote(row.body);
        showBubble(r, text);
        if (emote !== "none") startEmote(r, emote);
      },
    )
    .subscribe();

  const tmpVec = new THREE.Vector3();
  // Minimum personal-space radius. When external agents (Telegram bots,
  // OpenClaw, etc.) all spawn on the same tile, they'd otherwise stack
  // into a single visual blob — this gentle push keeps them apart.
  const PERSONAL_SPACE = 1.4;
  const SEPARATION_STRENGTH = 4.4; // m/s at full overlap
  const BUMP_RADIUS = 1.75;
  return {
    group,
    update(dt, playerPos) {
      // ---- soft separation: nudge stacked agents apart ----
      const list = [...residents.values()];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a.emote === "jet") continue; // mid-air, don't shove
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (b.emote === "jet") continue;
          const dx = a.wrapper.position.x - b.wrapper.position.x;
          const dz = a.wrapper.position.z - b.wrapper.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= PERSONAL_SPACE * PERSONAL_SPACE) continue;
          const d = Math.sqrt(d2);
          // Deterministic tiny offset so two perfectly stacked agents
          // (d ≈ 0) still get a direction to peel apart in.
          let nx: number, nz: number;
          if (d < 0.0001) {
            const seed = (hashString(a.key) ^ hashString(b.key)) >>> 0;
            const ang = (seed / 0xffffffff) * Math.PI * 2;
            nx = Math.cos(ang);
            nz = Math.sin(ang);
          } else {
            nx = dx / d;
            nz = dz / d;
          }
          const overlap = (PERSONAL_SPACE - d) / PERSONAL_SPACE; // 0..1
          const push = SEPARATION_STRENGTH * overlap * dt;
          a.bumpVel.x += nx * push * 10;
          a.bumpVel.z += nz * push * 10;
          b.bumpVel.x -= nx * push * 10;
          b.bumpVel.z -= nz * push * 10;
        }
      }
      for (const r of residents.values()) {
        // ---- movement ----
        const p = r.wrapper.position;
        if (r.idleT > 0) {
          r.idleT -= dt;
        } else {
          tmpVec.copy(r.target).sub(p);
          tmpVec.y = 0;
          const dist = tmpVec.length();
          if (dist < 0.4) {
            r.idleT = 1.2 + Math.random() * 2.0;
          } else {
            tmpVec.multiplyScalar(1 / dist);
            const step = Math.min(dist, r.speed * dt);
            p.x += tmpVec.x * step;
            p.z += tmpVec.z * step;
            const targetYaw = Math.atan2(tmpVec.x, tmpVec.z);
            let d = targetYaw - r.yaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            r.yaw += d * Math.min(1, dt * 6);
            r.wrapper.rotation.y = r.yaw;
          }
        }
        if (r.bumpVel.lengthSq() > 0.0001) {
          p.x += r.bumpVel.x * dt;
          p.z += r.bumpVel.z * dt;
          r.bumpVel.multiplyScalar(Math.pow(0.025, dt));
        } else {
          r.bumpVel.set(0, 0, 0);
        }
        // ---- emote ----
        if (r.emote !== "none") {
          r.emoteT += dt;
          if (r.emote === "jet") {
            // 1.6s arc up + drift back down
            const T = 1.6;
            const t = Math.min(1, r.emoteT / T);
            const h = Math.sin(t * Math.PI) * 6.0; // peak ~6m
            r.inner.position.y = r.baseLift + h;
            if (r.emoteT >= T) { r.inner.position.y = r.baseLift; r.emote = "none"; }
          } else if (r.emote === "jump") {
            const T = 0.5;
            const t = Math.min(1, r.emoteT / T);
            r.inner.position.y = r.baseLift + Math.sin(t * Math.PI) * 1.4;
            if (r.emoteT >= T) { r.inner.position.y = r.baseLift; r.emote = "none"; }
          } else if (r.emote === "wave") {
            const T = 1.4;
            r.inner.rotation.y = Math.sin(r.emoteT * 6) * 0.5;
            if (r.emoteT >= T) { r.inner.rotation.y = 0; r.emote = "none"; }
          } else if (r.emote === "dance") {
            const T = 3.0;
            r.inner.rotation.y = Math.sin(r.emoteT * 10) * 0.7;
            r.inner.position.y = r.baseLift + Math.abs(Math.sin(r.emoteT * 8)) * 0.4;
            if (r.emoteT >= T) {
              r.inner.rotation.y = 0;
              r.inner.position.y = r.baseLift;
              r.emote = "none";
            }
          }
        }
        // ---- bubble fade ----
        if (r.bubble) {
          r.bubbleT -= dt;
          if (r.bubbleT <= 0) {
            r.wrapper.remove(r.bubble);
            (r.bubble.material.map as THREE.Texture | null)?.dispose();
            r.bubble.material.dispose();
            r.bubble = null;
          } else if (r.bubbleT < 0.6) {
            r.bubble.material.opacity = r.bubbleT / 0.6;
          }
        }
        // ---- anim ----
        if (r.mixer && p.distanceToSquared(playerPos) < ANIM_CULL_DIST_SQ) {
          if (r.idleT <= 0 || r.emote === "dance") r.mixer.update(dt);
        }
      }
    },
    forEachOccupant(cb) {
      for (const r of residents.values()) {
        if (r.emote === "jet") continue; // mid-air
        const p = r.wrapper.position;
        cb(p.x, p.y, p.z);
      }
    },
    pushFrom(x, y, z, dirX, dirZ, speed, dt) {
      const len = Math.hypot(dirX, dirZ);
      if (len < 0.001 || speed < 0.5) return;
      const nx = dirX / len;
      const nz = dirZ / len;
      for (const r of residents.values()) {
        if (r.emote === "jet" || Math.abs(r.wrapper.position.y - y) > 2.6) continue;
        const dx = r.wrapper.position.x - x;
        const dz = r.wrapper.position.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= BUMP_RADIUS * BUMP_RADIUS) continue;
        const d = Math.sqrt(d2);
        const overlap = (BUMP_RADIUS - d) / BUMP_RADIUS;
        const shove = Math.min(10, 2.8 + speed * 0.32) * overlap;
        r.bumpVel.x += nx * shove * dt * 14;
        r.bumpVel.z += nz * shove * dt * 14;
        r.idleT = Math.min(r.idleT, 0.15);
      }
    },
    dispose() {
      disposed = true;
      supabase.removeChannel(channel);
      for (const key of [...residents.keys()]) remove(key);
      scene.remove(group);
    },
  };
}
