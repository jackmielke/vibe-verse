/**
 * multiplayer — shared Vibe City through Supabase Realtime.
 *
 * One channel ("vibe-city") carries everything:
 *  - presence: who's in the lobby (name + character), with automatic
 *    join/leave bookkeeping
 *  - broadcast "pos": each player's position/yaw/airborne state at
 *    ~8Hz; remote players render as real character models ("ghosts")
 *    that interpolate between updates and swap Walk/Idle clips
 *  - broadcast "chat": the community terminal, reborn
 *
 * Degrades gracefully: if the socket can't connect (offline, blocked
 * network), the world keeps working solo and the chat shows offline.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  air: boolean;
  char: string;
  /** Player body scale multiplier (1 = normal). Defaults to 1 if omitted. */
  scale?: number;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  ts: number;
  self?: boolean;
  /** True when this message came from a world_agents resident (vibe-world). */
  agent?: boolean;
}

export type EmoteName = "wave" | "dance" | "sit" | "point" | "heart" | "laugh";

export const EMOTE_EMOJI: Record<EmoteName, string> = {
  wave: "👋",
  dance: "💃",
  sit: "🪑",
  point: "👉",
  heart: "💜",
  laugh: "😂",
};

export interface NearbyPerson {
  kind: "player" | "agent";
  /** Stable ref used as DM thread participant key. For players: their auth user_id; for agents: world_agents.id. */
  ref: string;
  name: string;
  /** Distance squared from the query point. */
  distSq: number;
}

/** Rebel Defense co-op sync.
 *  - "sync": a wave just spawned on some peer — {seed, wave} lets anyone
 *    near the Vibe Star adopt the same deterministic fight.
 *  - "kill": a peer's bolt downed trooper `killId` — mirror it locally. */
export interface RebelEvent {
  t: "sync" | "kill";
  seed?: number;
  wave?: number;
  killId?: number;
}

export interface Multiplayer {
  update(dt: number, me: PlayerState): void;
  sendChat(text: string): void;
  setName(name: string): void;
  setUserId(userId: string | null): void;
  sendTimeMode(day: boolean): void;
  sendEmote(emote: EmoteName): void;
  sendRebel(ev: RebelEvent): void;
  /** Visit every remote ghost position. Used for soft player–player collision. */
  forEachOccupant(cb: (x: number, y: number, z: number) => void): void;
  /** Locally shove remote ghosts so bumping other players feels playful. */
  pushFrom(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dt: number): void;
  /** Nearest other player within `radius` meters (xz), or null. Players without a known userId are skipped. */
  getNearestPlayer(x: number, y: number, z: number, radius: number): NearbyPerson | null;
  /** World position of the remote player with this auth user id, or null. */
  getPlayerPosition(userId: string): { x: number; y: number; z: number } | null;
  /** Trigger a local wave emote sprite above a remote ghost (e.g. when someone bumps them). */
  showEmoteOnGhost(sessionId: string, emote: EmoteName): void;
  dispose(): void;
}

/** Choose where a newcomer should land: beside an active player when
 *  anyone is around (drop into the action), otherwise the town square.
 *  `occupants` are the current remote-player world positions. Pure so it
 *  can be unit-tested without a live presence channel. */
export function pickHubSpawn(
  occupants: { x: number; y: number; z: number }[],
  plaza: { x: number; y: number; z: number },
): { x: number; y: number; z: number; nearPeer: boolean } {
  if (occupants.length === 0) {
    return { x: plaza.x, y: plaza.y, z: plaza.z, nearPeer: false };
  }
  // Land beside whoever's most in the thick of it — the occupant nearest
  // the group's centroid — so you arrive in the middle of the action
  // rather than next to a straggler off at the edge of the world.
  let cx = 0;
  let cz = 0;
  for (const o of occupants) {
    cx += o.x;
    cz += o.z;
  }
  cx /= occupants.length;
  cz /= occupants.length;
  let best = occupants[0];
  let bestD = Infinity;
  for (const o of occupants) {
    const d = (o.x - cx) ** 2 + (o.z - cz) ** 2;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  // A couple of metres to the side so we don't spawn inside them.
  return { x: best.x + 2.2, y: best.y, z: best.z + 2.2, nearPeer: true };
}

interface Ghost {
  group: THREE.Group;
  /** The inner character instance — scale lives here so the label sprite isn't blown up too. */
  inst: THREE.Object3D | null;
  baseFit: number;
  appliedScale: number;
  mixer: THREE.AnimationMixer | null;
  walk: THREE.AnimationAction | null;
  idle: THREE.AnimationAction | null;
  active: "walk" | "idle" | null;
  /** Set instead of mixer/walk/idle when the peer plays a model-less
   *  character — driven from the ghost's interpolated velocity. */
  proc: ProceduralPilot | null;
  /** Previous frame's position, for deriving that velocity. */
  prevPos: THREE.Vector3;
  prevYaw: number;
  target: { x: number; y: number; z: number; yaw: number; scale: number };
  bumpVel: THREE.Vector3;
  char: string;
  label: string;
  /** Auth user id, if the peer is signed in. Required for DM threads. */
  userId: string | null;
  emote?: { sprite: THREE.Sprite; t: number; life: number; bob: number };
  chat?: { sprite: THREE.Sprite; t: number; life: number };
}

const SEND_INTERVAL_MS = 125;
const EMOTE_LIFE = 2.6;
const CHAT_BUBBLE_LIFE = 6.0;

function makeEmoteSprite(emoji: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 192;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "140px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 14;
  ctx.fillText(emoji, 96, 104);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.scale.set(1.2, 1.2, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/**
 * Club-Penguin style speech bubble parented to a character. White rounded
 * background, dark text, tiny tail at the bottom. Auto-wraps to multiple
 * lines and grows the canvas to fit.
 */
export function makeChatBubbleSprite(text: string): THREE.Sprite {
  const clean = text.slice(0, 140);
  const pad = 28;
  const lineH = 44;
  const fontPx = 34;
  const maxTextWidth = 520;

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `600 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (measure.measureText(test).width > maxTextWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
    if (lines.length >= 4) break;
  }
  if (cur && lines.length < 4) lines.push(cur);
  if (lines.length === 4 && cur && lines[3] !== cur) {
    let last = lines[3];
    while (measure.measureText(last + "…").width > maxTextWidth && last.length > 0) {
      last = last.slice(0, -1);
    }
    lines[3] = last + "…";
  }

  const textW = Math.min(
    maxTextWidth,
    Math.max(...lines.map((l) => measure.measureText(l).width)),
  );
  const w = Math.ceil(textW + pad * 2);
  const tail = 22;
  const h = Math.ceil(lines.length * lineH + pad * 2 + tail);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(64, w);
  canvas.height = Math.max(64, h);
  const ctx = canvas.getContext("2d")!;

  const r = 26;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - tail - r);
  ctx.quadraticCurveTo(w, h - tail, w - r, h - tail);
  ctx.lineTo(w / 2 + 16, h - tail);
  ctx.lineTo(w / 2, h - 2);
  ctx.lineTo(w / 2 - 16, h - tail);
  ctx.lineTo(r, h - tail);
  ctx.quadraticCurveTo(0, h - tail, 0, h - tail - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = "#0f172a";
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], w / 2, pad + lineH / 2 + i * lineH);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  const baseW = 3.4;
  sprite.scale.set(baseW, (baseW * h) / w, 1);
  sprite.renderOrder = 1000;
  return sprite;
}

export const CHAT_BUBBLE_DURATION = CHAT_BUBBLE_LIFE;


/** Draw a centered name label on a rounded, tinted "pill" background so
 *  robot vs human residents read at a glance. Shared by the AI-resident
 *  and human-ghost labels (same shape, different palette). */
export function drawNamePill(
  ctx: CanvasRenderingContext2D,
  text: string,
  palette: { fill: string; border: string; text: string },
): void {
  const canvas = ctx.canvas;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = Math.min(canvas.width - 24, ctx.measureText(text).width);
  const pillW = tw + 52;
  const pillH = 78;
  const x = cx - pillW / 2;
  const y = cy - pillH / 2;
  const r = pillH / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + pillW, y, x + pillW, y + pillH, r);
  ctx.arcTo(x + pillW, y + pillH, x, y + pillH, r);
  ctx.arcTo(x, y + pillH, x, y, r);
  ctx.arcTo(x, y, x + pillW, y, r);
  ctx.closePath();
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = palette.border;
  ctx.stroke();
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = palette.text;
  ctx.fillText(text, cx, cy + 2);
  ctx.shadowBlur = 0;
}

function makeLabelSprite(name: string): THREE.Sprite {
  // Real people wear a 👤 on a teal pill so they read at a glance as human,
  // distinct from the 🤖 purple pill the AI residents carry.
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  drawNamePill(ctx, `👤 ${name.slice(0, 16)}`, {
    fill: "rgba(16, 185, 132, 0.30)",
    border: "rgba(110, 255, 220, 0.85)",
    text: "#e3fff5",
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(3.6, 0.79, 1);
  sprite.position.y = 2.35;
  return sprite;
}

export function createMultiplayer(opts: {
  scene: THREE.Scene;
  characterUrl: (name: string) => string | undefined;
  name: string;
  onChat: (msg: ChatMessage) => void;
  onPeers: (count: number, online: boolean) => void;
  onTimeMode?: (day: boolean, fromPeer: boolean) => void;
  onEmote?: (emote: EmoteName, fromPeer: boolean) => void;
  onBump?: (x: number, y: number, z: number, dirX: number, dirZ: number, speed: number) => void;
  onRebel?: (ev: RebelEvent) => void;
}): Multiplayer {
  const { scene, characterUrl, onChat, onPeers, onTimeMode, onEmote, onBump, onRebel } = opts;
  let myName = opts.name;
  let myUserId: string | null = null;
  const sessionId = `p-${Math.random().toString(36).slice(2, 10)}`;
  const ghosts = new Map<string, Ghost>();
  const loader = new GLTFLoader();
  const baseCache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[]; fit: number; lift: number }>>();
  let online = false;
  let lastSend = 0;
  let lastBumpSend = 0;
  let lastSent: PlayerState | null = null;
  let disposed = false;
  let myDay: boolean | null = null; // our current known day/night, tracked in presence
  let appliedInitial = false;

  const loadBase = (char: string) => {
    let entry = baseCache.get(char);
    if (!entry) {
      const url = characterUrl(char);
      entry = new Promise((resolve, reject) => {
        if (!url) return reject(new Error(`unknown character ${char}`));
        loader.load(url, (gltf) => {
          const base = gltf.scene;
          base.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(base);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = 1.85 / Math.max(size.x, size.y, size.z, 0.0001);
          base.scale.setScalar(fit);
          base.updateMatrixWorld(true);
          const scaled = new THREE.Box3().setFromObject(base);
          base.scale.setScalar(1); // clones re-apply fit themselves
          resolve({ scene: base, clips: gltf.animations, fit, lift: -scaled.min.y });
        }, undefined, reject);
      });
      baseCache.set(char, entry);
    }
    return entry;
  };

  const spawnGhost = async (key: string, char: string, label: string, userId: string | null = null, initialScale = 1) => {
    if (ghosts.has(key) || disposed) return;
    const placeholder: Ghost = {
      group: new THREE.Group(),
      inst: null,
      baseFit: 1,
      appliedScale: initialScale,
      mixer: null,
      walk: null,
      idle: null,
      active: null,
      proc: null,
      prevPos: new THREE.Vector3(0, -500, 0),
      prevYaw: 0,
      target: { x: 0, y: -500, z: 0, yaw: 0, scale: initialScale },
      bumpVel: new THREE.Vector3(),
      char,
      label,
      userId,
    };
    ghosts.set(key, placeholder);
    // A character with no model file is built here rather than fetched,
    // so peers playing one are visible to everyone else instead of
    // silently becoming an invisible placeholder.
    if (!characterUrl(char)) {
      const p = buildProceduralPilot();
      placeholder.proc = p;
      placeholder.inst = p.group;
      placeholder.baseFit = 1;
      p.group.scale.setScalar(placeholder.appliedScale);
      placeholder.group.add(p.group);
      placeholder.group.add(makeLabelSprite(label));
      scene.add(placeholder.group);
      return;
    }
    try {
      const base = await loadBase(char);
      if (disposed || !ghosts.has(key)) return;
      const inst = cloneSkinned(base.scene);
      inst.scale.setScalar(base.fit * placeholder.appliedScale);
      inst.position.y = base.lift;
      inst.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const std = mesh.material as THREE.MeshStandardMaterial;
        if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.3);
          std.roughness = Math.max(std.roughness, 0.45);
        }
      });
      placeholder.inst = inst;
      placeholder.baseFit = base.fit;
      placeholder.group.add(inst);
      placeholder.group.add(makeLabelSprite(label));
      const walkClip = base.clips.find((c) => /walk/i.test(c.name) && !/carry/i.test(c.name));
      const idleClip = base.clips.find((c) => /idle/i.test(c.name));
      if (walkClip || idleClip) {
        placeholder.mixer = new THREE.AnimationMixer(inst);
        placeholder.walk = walkClip ? placeholder.mixer.clipAction(walkClip) : null;
        placeholder.idle = idleClip ? placeholder.mixer.clipAction(idleClip) : null;
        placeholder.idle?.play();
        placeholder.active = "idle";
      }
      scene.add(placeholder.group);
    } catch {
      // Unknown model — leave the (invisible) placeholder.
    }
  };

  const removeGhost = (key: string) => {
    const g = ghosts.get(key);
    if (!g) return;
    ghosts.delete(key);
    scene.remove(g.group);
    // Cloned GLB ghosts share cached geometry with the base, so they
    // must NOT be disposed here — but a procedural ghost owns its own,
    // and leaking one per peer per session adds up.
    g.proc?.dispose();
    g.proc = null;
  };

  const playEmoteOn = (g: Ghost, emote: EmoteName) => {
    if (g.emote) g.group.remove(g.emote.sprite);
    const sprite = makeEmoteSprite(EMOTE_EMOJI[emote] ?? "✨");
    sprite.position.set(0, 3.0, 0);
    g.group.add(sprite);
    g.emote = { sprite, t: 0, life: EMOTE_LIFE, bob: Math.random() * Math.PI * 2 };
  };

  const showChatOn = (g: Ghost, text: string) => {
    if (g.chat) {
      g.group.remove(g.chat.sprite);
      g.chat.sprite.material.dispose();
      (g.chat.sprite.material.map as THREE.Texture | null)?.dispose();
    }
    const sprite = makeChatBubbleSprite(text);
    // Sit above the name label (which is at y=2.35).
    sprite.position.set(0, 3.2 + sprite.scale.y / 2, 0);
    g.group.add(sprite);
    g.chat = { sprite, t: 0, life: CHAT_BUBBLE_LIFE };
  };





  let channel: RealtimeChannel | null = null;
  try {
    channel = supabase.channel("vibe-city", {
      config: {
        presence: { key: sessionId },
        broadcast: { self: false, ack: false },
      },
    });
    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel!.presenceState<{ name: string; char: string; day?: boolean; userId?: string | null }>();
        const keys = new Set(Object.keys(state));
        // Spawn newcomers, drop leavers.
        for (const key of keys) {
          if (key === sessionId) continue;
          const meta = state[key][0];
          if (!ghosts.has(key) && meta) {
            void spawnGhost(key, meta.char, meta.name, meta.userId ?? null);
          } else if (meta) {
            const g = ghosts.get(key);
            if (g && meta.userId && g.userId !== meta.userId) g.userId = meta.userId;
          }
        }
        for (const key of [...ghosts.keys()]) {
          if (!keys.has(key)) removeGhost(key);
        }
        // On first sync, adopt any peer's day/night so latecomers see the
        // same world the existing crew is in.
        if (!appliedInitial) {
          for (const key of keys) {
            if (key === sessionId) continue;
            const meta = state[key][0];
            if (meta && typeof meta.day === "boolean") {
              appliedInitial = true;
              myDay = meta.day;
              onTimeMode?.(meta.day, true);
              break;
            }
          }
        }
        onPeers(keys.size, online);
      })
      .on("broadcast", { event: "pos" }, ({ payload }) => {
        const p = payload as PlayerState & { id: string; name?: string; userId?: string | null };
        if (!p || p.id === sessionId) return;
        let g = ghosts.get(p.id);
        if (!g) {
          void spawnGhost(p.id, p.char, p.name ?? "pilot", p.userId ?? null);
          g = ghosts.get(p.id);
        }
        if (g) {
          const s = typeof p.scale === "number" && isFinite(p.scale) ? p.scale : 1;
          g.target = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: s };
          if (p.userId && g.userId !== p.userId) g.userId = p.userId;
          if (g.char !== p.char) {
            // Character switched mid-session: respawn the ghost (preserve scale).
            removeGhost(p.id);
            void spawnGhost(p.id, p.char, g.label, g.userId, s);
          }
        }
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        const m = payload as { id: string; name: string; text: string };
        if (!m?.text) return;
        const g = ghosts.get(m.id);
        if (g) showChatOn(g, m.text);
        onChat({ id: `${m.id}-${Date.now()}`, name: m.name, text: m.text, ts: Date.now() });
      })
      .on("broadcast", { event: "time-mode" }, ({ payload }) => {
        const p = payload as { day: boolean; id: string };
        if (!p || p.id === sessionId) return;
        myDay = !!p.day;
        appliedInitial = true;
        onTimeMode?.(myDay, true);
      })
      .on("broadcast", { event: "emote" }, ({ payload }) => {
        const p = payload as { id: string; emote: EmoteName };
        if (!p || p.id === sessionId) return;
        const g = ghosts.get(p.id);
        if (g) playEmoteOn(g, p.emote);
        onEmote?.(p.emote, true);
      })
      .on("broadcast", { event: "bump" }, ({ payload }) => {
        const p = payload as { id: string; x: number; y: number; z: number; dirX: number; dirZ: number; speed: number };
        if (!p || p.id === sessionId) return;
        onBump?.(p.x, p.y, p.z, p.dirX, p.dirZ, p.speed);
      })
      .on("broadcast", { event: "rebel" }, ({ payload }) => {
        const p = payload as RebelEvent & { id: string };
        if (!p || p.id === sessionId) return;
        onRebel?.(p);
      })
      .subscribe(async (status) => {
        online = status === "SUBSCRIBED";
        if (online) {
          await channel!.track({ name: myName, char: lastSent?.char ?? "", day: myDay ?? undefined, userId: myUserId });
        }
        onPeers(Object.keys(channel!.presenceState()).length, online);
      });
  } catch {
    online = false;
    onPeers(0, false);
  }

  return {
    update(dt, me) {
      // Throttled position broadcast — only when something changed.
      const now = performance.now();
      if (online && channel && now - lastSend > SEND_INTERVAL_MS) {
        const moved =
          !lastSent ||
          Math.abs(lastSent.x - me.x) > 0.03 ||
          Math.abs(lastSent.y - me.y) > 0.03 ||
          Math.abs(lastSent.z - me.z) > 0.03 ||
          Math.abs(lastSent.yaw - me.yaw) > 0.02 ||
          lastSent.char !== me.char ||
          Math.abs((lastSent.scale ?? 1) - (me.scale ?? 1)) > 0.01 ||
          now - lastSend > 1500; // heartbeat
        if (moved) {
          lastSend = now;
          lastSent = { ...me };
          void channel.send({
            type: "broadcast",
            event: "pos",
            payload: { id: sessionId, name: myName, userId: myUserId, ...me },
          });
        }
      }

      // Interpolate ghosts toward their latest reported state.
      for (const g of ghosts.values()) {
        const p = g.group.position;
        const k = 1 - Math.pow(0.002, dt);
        const wasAt = p.x;
        p.x += (g.target.x - p.x) * k;
        p.y += (g.target.y - p.y) * k;
        p.z += (g.target.z - p.z) * k;
        if (g.bumpVel.lengthSq() > 0.0001) {
          p.x += g.bumpVel.x * dt;
          p.z += g.bumpVel.z * dt;
          g.bumpVel.multiplyScalar(Math.pow(0.025, dt));
        } else {
          g.bumpVel.set(0, 0, 0);
        }
        let d = g.target.yaw - g.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        g.group.rotation.y += d * Math.min(1, dt * 8);

        // Smoothly ease body scale toward the peer's target so size
        // changes don't pop — and don't blow up the label sprite.
        if (g.inst) {
          const sk = 1 - Math.pow(0.01, dt);
          g.appliedScale += (g.target.scale - g.appliedScale) * sk;
          g.inst.scale.setScalar(g.baseFit * g.appliedScale);
        }

        // Walk vs idle from how far the ghost still has to travel.
        const moving =
          Math.hypot(g.target.x - p.x, g.target.z - p.z) > 0.25 || Math.abs(wasAt - p.x) > 0.02;
        const want: "walk" | "idle" = moving && g.walk ? "walk" : "idle";
        if (want !== g.active && g.mixer) {
          const from = g.active === "walk" ? g.walk : g.idle;
          const to = want === "walk" ? g.walk : g.idle;
          if (to) {
            to.reset().fadeIn(0.2).play();
            from?.fadeOut(0.2);
            g.active = want;
          }
        }
        g.mixer?.update(dt);
        // Model-less peers get the same rig the local pilot uses, fed
        // from the motion we just interpolated. It reads as a real gait
        // because the speed is real — it's how far they actually moved.
        if (g.proc) {
          const step = Math.hypot(p.x - g.prevPos.x, p.z - g.prevPos.z);
          let dy = g.group.rotation.y - g.prevYaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          g.proc.update(dt, {
            speed: step / Math.max(dt, 1e-4),
            // Peers report position, not contact — treat a clear rise as
            // airborne so jumps and jetpack climbs still read.
            grounded: p.y - g.prevPos.y < 0.02 * (dt * 60),
            verticalVel: (p.y - g.prevPos.y) / Math.max(dt, 1e-4),
            yawRate: dy / Math.max(dt, 1e-4),
            thrusting: false,
          });
          g.prevPos.copy(p);
          g.prevYaw = g.group.rotation.y;
        }

        // Emote bubble lifecycle: bob, fade, then detach.
        if (g.emote) {
          g.emote.t += dt;
          const u = g.emote.t / g.emote.life;
          if (u >= 1) {
            g.group.remove(g.emote.sprite);
            g.emote.sprite.material.dispose();
            (g.emote.sprite.material.map as THREE.Texture | null)?.dispose();
            g.emote = undefined;
          } else {
            g.emote.sprite.position.y = 3.0 + Math.sin(g.emote.bob + g.emote.t * 4) * 0.15 + u * 0.4;
            const fade = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
            g.emote.sprite.material.opacity = fade;
          }
        }

        // Chat bubble lifecycle: hold, then fade out near the end.
        if (g.chat) {
          g.chat.t += dt;
          const u = g.chat.t / g.chat.life;
          if (u >= 1) {
            g.group.remove(g.chat.sprite);
            g.chat.sprite.material.dispose();
            (g.chat.sprite.material.map as THREE.Texture | null)?.dispose();
            g.chat = undefined;
          } else {
            const fade = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
            g.chat.sprite.material.opacity = fade;
          }
        }
      }
    },
    sendChat(text) {
      const msg = { id: sessionId, name: myName, text: text.slice(0, 280) };
      onChat({ id: `${sessionId}-${Date.now()}`, name: myName, text: msg.text, ts: Date.now(), self: true });
      if (online && channel) {
        void channel.send({ type: "broadcast", event: "chat", payload: msg });
      }
    },
    setName(name) {
      myName = name;
      if (online && channel) void channel.track({ name, char: lastSent?.char ?? "", day: myDay ?? undefined, userId: myUserId });
    },
    setUserId(userId) {
      myUserId = userId;
      if (online && channel) void channel.track({ name: myName, char: lastSent?.char ?? "", day: myDay ?? undefined, userId });
    },
    getNearestPlayer(x, _y, z, radius) {
      let best: NearbyPerson | null = null;
      const r2 = radius * radius;
      for (const g of ghosts.values()) {
        if (!g.userId) continue;
        const p = g.group.position;
        if (p.y < -100) continue;
        const dx = p.x - x;
        const dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        if (!best || d2 < best.distSq) {
          best = { kind: "player", ref: g.userId, name: g.label, distSq: d2 };
        }
      }
      return best;
    },
    getPlayerPosition(userId) {
      for (const g of ghosts.values()) {
        if (g.userId === userId) {
          const p = g.group.position;
          return { x: p.x, y: p.y, z: p.z };
        }
      }
      return null;
    },
    showEmoteOnGhost(sid, emote) {
      const g = ghosts.get(sid);
      if (g) playEmoteOn(g, emote);
    },
    sendTimeMode(day) {
      myDay = !!day;
      appliedInitial = true;
      if (online && channel) {
        void channel.send({
          type: "broadcast",
          event: "time-mode",
          payload: { id: sessionId, day: myDay },
        });
        void channel.track({ name: myName, char: lastSent?.char ?? "", day: myDay });
      }
    },
    sendEmote(emote) {
      onEmote?.(emote, false);
      if (online && channel) {
        void channel.send({
          type: "broadcast",
          event: "emote",
          payload: { id: sessionId, emote },
        });
      }
    },
    sendRebel(ev) {
      if (online && channel) {
        void channel.send({
          type: "broadcast",
          event: "rebel",
          payload: { ...ev, id: sessionId },
        });
      }
    },
    forEachOccupant(cb) {
      for (const g of ghosts.values()) {
        const p = g.group.position;
        if (p.y < -100) continue; // not spawned yet
        cb(p.x, p.y, p.z);
      }
    },
    pushFrom(x, y, z, dirX, dirZ, speed, dt) {
      const len = Math.hypot(dirX, dirZ);
      if (len < 0.001 || speed < 0.5) return;
      const nx = dirX / len;
      const nz = dirZ / len;
      const radius = 1.75;
      let hit = false;
      for (const g of ghosts.values()) {
        const p = g.group.position;
        if (p.y < -100 || Math.abs(p.y - y) > 2.6) continue;
        const dx = p.x - x;
        const dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2);
        const overlap = (radius - d) / radius;
        const shove = Math.min(10, 2.8 + speed * 0.32) * overlap;
        g.bumpVel.x += nx * shove * dt * 14;
        g.bumpVel.z += nz * shove * dt * 14;
        hit = true;
      }
      const now = performance.now();
      if (hit && online && channel && now - lastBumpSend > 90) {
        lastBumpSend = now;
        void channel.send({
          type: "broadcast",
          event: "bump",
          payload: { id: sessionId, x, y, z, dirX: nx, dirZ: nz, speed },
        });
      }
    },
    dispose() {
      disposed = true;
      for (const key of [...ghosts.keys()]) removeGhost(key);
      if (channel) void supabase.removeChannel(channel);
    },
  };
}
