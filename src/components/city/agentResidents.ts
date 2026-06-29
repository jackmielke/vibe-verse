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

export interface NearbyAgent {
  agentId: string;
  name: string;
  distSq: number;
}

export interface AgentResidents {
  group: THREE.Group;
  update(dt: number, playerPos: THREE.Vector3): void;
  /** Visit every resident position. Used for soft player–agent collision. */
  forEachOccupant(cb: (x: number, y: number, z: number) => void): void;
  /** Shove nearby residents away from a moving player. */
  pushFrom(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dt: number): void;
  /** Nearest resident with a known DB id within `radius` meters (xz), or null. */
  getNearestAgent(x: number, y: number, z: number, radius: number): NearbyAgent | null;
  /** World position of the resident with this agent id, or null. */
  getAgentPosition(agentId: string): { x: number; y: number; z: number } | null;
  /** Trigger a local wave bubble above an agent (e.g. when the player bumps them). */
  showWaveAt(agentId: string): void;
  dispose(): void;
}

/**
 * One queued motor command. Body-local: "forward" walks toward whatever
 * direction the agent is currently facing, not world-north. /turn rotates
 * in place; /strafe walks sideways without changing facing.
 */
type QueuedCmd =
  | { kind: "walk"; dir: "forward" | "back" | "strafeL" | "strafeR"; dur: number }
  | { kind: "turn"; deltaYaw: number; dur: number } // radians
  | { kind: "emote"; emote: "jet" | "jump" | "wave" | "dance"; dur: number }
  | { kind: "fly"; dir: "forward" | "back" | "hover" | "up" | "down"; dur: number }
  | { kind: "land" }
  | { kind: "respawn" };

interface Resident {
  key: string;
  agentId: string | null;
  name: string;
  wrapper: THREE.Group;
  inner: THREE.Group;        // the character mesh — we bob/rotate this for emotes
  mixer: THREE.AnimationMixer | null;
  /** Original tile-derived world position. /respawn returns the resident here. */
  home: THREE.Vector3;
  /** Walking target when in "respawn" mode. Otherwise unused. */
  target: THREE.Vector3;
  /** True while the resident is walking back home. */
  goingHome: boolean;
  bumpVel: THREE.Vector3;
  /** Queue of pending motor commands; popped one at a time. */
  queue: QueuedCmd[];
  /** Active walk (body-local dir). */
  walkDir: "forward" | "back" | "strafeL" | "strafeR" | null;
  walkT: number;
  /** Active turn. */
  turnRemaining: number;     // radians left to rotate
  turnSign: number;          // +1 / -1
  turnRate: number;          // radians per second
  speed: number;
  yaw: number;
  // Emote state
  emote: "none" | "jet" | "jump" | "wave" | "dance";
  emoteT: number;            // seconds into the current emote
  emoteDur: number;
  baseLift: number;          // resting Y for the inner mesh
  // Sustained flight (jetpack travel)
  flying: boolean;
  flightT: number;           // elapsed seconds in current flight cmd
  flightDur: number;
  flightDir: "forward" | "back" | "hover" | "up" | "down";
  altitude: number;          // current altitude above baseLift (meters)
  targetAltitude: number;    // altitude the jetpack is climbing toward
  landing: boolean;          // descending back to ground
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
 * Parse ALL slash commands in a message, in order, into a motor queue.
 * Returns the clean text (with slash tokens stripped) and the command list.
 *
 * Commands (case-insensitive, N optional):
 *   /forward N        walk forward N seconds (body-local)
 *   /back N           walk backward
 *   /strafe-left N    sidestep left (no rotation)
 *   /strafe-right N   sidestep right
 *   /left N           turn left N×45°, gradual
 *   /right N          turn right N×45°, gradual
 *   /turn N           turn N degrees (negative = left)
 *   /jump /wave /dance N /jet
 *   /respawn
 */
function parseCommands(body: string): { text: string; cmds: QueuedCmd[] } {
  const cmds: QueuedCmd[] = [];
  // Find every "/word [num]" token, anywhere in the body.
  const re = /\/([a-zA-Z][a-zA-Z-]*)\s*(-?\d+(?:\.\d+)?)?/g;
  let cleaned = body;
  let m: RegExpExecArray | null;
  const ranges: [number, number][] = [];
  while ((m = re.exec(body)) !== null) {
    const cmd = m[1].toLowerCase().replace(/-/g, "");
    const num = m[2] !== undefined ? parseFloat(m[2]) : undefined;
    const dur = Math.max(0.3, Math.min(8, num ?? 2));
    ranges.push([m.index, m.index + m[0].length]);
    if (cmd === "forward" || cmd === "fwd" || cmd === "f") {
      cmds.push({ kind: "walk", dir: "forward", dur });
    } else if (cmd === "back" || cmd === "backward" || cmd === "b") {
      cmds.push({ kind: "walk", dir: "back", dur });
    } else if (cmd === "strafeleft" || cmd === "sidestepleft" || cmd === "stepleft") {
      cmds.push({ kind: "walk", dir: "strafeL", dur });
    } else if (cmd === "straferight" || cmd === "sidestepright" || cmd === "stepright") {
      cmds.push({ kind: "walk", dir: "strafeR", dur });
    } else if (cmd === "left" || cmd === "l" || cmd === "turnleft") {
      // N×45° turn, gradual (~120°/s)
      const deg = (num ?? 1) * 45;
      const rad = (deg * Math.PI) / 180;
      cmds.push({ kind: "turn", deltaYaw: -rad, dur: Math.max(0.25, deg / 120) });
    } else if (cmd === "right" || cmd === "r" || cmd === "turnright") {
      const deg = (num ?? 1) * 45;
      const rad = (deg * Math.PI) / 180;
      cmds.push({ kind: "turn", deltaYaw: rad, dur: Math.max(0.25, deg / 120) });
    } else if (cmd === "turn" || cmd === "rotate") {
      const deg = num ?? 90;
      const rad = (deg * Math.PI) / 180;
      cmds.push({ kind: "turn", deltaYaw: rad, dur: Math.max(0.25, Math.abs(deg) / 120) });
    } else if (cmd === "jump" || cmd === "hop") {
      cmds.push({ kind: "emote", emote: "jump", dur: 0.5 });
    } else if (cmd === "wave" || cmd === "hi" || cmd === "hello") {
      cmds.push({ kind: "emote", emote: "wave", dur: 1.4 });
    } else if (cmd === "dance" || cmd === "party" || cmd === "vibe") {
      cmds.push({ kind: "emote", emote: "dance", dur: Math.max(1, dur) });
    } else if (cmd === "jet" || cmd === "jetpack" || cmd === "boost" || cmd === "rocket") {
      cmds.push({ kind: "emote", emote: "jet", dur: 1.6 });
    } else if (cmd === "fly" || cmd === "flyforward" || cmd === "flyfwd") {
      cmds.push({ kind: "fly", dir: "forward", dur });
    } else if (cmd === "flyback" || cmd === "flybackward") {
      cmds.push({ kind: "fly", dir: "back", dur });
    } else if (cmd === "hover" || cmd === "float") {
      cmds.push({ kind: "fly", dir: "hover", dur });
    } else if (cmd === "up" || cmd === "ascend" || cmd === "rise") {
      cmds.push({ kind: "fly", dir: "up", dur });
    } else if (cmd === "down" || cmd === "descend") {
      cmds.push({ kind: "fly", dir: "down", dur });
    } else if (cmd === "land") {
      cmds.push({ kind: "land" });
    } else if (cmd === "respawn" || cmd === "home" || cmd === "reset") {
      cmds.push({ kind: "respawn" });
    } else {
      ranges.pop(); // unrecognised — leave the text in
    }
  }
  // Strip recognised tokens from the bubble text.
  if (ranges.length) {
    let out = "";
    let cursor = 0;
    for (const [s, e] of ranges) {
      out += body.slice(cursor, s);
      cursor = e;
    }
    out += body.slice(cursor);
    cleaned = out.replace(/\s+/g, " ").trim();
  }
  return { text: cleaned || (cmds.length ? "…" : body), cmds };
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

  /** Update the resident's "home" tile. Does NOT pull them back automatically — they only return on /respawn. */
  const setHomeFromTile = (r: Resident, x: number | null, y: number | null) => {
    if (x == null || y == null) return;
    const tmp = new THREE.Vector3();
    tileToOffset(x, y, radius, tmp);
    r.home.set(centerX + tmp.x, centerY, centerZ + tmp.z);
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
      const home = wrapper.position.clone();
      const resident: Resident = {
        key: row.key,
        agentId: row.agentId,
        name: row.name,
        wrapper,
        inner,
        mixer,
        home,
        target: home.clone(),
        goingHome: false,
        bumpVel: new THREE.Vector3(),
        queue: [],
        walkDir: null,
        walkT: 0,
        turnRemaining: 0,
        turnSign: 0,
        turnRate: 0,
        speed: 1.6 + (hashString(row.key + "spd") % 100) / 100 * 1.0,
        yaw: 0,
        emote: "none",
        emoteT: 0,
        emoteDur: 0,
        baseLift: lift,
        flying: false,
        flightT: 0,
        flightDur: 0,
        flightDir: "forward",
        altitude: 0,
        targetAltitude: 0,
        landing: false,
        bubble: null,
        bubbleT: 0,
      };
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

  const startEmote = (r: Resident, emote: "jet" | "jump" | "wave" | "dance", dur?: number) => {
    r.emote = emote;
    r.emoteT = 0;
    r.emoteDur = dur ?? (emote === "jet" ? 1.6 : emote === "jump" ? 0.5 : emote === "wave" ? 1.4 : 3.0);
  };

  /** Enqueue motor commands; the per-frame update pops them one at a time. */
  const enqueue = (r: Resident, cmds: QueuedCmd[]) => {
    r.queue.push(...cmds);
  };

  const respawn = (r: Resident) => {
    r.queue.length = 0;
    r.walkDir = null;
    r.walkT = 0;
    r.turnRemaining = 0;
    r.target.copy(r.home);
    r.goingHome = true;
    r.emote = "none";
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
        // Keep "home" up to date so /respawn returns them to their latest assigned tile,
        // but do NOT pull them back here — bumps and manual movement should persist.
        setHomeFromTile(r, row.x ?? null, row.y ?? null);
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
        const parsed = parseCommands(row.body);
        showBubble(r, parsed.text);
        if (parsed.cmds.length) enqueue(r, parsed.cmds);
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
        // ---- pop next queued command if idle ----
        const idle =
          r.walkT <= 0 &&
          r.turnRemaining <= 0 &&
          r.emote === "none" &&
          !r.goingHome &&
          r.flightDur <= 0 &&
          !r.landing;
        if (idle && r.queue.length) {
          const next = r.queue.shift()!;
          if (next.kind === "walk") {
            r.walkDir = next.dir;
            r.walkT = next.dur;
          } else if (next.kind === "turn") {
            r.turnRemaining = Math.abs(next.deltaYaw);
            r.turnSign = Math.sign(next.deltaYaw) || 1;
            r.turnRate = r.turnRemaining / Math.max(0.05, next.dur);
          } else if (next.kind === "emote") {
            startEmote(r, next.emote, next.dur);
          } else if (next.kind === "fly") {
            r.flying = true;
            r.flightT = 0;
            r.flightDur = next.dur;
            r.flightDir = next.dir;
            // Set/raise altitude target. Forward/back/hover cruise at ~8m.
            // /up adds altitude, /down reduces it.
            if (next.dir === "up") r.targetAltitude = Math.min(40, r.altitude + 4 * next.dur);
            else if (next.dir === "down") r.targetAltitude = Math.max(0, r.altitude - 4 * next.dur);
            else r.targetAltitude = Math.max(r.altitude, 8);
          } else if (next.kind === "land") {
            r.landing = true;
            r.flying = false;
            r.flightDur = 0;
          } else if (next.kind === "respawn") {
            respawn(r);
          }
        }

        // ---- movement ----
        const p = r.wrapper.position;
        let walking = false;
        let walkDirX = 0, walkDirZ = 0;
        // Body-local forward = (sin(yaw), cos(yaw)) so it matches the
        // wrapper's facing (see targetYaw = atan2(x,z) convention below).
        const fwdX = Math.sin(r.yaw), fwdZ = Math.cos(r.yaw);
        const rightX = Math.cos(r.yaw), rightZ = -Math.sin(r.yaw);
        if (r.walkT > 0 && r.walkDir) {
          walking = true;
          if (r.walkDir === "forward")      { walkDirX = fwdX;     walkDirZ = fwdZ; }
          else if (r.walkDir === "back")    { walkDirX = -fwdX;    walkDirZ = -fwdZ; }
          else if (r.walkDir === "strafeR") { walkDirX = rightX;   walkDirZ = rightZ; }
          else                              { walkDirX = -rightX;  walkDirZ = -rightZ; }
          r.walkT -= dt;
          if (r.walkT <= 0) { r.walkT = 0; r.walkDir = null; }
        } else if (r.turnRemaining > 0) {
          const step = Math.min(r.turnRemaining, r.turnRate * dt);
          r.yaw += step * r.turnSign;
          r.turnRemaining -= step;
          r.wrapper.rotation.y = r.yaw;
        } else if (r.goingHome) {
          tmpVec.copy(r.home).sub(p);
          tmpVec.y = 0;
          const dist = tmpVec.length();
          if (dist < 0.3) {
            r.goingHome = false;
          } else {
            tmpVec.multiplyScalar(1 / dist);
            walking = true;
            walkDirX = tmpVec.x;
            walkDirZ = tmpVec.z;
          }
        }
        if (walking) {
          p.x += walkDirX * r.speed * dt;
          p.z += walkDirZ * r.speed * dt;
          // For forward/back/respawn, face the direction of travel.
          // For strafe, keep current facing.
          if (r.walkDir !== "strafeL" && r.walkDir !== "strafeR") {
            const targetYaw = Math.atan2(walkDirX, walkDirZ);
            let d = targetYaw - r.yaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            r.yaw += d * Math.min(1, dt * 6);
          }
          r.wrapper.rotation.y = r.yaw;
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
          // Animate legs while moving, dancing, or returning home.
          if (r.walkT > 0 || r.goingHome || r.emote === "dance") r.mixer.update(dt);
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
        // Bumped residents simply stay where they're shoved — no auto-return.
      }
    },
    getNearestAgent(x, _y, z, radius) {
      let best: NearbyAgent | null = null;
      const r2 = radius * radius;
      for (const r of residents.values()) {
        if (!r.agentId) continue;
        const p = r.wrapper.position;
        const dx = p.x - x;
        const dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        if (!best || d2 < best.distSq) {
          best = { agentId: r.agentId, name: r.name, distSq: d2 };
        }
      }
      return best;
    },
    getAgentPosition(agentId) {
      for (const r of residents.values()) {
        if (r.agentId === agentId) {
          const p = r.wrapper.position;
          return { x: p.x, y: p.y, z: p.z };
        }
      }
      return null;
    },
    showWaveAt(agentId) {
      for (const r of residents.values()) {
        if (r.agentId === agentId) {
          showBubble(r, "👋");
          startEmote(r, "wave");
          return;
        }
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
