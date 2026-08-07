/**
 * Everything outside the system: the star, the background stars, the nebula,
 * and the streaks that replace all three at warp.
 *
 * The starfield is a `Points` cloud on a shell of radius `STARFIELD_R` that is
 * *carried by the camera* — its position is set to the camera's every frame, so
 * it never gets closer and never gets further. That is what keeps the whole
 * space scene inside a 0.5-to-20,000 depth range without a skybox, without a
 * second render pass, and without a logarithmic depth buffer. See the scale
 * note in `types.ts`; it is the constraint the rest of this file obeys.
 *
 * Star colours are drawn from a real distribution rather than a random hue —
 * mostly red and orange dwarfs, a scattering of white, and a handful of hot
 * blue ones. A field of evenly-distributed rainbow points reads as confetti;
 * this reads as a sky.
 */
import * as THREE from "three";
import { STARFIELD_R, STAR_DIST, makeRng } from "../types";
import { starColor, type StarClass } from "../galaxy/systems";

/* --- background stars ------------------------------------------------------ */

export interface Starfield {
  points: THREE.Points;
  /** Carry the shell along with the camera and stretch it at warp. */
  update(camera: THREE.Camera, warp: number): void;
  dispose(): void;
}

export function createStarfield(count = 5200, seed = 7): Starfield {
  const rng = makeRng(seed);
  const pos = new Float32Array(count * 3);
  const colArr = new Float32Array(count * 3);
  const sizeArr = new Float32Array(count);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere. Using two uniform angles instead clusters the
    // whole catalogue at the poles, which is very obvious once you pitch up.
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(th) * r * STARFIELD_R;
    pos[i * 3 + 1] = u * STARFIELD_R;
    pos[i * 3 + 2] = Math.sin(th) * r * STARFIELD_R;

    // Roughly the real main-sequence distribution: M dwarfs dominate.
    const roll = rng();
    const k = roll < 0.6 ? 3000 + rng() * 800 : roll < 0.86 ? 4200 + rng() * 1400 : roll < 0.97 ? 6000 + rng() * 1600 : 9000 + rng() * 12000;
    c.setHex(starColor(k));
    const mag = 0.35 + rng() * rng() * 0.85; // biased dim — a few bright ones
    colArr[i * 3] = c.r * mag;
    colArr[i * 3 + 1] = c.g * mag;
    colArr[i * 3 + 2] = c.b * mag;
    sizeArr[i] = (0.5 + rng() * rng() * 3.4) * 26;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizeArr, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uStretch: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying vec3 vCol;
      varying float vFade;
      uniform float uStretch;
      void main(){
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // At warp the points grow and brighten rather than smear — a real
        // streak needs line geometry, and the streak field does that job.
        gl_PointSize = aSize * (1.0 + uStretch * 2.0) / max(-mv.z, 1.0) * 40.0;
        vFade = 1.0 + uStretch * 1.6;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vFade;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r);
        gl_FragColor = vec4(vCol * vFade, a);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  return {
    points,
    update(camera, warp) {
      points.position.copy(camera.position);
      mat.uniforms.uStretch.value = warp;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      points.parent?.remove(points);
    },
  };
}

/* --- the local star -------------------------------------------------------- */

export interface Star {
  group: THREE.Group;
  light: THREE.DirectionalLight;
  /** Unit vector from the planet toward the star, world space. */
  direction: THREE.Vector3;
  tint: THREE.Color;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** Radius and brightness by spectral class. An M dwarf should look small and
 *  sullen next to an F star, because it is. */
const CLASS_SIZE: Record<StarClass, number> = {
  O: 3.2,
  B: 2.4,
  A: 1.7,
  F: 1.35,
  G: 1.0,
  K: 0.78,
  M: 0.52,
};

export function createStar(cls: StarClass, kelvin: number, azimuth = 0.9): Star {
  const group = new THREE.Group();
  const tint = new THREE.Color(starColor(kelvin));
  const size = CLASS_SIZE[cls] ?? 1;

  const dir = new THREE.Vector3(Math.cos(azimuth), 0.28, Math.sin(azimuth)).normalize();
  group.position.copy(dir).multiplyScalar(STAR_DIST);

  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture(0.06, 0.5),
      color: tint.clone().lerp(new THREE.Color(0xffffff), 0.55),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  core.scale.setScalar(560 * size);
  group.add(core);

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture(0.0, 0.5),
      color: tint,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      opacity: 0.55,
    }),
  );
  halo.scale.setScalar(2400 * size);
  group.add(halo);

  const light = new THREE.DirectionalLight(tint.getHex(), 2.1 * Math.min(1.4, size));
  light.position.copy(dir).multiplyScalar(100);

  let t = 0;
  return {
    group,
    light,
    direction: dir,
    tint,
    update(dt) {
      // A slow breath on the halo. Stars do not flicker; the eye still reads
      // absolute stillness as "sprite" and a 0.06 Hz wobble as "furnace".
      t += dt;
      halo.scale.setScalar(2400 * size * (1 + Math.sin(t * 0.37) * 0.035));
    },
    dispose() {
      group.traverse((o) => {
        const sp = o as THREE.Sprite;
        const mat = sp.material as THREE.SpriteMaterial | undefined;
        mat?.map?.dispose();
        mat?.dispose();
      });
      group.parent?.remove(group);
      light.parent?.remove(light);
    },
  };
}

/** A soft radial falloff, drawn once into a 128² canvas. `inner` is the size of
 *  the hard white core; 0 gives a pure glow. */
function radialTexture(inner: number, outer: number): THREE.Texture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  if (ctx) {
    const grd = ctx.createRadialGradient(S / 2, S / 2, S * inner, S / 2, S / 2, S * outer);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.25, "rgba(255,255,255,0.42)");
    grd.addColorStop(0.6, "rgba(255,255,255,0.09)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, S, S);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/* --- nebula ---------------------------------------------------------------- */

/**
 * Six or seven very large additive sprites hung on the starfield shell.
 *
 * They are tinted from the system's own accent, which is what makes each
 * system look like a *different* place from the moment the warp flash clears —
 * before the planet has even been found in frame. It is the cheapest
 * establishing shot in the world.
 */
export function createNebula(accent: number, seed: number): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  const rng = makeRng(seed);
  const tex = cloudTexture(rng);
  const base = new THREE.Color(accent);

  for (let i = 0; i < 7; i++) {
    const c = base
      .clone()
      .lerp(new THREE.Color(i % 2 ? 0x4060ff : 0xff4090), rng() * 0.55)
      .multiplyScalar(0.16 + rng() * 0.2);
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color: c,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        opacity: 0.5,
        rotation: rng() * Math.PI * 2,
      }),
    );
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    sp.position
      .set(Math.cos(th) * r, u * 0.6, Math.sin(th) * r)
      .normalize()
      .multiplyScalar(STARFIELD_R * 0.92);
    sp.scale.setScalar(3600 + rng() * 5200);
    group.add(sp);
  }
  group.frustumCulled = false;

  return {
    group,
    dispose() {
      group.traverse((o) => {
        const sp = o as THREE.Sprite;
        (sp.material as THREE.SpriteMaterial | undefined)?.dispose();
      });
      tex.dispose();
      group.parent?.remove(group);
    },
  };
}

function cloudTexture(rng: () => number): THREE.Texture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, S, S);
    // Forty overlapping soft blobs. Anything more structured starts to look
    // like a logo; this stays a smudge, which is what a nebula is at this
    // distance.
    for (let i = 0; i < 40; i++) {
      const x = S * (0.5 + (rng() - 0.5) * 0.75);
      const y = S * (0.5 + (rng() - 0.5) * 0.75);
      const r = S * (0.06 + rng() * 0.24);
      const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.05 + rng() * 0.12;
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    /* Vignette the whole thing to zero at the border.
     *
     * The blobs are placed across 75% of the canvas and can be a quarter of it
     * wide, so some of them reach the edge — and an additive sprite whose alpha
     * is non-zero at its own quad boundary draws a hard-edged rectangle across
     * the starfield. It is very obvious and it took a card-art capture to
     * notice, because it only reads against black. */
    ctx.globalCompositeOperation = "destination-in";
    const mask = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.5);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.75, "rgba(0,0,0,0.55)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/* --- warp streaks ---------------------------------------------------------- */

export interface Streaks {
  lines: THREE.LineSegments;
  /** `k` 0-1: how far into the jump we are. 0 hides it entirely. */
  update(camera: THREE.Camera, k: number, dt: number): void;
  dispose(): void;
}

/**
 * The streak field.
 *
 * Line segments in a cylinder around the camera's forward axis, extruded
 * backwards along it and scrolled. Points cannot do this — a stretched point
 * sprite stays square — and a full tunnel shader would have to own the whole
 * frame. Six hundred segments is enough to fill the periphery and cheap enough
 * to run on a phone.
 */
export function createStreaks(count = 640, seed = 21): Streaks {
  const rng = makeRng(seed);
  const pos = new Float32Array(count * 6);
  const colArr = new Float32Array(count * 6);
  const seeds = new Float32Array(count * 3); // radius, angle, z-offset

  for (let i = 0; i < count; i++) {
    seeds[i * 3] = 14 + rng() * 240;
    seeds[i * 3 + 1] = rng() * Math.PI * 2;
    seeds[i * 3 + 2] = rng();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    opacity: 0,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let scroll = 0;

  return {
    lines,
    update(camera, k, dt) {
      lines.visible = k > 0.001;
      mat.opacity = Math.min(1, k * 1.6);
      if (!lines.visible) return;

      scroll = (scroll + dt * (0.6 + k * 5.2)) % 1;
      camera.getWorldDirection(fwd);
      up.set(0, 1, 0);
      right.crossVectors(fwd, up).normalize();
      up.crossVectors(right, fwd).normalize();

      const len = 60 + k * 900;
      const p = geo.attributes.position as THREE.BufferAttribute;
      const c = geo.attributes.color as THREE.BufferAttribute;

      for (let i = 0; i < count; i++) {
        const rad = seeds[i * 3];
        const ang = seeds[i * 3 + 1];
        const z = ((seeds[i * 3 + 2] + scroll) % 1) * 1600 - 300;

        a.copy(camera.position)
          .addScaledVector(right, Math.cos(ang) * rad)
          .addScaledVector(up, Math.sin(ang) * rad)
          .addScaledVector(fwd, 900 - z);
        b.copy(a).addScaledVector(fwd, -len);

        p.setXYZ(i * 2, a.x, a.y, a.z);
        p.setXYZ(i * 2 + 1, b.x, b.y, b.z);

        // Bright at the head, dark at the tail, and bluer the faster we go.
        const br = (0.35 + k * 1.5) * (1 - Math.min(1, rad / 300) * 0.35);
        c.setXYZ(i * 2, br, br, br * 1.25);
        c.setXYZ(i * 2 + 1, 0, 0, 0);
      }
      p.needsUpdate = true;
      c.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      lines.parent?.remove(lines);
    },
  };
}
