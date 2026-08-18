/**
 * The Conservatory, in light.
 *
 * Every other realm in the vibeverse is stylised, and most are a game. This
 * one is trying to look real and has nothing for you to do, so all of it
 * rests on light behaving the way light does in a wet glasshouse at the end
 * of the day. Three ideas carry that, and they live here because six
 * different materials need them.
 *
 * 1. LIGHT REMEMBERS WHAT IT CAME THROUGH. A sunbeam in a glasshouse is not
 *    a smooth cone — it is chopped into strips by the roof ribs and stained
 *    by whatever is on the panes. So the shafts, the floor pools and the
 *    leaf highlights are all modulated by the SAME roof function. That one
 *    shared term is most of why the room reads as a real building rather
 *    than as fog with a light in it.
 *
 * 2. RAIN IS A LENS, NOT A TEXTURE. Drops on the glass sit still while they
 *    are small, then let go and streak, and what you see through them is
 *    displaced. Doing that as a normal perturbation on the glass — rather
 *    than as a scrolling overlay — is the difference between weather and
 *    wallpaper.
 *
 * 3. LEAVES ARE THIN. A leaf with the sun behind it glows; the same leaf
 *    with the sun behind YOU is flat and waxy. That one term does more for
 *    plants looking alive than any amount of geometry.
 */

/**
 * Where the sun sits. Low and late — the whole room is built for it.
 *
 * It was at 15 degrees, which is a beautiful number for a sunset and the
 * wrong one for this building. A shaft entering a vault at 15 degrees never
 * arrives anywhere: over the seventeen metres a beam is drawn for, it falls
 * four, so every shaft in the house hung above head height and quietly left
 * through a side wall. Nothing landed, so nothing read as a beam.
 *
 * Thirty-one degrees still looks like late afternoon, and it is steep
 * enough that a shaft crosses the whole room from ridge to floor — which
 * is the only way you ever see one, because what you are actually looking
 * at is the air it passes through on the way down.
 */
export const SUN_DIR: [number, number, number] = [-0.34, 0.52, -0.78];
/* Stronger and further round to orange than it was. The sun is the ONLY
   saturated thing in here; everything else is a shade of wet grey-green,
   and if the sun is merely warm-white the whole room reads as noon. */
export const SUN_COLOR: [number, number, number] = [1.0, 0.62, 0.30];
/* Overcast sky coming through the glass, which is most of the fill light.
   It was [0.42, 0.52, 0.62] — a periwinkle bright enough that after ACES
   every upward-facing surface in the building sat near white and the room
   looked like a hazy noon. Cloud is not blue; it is a neutral grey with a
   slight cool lean, and it should be DIM, because the drama here is the
   difference between the bars of sun and everything that is not in one. */
export const SKY_COLOR: [number, number, number] = [0.315, 0.345, 0.385];

export const conservatoryUniforms = () => ({
  uTime: { value: 0 },
  uCamPos: { value: [0, 1.6, 0] },
  uSunDir: { value: [...SUN_DIR] },
  uSunColor: { value: [...SUN_COLOR] },
  uSkyColor: { value: [...SKY_COLOR] },
  /** 0 = dry, 1 = full downpour. Drives rain, gloom and the shafts together. */
  uRain: { value: 0.65 },
  /** Rises when a gust passes; every plant leans on the same number. */
  uGust: { value: 0 },
});

/**
 * Shared GLSL. Hash and noise first, then the three ideas above.
 */
export const CONSERVATORY_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uRain;
uniform float uGust;

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1,0)), u.x),
             mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), u.x), u.y);
}

float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += vnoise(p) * a; p *= 2.03; a *= 0.5; }
  return s;
}

/* ------------------------------------------------------------------ *
 * 1. The roof, as a function
 *
 * Returns how much sun gets through the roof at a point, in the roof's own
 * coordinates. Ribs run across the barrel vault at a fixed pitch and the
 * panes between them are dirty in a low-frequency way — a hundred and
 * something years of London, or wherever this is.
 *
 * The shafts, the floor and the leaves all call this, which is what keeps
 * the bright strip on a leaf lined up with the bright strip on the floor
 * beneath it. Getting those out of step is the single most obvious way a
 * scene like this stops looking photographed.
 * ------------------------------------------------------------------ */
float roofTransmission(vec2 roofUV){
  // Iron ribs: hard, narrow, opaque.
  float rib = smoothstep(0.030, 0.075, abs(fract(roofUV.x * 8.0) - 0.5));
  // Glazing bars the other way, thinner and further apart.
  float bar = smoothstep(0.018, 0.055, abs(fract(roofUV.y * 3.0) - 0.5));
  // Grime and algae in the corners of the panes.
  float grime = 0.62 + 0.38 * fbm(roofUV * 6.0 + 11.0);
  return rib * bar * grime;
}

/**
 * The same roof, blurred — which is to say, with a penumbra.
 *
 * SHADOWS INDOORS ARE NOT HARD, and the first version's were. Every surface
 * called roofTransmission directly, so a 17cm glazing bar nine metres
 * overhead painted a 17cm-wide dead-black stripe on the floor with an edge
 * two centimetres across. The floor looked stencilled.
 *
 * A shadow's edge softens in proportion to the distance from the occluder
 * and the angular size of the source, and here BOTH are large: the roof is
 * most of a storey up, and the sun is coming through a rip in wet cloud, so
 * it is not a half-degree disc — it is a smeared patch several degrees
 * across. Nine metres under that, a glazing bar casts a band you can barely
 * find and the ribs are a soft rhythm rather than a barcode.
 *
 * So callers pass how far they are from the glass, in the roof's own uv
 * scale, and get an average instead of a sample. Five taps is enough
 * because what is being blurred is already a smooth function.
 */
float roofTransmissionSoft(vec2 roofUV, vec2 blur){
  float s = roofTransmission(roofUV) * 0.30;
  s += roofTransmission(roofUV + blur * 0.55) * 0.20;
  s += roofTransmission(roofUV - blur * 0.55) * 0.20;
  s += roofTransmission(roofUV + blur) * 0.15;
  s += roofTransmission(roofUV - blur) * 0.15;
  return s;
}

/* ------------------------------------------------------------------ *
 * 1b. The canopy, also as a function
 *
 * THE LARGEST REMAINING TELL WAS THAT NOTHING SHADED ANYTHING ELSE. The
 * roof cast a shadow, because the roof is a function — but three thousand
 * leaves hanging over a tiled path lit it as though they were not there.
 * A glasshouse floor is never evenly lit; it is a bright strip down the
 * middle with dappled shade creeping in from both beds, and that pattern is
 * most of what tells you there is a jungle above you without your having to
 * look up.
 *
 * A shadow map would do it properly and would mean every material in the
 * realm sampling a depth texture. This does it the same way the roof does:
 * one shared closed-form answer to "how much light reaches here", so the
 * floor, the soil, the kerbs, the water and the lower foliage all agree.
 * They agree because they are asking the same function, not because
 * somebody kept six magic numbers in sync.
 *
 * Two terms. The beds are dense and always dark; the path is open in the
 * middle and shaded at its edges, where the planting leans over it. On top
 * of that, dapple — because a canopy is holes, and the holes drift when the
 * wind moves, which is why the floor of a greenhouse never sits still.
 * ------------------------------------------------------------------ */
float canopyShade(vec3 worldPos){
  float ax = abs(worldPos.x);
  // Open down the centre line, closing towards the beds and dark inside them.
  float open = smoothstep(4.6, 1.1, ax);
  // Dapple. Drifts with the gust so the shade breathes when the house does.
  vec2 dp = worldPos.xz * 0.85 + vec2(uGust * 0.35, uTime * 0.02);
  float dapple = 0.55 + 0.45 * fbm(dp);
  // Under the beds themselves almost nothing gets through.
  /* 0.20 under the beds put them at pure black — every leaf below waist
     height lost its shape entirely, and a jungle floor is dim, not absent.
     Light bounces off a hundred wet surfaces before it gets down there. */
  float lit = mix(0.38, 1.0, open) * mix(0.74, 1.0, dapple);
  /* Contact. A surface right up against the kerb is occluded by it from
     nearly every direction, and that dark line where two things meet is
     the cheapest and most convincing occlusion there is. */
  float kerb = 1.0 - 0.42 * smoothstep(0.85, 0.10, abs(ax - 3.5));
  // Above the canopy there is nothing left to shade you.
  return mix(lit * kerb, 1.0, smoothstep(3.2, 6.0, worldPos.y));
}

/* ------------------------------------------------------------------ *
 * 2. Rain on glass
 *
 * Two populations, because real rain on a window has two.
 *
 * STATIC drops cling in a jittered lattice and only wobble. They are most
 * of what you see, and they never move, which is why a purely scrolling
 * rain shader looks wrong however good the droplets are.
 *
 * RUNNERS are the ones that got heavy enough to let go. They fall down
 * their own column, accelerating, and leave a thinning trail behind them
 * that the next runner in that column will re-wet.
 *
 * Returns (offset.xy, wetness) — the offset is used to bend what you see
 * through the pane, which is what makes them read as lenses.
 * ------------------------------------------------------------------ */
vec3 rainOnGlass(vec2 uv, float t){
  vec2 off = vec2(0.0);
  float wet = 0.0;

  // --- clinging drops -------------------------------------------------
  vec2 gv = uv * vec2(14.0, 9.0);
  vec2 id = floor(gv);
  vec2 f  = fract(gv) - 0.5;
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 nid = id + vec2(float(i), float(j));
      vec2 rnd = hash22(nid);
      if (rnd.x > 0.45 + 0.45 * (1.0 - uRain)) continue;   // sparser when dry
      // A slow breath, so the glass is never completely frozen.
      vec2 c = vec2(float(i), float(j)) + (rnd - 0.5) * 0.7
             + 0.02 * vec2(sin(t * 0.7 + rnd.x * 30.0), cos(t * 0.6 + rnd.y * 30.0));
      float r = 0.10 + 0.16 * rnd.y;
      float d = length(f - c);
      float drop = smoothstep(r, r * 0.25, d);
      wet = max(wet, drop);
      // Refraction: a drop is a tiny lens, so it pushes the view outward
      // from its own centre.
      off += normalize(f - c + 1e-5) * drop * 0.016;
    }
  }

  // --- runners --------------------------------------------------------
  float cols = 22.0;
  float cx = floor(uv.x * cols);
  float seed = hash11(cx * 3.7);
  // Each column runs on its own clock, so they never fall in step.
  float speed = 0.16 + 0.30 * seed + 0.25 * uRain;
  float phase = fract(t * speed + seed * 7.0);
  // Accelerating: a drop that has let go is still speeding up.
  float y = 1.0 - phase * phase;
  float lx = (cx + 0.5) / cols + (seed - 0.5) * 0.012;
  float dx = (uv.x - lx) * cols;
  float dy = (uv.y - y) * 9.0;

  float head = smoothstep(1.1, 0.0, length(vec2(dx * 1.4, dy)));
  // The trail is above the head (it came from up there) and thins with age.
  float tail = smoothstep(0.9, 0.0, abs(dx) * 1.9)
             * smoothstep(0.0, 1.0, dy) * smoothstep(6.0, 0.6, dy);
  float run = max(head, tail * 0.55) * step(0.25, uRain);
  wet = max(wet, run);
  off += vec2(dx * 0.004, 0.0) * head;

  return vec3(off, clamp(wet, 0.0, 1.0));
}

/* ------------------------------------------------------------------ *
 * 3. Thin leaves
 *
 * Lambert for the lit side, plus a transmission lobe for light coming
 * through from behind. The wrap term matters as much as the transmission:
 * leaves in shadow are lit by the whole sky, not by nothing.
 * ------------------------------------------------------------------ */
vec3 leafShade(vec3 n, vec3 viewDir, vec3 albedo, float thinness, float shade){
  vec3 L = normalize(uSunDir);
  float lambert = max(0.0, dot(n, L));
  // Wrapped diffuse — cheap stand-in for a leaf being lit from all around.
  float wrap = max(0.0, (dot(n, L) + 0.45) / 1.45);
  // Backlight: strongest when the sun is directly behind the leaf AND you
  // are looking towards it. This is the term that makes a canopy glow.
  float back = pow(max(0.0, dot(viewDir, -L)), 3.0) * max(0.0, -dot(n, L) * 0.5 + 0.5);
  // Sky fill through the glass. This is the dominant light in the room
  // on a grey day, not a rounding error on top of the sun.
  vec3 sky = uSkyColor * (0.55 + 0.90 * (n.y * 0.5 + 0.5));
  // Less wrap than before: a canopy needs a real dark side or the whole
  // planting flattens into one shade of green.
  vec3 lit = albedo * (sky + uSunColor * mix(lambert, wrap, 0.30) * shade * 2.3);
  // Transmitted light picks up the leaf's own colour on the way through,
  // which is why backlit foliage goes yellow-green rather than white.
  lit += albedo * uSunColor * back * thinness * shade * 2.4;
  return lit;
}

/**
 * Distance haze.
 *
 * The first pass used 0.012 + rain*0.010 per metre, which over a 48m nave
 * put the far gable under 59% fog — every surface beyond about fifteen
 * metres collapsed into the same flat grey and the room lost all its depth.
 * A humid glasshouse is not a fog bank; you can see the far end perfectly
 * well, it is just softer. Four times weaker, and capped much lower.
 */
vec3 humid(vec3 color, vec3 worldPos){
  float d = length(worldPos - uCamPos);
  float f = 1.0 - exp(-d * (0.0042 + uRain * 0.0028));
  vec3 air = mix(uSkyColor * 1.15, uSunColor * 0.34 + uSkyColor * 0.66, 0.35);
  return mix(color, air, clamp(f, 0.0, 0.42));
}
`;
