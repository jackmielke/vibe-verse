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

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  air: boolean;
  char: string;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  ts: number;
  self?: boolean;
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

export interface Multiplayer {
  update(dt: number, me: PlayerState): void;
  sendChat(text: string): void;
  setName(name: string): void;
  sendTimeMode(day: boolean): void;
  sendEmote(emote: EmoteName): void;
  dispose(): void;
}

interface Ghost {
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  walk: THREE.AnimationAction | null;
  idle: THREE.AnimationAction | null;
  active: "walk" | "idle" | null;
  target: { x: number; y: number; z: number; yaw: number };
  char: string;
  label: string;
  emote?: { sprite: THREE.Sprite; t: number; life: number; bob: number };
}

const SEND_INTERVAL_MS = 125;
const EMOTE_LIFE = 2.6;

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


function makeLabelSprite(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#baffe9";
  ctx.fillText(name.slice(0, 18), 256, 56);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(3.4, 0.75, 1);
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
}): Multiplayer {
  const { scene, characterUrl, onChat, onPeers, onTimeMode, onEmote } = opts;
  let myName = opts.name;
  const sessionId = `p-${Math.random().toString(36).slice(2, 10)}`;
  const ghosts = new Map<string, Ghost>();
  const loader = new GLTFLoader();
  const baseCache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[]; fit: number; lift: number }>>();
  let online = false;
  let lastSend = 0;
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

  const spawnGhost = async (key: string, char: string, label: string) => {
    if (ghosts.has(key) || disposed) return;
    const placeholder: Ghost = {
      group: new THREE.Group(),
      mixer: null,
      walk: null,
      idle: null,
      active: null,
      target: { x: 0, y: -500, z: 0, yaw: 0 },
      char,
      label,
    };
    ghosts.set(key, placeholder);
    try {
      const base = await loadBase(char);
      if (disposed || !ghosts.has(key)) return;
      const inst = cloneSkinned(base.scene);
      inst.scale.setScalar(base.fit);
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
  };

  const playEmoteOn = (g: Ghost, emote: EmoteName) => {
    if (g.emote) g.group.remove(g.emote.sprite);
    const sprite = makeEmoteSprite(EMOTE_EMOJI[emote] ?? "✨");
    sprite.position.set(0, 3.0, 0);
    g.group.add(sprite);
    g.emote = { sprite, t: 0, life: EMOTE_LIFE, bob: Math.random() * Math.PI * 2 };
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
        const state = channel!.presenceState<{ name: string; char: string; day?: boolean }>();
        const keys = new Set(Object.keys(state));
        // Spawn newcomers, drop leavers.
        for (const key of keys) {
          if (key === sessionId) continue;
          const meta = state[key][0];
          if (!ghosts.has(key) && meta) void spawnGhost(key, meta.char, meta.name);
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
        const p = payload as PlayerState & { id: string; name?: string };
        if (!p || p.id === sessionId) return;
        let g = ghosts.get(p.id);
        if (!g) {
          void spawnGhost(p.id, p.char, p.name ?? "pilot");
          g = ghosts.get(p.id);
        }
        if (g) {
          g.target = { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
          if (g.char !== p.char) {
            // Character switched mid-session: respawn the ghost.
            removeGhost(p.id);
            void spawnGhost(p.id, p.char, g.label);
          }
        }
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        const m = payload as { id: string; name: string; text: string };
        if (!m?.text) return;
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
      .subscribe(async (status) => {
        online = status === "SUBSCRIBED";
        if (online) {
          await channel!.track({ name: myName, char: lastSent?.char ?? "", day: myDay ?? undefined });
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
          now - lastSend > 1500; // heartbeat
        if (moved) {
          lastSend = now;
          lastSent = { ...me };
          void channel.send({
            type: "broadcast",
            event: "pos",
            payload: { id: sessionId, name: myName, ...me },
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
        let d = g.target.yaw - g.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        g.group.rotation.y += d * Math.min(1, dt * 8);

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
      if (online && channel) void channel.track({ name, char: lastSent?.char ?? "", day: myDay ?? undefined });
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
    dispose() {
      disposed = true;
      for (const key of [...ghosts.keys()]) removeGhost(key);
      if (channel) void supabase.removeChannel(channel);
    },
  };
}
