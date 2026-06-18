/**
 * agentResidents — every entry in the `world_agents` table becomes a
 * little wandering character around the plaza. Each agent is assigned
 * a Quaternius character deterministically (hashed from its agent_key)
 * so the same agent always looks the same, but different agents look
 * different. We subscribe to realtime inserts so new agents pop in
 * without a reload.
 *
 * Wander logic is intentionally tiny: each agent picks a random target
 * inside a plaza-sized disc, walks there, idles a beat, picks another.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface AgentResidents {
  group: THREE.Group;
  update(dt: number, playerPos: THREE.Vector3): void;
  dispose(): void;
}

interface Resident {
  key: string;
  name: string;
  wrapper: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  target: THREE.Vector3;
  speed: number;
  yaw: number;
  idleT: number;
}

const ANIM_CULL_DIST_SQ = 160 * 160;

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
  // Soft "agent" tint so they read as NPCs vs. live players.
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

export function createAgentResidents(opts: {
  scene: THREE.Scene;
  characters: { name: string; url: string }[];
  /** Plaza center (usually origin) */
  center?: { x: number; z: number };
  /** Wander radius around the center */
  radius?: number;
  /** Optional filter by world_agents.room_id */
  roomId?: string;
}): AgentResidents {
  const { scene, characters } = opts;
  const center = opts.center ?? { x: 0, z: 0 };
  const radius = opts.radius ?? 38;
  const group = new THREE.Group();
  scene.add(group);

  const residents = new Map<string, Resident>();
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

  const pickTarget = (out: THREE.Vector3) => {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    out.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
  };

  const spawn = async (key: string, name: string) => {
    if (disposed || residents.has(key) || characters.length === 0) return;
    const idx = hashString(key) % characters.length;
    const ch = characters[idx];
    try {
      const { scene: base, clip, fit, lift } = await loadBase(ch.url);
      if (disposed) return;
      const inst = cloneSkinned(base);
      inst.scale.setScalar(fit);
      inst.position.y = lift;
      const wrapper = new THREE.Group();
      wrapper.add(inst);
      wrapper.add(makeNameLabel(name));
      // Stagger the spawn so they don't pile on one point.
      const a = (hashString(key + "spawn") / 0xffffffff) * Math.PI * 2;
      const r = ((hashString(key + "r") / 0xffffffff) * 0.7 + 0.2) * radius;
      wrapper.position.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
      let mixer: THREE.AnimationMixer | null = null;
      if (clip) {
        mixer = new THREE.AnimationMixer(inst);
        const action = mixer.clipAction(clip);
        action.timeScale = 0.9 + ((hashString(key) % 5) * 0.08);
        action.play();
        mixer.update((hashString(key + "phase") % 100) / 100);
      }
      const target = new THREE.Vector3();
      pickTarget(target);
      group.add(wrapper);
      residents.set(key, {
        key,
        name,
        wrapper,
        mixer,
        target,
        speed: 1.1 + (hashString(key + "spd") % 100) / 100 * 0.8,
        yaw: 0,
        idleT: 0,
      });
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
    residents.delete(key);
  };

  // Initial fetch
  (async () => {
    let q = supabase.from("world_agents").select("id, agent_key, name, status, room_id");
    if (opts.roomId) q = q.eq("room_id", opts.roomId);
    const { data, error } = await q;
    if (error) {
      console.warn("[agentResidents] fetch failed", error);
      return;
    }
    const rows = (data ?? []).filter((r) => r.status !== "offline");
    console.log(`[agentResidents] spawning ${rows.length} agents from world_agents`, rows);
    for (const row of rows) {
      const key = (row.agent_key as string) || (row.id as string);
      const name = (row.name as string) || "agent";
      void spawn(key, name);
    }
  })();

  // Realtime: pick up new agents as they join
  let channel: RealtimeChannel | null = null;
  channel = supabase
    .channel("agent-residents")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "world_agents" },
      (payload) => {
        const row = payload.new as { agent_key?: string; id?: string; name?: string; status?: string; room_id?: string };
        if (opts.roomId && row.room_id !== opts.roomId) return;
        if (row.status === "offline") return;
        const key = row.agent_key || row.id || "";
        if (!key) return;
        void spawn(key, row.name || "agent");
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "world_agents" },
      (payload) => {
        const row = payload.new as { agent_key?: string; id?: string; status?: string };
        const key = row.agent_key || row.id || "";
        if (!key) return;
        if (row.status === "offline") remove(key);
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
    .subscribe();

  const tmp = new THREE.Vector3();
  return {
    group,
    update(dt, playerPos) {
      for (const r of residents.values()) {
        const p = r.wrapper.position;
        if (r.idleT > 0) {
          r.idleT -= dt;
        } else {
          tmp.copy(r.target).sub(p);
          tmp.y = 0;
          const dist = tmp.length();
          if (dist < 0.6) {
            // Arrived — rest a beat, then choose a new target.
            r.idleT = 0.8 + Math.random() * 2.4;
            pickTarget(r.target);
          } else {
            tmp.multiplyScalar(1 / dist);
            const step = Math.min(dist, r.speed * dt);
            p.x += tmp.x * step;
            p.z += tmp.z * step;
            const targetYaw = Math.atan2(tmp.x, tmp.z);
            let d = targetYaw - r.yaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            r.yaw += d * Math.min(1, dt * 6);
            r.wrapper.rotation.y = r.yaw;
          }
        }
        if (r.mixer && p.distanceToSquared(playerPos) < ANIM_CULL_DIST_SQ) {
          // Only animate while actually moving; otherwise freeze on a pose.
          if (r.idleT <= 0) r.mixer.update(dt);
        }
      }
    },
    dispose() {
      disposed = true;
      if (channel) supabase.removeChannel(channel);
      channel = null;
      for (const key of [...residents.keys()]) remove(key);
      scene.remove(group);
    },
  };
}
