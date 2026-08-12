/**
 * islandGrass — the lawn on Vibe Island, as actual grass.
 *
 * What was here before was a 1024² canvas stretched over a 110 m disc: about
 * nine pixels per metre, which is why standing on the island put you on a flat
 * mint-green plane with a faint path painted on it. No amount of redrawing that
 * canvas fixes it — at ankle height there is simply nothing there to see.
 *
 * So there are two halves to this module, and they solve different distances:
 *
 *  - `lawnTextures()` is the far half. The colour map keeps doing what it did
 *    (mowed stripes, the sandy path cross, clover) because that is the read
 *    from the air. What is new is a *tiled* normal map at ~2.5 m per repeat,
 *    which is what stops the mid-distance lawn being one flat value. three
 *    gives every map its own UV transform, so the colour map can stay at
 *    repeat 1 while the grain repeats forty times across the same mesh.
 *
 *  - `buildGrassField()` is the near half: real blades, instanced, swaying.
 *    One draw call, five triangles each, a vertex-shader wind that costs the
 *    CPU one uniform per frame. Blades cluster into tufts rather than
 *    scattering evenly, because evenly-scattered grass reads as a texture and
 *    clumped grass reads as a field.
 *
 * Both are shared with nothing — this is Vibe Island's lawn specifically, and
 * the exclusion predicate that keeps blades out of the plaza and the shops is
 * supplied by `cardboardIsland`, which is the only place that knows where the
 * buildings ended up.
 */
import * as THREE from "three";
import { ROAD } from "./islandPlan";

/** How the roads land on the canvas, in texture pixels. */
interface RoadPx {
  /** Pixels per island metre. */
  ppm: number;
}

/** Deterministic RNG — the lawn must not reshuffle between visits. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Ground textures
// ------------------------------------------------------------------

/**
 * The macro lawn: mowed stripes, a sandy path cross with stepping stones,
 * scattered clover. Read from the air and from a jetpack, where individual
 * blades are sub-pixel and all that survives is the large-scale pattern.
 *
 * Drawn at 2048 rather than 1024 not because anyone can see 2048 pixels over
 * 110 m — they can't — but because the path edges were visibly stair-stepped
 * at 1024 and a soft edge is most of what makes a path look worn in.
 */
function lawnColorTexture(road: RoadPx): THREE.CanvasTexture {
  const S = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;

  // Base: a deep, desaturated green — much darker than it looks like it
  // should be. The blades standing on top are lit from above and read light;
  // if the ground under them is the same value the whole field flattens into
  // one mint sheet, which is exactly what the old lawn did. The ground is the
  // shadow between the blades, so it has to be painted as one.
  ctx.fillStyle = "#33661f";
  ctx.fillRect(0, 0, S, S);

  // Broad colour drift — sun-bleached patches and damp hollows. Two octaves
  // of soft ellipses is enough; the point is that no two square metres of the
  // lawn are the same value.
  for (const [count, rad, alpha, warm, cool] of [
    [40, 260, 0.2, "rgba(122,166,64,ALPHA)", "rgba(30,64,26,ALPHA)"],
    [140, 90, 0.16, "rgba(140,180,78,ALPHA)", "rgba(34,72,28,ALPHA)"],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const x = (i * 613 + 71) % S;
      const y = (i * 977 + 149) % S;
      const c = (i % 2 ? warm : cool).replace("ALPHA", String(alpha));
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(x, y, rad * (0.5 + ((i * 37) % 100) / 120), rad * (0.4 + ((i * 53) % 100) / 140), i, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // (No mowed stripes. The old lawn had them and they came back here first,
  // but a five-metre band of flat white across a rolling meadow reads as a
  // light leak, not as mowing — and nobody mows a floating island anyway.)

  // Cropped grass, painted. One texel is about 5 cm, so a short stroke here is
  // roughly one blade lying flat — which is what the ground between the
  // standing blades actually is. 26k of them is not excessive: at this scale
  // anything sparser averages back to a flat fill at ten metres.
  const strokeRand = mulberry32(31415);
  ctx.lineCap = "round";
  // Two passes at two scales. The long pass is clump-sized — a tuft of grass
  // seen from standing height is about a hand's width, and at 18 px per metre
  // that is a ten-pixel stroke. The short pass is the stubble between them.
  for (const [n, minLen, spread, wide] of [
    [34000, 5, 11, 2.6],
    [46000, 2, 4, 1.6],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const x = strokeRand() * S;
      const y = strokeRand() * S;
      const a = strokeRand() * Math.PI * 2;
      const len = minLen + strokeRand() * spread;
      const shade = strokeRand();
      // The pale tone is the one to be careful with. A bright straw stroke at
      // a third of a metre long, repeated a few thousand times, stops reading
      // as sun-caught grass and starts reading as scratches on the lens.
      ctx.strokeStyle =
        shade < 0.46
          ? `rgba(18,48,14,${0.24 + strokeRand() * 0.3})`
          : shade < 0.88
            ? `rgba(98,150,54,${0.22 + strokeRand() * 0.28})`
            : `rgba(138,174,82,${0.1 + strokeRand() * 0.14})`;
      ctx.lineWidth = 1.1 + strokeRand() * wide;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
  }
  // A scatter of bare, trodden patches — thin soil showing through where the
  // island gets walked on. Grass that is perfect everywhere reads as carpet.
  // Small and faint: at 18 px per metre a 40 px blob is a two-metre bald spot,
  // and a lawn covered in those looks diseased rather than used.
  for (let i = 0; i < 110; i++) {
    const x = strokeRand() * S;
    const y = strokeRand() * S;
    const r = 8 + strokeRand() * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(104,84,50,0.3)");
    g.addColorStop(0.6, "rgba(92,78,48,0.11)");
    g.addColorStop(1, "rgba(92,78,48,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /*
   * The roads.
   *
   * Four arms of different lengths, not a cross running rim to rim. That is
   * the point of the layout: the east and west arms stop at a shop door, and
   * the north and south arms run out to the beacon and the Character Studio,
   * so every road arrives somewhere instead of running off the edge of the
   * island. The lengths are `ROAD.arm`, which the grass density predicate
   * reads too — paint a road here and the grass gets out of its way for free.
   *
   * Texture space: island +x is +u, and three's default `flipY` puts island +z
   * *down* the canvas. Getting that backwards lays the High Street's stepping
   * stones up the Approach instead.
   */
  const half = ROAD.half * road.ppm;
  const ARMS: Array<{ dx: number; dy: number; len: number }> = [
    { dx: 0, dy: -1, len: ROAD.arm.north * road.ppm },
    { dx: 0, dy: 1, len: ROAD.arm.south * road.ppm },
    { dx: 1, dy: 0, len: ROAD.arm.east * road.ppm },
    { dx: -1, dy: 0, len: ROAD.arm.west * road.ppm },
  ];
  // Trodden earth, not a stripe of beige: a soft body, a darker damp centre
  // line, and grass creeping back in at the shoulders.
  const surface = ctx.createLinearGradient(0, -half, 0, half);
  surface.addColorStop(0, "rgba(214,192,150,0)");
  surface.addColorStop(0.18, "rgba(214,192,150,0.55)");
  surface.addColorStop(0.34, "rgba(220,199,158,0.95)");
  surface.addColorStop(0.5, "rgba(203,180,140,0.95)");
  surface.addColorStop(0.66, "rgba(220,199,158,0.95)");
  surface.addColorStop(0.82, "rgba(214,192,150,0.55)");
  surface.addColorStop(1, "rgba(214,192,150,0)");
  for (const arm of ARMS) {
    ctx.save();
    ctx.translate(S / 2, S / 2);
    // Rotate the arm onto +x, so one piece of drawing code covers all four.
    ctx.rotate(Math.atan2(arm.dy, arm.dx));
    ctx.fillStyle = surface;
    // Start behind the centre so the four arms overlap into one junction
    // rather than leaving a seam through the middle of the plaza.
    ctx.fillRect(-half, -half, arm.len + half, half * 2);
    // Grit — small stones and scuffs, the detail that stops a gradient
    // reading as a gradient.
    const span = Math.max(1, Math.round(arm.len + half));
    for (let i = 0; i < 900; i++) {
      const along = ((i * 191) % span) - half;
      const across = ((i * 313) % Math.round(half * 1.8)) - half * 0.9;
      ctx.fillStyle = i % 4 === 0 ? "rgba(140,118,84,0.35)" : "rgba(240,228,198,0.4)";
      const w = 2 + (i % 3);
      ctx.fillRect(along, across, w, w);
    }
    // A soft end cap, so the road stops like a worn patch petering out rather
    // than a ruled line drawn across the grass.
    const cap = ctx.createRadialGradient(arm.len, 0, half * 0.25, arm.len, 0, half * 1.2);
    cap.addColorStop(0, "rgba(214,192,150,0.7)");
    cap.addColorStop(1, "rgba(214,192,150,0)");
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.arc(arm.len, 0, half * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /*
   * The promenade: the same worn earth as the avenues, swept round the rim.
   *
   * Drawn as a thick stroked circle rather than a filled annulus so the soft
   * shoulder gradient can be faked with three passes of decreasing alpha and
   * increasing width — a hard-edged ring would read as a painted line on a
   * lawn, which is the one thing the avenues were carefully not.
   */
  {
    const rr = ROAD.ring.r * road.ppm;
    const rHalf = ROAD.ring.half * road.ppm;
    for (const [w, alpha] of [
      [rHalf * 2.3, 0.14],
      [rHalf * 1.8, 0.34],
      [rHalf * 1.5, 0.8],
    ] as const) {
      ctx.strokeStyle = `rgba(214,192,150,${alpha})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Grit, so the promenade is the same material as the avenues.
    for (let i = 0; i < 2400; i++) {
      const a = (i * 2.39996) % (Math.PI * 2); // golden angle: no clumping
      const off = ((i * 313) % Math.round(rHalf * 1.9)) - rHalf * 0.95;
      ctx.fillStyle = i % 4 === 0 ? "rgba(140,118,84,0.35)" : "rgba(240,228,198,0.4)";
      const w = 2 + (i % 3);
      ctx.fillRect(S / 2 + Math.cos(a) * (rr + off), S / 2 + Math.sin(a) * (rr + off), w, w);
    }
  }

  // Stepping stones on top of the worn ground, laid out along each arm.
  const STONE_GAP = 84;
  for (const arm of ARMS) {
    for (let i = 1; i * STONE_GAP < arm.len - half * 0.4; i++) {
      // A stone is an ellipse laid across the road, so which axis is the long
      // one depends on which way the arm runs. The ±10 is the stones not being
      // laid in a straight line, which is most of what reads as "by hand".
      const horiz = arm.dx !== 0;
      const wobble = i % 2 ? 10 : -10;
      const cx = S / 2 + arm.dx * i * STONE_GAP + (horiz ? 0 : wobble);
      const cy = S / 2 + arm.dy * i * STONE_GAP + (horiz ? wobble : 0);
      {
      ctx.fillStyle = "rgba(60,48,32,0.18)"; // contact shadow under the stone
      ctx.beginPath();
      ctx.ellipse(cx + 3, cy + 3, horiz ? 24 : 17, horiz ? 17 : 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#cdb894";
      ctx.strokeStyle = "rgba(110,92,64,0.32)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(cx, cy, horiz ? 23 : 16, horiz ? 16 : 23, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Weathering on the stone face.
      ctx.fillStyle = "rgba(150,132,102,0.3)";
      for (let s = 0; s < 6; s++) {
        ctx.beginPath();
        ctx.arc(cx + ((s * 13) % 22) - 11, cy + ((s * 7) % 18) - 9, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      }
    }
  }

  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * The tiled grain: a tangent-space normal map of short grass strokes, laid
 * over the colour map at a few metres per repeat.
 *
 * This is the map doing the work at walking distance. The colour map cannot:
 * one texel of it is ten centimetres across, so it has no idea what a blade
 * of grass looks like. This one has ~40 repeats over the disc, so the same
 * canvas covers about 2.7 m and its strokes land at roughly blade scale.
 */
function lawnNormalTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  // Flat normal = (0.5, 0.5, 1) in tangent space.
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, S, S);

  // Each stroke is a two-sided ridge: one side tilted left, one right. Drawn
  // as a pair of offset lines rather than a gradient, because at this size a
  // gradient is three pixels wide and averages back to flat.
  const rand = mulberry32(90210);
  ctx.lineCap = "round";
  for (let i = 0; i < 1400; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.5; // mostly "up" in UV space
    const len = 7 + rand() * 16;
    const dx = Math.cos(a) * len;
    const dy = Math.sin(a) * len;
    // Left flank tilts -x, right flank tilts +x, perpendicular to the stroke.
    const px = -Math.sin(a) * 1.4;
    const py = Math.cos(a) * 1.4;
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "rgba(60,150,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(x - px, y - py);
    ctx.lineTo(x + dx - px, y + dy - py);
    ctx.stroke();
    ctx.strokeStyle = "rgba(196,150,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(x + px, y + py);
    ctx.lineTo(x + dx + px, y + dy + py);
    ctx.stroke();
  }
  // A few larger, softer undulations so the ground isn't billiard-flat either.
  for (let i = 0; i < 90; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 14 + rand() * 34;
    const g = ctx.createLinearGradient(x - r, y, x + r, y);
    g.addColorStop(0, "rgba(90,128,255,0.30)");
    g.addColorStop(0.5, "rgba(128,128,255,0)");
    g.addColorStop(1, "rgba(166,128,255,0.30)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 40);
  t.anisotropy = 8;
  return t;
}

/**
 * A tiled roughness map for the lawn. Grass is not uniformly matte — the
 * flatter, damper patches catch a sheen and the dry tufts don't, and that
 * variation is a surprising amount of what sells a surface as outdoors.
 */
function lawnRoughnessTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d8d8d8"; // roughness ~0.85 after the material's scalar
  ctx.fillRect(0, 0, S, S);
  const rand = mulberry32(5150);
  for (let i = 0; i < 260; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 6 + rand() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = rand() < 0.5 ? "255,255,255" : "150,150,150";
    g.addColorStop(0, `rgba(${v},0.5)`);
    g.addColorStop(1, `rgba(${v},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(26, 26);
  return t;
}

/**
 * The three maps that dress the island's grass cap.
 *
 * `capDiameter` is what ties the painted roads to the real ones: the colour map
 * covers the whole cap, so pixels-per-metre falls out of the cap's size, and
 * the road arms can then be drawn at the metre lengths `islandPlan` declares.
 */
export function lawnTextures(capDiameter: number): {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  return {
    map: lawnColorTexture({ ppm: 2048 / capDiameter }),
    normalMap: lawnNormalTexture(),
    roughnessMap: lawnRoughnessTexture(),
  };
}

// ------------------------------------------------------------------
// The blades
// ------------------------------------------------------------------

/**
 * One blade: a five-row tapered strip, one unit tall, curving away from the
 * root. Nine vertices, five triangles.
 *
 * The normals are deliberately wrong. `computeVertexNormals` gives each blade
 * a normal perpendicular to its own face, so half a field of randomly-yawed
 * blades faces away from the sun and goes black — a lawn full of dark specks.
 * Real grass scatters light through itself and reads as a soft mass, so the
 * normals here are bent most of the way toward straight up, which is the
 * cheap version of that and the standard trick.
 */
function bladeGeometry(): THREE.BufferGeometry {
  const rows = [0, 0.3, 0.58, 0.82, 1];
  const halfW = [0.026, 0.023, 0.018, 0.011, 0];
  const bend = [0, 0.02, 0.09, 0.22, 0.4];

  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const root = new THREE.Color("#2c5d26");
  const tip = new THREE.Color("#9ada63");
  const c = new THREE.Color();

  for (let i = 0; i < rows.length; i++) {
    const y = rows[i];
    c.lerpColors(root, tip, Math.pow(y, 0.75));
    if (i === rows.length - 1) {
      pos.push(0, y, bend[i]);
      col.push(c.r, c.g, c.b);
    } else {
      pos.push(-halfW[i], y, bend[i], halfW[i], y, bend[i]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < rows.length - 2; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  idx.push(6, 7, 8);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  {
    const n = geo.attributes.normal as THREE.BufferAttribute;
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) {
      v.fromBufferAttribute(n, i).lerp(up, 0.72).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
    n.needsUpdate = true;
  }
  return geo;
}

export interface GrassField {
  mesh: THREE.InstancedMesh;
  /** Advance the wind. `now` is milliseconds. */
  update(now: number): void;
  dispose(): void;
}

/**
 * Scatter a field of grass over a disc.
 *
 * Blades are placed in tufts: a clump centre is drawn, tested against the
 * caller's exclusion predicate once, and then five to nine blades are jittered
 * around it. Testing once per clump rather than once per blade is what makes
 * the rejection sampling affordable, and the tufting is what makes the result
 * look like ground cover instead of a regular stipple.
 *
 * `rimAt` lets the field follow the island's actual wobbly silhouette, so the
 * outermost blades hang over the lip rather than stopping at a perfect circle
 * two metres short of the edge.
 */
export function buildGrassField(opts: {
  radius: number;
  /** Scale of the rim wobble at a given angle, as a multiplier on radius. */
  rimAt?: (angle: number) => number;
  /**
   * How much grass grows at a point, 0..1. Return 0 for a hard surface — the
   * plaza pad, a shop's floor — and a fraction where the grass should thin
   * rather than stop. Paths matter here: real ground cover does not end at a
   * line, it gets patchier as the ground gets more walked on, and a lawn that
   * ends dead straight along a footpath is the thing that gives away that it
   * was placed by a rule.
   */
  density: (x: number, z: number) => number;
  /** Target blade count. Clamped to what the sampler can actually place. */
  count: number;
  seed?: number;
  /** Ground height at a point, if the lawn is not flat. Defaults to 0. */
  heightAt?: (x: number, z: number) => number;
}): GrassField {
  const { radius, density, count, seed = 1337, rimAt, heightAt } = opts;
  const rand = mulberry32(seed);

  const geo = bladeGeometry();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
    // Grass is thin enough to be lit from behind. A little emissive keyed off
    // the vertex colour is a poor man's translucency, and it is what keeps the
    // field from going flat-dark on the side of the island facing away.
    emissive: new THREE.Color("#12300f"),
    emissiveIntensity: 1,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
    uStrength: { value: 0.11 },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uStrength = uniforms.uStrength;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         uniform vec2 uWindDir;
         uniform float uStrength;`,
      )
      /*
       * The sway is applied AFTER the instance matrix and before the model-view
       * matrix — i.e. in the island's own frame, which has no rotation, so it
       * is effectively world space. Doing it in object space instead would
       * rotate each blade's sway by its own random yaw, and a field where every
       * blade leans a different way is not wind, it is noise.
       *
       * This is `project_vertex` verbatim with one block inserted; if three's
       * chunk ever changes, this replace is where it will show up.
       */
      .replace(
        "#include <project_vertex>",
        `vec4 mvPosition = vec4( transformed, 1.0 );
         #ifdef USE_BATCHING
           mvPosition = batchingMatrix * mvPosition;
         #endif
         #ifdef USE_INSTANCING
           mvPosition = instanceMatrix * mvPosition;
         #endif
         {
           // position.y is 0 at the root and 1 at the tip, before instance
           // scaling — so the bend is quadratic in height and the root never
           // detaches from the ground.
           float h = clamp( position.y, 0.0, 1.0 );
           vec3 io = mvPosition.xyz;
           float phase = io.x * 0.42 + io.z * 0.33;
           float gust = sin( uTime * 0.9 + phase * 0.18 ) * 0.5 + 0.75;
           float s = sin( uTime * 1.7 + phase ) + 0.4 * sin( uTime * 4.1 + phase * 2.3 );
           mvPosition.xz += uWindDir * ( s * gust * h * h * uStrength );
         }
         mvPosition = modelViewMatrix * mvPosition;
         gl_Position = projectionMatrix * mvPosition;`,
      );
  };

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Culled, and deliberately so: this is a quarter of a million triangles that
  // exists 300 m from the city plaza, and leaving it uncullable meant paying
  // for the island's lawn while standing in a street that cannot see it.
  // `computeBoundingSphere` below fits it once, after the instances are placed.
  mesh.frustumCulled = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  let placed = 0;
  let guard = 0;
  const GUARD_MAX = count * 12;
  while (placed < count && guard++ < GUARD_MAX) {
    // Clump centre, area-uniform over the disc.
    const a = rand() * Math.PI * 2;
    const rimScale = rimAt ? rimAt(a) : 1;
    const rMax = radius * rimScale;
    const cr = Math.sqrt(rand()) * rMax;
    const cx = Math.cos(a) * cr;
    const cz = Math.sin(a) * cr;
    const d = density(cx, cz);
    if (d <= 0 || rand() > d) continue;

    // Tuft size and character. A patch that is all one height reads as
    // astroturf, so the clump carries its own height and hue bias and the
    // blades vary around it.
    //
    // The height distribution is deliberately skewed short (the 1.7 exponent):
    // most of a lawn is stubble with the occasional taller tuft going to seed,
    // and an even spread of heights gives you a wheat field instead.
    //
    // Thinner ground also means *shorter* ground: grass at the edge of a path
    // is trodden and stunted, not full-height and simply rarer. Scaling both
    // the height and the blades-per-tuft by the density is what turns a
    // boundary into a verge.
    const clumpH = (0.1 + Math.pow(rand(), 1.7) * 0.42) * (0.55 + d * 0.45);
    const clumpHue = rand();
    const spread = 0.16 + rand() * 0.34;
    const n = 3 + Math.floor(rand() * 6 + d * 6);

    for (let i = 0; i < n && placed < count; i++) {
      const ba = rand() * Math.PI * 2;
      const br = Math.sqrt(rand()) * spread;
      const bx = cx + Math.cos(ba) * br;
      const bz = cz + Math.sin(ba) * br;
      const h = clumpH * (0.62 + rand() * 0.72);
      const w = 0.75 + rand() * 0.7;

      euler.set(
        (rand() - 0.5) * 0.34, // lean fore/aft
        rand() * Math.PI * 2, // yaw
        (rand() - 0.5) * 0.34, // lean left/right
      );
      q.setFromEuler(euler);
      pos.set(bx, heightAt ? heightAt(bx, bz) : 0, bz);
      scale.set(w, h, w);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(placed, m);

      // Per-blade tint. Warm yellow-green through to a cool deep green, biased
      // by the clump so neighbours agree, plus a little dry straw in the mix.
      const k = THREE.MathUtils.clamp(clumpHue * 0.7 + rand() * 0.4, 0, 1);
      tint.setHSL(
        0.22 + k * 0.075, // 79° → 106°: straw-yellow to true green
        0.42 + rand() * 0.22,
        0.4 + (1 - k) * 0.16 + rand() * 0.08,
      );
      mesh.setColorAt(placed, tint);
      placed++;
    }
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();

  return {
    mesh,
    update(now: number) {
      uniforms.uTime.value = now * 0.001;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}

// ------------------------------------------------------------------
// Ground cover: clover, daisies, dandelion heads
// ------------------------------------------------------------------

/**
 * The small stuff between the blades. Cheap — one instanced quad mesh, alpha
 * tested against a four-petal sprite — and it is what makes the ground read as
 * a meadow rather than a mown pitch when you stand in it.
 */
export function buildGroundCover(opts: {
  radius: number;
  rimAt?: (angle: number) => number;
  /** Same 0..1 predicate the grass field uses. */
  density: (x: number, z: number) => number;
  count: number;
  seed?: number;
}): { mesh: THREE.InstancedMesh; dispose(): void } {
  const { radius, density, count, seed = 4242, rimAt } = opts;
  const rand = mulberry32(seed);

  // A little four-petal bloom, drawn once and used for every flower; the
  // per-instance colour does the variety.
  const S = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  for (let p = 0; p < 5; p++) {
    const a = (p / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(S / 2 + Math.cos(a) * 13, S / 2 + Math.sin(a) * 13, 11, 8, a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#ffe9a8";
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 8, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const geo = new THREE.PlaneGeometry(0.16, 0.16);
  geo.rotateX(-Math.PI / 2); // lie flat on the lawn, seen from above
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.45,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();
  const palette = ["#ffffff", "#fff2b8", "#ffd7e6", "#e8dcff", "#fff8e0"];

  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 20) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * radius * (rimAt ? rimAt(a) : 1);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const d = density(x, z);
    if (d <= 0 || rand() > d) continue;
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, 0));
    pos.set(x, 0.035 + rand() * 0.06, z);
    const s = 0.7 + rand() * 0.8;
    scale.set(s, s, s);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(placed, m);
    tint.set(palette[Math.floor(rand() * palette.length)]);
    mesh.setColorAt(placed, tint);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();

  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
      mesh.dispose();
    },
  };
}
