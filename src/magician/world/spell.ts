/**
 * What a spell looks like on its way out.
 *
 * When Vibey casts, a ribbon of light leaves its hands, spirals up into the
 * sky and blooms there, and the change it asked for eases in behind it. The
 * ribbon is the part that makes a wish read as magic rather than as a
 * setting being changed: you see the spell go.
 *
 * Each ribbon is one `THREE.Points` whose points follow the head's recent
 * path, brightest at the head. A few can be in the air at once.
 */
import * as THREE from "three";

export interface SpellFx {
  group: THREE.Group;
  /** Send a ribbon up from `from`. `onBloom` fires when it reaches the top. */
  cast(from: THREE.Vector3, color: THREE.ColorRepresentation, onBloom?: (at: THREE.Vector3) => void): void;
  update(dt: number): void;
  dispose(): void;
}

const TRAIL = 56;

/** The colour a kind of spell leaves in the air. */
export function spellColour(tool: string): string {
  if (/weather|season/.test(tool)) return "#9fd8ff";
  if (/time|sky|paint/.test(tool)) return "#ffd27a";
  if (/lantern|lights|koi/.test(tool)) return "#ffb46a";
  if (/screen/.test(tool)) return "#c8a6ff";
  if (/spawn|remove/.test(tool)) return "#b8ffc8";
  if (/physics|dial/.test(tool)) return "#ffe7a0";
  return "#ffe7a0";
}

export function createSpellFx(): SpellFx {
  const group = new THREE.Group();
  group.name = "spells";
  const tex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 64;
    const g = cv.getContext("2d")!;
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,0.6)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  })();

  interface Ribbon {
    points: THREE.Points;
    pos: Float32Array;
    col: Float32Array;
    base: THREE.Color;
    from: THREE.Vector3;
    history: THREE.Vector3[];
    t: number;
    spin: number;
    radius: number;
    height: number;
    lean: THREE.Vector3;
    bloomed: boolean;
    onBloom?: (at: THREE.Vector3) => void;
    live: boolean;
  }
  const ribbons: Ribbon[] = [];
  for (let i = 0; i < 4; i++) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(TRAIL * 3);
    const col = new Float32Array(TRAIL * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.34, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.visible = false;
    group.add(points);
    ribbons.push({ points, pos, col, base: new THREE.Color(), from: new THREE.Vector3(), history: [], t: 0, spin: 1, radius: 1, height: 14, lean: new THREE.Vector3(), bloomed: false, live: false });
  }
  const head = new THREE.Vector3();
  const LIFE = 1.9;

  return {
    group,
    cast(from, color, onBloom) {
      const r = ribbons.find((x) => !x.live) ?? ribbons[0];
      r.live = true;
      r.t = 0;
      r.bloomed = false;
      r.onBloom = onBloom;
      r.base.set(color);
      r.from.copy(from);
      r.history.length = 0;
      r.spin = Math.random() < 0.5 ? 1 : -1;
      r.radius = 0.7 + Math.random() * 0.6;
      r.height = 12 + Math.random() * 6;
      r.lean.set((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6);
      r.points.visible = true;
    },
    update(dt) {
      for (const r of ribbons) {
        if (!r.live) continue;
        r.t += dt;
        const k = Math.min(1, r.t / (LIFE * 0.62));
        // The head: a widening spiral that rises fast then slows at the top.
        const ease = 1 - Math.pow(1 - k, 2.2);
        const ang = r.spin * (ease * Math.PI * 5);
        const rad = r.radius * (0.4 + ease * 1.8);
        head.set(
          r.from.x + Math.cos(ang) * rad + r.lean.x * ease,
          r.from.y + ease * r.height,
          r.from.z + Math.sin(ang) * rad + r.lean.z * ease,
        );
        if (r.t < LIFE * 0.62) {
          r.history.unshift(head.clone());
          if (r.history.length > TRAIL) r.history.length = TRAIL;
        } else if (!r.bloomed) {
          r.bloomed = true;
          r.onBloom?.(r.history[0] ?? head);
        }
        // After the bloom the trail shortens away into the sky.
        const fade = r.t < LIFE * 0.62 ? 1 : Math.max(0, 1 - (r.t - LIFE * 0.62) / (LIFE * 0.38));
        if (r.t >= LIFE * 0.62 && r.history.length) r.history.pop();
        for (let i = 0; i < TRAIL; i++) {
          const p = r.history[i];
          const o = i * 3;
          if (!p) { r.pos[o] = r.from.x; r.pos[o + 1] = -999; r.pos[o + 2] = r.from.z; r.col[o] = r.col[o + 1] = r.col[o + 2] = 0; continue; }
          const b = Math.pow(1 - i / TRAIL, 1.6) * fade * (0.8 + Math.random() * 0.4);
          r.pos[o] = p.x + (Math.random() - 0.5) * 0.08; r.pos[o + 1] = p.y; r.pos[o + 2] = p.z + (Math.random() - 0.5) * 0.08;
          r.col[o] = r.base.r * b; r.col[o + 1] = r.base.g * b; r.col[o + 2] = r.base.b * b;
        }
        (r.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (r.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        if (r.t > LIFE) { r.live = false; r.points.visible = false; }
      }
    },
    dispose() {
      for (const r of ribbons) { r.points.geometry.dispose(); (r.points.material as THREE.Material).dispose(); }
      tex.dispose();
    },
  };
}
