/**
 * Vibe Kart — netplay.
 *
 * The multiplayer layer is deliberately parasitic on the single-player race:
 * the field is still eight karts, the track, items and race director are
 * untouched. What changes is *who drives* a given slot. Every peer that joins
 * the room claims one of the AI slots; that racer is flagged `remote`, which
 * makes the AI skip it and the integrator leave it alone, and this system
 * writes its pose straight from the wire.
 *
 * That means: zero authority, zero rollback, zero server. Each client is
 * authoritative over its own kart and everybody else is a smoothed ghost. For
 * a party racer between friends that is exactly the right trade — collisions
 * between remote karts are approximate, but nothing ever rubber-bands.
 *
 * Transport is a Supabase Realtime channel: presence for "who is here", one
 * broadcast topic for poses at ~15 Hz.
 */
import { coursePrefix } from "../course";
import * as THREE from "three";
import { supabase } from "@/integrations/supabase/client";
import type { KartCtx, PhysicsService, RacerState, System } from "../types";
import { isBlocked, subscribeSafety } from "@/safety/safety";

/** What a peer's kart is labelled: "Player" once you have blocked them (App Store 1.2). */
const shown = (name: string, peerId: string): string => (isBlocked(name, peerId) ? "Player" : name);

/** `destroyRacer` is the model system's own extra, not part of the contract. */
type ModelsMaybe = { destroyRacer?(racerId: number): void } | undefined;

export interface KartNetConfig {
  /** Room code — everyone typing the same one races together. */
  room: string;
  /** Stable per-tab id. */
  peerId: string;
  name: string;
}

export interface KartNetPeer {
  peerId: string;
  name: string;
  racerId: number | null;
  lastSeen: number;
}

export interface KartNetService {
  peers(): KartNetPeer[];
  connected: boolean;
}

/** Pose broadcasts per second. Higher is smoother and noisier; 15 is plenty. */
const SEND_HZ = 15;
/** A peer that has not spoken for this long loses its slot back to the AI. */
const PEER_TIMEOUT = 6;

interface RemoteSlot {
  peer: KartNetPeer;
  racer: RacerState;
  target: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  speed: number;
}

export default function createNetplay(config: KartNetConfig) {
  return function netplayFactory(ctx: KartCtx): System {
    const physics = () => ctx.services.physics as PhysicsService | undefined;

    const slots = new Map<string, RemoteSlot>();
    const service: KartNetService = {
      peers: () => [...slots.values()].map((s) => s.peer),
      connected: false,
    };
    (ctx.services as Record<string, unknown>).net = service;

    const channel = supabase.channel(`kart-race-${coursePrefix()}${config.room}`, {
      config: { broadcast: { self: false }, presence: { key: config.peerId } },
    });

    /**
     * Put a peer's kart in the livery they chose in the lobby.
     *
     * `spawn` on an existing id is the physics system's own restart path, so
     * the racer object survives it; dropping the rig makes the model system
     * rebuild it in the new colours. Best effort throughout — a peer in the
     * wrong paint still races fine, and a peer with no kart does not.
     */
    function dress(racer: RacerState, name: string, characterId?: string | null): void {
      const phys = physics();
      racer.name = name;
      if (!phys || !characterId || characterId === racer.characterId) return;
      const slot = phys.racers.findIndex((r) => r.id === racer.id);
      try {
        phys.spawn({ id: racer.id, name, characterId, isPlayer: false, slot: Math.max(0, slot) });
        (ctx.services.models as ModelsMaybe)?.destroyRacer?.(racer.id);
      } catch (err) {
        console.error("[Vibe Kart/net] could not dress a peer's kart:", err);
      }
    }

    /** Hand a newly seen peer the free AI slot with the lowest id. */
    function claimSlot(peerId: string, name: string, characterId?: string | null): RemoteSlot | null {
      const phys = physics();
      if (!phys) return null;
      const taken = new Set([...slots.values()].map((s) => s.racer.id));
      const free = phys.racers.find((r) => !r.isPlayer && !taken.has(r.id));
      if (!free) return null;
      dress(free, shown(name, peerId), characterId);
      (free as RacerState & { remote?: boolean }).remote = true;
      const slot: RemoteSlot = {
        peer: { peerId, name, racerId: free.id, lastSeen: ctx.elapsed },
        racer: free,
        target: free.position.clone(),
        targetQuat: free.quaternion.clone(),
        speed: 0,
      };
      slots.set(peerId, slot);
      return slot;
    }

    function releaseSlot(peerId: string): void {
      const slot = slots.get(peerId);
      if (!slot) return;
      (slot.racer as RacerState & { remote?: boolean }).remote = false;
      slots.delete(peerId);
    }

    channel.on("broadcast", { event: "pose" }, ({ payload }) => {
      const p = payload as {
        peerId: string;
        name: string;
        characterId?: string | null;
        pos: [number, number, number];
        quat: [number, number, number, number];
        speed: number;
      };
      if (!p || p.peerId === config.peerId) return;
      const slot = slots.get(p.peerId) ?? claimSlot(p.peerId, p.name || "Racer", p.characterId);
      if (!slot) return;
      slot.peer.lastSeen = ctx.elapsed;
      slot.peer.name = p.name || slot.peer.name;
      // Re-read every packet, not just the first: between two races in the same
      // room a peer can go back to the lobby and pick a different racer.
      dress(slot.racer, shown(slot.peer.name, p.peerId), p.characterId);
      slot.target.set(p.pos[0], p.pos[1], p.pos[2]);
      slot.targetQuat.set(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
      slot.speed = p.speed;
    });

    channel.on("presence", { event: "leave" }, ({ key }) => releaseSlot(String(key)));

    channel.subscribe((status) => {
      service.connected = status === "SUBSCRIBED";
      if (status === "SUBSCRIBED") {
        void channel.track({ peerId: config.peerId, name: config.name });
      }
    });

    // Blocking mid-race relabels the kart; the race itself is untouched.
    const offSafety = subscribeSafety(() => {
      for (const slot of slots.values()) slot.racer.name = shown(slot.peer.name, slot.peer.peerId);
    });

    let sendAcc = 0;

    return {
      update(dt) {
        const phys = physics();
        if (!phys) return;

        // Send our own pose.
        sendAcc += dt;
        if (service.connected && sendAcc >= 1 / SEND_HZ) {
          sendAcc = 0;
          const me = phys.player;
          if (me) {
            void channel.send({
              type: "broadcast",
              event: "pose",
              payload: {
                peerId: config.peerId,
                name: config.name,
                // Physics is the authority on what you are driving — reading it
                // rather than a captured config means a racer swapped between
                // races reaches the others without reopening the channel.
                characterId: me.characterId,
                pos: [me.position.x, me.position.y, me.position.z],
                quat: [me.quaternion.x, me.quaternion.y, me.quaternion.z, me.quaternion.w],
                speed: me.speed,
              },
            });
          }
        }

        // Smooth every ghost toward its last known pose. A hard snap at 15 Hz
        // reads as strobing; a lerp at frame rate reads as driving.
        const blend = 1 - Math.pow(0.0001, dt);
        for (const [peerId, slot] of slots) {
          if (ctx.elapsed - slot.peer.lastSeen > PEER_TIMEOUT) {
            releaseSlot(peerId);
            continue;
          }
          const r = slot.racer;
          // Dead-reckon forward so a late packet does not stall the kart.
          const age = Math.min(ctx.elapsed - slot.peer.lastSeen, 0.5);
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(slot.targetQuat);
          const predicted = slot.target.clone().addScaledVector(fwd, slot.speed * age);
          if (r.position.distanceTo(predicted) > 40) r.position.copy(predicted);
          else r.position.lerp(predicted, blend);
          r.quaternion.slerp(slot.targetQuat, blend);
          r.velocity.copy(fwd).multiplyScalar(slot.speed);
          r.speed = slot.speed;
          r.rpm = Math.min(1, Math.abs(slot.speed) / 40);
          r.wheelSpin += slot.speed * dt * 2.2;
          if (r.object) {
            r.object.position.copy(r.position);
            r.object.quaternion.copy(r.quaternion);
          }
        }
      },

      dispose() {
        offSafety();
        for (const peerId of [...slots.keys()]) releaseSlot(peerId);
        void supabase.removeChannel(channel);
        delete (ctx.services as Record<string, unknown>).net;
      },
    };
  };
}
