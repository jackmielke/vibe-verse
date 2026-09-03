/**
 * Pathfinder — the engine.
 *
 * Sergey Brin's 406-foot airship flew over the East Bay this week collecting
 * data, and somebody in a car looked up and said "airship". This is the
 * version where it has a job: five relief drops around a Bay that has had a
 * bad week, in a ship that does everything twenty seconds after you ask.
 *
 * The physics is all in `ship.ts`; this file owns the Bay, the wind, the
 * cargo on its way down, the camera and the score. The one rule of the game
 * is real: dropping two and a half tonnes makes her light, and light means
 * up. Vent before you drop, or vent fast afterwards.
 */
import * as THREE from "three";
import { BRIDGES, DROPS, MOFFETT, bayHeight, type DropZone } from "./bay";
import { createShip, HULL_RADIUS, type ShipControls } from "./ship";

export interface AirshipState {
  altitude: number;
  airspeed: number;
  verticalSpeed: number;
  heading: number;
  helium: number;
  ballast: number;
  cargo: number;
  trim: number;
  throttle: number;
  wind: { x: number; z: number; speed: number };
  /** Drops still to make. */
  targets: { name: string; cargo: string; why: string; distance: number; bearing: number; done: boolean }[];
  /** Index of the nearest undone target, or -1. */
  nearest: number;
  /** True when a drop from here would land. */
  canDrop: boolean;
  /** Why not, when it would not. */
  dropHint: string;
  /** All cargo delivered; head home. */
  homeward: boolean;
  home: { distance: number; bearing: number };
  landed: boolean;
  elapsed: number;
  note: string | null;
  grounded: boolean;
}

export interface AirshipTouch {
  throttle: number;
  rudder: number;
  elevator: number;
  vent: boolean;
}

export interface AirshipWorld {
  readonly touch: AirshipTouch;
  drop(): void;
  ballast(): void;
  restart(): void;
  dispose(): void;
}

export interface AirshipOptions {
  container: HTMLElement;
  onState: (s: AirshipState) => void;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
varying vec3 vDir;
void main() {
  vec3 rd = normalize(vDir);
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 zenith = vec3(0.16, 0.30, 0.58);
  vec3 horizon = vec3(0.98, 0.74, 0.52);
  vec3 sky = mix(horizon, zenith, pow(up, 0.6));
  float mu = max(dot(rd, uSun), 0.0);
  sky += vec3(1.0, 0.8, 0.5) * pow(mu, 8.0) * 0.35;
  sky += vec3(1.0, 0.95, 0.85) * pow(mu, 200.0) * 2.0;
  float haze = exp(-abs(rd.y) * 6.0) * 0.5;
  sky = mix(sky, vec3(0.95, 0.85, 0.75), haze);
  gl_FragColor = vec4(sky, 1.0);
}
`;
const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  p.y += sin(p.x * 0.02 + uTime * 0.6) * 0.6 + sin(p.z * 0.017 - uTime * 0.5) * 0.5;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const WATER_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uCam;
varying vec3 vWorld;
void main() {
  vec3 v = normalize(uCam - vWorld);
  float ripple = sin(vWorld.x * 0.15 + uTime * 1.2) * sin(vWorld.z * 0.13 - uTime * 0.9);
  vec3 n = normalize(vec3(ripple * 0.06, 1.0, ripple * 0.05));
  vec3 h = normalize(uSun + v);
  float spec = pow(max(dot(n, h), 0.0), 180.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 deep = vec3(0.07, 0.20, 0.30);
  vec3 sky = vec3(0.75, 0.62, 0.55);
  vec3 c = mix(deep, sky, fres * 0.7);
  c += vec3(1.0, 0.85, 0.6) * spec * 1.4;
  float d = distance(uCam.xz, vWorld.xz);
  c = mix(c, vec3(0.93, 0.80, 0.68), 1.0 - exp(-d * 0.00022));
  gl_FragColor = vec4(c, 1.0);
}
`;

const SIZE = 9000;

function buildTerrain(): THREE.Mesh {
  const n = 180;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, n, n);
  geo.rotateX(-Math.PI / 2);
  geo.translate(800, 0, 1800);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const grass = new THREE.Color(0x8a9a4e);
  const gold = new THREE.Color(0xc9b06a);
  const rock = new THREE.Color(0x7d7468);
  const city = new THREE.Color(0xb9b3a8);
  const sandC = new THREE.Color(0xd8c9a6);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = bayHeight(x, z);
    pos.setY(i, Math.max(h, -6));
  }
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = pos.getY(i);
    const slope = 1 - nrm.getY(i);
    const urban = (x < -300 && z > 600 && z < 2200 && h < 90) || (x > 1700 && x < 2500 && z > -300 && z < 1800 && h < 60);
    if (h < 2) c.copy(sandC);
    else if (urban) c.copy(city);
    else c.copy(grass).lerp(gold, Math.min(1, h / 250)).lerp(rock, Math.min(1, slope * 4));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
}

function buildCity(): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xd9d4c7 });
  const N = 1400;
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let seed = 3;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let placed = 0;
  let tries = 0;
  while (placed < N && tries < N * 30) {
    tries++;
    const sf = rnd() < 0.65;
    const x = sf ? -1500 + rnd() * 1300 : 1750 + rnd() * 700;
    const z = sf ? 500 + rnd() * 1700 : -200 + rnd() * 1900;
    const h = bayHeight(x, z);
    if (h < 3 || h > 120) continue;
    // Downtown SF is the north-east corner of the peninsula; it gets the towers.
    const downtown = sf && x > -800 && z < 1200;
    const height = downtown ? 30 + rnd() * rnd() * 220 : 8 + rnd() * 22;
    p.set(x, h - 1, z);
    s.set(12 + rnd() * 20, height, 12 + rnd() * 20);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildBridge(b: { x1: number; z1: number; x2: number; z2: number; height: number; deck: number }, colour: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: colour });
  const dx = b.x2 - b.x1;
  const dz = b.z2 - b.z1;
  const len = Math.hypot(dx, dz);
  const ang = Math.atan2(dx, dz);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 3, len), mat);
  deck.position.set((b.x1 + b.x2) / 2, b.deck, (b.z1 + b.z2) / 2);
  deck.rotation.y = ang;
  g.add(deck);
  for (const t of [0.3, 0.7]) {
    const x = b.x1 + dx * t;
    const z = b.z1 + dz * t;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(6, b.height, 18), mat);
    tower.position.set(x, b.height / 2, z);
    tower.rotation.y = ang;
    g.add(tower);
  }
  // Cables, as a sagging line per side.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const sag = Math.abs(Math.sin((t - 0.3) / 0.4 * Math.PI));
    const y = t < 0.3 || t > 0.7 ? b.deck + (b.height - b.deck) * (t < 0.3 ? t / 0.3 : (1 - t) / 0.3) : b.height - (b.height - b.deck - 6) * (1 - sag) * 0 - (b.height - b.deck - 8) * (1 - Math.abs(Math.cos((t - 0.5) / 0.4 * Math.PI)));
    pts.push(new THREE.Vector3(b.x1 + dx * t, y, b.z1 + dz * t));
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colour }));
  g.add(line);
  return g;
}

export function createAirship(options: AirshipOptions): AirshipWorld {
  const { container, onState } = options;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0xf0c8a0, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xf1cfae, 0.00016);
  const camera = new THREE.PerspectiveCamera(58, (container.clientWidth || 1) / (container.clientHeight || 1), 1, 20000);

  const sunDir = new THREE.Vector3(-0.75, 0.22, -0.4).normalize();
  const sun = new THREE.DirectionalLight(0xffd9b0, 2.2);
  sun.position.copy(sunDir).multiplyScalar(1000);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xffd0b0, 0x2a3a4a, 0.8));

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: { uSun: { value: sunDir } },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 24, 16), skyMat);
  scene.add(sky);

  const terrain = buildTerrain();
  scene.add(terrain);
  const city = buildCity();
  scene.add(city);
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: { uTime: { value: 0 }, uSun: { value: sunDir }, uCam: { value: new THREE.Vector3() } },
    fog: false,
  });
  const waterGeo = new THREE.PlaneGeometry(SIZE * 2, SIZE * 2, 120, 120);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(800, 0, 1800);
  scene.add(water);

  scene.add(buildBridge(BRIDGES.goldenGate, 0xc44b2a));
  scene.add(buildBridge(BRIDGES.bayBridgeWest, 0x9a9a9a));
  scene.add(buildBridge(BRIDGES.bayBridgeEast, 0xd0d0d0));

  // Hangar One at Moffett: the biggest room in the Bay Area.
  const hangar = new THREE.Mesh(
    new THREE.CapsuleGeometry(40, 240, 6, 12),
    new THREE.MeshLambertMaterial({ color: 0x9aa3ad }),
  );
  hangar.rotation.z = Math.PI / 2;
  hangar.position.set(MOFFETT.x + 300, Math.max(0, bayHeight(MOFFETT.x + 300, MOFFETT.z + 40)) + 30, MOFFETT.z + 40);
  scene.add(hangar);
  // The mast she rides on, and the apron under it.
  const fieldY = Math.max(0, bayHeight(MOFFETT.x, MOFFETT.z));
  const apron = new THREE.Mesh(
    new THREE.CircleGeometry(130, 40),
    new THREE.MeshLambertMaterial({ color: 0x8e8a80 }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(MOFFETT.x, fieldY + 0.6, MOFFETT.z);
  scene.add(apron);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 2.4, HULL_RADIUS + 14, 8),
    new THREE.MeshLambertMaterial({ color: 0xc44b2a }),
  );
  mast.position.set(MOFFETT.x + Math.sin(Math.PI) * 60, fieldY + (HULL_RADIUS + 14) / 2, MOFFETT.z + Math.cos(Math.PI) * 60);
  scene.add(mast);
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 1400),
    new THREE.MeshLambertMaterial({ color: 0x6f6b64 }),
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(MOFFETT.x - 260, fieldY + 0.5, MOFFETT.z + 200);
  scene.add(runway);

  // Drop zones: a ring on the ground, a beacon up into the sky.
  const zones = DROPS.map((d) => {
    const y = Math.max(0.5, bayHeight(d.x, d.z));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(36, 46, 40),
      new THREE.MeshBasicMaterial({ color: 0xffb347, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(d.x, y + 1.5, d.z);
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 6, 700, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    beacon.position.set(d.x, y + 350, d.z);
    scene.add(ring, beacon);
    return { def: d, ring, beacon, done: false, y };
  });
  const homeRing = new THREE.Mesh(
    new THREE.RingGeometry(70, 84, 48),
    new THREE.MeshBasicMaterial({ color: 0x7fe0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.0 }),
  );
  homeRing.rotation.x = -Math.PI / 2;
  homeRing.position.set(MOFFETT.x, Math.max(0.5, bayHeight(MOFFETT.x, MOFFETT.z)) + 1.5, MOFFETT.z);
  scene.add(homeRing);

  const ship = createShip();
  scene.add(ship.group);
  // A shadow on the water: a soft dark ellipse that follows her.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  // Pallets in the air.
  interface Falling {
    mesh: THREE.Mesh;
    v: THREE.Vector3;
    zone: (typeof zones)[number] | null;
    chute: THREE.Mesh;
  }
  const falling: Falling[] = [];
  const palletGeo = new THREE.BoxGeometry(4, 2.6, 4);
  const palletMat = new THREE.MeshLambertMaterial({ color: 0xb8863a });
  const chuteGeo = new THREE.SphereGeometry(6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const chuteMat = new THREE.MeshLambertMaterial({ color: 0xff7a3a, side: THREE.DoubleSide });

  // ---- State -----------------------------------------------------------------
  const touch: AirshipTouch = { throttle: 0, rudder: 0, elevator: 0, vent: false };
  const controls: ShipControls = { throttle: 0, rudder: 0, elevator: 0 };
  const wind = new THREE.Vector3(6, 0, 1.5);
  let elapsed = 0;
  let note: string | null = null;
  let noteUntil = 0;
  let homeward = false;
  let landed = false;
  let grounded = false;
  let liftedOff = false;
  const say = (t: string, sec = 5) => {
    note = t;
    noteUntil = elapsed + sec;
  };

  const reset = () => {
    const y = Math.max(0, bayHeight(MOFFETT.x, MOFFETT.z)) + HULL_RADIUS + 14;
    ship.reset(MOFFETT.x, y, MOFFETT.z, Math.PI); // nose north, toward the bay
    controls.throttle = 0;
    controls.rudder = 0;
    controls.elevator = 0;
    elapsed = 0;
    homeward = false;
    landed = false;
    liftedOff = false;
    for (const z of zones) {
      z.done = false;
      z.ring.visible = true;
      z.beacon.visible = true;
    }
    for (const f of falling) scene.remove(f.mesh, f.chute);
    falling.length = 0;
    (homeRing.material as THREE.MeshBasicMaterial).opacity = 0;
    say("Pathfinder 1, on the mast at Moffett. Eight bags of ballast aboard; drop four and she will float. Five relief drops around the Bay, then bring her home.", 9);
  };
  reset();

  // ---- Input -----------------------------------------------------------------
  const keys = new Set<string>();
  let camYaw = 0.35;
  let camPitch = 0.22;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === "Space") {
      e.preventDefault();
      drop();
    }
    if (e.code === "KeyB") ballast();
    if (e.code === "KeyR") reset();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    camYaw -= (e.clientX - lastX) * 0.005;
    camPitch = Math.max(-0.4, Math.min(1.2, camPitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  const nearestZone = (): { zone: (typeof zones)[number] | null; dist: number } => {
    let best: (typeof zones)[number] | null = null;
    let bestD = Infinity;
    for (const z of zones) {
      if (z.done) continue;
      const d = Math.hypot(z.def.x - ship.state.position.x, z.def.z - ship.state.position.z);
      if (d < bestD) {
        bestD = d;
        best = z;
      }
    }
    return { zone: best, dist: bestD };
  };

  const dropCheck = (): { ok: boolean; hint: string; zone: (typeof zones)[number] | null } => {
    const { zone, dist } = nearestZone();
    if (!zone) return { ok: false, hint: "Nothing left to drop. Take her home.", zone: null };
    const agl = ship.state.position.y - Math.max(0, zone.y);
    const speed = Math.hypot(ship.state.velocity.x, ship.state.velocity.z);
    if (dist > 60) return { ok: false, hint: `${zone.def.name} is ${Math.round(dist)} m off. Get over the ring.`, zone };
    if (agl > 160) return { ok: false, hint: `Too high: ${Math.round(agl)} m over the ring. Under 160 m.`, zone };
    if (speed > 9) return { ok: false, hint: `Too fast: ${speed.toFixed(0)} m/s. Under 9 to land it on the ring.`, zone };
    return { ok: true, hint: "Over the ring, low and slow. Drop.", zone };
  };

  function drop() {
    if (ship.state.cargo <= 0) {
      say("The belly is empty.", 3);
      return;
    }
    const check = dropCheck();
    const zone = check.ok ? check.zone : null;
    if (!ship.dropCargo()) return;
    const mesh = new THREE.Mesh(palletGeo, palletMat);
    mesh.position.copy(ship.state.position).y -= HULL_RADIUS + 2;
    const chute = new THREE.Mesh(chuteGeo, chuteMat);
    chute.position.copy(mesh.position).y += 6;
    scene.add(mesh, chute);
    falling.push({ mesh, v: ship.state.velocity.clone(), zone, chute });
    if (zone) {
      zone.done = true;
      zone.ring.visible = false;
      zone.beacon.visible = false;
      say(`${zone.def.cargo} away, for ${zone.def.name}. She will want to climb now: vent.`, 5);
      if (zones.every((z) => z.done)) {
        homeward = true;
        (homeRing.material as THREE.MeshBasicMaterial).opacity = 0.85;
        say("That is all five. Bring her back to Moffett and set her down inside the blue ring.", 8);
      }
    } else {
      say(`Dropped in the water. ${check.hint}`, 5);
    }
  }

  function ballast() {
    if (ship.dropBallast()) {
      const left = ship.state.ballast;
      say(left > 4 ? `Ballast away. ${left} bags left; she is still heavy.` : left === 4 ? "Ballast away. Neutral, near enough. Throttle up." : `Ballast away. ${left} left, and she is light now.`, 3.5);
    } else say("No ballast left. Only helium to play with now.", 3);
  }

  // ---- Loop --------------------------------------------------------------------
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3(MOFFETT.x - 200, 80, MOFFETT.z + 200);
  const look = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;
  const bearingTo = (x: number, z: number) => {
    const b = Math.atan2(x - ship.state.position.x, z - ship.state.position.z);
    return ((b - ship.state.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // Controls: keys ramp the throttle; the touch pad sets it directly.
    if (keys.has("KeyW") || keys.has("ArrowUp")) controls.throttle = Math.min(1, controls.throttle + dt * 0.5);
    if (keys.has("KeyS") || keys.has("ArrowDown")) controls.throttle = Math.max(0, controls.throttle - dt * 0.5);
    if (touch.throttle !== 0) controls.throttle = touch.throttle;
    let rudder = 0;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) rudder -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) rudder += 1;
    if (touch.rudder !== 0) rudder = touch.rudder;
    controls.rudder += (rudder - controls.rudder) * Math.min(1, dt * 2);
    let elev = 0;
    if (keys.has("KeyQ")) elev += 1;
    if (keys.has("KeyE")) elev -= 1;
    if (touch.elevator !== 0) elev = touch.elevator;
    controls.elevator += (elev - controls.elevator) * Math.min(1, dt * 2);
    if (keys.has("KeyV") || touch.vent) ship.vent(dt);

    // The wind breathes.
    wind.set(6 + Math.sin(elapsed * 0.13) * 2.5, 0, 1.5 + Math.sin(elapsed * 0.21 + 1) * 2);

    const res = ship.step(dt, controls, wind, bayHeight);
    grounded = res.grounded;
    if (!grounded && !liftedOff) {
      liftedOff = true;
      say("She is off the mast. Throttle up and turn north; the Bay is that way.", 5);
    }
    if (homeward && !landed && grounded) {
      const d = Math.hypot(MOFFETT.x - ship.state.position.x, MOFFETT.z - ship.state.position.z);
      if (d < 90) {
        landed = true;
        say(`Down at Moffett. Five drops, ${Math.floor(elapsed / 60)}:${Math.floor(elapsed % 60).toString().padStart(2, "0")}. Somebody in a car looked up.`, 12);
      }
    }
    if (ship.state.position.y > 850) say("Ceiling. The cells are at their limit; vent to come down.", 3);

    // Falling cargo.
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      f.v.y -= 9.81 * dt;
      f.v.y = Math.max(f.v.y, -14); // the chute
      f.v.x *= 1 - dt * 0.6;
      f.v.z *= 1 - dt * 0.6;
      f.mesh.position.addScaledVector(f.v, dt);
      f.chute.position.copy(f.mesh.position).y += 6;
      f.chute.rotation.y += dt;
      const g = Math.max(0, bayHeight(f.mesh.position.x, f.mesh.position.z));
      if (f.mesh.position.y <= g + 1.3) {
        f.mesh.position.y = g + 1.3;
        scene.remove(f.chute);
        f.chute.geometry.dispose();
        falling.splice(i, 1);
        if (!f.zone) {
          // In the water: it sinks, slowly, and that is that.
          f.mesh.position.y = -3;
        }
      }
    }

    // Camera: chase, behind and above, orbiting on drag.
    const yaw = ship.state.heading + Math.PI + camYaw;
    const dist = 210;
    tmp.set(Math.sin(yaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(yaw) * Math.cos(camPitch));
    camGoal.copy(ship.state.position).addScaledVector(tmp, dist);
    camGoal.y = Math.max(camGoal.y, Math.max(0, bayHeight(camGoal.x, camGoal.z)) + 12);
    camPos.lerp(camGoal, Math.min(1, dt * 2.5));
    camera.position.copy(camPos);
    look.copy(ship.state.position);
    camera.lookAt(look);
    sky.position.copy(camera.position);
    waterMat.uniforms.uTime.value = elapsed;
    waterMat.uniforms.uCam.value.copy(camera.position);
    water.position.x = camera.position.x;
    water.position.z = camera.position.z;

    const groundY = Math.max(0, bayHeight(ship.state.position.x, ship.state.position.z));
    shadow.position.set(ship.state.position.x + 20, groundY + 0.8, ship.state.position.z);
    const agl = ship.state.position.y - groundY;
    shadow.scale.set(HULL_RADIUS * 6, HULL_RADIUS * 2.2, 1);
    shadow.rotation.z = -ship.state.heading + Math.PI / 2;
    (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.03, 0.3 - agl / 1500);

    for (const z of zones) {
      if (z.done) continue;
      z.ring.scale.setScalar(1 + Math.sin(elapsed * 2.5) * 0.05);
    }

    renderer.render(scene, camera);

    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      const check = dropCheck();
      if (note && elapsed > noteUntil) note = null;
      const targets = zones.map((z) => ({
        name: z.def.name,
        cargo: z.def.cargo,
        why: z.def.why,
        distance: Math.hypot(z.def.x - ship.state.position.x, z.def.z - ship.state.position.z),
        bearing: bearingTo(z.def.x, z.def.z),
        done: z.done,
      }));
      const nz = nearestZone().zone;
      onState({
        altitude: agl,
        airspeed: Math.max(0, ship.state.airspeed),
        verticalSpeed: ship.state.verticalSpeed,
        heading: ((ship.state.heading * 180) / Math.PI + 360 * 4) % 360,
        helium: ship.state.helium,
        ballast: ship.state.ballast,
        cargo: ship.state.cargo,
        trim: ship.state.trim,
        throttle: controls.throttle,
        wind: { x: wind.x, z: wind.z, speed: Math.hypot(wind.x, wind.z) },
        targets,
        nearest: nz ? zones.indexOf(nz) : -1,
        canDrop: check.ok,
        dropHint: check.hint,
        homeward,
        home: {
          distance: Math.hypot(MOFFETT.x - ship.state.position.x, MOFFETT.z - ship.state.position.z),
          bearing: bearingTo(MOFFETT.x, MOFFETT.z),
        },
        landed,
        elapsed,
        note,
        grounded,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    touch,
    drop,
    ballast,
    restart: reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      ship.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
