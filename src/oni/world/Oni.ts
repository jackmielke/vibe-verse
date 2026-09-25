/**
 * Oni: the engine.
 *
 * One renderer, the festival square, you, and everybody else. You are seen
 * from over your shoulder on a laptop or a phone and from your own eyes in a
 * headset; the projector (`watch`) circles the square from above and is not
 * a player at all.
 *
 * What is decided where:
 *  - `rules.ts` is the game, pure.
 *  - `match.ts` holds the round and the tags and runs the referee's clock.
 *  - here: where everybody is, and whether two of them just touched.
 *
 * Other players arrive as presence packets a few times a second with a
 * velocity; they are drawn where that velocity says they are *now*, eased,
 * so a slow packet rate still reads as running.
 */
import * as THREE from "three";
import { CHARACTERS } from "@/lib/characters";
import { createMatch, type Match } from "../match";
import { joinOniRoom, readNetMode, readRoom, type OniRoom, type Peer } from "../net";
import {
  GRAVITY, JUMP_SPEED, ONI_SPEED, RUN_SPEED, ROUND_MS, TAG_GRACE_MS, TAG_RADIUS, TAG_RADIUS_ONI,
  solve, spawnFor, type Phase, type Round, type Tag,
} from "../rules";
import { buildArena } from "./arena";
import { createAvatar, type Avatar } from "./avatars";
import { createSfx } from "./sfx";

export interface HudPlayer { id: string; name: string; char: string; oni: boolean; me: boolean; bot: boolean }

export interface Hud {
  phase: Phase;
  connected: boolean;
  /** Seconds of chase left, while playing. */
  left: number;
  /** Seconds until the chase starts, in the countdown. */
  countdown: number;
  /** Seconds until the next round is announced, if known. */
  nextIn: number | null;
  me: { id: string; oni: boolean } | null;
  players: HudPlayer[];
  runners: number;
  onis: number;
  result: { lastStanding: string | null; survived: number; survivors: string[]; topOni: string | null; topCount: number } | null;
  inVR: boolean;
}

export interface FeedLine { text: string; kind: "tag" | "join" | "leave" | "round" | "over" | "emote"; at: number }

export interface OniOptions {
  container: HTMLElement;
  name: string;
  char: string;
  /** The projector: a camera over the square, not a player. */
  watch?: boolean;
  /** Local practice opponents (no network). */
  bots?: number;
  phone?: boolean;
  onHud?(h: Hud): void;
  onFeed?(line: FeedLine): void;
}

export interface OniEngine {
  setStick(x: number, y: number): void;
  jump(): void;
  honk(emoji?: string): void;
  setChar(id: string): void;
  setName(name: string): void;
  start(): void;
  vrSupported(): Promise<boolean>;
  enterVR(): Promise<void>;
  setMuted(m: boolean): void;
  resumeAudio(): void;
  roomName: string;
  dispose(): void;
}

interface Remote {
  id: string;
  avatar: Avatar;
  x: number; y: number; z: number;
  yaw: number;
  speed: number;
  bot: boolean;
}

interface Bot { id: string; name: string; char: string; x: number; z: number; y: number; vy: number; vx: number; vz: number; yaw: number; wander: number }

const BOT_NAMES = ["Kenji", "Hana", "Momo", "Taro", "Yuki", "Sora", "Riku", "Aoi", "Mochi", "Daifuku"];
const EMOTES = ["😂", "👋", "🏃", "💨", "😱", "🥳", "👹", "🙈"];

export function createOni(opts: OniOptions): OniEngine {
  const { container } = opts;
  const watch = !!opts.watch;
  const phone = !!opts.phone;
  const renderer = new THREE.WebGLRenderer({ antialias: !phone, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.xr.enabled = true;
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#b98784", 45, 190);
  const camera = new THREE.PerspectiveCamera(58, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 600);
  const camRig = new THREE.Group();
  camRig.add(camera);
  scene.add(camRig);

  const arena = buildArena({ light: phone });
  scene.add(arena.group);
  const sfx = createSfx();

  // ---- VR HUD: a strip of text under the view --------------------------------
  const vrCanvas = document.createElement("canvas");
  vrCanvas.width = 1024; vrCanvas.height = 192;
  const vrTex = new THREE.CanvasTexture(vrCanvas);
  vrTex.colorSpace = THREE.SRGBColorSpace;
  const vrHud = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.12), new THREE.MeshBasicMaterial({ map: vrTex, transparent: true, depthTest: false, depthWrite: false }));
  vrHud.position.set(0, -0.26, -0.9);
  vrHud.rotation.x = -0.25;
  vrHud.renderOrder = 20;
  vrHud.visible = false;
  camera.add(vrHud);
  let vrText = "";
  const drawVrHud = (text: string, red: boolean) => {
    if (text === vrText) return;
    vrText = text;
    const g = vrCanvas.getContext("2d")!;
    g.clearRect(0, 0, 1024, 192);
    g.fillStyle = red ? "rgba(190,30,30,0.8)" : "rgba(10,12,24,0.7)";
    g.beginPath(); g.roundRect(40, 30, 944, 132, 60); g.fill();
    g.fillStyle = "#fff"; g.font = "600 64px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 512, 98);
    vrTex.needsUpdate = true;
  };

  // ---- us ------------------------------------------------------------------------
  let myName = opts.name.trim().slice(0, 16) || "player";
  let myChar = opts.char;
  const me = { x: 0, y: 0, z: 17, vx: 0, vz: 0, vy: 0, yaw: Math.PI, speed: 0 };
  {
    const a = Math.random() * Math.PI * 2;
    const p = solve(Math.cos(a) * 15, Math.sin(a) * 15);
    me.x = p.x; me.z = p.z; me.yaw = Math.atan2(-p.x, -p.z);
  }
  let myAvatar: Avatar | null = null;
  const myIdHolder = { id: watch ? null as string | null : Math.random().toString(36).slice(2, 10) };
  const myId = myIdHolder.id;
  if (!watch) {
    myAvatar = createAvatar({ id: myId!, name: myName, char: myChar });
    scene.add(myAvatar.group);
  }

  // ---- everybody else ----------------------------------------------------------
  const remotes = new Map<string, Remote>();
  const names = new Map<string, string>();
  if (myId) names.set(myId, myName);
  let room: OniRoom | null = null;
  let connected = false;
  const botMode = !watch && (opts.bots ?? 0) > 0;
  const bots: Bot[] = [];
  if (botMode) {
    const pool = CHARACTERS.filter((c) => c.id !== myChar);
    for (let i = 0; i < Math.min(9, opts.bots!); i++) {
      const a = (i / opts.bots!) * Math.PI * 2;
      const p = solve(Math.cos(a) * 12, Math.sin(a) * 12);
      const c = pool[(i * 7 + 3) % pool.length];
      bots.push({ id: `~bot${i}`, name: BOT_NAMES[i % BOT_NAMES.length], char: c.id, x: p.x, z: p.z, y: 0, vy: 0, vx: 0, vz: 0, yaw: 0, wander: Math.random() * 10 });
    }
    for (const b of bots) names.set(b.id, b.name);
  }
  const peerList = (): Peer[] => {
    const list = room?.peers() ?? [];
    if (!bots.length) return list;
    return [...list, ...bots.map<Peer>((b) => ({ id: b.id, name: b.name, char: b.char, x: b.x, y: b.y, z: b.z, yaw: b.yaw, vx: b.vx, vz: b.vz, oni: false, round: "", at: performance.now() }))];
  };

  const feed = (text: string, kind: FeedLine["kind"]) => opts.onFeed?.({ text, kind, at: Date.now() });
  const nameOf = (id: string) => (id === myId ? "you" : names.get(id) ?? "someone");
  const NameOf = (id: string) => { const n = nameOf(id); return n === "you" ? "You" : n; };

  // ---- effects: a burst of red confetti when somebody turns ---------------------
  const BURST = 90;
  const burstPos = new Float32Array(BURST * 3);
  const burstVel = new Float32Array(BURST * 3);
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute("position", new THREE.BufferAttribute(burstPos, 3));
  const burstMat = new THREE.PointsMaterial({ color: "#ff5a3a", size: 0.18, transparent: true, opacity: 0, depthWrite: false });
  const burst = new THREE.Points(burstGeo, burstMat);
  burst.frustumCulled = false;
  scene.add(burst);
  let burstT = 9;
  const doBurst = (x: number, y: number, z: number) => {
    for (let i = 0; i < BURST; i++) {
      burstPos[i * 3] = x; burstPos[i * 3 + 1] = y + 1.2; burstPos[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1;
      const s = 3 + Math.random() * 4;
      burstVel[i * 3] = Math.cos(a) * Math.sqrt(1 - u * u) * s;
      burstVel[i * 3 + 1] = Math.abs(u) * s + 2;
      burstVel[i * 3 + 2] = Math.sin(a) * Math.sqrt(1 - u * u) * s;
    }
    burstT = 0;
  };

  // ---- the hunt arrow: an oni sees which way the nearest runner is ---------------
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.55); arrowShape.lineTo(0.32, 0); arrowShape.lineTo(0.12, 0.05); arrowShape.lineTo(0.12, -0.35);
  arrowShape.lineTo(-0.12, -0.35); arrowShape.lineTo(-0.12, 0.05); arrowShape.lineTo(-0.32, 0); arrowShape.closePath();
  const arrowGeo = new THREE.ShapeGeometry(arrowShape);
  arrowGeo.rotateX(-Math.PI / 2);
  const arrowMat = new THREE.MeshBasicMaterial({ color: "#ff4a2a", transparent: true, opacity: 0.85, depthWrite: false });
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.visible = false;
  scene.add(arrow);

  // ---- the match ------------------------------------------------------------------
  let shake = 0;
  const lastClaim = new Map<string, number>();
  const match: Match = createMatch({
    me: myId,
    room: () => room,
    peers: peerList,
    events: {
      onRound(r: Round) {
        lastClaim.clear();
        if (myId) {
          const s = spawnFor(myId, r);
          me.x = s.x; me.z = s.z; me.yaw = s.yaw; me.vx = me.vz = 0;
          moveTarget = null;
          camYaw = s.yaw + Math.PI;
        }
        for (const b of bots) { const s = spawnFor(b.id, r); b.x = s.x; b.z = s.z; b.yaw = s.yaw; }
        const first = r.first.map(NameOf).join(" and ");
        feed(`New round! ${first} ${r.first.length > 1 ? "are" : "is"} the oni`, "round");
        lastCount = -1;
      },
      onTag(t: Tag) {
        const r = remotes.get(t.victim);
        const pos = t.victim === myId ? me : r ?? null;
        if (pos) doBurst(pos.x, pos.y, pos.z);
        const close = t.victim === myId || t.by === myId;
        sfx.tag(close);
        if (t.victim === myId) {
          shake = 0.6;
          try { navigator.vibrate?.([80, 40, 160]); } catch { /* no vibration */ }
        }
        const by = t.by && t.by !== "?" ? NameOf(t.by) : null;
        feed(by ? `${by} caught ${nameOf(t.victim)} 👹` : `${NameOf(t.victim)} turned oni 👹`, "tag");
      },
      onEmote(id, e) {
        if (id === myId) myAvatar?.emote(e);
        else remotes.get(id)?.avatar.emote(e);
        sfx.honk();
      },
      onOver(_r, res) {
        sfx.drum(false);
        sfx.fanfare();
        if (res.lastStanding) feed(`${NameOf(res.lastStanding.id)} ${res.lastStanding.id === myId ? "were" : "was"} the last one standing!`, "over");
        else if (res.survivors.length) feed(`Time! ${res.survivors.map(NameOf).join(", ")} survived`, "over");
      },
    },
  });

  const syncRemotes = (list: Peer[]) => {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      names.set(p.id, p.name);
      let r = remotes.get(p.id);
      if (!r) {
        const avatar = createAvatar({ id: p.id, name: p.name, char: p.char, big: watch });
        scene.add(avatar.group);
        r = { id: p.id, avatar, x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: 0, bot: p.id.startsWith("~") };
        avatar.group.position.set(p.x, p.y, p.z);
        remotes.set(p.id, r);
      }
      r.avatar.setName(p.name);
      r.avatar.setChar(p.char);
    }
    for (const [id, r] of remotes) {
      if (seen.has(id)) continue;
      scene.remove(r.avatar.group);
      r.avatar.dispose();
      remotes.delete(id);
    }
  };
  if (bots.length) syncRemotes(peerList());

  const roomName = readRoom();
  const netMode = botMode ? "off" : readNetMode();
  let disposed = false;
  void joinOniRoom({
    mode: netMode,
    room: roomName,
    id: myId ?? undefined,
    onMessage: (m) => match.handle(m),
    onPeers: () => syncRemotes(peerList()),
    onJoin: (p) => feed(`${p.name} joined`, "join"),
    onLeave: (p) => feed(`${p.name} left`, "leave"),
  }).then((r) => {
    if (disposed) { r.close(); return; }
    room = r;
    connected = r.connected;
    if (watch) r.send({ t: "hi", id: `w-${Math.random().toString(36).slice(2, 7)}` });
  });

  // ---- input ------------------------------------------------------------------------
  let camYaw = me.yaw + Math.PI;
  let camPitch = phone ? 0.62 : 0.5;
  let camDist = phone ? 10 : 8.5;
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  let jumpQueued = false;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input,textarea")) return;
    const k = e.key.toLowerCase();
    if (e.type === "keydown") {
      keys.add(k);
      if (k === " ") { jumpQueued = true; e.preventDefault(); }
      if (k === "h") engine.honk();
    } else keys.delete(k);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  // ---- where we are running to, if somewhere was tapped or pointed at -------------
  let moveTarget: { x: number; z: number } | null = null;
  let targetBest = Infinity;
  let targetStuck = 0;
  const setTarget = (x: number, z: number) => {
    if (!myId) return;
    const p = solve(x, z);
    moveTarget = { x: p.x, z: p.z };
    targetBest = Infinity;
    targetStuck = 0;
    markerPop = 1;
  };
  const markerMat = new THREE.MeshBasicMaterial({ color: "#ffe08a", transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  const markerGeo = new THREE.RingGeometry(0.32, 0.46, 32);
  markerGeo.rotateX(-Math.PI / 2);
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.visible = false;
  scene.add(marker);
  let markerPop = 0;

  // A tap or a click on the ground (one that did not turn into a drag) runs
  // us there; a drag still turns the camera.
  const drag = { id: -1, x: 0, y: 0, sx: 0, sy: 0, t: 0 };
  const el = renderer.domElement;
  const tapRay = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tapHit = new THREE.Vector3();
  const onDown = (e: PointerEvent) => {
    sfx.resume();
    if (drag.id !== -1) return;
    drag.id = e.pointerId; drag.x = drag.sx = e.clientX; drag.y = drag.sy = e.clientY; drag.t = performance.now();
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    camYaw -= dx * 0.006;
    camPitch = Math.max(0.15, Math.min(1.2, camPitch + dy * 0.004));
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    drag.id = -1;
    const still = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 10 && performance.now() - drag.t < 400;
    if (!still || watch || inVR()) return;
    const r = el.getBoundingClientRect();
    tapRay.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    if (tapRay.ray.intersectPlane(ground, tapHit) && Math.hypot(tapHit.x - me.x, tapHit.z - me.z) < 60) setTarget(tapHit.x, tapHit.z);
  };
  const onWheel = (e: WheelEvent) => { camDist = Math.max(4.5, Math.min(18, camDist * (1 + Math.sign(e.deltaY) * 0.08))); };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("wheel", onWheel, { passive: true });

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    // Keep about 80 degrees across on a portrait phone.
    camera.fov = camera.aspect < 1 ? Math.min(85, 2 * Math.atan(Math.tan((80 * Math.PI) / 360) / camera.aspect) * (180 / Math.PI)) : 58;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);
  onResize();

  // ---- VR ---------------------------------------------------------------------------
  let vrYaw = 0;
  let snapCool = 0;
  let vrButtons: boolean[] = [];
  const headWorld = new THREE.Vector3();
  const headDir = new THREE.Vector3();
  const inVR = () => renderer.xr.isPresenting;

  // Point and pull the trigger (or pinch) to run to where the laser meets the
  // ground; hold it to keep steering. Each controller, or hand, has its own.
  interface Pointer { ctrl: THREE.Group; laser: THREE.Line; reticle: THREE.Mesh; hit: THREE.Vector3 | null; held: boolean; live: boolean }
  const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const laserMat = new THREE.LineBasicMaterial({ color: "#ffe6d6", transparent: true, opacity: 0.75 });
  const reticleGeo = new THREE.RingGeometry(0.18, 0.26, 28);
  reticleGeo.rotateX(-Math.PI / 2);
  const reticleMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const pointers: Pointer[] = [];
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const laser = new THREE.Line(laserGeo, laserMat);
    laser.visible = false;
    ctrl.add(laser);
    camRig.add(ctrl);
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    reticle.visible = false;
    scene.add(reticle);
    const p: Pointer = { ctrl, laser, reticle, hit: null, held: false, live: false };
    ctrl.addEventListener("connected", () => { p.live = true; });
    ctrl.addEventListener("disconnected", () => { p.live = false; p.held = false; laser.visible = false; reticle.visible = false; });
    ctrl.addEventListener("selectstart", () => { p.held = true; if (p.hit) setTarget(p.hit.x, p.hit.z); });
    ctrl.addEventListener("selectend", () => { p.held = false; });
    pointers.push(p);
  }
  const rayO = new THREE.Vector3();
  const rayD = new THREE.Vector3();
  function updatePointers() {
    for (const p of pointers) {
      const on = inVR() && p.live && !!myId;
      p.laser.visible = on;
      if (!on) { p.reticle.visible = false; p.hit = null; continue; }
      p.ctrl.updateWorldMatrix(true, false);
      rayO.setFromMatrixPosition(p.ctrl.matrixWorld);
      rayD.set(0, 0, -1).transformDirection(p.ctrl.matrixWorld);
      let len = 6;
      p.hit = null;
      if (rayD.y < -0.02) {
        const t = -rayO.y / rayD.y;
        if (t > 0 && t < 45) {
          const c = solve(rayO.x + rayD.x * t, rayO.z + rayD.z * t);
          p.hit = (p.hit ?? new THREE.Vector3()).set(c.x, 0, c.z);
          len = t;
        }
      }
      p.laser.scale.z = len;
      p.reticle.visible = !!p.hit;
      if (p.hit) {
        p.reticle.position.set(p.hit.x, 0.04, p.hit.z);
        p.reticle.scale.setScalar(p.held ? 1.4 : 1);
        if (p.held) setTarget(p.hit.x, p.hit.z);
      }
    }
  }
  renderer.xr.addEventListener("sessionstart", () => {
    vrYaw = me.yaw + Math.PI;
    vrHud.visible = true;
    myAvatar?.setBodyVisible(false);
    if (myAvatar) myAvatar.group.visible = false;
  });
  renderer.xr.addEventListener("sessionend", () => {
    vrHud.visible = false;
    camRig.position.set(0, 0, 0); camRig.rotation.set(0, 0, 0);
    myAvatar?.setBodyVisible(true);
    if (myAvatar) myAvatar.group.visible = true;
  });

  // ---- bots ---------------------------------------------------------------------------
  function updateBots(dt: number, phase: Phase) {
    if (!bots.length) return;
    const everyone = [{ id: myId!, x: me.x, z: me.z }, ...bots.map((b) => ({ id: b.id, x: b.x, z: b.z }))];
    for (const b of bots) {
      b.wander += dt;
      const oni = match.isOni(b.id);
      let tx = Math.sin(b.wander * 0.7) * 0.5, tz = Math.cos(b.wander * 0.53) * 0.5;
      let speed = RUN_SPEED * 0.55;
      if (phase === "play" || phase === "countdown") {
        let best: { x: number; z: number; d: number } | null = null;
        for (const o of everyone) {
          if (o.id === b.id || match.isOni(o.id) === oni) continue;
          const d = Math.hypot(o.x - b.x, o.z - b.z);
          if (!best || d < best.d) best = { x: o.x, z: o.z, d };
        }
        if (best) {
          const dx = (best.x - b.x) / (best.d || 1), dz = (best.z - b.z) / (best.d || 1);
          if (oni) { tx = dx; tz = dz; speed = ONI_SPEED * 0.82; }
          else if (best.d < 11) { tx = -dx + tx * 0.6; tz = -dz + tz * 0.6; speed = RUN_SPEED * 0.9; }
        }
        // Keep off the fence: lean back toward the middle near the edge.
        const r = Math.hypot(b.x, b.z);
        if (r > 17) { tx -= (b.x / r) * (r - 17) * 0.5; tz -= (b.z / r) * (r - 17) * 0.5; }
        if (phase === "countdown" && oni) speed = 0;
      }
      const l = Math.hypot(tx, tz) || 1;
      b.vx += ((tx / l) * speed - b.vx) * Math.min(1, dt * 5);
      b.vz += ((tz / l) * speed - b.vz) * Math.min(1, dt * 5);
      const p = solve(b.x + b.vx * dt, b.z + b.vz * dt);
      b.x = p.x; b.z = p.z;
      if (Math.hypot(b.vx, b.vz) > 0.3) b.yaw = Math.atan2(b.vx, b.vz);
      if (b.y <= 0 && Math.random() < dt * 0.15) b.vy = JUMP_SPEED;
      b.vy -= GRAVITY * dt; b.y = Math.max(0, b.y + b.vy * dt); if (b.y === 0) b.vy = Math.min(0, b.vy);
      const r = remotes.get(b.id);
      if (r) { r.x = b.x; r.y = b.y; r.z = b.z; r.yaw = b.yaw; }
    }
  }

  // ---- tagging --------------------------------------------------------------------------
  function checkTags(now: number) {
    if (!myId) return;
    const tags = match.tags();
    const inGrace = (id: string) => { const t = tags.get(id); return !!t && now - t.at < TAG_GRACE_MS; };
    const bodies: Array<{ id: string; x: number; y: number; z: number }> = [{ id: myId, x: me.x, y: me.y, z: me.z }];
    for (const r of remotes.values()) bodies.push({ id: r.id, x: r.x, y: r.y, z: r.z });
    // We judge touches that involve us; bots are ours to judge entirely.
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        const mine = a.id === myId || b.id === myId;
        const botPair = a.id.startsWith("~") && b.id.startsWith("~");
        if (!mine && !botPair) continue;
        const ao = match.isOni(a.id), bo = match.isOni(b.id);
        if (ao === bo) continue;
        const oni = ao ? a : b, runner = ao ? b : a;
        if (inGrace(oni.id)) continue;
        if (Math.abs(oni.y - runner.y) > 1.1) continue; // hurdled
        const d = Math.hypot(oni.x - runner.x, oni.z - runner.z);
        // The runner's device sees the oni late; the oni's device sees the runner late.
        const limit = runner.id === myId || botPair ? TAG_RADIUS : TAG_RADIUS_ONI;
        if (d > limit) continue;
        const last = lastClaim.get(runner.id) ?? 0;
        if (now - last < 400) continue;
        lastClaim.set(runner.id, now);
        match.claim(runner.id, oni.id);
      }
    }
  }

  // ---- the loop ---------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let time = 0;
  let lastHud = 0;
  let lastCount = -1;
  let lastPhase: Phase = "lobby";
  const fwd = new THREE.Vector3();
  const look = new THREE.Vector3();
  let watchAngle = 0;

  function step(dt: number) {
    time += dt;
    const now = Date.now();
    match.update(now);
    const phase = match.phase(now);
    const round = match.round();
    const meOni = myId ? match.isOni(myId) : false;

    // Sounds that follow the phase.
    if (round && phase === "countdown") {
      const n = Math.ceil((round.start - now) / 1000);
      if (n !== lastCount && n <= 3) { lastCount = n; sfx.count(n); }
    }
    if (phase === "play" && lastPhase === "countdown") { sfx.gong(); feed(meOni ? "Go! You're the oni, catch them!" : "Go! Run!", "round"); }
    if (phase === "play" && round) {
      const left = (round.end - now) / 1000;
      sfx.drum(true, left < 20 ? 1 - left / 20 : 0);
    } else sfx.drum(false);
    lastPhase = phase;

    // ---- move us
    updatePointers();
    if (myId) {
      let ix = 0, iy = 0;
      if (keys.has("w") || keys.has("arrowup")) iy += 1;
      if (keys.has("s") || keys.has("arrowdown")) iy -= 1;
      if (keys.has("a") || keys.has("arrowleft")) ix -= 1;
      if (keys.has("d") || keys.has("arrowright")) ix += 1;
      ix += stick.x; iy += stick.y;
      let yawBase = camYaw;
      if (inVR()) {
        snapCool = Math.max(0, snapCool - dt);
        const session = renderer.xr.getSession();
        const pressed: boolean[] = [];
        for (const src of session?.inputSources ?? []) {
          const gp = src.gamepad;
          if (!gp) continue;
          const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
          if (src.handedness === "right") {
            if (Math.abs(ax[0]) > 0.7 && snapCool === 0) { vrYaw -= Math.sign(ax[0]) * (Math.PI / 6); snapCool = 0.3; }
            if (Math.abs(ax[0]) < 0.3) snapCool = 0;
            // A jumps, B honks. Never button 0: that is a hand's pinch.
            pressed[0] = !!gp.buttons[4]?.pressed; pressed[1] = !!gp.buttons[5]?.pressed;
          } else {
            if (Math.abs(ax[0]) > 0.15) ix += ax[0];
            if (Math.abs(ax[1]) > 0.15) iy -= ax[1];
            pressed[2] = !!gp.buttons[1]?.pressed;
          }
        }
        if (pressed[0] && !vrButtons[0]) jumpQueued = true;
        if ((pressed[1] && !vrButtons[1]) || (pressed[2] && !vrButtons[2])) engine.honk();
        vrButtons = pressed;
        renderer.xr.getCamera().getWorldDirection(headDir);
        yawBase = Math.atan2(-headDir.x, -headDir.z);
      }
      const len = Math.hypot(ix, iy);
      if (len > 1) { ix /= len; iy /= len; }
      const frozen = phase === "countdown" && meOni;
      const speed = frozen ? 0 : meOni && phase === "play" ? ONI_SPEED : RUN_SPEED;
      // Forward is away from the camera.
      const fx = -Math.sin(yawBase), fz = -Math.cos(yawBase);
      const rx = Math.cos(yawBase), rz = -Math.sin(yawBase);
      let tvx = (fx * iy + rx * ix) * speed, tvz = (fz * iy + rz * ix) * speed;
      if (moveTarget) {
        const dx = moveTarget.x - me.x, dz = moveTarget.z - me.z;
        const d = Math.hypot(dx, dz);
        if (len > 0.1 || d < 0.3) moveTarget = null;
        else {
          // Ease in over the last metre, and give up on a spot we cannot reach.
          const ease = Math.min(1, d / 1.1);
          tvx = (dx / d) * speed * ease; tvz = (dz / d) * speed * ease;
          if (speed > 0) {
            if (d < targetBest - 0.05) { targetBest = d; targetStuck = 0; } else targetStuck += dt;
            if (targetStuck > 1.2) moveTarget = null;
          }
        }
      }
      const k = Math.min(1, dt * (len > 0.05 || moveTarget ? 12 : 9));
      me.vx += (tvx - me.vx) * k; me.vz += (tvz - me.vz) * k;
      const p = solve(me.x + me.vx * dt, me.z + me.vz * dt);
      me.x = p.x; me.z = p.z;
      me.speed = Math.hypot(me.vx, me.vz);
      if (me.speed > 0.4) {
        const target = Math.atan2(me.vx, me.vz);
        let d = target - me.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        me.yaw += d * Math.min(1, dt * 14);
      }
      if (jumpQueued && me.y <= 0.001) { me.vy = JUMP_SPEED; sfx.jump(); room?.flush(); }
      jumpQueued = false;
      me.vy -= GRAVITY * dt;
      me.y = Math.max(0, me.y + me.vy * dt);
      if (me.y === 0) me.vy = Math.min(0, me.vy);
      if (myAvatar) {
        myAvatar.group.position.set(me.x, me.y, me.z);
        myAvatar.group.rotation.y = me.yaw;
        myAvatar.setOni(meOni);
        myAvatar.update(dt, me.speed, me.y > 0.05);
      }
      room?.setPresence({ n: myName, c: myChar, x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), yaw: +me.yaw.toFixed(2), vx: +me.vx.toFixed(2), vz: +me.vz.toFixed(2), o: meOni ? 1 : 0, r: round?.id ?? "" });
    }

    // ---- everybody else
    updateBots(dt, phase);
    const peers = room?.peers() ?? [];
    const pnow = performance.now();
    for (const p of peers) {
      const r = remotes.get(p.id);
      if (!r) continue;
      const age = Math.min(0.45, (pnow - p.at) / 1000);
      const tx = p.x + p.vx * age, tz = p.z + p.vz * age;
      const k = 1 - Math.exp(-dt * 10);
      const ox = r.x, oz = r.z;
      r.x += (tx - r.x) * k; r.z += (tz - r.z) * k; r.y += (p.y - r.y) * Math.min(1, dt * 14);
      const moved = Math.hypot(r.x - ox, r.z - oz) / Math.max(dt, 1e-3);
      r.speed += (Math.max(moved, Math.hypot(p.vx, p.vz)) - r.speed) * Math.min(1, dt * 6);
      let d = p.yaw - r.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      r.yaw += d * Math.min(1, dt * 10);
    }
    for (const r of remotes.values()) {
      if (r.bot) { const b = bots.find((x) => x.id === r.id); r.speed = b ? Math.hypot(b.vx, b.vz) : 0; }
      r.avatar.group.position.set(r.x, r.y, r.z);
      r.avatar.group.rotation.y = r.yaw;
      r.avatar.setOni(match.isOni(r.id));
      r.avatar.update(dt, r.speed, r.y > 0.05);
    }

    if (phase === "play") checkTags(now);

    marker.visible = !!moveTarget;
    if (moveTarget) {
      markerPop = Math.max(0, markerPop - dt * 3);
      marker.position.set(moveTarget.x, 0.05, moveTarget.z);
      marker.scale.setScalar(1 + markerPop * 0.8 + Math.sin(time * 6) * 0.06);
      markerMat.opacity = 0.65 + Math.sin(time * 6) * 0.2;
    }

    // Point an oni at the nearest runner, a couple of metres out in front of them.
    arrow.visible = false;
    if (myId && meOni && phase === "play" && !inVR()) {
      let best: Remote | null = null, bd = Infinity;
      for (const r of remotes.values()) {
        if (match.isOni(r.id)) continue;
        const d = Math.hypot(r.x - me.x, r.z - me.z);
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd > 3) {
        const a = Math.atan2(best.x - me.x, best.z - me.z);
        arrow.visible = true;
        arrow.position.set(me.x + Math.sin(a) * 1.6, 0.06, me.z + Math.cos(a) * 1.6);
        arrow.rotation.y = a + Math.PI;
        arrowMat.opacity = 0.6 + Math.sin(time * 8) * 0.25;
      }
    }

    // ---- effects
    burstT += dt;
    if (burstT < 1.6) {
      for (let i = 0; i < BURST; i++) {
        burstVel[i * 3 + 1] -= 9 * dt;
        burstPos[i * 3] += burstVel[i * 3] * dt; burstPos[i * 3 + 1] = Math.max(0.02, burstPos[i * 3 + 1] + burstVel[i * 3 + 1] * dt); burstPos[i * 3 + 2] += burstVel[i * 3 + 2] * dt;
      }
      (burstGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      burstMat.opacity = 1 - burstT / 1.6;
    } else burstMat.opacity = 0;
    arena.update(dt, time, watch || inVR() ? undefined : camera.position, look);

    // ---- camera
    shake = Math.max(0, shake - dt);
    if (watch) {
      watchAngle += dt * 0.045;
      camera.position.set(Math.sin(watchAngle) * 27, 25, Math.cos(watchAngle) * 27);
      camera.lookAt(0, 0, 0);
    } else if (inVR()) {
      // The rig carries the headset; put the head over our feet.
      camRig.rotation.set(0, vrYaw, 0);
      // `camera.position` is the head inside the rig (the XR pose); shift the
      // rig so the head, not the middle of the play space, is over our feet.
      headWorld.set(camera.position.x, 0, camera.position.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, vrYaw);
      camRig.position.set(me.x - headWorld.x, me.y, me.z - headWorld.z);
    } else {
      look.set(me.x, me.y * 0.5 + 1.1, me.z);
      const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
      fwd.set(Math.sin(camYaw) * cp, sp, Math.cos(camYaw) * cp);
      camera.position.copy(look).addScaledVector(fwd, camDist);
      if (camera.position.y < 0.6) camera.position.y = 0.6;
      if (shake > 0) camera.position.x += (Math.random() - 0.5) * shake * 0.6, camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      camera.lookAt(look);
    }
    if (inVR() && round) {
      const left = Math.max(0, Math.ceil((round.end - now) / 1000));
      const text = phase === "countdown" ? `${meOni ? "You're the ONI" : "Get ready"} · ${Math.ceil((round.start - now) / 1000)}`
        : phase === "play" ? `${meOni ? "👹 CATCH THEM" : "🏃 RUN"} · ${left}s`
        : "Round over";
      drawVrHud(text, meOni && phase !== "over");
    } else if (inVR()) drawVrHud(remotes.size ? "Point + trigger to run · next round soon" : "Point + trigger to run · waiting for players", false);

    // ---- HUD
    if (time - lastHud > 0.15) {
      lastHud = time;
      emitHud(now, phase, round);
    }
  }

  function emitHud(now: number, phase: Phase, round: Round | null) {
    const players: HudPlayer[] = [];
    if (myId) players.push({ id: myId, name: myName, char: myChar, oni: match.isOni(myId), me: true, bot: false });
    for (const p of peerList()) players.push({ id: p.id, name: p.name, char: p.char, oni: match.isOni(p.id), me: false, bot: p.id.startsWith("~") });
    const res = match.result();
    const next = match.nextAt();
    opts.onHud?.({
      phase,
      connected,
      left: round ? Math.max(0, (Math.min(round.end, round.start + ROUND_MS) - now) / 1000) : 0,
      countdown: round ? Math.max(0, (round.start - now) / 1000) : 0,
      nextIn: next === null ? null : Math.max(0, (next - now) / 1000),
      me: myId ? { id: myId, oni: match.isOni(myId) } : null,
      players,
      runners: players.filter((p) => !p.oni).length,
      onis: players.filter((p) => p.oni).length,
      result: res && phase === "over" ? {
        lastStanding: res.lastStanding ? NameOf(res.lastStanding.id) : null,
        survived: res.lastStanding ? res.lastStanding.survived / 1000 : 0,
        survivors: res.survivors.map(NameOf),
        topOni: res.topOni ? NameOf(res.topOni.id) : null,
        topCount: res.topOni?.count ?? 0,
      } : null,
      inVR: inVR(),
    });
  }

  let paused = false;
  renderer.setAnimationLoop(() => {
    if (paused) return;
    const dt = Math.min(0.1, clock.getDelta());
    step(dt);
    renderer.render(scene, camera);
  });

  // ---- debug hooks for scripts ----------------------------------------------------------
  const debug = {
    snapshot(quality = 0.85): string {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/jpeg", quality);
    },
    state() {
      return {
        id: myId, connected, room: roomName, net: netMode,
        me: { x: +me.x.toFixed(2), z: +me.z.toFixed(2), y: +me.y.toFixed(2), oni: myId ? match.isOni(myId) : false },
        phase: match.phase(), round: match.round(), tags: [...match.tags().values()],
        peers: [...remotes.values()].map((r) => ({ id: r.id, name: names.get(r.id), x: +r.x.toFixed(2), z: +r.z.toFixed(2), oni: match.isOni(r.id) })),
      };
    },
    goTo(x: number, z: number) { setTarget(x, z); },
    target() { return moveTarget; },
    teleport(x: number, z: number) { const p = solve(x, z); me.x = p.x; me.z = p.z; me.vx = me.vz = 0; },
    /** Run the simulation forward without drawing, for a machine with no GPU. */
    settle(seconds: number, dt = 1 / 20) { for (let t = 0; t < seconds; t += dt) step(dt); },
    look(yaw: number, pitch?: number, dist?: number) { camYaw = yaw; if (pitch !== undefined) camPitch = pitch; if (dist !== undefined) camDist = dist; },
    start() { match.announce(); },
    pause(p: boolean) { paused = p; },
  };
  (window as unknown as { __oni?: typeof debug }).__oni = debug;

  const engine: OniEngine = {
    roomName,
    setStick(x, y) { stick.x = x; stick.y = y; },
    jump() { jumpQueued = true; sfx.resume(); },
    honk(emoji) {
      sfx.resume();
      const e = emoji ?? EMOTES[Math.floor(Math.random() * EMOTES.length)];
      match.emote(e);
    },
    setChar(id) {
      myChar = id;
      myAvatar?.setChar(id);
      room?.flush();
    },
    setName(n) {
      myName = n.trim().slice(0, 16) || "player";
      if (myId) names.set(myId, myName);
      myAvatar?.setName(myName);
    },
    start() { match.announce(); },
    async vrSupported() {
      try { return !!(await navigator.xr?.isSessionSupported("immersive-vr")); } catch { return false; }
    },
    async enterVR() {
      if (!navigator.xr) return;
      const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"] });
      renderer.xr.setReferenceSpaceType("local-floor");
      await renderer.xr.setSession(session);
    },
    setMuted(m) { sfx.setMuted(m); },
    resumeAudio() { sfx.resume(); },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      void renderer.xr.getSession()?.end().catch(() => {});
      room?.close();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      for (const r of remotes.values()) r.avatar.dispose();
      remotes.clear();
      myAvatar?.dispose();
      arena.dispose();
      burstGeo.dispose(); burstMat.dispose(); markerGeo.dispose(); markerMat.dispose();
      laserGeo.dispose(); laserMat.dispose(); reticleGeo.dispose(); reticleMat.dispose(); arrowGeo.dispose(); arrowMat.dispose();
      vrTex.dispose(); (vrHud.material as THREE.Material).dispose(); vrHud.geometry.dispose();
      sfx.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      const w = window as unknown as { __oni?: typeof debug };
      if (w.__oni === debug) delete w.__oni;
    },
  };
  return engine;
}
