/**
 * Coast Road, the engine.
 *
 * Two and a half kilometres downhill to the sea on a longboard, in one of two
 * looks. Left and right carve, a jump clears a crack, a tuck goes faster, and
 * the wind is always there: in the grass, in the seeds or leaves going past, in
 * the sound, and in the gusts that lean on you. Nothing can hurt you. The
 * "lens" look adds an action-camera pass on top: a wide barrel-distorted
 * frame that smears at the edges when you are going fast.
 */
import * as THREE from "three";
import { buildRider, type Rider } from "./rider";
import { buildScenery, PALETTE, type Scenery } from "./scenery";
import { LENGTH, MAX_SPEED, newRide, roadAt, roadPos, stepRide, type RideInput, type RideState, type Style } from "./road";

export type { Style } from "./road";

export interface CoastState {
  style: Style;
  speedKmh: number;
  topKmh: number;
  distance: number;
  remaining: number;
  progress: number;
  flow: number;
  wind: number;
  windLat: number;
  gust: boolean;
  elapsed: number;
  jumped: number;
  hits: number;
  onGrass: boolean;
  lean: number;
  tuck: boolean;
  finished: boolean;
  note: string | null;
  tailwind: number;
}

export interface CoastStick {
  /** -1 into the hill, +1 seaward. */
  x: number;
}

export interface CoastWorld {
  readonly stick: CoastStick;
  jump(): void;
  setTuck(on: boolean): void;
  setBrake(on: boolean): void;
  restart(): void;
  dispose(): void;
}

export interface CoastOptions {
  container: HTMLElement;
  style: Style;
  autopilot?: boolean;
  /** Start this far down the road (the card capture uses it). */
  startS?: number;
  onState: (s: CoastState) => void;
}

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const POST_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse; uniform float uSpeed; uniform float uAspect; uniform float uTime;
varying vec2 vUv;
void main() {
  // Barrel distortion, the action-camera look.
  vec2 c = vUv - 0.5;
  c.x *= uAspect;
  float r2 = dot(c, c);
  vec2 d = c * (1.0 + 0.16 * r2 + 0.05 * r2 * r2);
  d.x /= uAspect;
  vec2 uv = d + 0.5;
  // Radial blur that grows with speed and with distance from the centre.
  float edge = smoothstep(0.08, 0.65, r2);
  float amount = uSpeed * edge * 0.055;
  vec3 col = vec3(0.0);
  const int N = 9;
  for (int i = 0; i < N; i++) {
    float k = (float(i) / float(N - 1) - 0.5) * 2.0;
    vec2 off = (uv - 0.5) * k * amount;
    // A whisper of chromatic split at the edges.
    float ca = 1.0 + 0.006 * edge * k;
    vec2 s = 0.5 + (uv - 0.5 + off) * ca;
    col.r += texture2D(tDiffuse, 0.5 + (uv - 0.5 + off) * (ca + 0.004 * edge)).r;
    col.g += texture2D(tDiffuse, s).g;
    col.b += texture2D(tDiffuse, 0.5 + (uv - 0.5 + off) * (ca - 0.004 * edge)).b;
  }
  col /= float(N);
  // The target is linear: tone map and encode here, since the screen pass is ours.
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  // Lens vignette and a touch of grain.
  col *= 1.0 - 0.32 * smoothstep(0.35, 1.05, r2);
  float g = fract(sin(dot(vUv * vec2(uTime * 13.7, 91.1), vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * 0.028;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface Audio {
  ctx: AudioContext;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  rumbleGain: GainNode;
  padGain: GainNode | null;
}

function makeNoise(ctx: AudioContext): AudioBufferSourceNode {
  const n = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.98 * b0 + 0.02 * w;
    d[i] = (w * 0.5 + b0 * 3) * 0.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

function startAudio(style: Style): Audio | null {
  const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
  if (!Ctor) return null;
  const ctx = new Ctor();
  const wind = makeNoise(ctx);
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "lowpass";
  windFilter.frequency.value = 500;
  windFilter.Q.value = 0.7;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  wind.connect(windFilter).connect(windGain).connect(ctx.destination);
  wind.start();
  const rumble = makeNoise(ctx);
  const rf = ctx.createBiquadFilter();
  rf.type = "lowpass";
  rf.frequency.value = 110;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  rumble.connect(rf).connect(rumbleGain).connect(ctx.destination);
  rumble.start();
  let padGain: GainNode | null = null;
  if (style === "painted") {
    padGain = ctx.createGain();
    padGain.gain.value = 0.0;
    const notes = [220, 277.2, 329.6, 440];
    for (const f of notes) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.05;
      const lg = ctx.createGain();
      lg.gain.value = 1.5;
      lfo.connect(lg).connect(o.detune);
      const g = ctx.createGain();
      g.gain.value = 0.25;
      o.connect(g).connect(padGain);
      o.start();
      lfo.start();
    }
    const pf = ctx.createBiquadFilter();
    pf.type = "lowpass";
    pf.frequency.value = 900;
    padGain.connect(pf).connect(ctx.destination);
  }
  return { ctx, windFilter, windGain, rumbleGain, padGain };
}

export function createCoastRoad(options: CoastOptions): CoastWorld {
  const { container, style, onState } = options;
  const painted = style === "painted";
  const pal = PALETTE[style];

  const renderer = new THREE.WebGLRenderer({ antialias: !painted ? false : true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = painted ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = painted ? new THREE.Fog(pal.fog, 700, 2600) : new THREE.Fog(pal.fog, 160, 1500);
  const camera = new THREE.PerspectiveCamera(painted ? 58 : 104, 1, 0.1, 6000);

  const scenery: Scenery = buildScenery(style);
  scene.add(scenery.group);
  const rider: Rider = buildRider(style);
  scene.add(rider.group);

  // Wind-borne bits: seeds and petals in the painted look, leaves in the lens.
  const BITS = 220;
  const bitGeo = new THREE.PlaneGeometry(painted ? 0.12 : 0.16, painted ? 0.12 : 0.1);
  const bitMat = new THREE.MeshBasicMaterial({ color: painted ? 0xffffff : 0x9a7a3c, side: THREE.DoubleSide, transparent: true, opacity: painted ? 0.9 : 0.85 });
  const bits = new THREE.InstancedMesh(bitGeo, bitMat, BITS);
  bits.frustumCulled = false;
  const bitPos = new Float32Array(BITS * 3);
  const bitPhase = new Float32Array(BITS);
  scene.add(bits);

  // Lens post pass.
  let target: THREE.WebGLRenderTarget | null = null;
  let postScene: THREE.Scene | null = null;
  let postCam: THREE.OrthographicCamera | null = null;
  let postMat: THREE.ShaderMaterial | null = null;
  if (!painted) {
    target = new THREE.WebGLRenderTarget(1, 1, { samples: 0 });
    postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: { tDiffuse: { value: target.texture }, uSpeed: { value: 0 }, uAspect: { value: 1 }, uTime: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    postScene = new THREE.Scene();
    postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
    postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (target && postMat) {
      const pr = renderer.getPixelRatio();
      target.setSize(Math.floor(w * pr), Math.floor(h * pr));
      postMat.uniforms.uAspect.value = w / h;
    }
  };
  onResize();

  // ---- Input -----------------------------------------------------------------
  const keys = new Set<string>();
  const stick: CoastStick = { x: 0 };
  let jumpQueued = false;
  let tuckHeld = false;
  let brakeHeld = false;
  let audio: Audio | null = null;
  const ensureAudio = () => {
    if (audio || disposed) return;
    audio = startAudio(style);
    if (audio && audio.ctx.state === "suspended") void audio.ctx.resume();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    ensureAudio();
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === " " || k === "w" || k === "arrowup") {
      jumpQueued = true;
      e.preventDefault();
    }
    if (k === "r") restart();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  const onPointerDown = () => ensureAudio();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);

  // ---- State -----------------------------------------------------------------
  let ride: RideState = newRide();
  if (options.startS) ride.s = Math.max(0, Math.min(LENGTH - 1, options.startS));
  const course = scenery.course;
  const input: RideInput = { steer: 0, jump: false, tuck: false, brake: false };
  let disposed = false;
  let raf = 0;
  let last = performance.now();
  let time = 0;
  let stateAt = 0;
  let frames = 0;
  const riderPos = new THREE.Vector3();
  const tmp = { x: 0, y: 0, z: 0 };
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const camUp = new THREE.Vector3(0, 1, 0);
  let camRoll = 0;
  let snapCam = true;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const bitV = new THREE.Vector3();
  const aheadPt = { x: 0, y: 0, z: 0, tx: 0, tz: 1, grade: 0, curve: 0 };

  function seedBits() {
    for (let i = 0; i < BITS; i++) {
      bitPos[i * 3] = (Math.random() - 0.5) * 60;
      bitPos[i * 3 + 1] = Math.random() * 12;
      bitPos[i * 3 + 2] = Math.random() * 90 - 20;
      bitPhase[i] = Math.random() * Math.PI * 2;
    }
  }
  seedBits();

  function restart() {
    ride = newRide();
    seedBits();
    snapCam = true;
  }

  function publish() {
    onState({
      style,
      speedKmh: ride.speed * 3.6,
      topKmh: ride.topSpeed * 3.6,
      distance: ride.s,
      remaining: Math.max(0, LENGTH - ride.s),
      progress: ride.s / LENGTH,
      flow: ride.flow,
      wind: ride.wind,
      windLat: ride.windLat,
      gust: !!ride.gust,
      elapsed: ride.elapsed,
      jumped: ride.jumped,
      hits: ride.hits,
      onGrass: ride.onGrass,
      lean: ride.lean,
      tuck: input.tuck,
      finished: ride.finished,
      note: ride.note,
      tailwind: ride.tailwind,
    });
  }

  function readInput() {
    let steer = stick.x;
    if (keys.has("a") || keys.has("arrowleft")) steer -= 1;
    if (keys.has("d") || keys.has("arrowright")) steer += 1;
    // Screen-left is toward the sea when heading down the road, so left = +lat.
    steer = -steer;
    input.steer = Math.max(-1, Math.min(1, steer));
    input.tuck = tuckHeld || keys.has("shift");
    input.brake = brakeHeld || keys.has("s") || keys.has("arrowdown");
    input.jump = jumpQueued;
    jumpQueued = false;
    if (options.autopilot) {
      const p = roadAt(ride.s + 6);
      input.steer = Math.max(-1, Math.min(1, p.curve * 150 - ride.lat * 0.7));
      input.tuck = true;
      const ob = course.obstacles[ride.nextObstacle];
      input.jump = !!ob && ob.s - ride.s < 3.5 && ob.s - ride.s > 1.5 && Math.abs(ob.lat - ride.lat) < ob.width / 2 + 0.3;
    }
  }

  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    frames++;

    readInput();
    // Fixed sub-steps keep the carve stable on slow frames. `dt` stays the
    // frame's own step for the camera and the air; `left` is what is consumed.
    let left = dt;
    while (left > 0) {
      const h = Math.min(left, 1 / 90);
      stepRide(ride, input, course, h);
      input.jump = false;
      left -= h;
    }

    // Rider placement.
    const p = roadAt(ride.s);
    roadPos(ride.s, ride.lat, tmp);
    const groundY = tmp.y + (ride.onGrass ? -0.04 : 0);
    riderPos.set(tmp.x, groundY + 0.05 + ride.z, tmp.z);
    rider.group.position.copy(riderPos);
    rider.group.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
    // Wobble is a shiver in the board.
    rider.group.rotation.z = Math.sin(time * 38) * ride.wobble * 0.05;
    rider.group.rotation.x = -Math.atan(p.grade);
    rider.pose(ride.lean, input.tuck ? 1 : 0.28 + ride.speed / MAX_SPEED * 0.35, ride.z, time, ride.speed);

    // Camera: chase, low and wide for the lens, higher and calmer when painted.
    const back = painted ? 5.6 : 3.4;
    const up = painted ? 2.4 : 1.25;
    const ahead = painted ? 14 : 10;
    camPos.set(tmp.x - p.tx * back + -p.tz * ride.lean * -0.6, groundY + up, tmp.z - p.tz * back + p.tx * ride.lean * -0.6);
    const pa = roadAt(Math.min(LENGTH, ride.s + ahead), aheadPt);
    camLook.set(pa.x, pa.y + (painted ? 1.6 : 1.1), pa.z);
    if (snapCam) {
      camera.position.copy(camPos);
      snapCam = false;
    } else camera.position.lerp(camPos, Math.min(1, 1 - Math.exp(-dt * 6)));
    const targetRoll = -ride.lean * (painted ? 0.04 : 0.11) + Math.sin(time * 38) * ride.wobble * 0.01;
    camRoll += (targetRoll - camRoll) * Math.min(1, 6 * dt + 0.001);
    camUp.set(Math.sin(camRoll), Math.cos(camRoll), 0);
    camera.up.copy(camUp);
    camera.lookAt(camLook);

    // Wind-borne bits drift down the road and sideways with the gust, and wrap.
    const windAlong = 2.5 + ride.wind * 7;
    for (let i = 0; i < BITS; i++) {
      const j = i * 3;
      bitPos[j] += (ride.windLat * 4 + Math.sin(time * 1.3 + bitPhase[i]) * 0.8) * dt - ride.lean * 0.4 * dt;
      bitPos[j + 1] += (Math.sin(time * 0.9 + bitPhase[i] * 1.7) * 0.6 + (painted ? 0.15 : -0.25)) * dt;
      bitPos[j + 2] += (windAlong - ride.speed * 0.15) * dt;
      // Relative to the rider frame: z is along the road.
      if (bitPos[j + 2] > 80 || bitPos[j + 2] < -25 || Math.abs(bitPos[j]) > 34 || bitPos[j + 1] < 0 || bitPos[j + 1] > 16) {
        bitPos[j] = (Math.random() - 0.5) * 60;
        bitPos[j + 1] = 0.3 + Math.random() * 12;
        bitPos[j + 2] = Math.random() < 0.7 ? -20 + Math.random() * 30 : 60 + Math.random() * 20;
      }
      // Into world space: along the tangent, left, up.
      bitV.set(tmp.x + p.tx * bitPos[j + 2] + -p.tz * bitPos[j], groundY + bitPos[j + 1], tmp.z + p.tz * bitPos[j + 2] + p.tx * bitPos[j]);
      q.setFromEuler(new THREE.Euler(time * 2 + bitPhase[i], bitPhase[i], time * 1.5));
      m4.compose(bitV, q, sc);
      bits.setMatrixAt(i, m4);
    }
    bits.instanceMatrix.needsUpdate = true;

    scenery.update(time, camera, ride.wind, ride.windLat, riderPos);

    // Sound.
    if (audio) {
      const sp = ride.speed / MAX_SPEED;
      audio.windFilter.frequency.value = 260 + ride.wind * 900 + sp * 1400;
      audio.windGain.gain.value = 0.035 + ride.wind * 0.09 + sp * 0.16;
      audio.rumbleGain.gain.value = ride.grounded ? sp * (ride.onGrass ? 0.25 : 0.12) + ride.wobble * 0.1 : 0.01;
      if (audio.padGain) audio.padGain.gain.value = 0.05 + sp * 0.04;
    }

    if (postMat && target && postScene && postCam) {
      postMat.uniforms.uSpeed.value = ride.speed / MAX_SPEED;
      postMat.uniforms.uTime.value = time;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } else {
      renderer.render(scene, camera);
    }

    if (now - stateAt > 90) {
      stateAt = now;
      publish();
    }
  }
  raf = requestAnimationFrame(frame);
  publish();
  // A probe for the sandbox, where a frame takes seconds: read where things are.
  (window as unknown as { __coast?: unknown }).__coast = {
    ride: () => ride,
    rider: () => rider.group.position.toArray(),
    camera: () => camera.position.toArray(),
    jump: (s: number) => {
      ride.s = Math.max(0, Math.min(LENGTH - 1, s));
      snapCam = true;
    },
    frames: () => frames,
  };

  return {
    stick,
    jump() {
      ensureAudio();
      jumpQueued = true;
    },
    setTuck(on) {
      tuckHeld = on;
    },
    setBrake(on) {
      brakeHeld = on;
    },
    restart,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      if (audio) void audio.ctx.close();
      rider.dispose();
      scenery.dispose();
      bitGeo.dispose();
      bitMat.dispose();
      target?.dispose();
      postMat?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
