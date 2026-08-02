/**
 * Vibe Kart — the bakers.
 *
 * One function per surface in the game. Each returns a `Baked` bundle of raw
 * channels (albedo raster, height field, roughness/metalness/AO fields, an
 * optional emissive raster) and the library upstairs turns those into three
 * shared GPU textures: albedo, tangent-space normal, and a packed ORM.
 *
 * The bar every one of these has to clear is: convincing at two metres AND at
 * a grazing angle, because a kart camera spends its whole life at a grazing
 * angle. That mostly means three things —
 *
 *   · the *height* field has to carry real structure, since at 8° of incidence
 *     the normal map is doing nearly all of the visible work;
 *   · roughness has to vary, because a constant-roughness surface reads as
 *     plastic the instant a specular highlight crosses it;
 *   · wear has to follow geometry. Paint chips off convex edges, grime settles
 *     in concave ones. Both masks come from the same height field, which is
 *     why every material builds height first and colour second.
 */
import {
  AlbedoBuffer,
  aoFromHeight,
  blurField,
  cavityField,
  clamp01,
  edgeWearField,
  fbmField,
  fieldOf,
  hexRgb,
  hsv,
  lerp,
  makeRng,
  makeSurface,
  normalFromHeight,
  rasterToBuffer,
  ridgedField,
  seamField,
  smoothstep,
  stampWrapped,
  surfaceToRaster,
  worleyField,
  type Field,
  type Raster,
  type Rng,
} from "./noise";

export type MaterialName =
  | "asphalt"
  | "asphaltWorn"
  | "kerb"
  | "roadLine"
  | "startLine"
  | "grass"
  | "dirt"
  | "sand"
  | "water"
  | "ice"
  | "wood"
  | "metal"
  | "grate"
  | "concrete"
  | "brick"
  | "stone"
  | "rubber"
  | "chrome"
  | "carPaint"
  | "glass"
  | "plastic"
  | "foliage"
  | "bark"
  | "cloth"
  | "banner"
  | "neon"
  | "antigrav"
  | "boostPad"
  | "crowd";

export interface BakeInput {
  /** Texture side in pixels, already scaled for quality. */
  size: number;
  /** Skip the AO pass on low-end machines — it is the most expensive one. */
  ao: boolean;
  rng: Rng;
}

export interface Baked {
  /** RGBA sRGB, row 0 = top. Alpha drives cutouts. */
  albedo?: Raster;
  /** 0..1 height, source of the normal map. */
  height?: Field;
  /** Multiplier into the Sobel — tune per material, not globally. */
  normalStrength?: number;
  roughness?: Field | number;
  metalness?: Field | number;
  ao?: Field;
  /** RGB sRGB emission, row 0 = top. */
  emissive?: Raster;
}

// ---------------------------------------------------------------------------
// Local pattern helpers
// ---------------------------------------------------------------------------

/** Scatter soft round dots — pebbles, flowers, rivets, nail heads, flakes. */
function dotField(
  size: number,
  o: { count: number; radius: number; radiusVar?: number; seed: number | string; hardness?: number },
): Field {
  const out = fieldOf(size);
  const rng = makeRng(o.seed);
  const rv = o.radiusVar ?? 0.5;
  const hardness = o.hardness ?? 0.5;
  for (let d = 0; d < o.count; d++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = o.radius * (1 - rv + rng() * rv * 2);
    const span = Math.ceil(r) + 1;
    for (let dy = -span; dy <= span; dy++) {
      const y = ((Math.floor(cy) + dy) % size + size) % size;
      const row = y * size;
      for (let dx = -span; dx <= span; dx++) {
        const fx = dx + Math.floor(cx) - cx;
        const fy = dy + Math.floor(cy) - cy;
        const dist = Math.sqrt(fx * fx + fy * fy) / r;
        if (dist >= 1) continue;
        const v = Math.pow(1 - dist, 1 + hardness * 3);
        const x = ((Math.floor(cx) + dx) % size + size) % size;
        if (v > out[row + x]) out[row + x] = v;
      }
    }
  }
  return out;
}

/** Hard-edged bands with a soft shoulder — planks, chevrons, kerb teeth. */
function stripeField(
  size: number,
  o: { count: number; axis?: "u" | "v"; duty?: number; soft?: number; skew?: number; phase?: number },
): Field {
  const out = fieldOf(size);
  const axis = o.axis ?? "v";
  const duty = o.duty ?? 0.5;
  const soft = o.soft ?? 0.02;
  const skew = o.skew ?? 0;
  const phase = o.phase ?? 0;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const a = axis === "v" ? v + u * skew : u + v * skew;
      const f = (a * o.count + phase) % 1;
      const w = f < 0 ? f + 1 : f;
      // Two shoulders so the band is symmetric and tiles at either end.
      const on = smoothstep(0, soft, w) * (1 - smoothstep(duty - soft, duty, w));
      out[y * size + x] = on;
    }
  }
  return out;
}

/** Checkerboard, used for the start line and the finish banner. */
function checkerField(size: number, cols: number, rows: number, soft = 0.6): Field {
  const out = fieldOf(size);
  const px = size / cols;
  const py = size / rows;
  for (let y = 0; y < size; y++) {
    const jy = Math.floor(y / py);
    const ey = Math.min(y % py, py - 1 - (y % py));
    for (let x = 0; x < size; x++) {
      const jx = Math.floor(x / px);
      const ex = Math.min(x % px, px - 1 - (x % px));
      const on = (jx + jy) & 1 ? 1 : 0;
      // Soften only the very last texel so the checker stays crisp under
      // anisotropic filtering instead of crawling.
      const edge = clamp01(Math.min(ex, ey) / soft);
      out[y * size + x] = on ? edge : 0;
    }
  }
  return out;
}

/**
 * Break up a seam/crack mask with noise.
 *
 * `seamField` draws a mathematically smooth path, and a smooth path reads as a
 * pencil line rather than a tar joint the moment you look at it. Modulating the
 * mask by a high-frequency field — and biting chunks out of it where the noise
 * is low — turns the same curve into something that looks poured.
 */
function roughen(seam: Field, noise: Field, bite = 0.45): Field {
  for (let i = 0; i < seam.length; i++) {
    const n = noise[i];
    seam[i] = clamp01(seam[i] * (1 - bite + n * bite * 2) - (1 - n) * bite * 0.5);
  }
  return seam;
}

/** Cell-boundary network from a Worley pair — cracks, crazing, dried mud. */
function crackNetwork(f1: Field, f2: Field, width: number): Field {
  const out = new Float32Array(f1.length);
  for (let i = 0; i < f1.length; i++) {
    out[i] = 1 - clamp01((f2[i] - f1[i]) / width);
  }
  return out;
}

/** Convenience: default AO pass, or flat white when quality says skip it. */
function ao(height: Field, i: BakeInput, strength = 1): Field | undefined {
  return i.ao ? aoFromHeight(height, i.size, { strength }) : undefined;
}

// ---------------------------------------------------------------------------
// Road surfaces
// ---------------------------------------------------------------------------

/**
 * Tarmac. Two scales of aggregate under a bitumen binder, a couple of hot-tar
 * repair seams, damp patches where the camber holds water, and — the detail
 * that sells it at speed — longitudinal polish streaks where tyres have burnished
 * the stone flush with the binder. Those streaks live almost entirely in the
 * roughness map: they are invisible head-on and blaze under the sun at 8°,
 * which is exactly how a real racing line behaves.
 */
function bakeAsphalt(i: BakeInput, worn: boolean): Baked {
  const { size } = i;
  const key = worn ? "asphaltWorn" : "asphalt";
  // Scale discipline: the tile covers 4 m (see SPEC), so 96 cells puts the
  // coarse chips at ~4 cm and the fine ones at ~3 cm. Anything chunkier and
  // tarmac turns into cobblestone — which is precisely what a first pass at
  // this material always does.
  const coarse = worleyField(size, { cells: 96, jitter: 0.95, seed: `${key}:coarse` });
  const fine = worleyField(size, { cells: 140, jitter: 1, seed: `${key}:fine` });
  const grit = fbmField(size, { period: 110, octaves: 2, gain: 0.5, seed: `${key}:grit` });
  const macro = fbmField(size, { period: 3, octaves: 4, gain: 0.6, seed: `${key}:macro` });
  const damp = fbmField(size, { period: 2, octaves: 3, gain: 0.55, seed: `${key}:damp` });
  // Stretched noise: two lattice cells across the tile, sixty down it — bands
  // that run with the traffic.
  const polish = fbmField(size, { period: [2, 30], octaves: 3, gain: 0.55, seed: `${key}:polish` });
  // Repair joints run nearly straight — a wandering one reads as a doodle —
  // and their edges are chewed up by the aggregate they were poured over.
  const seams = roughen(
    seamField(size, { count: worn ? 2 : 1, axis: "u", width: 0.009, wobble: 0.012, seed: `${key}:seam`, broken: 0.35 }),
    grit,
    0.55,
  );
  const cracks = worn
    ? crackNetwork(fine.f1, fine.f2, 0.16)
    : null;

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);

  const baseA = hexRgb(worn ? 0x4a4d55 : 0x32353e);
  const baseB = hexRgb(worn ? 0x5f6269 : 0x3f434d);
  const stoneWarm = hexRgb(0x8b8378);
  const stoneCool = hexRgb(0x7d838c);
  const tar = hexRgb(0x24262c);

  for (let p = 0; p < n; p++) {
    // Rounded chips: 1 at a cell centre, 0 at the boundary.
    const s1 = Math.pow(1 - coarse.f1[p], 1.7);
    const s2 = Math.pow(1 - fine.f1[p], 2.1);
    const g = grit[p];
    let h = s1 * 0.5 + s2 * 0.34 + g * 0.16;
    h -= seams[p] * 0.55;
    if (cracks) h -= cracks[p] * 0.3;
    height[p] = clamp01(h);

    // Colour: binder tone drifts on the macro scale, chips read a shade
    // lighter and take a warm or cool cast depending on the cell.
    const m = macro[p];
    let r = lerp(baseA.r, baseB.r, m);
    let gg = lerp(baseA.g, baseB.g, m);
    let b = lerp(baseA.b, baseB.b, m);

    // Exposed aggregate. Tarmac is *stone* held in bitumen, and if the chips
    // are not individually legible the surface collapses into grey felt — the
    // single most common failure of a procedural road.
    const exposure = clamp01((s1 - 0.28) * 2.6) * (worn ? 1 : 0.85);
    const warm = coarse.id[p];
    const value = 0.84 + fine.id[p] * 0.34;
    const sr = lerp(stoneCool.r, stoneWarm.r, warm) * value;
    const sg = lerp(stoneCool.g, stoneWarm.g, warm) * value;
    const sb = lerp(stoneCool.b, stoneWarm.b, warm) * value;
    // Capped short of 1: the chips are *drowned* in bitumen, not laid on top of
    // it, so even the proudest stone keeps a film of binder over it.
    const chipT = clamp01(exposure * (0.45 + 0.75 * s2)) * 0.7;
    r = lerp(r, sr, chipT);
    gg = lerp(gg, sg, chipT);
    b = lerp(b, sb, chipT);

    // Grain, then the tar seams painted over everything.
    const jit = (g - 0.5) * 0.13;
    r += jit;
    gg += jit;
    b += jit;
    const sm = seams[p] * 0.7;
    r = lerp(r, tar.r, sm);
    gg = lerp(gg, tar.g, sm);
    b = lerp(b, tar.b, sm);

    // Damp shadow: darker and very slightly blue, only in the low patches.
    const wet = clamp01((damp[p] - 0.62) * 3.4) * (1 - h * 0.5);
    r *= 1 - wet * 0.3;
    gg *= 1 - wet * 0.27;
    b *= 1 - wet * 0.19;

    // Polish: burnished stone, darkened by decades of rubber.
    const pol = clamp01((polish[p] - 0.5) * 2.6);
    const rubberT = pol * (worn ? 0.16 : 0.26);
    r = lerp(r, 0.13, rubberT);
    gg = lerp(gg, 0.13, rubberT);
    b = lerp(b, 0.14, rubberT);

    if (cracks) {
      const c = cracks[p];
      r *= 1 - c * 0.45;
      gg *= 1 - c * 0.45;
      b *= 1 - c * 0.42;
    }

    buf.r[p] = r;
    buf.g[p] = gg;
    buf.b[p] = b;

    // Roughness. Fresh binder is matte, exposed stone rougher still, tar and
    // polish glossy, standing damp glossiest.
    let ro = worn ? 0.9 : 0.84;
    ro += exposure * 0.06;
    ro -= pol * 0.4;
    ro = lerp(ro, 0.33, sm);
    ro = lerp(ro, 0.22, wet);
    rough[p] = clamp01(ro + (g - 0.5) * 0.06);
  }

  return {
    albedo: buf.toRaster(),
    height,
    // Deliberately gentle. Aggregate is a few millimetres proud of the binder,
    // not a few centimetres; a strong normal here is the difference between
    // "tarmac" and "riverbed" the moment the camera drops to kart height.
    normalStrength: worn ? 0.4 : 0.28,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.9),
  };
}

/**
 * Kerb. Red and white saw-tooth teeth, each one a chamfered block proud of the
 * apron, with the paint chipped off the leading corners where wheels clout it
 * and grime packed into the joints between teeth. The skew is what makes it a
 * saw-tooth rather than a zebra crossing: real kerbs are laid at an angle so a
 * car crossing them gets a rising rattle rather than a single bang.
 */
function bakeKerb(i: BakeInput): Baked {
  const { size } = i;
  const teeth = stripeField(size, { count: 4, axis: "v", duty: 0.5, soft: 0.012, skew: 0.34 });
  const joint = stripeField(size, { count: 4, axis: "v", duty: 0.06, soft: 0.02, skew: 0.34, phase: -0.03 });
  const concrete = fbmField(size, { period: 26, octaves: 3, gain: 0.55, seed: "kerb:concrete" });
  const pores = worleyField(size, { cells: 60, jitter: 1, seed: "kerb:pores" });
  const scuff = fbmField(size, { period: [3, 40], octaves: 3, gain: 0.55, seed: "kerb:scuff" });
  // Rubber smears are wide, faint and ragged — a crisp black line would read
  // as ink on the kerb rather than a hundred karts clipping the apex.
  const rubberMarks = roughen(
    seamField(size, { count: 4, axis: "u", width: 0.035, wobble: 0.03, seed: "kerb:rubber", broken: 0.75 }),
    scuff,
    0.7,
  );

  const n = size * size;
  const height = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    // Each tooth is a slab: flat top, chamfer at the edge, deep joint between.
    const slab = 0.62 + teeth[p] * 0.3;
    height[p] = clamp01(slab - joint[p] * 0.55 + (concrete[p] - 0.5) * 0.05 + (1 - pores.f1[p]) * 0.04);
  }

  const wear = edgeWearField(height, size, Math.max(2, size / 96), 0.55);
  const grime = cavityField(height, size, Math.max(3, size / 64), 0.42);

  const buf = new AlbedoBuffer(size);
  const rough = new Float32Array(n);
  const red = hexRgb(0xe23b3b);
  const redDark = hexRgb(0xa32a2a);
  const white = hexRgb(0xf6f4ef);
  const bare = hexRgb(0x9c9689);
  const dirt = hexRgb(0x4a4238);

  for (let p = 0; p < n; p++) {
    const isRed = teeth[p] > 0.5;
    const shade = concrete[p];
    let c = isRed
      ? { r: lerp(redDark.r, red.r, shade), g: lerp(redDark.g, red.g, shade), b: lerp(redDark.b, red.b, shade) }
      : { r: lerp(0.86, white.r, shade), g: lerp(0.85, white.g, shade), b: lerp(0.82, white.b, shade) };

    // Chipped paint: the concrete underneath, which is warm and matte.
    const chip = clamp01(wear[p] * (0.55 + scuff[p] * 0.7) - 0.12);
    c = {
      r: lerp(c.r, bare.r, chip),
      g: lerp(c.g, bare.g, chip),
      b: lerp(c.b, bare.b, chip),
    };
    // Grime in the joints.
    const gr = grime[p] * 0.75;
    c = { r: lerp(c.r, dirt.r, gr), g: lerp(c.g, dirt.g, gr), b: lerp(c.b, dirt.b, gr) };
    // Black rubber smears from a hundred karts cutting the apex.
    const rub = rubberMarks[p] * 0.34;
    c = { r: lerp(c.r, 0.12, rub), g: lerp(c.g, 0.12, rub), b: lerp(c.b, 0.13, rub) };

    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    // Fresh road paint is semi-gloss; bare concrete and grime are not.
    rough[p] = clamp01(lerp(0.36, 0.88, Math.max(chip, gr * 0.8)) + (pores.f1[p] - 0.5) * 0.08 + rub * 0.1);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.35,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.2),
  };
}

/**
 * Lane paint. Full-tile white thermoplastic with a bevelled edge — the strip
 * mesh that uses it is narrow, so V runs across the paint and the raised
 * shoulders at v=0 and v=1 give it real thickness against the tarmac.
 */
function bakeRoadLine(i: BakeInput): Baked {
  const { size } = i;
  const grain = fbmField(size, { period: 40, octaves: 3, gain: 0.55, seed: "line:grain" });
  const wear = fbmField(size, { period: [4, 22], octaves: 4, gain: 0.6, seed: "line:wear" });
  const beads = dotField(size, { count: Math.round(size * 1.6), radius: size / 180, seed: "line:beads", hardness: 0.9 });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const paint = hexRgb(0xf4f2ea);
  const road = hexRgb(0x3a3e48);

  for (let p = 0; p < n; p++) {
    const y = Math.floor(p / size) / size;
    // Bevelled shoulders: the paint is laid ~4 mm proud and feathers at the edge.
    const edge = smoothstep(0, 0.1, y) * (1 - smoothstep(0.9, 1, y));
    const worn = clamp01((wear[p] - 0.42) * 1.9);
    const cover = clamp01(edge * (0.55 + worn * 0.8));
    height[p] = cover * 0.7 + beads[p] * 0.3 + (grain[p] - 0.5) * 0.08;

    const t = cover;
    buf.r[p] = lerp(road.r, paint.r, t) * (0.9 + grain[p] * 0.2);
    buf.g[p] = lerp(road.g, paint.g, t) * (0.9 + grain[p] * 0.2);
    buf.b[p] = lerp(road.b, paint.b, t) * (0.9 + grain[p] * 0.2);
    // Glass retroreflective beads: little glossy points in an otherwise
    // chalky surface. They are the reason road paint sparkles in headlights.
    rough[p] = clamp01(lerp(0.86, 0.42, t) - beads[p] * 0.3);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.9,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.8),
  };
}

/**
 * Start/finish line: a proper laid checker with paint thickness, tyre rubber
 * over the top and grime at the paint edges where water sits.
 */
function bakeStartLine(i: BakeInput): Baked {
  const { size } = i;
  const check = checkerField(size, 8, 2, Math.max(1, size / 220));
  const grain = fbmField(size, { period: 34, octaves: 3, gain: 0.55, seed: "start:grain" });
  const wear = fbmField(size, { period: [6, 6], octaves: 4, gain: 0.6, seed: "start:wear" });
  const rubber = roughen(
    seamField(size, { count: 5, axis: "v", width: 0.045, wobble: 0.015, seed: "start:rubber", broken: 0.6 }),
    wear,
    0.7,
  );
  const beads = dotField(size, { count: Math.round(size * 2), radius: size / 200, seed: "start:beads", hardness: 0.9 });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const white = hexRgb(0xf2f0e8);
  const black = hexRgb(0x1b1c20);

  for (let p = 0; p < n; p++) {
    const worn = clamp01((wear[p] - 0.35) * 2);
    // Both colours are paint, so both are proud of the tarmac; only the white
    // squares are visibly thick because they are laid last.
    const paint = clamp01(0.55 + check[p] * 0.45) * (0.7 + worn * 0.5);
    height[p] = clamp01(paint * 0.55 + beads[p] * 0.25 + (grain[p] - 0.5) * 0.1);

    const t = check[p] * clamp01(0.66 + worn * 0.7);
    let r = lerp(black.r, white.r, t);
    let g = lerp(black.g, white.g, t);
    let b = lerp(black.b, white.b, t);
    const k = 0.9 + grain[p] * 0.22;
    r *= k;
    g *= k;
    b *= k;
    const rub = rubber[p] * 0.42;
    r = lerp(r, 0.11, rub);
    g = lerp(g, 0.11, rub);
    b = lerp(b, 0.12, rub);
    buf.r[p] = r;
    buf.g[p] = g;
    buf.b[p] = b;
    rough[p] = clamp01(0.5 - beads[p] * 0.28 + rub * 0.35 + (1 - paint) * 0.3);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.85,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.8),
  };
}

/**
 * Boost pad. A dark machined plate with a raised surround, and a flight of
 * chevrons that exists *only* in the emissive raster. That split is
 * deliberate: the library scrolls the emissive map along V at runtime, so the
 * arrows fly forward over a plate that stays perfectly still. Bake the arrows
 * into the albedo as well and the paint would slide off its own glow.
 */
function bakeBoostPad(i: BakeInput): Baked {
  const { size } = i;
  const chevron = chevronField(size, 4, 0.34, 0.05);
  const plate = fbmField(size, { period: 18, octaves: 3, gain: 0.5, seed: "boost:plate" });
  const brush = fbmField(size, { period: [4, 90], octaves: 2, gain: 0.5, seed: "boost:brush" });
  const scuff = fbmField(size, { period: [3, 20], octaves: 3, gain: 0.6, seed: "boost:scuff" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const glow = new AlbedoBuffer(size);
  const base = hexRgb(0x161c2a);
  const rim = hexRgb(0x3d4a66);
  const hot = hexRgb(0xffb02e);
  const hotter = hexRgb(0xfff3c8);

  for (let p = 0; p < n; p++) {
    const y = Math.floor(p / size) / size;
    const x = (p % size) / size;
    // A machined border around the pad, 5 % in from each edge.
    const border =
      1 -
      smoothstep(0.03, 0.06, x) * (1 - smoothstep(0.94, 0.97, x)) *
        smoothstep(0.03, 0.06, y) * (1 - smoothstep(0.94, 0.97, y));
    height[p] = clamp01(0.5 + border * 0.3 + (plate[p] - 0.5) * 0.14 + (brush[p] - 0.5) * 0.06);

    const k = 0.88 + brush[p] * 0.24;
    buf.r[p] = lerp(base.r, rim.r, border) * k;
    buf.g[p] = lerp(base.g, rim.g, border) * k;
    buf.b[p] = lerp(base.b, rim.b, border) * k;

    // A hot white core inside a warmer shoulder: emissive art that is one flat
    // colour blooms into a featureless blob, and two tones does not.
    const c = chevron[p];
    const core = clamp01((c - 0.4) * 2.4);
    // No border term here: the emissive map scrolls, and anything keyed to the
    // tile edge would travel with it.
    const heat = c * (0.75 + scuff[p] * 0.45);
    glow.r[p] = lerp(hot.r, hotter.r, core * 0.7) * heat;
    glow.g[p] = lerp(hot.g, hotter.g, core * 0.7) * heat;
    glow.b[p] = lerp(hot.b, hotter.b, core * 0.7) * heat;

    rough[p] = clamp01(0.5 + border * 0.12 - brush[p] * 0.14);
    metal[p] = lerp(0.55, 0.75, border);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.1,
    roughness: rough,
    metalness: metal,
    ao: ao(height, i, 0.9),
    emissive: glow.toRaster(),
  };
}

/** A flight of chevrons pointing up the tile, used by the boost pad. */
function chevronField(size: number, count: number, duty: number, soft: number): Field {
  const out = fieldOf(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Fold across the centre line so both halves lean into the middle.
      const fold = Math.abs(u - 0.5) * 2;
      const a = (v + fold * 0.28) * count;
      const f = a - Math.floor(a);
      const on = smoothstep(0, soft, f) * (1 - smoothstep(duty - soft, duty, f));
      // Taper the chevron tips so they do not run off the edge of the pad.
      out[y * size + x] = on * (1 - smoothstep(0.72, 0.98, fold));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Off-road
// ---------------------------------------------------------------------------

/**
 * Grass. Clumps first — real turf grows in tufts with bare, darker soil
 * between them — then blades inside the clumps, then colour by height so the
 * roots are deep and the tips are bright. A scatter of tiny daisies costs
 * nothing and is the difference between "green noise" and a lawn.
 */
function bakeGrass(i: BakeInput): Baked {
  const { size } = i;
  const clump = worleyField(size, { cells: 15, jitter: 0.95, seed: "grass:clump" });
  // Two ridged fields at right angles: each one is a sheaf of thin lines, and
  // crossing them gives blades leaning in two directions instead of a carpet of
  // dots. The frequencies are high on purpose — turf at 2 m is *fine*, and an
  // under-frequency lawn reads as moss.
  const blades = ridgedField(size, { period: [116, 62], octaves: 3, gain: 0.5, seed: "grass:blades" });
  const blades2 = ridgedField(size, { period: [58, 128], octaves: 2, gain: 0.5, seed: "grass:blades2" });
  const macro = fbmField(size, { period: 2, octaves: 4, gain: 0.6, seed: "grass:macro" });
  const dry = fbmField(size, { period: 5, octaves: 3, gain: 0.55, seed: "grass:dry" });
  const flowers = dotField(size, { count: Math.round(size / 12), radius: size / 190, seed: "grass:flowers", hardness: 0.8 });
  const soil = fbmField(size, { period: 60, octaves: 2, gain: 0.5, seed: "grass:soil" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);

  const root = hexRgb(0x25541f);
  const mid = hexRgb(0x479a34);
  const tip = hexRgb(0x82ce4b);
  const straw = hexRgb(0xb9b055);
  const earth = hexRgb(0x4b3b28);

  for (let p = 0; p < n; p++) {
    const tuft = 1 - clump.f1[p];
    const bl = blades[p] * 0.58 + blades2[p] * 0.42;
    // Turf is mostly closed; only the gaps between tufts show soil. The clump
    // term biases density and colour, it does not carve holes — carving holes
    // is what turns a lawn into bubble wrap.
    const cover = clamp01(tuft * 1.7 - 0.32);
    const h = clamp01(bl * (0.45 + cover * 0.55) + tuft * 0.1 + soil[p] * 0.08);
    height[p] = h;

    // Per-tuft hue: some clumps are bluish, some yellowish. Uniform green is
    // the single most obvious tell of a procedural lawn.
    const tuftHue = clump.id[p];
    // Compressed towards the mid tone: full root-to-tip contrast on every blade
    // makes a lawn sparkle like television static once it is a few metres away.
    const shade = clamp01(0.22 + (bl * 0.92 + tuft * 0.14) * 0.6);
    let c = shade < 0.5
      ? { r: lerp(root.r, mid.r, shade * 2), g: lerp(root.g, mid.g, shade * 2), b: lerp(root.b, mid.b, shade * 2) }
      : { r: lerp(mid.r, tip.r, (shade - 0.5) * 2), g: lerp(mid.g, tip.g, (shade - 0.5) * 2), b: lerp(mid.b, tip.b, (shade - 0.5) * 2) };

    const hueShift = (tuftHue - 0.5) * 0.16;
    c.r += hueShift * 0.9;
    c.g += hueShift * 0.25;
    c.b -= hueShift * 0.55;

    // Sun-bleached patches on the macro scale.
    const bleach = clamp01((dry[p] - 0.6) * 2.6) * clamp01(macro[p] * 1.2);
    c = { r: lerp(c.r, straw.r, bleach * 0.7), g: lerp(c.g, straw.g, bleach * 0.7), b: lerp(c.b, straw.b, bleach * 0.7) };

    // Bare earth showing through between the tufts.
    const bare = clamp01((1 - cover) * (1 - bl) * 1.3 - 0.25);
    c = { r: lerp(c.r, earth.r, bare * 0.75), g: lerp(c.g, earth.g, bare * 0.75), b: lerp(c.b, earth.b, bare * 0.75) };

    // Broad tonal drift so a football pitch of this does not read as carpet.
    const m = 0.86 + macro[p] * 0.28;
    c.r *= m;
    c.g *= m;
    c.b *= m;

    const fl = flowers[p];
    if (fl > 0.05) {
      const petal = clamp01(fl * 1.6);
      c.r = lerp(c.r, 0.97, petal);
      c.g = lerp(c.g, 0.95, petal);
      c.b = lerp(c.b, 0.8, petal);
    }

    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    // Grass is matte but the blade tips catch a waxy sheen, which is what
    // makes a lawn shimmer when the sun is low.
    rough[p] = clamp01(0.92 - bl * 0.22 + bare * 0.05);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.42,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.1),
  };
}

/** Packed dirt: pebbles, wheel ruts, dried mud crazing, dust film. */
function bakeDirt(i: BakeInput): Baked {
  const { size } = i;
  const clods = worleyField(size, { cells: 26, jitter: 1, seed: "dirt:clods" });
  const pebbles = dotField(size, { count: Math.round(size * 0.9), radius: size / 150, radiusVar: 0.7, seed: "dirt:pebbles", hardness: 0.7 });
  const grain = fbmField(size, { period: 90, octaves: 2, gain: 0.5, seed: "dirt:grain" });
  const macro = fbmField(size, { period: 3, octaves: 4, gain: 0.6, seed: "dirt:macro" });
  const ruts = fbmField(size, { period: [2, 44], octaves: 3, gain: 0.6, seed: "dirt:ruts" });
  const mud = crackNetwork(clods.f1, clods.f2, 0.14);

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const dark = hexRgb(0x4b3826);
  const light = hexRgb(0x9a7d55);
  const dust = hexRgb(0xc0a87e);
  const stone = hexRgb(0x8d8579);

  for (let p = 0; p < n; p++) {
    const clod = Math.pow(1 - clods.f1[p], 1.6);
    const rut = clamp01((ruts[p] - 0.5) * 2);
    const h = clamp01(clod * 0.4 + pebbles[p] * 0.45 + grain[p] * 0.18 - mud[p] * 0.28 - rut * 0.12);
    height[p] = h;

    const m = macro[p];
    let c = { r: lerp(dark.r, light.r, m * 0.7 + h * 0.4), g: lerp(dark.g, light.g, m * 0.7 + h * 0.4), b: lerp(dark.b, light.b, m * 0.7 + h * 0.4) };
    // Dust settles on the high ground and washes out of the ruts.
    const film = clamp01(h * 1.1 - rut * 0.6);
    c = { r: lerp(c.r, dust.r, film * 0.35), g: lerp(c.g, dust.g, film * 0.35), b: lerp(c.b, dust.b, film * 0.35) };
    const peb = clamp01(pebbles[p] * 1.4);
    c = { r: lerp(c.r, stone.r, peb * 0.7), g: lerp(c.g, stone.g, peb * 0.7), b: lerp(c.b, stone.b, peb * 0.7) };
    c.r *= 1 - mud[p] * 0.3;
    c.g *= 1 - mud[p] * 0.32;
    c.b *= 1 - mud[p] * 0.34;

    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    rough[p] = clamp01(0.94 - peb * 0.16 + (grain[p] - 0.5) * 0.08);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.6,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.2),
  };
}

/**
 * Sand. Wind ripples are the whole job: a periodic wave whose phase is warped
 * by low-frequency noise, so the crests wander and fork the way real ripples
 * do instead of marching in lockstep. Grain speckle on top, drift shadows
 * underneath, a few shells and pebbles for scale.
 */
function bakeSand(i: BakeInput): Baked {
  const { size } = i;
  const phase = fbmField(size, { period: 3, octaves: 4, gain: 0.6, seed: "sand:phase" });
  const drift = fbmField(size, { period: 2, octaves: 3, gain: 0.55, seed: "sand:drift" });
  const grain = fbmField(size, { period: 128, octaves: 2, gain: 0.5, seed: "sand:grain" });
  const pebbles = dotField(size, { count: Math.round(size / 6), radius: size / 190, seed: "sand:pebbles", hardness: 0.8 });
  const dunes = fbmField(size, { period: [2, 5], octaves: 3, gain: 0.6, seed: "sand:dunes" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const dry = hexRgb(0xefdda6);
  const damp = hexRgb(0xbfa878);
  const shell = hexRgb(0xfdf6e4);

  const RIPPLES = 14;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      // Integer ripple count keeps the wave periodic across the tile; the
      // warp term is itself periodic, so the whole thing still wraps.
      const w = Math.sin((v * RIPPLES + (phase[p] - 0.5) * 2.6) * Math.PI * 2);
      const ripple = Math.pow(clamp01(w * 0.5 + 0.5), 1.4);
      const h = clamp01(ripple * 0.55 + dunes[p] * 0.28 + grain[p] * 0.1 + pebbles[p] * 0.3);
      height[p] = h;

      // The lee side of every ripple holds damp, darker sand.
      const lee = clamp01((1 - ripple) * 1.2) * (0.4 + drift[p] * 0.6);
      let c = { r: lerp(dry.r, damp.r, lee * 0.75), g: lerp(dry.g, damp.g, lee * 0.75), b: lerp(dry.b, damp.b, lee * 0.75) };
      const k = 0.92 + grain[p] * 0.18;
      c.r *= k;
      c.g *= k;
      c.b *= k;
      const pb = clamp01(pebbles[p] * 1.5);
      c = { r: lerp(c.r, shell.r, pb * 0.8), g: lerp(c.g, shell.g, pb * 0.8), b: lerp(c.b, shell.b, pb * 0.8) };
      buf.r[p] = c.r;
      buf.g[p] = c.g;
      buf.b[p] = c.b;
      // Dry sand is completely matte; damp sand less so. That contrast is
      // what reads as moisture without any extra map.
      rough[p] = clamp01(0.96 - lee * 0.24 - pb * 0.2);
    }
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.8,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.1),
  };
}

// ---------------------------------------------------------------------------
// Liquids and glass
// ---------------------------------------------------------------------------

/**
 * Water. The albedo is almost flat — colour comes from the material tint and
 * the environment — so all the effort goes into a height field made of a few
 * warped swells plus capillary chop. The library scrolls this map twice at
 * different scales and speeds, which is the oldest trick in real-time water and
 * still the most convincing one per instruction.
 */
function bakeWater(i: BakeInput): Baked {
  const { size } = i;
  const swellA = fbmField(size, { period: [3, 4], octaves: 3, gain: 0.55, seed: "water:swellA" });
  const swellB = fbmField(size, { period: [6, 5], octaves: 3, gain: 0.5, seed: "water:swellB" });
  const chop = ridgedField(size, { period: [18, 22], octaves: 3, gain: 0.5, seed: "water:chop" });
  const foamN = fbmField(size, { period: 12, octaves: 4, gain: 0.6, seed: "water:foam" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const deep = hexRgb(0x1d6ea8);
  const shallow = hexRgb(0x49b7d8);

  for (let p = 0; p < n; p++) {
    const h = clamp01(swellA[p] * 0.45 + swellB[p] * 0.32 + chop[p] * 0.23);
    height[p] = h;
    // A whisper of foam on the crests keeps the surface from looking like
    // moulded plastic when it is dead calm.
    const foam = clamp01((h - 0.72) * 3) * clamp01((foamN[p] - 0.5) * 2.4);
    const c = { r: lerp(deep.r, shallow.r, h), g: lerp(deep.g, shallow.g, h), b: lerp(deep.b, shallow.b, h) };
    buf.r[p] = lerp(c.r, 0.95, foam);
    buf.g[p] = lerp(c.g, 0.97, foam);
    buf.b[p] = lerp(c.b, 0.98, foam);
    rough[p] = clamp01(0.05 + foam * 0.55 + (h - 0.5) * 0.06);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.55,
    roughness: rough,
    metalness: 0,
  };
}

/** Ice: sub-surface crazing, frost blooms on top, near-mirror everywhere else. */
function bakeIce(i: BakeInput): Baked {
  const { size } = i;
  const cells = worleyField(size, { cells: 9, jitter: 1, seed: "ice:cells" });
  const fine = worleyField(size, { cells: 24, jitter: 1, seed: "ice:fine" });
  const frost = fbmField(size, { period: 6, octaves: 5, gain: 0.6, seed: "ice:frost" });
  const swirl = fbmField(size, { period: 3, octaves: 4, gain: 0.55, seed: "ice:swirl" });
  const bubbles = dotField(size, { count: Math.round(size / 5), radius: size / 220, seed: "ice:bubbles", hardness: 0.9 });

  const crazeA = crackNetwork(cells.f1, cells.f2, 0.09);
  const crazeB = crackNetwork(fine.f1, fine.f2, 0.06);

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const clear = hexRgb(0x9fd4e8);
  const white = hexRgb(0xe8f6fb);
  const deep = hexRgb(0x4e90ad);

  for (let p = 0; p < n; p++) {
    const craze = Math.max(crazeA[p] * 0.8, crazeB[p] * 0.5);
    const bloom = clamp01((frost[p] - 0.58) * 2.8);
    // Cracks are *below* the surface: they barely touch the normal, or the ice
    // reads as cracked concrete instead of frozen water.
    height[p] = clamp01(0.5 + swirl[p] * 0.2 + bloom * 0.22 - bubbles[p] * 0.12 - craze * 0.05);

    let c = { r: lerp(deep.r, clear.r, swirl[p]), g: lerp(deep.g, clear.g, swirl[p]), b: lerp(deep.b, clear.b, swirl[p]) };
    c = { r: lerp(c.r, white.r, craze * 0.8), g: lerp(c.g, white.g, craze * 0.8), b: lerp(c.b, white.b, craze * 0.8) };
    c = { r: lerp(c.r, white.r, bloom * 0.85), g: lerp(c.g, white.g, bloom * 0.85), b: lerp(c.b, white.b, bloom * 0.85) };
    c = { r: lerp(c.r, 1, bubbles[p] * 0.6), g: lerp(c.g, 1, bubbles[p] * 0.6), b: lerp(c.b, 1, bubbles[p] * 0.6) };
    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    // Polished ice is a mirror; frost is powder. The step between them is the
    // whole read of the material.
    rough[p] = clamp01(0.06 + bloom * 0.72 + craze * 0.12);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.45,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.6),
  };
}

/** Glass: not clear plastic — faint orange peel, wiper arcs and edge smear. */
function bakeGlass(i: BakeInput): Baked {
  const { size } = i;
  const peel = fbmField(size, { period: 14, octaves: 3, gain: 0.5, seed: "glass:peel" });
  const smear = fbmField(size, { period: [4, 26], octaves: 3, gain: 0.6, seed: "glass:smear" });
  const dust = dotField(size, { count: Math.round(size / 8), radius: size / 240, seed: "glass:dust", hardness: 0.9 });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  for (let p = 0; p < n; p++) {
    height[p] = clamp01(0.5 + (peel[p] - 0.5) * 0.5 + dust[p] * 0.2);
    const grubby = clamp01((smear[p] - 0.55) * 2) * 0.5 + dust[p] * 0.6;
    buf.r[p] = 0.86 + grubby * 0.1;
    buf.g[p] = 0.92 + grubby * 0.06;
    buf.b[p] = 0.96;
    rough[p] = clamp01(0.03 + grubby * 0.3);
  }
  return { albedo: buf.toRaster(), height, normalStrength: 0.25, roughness: rough, metalness: 0 };
}

// ---------------------------------------------------------------------------
// Built surfaces
// ---------------------------------------------------------------------------

/** Planks: grain, rings, knots, gaps, nail heads, and a boot-worn centre. */
function bakeWood(i: BakeInput): Baked {
  const { size } = i;
  const PLANKS = 5;
  const gap = stripeField(size, { count: PLANKS, axis: "v", duty: 0.965, soft: 0.006 });
  const grain = fbmField(size, { period: [96, 4], octaves: 4, gain: 0.55, seed: "wood:grain" });
  const grainFine = ridgedField(size, { period: [180, 6], octaves: 2, gain: 0.5, seed: "wood:fine" });
  const knots = worleyField(size, { cells: [3, 5], jitter: 1, seed: "wood:knots" });
  const wear = fbmField(size, { period: [3, 8], octaves: 4, gain: 0.6, seed: "wood:wear" });
  const nails = dotField(size, { count: PLANKS * 4, radius: size / 90, radiusVar: 0.15, seed: "wood:nails", hardness: 0.85 });
  const rng = makeRng("wood:tone");
  const plankTone = new Float32Array(PLANKS);
  for (let k = 0; k < PLANKS; k++) plankTone[k] = rng();

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const dark = hexRgb(0x5a3a1f);
  const mid = hexRgb(0x9c6b38);
  const pale = hexRgb(0xc79a5f);
  const grey = hexRgb(0x9d8f7d);

  for (let p = 0; p < n; p++) {
    const y = Math.floor(p / size) / size;
    const k = Math.floor(y * PLANKS) % PLANKS;

    // Rings tighten around a knot, which is what makes a knot read as a knot
    // rather than a brown dot.
    const knotD = knots.f1[p];
    const knotM = clamp01(1 - knotD * 3.2) * clamp01((knots.id[p] - 0.45) * 4);
    const rings = Math.abs(Math.sin((grain[p] * 5.5 + (1 - knotD) * 7 * knotM) * Math.PI));

    const g = clamp01(rings * 0.6 + grainFine[p] * 0.4);
    const boards = gap[p];
    const worn = clamp01((wear[p] - 0.42) * 1.8);
    height[p] = clamp01(boards * (0.62 + g * 0.22 - knotM * 0.16 - worn * 0.08) + nails[p] * 0.2 - (1 - boards) * 0.55);

    const tone = plankTone[k];
    let c = {
      r: lerp(dark.r, pale.r, clamp01(g * 0.55 + tone * 0.45)),
      g: lerp(dark.g, pale.g, clamp01(g * 0.55 + tone * 0.45)),
      b: lerp(dark.b, pale.b, clamp01(g * 0.55 + tone * 0.45)),
    };
    c = { r: lerp(c.r, mid.r, 0.3), g: lerp(c.g, mid.g, 0.3), b: lerp(c.b, mid.b, 0.3) };
    // Knots are dark and resinous.
    c = { r: lerp(c.r, 0.18, knotM * 0.8), g: lerp(c.g, 0.11, knotM * 0.8), b: lerp(c.b, 0.05, knotM * 0.8) };
    // Weathering greys the exposed centre of every board.
    c = { r: lerp(c.r, grey.r, worn * 0.5), g: lerp(c.g, grey.g, worn * 0.5), b: lerp(c.b, grey.b, worn * 0.5) };
    // The gap between boards is shadow, not wood.
    const shadow = 1 - boards;
    c.r *= 1 - shadow * 0.85;
    c.g *= 1 - shadow * 0.85;
    c.b *= 1 - shadow * 0.85;
    const nail = clamp01(nails[p] * 1.6) * boards;
    c = { r: lerp(c.r, 0.35, nail), g: lerp(c.g, 0.34, nail), b: lerp(c.b, 0.33, nail) };

    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    rough[p] = clamp01(0.78 + worn * 0.14 - g * 0.1 - nail * 0.45);
  }

  const metal = new Float32Array(n);
  for (let p = 0; p < n; p++) metal[p] = clamp01(nails[p] * 1.6) * gap[p] * 0.9;

  return {
    albedo: buf.toRaster(),
    height,
    // Enough to catch the plank gaps and the nail heads; any more and the
    // grain itself starts to corrugate, which no planed board does.
    normalStrength: 0.95,
    roughness: rough,
    metalness: metal,
    ao: ao(height, i, 1.25),
  };
}

/** Brushed metal: fine directional scratches, shallow dents, a hint of oxide. */
function bakeMetal(i: BakeInput): Baked {
  const { size } = i;
  const brush = fbmField(size, { period: [6, 200], octaves: 3, gain: 0.5, seed: "metal:brush" });
  const brushFine = fbmField(size, { period: [3, 380], octaves: 2, gain: 0.5, seed: "metal:fine" });
  const dents = fbmField(size, { period: 7, octaves: 3, gain: 0.55, seed: "metal:dents" });
  const scratches = seamField(size, { count: 7, axis: "u", width: 0.004, wobble: 0.02, seed: "metal:scratch", broken: 0.8 });
  const oxide = fbmField(size, { period: 4, octaves: 4, gain: 0.6, seed: "metal:oxide" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const steel = hexRgb(0xb9c0c7);
  const shadowSteel = hexRgb(0x7b838c);
  const rust = hexRgb(0x8a5a33);

  for (let p = 0; p < n; p++) {
    const b = brush[p] * 0.6 + brushFine[p] * 0.4;
    height[p] = clamp01(0.5 + (b - 0.5) * 0.35 + (dents[p] - 0.5) * 0.5 - scratches[p] * 0.3);
    const ox = clamp01((oxide[p] - 0.72) * 3.5);
    let c = { r: lerp(shadowSteel.r, steel.r, b), g: lerp(shadowSteel.g, steel.g, b), b: lerp(shadowSteel.b, steel.b, b) };
    c = { r: lerp(c.r, rust.r, ox * 0.65), g: lerp(c.g, rust.g, ox * 0.65), b: lerp(c.b, rust.b, ox * 0.65) };
    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    // Brushed steel is anisotropic in reality; a streaked roughness map is the
    // honest cheap approximation and survives on any rasteriser.
    rough[p] = clamp01(0.3 + (b - 0.5) * 0.28 + ox * 0.45 + scratches[p] * 0.2);
    metal[p] = clamp01(1 - ox * 0.75);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.5,
    roughness: rough,
    metalness: metal,
    ao: ao(height, i, 0.7),
  };
}

/** Chrome: mirror-flat with just enough orange peel to bend a reflection. */
function bakeChrome(i: BakeInput): Baked {
  const { size } = i;
  const peel = fbmField(size, { period: 10, octaves: 3, gain: 0.5, seed: "chrome:peel" });
  const micro = fbmField(size, { period: 60, octaves: 2, gain: 0.5, seed: "chrome:micro" });
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size).fill(0xf2f5f8);
  for (let p = 0; p < n; p++) {
    height[p] = clamp01(0.5 + (peel[p] - 0.5) * 0.6 + (micro[p] - 0.5) * 0.15);
    rough[p] = clamp01(0.045 + (micro[p] - 0.5) * 0.05);
  }
  return { albedo: buf.toRaster(), height, normalStrength: 0.2, roughness: rough, metalness: 1 };
}

/** Perforated grate: diamond bars over a hole, cut with alpha. */
function bakeGrate(i: BakeInput): Baked {
  const { size } = i;
  const s = makeSurface(size);
  const ctx = s.ctx;
  ctx.clearRect(0, 0, size, size);
  // Bars are measured perpendicular to their own run, and the diagonal packing
  // means the gap closes 1.4× faster than the spacing suggests — hence a width
  // that looks far too thin written down and lands at ~half-open in the image.
  const bar = size * 0.055;
  ctx.lineCap = "butt";
  // Two crossing families of bars at ±45° make a diamond mesh that tiles as
  // long as the spacing divides the diagonal evenly.
  const spacing = size / 4;
  for (const dir of [1, -1]) {
    ctx.strokeStyle = dir > 0 ? "#c8ced4" : "#aab2ba";
    ctx.lineWidth = bar;
    for (let k = -6; k <= 10; k++) {
      const o = k * spacing;
      ctx.beginPath();
      ctx.moveTo(o - size, dir > 0 ? -size : size * 2);
      ctx.lineTo(o + size * 2, dir > 0 ? size * 2 : -size);
      ctx.stroke();
    }
  }
  const raster = surfaceToRaster(s);
  const buf = rasterToBuffer(raster, size);

  const dirtN = fbmField(size, { period: 8, octaves: 4, gain: 0.6, seed: "grate:dirt" });
  const brush = fbmField(size, { period: [200, 6], octaves: 2, gain: 0.5, seed: "grate:brush" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const solid = buf.a[p];
    // Round the bars so the light rolls off them rather than hitting a plateau.
    height[p] = solid;
    const grimeAmt = clamp01((dirtN[p] - 0.55) * 2.4);
    const k = 0.82 + brush[p] * 0.3;
    buf.r[p] = lerp(buf.r[p] * k, 0.31, grimeAmt * 0.6);
    buf.g[p] = lerp(buf.g[p] * k, 0.27, grimeAmt * 0.6);
    buf.b[p] = lerp(buf.b[p] * k, 0.23, grimeAmt * 0.6);
    rough[p] = clamp01(0.34 + grimeAmt * 0.45 + (brush[p] - 0.5) * 0.15);
    metal[p] = clamp01(0.95 - grimeAmt * 0.5);
    // Hard alpha: this material is cut, not blended, so mips must not smear it
    // into a grey haze. Push it away from the alphaTest threshold on both sides.
    buf.a[p] = solid > 0.5 ? 1 : 0;
  }
  const blurred = blurField(height, size, Math.max(1, size / 128), 1);
  for (let p = 0; p < n; p++) height[p] = blurred[p];

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.6,
    roughness: rough,
    metalness: metal,
    ao: ao(height, i, 0.9),
  };
}

/** Concrete: form-board lines, pitting, blotchy cure staining, hairline cracks. */
function bakeConcrete(i: BakeInput): Baked {
  const { size } = i;
  const pits = worleyField(size, { cells: 54, jitter: 1, seed: "concrete:pits" });
  const macro = fbmField(size, { period: 3, octaves: 5, gain: 0.6, seed: "concrete:macro" });
  const fine = fbmField(size, { period: 40, octaves: 3, gain: 0.5, seed: "concrete:fine" });
  const boards = stripeField(size, { count: 3, axis: "v", duty: 0.985, soft: 0.004 });
  const cracks = roughen(
    seamField(size, { count: 2, axis: "v", width: 0.004, wobble: 0.14, seed: "concrete:crack", broken: 0.6 }),
    fine,
    0.6,
  );
  const stains = fbmField(size, { period: [4, 3], octaves: 4, gain: 0.62, seed: "concrete:stain" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const light = hexRgb(0xbdb9b1);
  const dark = hexRgb(0x87847e);
  const stainC = hexRgb(0x5d5a54);

  for (let p = 0; p < n; p++) {
    const pit = clamp01(1 - pits.f1[p] * 2.4) * clamp01((pits.id[p] - 0.55) * 3);
    height[p] = clamp01(0.62 + (fine[p] - 0.5) * 0.2 - pit * 0.45 - (1 - boards[p]) * 0.35 - cracks[p] * 0.4);

    const m = macro[p];
    let c = { r: lerp(dark.r, light.r, m), g: lerp(dark.g, light.g, m), b: lerp(dark.b, light.b, m) };
    const st = clamp01((stains[p] - 0.58) * 2.2);
    c = { r: lerp(c.r, stainC.r, st * 0.55), g: lerp(c.g, stainC.g, st * 0.55), b: lerp(c.b, stainC.b, st * 0.55) };
    const dirtK = Math.max(pit, cracks[p], 1 - boards[p]);
    c.r *= 1 - dirtK * 0.4;
    c.g *= 1 - dirtK * 0.42;
    c.b *= 1 - dirtK * 0.44;
    const k = 0.94 + fine[p] * 0.12;
    buf.r[p] = c.r * k;
    buf.g[p] = c.g * k;
    buf.b[p] = c.b * k;
    rough[p] = clamp01(0.86 + pit * 0.1 - st * 0.14 + (fine[p] - 0.5) * 0.08);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.85,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.1),
  };
}

/** Brick in running bond: per-brick tone, recessed mortar, chipped arrises. */
function bakeBrick(i: BakeInput): Baked {
  const { size } = i;
  const ROWS = 8;
  const COLS = 4;
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const brickTone = new Float32Array(n);
  const brickHue = new Float32Array(n);
  const mortarMask = new Float32Array(n);

  const rng = makeRng("brick:tones");
  const tones = new Float32Array(ROWS * COLS * 2);
  for (let k = 0; k < tones.length; k++) tones[k] = rng();

  const mortarW = 0.055;
  const face = fbmField(size, { period: 64, octaves: 3, gain: 0.55, seed: "brick:face" });
  const mortarN = fbmField(size, { period: 90, octaves: 2, gain: 0.5, seed: "brick:mortar" });
  const efflor = fbmField(size, { period: 5, octaves: 4, gain: 0.62, seed: "brick:efflor" });

  for (let y = 0; y < size; y++) {
    const v = y * (ROWS / size);
    const row = Math.floor(v);
    const fy = v - row;
    // Running bond: every other course is offset by half a brick.
    const offset = row & 1 ? 0.5 : 0;
    for (let x = 0; x < size; x++) {
      const u = x * (COLS / size) + offset * 1;
      const col = Math.floor(u);
      const fx = u - col;
      const p = y * size + x;

      const inX = smoothstep(0, mortarW, fx) * (1 - smoothstep(1 - mortarW, 1, fx));
      const inY = smoothstep(0, mortarW * (COLS / ROWS), fy) * (1 - smoothstep(1 - mortarW * (COLS / ROWS), 1, fy));
      const brick = inX * inY;
      mortarMask[p] = 1 - brick;

      const k = (((row % ROWS) + ROWS) % ROWS) * COLS + (((col % COLS) + COLS) % COLS);
      brickTone[p] = tones[(k * 2) % tones.length];
      brickHue[p] = tones[(k * 2 + 1) % tones.length];

      height[p] = clamp01(
        brick * (0.78 + (face[p] - 0.5) * 0.18) + (1 - brick) * (0.34 + (mortarN[p] - 0.5) * 0.12),
      );
    }
  }

  const chip = edgeWearField(height, size, Math.max(2, size / 110), 0.6);
  const buf = new AlbedoBuffer(size);
  const mortarC = hexRgb(0xb2ada2);

  for (let p = 0; p < n; p++) {
    const brick = 1 - mortarMask[p];
    // A real wall is fired in batches: reds, oranges and a few near-black
    // clinkers. The spread is the point.
    const hue = lerp(0.02, 0.075, brickHue[p]);
    const sat = lerp(0.72, 0.45, brickTone[p]);
    const val = lerp(0.36, 0.66, brickTone[p] * 0.8 + face[p] * 0.2);
    const bc = hsv(hue, sat, val);
    let c = {
      r: lerp(mortarC.r, bc.r, brick),
      g: lerp(mortarC.g, bc.g, brick),
      b: lerp(mortarC.b, bc.b, brick),
    };
    // Chipped arris shows the pale unfired core.
    const ch = chip[p] * brick * 0.5;
    c = { r: lerp(c.r, 0.72, ch), g: lerp(c.g, 0.62, ch), b: lerp(c.b, 0.55, ch) };
    // Efflorescence: salt bloom, always worst just above the mortar.
    const ef = clamp01((efflor[p] - 0.66) * 3) * (0.35 + mortarMask[p] * 0.65);
    c = { r: lerp(c.r, 0.86, ef * 0.5), g: lerp(c.g, 0.85, ef * 0.5), b: lerp(c.b, 0.82, ef * 0.5) };
    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    rough[p] = clamp01(lerp(0.94, 0.74, brick) + ch * 0.15 + ef * 0.08);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.25,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.3),
  };
}

/** Dry-stone: rounded boulders packed tight with dirt and moss in the gaps. */
function bakeStone(i: BakeInput): Baked {
  const { size } = i;
  const cells = worleyField(size, { cells: 7, jitter: 1, manhattan: 0.25, seed: "stone:cells" });
  const detail = worleyField(size, { cells: 34, jitter: 1, seed: "stone:detail" });
  const strata = fbmField(size, { period: [3, 26], octaves: 3, gain: 0.55, seed: "stone:strata" });
  const grain = fbmField(size, { period: 70, octaves: 3, gain: 0.5, seed: "stone:grain" });
  const mossN = fbmField(size, { period: 5, octaves: 4, gain: 0.6, seed: "stone:moss" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);

  for (let p = 0; p < n; p++) {
    // Rounded dome per cell, minus the mortar valley at the boundary.
    const dome = Math.pow(clamp01(1 - cells.f1[p] * 1.15), 0.7);
    const bump = Math.pow(1 - detail.f1[p], 2) * 0.12;
    height[p] = clamp01(dome * 0.8 + bump + (grain[p] - 0.5) * 0.1 + strata[p] * 0.08);
  }

  const gaps = cavityField(height, size, Math.max(3, size / 40), 0.4);

  for (let p = 0; p < n; p++) {
    const id = cells.id[p];
    // Grey-brown spread with a couple of warmer stones per wall.
    const c0 = hsv(lerp(0.08, 0.12, id), lerp(0.05, 0.2, id), lerp(0.36, 0.62, grain[p] * 0.4 + id * 0.6));
    let c = { r: c0.r, g: c0.g, b: c0.b };
    const banding = 0.88 + strata[p] * 0.26;
    c.r *= banding;
    c.g *= banding;
    c.b *= banding;
    const dirtK = gaps[p];
    c = { r: lerp(c.r, 0.24, dirtK * 0.7), g: lerp(c.g, 0.21, dirtK * 0.7), b: lerp(c.b, 0.17, dirtK * 0.7) };
    const moss = clamp01((mossN[p] - 0.6) * 2.6) * clamp01(dirtK * 1.2 + 0.15);
    c = { r: lerp(c.r, 0.22, moss * 0.75), g: lerp(c.g, 0.35, moss * 0.75), b: lerp(c.b, 0.15, moss * 0.75) };
    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    rough[p] = clamp01(0.82 + dirtK * 0.12 + (grain[p] - 0.5) * 0.1 - moss * 0.05);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.3,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.35),
  };
}

/** Tyre rubber: moulded pebble texture, mould flash, and a dusty bloom. */
function bakeRubber(i: BakeInput): Baked {
  const { size } = i;
  const pebble = worleyField(size, { cells: 40, jitter: 1, seed: "rubber:pebble" });
  const micro = fbmField(size, { period: 110, octaves: 2, gain: 0.5, seed: "rubber:micro" });
  const flash = stripeField(size, { count: 1, axis: "v", duty: 0.012, soft: 0.006, phase: 0.25 });
  const bloom = fbmField(size, { period: 6, octaves: 4, gain: 0.6, seed: "rubber:bloom" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  for (let p = 0; p < n; p++) {
    const peb = Math.pow(1 - pebble.f1[p], 2.2);
    height[p] = clamp01(0.45 + peb * 0.3 + (micro[p] - 0.5) * 0.2 + flash[p] * 0.25);
    // Old rubber blooms a grey antiozonant film — the reason tyres are never
    // actually black.
    const b = clamp01((bloom[p] - 0.5) * 1.6);
    const v = 0.055 + peb * 0.02 + b * 0.05 + micro[p] * 0.02;
    buf.r[p] = v * 1.02;
    buf.g[p] = v;
    buf.b[p] = v * 0.98;
    rough[p] = clamp01(0.82 + b * 0.12 - peb * 0.12);
  }
  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.85,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.9),
  };
}

/** Injection-moulded plastic — white, so consumers tint it with `.color`. */
function bakePlastic(i: BakeInput): Baked {
  const { size } = i;
  const peel = fbmField(size, { period: 22, octaves: 3, gain: 0.5, seed: "plastic:peel" });
  const micro = fbmField(size, { period: 120, octaves: 2, gain: 0.5, seed: "plastic:micro" });
  const scuff = seamField(size, { count: 4, axis: "u", width: 0.003, wobble: 0.05, seed: "plastic:scuff", broken: 0.85 });
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  for (let p = 0; p < n; p++) {
    height[p] = clamp01(0.5 + (peel[p] - 0.5) * 0.45 + (micro[p] - 0.5) * 0.12 - scuff[p] * 0.15);
    const v = 0.9 + (micro[p] - 0.5) * 0.06;
    buf.r[p] = v;
    buf.g[p] = v;
    buf.b[p] = v * 0.995;
    rough[p] = clamp01(0.34 + (peel[p] - 0.5) * 0.12 + scuff[p] * 0.3);
  }
  return { albedo: buf.toRaster(), height, normalStrength: 0.35, roughness: rough, metalness: 0 };
}

/**
 * Car paint. The albedo is deliberately near-white — `carPaint()` tints the
 * material itself — and all the character is in a metallic flake field that
 * doubles as the clearcoat normal. Flake is high-frequency and *must* keep its
 * mips, otherwise it aliases into a crawling sparkle at speed.
 */
function bakeCarPaint(i: BakeInput): Baked {
  const { size } = i;
  const flake = dotField(size, { count: size * 14, radius: Math.max(1, size / 340), radiusVar: 0.4, seed: "paint:flake", hardness: 1 });
  const orange = fbmField(size, { period: 18, octaves: 3, gain: 0.5, seed: "paint:orangepeel" });
  const swirl = seamField(size, { count: 5, axis: "u", width: 0.002, wobble: 0.4, seed: "paint:swirl", broken: 0.9 });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  for (let p = 0; p < n; p++) {
    const f = flake[p];
    height[p] = clamp01(0.5 + (orange[p] - 0.5) * 0.4 + f * 0.35 - swirl[p] * 0.1);
    const v = 0.93 + f * 0.07;
    buf.r[p] = v;
    buf.g[p] = v;
    buf.b[p] = v;
    rough[p] = clamp01(0.26 - f * 0.18 + swirl[p] * 0.25 + (orange[p] - 0.5) * 0.06);
    // Only the flakes are metal; the binder around them is a dielectric.
    metal[p] = clamp01(0.18 + f * 0.75);
  }
  return { albedo: buf.toRaster(), height, normalStrength: 0.4, roughness: rough, metalness: metal };
}

// ---------------------------------------------------------------------------
// Nature and dressing
// ---------------------------------------------------------------------------

/**
 * Leaf card. Drawn rather than noised, because a leaf has a silhouette and
 * noise does not: each blade is a two-arc lozenge with a midrib, rotated and
 * scattered until the card is full, stamped nine times so it tiles.
 */
function bakeFoliage(i: BakeInput): Baked {
  const { size } = i;
  const s = makeSurface(size);
  const ctx = s.ctx;
  ctx.clearRect(0, 0, size, size);
  const rng = makeRng("foliage");

  const leaf = (c: CanvasRenderingContext2D, x: number, y: number, len: number, ang: number, hue: number) => {
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    const w = len * 0.42;
    const g = c.createLinearGradient(0, -len * 0.5, 0, len * 0.5);
    const base = hsv(lerp(0.23, 0.31, hue), lerp(0.75, 0.5, hue), lerp(0.3, 0.62, hue));
    const tipC = hsv(lerp(0.2, 0.28, hue), lerp(0.62, 0.42, hue), lerp(0.5, 0.82, hue));
    g.addColorStop(0, `rgb(${base.r * 255 | 0},${base.g * 255 | 0},${base.b * 255 | 0})`);
    g.addColorStop(1, `rgb(${tipC.r * 255 | 0},${tipC.g * 255 | 0},${tipC.b * 255 | 0})`);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, -len * 0.5);
    c.quadraticCurveTo(w, 0, 0, len * 0.5);
    c.quadraticCurveTo(-w, 0, 0, -len * 0.5);
    c.fill();
    // Midrib: a darker hairline that gives the leaf a fold when it lights.
    c.strokeStyle = `rgba(${base.r * 180 | 0},${base.g * 180 | 0},${base.b * 180 | 0},0.75)`;
    c.lineWidth = Math.max(1, len * 0.03);
    c.beginPath();
    c.moveTo(0, -len * 0.46);
    c.lineTo(0, len * 0.46);
    c.stroke();
    c.restore();
  };

  // Two passes: a dense dark understorey, then brighter leaves on top. The
  // depth separation is what stops an alpha card from looking like a sticker.
  for (const pass of [0, 1]) {
    const count = pass === 0 ? 24 : 18;
    for (let k = 0; k < count; k++) {
      const x = rng() * size;
      const y = rng() * size;
      const len = size * (pass === 0 ? 0.28 + rng() * 0.18 : 0.2 + rng() * 0.2);
      const ang = rng() * Math.PI * 2;
      const hue = pass === 0 ? rng() * 0.4 : 0.5 + rng() * 0.5;
      stampWrapped(s, (c) => leaf(c, x, y, len, ang, hue));
    }
  }

  const raster = surfaceToRaster(s);
  const buf = rasterToBuffer(raster, size);
  const n = size * size;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = buf.a[p];
  // Rounding the leaves via a blurred coverage field gives every card a
  // believable dome instead of a flat cutout.
  const height = blurField(alpha, size, Math.max(1, size / 120), 2);
  const veins = fbmField(size, { period: 40, octaves: 3, gain: 0.55, seed: "foliage:veins" });
  const rough = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    height[p] = clamp01(height[p] * 0.8 + (veins[p] - 0.5) * 0.15 * alpha[p]);
    rough[p] = clamp01(0.62 + (veins[p] - 0.5) * 0.2);
    buf.a[p] = alpha[p] > 0.45 ? 1 : 0;
  }
  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.7,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.8),
  };
}

/** Bark: deep vertical fissures, ridge highlights, lichen in the cracks. */
function bakeBark(i: BakeInput): Baked {
  const { size } = i;
  const fissure = ridgedField(size, { period: [10, 3], octaves: 4, gain: 0.55, seed: "bark:fissure" });
  const fine = ridgedField(size, { period: [26, 6], octaves: 3, gain: 0.5, seed: "bark:fine" });
  const rings = fbmField(size, { period: [3, 14], octaves: 3, gain: 0.55, seed: "bark:rings" });
  const lichenN = fbmField(size, { period: 7, octaves: 4, gain: 0.6, seed: "bark:lichen" });

  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const deep = hexRgb(0x2c1f14);
  const ridge = hexRgb(0x8a6a4a);
  const grey = hexRgb(0x9d968a);

  for (let p = 0; p < n; p++) {
    // A high exponent is what separates bark from planed timber: the ridges are
    // narrow plateaux and the fissures between them are deep and dark.
    const f = clamp01(fissure[p] * 0.72 + fine[p] * 0.28);
    const h = clamp01(Math.pow(f, 2.2) * 1.15 + rings[p] * 0.1);
    height[p] = h;
    let c = { r: lerp(deep.r, ridge.r, h), g: lerp(deep.g, ridge.g, h), b: lerp(deep.b, ridge.b, h) };
    // Ridges weather grey; fissures stay wet and dark.
    const weather = clamp01((h - 0.55) * 2.2);
    c = { r: lerp(c.r, grey.r, weather * 0.45), g: lerp(c.g, grey.g, weather * 0.45), b: lerp(c.b, grey.b, weather * 0.45) };
    const lich = clamp01((lichenN[p] - 0.64) * 3) * clamp01(h * 1.3);
    c = { r: lerp(c.r, 0.62, lich * 0.6), g: lerp(c.g, 0.68, lich * 0.6), b: lerp(c.b, 0.45, lich * 0.6) };
    buf.r[p] = c.r;
    buf.g[p] = c.g;
    buf.b[p] = c.b;
    rough[p] = clamp01(0.9 - weather * 0.06 + (1 - h) * 0.06);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.5,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1.3),
  };
}

/** Woven cloth: over-under threads, fibre fuzz, and a soft sheen. */
function bakeCloth(i: BakeInput): Baked {
  const { size } = i;
  const THREADS = 26;
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const fuzz = fbmField(size, { period: 140, octaves: 2, gain: 0.5, seed: "cloth:fuzz" });
  const wrinkle = fbmField(size, { period: 4, octaves: 4, gain: 0.6, seed: "cloth:wrinkle" });

  for (let y = 0; y < size; y++) {
    const v = (y / size) * THREADS;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * THREADS;
      const p = y * size + x;
      // Plain weave: warp is on top where (i+j) is even, weft where it is odd.
      const warp = Math.pow(Math.abs(Math.cos(u * Math.PI)), 0.6);
      const weft = Math.pow(Math.abs(Math.cos(v * Math.PI)), 0.6);
      const over = (Math.floor(u) + Math.floor(v)) & 1;
      const h = over ? warp * 0.85 + weft * 0.25 : weft * 0.85 + warp * 0.25;
      height[p] = clamp01(h * 0.7 + fuzz[p] * 0.12 + wrinkle[p] * 0.18);
      const shade = 0.72 + h * 0.28;
      const c = 0.92 * shade;
      buf.r[p] = c;
      buf.g[p] = c;
      buf.b[p] = c * 0.99;
      rough[p] = clamp01(0.88 - h * 0.1 + fuzz[p] * 0.08);
    }
  }
  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.6,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 1),
  };
}

/**
 * Trackside banner. Bold flat graphics — chevrons, a checker band, a ringed
 * emblem — over a cloth weave, because a banner reads at a hundred metres and
 * anything subtle is wasted there.
 */
function bakeBanner(i: BakeInput): Baked {
  const { size } = i;
  const s = makeSurface(size);
  const ctx = s.ctx;
  const yellow = "#ffcc22";
  const ink = "#12203a";
  const red = "#e8422e";
  const cream = "#fdf6e6";

  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, size, size);

  // Top and bottom accent bands.
  ctx.fillStyle = yellow;
  ctx.fillRect(0, 0, size, size * 0.09);
  ctx.fillRect(0, size * 0.91, size, size * 0.09);
  ctx.fillStyle = red;
  ctx.fillRect(0, size * 0.09, size, size * 0.022);
  ctx.fillRect(0, size * 0.888, size, size * 0.022);

  // Chevron run across the middle third.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, size * 0.14, size, size * 0.24);
  ctx.clip();
  ctx.fillStyle = yellow;
  const cw = size / 6;
  for (let k = -1; k < 8; k++) {
    ctx.beginPath();
    ctx.moveTo(k * cw, size * 0.14);
    ctx.lineTo(k * cw + cw * 0.45, size * 0.14);
    ctx.lineTo(k * cw + cw * 0.45 + cw * 0.3, size * 0.26);
    ctx.lineTo(k * cw + cw * 0.45, size * 0.38);
    ctx.lineTo(k * cw, size * 0.38);
    ctx.lineTo(k * cw + cw * 0.3, size * 0.26);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Checker band.
  const bandY = size * 0.62;
  const bandH = size * 0.2;
  const cell = size / 12;
  for (let cx = 0; cx < 12; cx++) {
    for (let cy = 0; cy < Math.round(bandH / cell); cy++) {
      ctx.fillStyle = (cx + cy) & 1 ? cream : ink;
      ctx.fillRect(cx * cell, bandY + cy * cell, cell + 1, cell + 1);
    }
  }

  // Emblem: a ring with a star, centred in the free space.
  const ex = size * 0.5;
  const ey = size * 0.5;
  const er = size * 0.1;
  ctx.strokeStyle = cream;
  ctx.lineWidth = size * 0.022;
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = yellow;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    const r = k & 1 ? er * 0.32 : er * 0.72;
    const px = ex + Math.cos(a) * r;
    const py = ey + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  const buf = rasterToBuffer(surfaceToRaster(s), size);
  const n = size * size;
  const weave = bakeCloth({ ...i, ao: false });
  const weaveH = weave.height as Field;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const sag = fbmField(size, { period: [2, 6], octaves: 3, gain: 0.6, seed: "banner:sag" });
  const dirtN = fbmField(size, { period: 5, octaves: 4, gain: 0.6, seed: "banner:dirt" });

  for (let p = 0; p < n; p++) {
    // Weave under the ink, plus a slack wave so the banner never looks like
    // a rigid billboard.
    height[p] = clamp01(weaveH[p] * 0.55 + sag[p] * 0.45);
    const grubby = clamp01((dirtN[p] - 0.66) * 2.6) * 0.35;
    const shade = 0.86 + weaveH[p] * 0.2;
    buf.r[p] = buf.r[p] * shade * (1 - grubby * 0.5);
    buf.g[p] = buf.g[p] * shade * (1 - grubby * 0.45);
    buf.b[p] = buf.b[p] * shade * (1 - grubby * 0.4);
    buf.a[p] = 1;
    rough[p] = clamp01(0.72 + grubby * 0.2 - weaveH[p] * 0.08);
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.5,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.7),
  };
}

/**
 * Neon: a glass tube grid with a hot core and a cooler halo, plus the dark
 * unlit backing between tubes. Emissive carries the light; albedo stays dark so
 * the sign still reads as an object in daylight.
 */
function bakeNeon(i: BakeInput): Baked {
  const { size } = i;
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const glow = new AlbedoBuffer(size);
  const grime = fbmField(size, { period: 8, octaves: 4, gain: 0.6, seed: "neon:grime" });

  const TUBES = 3;
  for (let y = 0; y < size; y++) {
    const v = (y / size) * TUBES;
    const f = v - Math.floor(v);
    // Distance from the tube axis, in tube radii.
    const d = Math.abs(f - 0.5) / 0.3;
    const tube = clamp01(1 - d);
    const core = Math.pow(tube, 3);
    const halo = Math.pow(tube, 0.6);
    const band = Math.floor(v) % TUBES;
    // Three hues so a strip of this reads as a sign, not a light bar.
    const hue = band === 0 ? 0.52 : band === 1 ? 0.86 : 0.13;
    const c = hsv(hue, 0.85, 1);
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const g = grime[p];
      height[p] = clamp01(0.35 + Math.sqrt(clamp01(1 - d * d)) * 0.6);
      // Unlit glass is a dark smoky grey with a bright rim.
      const glassV = 0.06 + tube * 0.1 + core * 0.5;
      buf.r[p] = lerp(0.07, c.r, core * 0.7) * (0.85 + g * 0.3) + glassV * 0.2;
      buf.g[p] = lerp(0.07, c.g, core * 0.7) * (0.85 + g * 0.3) + glassV * 0.2;
      buf.b[p] = lerp(0.08, c.b, core * 0.7) * (0.85 + g * 0.3) + glassV * 0.2;
      const e = core * 1.25 + halo * 0.35;
      glow.r[p] = c.r * e;
      glow.g[p] = c.g * e;
      glow.b[p] = c.b * e;
      rough[p] = clamp01(0.18 + (1 - tube) * 0.5 + g * 0.1);
    }
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.8,
    roughness: rough,
    metalness: 0,
    emissive: glow.toRaster(),
  };
}

/**
 * Anti-gravity plating: machined hex panels with a lit seam grid. The seams are
 * emissive and the library pulses them, so a section of track flips from
 * "industrial floor" to "the road is holding you on" as you enter it.
 */
function bakeAntigrav(i: BakeInput): Baked {
  const { size } = i;
  const n = size * size;
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  const buf = new AlbedoBuffer(size);
  const glow = new AlbedoBuffer(size);

  const brushN = fbmField(size, { period: [180, 5], octaves: 2, gain: 0.5, seed: "antigrav:brush" });
  const wear = fbmField(size, { period: 5, octaves: 4, gain: 0.6, seed: "antigrav:wear" });
  const rivets = dotField(size, { count: 24, radius: size / 64, radiusVar: 0.1, seed: "antigrav:rivets", hardness: 0.9 });

  const plate = hexRgb(0x2a3346);
  const plateHi = hexRgb(0x475572);
  const seamGlow = hexRgb(0x35e8ff);

  const HEX = 3;
  for (let y = 0; y < size; y++) {
    const v = (y / size) * HEX;
    const rowI = Math.floor(v);
    const fy = v - rowI;
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      // Offset rows give a brick-hex weave that tiles with an even row count.
      const u = (x / size) * HEX + (rowI & 1 ? 0.5 : 0);
      const fx = u - Math.floor(u);
      const seam =
        1 -
        smoothstep(0, 0.035, fx) * (1 - smoothstep(0.965, 1, fx)) *
          smoothstep(0, 0.035, fy) * (1 - smoothstep(0.965, 1, fy));
      const inner = 1 - seam;
      height[p] = clamp01(inner * 0.8 + 0.1 + rivets[p] * 0.25 + (brushN[p] - 0.5) * 0.06);

      const scuffed = clamp01((wear[p] - 0.55) * 2);
      const k = 0.9 + brushN[p] * 0.22;
      let r = lerp(plate.r, plateHi.r, scuffed) * k;
      let g = lerp(plate.g, plateHi.g, scuffed) * k;
      let b = lerp(plate.b, plateHi.b, scuffed) * k;
      // The seam is a dark channel with the light source at its bottom.
      r = lerp(r, 0.05, seam * 0.8);
      g = lerp(g, 0.07, seam * 0.8);
      b = lerp(b, 0.1, seam * 0.8);
      const riv = clamp01(rivets[p] * 1.5);
      r = lerp(r, 0.55, riv * 0.6);
      g = lerp(g, 0.58, riv * 0.6);
      b = lerp(b, 0.62, riv * 0.6);
      buf.r[p] = r;
      buf.g[p] = g;
      buf.b[p] = b;

      const e = Math.pow(seam, 1.6) * 1.35;
      glow.r[p] = seamGlow.r * e;
      glow.g[p] = seamGlow.g * e;
      glow.b[p] = seamGlow.b * e;

      rough[p] = clamp01(0.4 - scuffed * 0.12 + seam * 0.25 - riv * 0.2);
      metal[p] = clamp01(0.85 - seam * 0.5);
    }
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 1.0,
    roughness: rough,
    metalness: metal,
    ao: ao(height, i, 1),
    emissive: glow.toRaster(),
  };
}

/**
 * Grandstand crowd. A tiling strip of stamped spectators, three rows deep, the
 * back rows darker and smaller so the stand has depth from one alpha card.
 * Cheap enough to run round the whole circuit and the single biggest "this is
 * a real race" cue in the game.
 */
function bakeCrowd(i: BakeInput): Baked {
  const { size } = i;
  const s = makeSurface(size);
  const ctx = s.ctx;
  ctx.clearRect(0, 0, size, size);
  const rng = makeRng("crowd");

  const SKIN = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x5c3a21];
  const SHIRT = [
    0xe23b3b, 0x2e7fd9, 0xffcc22, 0x39b54a, 0xffffff, 0x8e44ad, 0xf39c12, 0x16a085,
    0xe84393, 0x2d3436,
  ];

  const css = (hex: number, k = 1) =>
    `rgb(${Math.min(255, ((hex >> 16) & 255) * k) | 0},${Math.min(255, ((hex >> 8) & 255) * k) | 0},${Math.min(255, (hex & 255) * k) | 0})`;

  // Back rows first: smaller, higher up the card, and darkened so the crowd
  // has aerial perspective baked in.
  // The front row's feet sit on the bottom edge of the card, so a billboard
  // can be planted straight onto the terrace floor with no dead margin.
  const ROWS = [
    { y: 0.6, scale: 0.62, count: 26, dim: 0.55 },
    { y: 0.8, scale: 0.8, count: 22, dim: 0.75 },
    { y: 1.0, scale: 1.0, count: 18, dim: 1.0 },
  ];

  for (const row of ROWS) {
    for (let k = 0; k < row.count; k++) {
      const x = ((k + rng() * 0.7) / row.count) * size;
      const baseY = size * row.y;
      const h = size * 0.36 * row.scale * (0.9 + rng() * 0.2);
      const w = h * 0.42;
      const skin = SKIN[(rng() * SKIN.length) | 0];
      const shirt = SHIRT[(rng() * SHIRT.length) | 0];
      const hat = rng() < 0.35 ? SHIRT[(rng() * SHIRT.length) | 0] : -1;
      const cheer = rng() < 0.45;
      stampWrapped(s, (c) => {
        c.save();
        c.translate(x, baseY);
        // Torso
        c.fillStyle = css(shirt, row.dim);
        c.beginPath();
        const tw = w;
        const th = h * 0.6;
        c.moveTo(-tw * 0.5, 0);
        c.lineTo(-tw * 0.42, -th);
        c.lineTo(tw * 0.42, -th);
        c.lineTo(tw * 0.5, 0);
        c.closePath();
        c.fill();
        // Arms — half the crowd has them up, which is what makes a still
        // frame look like a crowd rather than a queue.
        c.strokeStyle = css(skin, row.dim);
        c.lineWidth = w * 0.22;
        c.lineCap = "round";
        for (const side of [-1, 1]) {
          c.beginPath();
          c.moveTo(side * tw * 0.4, -th * 0.85);
          if (cheer) c.lineTo(side * tw * 0.72, -th * 1.55);
          else c.lineTo(side * tw * 0.6, -th * 0.15);
          c.stroke();
        }
        // Head
        c.fillStyle = css(skin, row.dim);
        c.beginPath();
        c.arc(0, -th - h * 0.16, h * 0.15, 0, Math.PI * 2);
        c.fill();
        if (hat >= 0) {
          c.fillStyle = css(hat, row.dim);
          c.beginPath();
          c.arc(0, -th - h * 0.19, h * 0.16, Math.PI, Math.PI * 2);
          c.fill();
          c.fillRect(-h * 0.18, -th - h * 0.2, h * 0.36, h * 0.045);
        }
        c.restore();
      });
    }
  }

  const buf = rasterToBuffer(surfaceToRaster(s), size);
  const n = size * size;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = buf.a[p];
  const height = blurField(alpha, size, Math.max(1, size / 96), 2);
  const cloth = fbmField(size, { period: 60, octaves: 3, gain: 0.55, seed: "crowd:cloth" });
  const rough = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const y = Math.floor(p / size) / size;
    // Ambient occlusion downwards: the stand is dark at the feet.
    const shade = lerp(0.55, 1, smoothstep(0.95, 0.4, y));
    buf.r[p] *= shade;
    buf.g[p] *= shade;
    buf.b[p] *= shade;
    height[p] = clamp01(height[p] * 0.9 + (cloth[p] - 0.5) * 0.1 * alpha[p]);
    rough[p] = clamp01(0.85 + (cloth[p] - 0.5) * 0.15);
    buf.a[p] = alpha[p] > 0.4 ? 1 : 0;
  }

  return {
    albedo: buf.toRaster(),
    height,
    normalStrength: 0.55,
    roughness: rough,
    metalness: 0,
    ao: ao(height, i, 0.7),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BAKERS: Record<MaterialName, (i: BakeInput) => Baked> = {
  asphalt: (i) => bakeAsphalt(i, false),
  asphaltWorn: (i) => bakeAsphalt(i, true),
  kerb: bakeKerb,
  roadLine: bakeRoadLine,
  startLine: bakeStartLine,
  grass: bakeGrass,
  dirt: bakeDirt,
  sand: bakeSand,
  water: bakeWater,
  ice: bakeIce,
  wood: bakeWood,
  metal: bakeMetal,
  grate: bakeGrate,
  concrete: bakeConcrete,
  brick: bakeBrick,
  stone: bakeStone,
  rubber: bakeRubber,
  chrome: bakeChrome,
  carPaint: bakeCarPaint,
  glass: bakeGlass,
  plastic: bakePlastic,
  foliage: bakeFoliage,
  bark: bakeBark,
  cloth: bakeCloth,
  banner: bakeBanner,
  neon: bakeNeon,
  antigrav: bakeAntigrav,
  boostPad: bakeBoostPad,
  crowd: bakeCrowd,
};

/** Re-exported so the library can build normals without importing noise twice. */
export { normalFromHeight };
