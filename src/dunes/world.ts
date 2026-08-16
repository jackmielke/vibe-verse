/**
 * The Dune Sea — the engine.
 *
 * You start on the rim in the last hour of daylight and the oasis is nine
 * hundred metres downhill. The sun is the clock: it drops in real time, the
 * whole world's light goes with it, and the gates you pass on the way buy
 * you more of it. Nothing counts down in the corner of the screen — the
 * thing you are racing is drawn across the entire sky.
 */
import * as THREE from "three";
import { buildSky } from "./sky";
import { buildSand } from "./sand";
import { buildRider } from "./rider";
import { buildPostFx } from "./postfx";
import { duneHeight, DUNE_RADIUS, OASIS_RADIUS } from "./terrain";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";

const GATE_COUNT = 8;
/** Seconds of daylight in a run with no gates taken. */
const DAYLIGHT = 165;
/** What one gate is worth, as a fraction of the sun's arc. */
const GATE_DAYLIGHT = 0.11;
const START_RADIUS = DUNE_RADIUS * 0.9;

export interface DuneState {
  gates: number;
  totalGates: number;
  speed: number;
  /** Metres to the oasis. */
  distance: number;
  /** 1 = high sun, 0 = touching the horizon, below 0 = gone. */
  sun: number;
  airTime: number;
  /** Best air of the run, seconds. */
  bestAir: number;
  arrived: boolean;
  benighted: boolean;
}

export interface DuneStick {
  x: number;
  y: number;
  tuck: boolean;
}

export interface DuneSeaWorld {
  readonly stick: DuneStick;
  jump(): void;
  restart(): void;
  dispose(): void;
}

export interface DuneSeaOptions {
  container: HTMLElement;
  onState: (state: DuneState) => void;
}

function pickQuality() {
  const coarse =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const small = typeof window !== "undefined" && window.innerWidth < 900;
  // Rings × segments is the whole terrain budget. The shadow march is the
  // other cost, and it is CPU — so the phone tier gets fewer vertices to
  // march for as well as fewer to draw.
  // Segments matter more than rings: a ring at 800 m is five kilometres
  // round, and it is the spacing *along* it that decides whether a 250 m
  // dune survives being sampled.
  if (coarse || small) return { tier: "low" as const, rings: 120, segments: 200, spray: 220 };
  return { tier: "high" as const, rings: 200, segments: 340, spray: 500 };
}

export function createDuneSea(options: DuneSeaOptions): DuneSeaWorld {
  const { container, onState } = options;
  const quality = pickQuality();

  const renderer = new THREE.WebGLRenderer({
    antialias: quality.tier === "high",
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(
    container.clientWidth || window.innerWidth,
    container.clientHeight || window.innerHeight,
  );
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x1b2545, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    64,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.2,
    9000,
  );

  const sky = buildSky();
  scene.add(sky.mesh);

  const sand = buildSand(quality.rings, quality.segments);
  scene.add(sand.mesh);

  const rider = buildRider();
  scene.add(rider.group);

  // The same character you are everywhere else in the vibeverse, standing
  // on a board. One localStorage key, one loader, no roster of its own.
  const RIDER_HEIGHT = 1.7;
  let rig: CharacterRig | null = null;
  let rigDropped = false;
  const charId =
    (typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character"))) ||
    "vibey";
  void loadCharacterRig(findCharacter(charId), {
    height: RIDER_HEIGHT,
    fitBy: "height",
    center: true,
    castShadow: false,
    walkSpeed: 2.2,
  })
    .then((r) => {
      if (rigDropped) return r.dispose();
      rig = r;
      rider.mount(r.object, RIDER_HEIGHT);
      // A boarder is not walking. Hold the rig at a standing pose and let
      // the lean and the board do the work.
      r.setLocomotion(0);
    })
    .catch(() => {
      /* no body, still a world */
    });

  // Sun key + sky fill. The sand and the sky are shaders and ignore these
  // entirely; they exist to light the rider, the board and the gates.
  const sunLight = new THREE.DirectionalLight(0xffd0a0, 2.4);
  scene.add(sunLight);
  const skyFill = new THREE.HemisphereLight(0x9fc0ff, 0xc08040, 0.7);
  scene.add(skyFill);

  // ---- Gates ---------------------------------------------------------
  // A descending spiral from the rim to the oasis: follow them and you have
  // ridden the whole field, ignore them and you run out of light.
  interface Gate {
    group: THREE.Group;
    ring: THREE.Mesh;
    x: number;
    z: number;
    passed: boolean;
  }
  const gates: Gate[] = [];
  {
    const ringGeo = new THREE.TorusGeometry(7, 0.45, 10, 32);
    const postGeo = new THREE.CylinderGeometry(0.4, 0.55, 9, 6);
    const ringMat = new THREE.MeshStandardMaterial({
      color: "#3ad6ff",
      emissive: "#0d6a8a",
      emissiveIntensity: 1.2,
      roughness: 0.4,
    });
    const postMat = new THREE.MeshStandardMaterial({ color: "#6b3b1e", roughness: 0.9 });
    for (let i = 0; i < GATE_COUNT; i++) {
      const t = (i + 0.5) / GATE_COUNT;
      const r = START_RADIUS * (1 - t) + OASIS_RADIUS * t * 1.6;
      const a = 1.15 + t * 3.4;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const g = new THREE.Group();
      g.position.set(x, duneHeight(x, z), z);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 8;
      // Face the next gate, so passing through one aims you at the following.
      const nt = (i + 1.5) / GATE_COUNT;
      const nr = START_RADIUS * (1 - nt) + OASIS_RADIUS * nt * 1.6;
      const na = 1.15 + nt * 3.4;
      g.lookAt(Math.cos(na) * nr, duneHeight(x, z) + 8, Math.sin(na) * nr);
      g.add(ring);
      for (const dx of [-7, 7]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(dx, 4, 0);
        g.add(post);
      }
      scene.add(g);
      gates.push({ group: g, ring, x, z, passed: false });
    }
  }

  // ---- The oasis ------------------------------------------------------
  const oasis = new THREE.Group();
  {
    // Emissive, not just lit. At sunset the sun is two degrees up and a
    // rough-0.08 metal disc facing straight at the sky returns almost
    // nothing to a camera at head height — the pool rendered as a black
    // hole in the middle of the one place you are trying to reach.
    const waterMat = new THREE.MeshStandardMaterial({
      color: "#2a8f9c",
      roughness: 0.15,
      metalness: 0.2,
      emissive: "#0d4f5c",
      emissiveIntensity: 0.8,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(OASIS_RADIUS * 0.55, 48), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = duneHeight(0, 0) + 0.4;
    oasis.add(water);
    const trunkMat = new THREE.MeshStandardMaterial({ color: "#5a3a20", roughness: 0.9 });
    const frondMat = new THREE.MeshStandardMaterial({
      color: "#2f7a34",
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.42, 9, 6);
    const frondGeo = new THREE.ConeGeometry(0.7, 4.2, 4, 1, true);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.4;
      const r = OASIS_RADIUS * (0.62 + (i % 3) * 0.11);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = duneHeight(x, z);
      const lean = (i % 5) * 0.05;
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(x, y + 4.5, z);
      trunk.rotation.z = lean;
      oasis.add(trunk);
      for (let f = 0; f < 6; f++) {
        const frond = new THREE.Mesh(frondGeo, frondMat);
        const fa = (f / 6) * Math.PI * 2;
        frond.position.set(x + Math.cos(fa) * 1.5 + lean * 9, y + 9, z + Math.sin(fa) * 1.5);
        frond.rotation.set(Math.PI / 2 - 0.5, 0, -fa);
        oasis.add(frond);
      }
    }
  }
  scene.add(oasis);

  // ---- Sand spray -----------------------------------------------------
  // A ring buffer of grains kicked off the board. CPU-updated, because a
  // few hundred particles is nothing and the alternative is a simulation
  // that cannot know when the board is actually biting.
  const sprayCount = quality.spray;
  const sprayPos = new Float32Array(sprayCount * 3);
  const sprayVel = new Float32Array(sprayCount * 3);
  const sprayLife = new Float32Array(sprayCount);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
  sprayGeo.setAttribute("aLife", new THREE.BufferAttribute(sprayLife, 1));
  const sprayMat = new THREE.ShaderMaterial({
    name: "DuneSpray",
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color("#f0cfa0") }, uSize: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aLife;
      varying float vLife;
      uniform float uSize;
      void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (26.0 + 30.0 * aLife) / max(-mv.z, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uColor;
      varying float vLife;
      void main() {
        if (vLife <= 0.0) discard;
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.1, length(d)) * vLife;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a * 0.85);
      }
    `,
  });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.frustumCulled = false;
  scene.add(spray);
  let sprayHead = 0;
  const emitSpray = (x: number, y: number, z: number, vx: number, vz: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const j = sprayHead;
      sprayHead = (sprayHead + 1) % sprayCount;
      sprayPos[j * 3] = x + (Math.random() - 0.5) * 0.5;
      sprayPos[j * 3 + 1] = y + 0.1;
      sprayPos[j * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
      sprayVel[j * 3] = -vx * 0.22 + (Math.random() - 0.5) * 3.2;
      sprayVel[j * 3 + 1] = 1.6 + Math.random() * 3.4;
      sprayVel[j * 3 + 2] = -vz * 0.22 + (Math.random() - 0.5) * 3.2;
      sprayLife[j] = 1;
    }
  };

  const postfx = buildPostFx(renderer, quality.tier);

  // ---- Input ----------------------------------------------------------
  const keys = new Set<string>();
  const stick: DuneStick = { x: 0, y: 0, tuck: false };
  let jumpRequest = false;
  let camYaw = 0;
  let yawOffset = 0;
  let pitch = 0.12;
  // Further back and higher than a follow camera usually wants to be. The
  // subject here is not the rider, it is nine hundred metres of dune field
  // and where the next crest is — at eleven metres and three up, the frame
  // was a patch of sand forty metres across with a boarder in the middle
  // of it and no horizon at all.
  let camDist = 22;
  let dragging = false;
  let lastPointer = { x: 0, y: 0 };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      jumpRequest = true;
      e.preventDefault();
    }
    keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    yawOffset -= (e.clientX - lastPointer.x) * 0.005;
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - lastPointer.y) * 0.003, -0.1, 0.8);
    lastPointer = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent) => {
    camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.012, 5.5, 26);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: true });

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    postfx.setSize(w, h, renderer.getPixelRatio());
  };
  window.addEventListener("resize", onResize);
  onResize();

  // ---- Run state -------------------------------------------------------
  let sunElevation = 1;
  let gatesPassed = 0;
  let bestAir = 0;
  let arrived = false;
  let benighted = false;
  // Enough to sweep the whole field about every second and a half.
  const shadowBudget = Math.max(80, Math.round((quality.rings * quality.segments) / 90));
  let stateClock = 0;
  let elapsed = 0;
  let raf = 0;
  let last = performance.now();
  let disposed = false;

  const camGoal = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  const startRun = () => {
    // Drop in on the rim, pointed downhill at the oasis.
    const a = 1.15;
    rider.reset(Math.cos(a) * START_RADIUS, Math.sin(a) * START_RADIUS);
    camTarget.copy(rider.position);
    camYaw = rider.heading;
    sunElevation = 1;
    gatesPassed = 0;
    bestAir = 0;
    arrived = false;
    benighted = false;
    gates.forEach((g) => {
      g.passed = false;
      (g.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2;
    });
    sky.setElevation(1);
  };
  startRun();

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    let ix = stick.x;
    let iy = stick.y;
    if (keys.has("KeyW") || keys.has("ArrowUp")) iy -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) iy += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
    const tuck = stick.tuck || keys.has("ShiftLeft") || keys.has("ShiftRight");
    const jump = jumpRequest;
    jumpRequest = false;

    const wasAirborne = rider.airborne;
    rider.update(dt, { x: ix, y: iy, tuck, jump }, camYaw);
    if (rig) rig.update(dt);

    // ---- The sun, which is the clock ---------------------------------
    if (!arrived) {
      sunElevation -= dt / DAYLIGHT;
      if (sunElevation < -0.18) benighted = true;
    }
    sky.setElevation(sunElevation);
    sunLight.position.copy(sky.sunDir).multiplyScalar(300).add(rider.position);
    sunLight.target.position.copy(rider.position);
    sunLight.target.updateMatrixWorld();
    sunLight.color.copy(sky.sunColor);
    sunLight.intensity = 1.2 + Math.max(0, sunElevation) * 1.8;
    skyFill.color.copy(sky.skyColor);
    skyFill.intensity = 0.35 + Math.max(0, sunElevation) * 0.5;
    // A slice of the shadow march every frame rather than the whole field
    // every six seconds. Same total work, no long frame anywhere — and the
    // shadows keep up with a sun that is always moving.
    sand.stepShadows(sky.sunDir, shadowBudget);

    // ---- Gates ---------------------------------------------------------
    for (const g of gates) {
      if (g.passed) continue;
      const d = Math.hypot(rider.position.x - g.x, rider.position.z - g.z);
      const mat = g.ring.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.2 + Math.sin(elapsed * 3 + g.x) * 0.35;
      if (d < 8 && Math.abs(rider.position.y - g.group.position.y) < 12) {
        g.passed = true;
        gatesPassed++;
        // The reward is daylight, and you can see it happen: the sun lifts.
        sunElevation = Math.min(1, sunElevation + GATE_DAYLIGHT);
        mat.emissiveIntensity = 0.15;
        (mat.color as THREE.Color).set("#2a6a55");
      }
    }

    // ---- Arrival --------------------------------------------------------
    const distance = Math.hypot(rider.position.x, rider.position.z);
    if (!arrived && distance < OASIS_RADIUS * 0.7) arrived = true;

    // ---- Spray ----------------------------------------------------------
    if (!rider.airborne) {
      const n = Math.round(rider.carve * 6 + Math.min(2, rider.speed / 22));
      if (n > 0) {
        emitSpray(
          rider.position.x,
          rider.position.y,
          rider.position.z,
          rider.velocity.x,
          rider.velocity.z,
          n,
        );
      }
      // A landing throws a lot more sand than a carve does.
      if (wasAirborne) {
        emitSpray(
          rider.position.x,
          rider.position.y,
          rider.position.z,
          rider.velocity.x,
          rider.velocity.z,
          Math.min(40, 12 + Math.round(rider.speed)),
        );
      }
    }
    if (rider.airborne) bestAir = Math.max(bestAir, rider.airTime);
    for (let i = 0; i < sprayCount; i++) {
      if (sprayLife[i] <= 0) continue;
      sprayLife[i] -= dt * 0.85;
      sprayVel[i * 3 + 1] -= 11 * dt;
      sprayPos[i * 3] += sprayVel[i * 3] * dt;
      sprayPos[i * 3 + 1] += sprayVel[i * 3 + 1] * dt;
      sprayPos[i * 3 + 2] += sprayVel[i * 3 + 2] * dt;
    }
    (sprayGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (sprayGeo.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
    (sprayMat.uniforms.uColor.value as THREE.Color).copy(sky.sunColor).lerp(sky.skyColor, 0.35);

    // ---- Camera ----------------------------------------------------------
    const speed = rider.speed;
    const travel = speed > 2 ? Math.atan2(rider.velocity.x, rider.velocity.z) : rider.heading;
    yawOffset *= Math.exp(-(dragging ? 0 : 1.2) * dt);
    let delta = travel + yawOffset - camYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    camYaw += delta * (1 - Math.exp(-3 * dt));

    const dist = camDist + Math.min(8, speed * 0.18);
    camGoal.set(
      rider.position.x - Math.sin(camYaw) * dist,
      // Sixteen metres up, not eight. The features here are a hundred and
      // sixty metres across: from head height a dune field foreshortens
      // into a flat wash with a straight horizon on it, and the only way
      // to see that the ground rolls is to get above it.
      rider.position.y + 16 + pitch * 10 + Math.min(5, speed * 0.09),
      rider.position.z - Math.cos(camYaw) * dist,
    );
    // Never let the camera end up inside a dune — the ground is a function,
    // so this is one call rather than a raycast against 90,000 triangles.
    const camFloor = duneHeight(camGoal.x, camGoal.z) + 2.2;
    if (camGoal.y < camFloor) camGoal.y = camFloor;
    camera.position.lerp(camGoal, 1 - Math.exp(-6 * dt));
    camTarget.lerp(
      // Aim well ahead of the board, not at it: that is what puts the
      // horizon and the next two dunes in the frame instead of your own
      // shadow.
      lookAt.set(
        rider.position.x + Math.sin(camYaw) * 26,
        rider.position.y + 6.5,
        rider.position.z + Math.cos(camYaw) * 26,
      ),
      1 - Math.exp(-8 * dt),
    );
    camera.lookAt(camTarget);
    const wantFov = 64 + Math.min(16, speed * 0.4);
    camera.fov += (wantFov - camera.fov) * (1 - Math.exp(-3 * dt));
    camera.updateProjectionMatrix();

    sky.update(elapsed, camera);
    sand.update(sky.sunDir, sky.sunColor, sky.skyColor, elapsed);
    (sand.material.uniforms.uCamera.value as THREE.Vector3).copy(camera.position);
    postfx.setHeat(Math.max(0, sunElevation) * 0.9);
    postfx.render(renderer, scene, camera, elapsed);

    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      onState({
        gates: gatesPassed,
        totalGates: gates.length,
        speed,
        distance,
        sun: sunElevation,
        airTime: rider.airborne ? rider.airTime : 0,
        bestAir,
        arrived,
        benighted,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  // Test aid: the harness cannot ride nine hundred metres at four frames a
  // second, and every assertion worth making is about what happens when it
  // arrives. Placement goes through the same physics reset the run does.
  const debug = {
    character: () => charId,
    postfx: () => postfx.info,
    setGlow: (v: number) => postfx.setGlow(v),
    probeSand: (mode: "off" | "front" | "double") => sand.setProbe(mode),
    state: () => ({
      gates: gatesPassed,
      sun: sunElevation,
      distance: Math.hypot(rider.position.x, rider.position.z),
      speed: rider.speed,
      arrived,
      airborne: rider.airborne,
      groundError: rider.position.y - duneHeight(rider.position.x, rider.position.z),
    }),
    gates: () => gates.filter((g) => !g.passed).map((g) => [g.x, g.z] as [number, number]),
    warp: (x: number, z: number) => rider.reset(x, z),
    setSun: (e: number) => {
      sunElevation = e;
      sky.setElevation(e);
      // Full sweep, immediately: a capture must not photograph a field
      // that is half-way through catching up with a sun that just jumped.
      sand.refreshShadows(sky.sunDir);
    },
  };
  (window as unknown as { __duneDebug?: typeof debug }).__duneDebug = debug;

  return {
    stick,
    jump() {
      jumpRequest = true;
    },
    restart: startRun,
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
      canvas.removeEventListener("wheel", onWheel);
      delete (window as unknown as { __duneDebug?: unknown }).__duneDebug;
      rigDropped = true;
      rider.unmount();
      rig?.dispose();
      rig = null;
      sky.dispose();
      sand.dispose();
      rider.dispose();
      postfx.dispose();
      sprayGeo.dispose();
      sprayMat.dispose();
      gates.forEach((g) => {
        g.ring.geometry.dispose();
        (g.ring.material as THREE.Material).dispose();
      });
      oasis.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
