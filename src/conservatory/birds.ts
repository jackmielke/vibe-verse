/**
 * The sparrows that got in.
 *
 * There is always one. A building with sixty metres of glass and a door
 * somebody props open has birds in it, and they behave in a very particular
 * way that is worth copying exactly, because it is the difference between
 * "there is a bird" and "there is a bird IN HERE":
 *
 *  - They perch high, on the purlins and the ribs, out of reach.
 *  - They sit still for a long time and then go all at once.
 *  - The flight is not a curve between two points. It is a series of
 *    bounds: three or four fast wingbeats that lift, then a pause with the
 *    wings folded where they coast and fall. That undulation is the whole
 *    signature of a small bird and no amount of smooth interpolation will
 *    produce it.
 *  - They land short, hop, and settle.
 *
 * They are also the only things in this realm with any agency, which is a
 * larger effect than three birds ought to have. Everything else here — the
 * rain, the gusts, the light — happens TO the room. The sparrows are the
 * only part of it doing something for their own reasons, and a room where
 * something is going on without you is a room you are visiting rather than
 * a room that was built for you.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON } from "./shaders";
import { NAVE } from "./structure";

export interface Birds {
  group: THREE.Group;
  update(dt: number, t: number): void;
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

/**
 * A sparrow is almost always seen against the roof, which is the brightest
 * thing in the building — so it is a silhouette nine times out of ten, and
 * the tenth time it wants to be brown rather than black. Both, cheaply:
 * a dark body that picks up a little sky on its back and a warm edge where
 * the low sun catches it.
 */
function birdMaterial(uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
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
        if (dot(n, v) < 0.0) n = -n;
        // House sparrow: grey-brown, paler underneath.
        vec3 feather = mix(vec3(0.075, 0.058, 0.042), vec3(0.155, 0.128, 0.098),
                           n.y * 0.5 + 0.5);
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.004, 0.009));
        vec3 col = feather * (uSkyColor * 0.9
                            + uSunColor * max(0.0, dot(n, normalize(uSunDir))) * thru * 1.8);
        // The rim the low sun draws round anything small and fuzzy.
        col += uSunColor * pow(1.0 - max(0.0, dot(n, v)), 3.0) * thru * 0.35;
        gl_FragColor = vec4(humid(col, vWorld), 1.0);
      }
    `,
  });
}

/** Body, head, tail. Wings are separate so they can beat. */
function bodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.SphereGeometry(0.052, 8, 6);
  body.scale(1.0, 0.86, 1.5);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.033, 7, 5);
  head.translate(0, 0.026, 0.062);
  parts.push(head);
  const beak = new THREE.ConeGeometry(0.010, 0.028, 4);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.022, 0.092);
  parts.push(beak);
  const tail = new THREE.BoxGeometry(0.036, 0.006, 0.075);
  tail.translate(0, 0.004, -0.098);
  parts.push(tail);
  return mergeParts(parts);
}

/** One wing, hinged at the origin, reaching out along +x. */
function wingGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // A swept triangle pair — a bird's wing seen from any distance you will
  // ever see this one from is a shape, not a set of feathers.
  const v = new Float32Array([
    0, 0, 0.030, 0.105, 0, 0.010, 0.088, 0, -0.048,
    0, 0, 0.030, 0.088, 0, -0.048, 0, 0, -0.038,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

function mergeParts(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
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
  geos.forEach((g) => g.dispose());
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return out;
}

/** Somewhere a sparrow would actually sit. */
function perches(rand: () => number) {
  const out: THREE.Vector3[] = [];
  const HALF = NAVE.length / 2;
  // The purlins, which run the length of the house at fixed points on the arch.
  for (let k = 1; k <= 7; k++) {
    const a = (k / 8) * Math.PI;
    const x = Math.cos(a) * NAVE.radius;
    const y = NAVE.spring + Math.sin(a) * NAVE.radius;
    if (y < NAVE.spring) continue;
    for (let i = 0; i < 4; i++) {
      out.push(new THREE.Vector3(x * 0.97, y - 0.06, (rand() - 0.5) * (HALF * 1.7)));
    }
  }
  // The ridge.
  for (let i = 0; i < 5; i++) {
    out.push(new THREE.Vector3(0, NAVE.spring + NAVE.radius - 0.11,
                               (rand() - 0.5) * (HALF * 1.7)));
  }
  // And, much more rarely, the back of a bench or the rim of the pool —
  // which is the only time you ever get near one.
  out.push(new THREE.Vector3(-2.65, 0.90, -HALF + 9.0));
  out.push(new THREE.Vector3(2.65, 0.90, -HALF + 17.5));
  out.push(new THREE.Vector3(1.55, 0.34, 4));
  out.push(new THREE.Vector3(-1.75, 0.34, 4));
  return out;
}

interface Sparrow {
  root: THREE.Group;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Seconds left sitting still, or -1 while in the air. */
  wait: number;
  /** 0→1 across the current flight. */
  flight: number;
  duration: number;
  hop: number;
  facing: number;
}

export function buildBirds(uniforms: Record<string, THREE.IUniform>, count = 3): Birds {
  const group = new THREE.Group();
  const mat = birdMaterial(uniforms);
  const bodyGeo = bodyGeometry();
  const wingGeo = wingGeometry();
  const rand = rng(0x5add1e);
  const spots = perches(rand);
  const birds: Sparrow[] = [];

  for (let i = 0; i < count; i++) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mat);
    root.add(body);
    const wingL = new THREE.Mesh(wingGeo, mat);
    wingL.position.set(0.030, 0.020, 0.005);
    const wingR = new THREE.Mesh(wingGeo, mat);
    wingR.position.set(-0.030, 0.020, 0.005);
    wingR.scale.x = -1;
    root.add(wingL, wingR);
    const at = spots[Math.floor(rand() * spots.length)];
    root.position.copy(at);
    group.add(root);
    birds.push({
      root, wingL, wingR,
      from: at.clone(), to: at.clone(),
      wait: 2 + rand() * 12,
      flight: 1, duration: 1, hop: 0,
      facing: rand() * Math.PI * 2,
    });
  }
  group.frustumCulled = false;

  const tmp = new THREE.Vector3();

  return {
    group,
    update(dt) {
      for (const b of birds) {
        if (b.wait >= 0) {
          // --- perched ---------------------------------------------------
          b.wait -= dt;
          // Never completely still: a sparrow at rest twitches, and the
          // twitch is what stops it reading as an ornament.
          b.hop = Math.max(0, b.hop - dt * 3.4);
          if (rand() < dt * 0.55) b.hop = 1;
          b.root.position.y = b.to.y + b.hop * 0.022;
          b.root.rotation.set(0, b.facing + Math.sin(b.hop * 9.0) * 0.25, 0);
          b.wingL.rotation.z = -0.15;
          b.wingR.rotation.z = 0.15;
          if (b.wait < 0) {
            // Go. Somewhere far enough away to be worth flying to.
            let target = spots[Math.floor(rand() * spots.length)];
            for (let tries = 0; tries < 6 && target.distanceTo(b.to) < 6; tries++) {
              target = spots[Math.floor(rand() * spots.length)];
            }
            b.from.copy(b.to);
            b.to.copy(target);
            b.flight = 0;
            b.duration = 0.55 + b.from.distanceTo(b.to) * 0.055;
          }
          continue;
        }

        // --- in the air ---------------------------------------------------
        b.flight += dt / b.duration;
        if (b.flight >= 1) {
          b.flight = 1;
          b.wait = 3 + rand() * 16;
          b.facing = rand() * Math.PI * 2;
        }
        const u = b.flight;
        tmp.lerpVectors(b.from, b.to, u);
        /* THE BOUNDING FLIGHT. Three or four bursts of wingbeats that lift,
           each followed by a coast that falls — a smooth arc between the
           two perches would read as a thrown stone. `beats` is how many
           bursts fit in this trip; longer flights get more of them, which
           is why a sparrow crossing a big room undulates more times than
           one hopping between neighbouring purlins. */
        const beats = Math.max(2, Math.round(b.duration * 3.2));
        const phase = u * beats;
        const bound = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
        // Lift while beating, fall while coasting; damped at both ends so it
        // leaves and arrives on the perch rather than above it.
        const ends = Math.sin(u * Math.PI);
        tmp.y += (bound - 0.35) * 0.30 * ends;
        // And a lazy sideways weave, because nothing flies in a plane.
        const side = Math.sin(u * Math.PI * 1.7 + b.facing) * 0.30 * ends;
        tmp.x += side * 0.7;
        tmp.z += side * 0.3;
        b.root.position.copy(tmp);

        // Face the way it is going.
        const ahead = b.to.clone().sub(b.from);
        b.root.rotation.set(
          -Math.atan2(ahead.y, Math.hypot(ahead.x, ahead.z)) * 0.35,
          Math.atan2(ahead.x, ahead.z),
          Math.sin(phase * Math.PI * 2) * 0.30,
          "YXZ",
        );

        /* Wings beat hard through the rising half of each bound and fold
           through the falling half. Folding — not slowing — is what makes
           the coast read; a bird that keeps flapping while it drops looks
           like it is struggling rather than saving effort. */
        const rising = bound > 0.5;
        const flap = rising ? Math.sin(phase * Math.PI * 14.0) * 1.15 : -0.9;
        b.wingL.rotation.z = -0.15 + flap;
        b.wingR.rotation.z = 0.15 - flap;
      }
    },
    dispose() {
      bodyGeo.dispose();
      wingGeo.dispose();
      mat.dispose();
    },
  };
}
