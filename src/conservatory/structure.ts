/**
 * The building: a Victorian barrel-vaulted glasshouse.
 *
 * The shape is doing a job rather than being decorative. A barrel vault
 * gives a long run of repeating ribs, and repeating ribs are what slice a
 * low sun into the row of bright bars across the floor that this whole
 * realm is built around. A dome would have been prettier and would have
 * thrown one soft pool of light, which is nothing to look at.
 *
 * Everything static is merged into a handful of draw calls. There are a
 * few hundred iron members and none of them ever move.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON } from "./shaders";

/** Interior dimensions, metres. */
export const NAVE = {
  halfWidth: 7.0,
  length: 48,
  /** Height the vault springs from — below this the walls are vertical. */
  spring: 3.1,
  /** Radius of the vault itself. */
  radius: 7.0,
  /** One structural bay. Rib pitch, and the pitch of the light on the floor. */
  bay: 2.4,
};

export const FLOOR_Y = 0;

/** Height of the vault at a given distance from the centre line. */
export function vaultHeight(x: number): number {
  const t = Math.min(Math.abs(x) / NAVE.radius, 1);
  return NAVE.spring + Math.sqrt(Math.max(0, 1 - t * t)) * NAVE.radius;
}

/** Is this point inside the house, with room for a person? */
export function insideNave(x: number, z: number): boolean {
  return Math.abs(x) < NAVE.halfWidth - 0.45 && Math.abs(z) < NAVE.length / 2 - 0.6;
}

interface Built {
  group: THREE.Group;
  dispose(): void;
}

/** Merge non-indexed position/normal/uv geometry. */
function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of flat) total += g.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of flat) {
    if (!g.attributes.normal) g.computeVertexNormals();
    position.set(g.attributes.position.array as ArrayLike<number>, o * 3);
    normal.set(g.attributes.normal.array as ArrayLike<number>, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as ArrayLike<number>, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return out;
}

// ---------------------------------------------------------------------
// Painted ironwork
// ---------------------------------------------------------------------
export function ironMaterial(uniforms: Record<string, THREE.IUniform>) {
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
        vec3 v = normalize(uCamPos - vWorld);
        // Flaking cream paint over iron. The wear follows height, because
        // that is where the damp collects and the paint gives up first.
        float wear = smoothstep(0.35, 0.0, fbm(vWorld.xz * 2.2 + vWorld.y * 0.9));
        /* Cream, but a DIRTY cream. At 0.86 the ironwork came back out of
           ACES as pure white and read as moulded plastic — nothing painted
           and rained on for a century is that bright. */
        vec3 paint = mix(vec3(0.62, 0.60, 0.54), vec3(0.26, 0.21, 0.18), wear * 0.8);
        float sun = max(0.0, dot(n, normalize(uSunDir)));
        vec3 sky = uSkyColor * (0.72 + 0.60 * (n.y * 0.5 + 0.5));
        // Ironwork is only ever lit through the roof it is holding up, so
        // it must be dimmed by the same roof everything else is.
        float thru = roofTransmission(vec2(vWorld.z * 0.20, vWorld.x * 0.07));
        vec3 col = paint * (sky + uSunColor * sun * 1.7 * thru);
        // Wet paint has a broad sheen rather than a highlight.
        float fres = pow(1.0 - max(0.0, dot(n, v)), 4.0);
        col += uSkyColor * fres * (0.07 + uRain * 0.16);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// The glass
// ---------------------------------------------------------------------
export function glassMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      ${CONSERVATORY_COMMON}
      void main(){
        vec3 n = normalize(vNormal);
        vec3 v = normalize(uCamPos - vWorld);
        float fres = pow(1.0 - abs(dot(n, v)), 3.4);

        // Rain lives on the OUTSIDE face, so it is keyed to world position
        // rather than to the mesh's uv — otherwise every pane would carry
        // an identical copy of the same storm.
        vec3 rain = rainOnGlass(vec2(vWorld.z * 0.055 + 0.5, vUv.y), uTime);
        vec2 warp = rain.xy;
        float wet = rain.z;

        /* THE PANES, IN WORLD MEASURE.
           Keyed to uv, the same numbers gave 77cm panes on the 48m vault
           and 34cm ones on the 3m side walls — the walls came out as a
           lattice, because a uv is a fraction of whatever it is stretched
           over and glazing bars are not. In metres, every pane in the
           building is the same size, which is what makes it read as one
           building rather than as several surfaces that happen to touch.

           Rafters run one way and purlins the other, and which way is which
           depends on the surface: on the vault and the side walls the
           rafters run along the length, and on a gable there is no length
           to run along, so they follow x instead. */
        float alongAxis = abs(n.z) > 0.7 ? vWorld.x : vWorld.z;
        vec2 pane = vec2(alongAxis * 1.30, vWorld.y * 1.30);
        vec2 pf = abs(fract(pane) - 0.5);
        /* Slimmer than they were. At 0.40 the soft edge alone was 15cm
           wide, so standing three metres off a wall put you behind what
           looked like prison bars — a real glazing bar is a couple of
           centimetres of iron with a putty line either side. */
        float bars = max(smoothstep(0.452, 0.492, pf.x),
                         smoothstep(0.455, 0.494, pf.y));
        /* Fade the grid out once the panes are smaller than a pixel. Down
           the length of a 48m vault they get there quickly, and an unfaded
           grid at that scale is not a roof, it is a moiré — the same thing
           that was happening to the floor tiles, for the same reason, and
           fixed the same way. */
        /* Fading from 0.30 was still half a bay too late: around the far end
           of the vault the grid broke into a field of dots, which is what a
           moiré looks like when it is nearly resolved rather than badly.
           Start letting go while each pane is still three pixels across. */
        bars *= 1.0 - smoothstep(0.16, 0.55, max(fwidth(pane.x), fwidth(pane.y)));

        /* WHAT IS ON THE GLASS, NOT WHAT IS BEHIND IT.
           This used to compute a sky of its own and hand it back as the
           pane's colour, at very nearly the brightness of the actual sky
           dome behind it — so every pane in the house painted over the
           weather with a flat copy of itself, and the garden outside was
           invisible from indoors. What a pane contributes is its
           REFLECTIONS and its DIRT; the view is the thing behind it, and
           the only honest way to show that is to let it through. */
        float pid = hash21(floor(pane));
        float grime = fbm(vec2(vWorld.z * 0.55, vUv.y * 5.0 + vWorld.x * 0.35));

        // Reflected room and sky, plus the sun's own disc smeared by water.
        vec3 on = uSkyColor * (0.30 + fres * 0.75);
        float sunDisc = pow(max(0.0, dot(normalize(-v), normalize(uSunDir))), 26.0);
        on += uSunColor * sunDisc * 1.3;
        // Old horticultural glass is green at the edges and never clean.
        on = mix(on, on * vec3(0.80, 1.0, 0.84), smoothstep(0.55, 1.0, grime) * 0.6);
        on += vec3(0.55) * wet * 0.10;
        // The drops are lenses; the warp they impose shows as a smear of
        // whatever brightness they are sitting in front of.
        on += uSkyColor * length(warp) * 6.0;

        /* Alpha is now the pane's OPACITY — grime, water and the glancing
           sheen — rather than an excuse to blend in a painted sky. Face on,
           you see the garden; along the glass, you see the glass. */
        float alpha = clamp(0.055 + fres * 0.62 + wet * 0.20
                          + smoothstep(0.5, 1.0, grime) * 0.16
                          + (pid - 0.5) * 0.05, 0.0, 0.94);
        vec3 col = on;
        // The bars are painted iron, not glass: dark, and opaque.
        col = mix(col, uSkyColor * 0.34, bars * 0.94);
        alpha = mix(alpha, 1.0, bars * 0.94);
        gl_FragColor = vec4(humid(col, vWorld), alpha);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// Floor: encaustic tile, wet
// ---------------------------------------------------------------------
/** Brick: the bed kerbs and the pool rim. Warm, matte, and damp. */
export function brickMaterial(uniforms: Record<string, THREE.IUniform>) {
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
        // Courses, with the vertical joints offset every other row.
        float row = floor(vWorld.y * 13.0);
        float u = vWorld.x * 8.0 + vWorld.z * 8.0 + mod(row, 2.0) * 0.5;
        float mortar = smoothstep(0.0, 0.06, abs(fract(u) - 0.5))
                     * smoothstep(0.0, 0.10, abs(fract(vWorld.y * 13.0) - 0.5));
        vec3 brick = mix(vec3(0.46, 0.28, 0.21), vec3(0.62, 0.40, 0.30),
                         hash21(vec2(floor(u), row)));
        // Damp, and green at the bottom where it meets the soil.
        brick = mix(brick * 0.7, brick, mortar);
        brick = mix(vec3(0.24, 0.30, 0.22), brick, smoothstep(0.0, 0.30, vWorld.y));
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.010, 0.022));
        float can = canopyShade(vWorld);
        vec3 sky = uSkyColor * (0.66 + 0.52 * (n.y * 0.5 + 0.5)) * mix(0.60, 1.0, can);
        vec3 col = brick * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir))) * thru * 1.6 * can);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

export function floorMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      ${CONSERVATORY_COMMON}
      void main(){
        vec2 p = vWorld.xz;

        /* ENCAUSTIC TILE, AND THE REASON IT IS DRAWN THIS WAY.
           The first version was a two-colour chequer with 24% random
           per-tile brightness on top of a noise "wear" term, and it came
           out as tartan. Three separate mistakes stacked: the two colours
           were far too far apart for fired clay, the per-tile jitter fought
           the pattern instead of sitting under it, and a 28cm cell seen
           down a 48m nave lands several tiles inside one pixel, which is
           where the plaid actually came from.

           So: one modest field colour with a dark border course, the
           jitter down to a whisper, and — the part that matters — the
           pattern filtered against its own footprint with fwidth(), so it
           dissolves to its average as it gets too small to resolve instead
           of aliasing into a herringbone. That is what a mip chain would do
           for a texture; this floor is a function, so it has to do it
           itself. */
        float TS = 2.6;                       // ~38cm tiles
        vec2 tp = p * TS;
        float fw = max(fwidth(tp.x), fwidth(tp.y));
        // 0 while the cell is comfortably bigger than a pixel, 1 once it
        // is not — everything patterned fades out on this one number.
        float legible = 1.0 - smoothstep(0.35, 1.1, fw);

        vec2 cell = floor(tp);
        float chk = mod(cell.x + cell.y, 2.0);
        vec3 a = vec3(0.325, 0.255, 0.215);
        vec3 b = vec3(0.415, 0.350, 0.295);
        vec3 field = mix(a, b, chk);
        // No two fired tiles match, but they very nearly do.
        field *= 0.955 + 0.09 * hash21(cell);

        /* The border course. Every floor of this kind has one: two dark
           bands running the length of the walk, a tile in from the kerb.
           It is what gives a long room its perspective lines. */
        float bd = abs(abs(p.x) - 2.55);
        float border = 1.0 - smoothstep(0.10, 0.26, bd);
        vec3 tile = mix(field, vec3(0.215, 0.145, 0.125), border * 0.85);

        // Grout. Thin, pale, and gone the moment it stops being resolvable.
        vec2 g = abs(fract(tp) - 0.5);
        float grout = (1.0 - smoothstep(0.44, 0.492, max(g.x, g.y)));
        /* Grout is DIRTY. At 0.44 it was paler than half the tiles and
           perfectly even, which drew a bright regular lattice over the whole
           floor and made it read as sheet vinyl. Real lime joints in a
           glasshouse are darker than the tile, not lighter, and they are
           darkest where the water sits. */
        vec3 joint = mix(vec3(0.235, 0.205, 0.175), vec3(0.30, 0.27, 0.235),
                         fbm(p * 5.0));
        tile = mix(joint, tile, mix(1.0, grout, legible));

        // Wear: the middle of the walk is polished paler, the edges are not.
        float wear = smoothstep(3.0, 0.4, abs(p.x)) * (0.6 + 0.4 * fbm(p * 1.1));
        tile = mix(tile, vec3(0.40, 0.355, 0.315), wear * 0.30);

        // Dissolve to the mean where the tiles no longer resolve.
        vec3 mean = mix(a, b, 0.5);
        mean = mix(mean, vec3(0.215, 0.145, 0.125), border * 0.85);
        tile = mix(mean, tile, legible);

        // Beyond the path it is gravel and spilled soil.
        float onPath = smoothstep(3.4, 2.95, abs(p.x));
        vec3 grit = vec3(0.235, 0.195, 0.155) * (0.8 + 0.4 * fbm(p * 9.0));
        vec3 albedo = mix(grit, tile, onPath);

        // THE SHAFTS LANDING. Same roof function as the beams themselves, so
        // the bars on the floor line up with the bars in the air above them.
        /* Nine metres below the glass, so the widest penumbra in the room.
           The blur is deliberately wider than the glazing bars: at this
           distance they should read as a faint warmth gradient across the
           walk, not as painted stripes, and the ribs' rhythm survives it. */
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.011, 0.024));
        float can = canopyShade(vWorld);
        vec3 sky = uSkyColor * 0.90 * mix(0.55, 1.0, can);
        /* Sunlight lands on the floor already bounced off a hundred wet
           leaves, so it arrives less orange than it left. Feeding the raw
           sun colour in at full strength turned a terracotta floor neon. */
        vec3 warm = mix(uSunColor, vec3(0.92, 0.80, 0.66), 0.45);
        vec3 col = albedo * (sky + warm * thru * 1.25 * can);

        // Standing water. Puddles gather where the floor is worn, they
        // darken the tile, and they mirror the roof — which is the cheapest
        // honest reflection available, because the roof is a function.
        /* Grazing reflections ARE strong, but the first version reflected a
           bright SKY, and at eye level almost the whole floor is grazing —
           so the floor came back pale blue everywhere and read as more sky.
           What a wet floor in a dim glasshouse mirrors is the room: dark
           ironwork, with the roof's bright bars picked out across it. */
        float pud = smoothstep(0.62, 0.86, fbm(p * 0.55 + 3.0)) * uRain;
        vec3 view = normalize(vWorld - uCamPos);
        float fres = pow(1.0 - abs(view.y), 5.0);
        float bars = roofTransmissionSoft(vec2(vWorld.z * 0.20 + view.z * 0.35,
                                              vWorld.x * 0.07 + view.x * 0.12),
                                          vec2(0.008, 0.016));
        vec3 mirrored = uSkyColor * 0.20 + warm * bars * 0.75;
        col = mix(col, mix(col * 0.62, mirrored, clamp(fres, 0.0, 0.65)), pud * 0.85);

        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// The pool, and the soil it sits between
// ---------------------------------------------------------------------
/**
 * Still water under glass.
 *
 * The pool had a brick rim and nothing in it, so from any distance it read
 * as a manhole. A dark ring on a floor is not a pond; the pond is the part
 * that MOVES, and in a room where nothing else does, it is the only thing
 * carrying the fact that time is passing.
 *
 * Three things, in order of how much they matter:
 *
 * - It reflects the roof. Same `roofTransmission` as the floor and the
 *   leaves, sampled along the reflected view, so the bright bars overhead
 *   appear in the water in the right places and swim when it ripples. That
 *   single term is what makes it read as a surface rather than a colour.
 * - The ripples are two noise fields drifting at different speeds. One
 *   field is a pattern; two crossing fields are water.
 * - Rain lands on it. Expanding rings, several at once, each fading as it
 *   grows — and they only exist while it is raining, which is how the pool
 *   ends up being the clearest indicator in the room of whether the weather
 *   is on.
 */
export function waterMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      ${CONSERVATORY_COMMON}
      void main(){
        vec2 p = vWorld.xz;

        // --- surface ----------------------------------------------------
        // Two drifting fields. One would be a pattern; two crossing is water.
        float h1 = vnoise(p * 3.1 + vec2(uTime * 0.10, uTime * 0.06));
        float h2 = vnoise(p * 6.7 - vec2(uTime * 0.13, uTime * 0.09));
        float h = h1 * 0.6 + h2 * 0.4;

        // Rain rings. Four at a time, each on its own clock and its own spot.
        float rings = 0.0;
        for (int i = 0; i < 4; i++){
          float fi = float(i);
          float clock = uTime * 0.55 + fi * 1.37;
          float era = floor(clock);
          float age = fract(clock);
          vec2 at = (hash22(vec2(era, fi * 7.3)) - 0.5) * 3.4;
          float r = age * 1.5;
          float d = abs(length(p - at) - r);
          // The ring thins and fades as it grows, like a real one.
          rings += (1.0 - age) * smoothstep(0.10, 0.0, d) * 0.5;
        }
        h += rings * uRain;

        // Slope of that height field, as a normal.
        float e = 0.035;
        vec2 grad = vec2(
          vnoise((p + vec2(e,0.0)) * 3.1 + vec2(uTime*0.10, uTime*0.06)) - h1,
          vnoise((p + vec2(0.0,e)) * 3.1 + vec2(uTime*0.10, uTime*0.06)) - h1
        ) / e;
        vec3 n = normalize(vec3(-grad.x * 0.35, 1.0, -grad.y * 0.35));

        vec3 view = normalize(vWorld - uCamPos);
        vec3 refl = reflect(view, n);
        float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, -dot(view, n)), 4.0);

        // --- what is under it -------------------------------------------
        // Not deep. You can see the bottom, and the bottom is silt and moss.
        vec3 bed = mix(vec3(0.055, 0.075, 0.055), vec3(0.10, 0.115, 0.075),
                       fbm(p * 3.5));
        float thruDown = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                              vec2(0.010, 0.022));
        float can = canopyShade(vWorld);
        vec3 under = bed * (uSkyColor * 0.75 + uSunColor * thruDown * 0.9 * can);

        // --- what is on it ----------------------------------------------
        // The roof, mirrored — bright bars sliding as the surface moves.
        float bars = roofTransmissionSoft(vec2(vWorld.z * 0.20 + refl.z * 0.9,
                                               vWorld.x * 0.07 + refl.x * 0.28),
                                          vec2(0.007, 0.015));
        vec3 mirrored = uSkyColor * 0.55 + uSunColor * bars * 0.85;
        // A broad glint where the sun's own smeared disc lands.
        float glint = pow(max(0.0, dot(refl, normalize(uSunDir))), 90.0);
        mirrored += uSunColor * glint * 1.1;

        vec3 col = mix(under, mirrored, clamp(fres, 0.0, 0.90));
        // The rings themselves catch light on their crests.
        col += uSunColor * rings * uRain * 0.22;
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

/**
 * The beds.
 *
 * They were drawn in the brick material, which gave every bed a flat
 * orange top surface with mortar courses in it — a brick lid on the soil,
 * visible the length of the room. Soil is dark, damp, and covered in what
 * the plants above it have dropped.
 */
export function soilMaterial(uniforms: Record<string, THREE.IUniform>) {
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
        vec2 p = vWorld.xz;
        // Clods at two scales, so it is lumpy rather than merely noisy.
        float coarse = fbm(p * 4.5);
        float fine = fbm(p * 19.0);
        /* Damp earth is DARK, but it is not black, and at 0.055–0.115
           under a canopy term that already halves the light it came out at
           about one part in seventy — a flat void with a hard edge where
           the bed stopped. You should be able to see the clods. */
        vec3 soil = mix(vec3(0.105, 0.080, 0.058), vec3(0.205, 0.158, 0.108),
                        coarse * 0.7 + fine * 0.3);
        // Leaf litter and the odd pale fleck of grit.
        float litter = smoothstep(0.66, 0.80, fbm(p * 8.0 + 31.0));
        soil = mix(soil, vec3(0.215, 0.165, 0.092), litter * 0.55);
        soil += vec3(0.05) * smoothstep(0.88, 0.96, fine);
        // Moss creeping in from the kerb, where the water collects.
        float moss = smoothstep(0.60, 0.85, fbm(p * 2.2 + 7.0)) * 0.5;
        soil = mix(soil, vec3(0.085, 0.145, 0.070), moss);

        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.010, 0.022));
        // Under a canopy: very little sky reaches the ground in a bed.
        float can = canopyShade(vWorld);
        vec3 sky = uSkyColor * (0.62 + 0.40 * (n.y * 0.5 + 0.5)) * mix(0.70, 1.0, can);
        vec3 col = soil * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir)))
                                 * thru * 1.1 * can);
        // Wet earth has a dull sheen, not a highlight.
        vec3 v = normalize(uCamPos - vWorld);
        col += uSkyColor * pow(1.0 - max(0.0, dot(n, v)), 5.0) * uRain * 0.10;
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------
export function buildStructure(
  iron: THREE.Material,
  glass: THREE.Material,
  floor: THREE.Material,
  brick: THREE.Material,
  soil: THREE.Material,
  water: THREE.Material,
): Built {
  const group = new THREE.Group();
  const owned: THREE.BufferGeometry[] = [];
  const endMaterials: THREE.Material[] = [];

  // ---- Floor ---------------------------------------------------------
  const floorGeo = new THREE.PlaneGeometry(NAVE.halfWidth * 2 + 1, NAVE.length + 1);
  floorGeo.rotateX(-Math.PI / 2);
  const floorMesh = new THREE.Mesh(floorGeo, floor);
  floorMesh.position.y = FLOOR_Y;
  group.add(floorMesh);
  owned.push(floorGeo);

  // ---- Ribs ----------------------------------------------------------
  // One arch per bay: a half torus standing on two short columns.
  const ironParts: THREE.BufferGeometry[] = [];
  const bays = Math.floor(NAVE.length / NAVE.bay);
  for (let i = 0; i <= bays; i++) {
    const z = -NAVE.length / 2 + i * NAVE.bay;
    const arch = new THREE.TorusGeometry(NAVE.radius, 0.075, 6, 22, Math.PI);
    arch.translate(0, NAVE.spring, 0);
    arch.rotateY(Math.PI / 2);
    arch.translate(0, 0, z);
    ironParts.push(arch);
    for (const side of [-1, 1]) {
      const col = new THREE.CylinderGeometry(0.085, 0.10, NAVE.spring, 7);
      col.translate(side * NAVE.halfWidth, NAVE.spring / 2, z);
      ironParts.push(col);
      /* Spandrel bracket: the quarter-round that fills the corner between
         the top of a column and the springing of the arch it carries.

         It used to be built by rotating a quarter torus about two axes with
         a different second rotation per side, which is a sure sign nobody
         had worked out where the ends were meant to land — and they did not
         land anywhere. Both brackets floated a foot clear of everything,
         at different angles, like croquet hoops somebody had thrown at the
         wall. Placing it by its ENDPOINTS instead is unambiguous.

         A quarter torus drawn from 0 to PI/2 runs from (r, 0) to (0, r).
         Put its centre 0.5m in from the wall and 0.5m below the springing
         and those two points are exactly the column and the arch. The left
         one is the same arc turned a quarter turn, not a different rotation
         order. */
      const br = new THREE.TorusGeometry(0.5, 0.035, 5, 10, Math.PI / 2);
      if (side < 0) br.rotateZ(Math.PI / 2);
      br.translate(side * (NAVE.halfWidth - 0.5), NAVE.spring - 0.5, z);
      ironParts.push(br);
    }
  }
  // Purlins running the length, tying the arches together.
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI;
    const x = Math.cos(a) * NAVE.radius;
    const y = NAVE.spring + Math.sin(a) * NAVE.radius;
    if (y < NAVE.spring - 0.01) continue;
    const p = new THREE.CylinderGeometry(0.035, 0.035, NAVE.length, 5);
    p.rotateX(Math.PI / 2);
    p.translate(x, y, 0);
    ironParts.push(p);
  }
  // Ridge.
  const ridge = new THREE.CylinderGeometry(0.09, 0.09, NAVE.length, 8);
  ridge.rotateX(Math.PI / 2);
  ridge.translate(0, NAVE.spring + NAVE.radius, 0);
  ironParts.push(ridge);

  const ironGeo = merge(ironParts);
  ironParts.forEach((g) => g.dispose());
  const ironMesh = new THREE.Mesh(ironGeo, iron);
  ironMesh.frustumCulled = false;
  group.add(ironMesh);
  owned.push(ironGeo);

  // ---- Glazing -------------------------------------------------------
  /* The vault is built vertex by vertex rather than from a rotated
     CylinderGeometry. Three rotations of a half-cylinder is two too many to
     hold in your head, and the first attempt put the open half facing the
     wrong way — from inside, the "roof" was a wall of glass directly in
     front of you and the whole realm was a pale blue rectangle. Explicit
     geometry cannot be ambiguous about which half it is.

     The uvs matter as much as the positions: v runs from the eaves (0) to
     the ridge (1), because that is the direction rain runs. */
  const vaultGeo = (() => {
    const segs = 44;
    const L = NAVE.length, R = NAVE.radius;
    const pos: number[] = [], nor: number[] = [], uvs: number[] = [];
    const push = (a: number, zf: number) => {
      const x = -Math.cos(a) * R;
      const y = NAVE.spring + Math.sin(a) * R;
      pos.push(x, y, -L / 2 + zf * L);
      // Inward normal — we only ever see this from underneath.
      nor.push(Math.cos(a), -Math.sin(a), 0);
      uvs.push(zf, Math.sin(a));
    };
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI;
      const a1 = ((i + 1) / segs) * Math.PI;
      push(a0, 0); push(a1, 0); push(a1, 1);
      push(a0, 0); push(a1, 1); push(a0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    return g;
  })();
  const vaultMesh = new THREE.Mesh(vaultGeo, glass);
  vaultMesh.frustumCulled = false;
  group.add(vaultMesh);
  owned.push(vaultGeo);

  /* The near end is glazed; the far end is a brick wall with a door in it.
     A glasshouse glazed at BOTH ends is a tube, and looking down a tube you
     see forty-eight metres of sky and nothing else — which is exactly what
     the first version looked like. The wall gives the walk a destination
     and gives the eye somewhere to stop. */
  {
    const gable = new THREE.CircleGeometry(NAVE.radius, 28, 0, Math.PI);
    gable.translate(0, NAVE.spring, NAVE.length / 2);
    group.add(new THREE.Mesh(gable, glass));
    owned.push(gable);
    const wall = new THREE.PlaneGeometry(NAVE.halfWidth * 2, NAVE.spring);
    wall.translate(0, NAVE.spring / 2, NAVE.length / 2);
    group.add(new THREE.Mesh(wall, glass));
    owned.push(wall);
  }
  // Side walls below the springing.
  for (const side of [-1, 1]) {
    const w = new THREE.PlaneGeometry(NAVE.length, NAVE.spring);
    w.rotateY(side * Math.PI / 2);
    w.translate(side * NAVE.halfWidth, NAVE.spring / 2, 0);
    const m = new THREE.Mesh(w, glass);
    group.add(m);
    owned.push(w);
  }

  // ---- The far wall ---------------------------------------------------
  // Brick, with a doorway that shows a lit corridor beyond — the one warm
  // thing in the room, and the thing you walk towards.
  {
    const endParts: THREE.BufferGeometry[] = [];
    const Z = -NAVE.length / 2;
    const DOOR_W = 1.6, DOOR_H = 2.5;
    // Wall in four pieces so the doorway is a real hole rather than a decal.
    const seg = (w: number, h: number, x: number, y: number) => {
      const g = new THREE.BoxGeometry(w, h, 0.5);
      g.translate(x, y, Z - 0.25);
      endParts.push(g);
    };
    const half = NAVE.halfWidth;
    seg(half - DOOR_W / 2, NAVE.spring + NAVE.radius * 0.7, -(half + DOOR_W / 2) / 2, (NAVE.spring + NAVE.radius * 0.7) / 2);
    seg(half - DOOR_W / 2, NAVE.spring + NAVE.radius * 0.7, (half + DOOR_W / 2) / 2, (NAVE.spring + NAVE.radius * 0.7) / 2);
    seg(DOOR_W, NAVE.spring + NAVE.radius * 0.7 - DOOR_H, 0, DOOR_H + (NAVE.spring + NAVE.radius * 0.7 - DOOR_H) / 2);
    const endGeo = merge(endParts);
    endParts.forEach((g) => g.dispose());
    /* Brick. It was drawn in the ironwork's cream paint, which at
       twenty-four metres and lit only by sky came back as one flat grey
       slab — the deadest area of the frame, and the thing the whole walk
       is aimed at. */
    const endMesh = new THREE.Mesh(endGeo, brick);
    endMesh.frustumCulled = false;
    group.add(endMesh);
    owned.push(endGeo);

    // What is through the door. A flat warm panel is enough — you never get
    // to walk through it, and a lit rectangle at the end of a long dim room
    // does more work than any amount of geometry behind it.
    const lit = new THREE.PlaneGeometry(DOOR_W, DOOR_H);
    lit.translate(0, DOOR_H / 2, Z - 0.55);
    const litMat = new THREE.MeshBasicMaterial({ color: 0xffcf8e });
    const litMesh = new THREE.Mesh(lit, litMat);
    group.add(litMesh);
    owned.push(lit);
    endMaterials.push(litMat);
  }

  // ---- Planting beds and the pool -------------------------------------
  const brickParts: THREE.BufferGeometry[] = [];
  const soilParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // A low brick kerb holding the soil back from the path.
    /* The bed runs wall to wall. It stopped 1.5m short of each gable,
       which from the near end showed as a slab of bare soil with a sharp
       square edge and then bare floor — the one place in the room where you
       could see it had been BUILT rather than grown. */
    const kerb = new THREE.BoxGeometry(0.34, 0.44, NAVE.length - 0.4);
    kerb.translate(side * 3.5, 0.22, 0);
    brickParts.push(kerb);
    /* The bed itself is EARTH, and used to be drawn in the brick material —
       so every bed had a flat orange lid with mortar courses in it, running
       the length of the room at knee height. Nothing else in the frame gave
       the game away faster. */
    const bed = new THREE.BoxGeometry(NAVE.halfWidth - 3.5, 0.38, NAVE.length - 0.4);
    bed.translate(side * (3.5 + (NAVE.halfWidth - 3.5) / 2), 0.19, 0);
    soilParts.push(bed);
  }
  // The pool: a sunken basin on the centre line, halfway down.
  const rim = new THREE.TorusGeometry(1.9, 0.16, 8, 30);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.16, 4);
  brickParts.push(rim);
  const brickGeo = merge(brickParts);
  brickParts.forEach((g) => g.dispose());
  const brickMesh = new THREE.Mesh(brickGeo, brick);
  brickMesh.frustumCulled = false;
  group.add(brickMesh);
  owned.push(brickGeo);

  const soilGeo = merge(soilParts);
  soilParts.forEach((g) => g.dispose());
  const soilMesh = new THREE.Mesh(soilGeo, soil);
  soilMesh.frustumCulled = false;
  group.add(soilMesh);
  owned.push(soilGeo);

  /* Water in the pool. Sixty-four segments because the rim is a torus of
     thirty and a disc coarser than its own kerb reads as a polygon. */
  const pond = new THREE.CircleGeometry(1.86, 64);
  pond.rotateX(-Math.PI / 2);
  pond.translate(0, 0.185, 4);
  const pondMesh = new THREE.Mesh(pond, water);
  group.add(pondMesh);
  owned.push(pond);

  return {
    group,
    dispose() {
      owned.forEach((g) => g.dispose());
      endMaterials.forEach((m) => m.dispose());
    },
  };
}
