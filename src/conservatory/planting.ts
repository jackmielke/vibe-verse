/**
 * What grows in here.
 *
 * THE FIRST VERSION OF THIS FILE WAS A CORNFIELD, and the reason is worth
 * writing down because it is not obvious from the code. It had five
 * "species" — palm, fern, paddle, hanging, ground — with different lengths,
 * widths, counts, tints and stiffnesses. Five entries in an array, all
 * carefully distinct. And every one of them called the same
 * `bladeGeometry()`, so every plant in the house was one tapered strap at a
 * different size. Walking down the nave was walking through maize.
 *
 * A plant is recognised by its SILHOUETTE before anything else. Tint and
 * scale do not separate a palm from a fern; a palm is a stem with leaflets
 * ranked along it and a fern is the same idea drawn finer, while a banana
 * is one huge sheet torn into ribbons by the wind. So there are three
 * geometry builders here rather than one, and the variety comes from them:
 *
 *   strapGeometry  — one tapered blade. Grasses and ground cover only.
 *   frondGeometry  — a rachis with leaflets ranked up it. Palms, ferns.
 *   paddleGeometry — a broad sheet with a folded midrib and torn edges.
 *
 * The other half of looking real is knowing where NOT to put things. The
 * cornfield was also a framing problem: fronds were anchored at x≈3 and
 * three metres long, so they lay across the walking line at eye height and
 * there was no room left to be in. Planting now respects a clear corridor
 * (`PATH`), and the canopy is only allowed to close overhead — well above a
 * head — which is what a real glasshouse does and why it feels like a room
 * rather than a hedge.
 *
 * Two things then make it move, and neither is polygon count.
 *
 * WIND IS NOT A SINE. A real gust arrives, bends everything one way for a
 * few seconds, and passes — and while it is passing, individual leaves
 * flutter on their own much faster. So there are two terms: a slow lean
 * shared by every plant in the house (`uGust`, so the whole room moves
 * together, which is what makes it feel like one volume of air) and a fast
 * per-leaf flutter that only shows up while the gust is on.
 *
 * LEAVES ARE THIN. Handled in `leafShade` — but the geometry has to earn it
 * by being single-sided blades you can actually get behind, not boxes.
 *
 * Bend needs to know how far out along the plant a vertex is, and that is
 * not its height: a hanging basket points down, and a leaflet halfway up a
 * frond should swing with the frond, not with its own tip. So it is baked
 * per-vertex as `aFlex` when the geometry is built, and `aLeaf` alongside it
 * carries base-to-tip position within a single leaflet for the colour ramp.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON } from "./shaders";
import { NAVE } from "./structure";

/** Half-width of the corridor a person walks down. Nothing may hang into
 *  this below head height; the canopy above it is the whole point. */
const PATH = 3.35;
/** Above here, foliage may reach as far over the path as it likes. */
const HEAD = 2.5;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Planting {
  group: THREE.Group;
  dispose(): void;
}

// ---------------------------------------------------------------------
// Leaf geometry
//
// All three builders write into the same little accumulator, so a frond is
// literally twenty blades welded together and costs one instance to draw.
// ---------------------------------------------------------------------

interface Accum {
  pos: number[];
  flex: number[];
  leaf: number[];
}

const newAccum = (): Accum => ({ pos: [], flex: [], leaf: [] });

function finish(a: Accum): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(a.pos, 3));
  g.setAttribute("aFlex", new THREE.Float32BufferAttribute(a.flex, 1));
  g.setAttribute("aLeaf", new THREE.Float32BufferAttribute(a.leaf, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Lay one tapered blade into the accumulator under an arbitrary transform.
 *
 * `flexAt` is the anchor's own flex — everything on this blade swings at
 * least that much, plus its own reach — which is what makes a leaflet
 * halfway up a frond travel with the frond rather than independently.
 */
function blade(
  a: Accum,
  m: THREE.Matrix4,
  len: number,
  wid: number,
  segs: number,
  droop: number,
  flexAt: number,
  flexSpan: number,
) {
  const v = new THREE.Vector3();
  const ring: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Taper to a point, with a little width kept at the base. The sine
    // gives a leaf's shoulder rather than a triangle's straight edge.
    const w = (wid / 2) * (0.22 + 0.78 * Math.sin(Math.PI * Math.min(t * 1.12, 1)));
    const y = t * len;
    const z = -droop * t * t * len;
    const row: number[] = [];
    for (const s of [-1, 1]) {
      v.set(s * w, y, z).applyMatrix4(m);
      row.push(v.x, v.y, v.z);
    }
    ring.push(row);
  }
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const [l0x, l0y, l0z, r0x, r0y, r0z] = ring[i];
    const [l1x, l1y, l1z, r1x, r1y, r1z] = ring[i + 1];
    const f0 = flexAt + flexSpan * t0;
    const f1 = flexAt + flexSpan * t1;
    const push = (x: number, y: number, z: number, f: number, l: number) => {
      a.pos.push(x, y, z);
      a.flex.push(f);
      a.leaf.push(l);
    };
    push(l0x, l0y, l0z, f0, t0); push(r0x, r0y, r0z, f0, t0); push(r1x, r1y, r1z, f1, t1);
    push(l0x, l0y, l0z, f0, t0); push(r1x, r1y, r1z, f1, t1); push(l1x, l1y, l1z, f1, t1);
  }
}

/** One strap leaf, standing at the origin. Grasses, and nothing else. */
function strapGeometry(len: number, wid: number, segs: number, droop: number) {
  const a = newAccum();
  blade(a, new THREE.Matrix4(), len, wid, segs, droop, 0, 1);
  return finish(a);
}

/**
 * A pinnate frond: a rachis arching up and over, with leaflets ranked in
 * pairs along it. This is the shape that says "palm" from forty metres away
 * in a silhouette, and no amount of tinting a strap will say it.
 */
function frondGeometry(opts: {
  rachis: number;
  pairs: number;
  leaflet: number;
  wide: number;
  droop: number;
  /** How far back from perpendicular the leaflets sweep, in radians. */
  sweep: number;
  /** Leaflets shorten towards the tip; 1 = no shortening. */
  taper: number;
  segs?: number;
}) {
  const a = newAccum();
  const segs = opts.segs ?? 3;
  const m = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);

  // The rachis itself — a thin strip, so the frond has a visible spine.
  blade(a, new THREE.Matrix4(), opts.rachis, opts.wide * 0.30, 6, opts.droop, 0, 1);

  for (let i = 0; i < opts.pairs; i++) {
    // Start a little way up: a frond is bare at the base.
    const t = 0.16 + 0.84 * ((i + 0.5) / opts.pairs);
    const y = t * opts.rachis;
    const z = -opts.droop * t * t * opts.rachis;
    // Shorter at both ends, longest around a third of the way up.
    const bell = Math.sin(Math.PI * Math.min(t * 1.05, 1)) ** 0.6;
    const len = opts.leaflet * bell * (1 - opts.taper * t);

    for (const side of [-1, 1]) {
      p.set(0, y, z);
      /* Rotate the leaflet out sideways, then tip it forward so the pair
         makes a shallow V rather than lying flat — a frond is a gutter, and
         that is what catches the light along its length. */
      e.set(opts.sweep, 0, side * (Math.PI / 2 - opts.sweep * 0.55), "ZYX");
      q.setFromEuler(e);
      m.compose(p, q, s);
      blade(a, m, len, opts.wide, segs, 0.30, t, (1 - t) * 0.55 + 0.12);
    }
  }
  return finish(a);
}

/**
 * A broad sheet — banana, canna, the things at eye level you actually walk
 * past. Two details do all the work: the midrib is a fold, not a line, so
 * the leaf catches light on one half and not the other; and the edges are
 * torn into ribbons, because a big soft leaf in a room with wind in it
 * always is, and a clean ellipse looks like plastic.
 */
function paddleGeometry(len: number, wid: number, tears: number) {
  const a = newAccum();
  const segs = 8;
  const rows: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = (wid / 2) * Math.sin(Math.PI * Math.min(0.10 + t * 0.95, 1)) ** 0.75;
    // The tears: a comb along the edge, deeper towards the tip.
    const comb = Math.abs(Math.sin(t * tears * Math.PI));
    const cut = w * 0.34 * comb * t;
    const y = t * len;
    const fold = -0.10 * len * t;             // the whole leaf arcs over
    rows.push([w - cut, y, fold]);
  }
  const v = new THREE.Vector3();
  const push = (x: number, y: number, z: number, f: number, l: number) => {
    v.set(x, y, z);
    a.pos.push(v.x, v.y, v.z);
    a.flex.push(f);
    a.leaf.push(l);
  };
  for (let i = 0; i < segs; i++) {
    const [w0, y0, z0] = rows[i];
    const [w1, y1, z1] = rows[i + 1];
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    // The midrib sits proud of the two halves — hence the centre column at
    // z0 + rise rather than a single flat quad across.
    const rise0 = wid * 0.10;
    const rise1 = wid * 0.10;
    for (const s of [-1, 1]) {
      push(0, y0, z0 + rise0, t0, t0);
      push(s * w0, y0, z0, t0, t0);
      push(s * w1, y1, z1, t1, t1);
      push(0, y0, z0 + rise0, t0, t0);
      push(s * w1, y1, z1, t1, t1);
      push(0, y1, z1 + rise1, t1, t1);
    }
  }
  return finish(a);
}

// ---------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------

function leafMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aTint;
      attribute vec3 aParams;   // x: phase, y: stiffness, z: thinness
      attribute float aFlex;    // 0 at the anchor, 1 at the far extremity
      attribute float aLeaf;    // 0 at a leaflet's base, 1 at its tip
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vTint;
      varying float vThin;
      varying float vLeaf;
      uniform float uTime;
      uniform float uGust;
      void main(){
        vTint = aTint;
        vThin = aParams.z;
        vLeaf = aLeaf;
        vec3 p = position;
        // Bend accumulates towards the extremity — a plant is anchored at
        // its base, and a leaflet halfway up a frond travels WITH the frond.
        float bendAmt = aFlex * aFlex * (1.6 - aParams.y);

        // The gust: one direction, shared by the whole house.
        float lean = uGust * bendAmt * 0.55;
        // The flutter: fast, per-leaf, and only while the gust is blowing.
        float flut = sin(uTime * (5.5 + aParams.x * 4.0) + aParams.x * 40.0)
                   * bendAmt * (0.035 + uGust * 0.14);

        p.x += lean + flut;
        p.z += lean * 0.35 + flut * 0.5;
        // Bending shortens the reach, which stops leaves stretching.
        p.y -= (lean * lean + flut * flut) * 0.5;

        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vTint;
      varying float vThin;
      varying float vLeaf;
      ${CONSERVATORY_COMMON}
      void main(){
        vec3 n = normalize(vNormal);
        // Two-sided: flip the normal to face the eye, or half the canopy
        // shades as though it were lit from behind the camera.
        vec3 v = normalize(uCamPos - vWorld);
        if (dot(n, v) < 0.0) n = -n;

        // Darker at the base, paler and thinner at the tip.
        vec3 albedo = vTint * (0.66 + 0.52 * vLeaf);

        // Dimmed by the same roof as everything else — a leaf under a rib
        // is in shadow, and the shadow moves with the rib.
        /* Foliage is nearer the glass than the floor is, and the canopy is
           nearer still, so its shadow edges are correspondingly crisper —
           the penumbra closes as the gap does. */
        float lift = clamp(vWorld.y / 9.0, 0.0, 1.0);
        vec2 blur = mix(vec2(0.010, 0.021), vec2(0.003, 0.006), lift);
        float shade = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07), blur);
        // Lower leaves are shaded by the canopy above them — the same
        // canopy the floor is shaded by, so a leaf standing in a bright
        // patch of path is itself bright.
        shade *= canopyShade(vWorld);

        vec3 col = leafShade(n, v, albedo, vThin, shade);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

/**
 * Palm trunks.
 *
 * These were handed the ironwork's material, so every palm in the house
 * stood on a column of cream Victorian paint — indistinguishable from the
 * actual iron columns three metres behind them, and the reason the palms
 * looked like fronds floating in mid-air. A trunk is fibrous, brown, and
 * ringed with the scars of the fronds it has already dropped.
 */
function barkMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${CONSERVATORY_COMMON}
      void main(){
        vec3 n = normalize(vNormal);
        // Vertical fibre, and the horizontal scar rings the geometry bulges.
        float fibre = fbm(vec2(atan(vWorld.z, vWorld.x) * 3.0, vWorld.y * 7.0));
        float scar = 0.5 + 0.5 * sin(vWorld.y * 21.0);
        vec3 wood = mix(vec3(0.175, 0.132, 0.090), vec3(0.290, 0.228, 0.158), fibre);
        wood = mix(wood, wood * 0.72, scar * 0.40);
        // Moss up the damp side, which in here is every side.
        float moss = smoothstep(0.55, 0.85, fbm(vec2(vWorld.x, vWorld.y) * 1.6))
                   * smoothstep(2.6, 0.4, vWorld.y);
        wood = mix(wood, vec3(0.062, 0.105, 0.050), moss * 0.6);

        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.007, 0.015));
        vec3 sky = uSkyColor * (0.80 + 0.55 * (n.y * 0.5 + 0.5));
        vec3 col = wood * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir)))
                                 * thru * 1.8);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// The planting plan
// ---------------------------------------------------------------------

interface Species {
  name: string;
  geo: THREE.BufferGeometry;
  count: number;
  /** Places a single instance. */
  place(m: THREE.Matrix4, rand: () => number, x: number, z: number, i: number): void;
  /** Where along x, from the centre line, this species is bedded. */
  bed: [number, number];
  tint: [number, number, number];
  tintVary: number;
  stiffness: number;
  thinness: number;
}

export function buildPlanting(uniforms: Record<string, THREE.IUniform>): Planting {
  const group = new THREE.Group();
  const rand = rng(0x5eed);
  const owned: THREE.BufferGeometry[] = [];
  const mat = leafMaterial(uniforms);
  const bark = barkMaterial(uniforms);

  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  /* Palm trunks are placed first, because the fronds have to grow out of
     them. A crown of fronds hanging in mid-air over a trunk that is three
     metres away is the single most obvious tell there is. */
  const trunks: { x: number; z: number; h: number }[] = [];
  const tr = rng(0xbeef);
  for (let i = 0; i < 18; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    trunks.push({
      x: side * (4.5 + tr() * 1.9),
      z: (tr() - 0.5) * (NAVE.length - 6),
      h: 3.4 + tr() * 1.7,
    });
  }

  const species: Species[] = [
    {
      /* Palms. The crowns sit HIGH — above head height — and arch inward
         over the walk, so the canopy closes overhead while the corridor
         stays open. The first pass put crowns at 2.8m and let fronds reach
         to x=1, which put three metres of leaf across the walking line at
         eye level: not a canopy, a hedge you were inside. */
      name: "palm",
      geo: frondGeometry({
        rachis: 2.5, pairs: 13, leaflet: 0.52, wide: 0.085,
        droop: 0.34, sweep: 0.34, taper: 0.35,
      }),
      count: 150,
      bed: [0, 0],   // placed on the trunks instead
      tint: [0.115, 0.235, 0.095], tintVary: 0.24, stiffness: 0.95, thinness: 0.65,
      place(m, r, _x, _z, i) {
        const t = trunks[i % trunks.length];
        const a = (i / trunks.length) * 2.4 + r() * 0.5;
        // Fronds radiate from the crown, arching down and outward. Tilted
        // back towards the nave so the canopy leans over the path.
        e.set(-0.55 - r() * 0.75, a, 0, "YXZ");
        q.setFromEuler(e);
        pos.set(t.x, t.h + 0.25, t.z);
        scl.setScalar(0.9 + r() * 0.45);
        m.compose(pos, q, scl);
      },
    },
    {
      /* Tree ferns: the same pinnate idea drawn much finer, in a
         shuttlecock at waist height, deep in the beds. */
      name: "fern",
      geo: frondGeometry({
        rachis: 1.25, pairs: 15, leaflet: 0.24, wide: 0.055,
        droop: 0.55, sweep: 0.16, taper: 0.45, segs: 2,
      }),
      count: 300,
      bed: [3.9, 6.5],
      tint: [0.095, 0.215, 0.095], tintVary: 0.30, stiffness: 0.35, thinness: 0.95,
      place(m, r, x, z, i) {
        const a = (i % 7) / 7 * Math.PI * 2 + r() * 0.7;
        e.set(-0.40 - r() * 0.60, a, (r() - 0.5) * 0.25, "YXZ");
        q.setFromEuler(e);
        pos.set(x, 0.45 + r() * 0.75, z);
        scl.setScalar(0.7 + r() * 0.6);
        m.compose(pos, q, scl);
      },
    },
    {
      /* Bananas and cannas — the big torn sheets you walk past. They stand
         near the kerb because their scale is what tells you how big the
         room is, and you have to be beside one to read it. */
      name: "paddle",
      geo: paddleGeometry(1.5, 0.72, 7),
      count: 150,
      bed: [3.7, 5.6],
      tint: [0.085, 0.205, 0.090], tintVary: 0.22, stiffness: 1.0, thinness: 0.55,
      place(m, r, x, z) {
        e.set(-0.18 - r() * 0.55, r() * Math.PI * 2, (r() - 0.5) * 0.45, "YXZ");
        q.setFromEuler(e);
        pos.set(x, 0.55 + r() * 1.5, z);
        scl.setScalar(0.7 + r() * 0.65);
        m.compose(pos, q, scl);
      },
    },
    {
      /* Hanging baskets slung from the purlins. They cross the top of the
         forward view, which is the cheapest way to make a long room feel
         occupied rather than surveyed — but they hang WELL above a head,
         and the trailing strands are short. */
      name: "hanging",
      geo: strapGeometry(0.85, 0.075, 6, 1.30),
      count: 700,
      bed: [2.2, 3.9],
      tint: [0.115, 0.245, 0.105], tintVary: 0.30, stiffness: 0.2, thinness: 1.0,
      place(m, r, x, z) {
        e.set(Math.PI - 0.30 + r() * 0.6, r() * Math.PI * 2, (r() - 0.5) * 0.4, "YXZ");
        q.setFromEuler(e);
        pos.set(x, 3.5 + r() * 1.0, z);
        scl.setScalar(0.7 + r() * 0.6);
        m.compose(pos, q, scl);
      },
    },
    {
      /* SCREENING. Everything above is bedded between x=3.7 and x=6.5, and
         the house is 7m to the wall — so behind every plant there was a
         strip of bare grey glazing at exactly eye level, and the beds read
         as a window box rather than as a jungle you cannot see the end of.
         This is one tall dense rank hard against the wall whose only job is
         that you never see through the planting. */
      name: "screen",
      geo: strapGeometry(1.35, 0.16, 6, 0.42),
      count: 900,
      bed: [5.9, 6.85],
      tint: [0.075, 0.175, 0.080], tintVary: 0.20, stiffness: 0.75, thinness: 0.8,
      place(m, r, x, z) {
        e.set(-0.15 - r() * 0.45, r() * Math.PI * 2, (r() - 0.5) * 0.5, "YXZ");
        q.setFromEuler(e);
        pos.set(x, 0.38 + r() * 1.7, z);
        scl.setScalar(0.8 + r() * 0.8);
        m.compose(pos, q, scl);
      },
    },
    {
      // Ground cover crowding the kerb and creeping onto the tiles.
      name: "ground",
      geo: strapGeometry(0.42, 0.10, 4, 0.6),
      count: 1400,
      bed: [3.3, 6.7],
      tint: [0.105, 0.235, 0.100], tintVary: 0.32, stiffness: 0.5, thinness: 1.0,
      place(m, r, x, z) {
        e.set(-0.28 - r() * 0.8, r() * Math.PI * 2, (r() - 0.5) * 0.7, "YXZ");
        q.setFromEuler(e);
        pos.set(x, 0.34 + r() * 0.20, z);
        scl.setScalar(0.7 + r() * 0.8);
        m.compose(pos, q, scl);
      },
    },
  ];

  const m4 = new THREE.Matrix4();
  const colour = new THREE.Color();

  for (const s of species) {
    const mesh = new THREE.InstancedMesh(s.geo, mat, s.count);
    mesh.frustumCulled = false;
    const tints = new Float32Array(s.count * 3);
    const params = new Float32Array(s.count * 3);

    for (let i = 0; i < s.count; i++) {
      const side = rand() < 0.5 ? -1 : 1;
      const x = side * (s.bed[0] + rand() * (s.bed[1] - s.bed[0]));
      const z = (rand() - 0.5) * (NAVE.length - 4.5);
      s.place(m4, rand, x, z, i);
      mesh.setMatrixAt(i, m4);

      const v = (rand() - 0.5) * s.tintVary;
      colour.setRGB(
        Math.max(0, s.tint[0] + v * 0.5),
        Math.max(0, s.tint[1] + v),
        Math.max(0, s.tint[2] + v * 0.4),
      );
      tints[i * 3] = colour.r; tints[i * 3 + 1] = colour.g; tints[i * 3 + 2] = colour.b;
      params[i * 3] = rand();
      params[i * 3 + 1] = s.stiffness;
      params[i * 3 + 2] = s.thinness;
    }
    mesh.instanceMatrix.needsUpdate = true;
    s.geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));
    s.geo.setAttribute("aParams", new THREE.InstancedBufferAttribute(params, 3));
    group.add(mesh);
    owned.push(s.geo);
  }

  /* The trunks the palm crowns actually sit on. Not instanced with the
     leaves — they are solid, and they want the ironwork's shading. Rings
     of old frond scars give them a scale you can read at a glance. */
  const trunkParts: THREE.BufferGeometry[] = [];
  for (const t of trunks) {
    const g = new THREE.CylinderGeometry(0.135, 0.23, t.h, 8, 6);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      // Frond scars: a shallow ripple every 30cm or so, and a slight lean.
      const bulge = 1 + 0.055 * Math.sin((y + t.h / 2) * 21.0);
      const lean = 0.035 * (y + t.h / 2);
      p.setX(i, p.getX(i) * bulge + lean * Math.sign(-t.x));
      p.setZ(i, p.getZ(i) * bulge);
    }
    g.computeVertexNormals();
    g.translate(t.x, t.h / 2 + 0.3, t.z);
    trunkParts.push(g);
  }
  const trunkGeo = mergeTrunks(trunkParts);
  trunkParts.forEach((g) => g.dispose());
  const trunkMesh = new THREE.Mesh(trunkGeo, bark);
  trunkMesh.frustumCulled = false;
  group.add(trunkMesh);
  owned.push(trunkGeo);

  return {
    group,
    dispose() {
      owned.forEach((g) => g.dispose());
      mat.dispose();
      bark.dispose();
    },
  };
}

/** Same merge as structure.ts, kept local so planting owns its own. */
function mergeTrunks(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of flat) total += g.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let o = 0;
  for (const g of flat) {
    if (!g.attributes.normal) g.computeVertexNormals();
    position.set(g.attributes.position.array as ArrayLike<number>, o * 3);
    normal.set(g.attributes.normal.array as ArrayLike<number>, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return out;
}

/** Exported for the test that checks nothing hangs into the walking line. */
export const PLANTING_CLEARANCE = { PATH, HEAD };
