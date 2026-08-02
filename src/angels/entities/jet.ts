/**
 * The aeroplanes.
 *
 * Every airframe in the hangar is built here from its own spec — nobody ships
 * a GLB, and there is a reason beyond download size. The seven jets on the
 * roster span forty years of aviation, and what makes an A-4 read as an A-4
 * and a Phantom read as a Phantom is not detail, it is *proportion*: where the
 * wing sits, how far the nose sticks out ahead of it, whether the tail is one
 * fin or two. A parametric builder gets those relationships from the same
 * numbers the flight model integrates, so a jet that flies like a Skyhawk
 * cannot accidentally look like a Hornet.
 *
 * Livery is vertex colour, not texture: gloss Insignia Blue everywhere, yellow
 * on the leading edges, the tips, the tail and the nose flash. The one thing
 * that *is* a texture is the number on the fin, because a number is the one
 * mark on a Blue Angel that has to be legible from three hundred metres.
 *
 * Body frame, matching the flight model: nose along -Z, right wing +X, canopy
 * +Y. Everything in metres.
 */
import * as THREE from "three";
import type { AircraftSpec } from "../flight/aircraft";
import { AERIAL_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "../world/env";
import { PALETTE } from "../types";

export interface JetRig {
  root: THREE.Group;
  /** Rotate with roll input. */
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  /** Rotate with pitch input. */
  stabL: THREE.Object3D;
  stabR: THREE.Object3D;
  /** Rotate with rudder. */
  rudders: THREE.Object3D[];
  /** Retract with the gear. */
  gear: THREE.Group;
  /** Where the exhaust plume starts, body space. */
  nozzles: THREE.Vector3[];
  /** Wingtips, for vortex and smoke emitters. */
  tips: THREE.Vector3[];
  /** The afterburner cones — scaled by the burner fraction. */
  flames: THREE.Mesh[];
  dispose(): void;
}

/** One material for every jet in the air: it is the same paint. */
export function createJetMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vColor = color;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(normalMatrix * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(cameraPosition - vWorld);
        float ndl = max(dot(n, uSunDir), 0.0);

        // Hemisphere ambient: sky above, ground below. On a jet this matters
        // more than on anything else in the world, because half the time you
        // are looking at its belly against the sky and the other half at its
        // back against the water.
        vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);

        // Show paint is *very* glossy — a clearcoat over Insignia Blue. The
        // hard highlight is most of what sells it as a real object.
        vec3 h = normalize(uSunDir + v);
        float spec = pow(max(dot(n, h), 0.0), 90.0) * 1.4;
        float sheen = pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.30;

        vec3 lit = vColor * (uSunColor * ndl * 1.35 + amb * 0.75)
                 + uSunColor * spec
                 + uSkyColor * sheen;
        lit *= mix(1.0, 0.30, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const _c = new THREE.Color();

function tint(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const p = geo.attributes.position as THREE.BufferAttribute;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    _c.setHex(fn(p.getX(i), p.getY(i), p.getZ(i)));
    arr[i * 3] = _c.r;
    arr[i * 3 + 1] = _c.g;
    arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function solid(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  return tint(geo, () => color);
}

/**
 * A wing panel: a tapered, swept, slightly thick quadrilateral.
 *
 * Built by hand rather than extruded because the thing that has to be right is
 * the *leading edge* — it is where the yellow goes, and it is the line the eye
 * follows when the jet rolls.
 */
function wingPanel(opts: {
  rootChord: number;
  tipChord: number;
  span: number;
  /** Leading-edge sweep, radians. */
  sweep: number;
  thickness: number;
  dihedral: number;
  /** Z of the leading edge at the root. Negative is forward. */
  rootZ: number;
  /** Which side: +1 right, -1 left. */
  side: number;
  color: number;
  edgeColor: number;
}): THREE.BufferGeometry {
  const { rootChord, tipChord, span, sweep, thickness, dihedral, rootZ, side, color, edgeColor } = opts;
  const tipZ = rootZ + Math.tan(sweep) * span;
  const tipY = Math.tan(dihedral) * span;
  const t = thickness / 2;

  // Eight corners: root LE/TE and tip LE/TE, top and bottom.
  const pts: Array<[number, number, number]> = [
    [0, t, rootZ], // 0 root LE top
    [0, t, rootZ + rootChord], // 1 root TE top
    [side * span, tipY + t * 0.5, tipZ], // 2 tip LE top
    [side * span, tipY + t * 0.5, tipZ + tipChord], // 3 tip TE top
    [0, -t, rootZ], // 4 root LE bottom
    [0, -t, rootZ + rootChord], // 5
    [side * span, tipY - t * 0.5, tipZ], // 6
    [side * span, tipY - t * 0.5, tipZ + tipChord], // 7
  ];

  const faces: number[][] = [
    [0, 1, 3, 2], // top
    [4, 6, 7, 5], // bottom
    [0, 2, 6, 4], // leading edge
    [1, 5, 7, 3], // trailing edge
    [2, 3, 7, 6], // tip
    [0, 4, 5, 1], // root
  ];

  const pos: number[] = [];
  const idx: number[] = [];
  const isEdge: boolean[] = [];
  for (let f = 0; f < faces.length; f++) {
    const quad = side > 0 ? faces[f] : [...faces[f]].reverse();
    const base = pos.length / 3;
    for (const vi of quad) {
      pos.push(pts[vi][0], pts[vi][1], pts[vi][2]);
      // Leading edge and tip get the yellow.
      isEdge.push(f === 2 || f === 4);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const col = new Float32Array(isEdge.length * 3);
  for (let i = 0; i < isEdge.length; i++) {
    _c.setHex(isEdge[i] ? edgeColor : color);
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

/** The number on the tail, drawn once per jet into a small canvas. */
function numberTexture(n: number): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, size, size);
  g.fillStyle = "#ffc61e";
  g.font = "bold 108px Impact, 'Arial Black', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), size / 2, size / 2 + 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export interface JetOptions {
  /** 1..6, or 0 for an unnumbered jet. Painted on both fins. */
  number?: number;
  /** Blue Angels paint, or plain grey fleet colours. */
  livery?: "angels" | "fleet";
}

export function buildJet(
  spec: AircraftSpec,
  material: THREE.ShaderMaterial,
  opts: JetOptions = {},
): JetRig {
  const angels = (opts.livery ?? "angels") === "angels";
  const BLUE = angels ? PALETTE.angelBlue : 0x6d7681;
  const YELLOW = angels ? PALETTE.angelYellow : 0x8b94a0;
  const L = spec.length;
  const semi = spec.wingspan / 2;
  const shape = spec.shape;
  const prop = shape.planform === "prop";

  const root = new THREE.Group();
  root.name = spec.id;
  const owned: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];

  const mesh = (geo: THREE.BufferGeometry, parent: THREE.Object3D = root) => {
    owned.push(geo);
    const m = new THREE.Mesh(geo, material);
    parent.add(m);
    return m;
  };

  // ---- fuselage -----------------------------------------------------------
  // A lathe, so the section can pinch at the nose, swell at the intakes and
  // taper to the nozzles without a single box anywhere.
  const bodyR = prop ? 1.9 : Math.max(0.85, spec.height * 0.24);
  const profile: Array<[number, number]> = prop
    ? [
        [0.02, -L * 0.5],
        [bodyR * 0.7, -L * 0.44],
        [bodyR, -L * 0.3],
        [bodyR, L * 0.16],
        [bodyR * 0.82, L * 0.34],
        [bodyR * 0.3, L * 0.5],
        [0.02, L * 0.5],
      ]
    : [
        [0.02, -L * 0.5],
        [bodyR * 0.32, -L * 0.44],
        [bodyR * 0.72, -L * 0.34],
        [bodyR * 0.98, -L * 0.16],
        [bodyR * 1.04, 0],
        [bodyR * 1.0, L * 0.2],
        [bodyR * 0.86, L * 0.4],
        [bodyR * 0.8, L * 0.5],
        [0.02, L * 0.5],
      ];

  const latheGeo = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(r, z)),
    prop ? 14 : 12,
  );
  // LatheGeometry spins about +Y; the fuselage runs along Z.
  latheGeo.rotateX(Math.PI / 2);
  // A fighter's section is wider than it is tall.
  latheGeo.scale(1.15, prop ? 1.05 : 0.86, 1);
  tint(latheGeo, (x, y, z) => {
    // The nose flash: yellow wrapping the radome's tip.
    if (z < -L * 0.42) return YELLOW;
    // Anti-glare panel ahead of the windscreen — matte black, subtle, present.
    if (angels && z > -L * 0.4 && z < -L * 0.2 && y > bodyR * 0.3) return 0x14161a;
    // Belly is the same blue; the team paints "NAVY" upside down under there
    // so it reads right way up during an inverted pass.
    return BLUE;
  });
  mesh(latheGeo);

  // ---- LERX ---------------------------------------------------------------
  if (shape.lerx) {
    for (const side of [-1, 1]) {
      const g = wingPanel({
        rootChord: L * 0.34,
        tipChord: L * 0.06,
        span: semi * 0.34,
        sweep: 1.15,
        thickness: 0.22,
        dihedral: 0,
        rootZ: -L * 0.2,
        side,
        color: BLUE,
        edgeColor: YELLOW,
      });
      mesh(g).position.y = bodyR * 0.28;
    }
  }

  // ---- main wing ----------------------------------------------------------
  const wingRootZ =
    shape.planform === "delta" ? -L * 0.1 : shape.planform === "swept" ? -L * 0.02 : -L * 0.04;
  const rootChord =
    shape.planform === "delta" ? L * 0.46 : shape.planform === "straight" ? L * 0.22 : L * 0.3;
  const tipChord = rootChord * (shape.planform === "delta" ? 0.24 : 0.42);

  for (const side of [-1, 1]) {
    const g = wingPanel({
      rootChord: prop ? L * 0.2 : rootChord,
      tipChord: prop ? L * 0.13 : tipChord,
      span: semi,
      sweep: shape.sweep,
      thickness: prop ? 0.5 : Math.max(0.16, bodyR * 0.24),
      // Hornets have a slight anhedral on the outer panel; most of the rest do
      // not. It is a small angle and it changes the whole head-on silhouette.
      dihedral: shape.lerx ? -0.03 : prop ? 0.02 : 0.04,
      rootZ: prop ? -L * 0.16 : wingRootZ,
      side,
      color: BLUE,
      edgeColor: YELLOW,
    });
    const w = mesh(g);
    w.position.y = prop ? bodyR * 0.85 : -bodyR * 0.1;

    // Ailerons, on the outboard trailing edge.
    const pivot = new THREE.Group();
    pivot.position.set(side * semi * 0.68, w.position.y, wingRootZ + rootChord * 0.86);
    root.add(pivot);
    const ail = new THREE.BoxGeometry(semi * 0.5, 0.1, rootChord * 0.2);
    solid(ail, BLUE);
    owned.push(ail);
    const am = new THREE.Mesh(ail, material);
    am.position.z = rootChord * 0.1;
    pivot.add(am);
    if (side < 0) (root as unknown as { _ailL?: THREE.Object3D })._ailL = pivot;
    else (root as unknown as { _ailR?: THREE.Object3D })._ailR = pivot;
  }

  // ---- canopy -------------------------------------------------------------
  const canopy = new THREE.SphereGeometry(bodyR * 0.62, 12, 8);
  canopy.scale(1, 0.85, prop ? 1.4 : 2.6);
  solid(canopy, PALETTE.canopy);
  mesh(canopy).position.set(0, bodyR * 0.62, prop ? -L * 0.36 : -L * 0.24);

  // ---- stabilators --------------------------------------------------------
  const stabSpan = semi * (prop ? 0.42 : 0.42);
  const stabChord = L * (prop ? 0.12 : 0.14);
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0, prop ? bodyR * 0.2 : -bodyR * 0.05, L * (prop ? 0.4 : 0.33));
    root.add(pivot);
    const g = wingPanel({
      rootChord: stabChord,
      tipChord: stabChord * 0.45,
      span: stabSpan,
      sweep: shape.sweep * 0.9 + 0.15,
      thickness: 0.14,
      dihedral: prop ? 0 : -0.05,
      rootZ: 0,
      side,
      color: BLUE,
      edgeColor: YELLOW,
    });
    owned.push(g);
    pivot.add(new THREE.Mesh(g, material));
    if (side < 0) (root as unknown as { _stabL?: THREE.Object3D })._stabL = pivot;
    else (root as unknown as { _stabR?: THREE.Object3D })._stabR = pivot;
  }

  // ---- fins ---------------------------------------------------------------
  const rudders: THREE.Object3D[] = [];
  const finCount = shape.fins;
  const finHeight = spec.height * (prop ? 1.0 : 0.78);
  const finChord = L * (prop ? 0.2 : 0.19);

  for (let i = 0; i < finCount; i++) {
    const side = finCount === 2 ? (i === 0 ? -1 : 1) : 0;
    const fin = new THREE.Group();
    fin.position.set(side * semi * 0.22, bodyR * 0.6, L * (prop ? 0.3 : 0.2));
    fin.rotation.z = -side * shape.finCant;
    root.add(fin);

    const g = wingPanel({
      rootChord: finChord,
      tipChord: finChord * 0.42,
      span: finHeight,
      sweep: 0.72,
      thickness: 0.13,
      dihedral: 0,
      rootZ: 0,
      side: 1,
      color: BLUE,
      edgeColor: YELLOW,
    });
    owned.push(g);
    const finMesh = new THREE.Mesh(g, material);
    // The panel is built spanwise in X; stand it up.
    finMesh.rotation.z = Math.PI / 2;
    fin.add(finMesh);

    // The number, on both sides of both fins.
    if (angels && opts.number) {
      const tex = numberTexture(opts.number);
      if (tex) {
        textures.push(tex);
        const decalMat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const dg = new THREE.PlaneGeometry(finHeight * 0.5, finHeight * 0.5);
        owned.push(dg);
        const decal = new THREE.Mesh(dg, decalMat);
        decal.position.set(0.09 * (side || 1), finHeight * 0.52, finChord * 0.42);
        decal.rotation.y = Math.PI / 2;
        fin.add(decal);
      }
    }

    // The rudder, hinged at the trailing edge.
    const rudder = new THREE.Group();
    rudder.position.set(0, finHeight * 0.42, finChord * 0.72);
    const rg = new THREE.BoxGeometry(0.12, finHeight * 0.62, finChord * 0.24);
    solid(rg, BLUE);
    owned.push(rg);
    rudder.add(new THREE.Mesh(rg, material));
    fin.add(rudder);
    rudders.push(rudder);
  }

  // ---- engines ------------------------------------------------------------
  const nozzles: THREE.Vector3[] = [];
  const flames: THREE.Mesh[] = [];

  if (prop) {
    // Four turboprops, and the props themselves as translucent discs — a
    // stopped propeller on a flying aeroplane is the oldest tell there is.
    for (let i = 0; i < 4; i++) {
      const side = i < 2 ? -1 : 1;
      const out = (i % 2 === 0 ? 0.34 : 0.6) * semi;
      const nacelle = new THREE.CylinderGeometry(0.85, 0.7, 5.2, 10);
      nacelle.rotateX(Math.PI / 2);
      solid(nacelle, 0xdfe3e8);
      owned.push(nacelle);
      const nm = new THREE.Mesh(nacelle, material);
      nm.position.set(side * out, bodyR * 0.72, -L * 0.14);
      root.add(nm);

      const disc = new THREE.CircleGeometry(2.1, 16);
      const discMat = new THREE.MeshBasicMaterial({
        color: 0xb8c4d4,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      owned.push(disc);
      const dm = new THREE.Mesh(disc, discMat);
      dm.position.set(side * out, bodyR * 0.72, -L * 0.2);
      root.add(dm);
    }
  } else {
    const spread = shape.nozzles === 2 ? bodyR * 0.62 : 0;
    for (let i = 0; i < shape.nozzles; i++) {
      const x = shape.nozzles === 2 ? (i === 0 ? -spread : spread) : 0;
      const nz = new THREE.CylinderGeometry(bodyR * 0.52, bodyR * 0.46, 1.6, 10, 1, true);
      nz.rotateX(Math.PI / 2);
      solid(nz, PALETTE.nozzle);
      owned.push(nz);
      mesh(nz).position.set(x, 0, L * 0.47);
      nozzles.push(new THREE.Vector3(x, 0, L * 0.5));

      // The burner plume: a cone with additive shading and a shock-diamond
      // stripe down the middle. Scaled to zero when the burner is out.
      const flameGeo = new THREE.ConeGeometry(bodyR * 0.42, 9, 12, 1, true);
      flameGeo.rotateX(-Math.PI / 2);
      flameGeo.translate(0, 0, 4.5);
      owned.push(flameGeo);
      const flameMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uPower;
          varying vec3 vPos;
          void main() {
            float t = clamp(vPos.z / 9.0, 0.0, 1.0);
            // Shock diamonds: standing waves in the plume, spaced by the
            // pressure ratio. Nothing else looks like an afterburner.
            float diamonds = 0.5 + 0.5 * sin(t * 34.0 - uTime * 12.0);
            vec3 core = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.55, 0.18), t);
            float a = (1.0 - t) * uPower * (0.55 + 0.45 * diamonds);
            gl_FragColor = vec4(core * (1.4 + diamonds * 0.6), a);
          }
        `,
      });
      const flame = new THREE.Mesh(flameGeo, flameMat);
      flame.position.set(x, 0, L * 0.5);
      flame.visible = false;
      root.add(flame);
      flames.push(flame);
    }
  }

  // ---- landing gear -------------------------------------------------------
  const gear = new THREE.Group();
  gear.name = "gear";
  root.add(gear);
  const gearLen = spec.height * 0.45;
  const legs: Array<[number, number]> = [
    [0, -L * 0.3],
    [-semi * 0.28, L * 0.02],
    [semi * 0.28, L * 0.02],
  ];
  for (const [x, z] of legs) {
    const strut = new THREE.CylinderGeometry(0.11, 0.13, gearLen, 6);
    solid(strut, 0xc9ced6);
    owned.push(strut);
    const sm = new THREE.Mesh(strut, material);
    sm.position.set(x, -bodyR * 0.55 - gearLen / 2, z);
    gear.add(sm);

    const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.24, 10);
    wheel.rotateZ(Math.PI / 2);
    solid(wheel, 0x1c1e22);
    owned.push(wheel);
    const wm = new THREE.Mesh(wheel, material);
    wm.position.set(x, -bodyR * 0.55 - gearLen, z);
    gear.add(wm);
  }
  gear.visible = false;

  const tips = [new THREE.Vector3(-semi, 0, wingRootZ + Math.tan(shape.sweep) * semi + tipChord * 0.7),
                new THREE.Vector3(semi, 0, wingRootZ + Math.tan(shape.sweep) * semi + tipChord * 0.7)];

  const rig: JetRig = {
    root,
    aileronL: (root as unknown as { _ailL: THREE.Object3D })._ailL,
    aileronR: (root as unknown as { _ailR: THREE.Object3D })._ailR,
    stabL: (root as unknown as { _stabL: THREE.Object3D })._stabL,
    stabR: (root as unknown as { _stabR: THREE.Object3D })._stabR,
    rudders,
    gear,
    nozzles: nozzles.length ? nozzles : [new THREE.Vector3(0, 0, L * 0.5)],
    tips,
    flames,
    dispose() {
      for (const g of owned) g.dispose();
      for (const t of textures) t.dispose();
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m && m !== material) {
          for (const mm of Array.isArray(m) ? m : [m]) mm.dispose();
        }
      });
    },
  };
  return rig;
}

/**
 * Push the pilot's inputs into the airframe.
 *
 * Control surfaces that do not move are the fastest way to make a good model
 * look like a toy, and they are almost free: four rotations a frame.
 */
export function poseJet(
  rig: JetRig,
  controls: { roll: number; pitch: number; yaw: number; brake: number },
  gearPos: number,
  burner: number,
  time: number,
): void {
  const ail = controls.roll * 0.42;
  rig.aileronL.rotation.x = ail;
  rig.aileronR.rotation.x = -ail;
  // Stabilators are the primary pitch control on everything here, and they
  // also differentially help the roll.
  const stab = -controls.pitch * 0.3;
  rig.stabL.rotation.x = stab + ail * 0.25;
  rig.stabR.rotation.x = stab - ail * 0.25;
  for (const r of rig.rudders) r.rotation.y = -controls.yaw * 0.34;

  rig.gear.visible = gearPos > 0.01;
  if (gearPos > 0.01) {
    // Legs swing down rather than appearing: rotate about the fuselage line.
    rig.gear.rotation.x = (1 - gearPos) * -1.35;
    rig.gear.scale.setScalar(0.35 + gearPos * 0.65);
  }

  for (const f of rig.flames) {
    f.visible = burner > 0.01;
    if (!f.visible) continue;
    const mat = f.material as THREE.ShaderMaterial;
    mat.uniforms.uTime.value = time;
    mat.uniforms.uPower.value = burner;
    // The plume lengthens with power and flickers, because a constant-length
    // flame reads as a cone glued to the tail.
    f.scale.set(0.8 + burner * 0.4, 0.8 + burner * 0.4, 0.35 + burner * (0.8 + Math.sin(time * 31) * 0.06));
  }
}
