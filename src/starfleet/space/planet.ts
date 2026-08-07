/**
 * A world, seen from orbit.
 *
 * Four shells, drawn back to front, and each one is doing a job the others
 * cannot:
 *
 * 1. **The body.** One sphere, one fragment shader. Terrain is six octaves of
 *    simplex noise evaluated on the unit sphere, so there are no seams and no
 *    texture to load. The height drives a five-stop colour ramp out of the
 *    world's own palette, then the sea line floods everything below it, then
 *    latitude lays caps on top. Nothing here is procedural in the sense of
 *    "random": the seed is the system key, so Vulcan has the same coastline
 *    every time you make orbit, which is the entire difference between a place
 *    and a screensaver.
 *
 * 2. **The night side.** The same shader, on the far side of the terminator.
 *    Inhabited worlds get a lamp-coloured mask keyed off the same noise field
 *    that made the land — so cities land on coasts and in valleys rather than
 *    in the sea — and uninhabited ones get nothing at all. This is the single
 *    strongest "someone lives here" signal the renderer has, and it costs four
 *    lines.
 *
 * 3. **The cloud deck.** A second sphere at 1.02 R with its own noise field,
 *    rotating slightly faster than the ground. It has to be a separate shell
 *    rather than a layer in the main shader because it must cast its own
 *    terminator and sit *above* the atmosphere's inner edge.
 *
 * 4. **The atmosphere.** A sphere at 1.055 R drawn back-faces-only and added.
 *    Fresnel against the view vector gives the limb; the dot against the sun
 *    gives the day-side brightening. Front faces would put a wash over the
 *    whole disc and flatten everything underneath it.
 *
 * The one rule that is easy to break and expensive to debug: **the shader is
 * lit by a direction, not by three.js's lighting.** These are `ShaderMaterial`s
 * and know nothing about the scene's lights, so `setSun` has to be called
 * every time the star moves. Forget it and the planet renders fully lit, which
 * looks fine in a screenshot and wrong the moment anything moves.
 */
import * as THREE from "three";
import { PLANET_R, hashString, makeRng } from "../types";
import type { PlanetSpec } from "../galaxy/systems";

/* Ashima Arts' 3D simplex noise, MIT. The one piece of GLSL in this world that
   is not hand-written, because writing another one would be worse and slower. */
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p, int oct, float gain, float lac){
  float a = 0.5, f = 1.0, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    s += a * snoise(p*f);
    n += a; a *= gain; f *= lac;
  }
  return s / max(n, 0.0001);
}
/* Ridged noise. Mountain chains rather than rolling hills — the difference
   between Vulcan reading as a desert and reading as a beach. */
float ridged(vec3 p, int oct){
  float a=0.5,f=1.0,s=0.0,n=0.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    float v = 1.0 - abs(snoise(p*f));
    s += a*v*v; n += a; a*=0.5; f*=2.1;
  }
  return s/max(n,0.0001);
}
`;

const BODY_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vNrm;
void main(){
  vPos = normalize(position);
  vNrm = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BODY_FRAG = /* glsl */ `
precision highp float;
${SIMPLEX}
varying vec3 vPos;
varying vec3 vNrm;

uniform vec3 uSun;        // unit, in view space
uniform vec3 uSunTint;
uniform vec3 c0,c1,c2,c3,c4,cPolar,cWater;
uniform float uSea, uVeg, uRelief, uCraters, uNight, uSeed, uIce;
uniform vec3 uLamp;

void main(){
  vec3 p = vPos * 1.7 + vec3(uSeed);

  // Continents: low-frequency fbm shaped by a ridged band. The pow() on the
  // ridge is what stops mountains from carpeting the whole globe.
  float base = fbm(p, 5, 0.5, 2.05) * 0.5 + 0.5;
  float ridge = ridged(p * 2.3, 5);
  float h = base * 0.72 + pow(ridge, 2.2) * 0.28 * uRelief;
  h += fbm(p * 8.0, 3, 0.5, 2.2) * 0.045 * uRelief;

  // Craters, on the airless and the old. Subtractive rings from a cellular-ish
  // band; masked to nothing when uCraters is 0 so nobody pays for them.
  if (uCraters > 0.01) {
    float cr = ridged(p * 5.5 + 31.0, 3);
    h -= smoothstep(0.62, 0.95, cr) * 0.13 * uCraters;
  }

  float lat = abs(vPos.y);
  bool water = h < uSea;

  vec3 albedo;
  float rough = 1.0;
  if (water) {
    // Depth shading: shelf to abyss, so coastlines read from orbit.
    float d = smoothstep(uSea - 0.16, uSea, h);
    albedo = mix(cWater * 0.55, cWater * 1.15, d);
    rough = 0.08;
  } else {
    float t = (h - uSea) / max(1.0 - uSea, 0.001);
    vec3 low  = mix(c0, c1, smoothstep(0.0, 0.30, t));
    vec3 mid  = mix(low, c2, smoothstep(0.22, 0.55, t));
    vec3 high = mix(mid, c3, smoothstep(0.50, 0.78, t));
    albedo    = mix(high, c4, smoothstep(0.74, 1.0, t));
    // Vegetation belt: a band of latitude, thinned at altitude and by a noise
    // field so the edge is a treeline rather than a stripe.
    float veg = uVeg * (1.0 - smoothstep(0.45, 0.95, lat)) * (1.0 - smoothstep(0.30, 0.72, t));
    veg *= smoothstep(0.35, 0.65, fbm(p * 3.1 + 11.0, 3, 0.5, 2.0) * 0.5 + 0.5);
    albedo = mix(albedo, c1 * 0.9, clamp(veg, 0.0, 1.0));
  }

  // Ice. Latitude plus a wobble, plus altitude so peaks whiten anywhere.
  float capEdge = 0.74 - uIce * 0.35;
  float cap = smoothstep(capEdge, capEdge + 0.14, lat + fbm(p * 4.0, 3, 0.5, 2.0) * 0.06);
  cap = max(cap, smoothstep(0.86, 0.97, h) * 0.85);
  albedo = mix(albedo, cPolar, clamp(cap, 0.0, 1.0));
  if (cap > 0.4) rough = 0.35;

  vec3 N = normalize(vNrm);
  float ndl = dot(N, uSun);

  // A soft terminator. A hard one is geometrically right for a body with no
  // air and wrong for every world in the catalogue that has some.
  float day = smoothstep(-0.12, 0.28, ndl);

  vec3 lit = albedo * uSunTint * (0.06 + day * 1.05);

  // Specular, water only. The glint is what tells you at a glance that the
  // blue is liquid rather than paint.
  if (water) {
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 H = normalize(uSun + V);
    float spec = pow(max(dot(N, H), 0.0), 60.0) * (1.0 - rough) * day;
    lit += uSunTint * spec * 1.6;
  }

  // Night side. Same noise field as the land, thresholded hard, so lights sit
  // where land is and cluster where the terrain is interesting.
  if (uNight > 0.01 && !water) {
    float city = fbm(p * 6.0 + 5.0, 4, 0.5, 2.1) * 0.5 + 0.5;
    city = smoothstep(0.66, 0.82, city);
    city *= 1.0 - smoothstep(0.55, 0.9, lat);
    city *= smoothstep(0.02, 0.22, h - uSea);
    float dark = 1.0 - smoothstep(-0.22, 0.06, ndl);
    lit += uLamp * city * dark * uNight * 0.9;
  }

  gl_FragColor = vec4(lit, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;
${SIMPLEX}
varying vec3 vPos;
varying vec3 vNrm;
uniform vec3 uSun, uSunTint, uTint;
uniform float uCover, uScale, uThick, uTime, uSeed;
void main(){
  // Two layers drifting at different rates. One layer reads as a texture; two
  // read as weather.
  vec3 p = vPos * uScale + vec3(uSeed * 0.7);
  float a = fbm(p + vec3(uTime * 0.004, 0.0, 0.0), 5, 0.5, 2.2) * 0.5 + 0.5;
  float b = fbm(p * 1.9 - vec3(uTime * 0.007, 0.0, 0.0), 4, 0.55, 2.1) * 0.5 + 0.5;
  float m = a * 0.65 + b * 0.35;

  float edge = 1.0 - uCover;
  float alpha = smoothstep(edge, edge + 0.18, m);
  if (alpha < 0.004) discard;

  float ndl = dot(normalize(vNrm), uSun);
  float day = smoothstep(-0.14, 0.30, ndl);
  // Self-shadowing: the underside of a thick deck is darker than its top.
  float thick = smoothstep(edge, edge + 0.5, m);
  vec3 c = uTint * uSunTint * (0.05 + day * (1.15 - thick * 0.30));
  gl_FragColor = vec4(c, alpha * (0.55 + uThick * 14.0));
}
`;

const AIR_VERT = /* glsl */ `
varying vec3 vNrm;
varying vec3 vView;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNrm = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const AIR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNrm;
varying vec3 vView;
uniform vec3 uColor, uSun;
uniform float uDensity;
void main(){
  // Back faces, so the normal points away: flip it to get the shell's outward
  // normal and the Fresnel comes out the right way round.
  vec3 N = normalize(-vNrm);
  float fres = pow(1.0 - max(dot(N, vView), 0.0), 2.6);
  float ndl = dot(N, uSun);
  // The limb is brightest where the sun is behind the planet's edge — that is
  // the forward-scattering rim you see from the ISS at orbital sunrise.
  float day = smoothstep(-0.55, 0.42, ndl);
  float glow = fres * day * uDensity;
  gl_FragColor = vec4(uColor * glow, glow);
}
`;

export interface Planet {
  group: THREE.Group;
  /** Call every frame with the sun direction *in world space*. */
  setSun(dirWorld: THREE.Vector3, tint: THREE.Color, camera: THREE.Camera): void;
  update(dt: number): void;
  dispose(): void;
}

const C = (hex: number) => new THREE.Color(hex);

export function createPlanet(spec: PlanetSpec, seedKey: string, segments = 96): Planet {
  const group = new THREE.Group();
  const seed = (hashString(seedKey) % 10000) / 97;
  const rng = makeRng(hashString(seedKey));

  const sunView = new THREE.Vector3(1, 0, 0);
  const tint = new THREE.Color(0xffffff);

  /* --- body --- */
  const bodyUniforms = {
    uSun: { value: sunView },
    uSunTint: { value: tint },
    c0: { value: C(spec.colors.c0) },
    c1: { value: C(spec.colors.c1) },
    c2: { value: C(spec.colors.c2) },
    c3: { value: C(spec.colors.c3) },
    c4: { value: C(spec.colors.c4) },
    cPolar: { value: C(spec.colors.polar) },
    cWater: { value: C(spec.colors.water) },
    uSea: { value: spec.sea },
    uVeg: { value: spec.veg },
    uRelief: { value: spec.relief },
    uCraters: { value: spec.craters },
    uNight: { value: spec.night },
    uLamp: { value: C(spec.lamp ?? 0xffd08a) },
    uSeed: { value: seed },
    uIce: { value: spec.kind === "ice" ? 1 : spec.kind === "desert" || spec.kind === "volcanic" ? 0.15 : 0.55 },
  };
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: bodyUniforms,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R, segments, segments / 2), bodyMat);
  group.add(body);

  /* --- clouds --- */
  let clouds: THREE.Mesh | null = null;
  let cloudMat: THREE.ShaderMaterial | null = null;
  if (spec.clouds) {
    cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: sunView },
        uSunTint: { value: tint },
        uTint: { value: C(spec.clouds.tint) },
        uCover: { value: spec.clouds.cover },
        uScale: { value: spec.clouds.scale },
        uThick: { value: spec.clouds.thick },
        uTime: { value: 0 },
        uSeed: { value: seed },
      },
      vertexShader: BODY_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_R * (1 + spec.clouds.alt), segments, segments / 2),
      cloudMat,
    );
    group.add(clouds);
  }

  /* --- atmosphere --- */
  let airMat: THREE.ShaderMaterial | null = null;
  if (spec.air.density > 0.01) {
    airMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: C(spec.air.color) },
        uSun: { value: sunView },
        uDensity: { value: spec.air.density },
      },
      vertexShader: AIR_VERT,
      fragmentShader: AIR_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.055, 64, 32), airMat));
  }

  /* --- rings --- */
  if (spec.rings) {
    const r = spec.rings;
    const geo = new THREE.RingGeometry(PLANET_R * r.inner, PLANET_R * r.outer, 192, 1);
    // RingGeometry's uv is unusable for a radial gradient, so bake the radius
    // into uv.x by hand. Without this the ring is a flat disc of one colour.
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (d / PLANET_R - r.inner) / (r.outer - r.inner), 0.5);
    }
    uv.needsUpdate = true;

    const tex = ringTexture(rng);
    const ring = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: tex,
        color: C(r.tint),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        opacity: 0.85,
      }),
    );
    ring.rotation.x = Math.PI / 2 + (r.tilt * Math.PI) / 180;
    group.add(ring);
  }

  /* --- moons --- */
  const moons: { mesh: THREE.Mesh; dist: number; speed: number; phase: number }[] = [];
  for (const m of spec.moons ?? []) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_R * m.radius * 0.28, 24, 16),
      new THREE.MeshLambertMaterial({ color: m.tint }),
    );
    group.add(mesh);
    moons.push({ mesh, dist: PLANET_R * m.dist * 0.42, speed: m.speed, phase: rng() * Math.PI * 2 });
  }

  group.rotation.z = (spec.tilt * Math.PI) / 180;

  let t = 0;
  const tmp = new THREE.Vector3();

  return {
    group,
    setSun(dirWorld, sunTint, camera) {
      // The shaders light in view space, so the direction has to be rotated
      // into it every frame — the camera moves constantly in orbit.
      tmp.copy(dirWorld).transformDirection(camera.matrixWorldInverse).normalize();
      sunView.copy(tmp);
      tint.copy(sunTint);
    },
    update(dt) {
      t += dt;
      body.rotation.y += dt * 0.012;
      if (clouds && cloudMat) {
        clouds.rotation.y += dt * 0.019;
        cloudMat.uniforms.uTime.value = t;
      }
      for (const m of moons) {
        const a = m.phase + t * m.speed * 0.1;
        m.mesh.position.set(Math.cos(a) * m.dist, Math.sin(a * 0.3) * m.dist * 0.12, Math.sin(a) * m.dist);
      }
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) {
          const withMap = mat as THREE.MeshBasicMaterial;
          withMap.map?.dispose?.();
          mat.dispose();
        }
      });
      group.parent?.remove(group);
    },
  };
}

/** A 1×N strip of banded transparency — Cassini divisions and all. Cheap, and
 *  it is the only thing that stops a ring reading as a hoop of plastic. */
function ringTexture(rng: () => number): THREE.DataTexture {
  const W = 512;
  const data = new Uint8Array(W * 4);
  const bands: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) bands.push([rng(), 0.02 + rng() * 0.09, 0.25 + rng() * 0.75]);
  for (let i = 0; i < W; i++) {
    const x = i / W;
    let a = 0.55 + Math.sin(x * 41) * 0.08;
    for (const [c, w, s] of bands) a *= 1 - Math.exp(-((x - c) ** 2) / (w * w)) * s;
    a *= Math.min(1, x * 8) * Math.min(1, (1 - x) * 6);
    const v = Math.max(0, Math.min(1, a));
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.round(v * 255);
  }
  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
