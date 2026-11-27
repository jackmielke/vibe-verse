/**
 * Draws a Wizard world: every Thing is a group of primitives, eased into
 * existence, gently animated, culled by distance.
 *
 * Two rules keep it cheap enough to drop into a scene as heavy as /city:
 *
 *  - **No real lights.** A wish with a `light` gets a glowing halo sprite, not
 *    a PointLight. Adding a light to a three scene changes the light count in
 *    every material's shader, so one wished lantern would recompile the whole
 *    city on every machine on the island.
 *  - **Static parts are merged.** Parts with no animation that share a
 *    material become one mesh, so a 70-part dragon is a handful of draw calls.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Anim, Part, Thing, WorldState } from "../../supabase/functions/vibe-wizard/spec.ts";

const DEG = Math.PI / 180;

/** Every shape fitted to a 1 x 1 x 1 box centred on the origin. */
function unit(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
  g.scale(sx > 1e-4 ? 1 / sx : 1, sy > 1e-4 ? 1 / sy : 1, sz > 1e-4 ? 1 / sz : 1);
  return g;
}

let shapeCache: Map<string, THREE.BufferGeometry> | null = null;
function shape(s: Part["s"]): THREE.BufferGeometry {
  if (!shapeCache) {
    shapeCache = new Map<string, THREE.BufferGeometry>([
      ["box", unit(new THREE.BoxGeometry(1, 1, 1))],
      ["sphere", unit(new THREE.SphereGeometry(0.5, 20, 14))],
      ["cylinder", unit(new THREE.CylinderGeometry(0.5, 0.5, 1, 20))],
      ["cone", unit(new THREE.ConeGeometry(0.5, 1, 20))],
      ["torus", unit(new THREE.TorusGeometry(0.36, 0.14, 12, 30))],
      ["capsule", unit(new THREE.CapsuleGeometry(0.3, 0.6, 6, 14))],
      ["pyramid", unit(new THREE.ConeGeometry(0.5, 1, 4).rotateY(Math.PI / 4))],
      ["gem", unit(new THREE.OctahedronGeometry(0.5))],
      ["icosa", unit(new THREE.IcosahedronGeometry(0.5))],
      ["dodeca", unit(new THREE.DodecahedronGeometry(0.5))],
      ["ring", unit(new THREE.TorusGeometry(0.45, 0.05, 8, 40).rotateX(Math.PI / 2))],
      ["text", new THREE.PlaneGeometry(1, 1)],
    ]);
  }
  return shapeCache.get(s) ?? shapeCache.get("box")!;
}

let dotTex: THREE.Texture | null = null;
function dot(): THREE.Texture | null {
  if (dotTex || typeof document === "undefined") return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

function textTexture(text: string, color: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "rgba(255,250,235,0.96)";
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = "rgba(60,40,20,0.6)";
  g.lineWidth = 8;
  g.strokeRect(4, 4, 504, 120);
  g.fillStyle = color;
  let size = 72;
  g.font = `bold ${size}px system-ui, sans-serif`;
  while (g.measureText(text).width > 480 && size > 20) {
    size -= 4;
    g.font = `bold ${size}px system-ui, sans-serif`;
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelSprite(text: string): THREE.Sprite | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const g = c.getContext("2d");
  if (!g) return null;
  g.font = "600 40px system-ui, sans-serif";
  const w = Math.min(500, g.measureText(text).width + 40);
  g.fillStyle = "rgba(20,12,40,0.72)";
  g.beginPath();
  g.roundRect?.((512 - w) / 2, 14, w, 68, 34);
  g.fill();
  g.fillStyle = "#ffe9a8";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 50, 480);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(4, 0.75, 1);
  s.renderOrder = 10;
  return s;
}

const FX_LOOK: Record<string, { color: string; n: number; size: number; up: number; spread: number; additive: boolean }> = {
  sparkles: { color: "#fff3a0", n: 40, size: 0.35, up: 0.4, spread: 1.6, additive: true },
  fire: { color: "#ff7a22", n: 50, size: 0.7, up: 2.2, spread: 0.6, additive: true },
  smoke: { color: "#9a9a9a", n: 30, size: 1.4, up: 1.2, spread: 0.8, additive: false },
  snow: { color: "#ffffff", n: 60, size: 0.25, up: -1.0, spread: 3, additive: false },
  bubbles: { color: "#a8e8ff", n: 30, size: 0.45, up: 0.9, spread: 1.4, additive: true },
  hearts: { color: "#ff6fa8", n: 24, size: 0.5, up: 0.8, spread: 1.4, additive: true },
  rain: { color: "#9ec8ff", n: 70, size: 0.18, up: -6, spread: 3, additive: false },
  confetti: { color: "#ffffff", n: 60, size: 0.3, up: -0.8, spread: 2.5, additive: false },
  fireflies: { color: "#d8ff6a", n: 30, size: 0.3, up: 0.1, spread: 3, additive: true },
};

interface Animated { obj: THREE.Object3D; a: Anim; base: THREE.Vector3; baseRot: THREE.Euler; baseScale: THREE.Vector3; phase: number }

interface Drawn {
  key: string;
  thing: Thing;
  group: THREE.Group;
  /** Inner group that carries the thing-level animation and the appear scale. */
  body: THREE.Group;
  anims: Animated[];
  fx: THREE.Points | null;
  fxSeed: Float32Array | null;
  label: THREE.Sprite | null;
  born: number;
  dying: number;
  disposables: Array<{ dispose(): void }>;
  radius: number;
}

export interface WizardLayer {
  group: THREE.Group;
  setState(state: WorldState): void;
  update(dt: number, now: number, viewer?: THREE.Vector3): void;
  /** Where a thing stands, for the camera ("show me the dragon"). */
  find(id: string): THREE.Vector3 | null;
  count(): number;
  dispose(): void;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function material(p: Part): THREE.MeshStandardMaterial {
  const key = `${p.c}|${p.e ?? 0}|${p.m ?? 0}|${p.o ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    const col = new THREE.Color(p.c ?? "#cccccc");
    m = new THREE.MeshStandardMaterial({
      color: col,
      metalness: p.m ?? 0,
      roughness: p.m ? 0.35 : 0.7,
      emissive: p.e ? col.clone() : new THREE.Color(0),
      emissiveIntensity: p.e ? Math.min(3, p.e) * 0.6 : 0,
      transparent: (p.o ?? 1) < 1,
      opacity: p.o ?? 1,
      depthWrite: (p.o ?? 1) >= 1,
    });
    matCache.set(key, m);
  }
  return m;
}

function partMatrix(p: Part): THREE.Matrix4 {
  const [w, h, d] = p.size ?? [1, 1, 1];
  const r = p.r ?? [0, 0, 0];
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(...(p.p ?? [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG)),
    new THREE.Vector3(w, h, p.s === "text" ? 1 : d),
  );
  return m;
}

export function createWizardLayer(opts: { lowDetail?: boolean; cullDistance?: number } = {}): WizardLayer {
  const group = new THREE.Group();
  group.name = "wizard-layer";
  const drawn = new Map<string, Drawn>();
  const cull = opts.cullDistance ?? 260;
  let clock = 0;

  const build = (thing: Thing, born: number): Drawn => {
    const g = new THREE.Group();
    g.name = `wish:${thing.id}`;
    const body = new THREE.Group();
    g.add(body);
    const disposables: Array<{ dispose(): void }> = [];
    const anims: Animated[] = [];
    const statics = new Map<string, THREE.BufferGeometry[]>();
    const box = new THREE.Box3();

    const spinCentres = new Map<string, THREE.Vector3>();
    const spinCounts = new Map<string, number>();
    for (const p of thing.parts) {
      if (p.a?.k !== "spin") continue;
      const key = JSON.stringify(p.a);
      const c = spinCentres.get(key) ?? new THREE.Vector3();
      c.add(new THREE.Vector3(...(p.p ?? [0, 0, 0])));
      spinCentres.set(key, c);
      spinCounts.set(key, (spinCounts.get(key) ?? 0) + 1);
    }
    for (const [k, c] of spinCentres) c.divideScalar(spinCounts.get(k)!);
    const spinPivots = new Map<string, THREE.Group>();

    for (const p of thing.parts) {
      const m = partMatrix(p);
      box.union(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(m));
      if (p.s === "text") {
        const tex = textTexture(p.t ?? "", p.c ?? "#222222");
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
        disposables.push(mat);
        if (tex) disposables.push(tex);
        const mesh = new THREE.Mesh(shape("text"), mat);
        mesh.matrixAutoUpdate = true;
        m.decompose(mesh.position, mesh.quaternion, mesh.scale);
        body.add(mesh);
        if (p.a) anims.push({ obj: mesh, a: p.a, base: mesh.position.clone(), baseRot: mesh.rotation.clone(), baseScale: mesh.scale.clone(), phase: Math.random() * 6 });
        continue;
      }
      if (p.a) {
        const mesh = new THREE.Mesh(shape(p.s), material(p));
        mesh.castShadow = !opts.lowDetail;
        m.decompose(mesh.position, mesh.quaternion, mesh.scale);
        const pos = p.p ?? [0, 0, 0];
        if (p.a.k === "spin") {
          // Parts that share one spin turn together about their middle: the
          // sails of a windmill, the blades of a propeller. Spun one by one
          // each blade would twirl on its own centre, which reads as broken.
          const key = JSON.stringify(p.a);
          let pivot = spinPivots.get(key);
          if (!pivot) {
            const c = spinCentres.get(key)!;
            pivot = new THREE.Group();
            pivot.position.copy(c);
            body.add(pivot);
            spinPivots.set(key, pivot);
            anims.push({ obj: pivot, a: p.a, base: pivot.position.clone(), baseRot: pivot.rotation.clone(), baseScale: pivot.scale.clone(), phase: 0 });
          }
          mesh.position.sub(pivot.position);
          pivot.add(mesh);
        } else if ((p.a.k === "flap" || p.a.k === "sway") && Math.abs(pos[0]) > 0.05) {
          // A wing hinges at its inner edge, and the two sides mirror each other.
          const side = Math.sign(pos[0]);
          const w = (p.size ?? [1, 1, 1])[0];
          const pivot = new THREE.Group();
          pivot.position.set(pos[0] - side * w * 0.5, pos[1], pos[2]);
          mesh.position.sub(pivot.position);
          pivot.add(mesh);
          body.add(pivot);
          anims.push({ obj: pivot, a: { ...p.a, amt: (p.a.amt ?? 25) * side }, base: pivot.position.clone(), baseRot: pivot.rotation.clone(), baseScale: pivot.scale.clone(), phase: 0 });
        } else {
          body.add(mesh);
          anims.push({ obj: mesh, a: p.a, base: mesh.position.clone(), baseRot: mesh.rotation.clone(), baseScale: mesh.scale.clone(), phase: Math.random() * 6 });
        }
      } else {
        const key = `${p.c}|${p.e ?? 0}|${p.m ?? 0}|${p.o ?? 1}`;
        const geo = shape(p.s).clone().applyMatrix4(m);
        // mergeGeometries wants matching attribute sets; drop uv2-ish extras.
        for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
        const list = statics.get(key) ?? [];
        list.push(geo.index ? geo.toNonIndexed() : geo);
        statics.set(key, list);
      }
    }
    for (const [key, geos] of statics) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((x) => x.dispose());
      if (!merged) continue;
      disposables.push(merged);
      const [c, e, mm, o] = key.split("|");
      const mesh = new THREE.Mesh(merged, material({ s: "box", c, e: Number(e), m: Number(mm), o: Number(o) }));
      mesh.castShadow = !opts.lowDetail;
      body.add(mesh);
    }

    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(1, size.length() / 2) * (thing.scale ?? 1);
    const top = box.max.y;

    if (thing.light) {
      const tex = dot();
      const mat = new THREE.SpriteMaterial({
        map: tex, color: new THREE.Color(thing.light.c ?? "#fff2cc"), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      disposables.push(mat);
      const halo = new THREE.Sprite(mat);
      const s = Math.min(30, (thing.light.d ?? 12) * 0.5 * Math.max(0.4, (thing.light.i ?? 1.5) / 2));
      halo.scale.set(s, s, 1);
      halo.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      body.add(halo);
    }

    let fx: THREE.Points | null = null;
    let fxSeed: Float32Array | null = null;
    if (thing.fx) {
      const look = FX_LOOK[thing.fx];
      const n = opts.lowDetail ? Math.ceil(look.n / 2) : look.n;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const colors = new Float32Array(n * 3);
      const tmp = new THREE.Color();
      for (let i = 0; i < n; i++) {
        if (thing.fx === "confetti") tmp.setHSL(Math.random(), 0.85, 0.6);
        else tmp.set(look.color).offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.1);
        colors.set([tmp.r, tmp.g, tmp.b], i * 3);
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: look.size, map: dot(), vertexColors: true, transparent: true, depthWrite: false,
        blending: look.additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true,
      });
      disposables.push(geo, mat);
      fx = new THREE.Points(geo, mat);
      fx.frustumCulled = false;
      fxSeed = new Float32Array(n * 4).map(() => Math.random());
      fx.userData = { spread: look.spread * Math.max(1, size.x / 3), up: look.up, height: Math.max(1, top), kind: thing.fx };
      g.add(fx);
    }

    const label = labelSprite(thing.by ? `${thing.name} · ${thing.by}` : thing.name);
    if (label) {
      label.position.y = (top + 1.1) * (thing.scale ?? 1);
      label.visible = false;
      disposables.push(label.material.map!, label.material);
      g.add(label);
    }

    g.position.set(...thing.at);
    g.rotation.y = (thing.yaw ?? 0) * DEG;
    body.scale.setScalar(0.001);
    group.add(g);
    return {
      key: JSON.stringify(thing), thing, group: g, body, anims, fx, fxSeed, label, born, dying: 0, disposables, radius,
    };
  };

  const destroy = (d: Drawn) => {
    group.remove(d.group);
    d.disposables.forEach((x) => x.dispose());
  };

  const animate = (obj: THREE.Object3D, a: Anim, base: THREE.Vector3, baseRot: THREE.Euler, baseScale: THREE.Vector3, t: number, phase: number) => {
    const sp = a.sp ?? 0.5;
    const amt = a.amt ?? 1;
    const w = t * sp * Math.PI * 2 + phase;
    const ax = a.ax ?? (a.k === "flap" ? "z" : a.k === "sway" ? "z" : "y");
    switch (a.k) {
      case "spin":
        obj.rotation.copy(baseRot);
        obj.rotation[ax] = baseRot[ax] + t * sp * Math.PI * 2;
        break;
      case "sway":
      case "flap":
        obj.rotation.copy(baseRot);
        obj.rotation[ax] = baseRot[ax] + Math.sin(w) * amt * DEG;
        break;
      case "bob":
      case "hover":
        obj.position.set(base.x, base.y + Math.sin(w) * (a.k === "hover" ? amt * 0.5 : amt), base.z);
        break;
      case "pulse": {
        const k = 1 + Math.sin(w) * Math.min(0.8, amt > 1 ? amt / 10 : amt);
        obj.scale.set(baseScale.x * k, baseScale.y * k, baseScale.z * k);
        break;
      }
      case "orbit": {
        const r = Math.max(0.5, amt);
        obj.position.set(base.x + Math.cos(w) * r, base.y, base.z + Math.sin(w) * r);
        break;
      }
      case "wander": {
        const r = Math.max(1, amt);
        const x = Math.sin(w * 0.37) * r, z = Math.sin(w * 0.23 + 1.3) * r;
        const nx = Math.sin((w + 0.05) * 0.37) * r, nz = Math.sin((w + 0.05) * 0.23 + 1.3) * r;
        obj.position.set(base.x + x, base.y, base.z + z);
        obj.rotation.y = baseRot.y + Math.atan2(nx - x, nz - z);
        break;
      }
    }
  };

  const zero = new THREE.Vector3();
  const zeroRot = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);

  return {
    group,
    setState(state) {
      for (const [id, d] of drawn) {
        const t = state.things.get(id);
        if (!t) {
          if (!d.dying) d.dying = clock;
          continue;
        }
        if (JSON.stringify(t) !== d.key) {
          // Edited in place: rebuild, but without the pop-in, it was already here.
          destroy(d);
          const n = build(t, clock - 10);
          drawn.set(id, n);
        } else if (d.dying) {
          d.dying = 0; // undo of an undo
        }
      }
      for (const [id, t] of state.things) {
        if (!drawn.has(id)) drawn.set(id, build(t, clock));
      }
    },
    update(dt, now, viewer) {
      clock += dt;
      const t = now / 1000;
      for (const [id, d] of drawn) {
        if (viewer) {
          const dist = d.group.position.distanceTo(viewer) - d.radius;
          d.group.visible = dist < cull;
          if (d.label) d.label.visible = dist < 9;
          if (!d.group.visible) continue;
        }
        // Appear: a springy grow over ~0.9 s. Die: shrink over 0.5 s.
        const s = d.thing.scale ?? 1;
        let k = 1;
        const age = clock - d.born;
        if (age < 0.9) {
          const x = Math.max(0, age / 0.9);
          k = 1 + Math.sin(x * Math.PI * 1.5) * (1 - x) * 0.35 - Math.pow(1 - x, 3);
          k = Math.max(0.001, k);
        }
        if (d.dying) {
          const x = (clock - d.dying) / 0.5;
          if (x >= 1) {
            destroy(d);
            drawn.delete(id);
            continue;
          }
          k = Math.max(0.001, 1 - x);
        }
        d.body.scale.setScalar(s * k);
        if (d.thing.a) animate(d.body, d.thing.a, zero, zeroRot, one.clone().multiplyScalar(s * k), t, 0);
        for (const an of d.anims) animate(an.obj, an.a, an.base, an.baseRot, an.baseScale, t, an.phase);
        if (d.fx && d.fxSeed) {
          const pos = d.fx.geometry.attributes.position as THREE.BufferAttribute;
          const { spread, up, height, kind } = d.fx.userData as { spread: number; up: number; height: number; kind: string };
          const n = pos.count;
          for (let i = 0; i < n; i++) {
            const a = d.fxSeed[i * 4], b = d.fxSeed[i * 4 + 1], c = d.fxSeed[i * 4 + 2], e = d.fxSeed[i * 4 + 3];
            const life = 2.5 + e * 2;
            const u = ((t / life) + a) % 1;
            let y: number;
            if (up >= 0) y = (kind === "fire" ? 0.2 : height * 0.3) + u * up * life * 0.6;
            else y = height + 3 - u * Math.min(height + 3, -up * life * 0.5);
            const ang = b * Math.PI * 2 + (kind === "fireflies" ? t * 0.3 * (c - 0.5) : 0);
            const r = spread * (kind === "fire" ? (1 - u) * c : c);
            const wob = kind === "fireflies" || kind === "bubbles" ? Math.sin(t * 2 + a * 9) * 0.3 : 0;
            pos.setXYZ(i, Math.cos(ang) * r + wob, y * s, Math.sin(ang) * r);
          }
          pos.needsUpdate = true;
        }
      }
    },
    find(id) {
      const d = drawn.get(id);
      return d ? d.group.position.clone() : null;
    },
    count: () => drawn.size,
    dispose() {
      for (const d of drawn.values()) destroy(d);
      drawn.clear();
    },
  };
}
