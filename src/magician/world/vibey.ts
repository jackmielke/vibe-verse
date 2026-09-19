/**
 * Vibey, the magician.
 *
 * The same expressive robot as everywhere else in the vibeverse
 * (`/models/vibey.glb`, the three.js RobotExpressive), with its animation
 * clips finally used: Idle as a base, and Wave / Dance / Jump / Yes / No /
 * ThumbsUp / Punch as one-shot emotes the voice agent can trigger. The
 * subtitle above the head is a canvas sprite, so it also works in VR where
 * there is no HTML.
 *
 * Vibey follows the player, keeping a polite distance a little to one side
 * and always facing them, and pulses when speaking.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface Vibey {
  group: THREE.Group;
  update(dt: number, time: number, player: THREE.Vector3, playerYaw: number, groundAt: (x: number, z: number) => number): void;
  emote(clip: string): void;
  setSpeaking(level: number): void;
  setListening(on: boolean): void;
  setCaption(text: string): void;
  /** Where the head is, for the voice to come from. */
  position: THREE.Vector3;
  dispose(): void;
}

export function createVibey(): Vibey {
  const group = new THREE.Group();
  const holder = new THREE.Group();
  group.add(holder);

  // Glow ring on the ground and a soft halo, so Vibey reads at night.
  const ringMat = new THREE.MeshBasicMaterial({ color: "#73ffb8", transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.95, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const halo = new THREE.PointLight("#73ffb8", 1.2, 8, 2);
  halo.position.y = 1.6;
  holder.add(halo);

  // A wizard's hat, because a magician needs one. Sits on top of the head.
  const hatMat = new THREE.MeshStandardMaterial({ color: "#3a2a8a", roughness: 0.7 });
  const hat = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 12), hatMat);
  cone.position.y = 0.33;
  cone.rotation.z = -0.18;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 16), hatMat);
  const starMat = new THREE.MeshBasicMaterial({ color: "#ffe066" });
  const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), starMat);
  star.position.set(0.08, 0.55, 0.15);
  hat.add(cone, brim, star);
  hat.castShadow = true;
  hat.visible = false;
  holder.add(hat);

  let mixer: THREE.AnimationMixer | null = null;
  let idle: THREE.AnimationAction | null = null;
  let current: THREE.AnimationAction | null = null;
  const clips = new Map<string, THREE.AnimationClip>();
  let model: THREE.Group | null = null;
  let headBone: THREE.Object3D | null = null;

  const loader = new GLTFLoader();
  loader.load("/models/vibey.glb", (gltf) => {
    model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const fit = 1.7 / Math.max(size.x, size.y, size.z, 0.0001);
    model.scale.setScalar(fit);
    model.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(model);
    model.position.y = -scaled.min.y;
    model.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; }
      if (obj.name === "Head" || obj.name === "Head_1") headBone = obj;
    });
    holder.add(model);
    mixer = new THREE.AnimationMixer(model);
    for (const c of gltf.animations) clips.set(c.name, c);
    const idleClip = clips.get("Idle");
    if (idleClip) {
      idle = mixer.clipAction(idleClip);
      idle.play();
      current = idle;
    }
    hat.visible = true;
    hat.position.set(0, scaled.max.y - scaled.min.y - 0.08, 0.02);
  });

  // Caption sprite.
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
    // Wrap into at most three lines.
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

  let speaking = 0;
  let listening = false;
  const desired = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let bobPhase = Math.random() * 10;
  let facing = 0;
  let initialised = false;

  return {
    group,
    position: group.position,
    update(dt, time, player, playerYaw, groundAt) {
      // Target: 2.6 m in front of the player and 1.2 m to their left.
      const fx = -Math.sin(playerYaw), fz = -Math.cos(playerYaw);
      const lx = -fz, lz = fx;
      desired.set(player.x + fx * 2.6 + lx * 1.3, 0, player.z + fz * 2.6 + lz * 1.3);
      desired.y = groundAt(desired.x, desired.z);
      if (!initialised) { group.position.copy(desired); initialised = true; }
      const dist = tmp.copy(desired).sub(group.position).length();
      // Only drift over when the player has moved a fair way, so Vibey does
      // not orbit nervously every time you turn your head.
      const k = dist > 4.5 ? 2.2 : dist > 1.2 ? 0.9 : 0.15;
      group.position.lerp(desired, Math.min(1, dt * k));
      const ground = groundAt(group.position.x, group.position.z);
      group.position.y += (ground - group.position.y) * Math.min(1, dt * 4);
      // Face the player.
      const want = Math.atan2(player.x - group.position.x, player.z - group.position.z);
      let d = want - facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      facing += d * Math.min(1, dt * 4);
      holder.rotation.y = facing;
      // Hover and bob.
      bobPhase += dt;
      holder.position.y = 0.55 + Math.sin(bobPhase * 1.6) * 0.12 + speaking * 0.08 * Math.sin(time * 14);
      const pulse = 1 + speaking * 0.05 * Math.sin(time * 18);
      holder.scale.setScalar(pulse);
      ringMat.opacity = 0.35 + Math.sin(time * 2.4) * 0.12 + speaking * 0.35 + (listening ? 0.15 : 0);
      ringMat.color.set(listening ? "#ffd166" : "#73ffb8");
      halo.intensity = 0.9 + speaking * 1.8;
      halo.color.copy(ringMat.color);
      mixer?.update(dt);
      captionAge += dt;
      capMat.opacity = captionAge < 7 ? 1 : Math.max(0, 1 - (captionAge - 7) * 1.5);
      if (headBone && speaking > 0) headBone.rotation.x = Math.sin(time * 16) * 0.06 * speaking;
      star.rotation.y = time * 2;
    },
    emote(name) {
      if (!mixer) return;
      const clip = clips.get(name);
      if (!clip || !idle) return;
      const action = mixer.clipAction(clip);
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      action.fadeIn(0.2).play();
      idle.fadeOut(0.2);
      current = action;
      const done = () => {
        mixer?.removeEventListener("finished", done);
        if (current === action && idle) { idle.reset().fadeIn(0.3).play(); action.fadeOut(0.3); current = idle; }
      };
      mixer.addEventListener("finished", done);
    },
    setSpeaking(level) { speaking = Math.max(0, Math.min(1, level)); },
    setListening(on) { listening = on; },
    setCaption(text) { drawCaption(text); captionAge = 0; },
    dispose() {
      tex.dispose();
      capMat.dispose();
      ringMat.dispose();
      hatMat.dispose();
      starMat.dispose();
      mixer?.stopAllAction();
      model?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose()); }
      });
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
