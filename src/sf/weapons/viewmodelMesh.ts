/**
 * weapons/viewmodelMesh.ts — the gun itself, built from the registry's spec.
 *
 * There are no weapon models in this project, so each one is assembled out of
 * primitives at load time from its `ViewmodelSpec`. Three things keep that
 * from looking like a stack of grey boxes:
 *
 *   1. **Everything static is merged into one geometry** with baked vertex
 *      colours, so the gun is two or three draw calls, not twenty — and the
 *      vertex colours carry wear: edges lighten, undersides darken, and a
 *      seeded per-vertex jitter breaks the flatness that screams "primitive".
 *   2. **Materials are physically plausible.** Receivers are near-dielectric
 *      with high roughness (parkerised steel and polymer), bolts and barrels
 *      are proper metal with low roughness, optic glass is a thin transmissive
 *      panel with a tinted emissive reticle.
 *   3. **The moving parts are real objects.** Slide, bolt, magazine and shell
 *      are separate nodes the animator drives; the muzzle and ejection port
 *      are empties so effects always come out of the right hole even after the
 *      weapon has been re-specced.
 *
 * Public API
 * ----------
 *   buildViewmodel(def) → Viewmodel { root, muzzle, ejectPort, slide, magazine,
 *                                     setHeat(h), dispose() }
 */
import * as THREE from "three";
import { makeRng, type Rng } from "../math/rng";
import type { WeaponDef } from "./types";

export interface Viewmodel {
  /** Parent this. Local space: -Z down the barrel, +Y up, +X right. */
  root: THREE.Group;
  /** Empty at the muzzle tip — flash, smoke and the shot ray originate here. */
  muzzle: THREE.Object3D;
  /** Empty at the ejection port. */
  ejectPort: THREE.Object3D;
  /** Reciprocating mass: slide, bolt or pump. Driven along local +Z. */
  slide: THREE.Object3D;
  /** Magazine / belt box; dropped and replaced during reloads. */
  magazine: THREE.Object3D;
  /** 0..1 barrel heat: drives the emissive glow on the barrel material. */
  setHeat(h: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * Geometry assembly helpers
 * ------------------------------------------------------------------ */

interface Piece {
  geo: THREE.BufferGeometry;
  /** Which material bucket it belongs to. */
  bucket: "body" | "metal" | "grip" | "glass" | "emissive";
  /** Base tint multiplier, baked into vertex colour. */
  tint?: number;
}

/** Heat ramps from red toward a pale orange as the barrel gets away from you. */
const _scratchWhite = new THREE.Color(0xffdca0);

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function place(
  geo: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _m4.compose(_v, _q, _s);
  geo.applyMatrix4(_m4);
  return geo;
}

/**
 * Merge non-indexed geometries and bake per-vertex wear.
 *
 * Written out rather than pulled from BufferGeometryUtils because we want the
 * vertex-colour pass in the same walk, and because the merge is trivial once
 * everything is non-indexed.
 */
function mergePieces(pieces: Piece[], rng: Rng, base: THREE.Color): THREE.BufferGeometry {
  let total = 0;
  const flat: { g: THREE.BufferGeometry; tint: number }[] = [];
  for (const p of pieces) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (g !== p.geo) p.geo.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    total += g.attributes.position.count;
    flat.push({ g, tint: p.tint ?? 1 });
  }

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, tint } of flat) {
    const gp = g.attributes.position.array as ArrayLike<number>;
    const gn = g.attributes.normal.array as ArrayLike<number>;
    const gu = g.attributes.uv.array as ArrayLike<number>;
    const n = g.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const i3 = (o + i) * 3;
      pos[i3] = gp[i * 3];
      pos[i3 + 1] = gp[i * 3 + 1];
      pos[i3 + 2] = gp[i * 3 + 2];
      const nx = gn[i * 3];
      const ny = gn[i * 3 + 1];
      const nz = gn[i * 3 + 2];
      nrm[i3] = nx;
      nrm[i3 + 1] = ny;
      nrm[i3 + 2] = nz;
      uv[(o + i) * 2] = gu[i * 2];
      uv[(o + i) * 2 + 1] = gu[i * 2 + 1];

      // Wear model: upward faces catch light and hand oil, undersides sit in
      // shadow, and a little per-vertex noise stops any face reading as a flat
      // painted quad under a moving light.
      const up = ny * 0.5 + 0.5;
      const wear = 0.86 + up * 0.2 + rng.gauss() * 0.035;
      col[i3] = base.r * tint * wear;
      col[i3 + 1] = base.g * tint * wear;
      col[i3 + 2] = base.b * tint * wear;
    }
    o += n;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

export function buildViewmodel(def: WeaponDef): Viewmodel {
  const v = def.view;
  const rng = makeRng(`sf-vm-${def.key}`);
  const root = new THREE.Group();
  root.name = `vm:${def.key}`;

  const bodyPieces: Piece[] = [];
  const metalPieces: Piece[] = [];
  const gripPieces: Piece[] = [];

  const L = v.length;
  const halfW = v.bodyW;
  const halfH = v.bodyH;
  // The receiver runs from z=+0.04 (rear) to z=-(L-0.04) (front).
  const recLen = Math.max(0.08, L * 0.55);
  const recZ = -recLen * 0.5 + 0.03;

  /* ---------------- receiver ---------------- */
  bodyPieces.push({
    geo: place(new THREE.BoxGeometry(halfW * 2, halfH * 2, recLen), 0, 0, recZ),
    bucket: "body",
  });
  // Top rail — a raised strip, so the silhouette is not a plain slab.
  bodyPieces.push({
    geo: place(
      new THREE.BoxGeometry(halfW * 1.15, halfH * 0.28, recLen * 0.92),
      0, halfH + halfH * 0.12, recZ,
    ),
    bucket: "body",
    tint: 0.86,
  });
  // Lower rail / dust cover.
  bodyPieces.push({
    geo: place(
      new THREE.BoxGeometry(halfW * 1.5, halfH * 0.35, recLen * 0.7),
      0, -halfH * 0.95, recZ - recLen * 0.08,
    ),
    bucket: "body",
    tint: 0.92,
  });

  /* ---------------- grip ---------------- */
  const gripH = 0.11 + halfH * 0.6;
  gripPieces.push({
    geo: place(
      new THREE.BoxGeometry(halfW * 1.55, gripH, halfW * 2.6),
      0, -halfH - gripH * 0.42, 0.008,
      -0.3, 0, 0,
    ),
    bucket: "grip",
    tint: 0.72,
  });
  // Trigger guard: a half torus reads as a guard from any angle.
  const guard = new THREE.TorusGeometry(0.021, 0.0035, 5, 9, Math.PI);
  gripPieces.push({
    geo: place(guard, 0, -halfH - 0.018, -0.03, 0, Math.PI * 0.5, Math.PI),
    bucket: "metal",
    tint: 0.9,
  });
  // Trigger.
  metalPieces.push({
    geo: place(new THREE.BoxGeometry(0.005, 0.021, 0.006), 0, -halfH - 0.016, -0.03, 0.18, 0, 0),
    bucket: "metal",
    tint: 0.8,
  });

  /* ---------------- barrel + handguard ---------------- */
  const barrelStart = recZ - recLen * 0.5;
  const barrelLen = Math.max(0.02, v.barrelLen);
  const barrel = new THREE.CylinderGeometry(v.barrelR, v.barrelR * 0.97, barrelLen, 10);
  barrel.rotateX(Math.PI / 2);
  const barrelGeo = place(barrel, 0, halfH * 0.15, barrelStart - barrelLen * 0.5);
  metalPieces.push({ geo: barrelGeo, bucket: "metal", tint: 1 });

  if (v.handguard > 0.01) {
    const hgLen = v.handguard;
    bodyPieces.push({
      geo: place(
        new THREE.BoxGeometry(halfW * 1.65, halfH * 1.15, hgLen),
        0, halfH * 0.08, barrelStart - hgLen * 0.5,
      ),
      bucket: "body",
      tint: 0.88,
    });
    // Vent slots: three thin darker strips.
    for (let i = 0; i < 3; i++) {
      bodyPieces.push({
        geo: place(
          new THREE.BoxGeometry(halfW * 1.72, halfH * 0.12, hgLen * 0.16),
          0, halfH * 0.32, barrelStart - hgLen * (0.25 + i * 0.22),
        ),
        bucket: "body",
        tint: 0.5,
      });
    }
  }

  /* ---------------- muzzle device ---------------- */
  const muzzleZ = barrelStart - barrelLen;
  switch (v.muzzle) {
    case "brake": {
      const g = new THREE.CylinderGeometry(v.barrelR * 1.7, v.barrelR * 1.55, 0.045, 8);
      g.rotateX(Math.PI / 2);
      metalPieces.push({ geo: place(g, 0, halfH * 0.15, muzzleZ - 0.022), bucket: "metal", tint: 0.92 });
      for (let i = 0; i < 2; i++) {
        metalPieces.push({
          geo: place(
            new THREE.BoxGeometry(v.barrelR * 4, v.barrelR * 0.5, 0.008),
            0, halfH * 0.15, muzzleZ - 0.012 - i * 0.016,
          ),
          bucket: "metal",
          tint: 0.6,
        });
      }
      break;
    }
    case "hider": {
      const g = new THREE.CylinderGeometry(v.barrelR * 1.45, v.barrelR * 1.15, 0.05, 7, 1, true);
      g.rotateX(Math.PI / 2);
      metalPieces.push({ geo: place(g, 0, halfH * 0.15, muzzleZ - 0.025), bucket: "metal", tint: 0.85 });
      break;
    }
    case "can": {
      const g = new THREE.CylinderGeometry(v.barrelR * 2.4, v.barrelR * 2.4, 0.14, 12);
      g.rotateX(Math.PI / 2);
      metalPieces.push({ geo: place(g, 0, halfH * 0.15, muzzleZ - 0.07), bucket: "metal", tint: 0.78 });
      break;
    }
    case "tube": {
      const g = new THREE.CylinderGeometry(v.barrelR * 1.12, v.barrelR * 1.06, 0.05, 12, 1, true);
      g.rotateX(Math.PI / 2);
      metalPieces.push({ geo: place(g, 0, halfH * 0.15, muzzleZ - 0.025), bucket: "metal", tint: 0.7 });
      break;
    }
    default:
      break;
  }

  /* ---------------- stock ---------------- */
  const rearZ = recZ + recLen * 0.5;
  if (v.stock === "fixed") {
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(halfW * 1.5, halfH * 1.3, 0.18), 0, -halfH * 0.25, rearZ + 0.09, -0.06, 0, 0),
      bucket: "body",
      tint: 0.8,
    });
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(halfW * 1.7, halfH * 2.1, 0.03), 0, -halfH * 0.5, rearZ + 0.185, -0.06, 0, 0),
      bucket: "grip",
      tint: 0.6,
    });
  } else if (v.stock === "brace") {
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(halfW * 0.5, halfH * 0.5, 0.12), 0, halfH * 0.2, rearZ + 0.06),
      bucket: "metal",
      tint: 0.75,
    });
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(halfW * 1.3, halfH * 1.5, 0.022), 0, halfH * 0.1, rearZ + 0.12),
      bucket: "grip",
      tint: 0.6,
    });
  } else if (v.stock === "rest") {
    const pad = new THREE.CylinderGeometry(halfH * 1.5, halfH * 1.3, 0.05, 10);
    pad.rotateX(Math.PI / 2);
    bodyPieces.push({ geo: place(pad, 0, -halfH * 0.4, rearZ + 0.05), bucket: "grip", tint: 0.62 });
  }

  /* ---------------- optic ---------------- */
  const opticY = halfH * 1.55;
  const glassPieces: Piece[] = [];
  if (v.optic === "reddot") {
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(0.026, 0.03, 0.05), 0, opticY + 0.008, recZ - 0.02),
      bucket: "body",
      tint: 0.7,
    });
    glassPieces.push({
      geo: place(new THREE.PlaneGeometry(0.02, 0.02), 0, opticY + 0.012, recZ - 0.043),
      bucket: "glass",
    });
  } else if (v.optic === "scope") {
    const tube = new THREE.CylinderGeometry(0.021, 0.021, 0.19, 14);
    tube.rotateX(Math.PI / 2);
    bodyPieces.push({ geo: place(tube, 0, opticY + 0.012, recZ - 0.03), bucket: "body", tint: 0.62 });
    const bell = new THREE.CylinderGeometry(0.028, 0.021, 0.05, 14);
    bell.rotateX(Math.PI / 2);
    bodyPieces.push({ geo: place(bell, 0, opticY + 0.012, recZ - 0.14), bucket: "body", tint: 0.58 });
    // Mounting rings.
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.TorusGeometry(0.023, 0.005, 5, 12);
      bodyPieces.push({
        geo: place(ring, 0, opticY + 0.012, recZ + (i === 0 ? 0.03 : -0.075), Math.PI / 2, 0, 0),
        bucket: "metal",
        tint: 0.8,
      });
    }
    glassPieces.push({
      geo: place(new THREE.CircleGeometry(0.019, 16), 0, opticY + 0.012, recZ + 0.066),
      bucket: "glass",
    });
  } else if (v.optic === "ladder") {
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(0.006, 0.045, 0.004), 0, opticY, recZ + 0.02, -0.25, 0, 0),
      bucket: "metal",
      tint: 0.8,
    });
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(0.005, 0.03, 0.004), 0, opticY - 0.008, barrelStart - barrelLen * 0.6),
      bucket: "metal",
      tint: 0.8,
    });
  } else {
    // Irons: a front post and a rear notch, both small and both real.
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(0.0045, 0.017, 0.004), 0, halfH + 0.011, barrelStart - barrelLen * 0.82),
      bucket: "metal",
      tint: 0.75,
    });
    bodyPieces.push({
      geo: place(new THREE.BoxGeometry(0.018, 0.011, 0.004), 0, halfH + 0.008, recZ + recLen * 0.42),
      bucket: "metal",
      tint: 0.75,
    });
  }

  /* ---------------- static mesh ---------------- */
  const bodyColor = new THREE.Color(v.bodyColor);
  const metalColor = new THREE.Color(v.metalColor);

  const bodyGeo = mergePieces([...bodyPieces, ...gripPieces], rng.fork("body"), bodyColor);
  const metalGeo = mergePieces(metalPieces, rng.fork("metal"), metalColor);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: v.roughness,
    metalness: 0.32,
    envMapIntensity: 0.9,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: Math.max(0.16, v.roughness * 0.62),
    metalness: 0.95,
    envMapIntensity: 1.15,
    emissive: new THREE.Color(0xff3a00),
    emissiveIntensity: 0,
  });

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  const metalMesh = new THREE.Mesh(metalGeo, metalMat);
  for (const m of [bodyMesh, metalMesh]) {
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = false;
    root.add(m);
  }

  let glassMesh: THREE.Mesh | null = null;
  if (glassPieces.length) {
    const glassGeo = mergePieces(glassPieces, rng.fork("glass"), new THREE.Color(0x9ecfe8));
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.06,
      metalness: 0.1,
      transparent: true,
      opacity: 0.42,
      emissive: new THREE.Color(0xff2a1a),
      emissiveIntensity: 0.55,
    });
    glassMesh = new THREE.Mesh(glassGeo, glassMat);
    glassMesh.frustumCulled = false;
    root.add(glassMesh);
  }

  /* ---------------- moving parts ---------------- */
  const slide = new THREE.Group();
  slide.name = "slide";
  if (def.action !== "none") {
    const slidePieces: Piece[] = [];
    if (def.cls === "sidearm") {
      // A pistol's whole slide reciprocates.
      slidePieces.push({
        geo: place(new THREE.BoxGeometry(halfW * 2.05, halfH * 0.95, recLen * 0.98), 0, halfH * 0.5, recZ),
        bucket: "metal",
        tint: 1,
      });
      for (let i = 0; i < 6; i++) {
        slidePieces.push({
          geo: place(
            new THREE.BoxGeometry(halfW * 2.1, halfH * 0.5, 0.0035),
            0, halfH * 0.5, recZ + recLen * (0.26 + i * 0.045),
          ),
          bucket: "metal",
          tint: 0.62,
        });
      }
    } else if (def.action === "pump") {
      // The pump rides the magazine tube under the barrel.
      slidePieces.push({
        geo: place(
          new THREE.BoxGeometry(halfW * 1.5, halfH * 0.95, 0.11),
          0, -halfH * 0.85, barrelStart - v.handguard * 0.55,
        ),
        bucket: "grip",
        tint: 0.66,
      });
    } else {
      // Charging handle / bolt carrier stub on the ejection side.
      const side = v.ejectSide || 1;
      slidePieces.push({
        geo: place(
          new THREE.BoxGeometry(0.012, 0.014, 0.05),
          side * (halfW + 0.008), halfH * 0.45, recZ + recLen * 0.24,
        ),
        bucket: "metal",
        tint: 0.85,
      });
    }
    const slideGeo = mergePieces(slidePieces, rng.fork("slide"), metalColor);
    const slideMesh = new THREE.Mesh(slideGeo, metalMat);
    slideMesh.frustumCulled = false;
    slide.add(slideMesh);
  }
  root.add(slide);

  const magazine = new THREE.Group();
  magazine.name = "magazine";
  if (v.magH > 0.001) {
    const magPieces: Piece[] = [
      {
        geo: place(
          new THREE.BoxGeometry(v.magW * 2, v.magH, v.magD),
          0, -halfH - v.magH * 0.5 + 0.005, v.magZ,
          0.12, 0, 0,
        ),
        bucket: "body",
        tint: 0.78,
      },
      {
        geo: place(
          new THREE.BoxGeometry(v.magW * 2.15, v.magH * 0.09, v.magD * 1.05),
          0, -halfH - v.magH + 0.005, v.magZ,
          0.12, 0, 0,
        ),
        bucket: "metal",
        tint: 0.6,
      },
    ];
    const magGeo = mergePieces(magPieces, rng.fork("mag"), bodyColor);
    const magMesh = new THREE.Mesh(magGeo, bodyMat);
    magMesh.frustumCulled = false;
    magazine.add(magMesh);
  }
  root.add(magazine);

  /* ---------------- empties ---------------- */
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, halfH * 0.15, muzzleZ - (v.muzzle === "can" ? 0.14 : v.muzzle === "none" ? 0.005 : 0.05));
  root.add(muzzle);

  const ejectPort = new THREE.Object3D();
  ejectPort.position.set((v.ejectSide || 1) * (halfW + 0.01), halfH * 0.45, recZ + recLen * 0.16);
  root.add(ejectPort);

  const heatColor = new THREE.Color(0xff3a00);
  return {
    root,
    muzzle,
    ejectPort,
    slide,
    magazine,
    setHeat(h: number) {
      // Only the metal glows, and only above a threshold: cold steel with a
      // faint red tint looks like a bug, not like a hot barrel.
      const t = h > 0.35 ? (h - 0.35) / 0.65 : 0;
      metalMat.emissiveIntensity = t * t * 1.5;
      metalMat.emissive.copy(heatColor).lerp(_scratchWhite, t * 0.25);
    },
    dispose() {
      bodyGeo.dispose();
      metalGeo.dispose();
      bodyMat.dispose();
      metalMat.dispose();
      if (glassMesh) {
        glassMesh.geometry.dispose();
        (glassMesh.material as THREE.Material).dispose();
      }
      slide.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      magazine.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      root.clear();
    },
  };
}
