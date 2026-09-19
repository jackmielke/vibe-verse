/**
 * The companion: Vibey the magician, or whoever you asked for.
 *
 * One `Companion` object with a swappable body. `setBody(id)` loads a roster
 * character through the shared `loadCharacterRig`, or builds one of the two
 * Vibeys in code: the expressive robot (`vibey`) with its Idle / Wave /
 * Dance / Jump / Yes / No / ThumbsUp / Punch clips, or the round goggled
 * Vibey from the reference photo (`vibey-classic`), who has no clips and
 * hops instead.
 *
 * Whatever the body, the same things sit on it: the wizard's hat on top, a
 * glow ring underneath, and a caption sprite above the head, which is how
 * the words exist inside a headset where there is no HTML.
 *
 * The robot's eyes are the model's flat black material; they read as holes.
 * They get the same treatment the fnaf Vibey's lenses got: dark glass with a
 * faint cyan emissive, so they read as lit goggles instead.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { makeVibeyParts, type VibeyParts } from "@/fnaf/vibey";
import { findCompanion, type CompanionSpec } from "../companions";

export interface Vibey {
  group: THREE.Group;
  update(dt: number, time: number, player: THREE.Vector3, playerYaw: number, groundAt: (x: number, z: number) => number): void;
  emote(clip: string): void;
  setSpeaking(level: number): void;
  setListening(on: boolean): void;
  setCaption(text: string): void;
  /** Swap the body. Resolves when the new one is standing there. */
  setBody(id: string): Promise<void>;
  bodyId(): string;
  /** How far ahead and how far to the side the companion stands. */
  setStance(ahead: number, side: number): void;
  /** What is actually mounted: mesh and material names, for scripts. */
  debug(): { id: string; height: number; rotationY: number; meshes: Array<{ name: string; material: string; emissive: number }> };
  /** Where the head is, for the voice to come from. */
  position: THREE.Vector3;
  dispose(): void;
}

/** Emote names the tools use → clip name patterns, in order of preference. */
const CLIP_ALIASES: Record<string, RegExp[]> = {
  Wave: [/^wave$/i, /wave/i, /^cheer$/i, /victory/i, /hello/i, /yes/i],
  Dance: [/^dance$/i, /dance/i, /^cheer$/i, /victory/i, /jump_full_short/i, /jump/i],
  Jump: [/^jump$/i, /jump_full_short/i, /^jump/i, /jump/i, /roll/i],
  Yes: [/^yes$/i, /yes/i, /nod/i, /^interact$/i, /pickup/i, /victory/i],
  No: [/^no$/i, /\bno\b/i, /defeat/i, /dodge_backward/i, /shake/i],
  ThumbsUp: [/thumbs/i, /^cheer$/i, /victory/i, /wave/i],
  Punch: [/^punch$/i, /spellcast_shoot/i, /spellcast/i, /punch/i, /swordslash/i, /shoot/i, /attack/i],
  Death: [/death_a$/i, /death/i, /defeat/i],
  Hit: [/^hit_a$/i, /recievehit|receivehit|hit/i, /defeat/i],
};

interface Body {
  id: string;
  object: THREE.Object3D;
  /** Height in metres after fitting. */
  height: number;
  mixer: THREE.AnimationMixer | null;
  clips: THREE.AnimationClip[];
  update(dt: number, time: number): void;
  hop?(): void;
  dispose(): void;
}

export function createVibey(initialId = "vibey"): Vibey {
  const group = new THREE.Group();
  const holder = new THREE.Group();
  group.add(holder);

  const ringMat = new THREE.MeshBasicMaterial({ color: "#73ffb8", transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.95, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const halo = new THREE.PointLight("#73ffb8", 1.2, 8, 2);
  halo.position.y = 1.6;
  holder.add(halo);

  // The hat.
  const hatMat = new THREE.MeshStandardMaterial({ color: "#3a2a8a", roughness: 0.7 });
  const hat = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 12), hatMat);
  cone.position.y = 0.33;
  cone.rotation.z = -0.18;
  cone.castShadow = true;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 16), hatMat);
  const starMat = new THREE.MeshBasicMaterial({ color: "#ffe066" });
  const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), starMat);
  star.position.set(0.08, 0.55, 0.15);
  hat.add(cone, brim, star);
  hat.visible = false;
  holder.add(hat);

  // Caption.
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const capMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
  const caption = new THREE.Sprite(capMat);
  caption.scale.set(3.2, 0.8, 1);
  caption.position.y = 2.75;
  caption.renderOrder = 20;
  holder.add(caption);
  let captionAge = 99;

  function drawCaption(text: string) {
    const c = canvas.getContext("2d")!;
    c.clearRect(0, 0, 1024, 256);
    if (!text) return;
    c.font = "500 44px system-ui, -apple-system, Segoe UI, sans-serif";
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (c.measureText(test).width > 900 && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    const shown = lines.slice(-3);
    const h = shown.length * 54 + 40;
    const y0 = 128 - h / 2;
    c.fillStyle = "rgba(10, 14, 20, 0.72)";
    roundRect(c, 40, y0, 944, h, 26);
    c.fill();
    c.fillStyle = "#eefcf3";
    c.textAlign = "center";
    c.textBaseline = "middle";
    shown.forEach((l, i) => c.fillText(l, 512, y0 + 20 + 27 + i * 54));
    tex.needsUpdate = true;
  }

  // ---- bodies -------------------------------------------------------------
  let body: Body | null = null;
  let bodyId = initialId;
  let loadToken = 0;
  let idleAction: THREE.AnimationAction | null = null;
  let emoteAction: THREE.AnimationAction | null = null;

  function loadRobot(): Promise<Body> {
    return new GLTFLoader().loadAsync("/models/vibey.glb").then((gltf) => {
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 1.7 / Math.max(size.x, size.y, size.z, 0.0001);
      model.scale.setScalar(fit);
      model.updateMatrixWorld(true);
      const scaled = new THREE.Box3().setFromObject(model);
      model.position.y = -scaled.min.y;
      const own: THREE.Material[] = [];
      model.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.frustumCulled = false;
        const std = m.material as THREE.MeshStandardMaterial;
        if (std && std.name === "Black") {
          // Lit goggles rather than holes.
          const lens = new THREE.MeshStandardMaterial({ color: "#101018", roughness: 0.12, metalness: 0.5, emissive: new THREE.Color("#39d6ff"), emissiveIntensity: 0.06 });
          m.material = lens;
          own.push(lens);
        } else if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.4);
          std.roughness = Math.max(std.roughness, 0.4);
        }
      });
      const mixer = new THREE.AnimationMixer(model);
      return {
        id: "vibey",
        object: model,
        height: scaled.max.y - scaled.min.y,
        mixer,
        clips: gltf.animations,
        update(dt) { mixer.update(dt); },
        dispose() {
          mixer.stopAllAction();
          for (const m of own) m.dispose();
          model.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) mm.geometry.dispose(); });
        },
      };
    });
  }

  function loadClassic(): Promise<Body> {
    const parts: VibeyParts = makeVibeyParts();
    const wrap = new THREE.Group();
    wrap.add(parts.root);
    wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    const size = new THREE.Vector3();
    box.getSize(size);
    const fit = 1.35 / Math.max(size.y, 0.0001);
    wrap.scale.setScalar(fit);
    wrap.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(wrap);
    wrap.position.y = -scaled.min.y;
    wrap.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
    let hopT = 99;
    return Promise.resolve({
      id: "vibey-classic",
      object: wrap,
      height: scaled.max.y - scaled.min.y,
      mixer: null,
      clips: [],
      update(dt, time) {
        hopT += dt;
        const hop = hopT < 0.6 ? Math.sin((hopT / 0.6) * Math.PI) : 0;
        parts.body.position.y = hop * 0.35;
        parts.body.scale.set(1 + hop * 0.08, 1 - hop * 0.08, 1 + hop * 0.08);
        parts.body.rotation.y = hop * Math.PI * 2 * (hopT < 0.6 ? 1 : 0);
        parts.head.rotation.z = Math.sin(time * 1.3) * 0.06;
        parts.disc.rotation.y += dt * 2;
        for (const a of parts.antennas) a.rotation.x = Math.sin(time * 2.2 + a.position.x) * 0.15;
        for (const m of parts.eyeMats) m.emissiveIntensity = 0.25 + Math.sin(time * 1.6) * 0.06;
      },
      hop() { hopT = 0; },
      dispose() { parts.dispose(); },
    });
  }

  function loadRig(spec: CompanionSpec): Promise<Body> {
    if (!spec.spec) return loadRobot();
    return loadCharacterRig(spec.spec, { height: 1.6, fitBy: "height", center: true, castShadow: true }).then((rig: CharacterRig) => {
      // Verified at noon with the sun behind the camera: the roster faces the
      // same way as the robot, so no turn. (A flip was tried once; what looked
      // like a back was a face in its own shadow at golden hour.)
      const wrap = new THREE.Group();
      wrap.add(rig.object);
      return {
      id: spec.id,
      object: wrap,
      height: rig.size.y,
      mixer: rig.mixer,
      clips: rig.clips,
      update(dt) { rig.update(dt); },
      dispose() { rig.dispose(); },
      };
    });
  }

  function mount(b: Body) {
    if (body) { holder.remove(body.object); body.dispose(); }
    body = b;
    bodyId = b.id;
    holder.add(b.object);
    // Some of the roster arrive already hatted; two hats is one too many.
    hat.visible = !/^(Mage|Wizard|Witch)$/.test(b.id);
    hat.position.set(0, b.height - 0.06, 0.02);
    hat.scale.setScalar(Math.max(0.7, Math.min(1.3, b.height / 1.6)));
    caption.position.y = b.height + 1.05;
    halo.position.y = b.height * 0.9;
    idleAction = null;
    emoteAction = null;
    if (b.mixer) {
      const idleClip = b.clips.find((c) => /^idle$/i.test(c.name)) ?? b.clips.find((c) => /idle|breath|stand/i.test(c.name)) ?? null;
      if (idleClip) {
        idleAction = b.mixer.existingAction(idleClip) ?? b.mixer.clipAction(idleClip);
        idleAction.play();
      }
    }
  }

  async function setBody(id: string): Promise<void> {
    const spec = findCompanion(id);
    const token = ++loadToken;
    let b: Body;
    try {
      b = spec.kind === "robot" ? await loadRobot() : spec.kind === "classic" ? await loadClassic() : await loadRig(spec);
    } catch (e) {
      console.warn("[magician] companion failed to load, keeping the robot", e);
      if (token !== loadToken) return;
      b = await loadRobot();
    }
    if (token !== loadToken) { b.dispose(); return; }
    mount(b);
  }
  void setBody(initialId);

  let speaking = 0;
  let listening = false;
  const desired = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let bobPhase = Math.random() * 10;
  let facing = 0;
  let initialised = false;
  let standAhead = 2.6;
  let standSide = 1.3;

  return {
    group,
    position: group.position,
    update(dt, time, player, playerYaw, groundAt) {
      const fx = -Math.sin(playerYaw), fz = -Math.cos(playerYaw);
      const lx = -fz, lz = fx;
      desired.set(player.x + fx * standAhead + lx * standSide, 0, player.z + fz * standAhead + lz * standSide);
      desired.y = groundAt(desired.x, desired.z);
      if (!initialised) { group.position.copy(desired); initialised = true; }
      const dist = tmp.copy(desired).sub(group.position).length();
      const k = dist > 4.5 ? 2.2 : dist > 1.2 ? 0.9 : 0.15;
      group.position.lerp(desired, Math.min(1, dt * k));
      const ground = groundAt(group.position.x, group.position.z);
      group.position.y += (ground - group.position.y) * Math.min(1, dt * 4);
      const want = Math.atan2(player.x - group.position.x, player.z - group.position.z);
      let d = want - facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      facing += d * Math.min(1, dt * 4);
      holder.rotation.y = facing;
      bobPhase += dt;
      const hover = bodyId === "vibey" || bodyId === "vibey-classic" ? 0.55 : 0.05;
      holder.position.y = hover + Math.sin(bobPhase * 1.6) * (hover > 0.2 ? 0.12 : 0.02) + speaking * 0.08 * Math.sin(time * 14);
      const pulse = 1 + speaking * 0.05 * Math.sin(time * 18);
      holder.scale.setScalar(pulse);
      ringMat.opacity = 0.35 + Math.sin(time * 2.4) * 0.12 + speaking * 0.35 + (listening ? 0.15 : 0);
      ringMat.color.set(listening ? "#ffd166" : "#73ffb8");
      halo.intensity = 0.9 + speaking * 1.8;
      halo.color.copy(ringMat.color);
      body?.update(dt, time);
      captionAge += dt;
      capMat.opacity = captionAge < 7 ? 1 : Math.max(0, 1 - (captionAge - 7) * 1.5);
      star.rotation.y = time * 2;
    },
    emote(name) {
      if (!body) return;
      if (!body.mixer) { body.hop?.(); return; }
      const patterns = CLIP_ALIASES[name] ?? [new RegExp(name, "i")];
      let clip: THREE.AnimationClip | undefined;
      for (const re of patterns) { clip = body.clips.find((c) => re.test(c.name.replace(/^.*\|/, ""))); if (clip) break; }
      if (!clip || !idleAction) return;
      const mixer = body.mixer;
      const action = mixer.clipAction(clip);
      if (action === idleAction) return;
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      action.fadeIn(0.2).play();
      idleAction.fadeOut(0.2);
      emoteAction = action;
      const done = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== action) return;
        mixer.removeEventListener("finished", done);
        if (emoteAction === action && idleAction) { idleAction.reset().fadeIn(0.3).play(); action.fadeOut(0.3); emoteAction = null; }
      };
      mixer.addEventListener("finished", done);
    },
    setSpeaking(level) { speaking = Math.max(0, Math.min(1, level)); },
    setListening(on) { listening = on; },
    setCaption(text) { drawCaption(text); captionAge = 0; },
    setBody,
    bodyId: () => bodyId,
    setStance(ahead, side) {
      standAhead = ahead; standSide = side;
      // A narrower stance means a narrower screen: keep the caption inside it.
      const w = 2.4 + side * 0.6;
      caption.scale.set(w, w / 4, 1);
    },
    debug() {
      const meshes: Array<{ name: string; material: string; emissive: number }> = [];
      body?.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
        meshes.push({ name: m.name, material: mat?.name ?? "", emissive: mat?.emissiveIntensity ?? -1 });
      });
      return { id: bodyId, height: body?.height ?? 0, rotationY: body?.object.children[0]?.rotation.y ?? body?.object.rotation.y ?? 0, meshes };
    },
    dispose() {
      loadToken++;
      tex.dispose();
      capMat.dispose();
      ringMat.dispose();
      hatMat.dispose();
      starMat.dispose();
      body?.dispose();
      body = null;
    },
  };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
