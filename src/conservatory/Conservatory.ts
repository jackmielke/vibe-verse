/**
 * The Conservatory — engine.
 *
 * A glasshouse at the end of a wet afternoon. There is nothing to collect
 * and nothing to survive; you walk the length of it slowly and the light
 * does the work. That is the point — the vibeverse has fifty-odd realms and
 * every one of them wants something from you.
 *
 * Because there is no game underneath, everything rests on the room being
 * convincing, so the choices here are all about *not* breaking the illusion:
 *
 *  - Walking pace is 1.35 m/s, roughly a real amble. Every other realm here
 *    moves at 10–30 m/s, which is right for them and would make this one
 *    feel like a corridor to get through.
 *  - The head bob is 1.4 cm. Big enough to feel, small enough not to notice.
 *  - Gusts are a stochastic process rather than a sine: they arrive, hold,
 *    and pass, and the whole house leans together while one is on.
 *  - The rain is audible and its level tracks the gust, so what you hear and
 *    what you see are the same weather.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON, conservatoryUniforms } from "./shaders";
import {
  brickMaterial, buildStructure, floorMaterial, glassMaterial, ironMaterial, insideNave,
  NAVE, soilMaterial, waterMaterial,
} from "./structure";
import { buildPlanting } from "./planting";
import { buildMotes, buildRainOutside, buildShafts, type AirSystem } from "./air";

export interface ConservatoryWorld {
  dispose(): void;
  setMuted(muted: boolean): void;
}

export interface ConservatoryOptions {
  container: HTMLElement;
  /** Metres walked, for the page's one line of chrome. */
  onWalked?: (metres: number) => void;
  muted?: boolean;
}

const EYE = 1.68;
const WALK = 1.35;

export function createConservatory(opts: ConservatoryOptions): ConservatoryWorld {
  const { container } = opts;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Slightly under 1: the room is meant to be dim, with the beams as the
  // only bright thing. Exposed to taste against a real photograph of a
  // palm house on a grey day.
  // Late afternoon, not noon. The beams should be the brightest thing in
  // the frame by a clear margin.
  renderer.toneMappingExposure = 0.92;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    58, container.clientWidth / Math.max(1, container.clientHeight), 0.05, 220,
  );
  camera.position.set(0, EYE, NAVE.length / 2 - 3);

  const uniforms = conservatoryUniforms() as unknown as Record<string, THREE.IUniform>;

  // ---- Outside -------------------------------------------------------
  // A dome standing in for the weather beyond the glass. It never needs to
  // be interesting; it needs to be the right grey, because every pane in
  // the building is showing it.
  const skyGeo = new THREE.SphereGeometry(160, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      ${CONSERVATORY_COMMON}
      void main(){
        vec3 d = normalize(vW - uCamPos);
        // Overcast: bright at the horizon, heavier overhead. The opposite
        // of a clear sky, and the reason wet daylight looks flat.
        float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        // Dimmer than it was. The dome is seen through every pane in the
        // building, so its brightness sets how much the glass blows out.
        vec3 col = mix(uSkyColor * 1.30, uSkyColor * 0.78, smoothstep(0.40, 1.0, up));
        // A bright rip in the cloud where the sun is getting through.
        float s = max(0.0, dot(d, normalize(uSunDir)));
        col += uSunColor * pow(s, 8.0) * (0.55 + (1.0 - uRain) * 0.9);
        col += uSunColor * pow(s, 60.0) * 1.4;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -2;
  scene.add(sky);

  // ---- The building ---------------------------------------------------
  const iron = ironMaterial(uniforms);
  const glass = glassMaterial(uniforms);
  const floor = floorMaterial(uniforms);
  const brick = brickMaterial(uniforms);
  const soil = soilMaterial(uniforms);
  const water = waterMaterial(uniforms);
  const structure = buildStructure(iron, glass, floor, brick, soil, water);
  scene.add(structure.group);

  const planting = buildPlanting(uniforms);
  scene.add(planting.group);

  const air: AirSystem[] = [
    buildRainOutside(uniforms),
    buildShafts(uniforms),
    buildMotes(uniforms),
  ];
  air.forEach((a) => scene.add(a.group));

  // ---- Rain, heard ----------------------------------------------------
  // Filtered noise, two bands: a wide hiss for the rain in the air, and a
  // narrower resonant one for it hitting glass over your head. The gust
  // opens the filter, so a squall gets brighter as well as louder — which
  // is what actually happens, and what makes it read as weather rather
  // than as a loop.
  let audio: AudioContext | null = null;
  let hissGain: GainNode | null = null;
  let glassGain: GainNode | null = null;
  let master: GainNode | null = null;
  let glassFilter: BiquadFilterNode | null = null;
  const startAudio = () => {
    if (audio) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audio = new Ctx();
      const len = audio.sampleRate * 3;
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = audio.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const lp = audio.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1400; lp.Q.value = 0.4;
      hissGain = audio.createGain(); hissGain.gain.value = 0.05;

      glassFilter = audio.createBiquadFilter();
      glassFilter.type = "bandpass"; glassFilter.frequency.value = 3200; glassFilter.Q.value = 0.9;
      glassGain = audio.createGain(); glassGain.gain.value = 0.03;

      master = audio.createGain();
      master.gain.value = opts.muted ? 0 : 1;

      src.connect(lp).connect(hissGain).connect(master);
      src.connect(glassFilter).connect(glassGain).connect(master);
      master.connect(audio.destination);
      src.start();
    } catch {
      /* No audio is a fine conservatory. */
      audio = null;
    }
  };

  // ---- Looking and walking ---------------------------------------------
  /* Facing down the length of the house — which is yaw 0, not PI.
     A three.js camera looks down -Z by default, and the walk starts at
     z = +21 in a nave that runs to z = -24. Setting yaw to PI turned the
     camera around to face the near gable three metres behind it, and the
     forty-eight metres this realm is built around were off-screen the whole
     time. Everything looked like sky because it WAS sky: I was standing at
     one end of a glasshouse looking out of the end wall. */
  let yaw = 0;
  let pitch = -0.03;
  const vel = new THREE.Vector3();
  let walked = 0;
  let bobPhase = 0;
  let roll = 0;

  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    keys.add(e.code);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) e.preventDefault();
    startAudio();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);

  let dragging = false;
  let lastX = 0, lastY = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
    startAudio();
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.0026;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - lastY) * 0.0026, -1.2, 1.2);
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  };
  let touchWalk = false;
  const onTouchStart = () => { touchWalk = true; startAudio(); };
  const onTouchEnd = (e: TouchEvent) => { if (e.touches.length === 0) touchWalk = false; };

  const el = renderer.domElement;
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  onResize();
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  // ---- Weather ----------------------------------------------------------
  /* A gust is an event, not a waveform. One is scheduled, it ramps in over
     a second or two, holds, and decays — and `uGust` is the single number
     the leaves, the dust and the rain all lean on, so the room moves as one
     body of air rather than as a hundred independent wobbles. */
  let gust = 0;
  let gustTarget = 0;
  let nextGust = 3 + Math.random() * 6;

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const wish = new THREE.Vector3();
  const clock = new THREE.Clock();
  let raf = 0;
  let disposed = false;

  interface ConsDebug {
    look(): { hits: { name: string; dist: number }[]; cam: number[] };
    show(name: string, on: boolean): void;
    down(): { name: string; dist: number; mat: string }[];
    up(): { name: string; dist: number }[];
    setLook(yaw: number, pitch: number): void;
    rayAt(deg: number): { d: number; y: number; n: number }[];
    census(): string[];
  }
  const dev = window as unknown as { __consDebug?: ConsDebug };
  const named = new Map<string, THREE.Object3D>([
    ["sky", sky], ["structure", structure.group], ["planting", planting.group],
    ["rain", air[0].group], ["shafts", air[1].group], ["motes", air[2].group],
  ]);
  dev.__consDebug = {
    look() {
      const ray = new THREE.Raycaster();
      const d = new THREE.Vector3();
      camera.getWorldDirection(d);
      ray.set(camera.position, d);
      const hits = ray.intersectObjects(scene.children, true).slice(0, 6).map((h) => ({
        name: h.object.name || h.object.type, dist: +h.distance.toFixed(2),
      }));
      return { hits, cam: camera.position.toArray().map((n) => +n.toFixed(2)) };
    },
    show(name, on) { const o = named.get(name); if (o) o.visible = on; },
    setLook(y: number, pi: number) { yaw = y; pitch = pi; },
    rayAt(deg: number) {
      const a = (deg * Math.PI) / 180;
      const d = new THREE.Vector3(0, Math.sin(a), Math.cos(a)).normalize();
      const ray = new THREE.Raycaster();
      ray.set(camera.position, d);
      return ray.intersectObjects(scene.children, true).slice(0, 4).map((h) => ({
        d: +h.distance.toFixed(2), y: +h.point.y.toFixed(2),
        n: (h.object as THREE.Mesh).geometry?.attributes.position?.count ?? 0,
      }));
    },
    up() {
      const ray = new THREE.Raycaster();
      ray.set(camera.position, new THREE.Vector3(0, 1, 0));
      return ray.intersectObjects(scene.children, true).slice(0,3).map((h) => ({
        name: h.object.name || h.object.type, dist: +h.distance.toFixed(2) }));
    },
    down() {
      const ray = new THREE.Raycaster();
      ray.set(camera.position, new THREE.Vector3(0, -1, 0));
      return ray.intersectObjects(scene.children, true).map((h) => ({
        name: h.object.name || h.object.type, dist: +h.distance.toFixed(2),
        mat: (h.object as THREE.Mesh).material ? ((h.object as THREE.Mesh).material as THREE.Material).type : "?",
      }));
    },
    census() {
      const out: string[] = [];
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) out.push(`${o.type} vis=${o.visible} tris=${(m.geometry?.attributes.position?.count ?? 0) / 3} y=${o.position.y.toFixed(2)}`);
      });
      return out;
    },
  };

  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    // Gusts.
    nextGust -= dt;
    if (nextGust <= 0) {
      gustTarget = 0.35 + Math.random() * 0.75;
      nextGust = 5 + Math.random() * 11;
      // The gust decays on its own; the target is only the peak.
      window.setTimeout(() => { gustTarget = 0; }, 1400 + Math.random() * 2600);
    }
    gust += (gustTarget - gust) * Math.min(1, dt * (gustTarget > gust ? 1.6 : 0.7));

    /* Orientation, via a YXZ Euler — the standard first-person order, and
       the only one that is safe here.

       Two earlier attempts got this wrong in the same underlying way. The
       first assigned `camera.rotation.z` at the end of the frame to apply
       the head-bob roll; the second composed rotateY/rotateX/rotateZ. Both
       leave the result at the mercy of how three decomposes the quaternion
       into an XYZ Euler, and at a yaw near PI that decomposition puts PI in
       x and z — so the camera ends up upside down and the entire realm
       renders flipped, with the floor as a band along the top of the frame.
       Every object is exactly where it belongs, which makes it a horrible
       thing to find by reading.

       YXZ means yaw, then pitch, then roll, applied in that order, which is
       what a head on a neck actually does. */
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, up).normalize();

    wish.set(0, 0, 0);
    if (keys.has("KeyW") || keys.has("ArrowUp") || touchWalk) wish.add(forward);
    if (keys.has("KeyS") || keys.has("ArrowDown")) wish.sub(forward);
    if (keys.has("KeyD") || keys.has("ArrowRight")) wish.add(right);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) wish.sub(right);
    const hurrying = keys.has("ShiftLeft") || keys.has("ShiftRight");
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(WALK * (hurrying ? 1.9 : 1));

    // Ease into and out of walking. Nobody starts at full pace.
    vel.lerp(wish, Math.min(1, dt * 7));
    const step = vel.length() * dt;
    const nx = camera.position.x + vel.x * dt;
    const nz = camera.position.z + vel.z * dt;
    if (insideNave(nx, camera.position.z)) camera.position.x = nx;
    if (insideNave(camera.position.x, nz)) camera.position.z = nz;
    // Keep to the path — the beds are planted, not walked on.
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -3.25, 3.25);
    walked += step;

    // Head bob, tied to distance rather than to time, so it stops dead when
    // you do instead of pacing on the spot.
    bobPhase += step * 3.4;
    const moving = Math.min(1, vel.length() / WALK);
    camera.position.y = EYE
      + Math.sin(bobPhase) * 0.014 * moving
      + Math.sin(t * 0.35) * 0.004;          // standing sway
    // Applied at the top of the NEXT frame, through rotateZ. One frame of
    // lag on a six-thousandths-of-a-radian roll is not a thing anyone can
    // see, and it keeps the composition honest.
    roll = Math.sin(bobPhase * 0.5) * 0.006 * moving;

    (uniforms.uCamPos.value as number[])[0] = camera.position.x;
    (uniforms.uCamPos.value as number[])[1] = camera.position.y;
    (uniforms.uCamPos.value as number[])[2] = camera.position.z;
    uniforms.uTime.value = t;
    uniforms.uGust.value = gust;

    if (hissGain && glassGain && glassFilter) {
      hissGain.gain.value = 0.035 + gust * 0.045;
      glassGain.gain.value = 0.018 + gust * 0.05;
      glassFilter.frequency.value = 2600 + gust * 2200;
    }

    for (const a of air) a.update(dt, t, camera);
    sky.position.set(camera.position.x, 0, camera.position.z);

    opts.onWalked?.(walked);
    renderer.render(scene, camera);
  };
  frame();

  return {
    setMuted(muted: boolean) {
      if (master) master.gain.value = muted ? 0 : 1;
    },
    dispose() {
      disposed = true;
      delete dev.__consDebug;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      air.forEach((a) => a.dispose());
      planting.dispose();
      structure.dispose();
      skyGeo.dispose(); skyMat.dispose();
      iron.dispose(); glass.dispose(); floor.dispose(); brick.dispose();
      soil.dispose(); water.dispose();
      // An audio context left open counts against a hard per-page limit,
      // and a leaked WebGL context breaks the NEXT realm somebody opens.
      void audio?.close().catch(() => {});
      audio = null;
      renderer.dispose();
      renderer.forceContextLoss();
      if (el.parentNode === container) container.removeChild(el);
    },
  };
}
