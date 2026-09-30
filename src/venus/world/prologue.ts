/**
 * The way there.
 *
 * Two small scenes before the clouds. The Moon, where the lunar mass driver
 * throws a satellite into solar orbit every few seconds for the price of
 * electricity — and then throws you. And the transfer: everybody else went
 * uphill, out to Mars; Venus is downhill, sunward, and the capsule simply
 * falls toward it.
 */
import * as THREE from "three";
import { NOISE } from "./shaders";

const RAIL_START = -2600;
const RAIL_END = 2600;
const railY = (x: number) => 14 + Math.max(0, x - 900) * 0.045 + Math.max(0, x - 1900) * 0.07;

function stars(n: number, r: number, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
    const k = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * k * r, u * r, Math.sin(a) * k * r], i * 3);
    const b = 0.4 + Math.pow(rnd(), 3) * 2.2;
    const warm = rnd();
    col.set([b * (0.85 + warm * 0.15), b * 0.92, b * (1.05 - warm * 0.2)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}

const PLANET_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main() {
  vP = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const EARTH_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform float uTime;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main() {
  vec3 p = normalize(vP);
  vec2 q = vec2(atan(p.z, p.x) * 1.4, asin(p.y) * 2.2);
  float land = smoothstep(0.52, 0.56, vfbm(q * 2.2 + 4.0));
  float cloud = smoothstep(0.5, 0.75, vfbm(q * 3.0 + vec2(uTime * 0.01, 0.0)));
  float ice = smoothstep(0.78, 0.9, abs(p.y));
  vec3 col = mix(vec3(0.02, 0.09, 0.28), mix(vec3(0.12, 0.28, 0.08), vec3(0.45, 0.38, 0.22), vfbm(q * 6.0)), land);
  col = mix(col, vec3(0.9), ice);
  col = mix(col, vec3(1.0), cloud * 0.85);
  float l = max(dot(normalize(vN), uSun), 0.0);
  vec3 v = normalize(cameraPosition - vW);
  float rim = pow(1.0 - max(dot(normalize(vN), v), 0.0), 3.0);
  vec3 outc = col * (0.03 + l * 1.3) + vec3(0.3, 0.55, 1.0) * rim * (0.2 + l);
  gl_FragColor = vec4(outc, 1.0);
}
`;

const VENUS_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform float uTime;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main() {
  vec3 p = normalize(vP);
  float lat = asin(p.y);
  float lon = atan(p.z, p.x);
  // The Y: chevrons pointing west, combed out by the super-rotation.
  vec2 q = vec2(lon * 1.2 + abs(lat) * 1.8 + uTime * 0.02, lat * 5.0);
  float b = vfbm(q * vec2(1.4, 1.0) + vfbm(q * 2.0) * 0.8);
  vec3 col = mix(vec3(0.78, 0.62, 0.38), vec3(1.0, 0.93, 0.78), b);
  col = mix(col, vec3(0.92, 0.84, 0.66), smoothstep(0.6, 1.2, abs(lat)));
  float l = max(dot(normalize(vN), uSun), 0.0);
  vec3 v = normalize(cameraPosition - vW);
  float rim = pow(1.0 - max(dot(normalize(vN), v), 0.0), 2.0);
  vec3 outc = col * (0.02 + pow(l, 0.8) * 1.35) + vec3(1.0, 0.8, 0.5) * rim * l * 0.6;
  gl_FragColor = vec4(outc, 1.0);
}
`;

function planet(frag: string, radius: number, sun: THREE.Vector3) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sun }, uTime: { value: 0 } },
    vertexShader: PLANET_VERT,
    fragmentShader: NOISE + frag,
    defines: { OCTAVES: 5 },
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 40), m);
}

function glowSprite(color: number, size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

/* =============================================================== the Moon */

export class MoonScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private coils: THREE.InstancedMesh;
  private coilX: number[] = [];
  private coilHeat: Float32Array;
  private capsule: THREE.Group;
  private capsuleGlow: THREE.Sprite;
  private bolts: Array<{ m: THREE.Sprite; x: number; v: number; t: number; free: boolean; vy: number; y: number; z: number }> = [];
  private bolt: THREE.Sprite;
  private sun = new THREE.Vector3(-0.55, 0.22, -0.35).normalize();
  private earth: THREE.Mesh;
  t = 0;
  fired = -1;
  private nextBolt = 0.6;
  private cold = new THREE.Color(0.25, 0.16, 0.1);
  private hot = new THREE.Color(0.6, 3.2, 4.0);
  /** 0..1, how far the capsule is down the rail. */
  progress = 0;
  done = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 1, 60000);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(stars(3500, 30000, 11));

    const sunL = new THREE.DirectionalLight(0xffffff, 3.0);
    sunL.position.copy(this.sun).multiplyScalar(1000);
    this.scene.add(sunL);
    this.scene.add(new THREE.HemisphereLight(0x3a4a66, 0x1a1a1a, 0.22));
    const sunSprite = glowSprite(0xfff2d0, 2600);
    sunSprite.position.copy(this.sun).multiplyScalar(26000);
    this.scene.add(sunSprite);

    // Regolith, cratered.
    const geo = new THREE.PlaneGeometry(16000, 16000, 240, 240);
    geo.rotateX(-Math.PI / 2);
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const craters: Array<[number, number, number]> = [];
    for (let i = 0; i < 70; i++) {
      const r = 60 + Math.pow(rnd(), 2.2) * 900;
      let x = (rnd() - 0.5) * 15000, z = (rnd() - 0.5) * 15000;
      if (Math.abs(z) < r + 120 && x > RAIL_START - 200 && x < RAIL_END + 200) z += Math.sign(z || 1) * (r + 300);
      craters.push([x, z, r]);
    }
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let y = Math.sin(x * 0.0011) * 30 + Math.cos(z * 0.0009 + 1) * 40 + Math.sin((x + z) * 0.004) * 6;
      for (const [cx, cz, r] of craters) {
        const d = Math.hypot(x - cx, z - cz) / r;
        if (d < 1.6) {
          y += d < 1 ? -(1 - d * d) * r * 0.22 : 0;
          y += Math.exp(-Math.pow((d - 1) * 5, 2)) * r * 0.08;
        }
      }
      // A graded strip for the rail.
      const strip = Math.exp(-Math.pow(z / 90, 2));
      y = y * (1 - strip) + strip * 0;
      pos.setY(i, y - 2);
    }
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9c9a97, roughness: 1, metalness: 0 }));
    this.scene.add(ground);

    // The rail: two beams, pylons, and a coil every forty metres.
    const beamMat = new THREE.MeshStandardMaterial({ color: 0xb9b4ad, roughness: 0.5, metalness: 0.6 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3b3835, roughness: 0.6, metalness: 0.5 });
    const seg = 40;
    const n = Math.floor((RAIL_END - RAIL_START) / seg);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const beams = new THREE.InstancedMesh(box, beamMat, n * 2);
    const pylons = new THREE.InstancedMesh(box, darkMat, n);
    this.coils = new THREE.InstancedMesh(new THREE.TorusGeometry(7, 1.1, 8, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.coilHeat = new Float32Array(n);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const x0 = RAIL_START + i * seg, x1 = x0 + seg;
      const y0 = railY(x0), y1 = railY(x1);
      const mid = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
      const pitch = Math.atan2(y1 - y0, seg);
      q.setFromEuler(new THREE.Euler(0, 0, pitch));
      for (const side of [-3.2, 3.2]) {
        m4.compose(new THREE.Vector3(mid.x, mid.y - 4, side), q, new THREE.Vector3(seg + 0.5, 1.4, 1.2));
        beams.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), m4);
      }
      m4.compose(new THREE.Vector3(x0, y0 / 2 - 4, 0), new THREE.Quaternion(), new THREE.Vector3(3, Math.max(1, y0), 3));
      pylons.setMatrixAt(i, m4);
      const cq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, pitch));
      m4.compose(new THREE.Vector3(x0, y0, 0), cq, new THREE.Vector3(1, 1, 1));
      this.coils.setMatrixAt(i, m4);
      this.coils.setColorAt(i, this.cold);
      this.coilX.push(x0);
    }
    this.scene.add(beams, pylons, this.coils);

    // The yard at the breech: assembly halls and a stack of satellites.
    const hall = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.6 });
    const lit = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.6, 1.0) });
    for (let i = 0; i < 5; i++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(80 + i * 10, 26 + i * 6, 60), hall);
      h.position.set(RAIL_START - 160 - i * 30, 10, (i % 2 ? 1 : -1) * (120 + i * 70));
      this.scene.add(h);
      const w = new THREE.Mesh(new THREE.BoxGeometry(60, 3, 61), lit);
      w.position.copy(h.position).add(new THREE.Vector3(0, 6, 0));
      this.scene.add(w);
    }
    const dome = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), hall);
    dome.position.set(RAIL_START - 380, 0, 40);
    this.scene.add(dome);

    // Earth, over the far end of the rail.
    this.earth = planet(EARTH_FRAG, 700, this.sun);
    this.earth.position.set(6000, 2600, -5200);
    this.scene.add(this.earth);

    // The capsule.
    this.capsule = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.35, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 12, 20), white);
    body.rotation.z = -Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 20), white);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = 9;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(3.05, 3.05, 1.2, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.6, 0.6) }));
    band.rotation.z = -Math.PI / 2;
    band.position.x = -3;
    this.capsule.add(body, nose, band);
    this.capsuleGlow = glowSprite(0x9ff4ff, 40);
    this.capsuleGlow.position.x = -8;
    this.capsule.add(this.capsuleGlow);
    this.capsule.position.set(RAIL_START + 10, railY(RAIL_START), 0);
    this.scene.add(this.capsule);

    this.bolt = glowSprite(0x9ff4ff, 26);
  }

  fire() {
    if (this.fired < 0) this.fired = this.t;
  }

  update(dt: number) {
    this.t += dt;
    (this.earth.material as THREE.ShaderMaterial).uniforms.uTime.value = this.t;
    this.earth.rotation.y += dt * 0.01;

    // Satellites, every few seconds, until it is your turn.
    this.nextBolt -= dt;
    if (this.nextBolt <= 0 && this.fired < 0) {
      this.nextBolt = 2.6;
      const m = this.bolt.clone();
      m.material = (this.bolt.material as THREE.SpriteMaterial).clone();
      this.scene.add(m);
      this.bolts.push({ m, x: RAIL_START, v: 0, t: 0, free: false, vy: 0, y: 0, z: 0 });
    }
    for (const b of [...this.bolts]) {
      b.t += dt;
      if (!b.free) {
        b.v += 1400 * dt;
        b.x += b.v * dt;
        this.heat(b.x);
        b.m.position.set(b.x, railY(b.x), 0);
        if (b.x >= RAIL_END) { b.free = true; b.vy = b.v * 0.16; b.y = railY(RAIL_END); b.z = 0; }
      } else {
        b.x += b.v * dt;
        b.y += b.vy * dt;
        b.m.position.set(b.x, b.y, b.z);
        (b.m.material as THREE.SpriteMaterial).opacity *= Math.exp(-dt * 0.6);
      }
      if (b.t > 12) {
        this.scene.remove(b.m);
        (b.m.material as THREE.Material).dispose();
        this.bolts.splice(this.bolts.indexOf(b), 1);
      }
    }

    // You.
    let camTarget: THREE.Vector3;
    let camPos: THREE.Vector3;
    if (this.fired < 0) {
      const k = Math.min(1, this.t / 14);
      camPos = new THREE.Vector3(RAIL_START - 160 + k * 90, 26 + k * 8, 110 - k * 30);
      camTarget = new THREE.Vector3(RAIL_START + 900, 160 + k * 60, -260);
      this.capsuleGlow.material.opacity = 0.4 + Math.sin(this.t * 4) * 0.2;
    } else {
      const ft = this.t - this.fired;
      const a = 620;
      let x = RAIL_START + 10 + 0.5 * a * ft * ft;
      let y: number;
      let vx = a * ft;
      if (x < RAIL_END) {
        y = railY(x);
        this.heat(x);
        this.progress = (x - RAIL_START) / (RAIL_END - RAIL_START);
      } else {
        const tEnd = Math.sqrt((2 * (RAIL_END - RAIL_START - 10)) / a);
        const dtf = ft - tEnd;
        vx = a * tEnd;
        x = RAIL_END + vx * dtf;
        y = railY(RAIL_END) + vx * 0.2 * dtf + 30 * dtf * dtf;
        this.progress = 1;
        if (dtf > 4.5) this.done = true;
      }
      this.capsule.position.set(x, y, 0);
      this.capsule.rotation.z = Math.atan2(x < RAIL_END ? 0.05 : 0.2, 1);
      this.capsuleGlow.material.opacity = 1;
      this.capsuleGlow.scale.setScalar(30 + Math.min(30, vx * 0.02));
      if (x < RAIL_END) {
        // Chase, low and to the side.
        camPos = new THREE.Vector3(x - 90 - vx * 0.02, y + 14, 38);
        camTarget = new THREE.Vector3(x + 60, y + 2, 0);
      } else {
        // Hold at the muzzle and watch it go.
        camPos = new THREE.Vector3(RAIL_END - 140, railY(RAIL_END) + 24, 60);
        camTarget = this.capsule.position.clone();
      }
    }
    this.camera.position.lerp(camPos, this.fired < 0 ? 1 : Math.min(1, dt * 6));
    this.camera.lookAt(camTarget);

    // Coils cool back down.
    let dirty = false;
    for (let i = 0; i < this.coilHeat.length; i++) {
      if (this.coilHeat[i] > 0.001) {
        this.coilHeat[i] *= Math.exp(-dt * 2.2);
        this.coils.setColorAt(i, tmp.copy(this.cold).lerp(this.hot, this.coilHeat[i]));
        dirty = true;
      }
    }
    if (dirty && this.coils.instanceColor) this.coils.instanceColor.needsUpdate = true;
  }

  private heat(x: number) {
    const i = Math.floor((x - RAIL_START) / 40);
    if (i >= 0 && i < this.coilHeat.length) this.coilHeat[i] = 1;
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}

const tmp = new THREE.Color();

/* ========================================================= the transfer */

export class TransferScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private venus: THREE.Mesh;
  private earth: THREE.Mesh;
  private mars: THREE.Mesh;
  private capsule: THREE.Sprite;
  private path: THREE.Line;
  private curve: THREE.QuadraticBezierCurve3;
  private sunDir = new THREE.Vector3(-1, 0.05, 0.2).normalize();
  t = 0;
  readonly duration = 14;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(45, aspect, 1, 200000);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(stars(4000, 90000, 3));
    const sun = glowSprite(0xfff0c8, 26000);
    sun.position.copy(this.sunDir).multiplyScalar(60000);
    this.scene.add(sun);
    const sun2 = glowSprite(0xffd080, 60000);
    sun2.position.copy(sun.position);
    (sun2.material as THREE.SpriteMaterial).opacity = 0.35;
    this.scene.add(sun2);

    this.earth = planet(EARTH_FRAG, 700, this.sunDir);
    this.earth.position.set(8000, -600, 1500);
    this.scene.add(this.earth);
    this.mars = planet(EARTH_FRAG, 380, this.sunDir);
    (this.mars.material as THREE.ShaderMaterial).fragmentShader = NOISE + EARTH_FRAG.replace("vec3(0.02, 0.09, 0.28)", "vec3(0.45, 0.16, 0.06)").replace("vec3(0.12, 0.28, 0.08)", "vec3(0.6, 0.28, 0.12)").replace("col = mix(col, vec3(1.0), cloud * 0.85);", "");
    this.mars.position.set(24000, 3000, -9000);
    this.scene.add(this.mars);

    this.venus = planet(VENUS_FRAG, 2400, this.sunDir);
    this.venus.position.set(-14000, 400, -6000);
    this.scene.add(this.venus);

    // Downhill: a curve that bends toward the Sun.
    this.curve = new THREE.QuadraticBezierCurve3(
      this.earth.position.clone(),
      new THREE.Vector3(-2000, 800, 7000),
      this.venus.position.clone().add(new THREE.Vector3(-900, 300, 2700)),
    );
    const pts = this.curve.getPoints(120);
    this.path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xffd79a, dashSize: 300, gapSize: 220, transparent: true, opacity: 0.55 }),
    );
    this.path.computeLineDistances();
    this.scene.add(this.path);

    const up = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(this.earth.position.clone(), new THREE.Vector3(18000, 3000, 4000), this.mars.position.clone()).getPoints(60)),
      new THREE.LineDashedMaterial({ color: 0xff7a5a, dashSize: 200, gapSize: 300, transparent: true, opacity: 0.35 }),
    );
    up.computeLineDistances();
    this.scene.add(up);

    this.capsule = glowSprite(0x9ff4ff, 380);
    this.scene.add(this.capsule);
  }

  /** 0..1 */
  get progress() { return Math.min(1, this.t / this.duration); }

  update(dt: number) {
    this.t += dt;
    const k = this.progress;
    const e = k * k * (3 - 2 * k);
    for (const m of [this.venus, this.earth, this.mars]) {
      (m.material as THREE.ShaderMaterial).uniforms.uTime.value = this.t;
    }
    this.venus.rotation.y += dt * 0.02;
    const c = this.curve.getPoint(Math.min(1, e * 1.02));
    this.capsule.position.copy(c);
    // Fade the capsule out before the camera catches it up.
    (this.capsule.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, (0.93 - k) * 8));
    // Camera: start behind Earth looking at the whole arc, end falling into Venus.
    const start = new THREE.Vector3(14000, 2600, 12000);
    const end = this.venus.position.clone().add(new THREE.Vector3(-2600, 900, 4600));
    const pos = start.clone().lerp(end, Math.pow(e, 1.6));
    this.camera.position.copy(pos);
    const look = new THREE.Vector3(-3000, 0, 0).lerp(this.venus.position, Math.min(1, e * 1.3));
    this.camera.lookAt(look);
    this.camera.fov = 45 - e * 10;
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}
