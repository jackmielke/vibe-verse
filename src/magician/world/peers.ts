/**
 * Ghosts of the other players.
 *
 * Nobody downloads a second character rig for somebody else: a peer is a
 * small figure built from three primitives in a colour hashed from their id,
 * with a name tag, and a wizard's hat if their companion is one. It eases
 * toward the last presence it heard, so eight packets a second look like
 * walking.
 */
import * as THREE from "three";
import type { PeerPresence } from "../net";

export interface Peers {
  group: THREE.Group;
  sync(list: PeerPresence[]): void;
  update(dt: number, time: number, groundAt: (x: number, z: number) => number): void;
  count(): number;
  dispose(): void;
}

interface Ghost {
  group: THREE.Group;
  body: THREE.Group;
  target: THREE.Vector3;
  yaw: number;
  mat: THREE.MeshStandardMaterial;
  tag: THREE.Sprite;
  tagTex: THREE.CanvasTexture;
  talking: boolean;
  ring: THREE.Mesh;
}

function colourFor(id: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.55);
}

function makeTag(name: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(10,14,20,0.65)";
  ctx.beginPath();
  ctx.roundRect(60, 24, 392, 80, 24);
  ctx.fill();
  ctx.fillStyle = "#f3ecff";
  ctx.font = "500 44px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name.slice(0, 18), 256, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createPeers(): Peers {
  const group = new THREE.Group();
  const ghosts = new Map<string, Ghost>();
  const bodyGeo = new THREE.CapsuleGeometry(0.32, 0.9, 6, 12);
  const headGeo = new THREE.SphereGeometry(0.26, 14, 10);
  const ringGeo = new THREE.RingGeometry(0.45, 0.6, 24);
  const hatGeo = new THREE.ConeGeometry(0.24, 0.6, 10);
  const hatMat = new THREE.MeshStandardMaterial({ color: "#3a2a8a", roughness: 0.7 });

  function make(p: PeerPresence): Ghost {
    const g = new THREE.Group();
    const body = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: colourFor(p.id), roughness: 0.6, transparent: true, opacity: 0.85 });
    const torso = new THREE.Mesh(bodyGeo, mat); torso.position.y = 0.95; torso.castShadow = true;
    const head = new THREE.Mesh(headGeo, mat); head.position.y = 1.75; head.castShadow = true;
    const hat = new THREE.Mesh(hatGeo, hatMat); hat.position.y = 2.25; hat.rotation.z = -0.15;
    body.add(torso, head, hat);
    const ringMat = new THREE.MeshBasicMaterial({ color: mat.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    const tagTex = makeTag(p.name);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false }));
    tag.scale.set(1.6, 0.4, 1); tag.position.y = 2.75;
    g.add(body, ring, tag);
    g.position.set(p.x, p.y, p.z);
    group.add(g);
    return { group: g, body, target: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw, mat, tag, tagTex, talking: p.talking, ring };
  }

  return {
    group,
    sync(list) {
      const seen = new Set<string>();
      for (const p of list) {
        seen.add(p.id);
        let g = ghosts.get(p.id);
        if (!g) { g = make(p); ghosts.set(p.id, g); }
        g.target.set(p.x, p.y, p.z);
        g.yaw = p.yaw;
        g.talking = p.talking;
      }
      for (const [id, g] of ghosts) {
        if (seen.has(id)) continue;
        group.remove(g.group);
        g.mat.dispose(); g.tagTex.dispose(); (g.tag.material as THREE.Material).dispose(); (g.ring.material as THREE.Material).dispose();
        ghosts.delete(id);
      }
    },
    update(dt, time, groundAt) {
      for (const g of ghosts.values()) {
        g.group.position.lerp(g.target, Math.min(1, dt * 8));
        const ground = groundAt(g.group.position.x, g.group.position.z);
        if (g.group.position.y < ground - 0.5) g.group.position.y = ground;
        let d = g.yaw - g.body.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        g.body.rotation.y += d * Math.min(1, dt * 8);
        const moving = g.group.position.distanceToSquared(g.target) > 0.01 ? 1 : 0;
        g.body.position.y = Math.abs(Math.sin(time * 9)) * 0.05 * moving;
        (g.ring.material as THREE.MeshBasicMaterial).opacity = g.talking ? 0.5 + Math.sin(time * 8) * 0.3 : 0.25;
      }
    },
    count: () => ghosts.size,
    dispose() {
      for (const g of ghosts.values()) { g.mat.dispose(); g.tagTex.dispose(); (g.tag.material as THREE.Material).dispose(); (g.ring.material as THREE.Material).dispose(); }
      ghosts.clear();
      bodyGeo.dispose(); headGeo.dispose(); ringGeo.dispose(); hatGeo.dispose(); hatMat.dispose();
    },
  };
}
