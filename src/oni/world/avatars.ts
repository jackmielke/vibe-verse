/**
 * A player in the square: their character from the roster, a name over
 * their head, and horns when they are oni.
 *
 * Bodies come from the shared `loadCharacterRig`, so anybody in
 * `src/lib/characters.ts` can play, including the code-built half of the
 * cast that has no file. Until a body has loaded (or if it never does) the
 * player is a soft capsule in their own colour, so nobody is ever invisible.
 */
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { RUN_SPEED, hash } from "../rules";

export const BODY_HEIGHT = 1.7;

export interface Avatar {
  group: THREE.Group;
  char(): string;
  setChar(id: string): void;
  setName(name: string): void;
  setOni(on: boolean): void;
  /** An emoji that pops out over the head. */
  emote(e: string): void;
  /** Hide the body (our own, in a headset) while keeping the tag. */
  setBodyVisible(v: boolean): void;
  /** `speed` in m/s, `air` whether off the ground. */
  update(dt: number, speed: number, air: boolean): void;
  dispose(): void;
}

function tagTexture(name: string, oni: boolean, big: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  const label = (oni ? "👹 " : "") + name.slice(0, 16);
  g.font = `600 ${big ? 58 : 50}px system-ui, sans-serif`;
  const w = Math.min(500, g.measureText(label).width + 56);
  g.fillStyle = oni ? "rgba(200,30,30,0.85)" : "rgba(12,14,24,0.62)";
  g.beginPath();
  g.roundRect(256 - w / 2, 18, w, 92, 46);
  g.fill();
  g.fillStyle = oni ? "#fff2e0" : "#f5f0ff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function emojiTexture(e: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d")!;
  g.font = "96px system-ui, 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(e, 64, 72);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Shared by every avatar.
let shared: { horn: THREE.ConeGeometry; band: THREE.TorusGeometry; hornMat: THREE.MeshStandardMaterial; bandMat: THREE.MeshStandardMaterial; glow: THREE.CanvasTexture; capsule: THREE.CapsuleGeometry; users: number } | null = null;
function acquire() {
  if (!shared) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,255,255,0.9)");
    gr.addColorStop(0.5, "rgba(255,255,255,0.35)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    shared = {
      horn: new THREE.ConeGeometry(0.09, 0.42, 10),
      band: new THREE.TorusGeometry(0.2, 0.035, 6, 20),
      hornMat: new THREE.MeshStandardMaterial({ color: "#ff3b2a", emissive: "#ff2a10", emissiveIntensity: 0.9, roughness: 0.4 }),
      bandMat: new THREE.MeshStandardMaterial({ color: "#ffd35a", emissive: "#6a4a00", roughness: 0.4, metalness: 0.2 }),
      glow: new THREE.CanvasTexture(c),
      capsule: new THREE.CapsuleGeometry(0.3, 0.9, 6, 12),
      users: 0,
    };
  }
  shared.users++;
  return shared;
}
function release() {
  if (!shared) return;
  if (--shared.users > 0) return;
  shared.horn.dispose(); shared.band.dispose(); shared.hornMat.dispose(); shared.bandMat.dispose(); shared.glow.dispose(); shared.capsule.dispose();
  shared = null;
}

export function colourFor(id: string): THREE.Color {
  return new THREE.Color().setHSL((hash(id) % 360) / 360, 0.7, 0.58);
}

export function createAvatar(opts: { id: string; name: string; char: string; big?: boolean }): Avatar {
  const s = acquire();
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const colour = colourFor(opts.id);

  // Placeholder until the rig arrives.
  const placeholderMat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, transparent: true, opacity: 0.8 });
  const placeholder = new THREE.Mesh(s.capsule, placeholderMat);
  placeholder.position.y = 0.8;
  body.add(placeholder);

  // Horns on a gold band, only while oni.
  const horns = new THREE.Group();
  const band = new THREE.Mesh(s.band, s.bandMat);
  band.rotation.x = Math.PI / 2;
  horns.add(band);
  for (const side of [-1, 1]) {
    const h = new THREE.Mesh(s.horn, s.hornMat);
    h.position.set(side * 0.13, 0.2, 0);
    h.rotation.z = -side * 0.35;
    horns.add(h);
  }
  horns.visible = false;
  body.add(horns);

  // The glow under an oni's feet.
  const glowMat = new THREE.MeshBasicMaterial({ map: s.glow, color: "#ff3a20", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03;
  group.add(glow);
  // A coloured ring for everybody, so a crowd reads as separate people from above.
  const ringMat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.55, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 28), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  group.add(ring);

  let name = opts.name;
  let oni = false;
  const big = !!opts.big;
  let tagTex = tagTexture(name, oni, big);
  const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false, depthTest: false });
  const tag = new THREE.Sprite(tagMat);
  tag.renderOrder = 10;
  const tagScale = big ? 3.6 : 1.6;
  tag.scale.set(tagScale, tagScale / 4, 1);
  tag.position.y = BODY_HEIGHT + 0.65;
  group.add(tag);

  const emotes: Array<{ sprite: THREE.Sprite; tex: THREE.CanvasTexture; t: number }> = [];

  let char = opts.char;
  let rig: CharacterRig | null = null;
  let loadToken = 0;
  let headY = BODY_HEIGHT * 0.96;
  let idle: THREE.AnimationAction | null = null;
  let run: THREE.AnimationAction | null = null;
  let jumpAct: THREE.AnimationAction | null = null;
  let loco = 0;
  let scale = 1;
  let disposed = false;

  function load(id: string) {
    const token = ++loadToken;
    const spec = findCharacter(id);
    loadCharacterRig(spec, { height: BODY_HEIGHT, fitBy: "height", center: true, castShadow: true, walkSpeed: RUN_SPEED }).then((r) => {
      if (disposed || token !== loadToken) { r.dispose(); return; }
      if (rig) { body.remove(rig.object); rig.dispose(); }
      rig = r;
      body.add(r.object);
      placeholder.visible = false;
      headY = Math.max(0.6, r.size.y * 0.96);
      idle = run = jumpAct = null;
      if (r.mixer && r.clips.length) {
        const find = (re: RegExp, not?: RegExp) => r.clips.find((c) => re.test(c.name) && !(not && not.test(c.name)));
        const idleClip = find(/idle|breath|stand/i, /gun|sword|shoot|attack/i) ?? r.clips[0];
        const runClip = find(/(^|[_|\s])run($|[_|\s])/i, /back|left|right|gun|shoot|carry|attack/i) ?? find(/run|sprint|jog/i, /back|gun|shoot/i) ?? find(/walk/i);
        const jumpClip = find(/jump/i, /land|idle/i);
        // The rig starts idle and walk actions itself; we drive the weights.
        for (const a of r.clips) { const act = r.mixer.existingAction(a); if (act) act.weight = 0; }
        idle = r.mixer.clipAction(idleClip); idle.play(); idle.weight = 1;
        if (runClip && runClip !== idleClip) { run = r.mixer.clipAction(runClip); run.setLoop(THREE.LoopRepeat, Infinity); run.play(); run.weight = 0; }
        if (jumpClip) { jumpAct = r.mixer.clipAction(jumpClip); jumpAct.setLoop(THREE.LoopRepeat, Infinity); jumpAct.play(); jumpAct.weight = 0; }
      }
      horns.position.y = headY;
    }).catch(() => { /* stays a capsule */ });
  }
  load(char);
  horns.position.y = headY;

  function redrawTag() {
    const old = tagTex;
    tagTex = tagTexture(name, oni, big);
    tagMat.map = tagTex;
    tagMat.needsUpdate = true;
    old.dispose();
  }

  let pulse = 0;
  return {
    group,
    char: () => char,
    setChar(id) { if (id === char) return; char = id; placeholder.visible = !rig; load(id); },
    setName(n) { if (n === name) return; name = n; redrawTag(); },
    setOni(on) {
      if (on === oni) return;
      oni = on;
      horns.visible = on;
      redrawTag();
      if (on) pulse = 1;
    },
    emote(e) {
      const tex = emojiTexture(e);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      sprite.renderOrder = 11;
      sprite.scale.setScalar(0.9);
      sprite.position.y = BODY_HEIGHT + 1.2;
      group.add(sprite);
      emotes.push({ sprite, tex, t: 0 });
    },
    setBodyVisible(v) { body.visible = v; ring.visible = v; },
    update(dt, speed, air) {
      rig?.update(dt);
      const m = Math.min(1, speed / (RUN_SPEED * 0.7));
      loco += (m - loco) * Math.min(1, dt * 10);
      if (rig && !rig.mixer) rig.setLocomotion(Math.min(1, speed / RUN_SPEED));
      if (idle) {
        const j = air && jumpAct ? 1 : 0;
        idle.weight = (1 - loco) * (1 - j);
        if (run) { run.weight = loco * (1 - j); run.timeScale = 0.8 + loco * 0.5; }
        else idle.weight = 1 - j;
        if (jumpAct) jumpAct.weight = j;
      }
      if (!rig) placeholder.position.y = 0.8 + Math.abs(Math.sin(performance.now() / 90)) * 0.08 * loco;
      // Oni are a little bigger, and swell for a moment when they turn.
      pulse = Math.max(0, pulse - dt * 1.6);
      const target = (oni ? 1.12 : 1) + pulse * 0.35 * Math.sin(pulse * 14);
      scale += (target - scale) * Math.min(1, dt * 12);
      body.scale.setScalar(scale);
      const t = performance.now() / 1000;
      glowMat.opacity = oni ? 0.55 + Math.sin(t * 7) * 0.15 : 0;
      horns.children[1].rotation.x = horns.children[2].rotation.x = oni ? Math.sin(t * 9) * 0.05 : 0;
      tag.position.y = BODY_HEIGHT * scale + 0.6;
      for (let i = emotes.length - 1; i >= 0; i--) {
        const e = emotes[i];
        e.t += dt;
        const k = e.t / 1.8;
        e.sprite.position.y = BODY_HEIGHT + 1.1 + k * 1.2;
        e.sprite.scale.setScalar(0.6 + Math.min(1, e.t * 6) * 0.6);
        (e.sprite.material as THREE.SpriteMaterial).opacity = 1 - Math.max(0, k - 0.6) / 0.4;
        if (k >= 1) { group.remove(e.sprite); e.tex.dispose(); (e.sprite.material as THREE.Material).dispose(); emotes.splice(i, 1); }
      }
    },
    dispose() {
      disposed = true;
      rig?.dispose();
      placeholderMat.dispose();
      glowMat.dispose(); (glow.geometry as THREE.BufferGeometry).dispose();
      ringMat.dispose(); (ring.geometry as THREE.BufferGeometry).dispose();
      tagTex.dispose(); tagMat.dispose();
      for (const e of emotes) { e.tex.dispose(); (e.sprite.material as THREE.Material).dispose(); }
      release();
    },
  };
}
