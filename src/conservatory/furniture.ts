/**
 * The things people leave in a glasshouse.
 *
 * WHAT SEPARATED THIS ROOM FROM A PHOTOGRAPH OF ONE WAS NOT LIGHT. The
 * light was already doing its job — soft shadows, a shared canopy, bars off
 * the roof landing where they should. What the room had was a floor, two
 * beds, a pool and nothing else, and a room with no objects in it does not
 * read as a place somebody works in. It reads as an architectural render:
 * correct, and empty.
 *
 * So: benches to sit on, clay pots stacked where somebody put them down,
 * a watering can nobody put away, and labels stuck in the beds. None of it
 * does anything. All of it is at HUMAN SCALE, which is the actual job —
 * a 48m nave has no scale of its own, and a bench you could sit on is what
 * tells you how big the palms are.
 *
 * They are placed deliberately rather than scattered: an object dropped at
 * random reads as debris, and an object squared up to a kerb reads as
 * having been put there. That difference is most of the effect, and it is
 * why this is a list of positions and not another instanced buffer.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON } from "./shaders";
import { NAVE } from "./structure";

export interface Furniture {
  group: THREE.Group;
  dispose(): void;
}

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

/** Merge, positions and normals only. */
function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
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

/**
 * Unfired terracotta.
 *
 * A pot is the one object in here whose colour everybody already knows, so
 * it is worth getting the two things right that make clay look like clay:
 * it is porous, so it goes dark where it stays wet — around the base, and
 * in a band under the rim where the water runs off; and it grows a green
 * bloom of algae on the shaded side, which in a glasshouse is every side.
 */
function terracottaMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      ${CONSERVATORY_COMMON}
      void main(){
        vec3 n = normalize(vNormal);
        vec3 clay = mix(vec3(0.38, 0.185, 0.115), vec3(0.52, 0.275, 0.175),
                        fbm(vWorld.xz * 22.0 + vWorld.y * 9.0));
        // Damp low down, where it sits in a saucer of its own drainage.
        float damp = smoothstep(0.30, 0.0, vWorld.y - floor(vWorld.y));
        clay *= 1.0 - 0.30 * damp;
        // Algae, heavier on whatever faces away from the glass.
        float bloom = smoothstep(0.50, 0.85, fbm(vWorld.xz * 5.0 + vWorld.y * 3.0))
                    * (0.55 - 0.45 * n.y);
        clay = mix(clay, vec3(0.135, 0.185, 0.105), clamp(bloom, 0.0, 0.65));
        // Old lime, drawn out of the clay and left in a ring near the rim.
        clay = mix(clay, vec3(0.62, 0.58, 0.50),
                   smoothstep(0.72, 0.92, fbm(vLocal.xz * 30.0)) * 0.25);

        float can = canopyShade(vWorld);
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.009, 0.019));
        vec3 sky = uSkyColor * (0.66 + 0.52 * (n.y * 0.5 + 0.5)) * mix(0.60, 1.0, can);
        vec3 col = clay * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir)))
                                 * thru * can * 1.5);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

/**
 * Cast iron and galvanised steel: benches, the watering can, the tap.
 *
 * Distinct from the building's painted ironwork on purpose — the structure
 * is cream and flaking, and the furniture is dark green and waxy, which is
 * how you tell at a glance what is holding the roof up and what somebody
 * carried in.
 */
function castMaterial(uniforms: Record<string, THREE.IUniform>) {
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
        float wear = smoothstep(0.42, 0.72, fbm(vWorld.xz * 6.0 + vWorld.y * 2.5));
        // Dark green paint, rusting through at the edges.
        vec3 paint = mix(vec3(0.075, 0.115, 0.088), vec3(0.235, 0.115, 0.062), wear * 0.7);
        float can = canopyShade(vWorld);
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.008, 0.017));
        vec3 sky = uSkyColor * (0.85 + 0.65 * (n.y * 0.5 + 0.5)) * mix(0.62, 1.0, can);
        vec3 col = paint * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir)))
                                  * thru * can * 2.0);
        // Wet metal keeps a broad sheen along its edges.
        col += uSkyColor * pow(1.0 - max(0.0, dot(n, v)), 3.5) * (0.14 + uRain * 0.22);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

/** Timber: the bench slats and the staging. */
function timberMaterial(uniforms: Record<string, THREE.IUniform>) {
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
        // Grain along the length of the slat, which is along z here.
        float grain = fbm(vec2(vWorld.z * 26.0, vWorld.x * 3.0 + vWorld.y * 3.0));
        vec3 wood = mix(vec3(0.185, 0.135, 0.088), vec3(0.30, 0.235, 0.155), grain);
        // Weathered grey where the rain gets at it, green where it does not dry.
        wood = mix(wood, vec3(0.215, 0.215, 0.195),
                   smoothstep(0.55, 0.9, fbm(vWorld.xz * 3.0)) * 0.45);
        float can = canopyShade(vWorld);
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.008, 0.017));
        vec3 sky = uSkyColor * (0.80 + 0.55 * (n.y * 0.5 + 0.5)) * mix(0.62, 1.0, can);
        vec3 col = wood * (sky + uSunColor * max(0.0, dot(n, normalize(uSunDir)))
                                 * thru * can * 1.8);
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------
// The objects
// ---------------------------------------------------------------------

/** A flowerpot: a truncated cone plus a rolled rim, at the origin. */
function pot(r: number, h: number, into: THREE.BufferGeometry[]) {
  const body = new THREE.CylinderGeometry(r, r * 0.72, h, 12, 1, true);
  body.translate(0, h / 2, 0);
  into.push(body);
  const rim = new THREE.TorusGeometry(r * 0.98, r * 0.09, 5, 14);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, h - r * 0.05, 0);
  into.push(rim);
  // A disc of soil, sunk a little below the rim. An empty pot reads hollow.
  const soil = new THREE.CircleGeometry(r * 0.93, 12);
  soil.rotateX(-Math.PI / 2);
  soil.translate(0, h * 0.82, 0);
  into.push(soil);
}

/**
 * A Victorian park bench: two cast ends, five timber slats.
 *
 * Its actual purpose is to be 45cm high, because that is a number every
 * person already knows in their body, and it is what makes the palms read
 * as four metres rather than as a texture.
 */
function bench(x: number, z: number, facing: number,
               cast: THREE.BufferGeometry[], wood: THREE.BufferGeometry[]) {
  const W = 1.7;
  const m = new THREE.Matrix4()
    .makeRotationY(facing)
    .setPosition(x, 0, z);
  const add = (g: THREE.BufferGeometry, into: THREE.BufferGeometry[]) => {
    g.applyMatrix4(m);
    into.push(g);
  };
  for (const s of [-1, 1]) {
    // Legs, splayed, with a scrolled arm — a torus quarter reads as cast
    // iron from any distance a person will ever see it from.
    const leg = new THREE.BoxGeometry(0.06, 0.44, 0.055);
    leg.translate(s * (W / 2 - 0.06), 0.22, 0.20);
    add(leg, cast);
    const leg2 = new THREE.BoxGeometry(0.06, 0.44, 0.055);
    leg2.translate(s * (W / 2 - 0.06), 0.22, -0.20);
    add(leg2, cast);
    const rail = new THREE.BoxGeometry(0.055, 0.05, 0.50);
    rail.translate(s * (W / 2 - 0.06), 0.44, 0);
    add(rail, cast);
    // Back stile, raked.
    const stile = new THREE.BoxGeometry(0.05, 0.52, 0.05);
    stile.translate(s * (W / 2 - 0.06), 0.70, -0.20);
    add(stile, cast);
    const scroll = new THREE.TorusGeometry(0.16, 0.022, 5, 12, Math.PI * 1.2);
    scroll.rotateY(Math.PI / 2);
    scroll.translate(s * (W / 2 - 0.06), 0.60, -0.05);
    add(scroll, cast);
  }
  // Seat slats, then back slats.
  for (let i = 0; i < 3; i++) {
    const sl = new THREE.BoxGeometry(W, 0.035, 0.115);
    sl.translate(0, 0.455, 0.17 - i * 0.15);
    add(sl, wood);
  }
  for (let i = 0; i < 2; i++) {
    const sl = new THREE.BoxGeometry(W, 0.115, 0.032);
    sl.translate(0, 0.66 + i * 0.19, -0.21);
    add(sl, wood);
  }
}

/** A galvanised watering can. Body, spout, handle. */
function wateringCan(x: number, z: number, turn: number, into: THREE.BufferGeometry[]) {
  const m = new THREE.Matrix4().makeRotationY(turn).setPosition(x, 0, z);
  const add = (g: THREE.BufferGeometry) => { g.applyMatrix4(m); into.push(g); };
  const body = new THREE.CylinderGeometry(0.115, 0.135, 0.27, 12);
  body.translate(0, 0.135, 0);
  add(body);
  const spout = new THREE.CylinderGeometry(0.022, 0.038, 0.42, 7);
  spout.rotateZ(-0.62);
  spout.translate(0.20, 0.23, 0);
  add(spout);
  const rose = new THREE.CylinderGeometry(0.055, 0.038, 0.05, 8);
  rose.rotateZ(-0.62);
  rose.translate(0.32, 0.32, 0);
  add(rose);
  const handle = new THREE.TorusGeometry(0.10, 0.014, 5, 12, Math.PI);
  handle.rotateY(Math.PI / 2);
  handle.translate(-0.02, 0.29, 0);
  add(handle);
}

export function buildFurniture(uniforms: Record<string, THREE.IUniform>): Furniture {
  const group = new THREE.Group();
  const owned: THREE.BufferGeometry[] = [];
  const clayMat = terracottaMaterial(uniforms);
  const castMat = castMaterial(uniforms);
  const woodMat = timberMaterial(uniforms);

  const clay: THREE.BufferGeometry[] = [];
  const cast: THREE.BufferGeometry[] = [];
  const wood: THREE.BufferGeometry[] = [];
  const r = rng(0xc0ffee);

  /* Benches, backs to the beds, spaced down the nave. Not opposite each
     other — a facing pair reads as a waiting room. */
  const HALF = NAVE.length / 2;
  bench(-2.65, -HALF + 9.0, Math.PI / 2 + 0.06, cast, wood);
  bench(2.65, -HALF + 17.5, -Math.PI / 2 - 0.04, cast, wood);
  bench(-2.65, -HALF + 30.0, Math.PI / 2 - 0.05, cast, wood);
  bench(2.65, -HALF + 40.0, -Math.PI / 2 + 0.07, cast, wood);

  /* Pots. Three ways they occur in a real glasshouse, and all three are
     needed, because a row of identical pots is a garden centre:
       - stacked empties, nested, tipped slightly, against a kerb
       - a group of three planted ones squared up to the path
       - one on its side that somebody knocked over and left */
  const potSpots = [
    { x: -3.05, z: -HALF + 5.5 }, { x: 3.05, z: -HALF + 12.0 },
    { x: -3.05, z: -HALF + 21.0 }, { x: 3.02, z: -HALF + 27.0 },
    { x: -3.02, z: -HALF + 35.5 }, { x: 3.05, z: -HALF + 44.0 },
  ];
  for (const spot of potSpots) {
    const kind = Math.floor(r() * 3);
    if (kind === 0) {
      // A nested stack. Each one sits a few centimetres into the last.
      const n = 3 + Math.floor(r() * 3);
      const rad = 0.17 + r() * 0.05;
      for (let i = 0; i < n; i++) {
        const parts: THREE.BufferGeometry[] = [];
        pot(rad, 0.22, parts);
        const tilt = new THREE.Matrix4().makeRotationZ((r() - 0.5) * 0.10);
        const at = new THREE.Matrix4().setPosition(spot.x, i * 0.055, spot.z);
        for (const g of parts) { g.applyMatrix4(tilt); g.applyMatrix4(at); clay.push(g); }
      }
    } else if (kind === 1) {
      // A group of three, different sizes, squared up.
      for (let i = 0; i < 3; i++) {
        const rad = 0.14 + r() * 0.11;
        const parts: THREE.BufferGeometry[] = [];
        pot(rad, rad * 1.35, parts);
        const at = new THREE.Matrix4().setPosition(
          spot.x + (i - 1) * 0.34 * Math.sign(spot.x || 1) * 0.35,
          0,
          spot.z + (i - 1) * 0.38,
        );
        for (const g of parts) { g.applyMatrix4(at); clay.push(g); }
      }
    } else {
      // One on its side. Nobody picked it up.
      const parts: THREE.BufferGeometry[] = [];
      pot(0.19, 0.25, parts);
      const roll = new THREE.Matrix4().makeRotationX(Math.PI / 2 + (r() - 0.5) * 0.3);
      const at = new THREE.Matrix4()
        .makeRotationY(r() * Math.PI * 2)
        .setPosition(spot.x, 0.19, spot.z);
      for (const g of parts) { g.applyMatrix4(roll); g.applyMatrix4(at); clay.push(g); }
      // And an upright one beside it, so it reads as dropped rather than placed.
      const up: THREE.BufferGeometry[] = [];
      pot(0.19, 0.25, up);
      const at2 = new THREE.Matrix4().setPosition(spot.x + 0.05, 0, spot.z + 0.46);
      for (const g of up) { g.applyMatrix4(at2); clay.push(g); }
    }
  }

  /* DRAINS. A glasshouse floor is watered with a hose twice a day and has
     to take it somewhere, so it falls to a channel down the middle with
     cast gratings in it at intervals. Two bars of iron in a tiled floor,
     and the floor stops being a texture and becomes a thing that was
     PLUMBED — which is a surprising amount of what "real building" means. */
  for (let i = 0; i < 6; i++) {
    const z = -HALF + 4.5 + i * 8.2;
    const frame = new THREE.BoxGeometry(0.46, 0.035, 0.46);
    frame.translate(0, 0.018, z);
    cast.push(frame);
    // Slots, sunk just below the frame so they read as holes.
    for (let k = 0; k < 5; k++) {
      const bar = new THREE.BoxGeometry(0.40, 0.03, 0.032);
      bar.translate(0, 0.030, z - 0.16 + k * 0.08);
      cast.push(bar);
    }
  }

  // Two watering cans, left where somebody was last working.
  wateringCan(-3.02, -HALF + 14.2, 0.9, cast);
  wateringCan(3.0, -HALF + 33.0, -2.1, cast);

  /* Labels. Little zinc tags on wire, stuck in the beds. Individually
     invisible; collectively they are the difference between a jungle and a
     COLLECTION, which is what a glasshouse like this actually is. */
  for (let i = 0; i < 46; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (3.75 + r() * 1.5);
    const z = (r() - 0.5) * (NAVE.length - 8);
    const wire = new THREE.CylinderGeometry(0.006, 0.006, 0.34, 4);
    wire.translate(x, 0.55, z);
    cast.push(wire);
    const tag = new THREE.BoxGeometry(0.10, 0.055, 0.004);
    tag.rotateY(r() * 0.9 - 0.45);
    tag.translate(x, 0.74, z);
    cast.push(tag);
  }

  /* LEAF LITTER. Sixty feet of path with nothing on it is the last thing
     in here that only a computer would produce: a room full of plants that
     drop things, swept to a shine. Real litter is not scattered evenly —
     it is blown to the EDGES, banked against the kerbs and in the lee of
     anything standing on the floor, and thin in the middle where feet go.
     Placing it that way costs nothing and is the whole difference between
     "leaves on the floor" and "nobody has swept since Tuesday". */
  for (let i = 0; i < 320; i++) {
    const side = r() < 0.5 ? -1 : 1;
    // Biased hard towards the kerb: a squared random lands most of them in
    // the outer third of the path.
    const t = r() * r();
    const x = side * (3.30 - t * 2.9);
    const z = (r() - 0.5) * (NAVE.length - 4);
    const len = 0.085 + r() * 0.11;
    const leaf = new THREE.PlaneGeometry(len * 0.42, len, 1, 2);
    const pos = leaf.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      // Curled, and lying at a slight angle — a dry leaf never lies flat.
      const yy = pos.getY(v);
      pos.setZ(v, Math.abs(pos.getX(v)) * 0.55 + (yy / len) * 0.02);
    }
    leaf.computeVertexNormals();
    leaf.rotateX(-Math.PI / 2 + (r() - 0.5) * 0.35);
    leaf.rotateY(r() * Math.PI * 2);
    leaf.translate(x, 0.004 + r() * 0.008, z);
    wood.push(leaf);
  }

  for (const [parts, mat] of [
    [clay, clayMat], [cast, castMat], [wood, woodMat],
  ] as [THREE.BufferGeometry[], THREE.Material][]) {
    const geo = merge(parts);
    parts.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    owned.push(geo);
  }

  return {
    group,
    dispose() {
      owned.forEach((g) => g.dispose());
      clayMat.dispose(); castMat.dispose(); woodMat.dispose();
    },
  };
}
