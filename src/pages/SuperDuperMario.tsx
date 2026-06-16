/**
 * SuperDuperMario — "SUPER DUPER MARIO", an explorable third-person 3D
 * world in the bright, blocky, playful Super Mario style.
 *
 * Pure Three.js (same pattern as City / Museum / MemoryGarden in this
 * repo — no r3f, no heavy GLB downloads). Every asset here is geometry
 * built in code with flat, saturated Mario colors, so the world loads
 * instantly and stays smooth on mid-range phones.
 *
 * What's here:
 *   - A clear spawn pad with a floating intro sign.
 *   - A coin trail, ?-blocks, brick rows, warp pipes, Goombas, a
 *     flagpole and a little castle — all reachable on foot in seconds.
 *   - A HIDDEN underground room: drop into the glowing dark-green pipe
 *     near the castle to find the secret Power Star (confetti reward).
 *   - A relaxed "jazz cafe" soundtrack, fully synthesized (marioJazz).
 *
 * Controls:
 *   WASD / arrows — move (camera-relative)   Shift — run
 *   Space         — jump                      drag  — orbit camera
 *   scroll        — zoom                      touch — joystick + A button
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import confetti from "canvas-confetti";
import { createMarioJazz, type MarioJazz } from "@/lib/marioJazz";

// ------------------------------------------------------------------
// Mario palette — bright, saturated, consistent everywhere.
// ------------------------------------------------------------------
const C = {
  sky: 0x5c94fc, // classic SMB sky blue
  grass: 0x4cbb17,
  grassDark: 0x3a9410,
  dirt: 0x9b5a2a,
  brick: 0xc84c0c,
  brickMortar: 0x000000,
  question: 0xf8b800,
  questionDark: 0xe39400,
  pipe: 0x00a800,
  pipeDark: 0x007000,
  pipeSecret: 0x008060,
  coin: 0xffd700,
  cloud: 0xffffff,
  red: 0xe52521,
  blue: 0x2038ec,
  skin: 0xffc89b,
  brown: 0x7c3f00,
  goomba: 0x8b4513,
  castle: 0xd86010,
  star: 0xffe000,
};

type Box = { min: THREE.Vector3; max: THREE.Vector3 };

export default function SuperDuperMario() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [coins, setCoins] = useState(0);
  const [showIntro, setShowIntro] = useState(true);
  const [secret, setSecret] = useState(false);
  const [musicOn, setMusicOn] = useState(false);

  // Cross-boundary refs so React buttons can talk to the render loop.
  const audioRef = useRef<MarioJazz | null>(null);
  const setCoinsRef = useRef(setCoins);
  setCoinsRef.current = setCoins;
  const setSecretRef = useRef(setSecret);
  setSecretRef.current = setSecret;

  // Touch input written straight into the loop (no React in hot path).
  const moveRef = useRef({ x: 0, y: 0 });
  const jumpRef = useRef(false);

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.sky);
    scene.fog = new THREE.Fog(C.sky, 90, 200);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      400,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); // cap for mobile fps
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // ---- lighting: bright, sunny, cheerful ------------------------
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4cbb17, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4d6, 1.25);
    sun.position.set(40, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.camera.far = 220;
    scene.add(sun);

    const colliders: Box[] = [];
    const addCollider = (mesh: THREE.Object3D) => {
      const b = new THREE.Box3().setFromObject(mesh);
      colliders.push({ min: b.min.clone(), max: b.max.clone() });
    };

    // ---- shared geometry/materials (reuse → fewer draw calls) -----
    const mat = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...opts });
    const box1 = new THREE.BoxGeometry(1, 1, 1);

    // ---- OVERWORLD ground -----------------------------------------
    const OVER_Y = 0;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(150, 48),
      mat(C.grass),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Rolling decorative hills (rounded mounds, no collision).
    const hillGeo = new THREE.SphereGeometry(1, 12, 8);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.6;
      const r = 55 + (i % 3) * 18;
      const s = 8 + (i % 4) * 4;
      const hill = new THREE.Mesh(hillGeo, mat(i % 2 ? C.grassDark : C.grass));
      hill.position.set(Math.cos(a) * r, -s * 0.45, Math.sin(a) * r);
      hill.scale.set(s * 1.4, s, s * 1.4);
      hill.receiveShadow = true;
      scene.add(hill);
    }

    // ---- clouds (flat fluffy clusters of spheres) -----------------
    const cloudMat = mat(C.cloud, { roughness: 1, emissive: 0x223344, emissiveIntensity: 0.05 });
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    const clouds: THREE.Group[] = [];
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const puffs = 3 + (i % 3);
      for (let p = 0; p < puffs; p++) {
        const m = new THREE.Mesh(sphere, cloudMat);
        m.position.set((p - puffs / 2) * 3.4, Math.sin(p) * 1.2, 0);
        m.scale.setScalar(3.2 + (p % 2) * 1.4);
        g.add(m);
      }
      g.position.set(
        Math.cos((i / 9) * Math.PI * 2) * (60 + (i % 3) * 12),
        26 + (i % 4) * 6,
        Math.sin((i / 9) * Math.PI * 2) * (60 + (i % 3) * 12),
      );
      scene.add(g);
      clouds.push(g);
    }

    // ---- bushes & hills made of grass spheres (decor) -------------
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 14 + Math.random() * 60;
      const bush = new THREE.Group();
      const n = 2 + (i % 3);
      for (let p = 0; p < n; p++) {
        const m = new THREE.Mesh(sphere, mat(C.grassDark));
        m.position.set((p - n / 2) * 1.6, 0.2, 0);
        m.scale.setScalar(1.4 + (p % 2) * 0.6);
        m.castShadow = true;
        bush.add(m);
      }
      bush.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      scene.add(bush);
    }

    // ---- spawn pad (clear starting point) -------------------------
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.4, 0.6, 32), mat(0xffffff));
    pad.position.y = 0.3;
    pad.receiveShadow = true;
    scene.add(pad);
    const padRing = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.25, 8, 32), mat(C.red, { emissive: C.red, emissiveIntensity: 0.4 }));
    padRing.position.y = 0.62;
    padRing.rotation.x = -Math.PI / 2;
    scene.add(padRing);

    // ---- helper builders ------------------------------------------
    const brickMat = mat(C.brick, { roughness: 1 });
    const buildBlock = (x: number, y: number, z: number, kind: "brick" | "question") => {
      const material = kind === "question"
        ? mat(C.question, { emissive: C.questionDark, emissiveIntensity: 0.25, roughness: 0.6 })
        : brickMat;
      const m = new THREE.Mesh(box1, material);
      m.scale.setScalar(2);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      if (kind === "question") {
        // little "?" via a thin emissive cross of bars on each face front
        const q = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 6, 12, Math.PI * 1.5), mat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.3 }));
        q.position.set(x, y + 0.2, z + 1.01);
        scene.add(q);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), mat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.3 }));
        dot.position.set(x, y - 0.6, z + 1.01);
        scene.add(dot);
      }
      addCollider(m);
      return m;
    };

    const buildPipe = (x: number, z: number, h: number, secretPipe = false) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, h, 20),
        mat(secretPipe ? C.pipeSecret : C.pipe, secretPipe ? { emissive: C.pipeSecret, emissiveIntensity: 0.35 } : {}),
      );
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 1.2, 20), mat(secretPipe ? C.pipeSecret : C.pipeDark, secretPipe ? { emissive: C.pipeSecret, emissiveIntensity: 0.5 } : {}));
      rim.position.y = h;
      rim.castShadow = true;
      g.add(body, rim);
      g.position.set(x, 0, z);
      scene.add(g);
      addCollider(g);
      return { group: g, x, z, top: h };
    };

    // ---- ? + brick rows (a classic floating row) ------------------
    buildBlock(-10, 6, -16, "brick");
    buildBlock(-8, 6, -16, "question");
    buildBlock(-6, 6, -16, "brick");
    buildBlock(-7, 11, -16, "question");
    buildBlock(10, 6, -24, "question");
    buildBlock(12, 6, -24, "brick");
    // a little staircase of bricks you can climb
    for (let s = 0; s < 4; s++) {
      buildBlock(26 + s * 2, 1 + s * 2, 6, "brick");
    }

    // ---- pipes ----------------------------------------------------
    buildPipe(-22, 10, 7);
    buildPipe(18, 26, 9);
    // The SECRET warp pipe — glowing teal, near the castle. Drop in!
    const secretPipe = buildPipe(34, -28, 6, true);

    // ---- castle (goal landmark) -----------------------------------
    const castle = new THREE.Group();
    const keep = new THREE.Mesh(new THREE.BoxGeometry(14, 12, 14), mat(C.castle, { roughness: 1 }));
    keep.position.y = 6;
    keep.castShadow = true;
    keep.receiveShadow = true;
    castle.add(keep);
    for (const dx of [-7, 7]) {
      for (const dz of [-7, 7]) {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 16, 12), mat(C.castle));
        tower.position.set(dx, 8, dz);
        tower.castShadow = true;
        castle.add(tower);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 3, 12), mat(C.red));
        roof.position.set(dx, 17.5, dz);
        castle.add(roof);
      }
    }
    const gate = new THREE.Mesh(new THREE.BoxGeometry(4, 6, 0.6), mat(C.brown));
    gate.position.set(0, 3, 7.1);
    castle.add(gate);
    castle.position.set(48, 0, -40);
    scene.add(castle);
    addCollider(keep);

    // ---- flagpole -------------------------------------------------
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 24, 8), mat(0x9bbc0f, { metalness: 0.3, roughness: 0.5 }));
    pole.position.set(34, 12, -40);
    scene.add(pole);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 12), mat(C.question, { emissive: C.questionDark, emissiveIntensity: 0.4 }));
    ball.position.set(34, 24.2, -40);
    scene.add(ball);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), mat(C.red, { side: THREE.DoubleSide }));
    flag.position.set(32, 22, -40);
    scene.add(flag);

    // ---- coins ----------------------------------------------------
    const coinGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.18, 18);
    const coinMat = mat(C.coin, { emissive: 0x6b5200, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 });
    type Coin = { mesh: THREE.Mesh; got: boolean; under?: boolean };
    const coinList: Coin[] = [];
    const addCoin = (x: number, y: number, z: number, under = false) => {
      const m = new THREE.Mesh(coinGeo, coinMat);
      m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      m.castShadow = true;
      scene.add(m);
      coinList.push({ mesh: m, got: false, under });
    };
    // A welcoming coin trail leading away from spawn.
    for (let i = 0; i < 10; i++) addCoin(0, 1.6, -8 - i * 3.2);
    // arcs and clusters
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI;
      addCoin(-14 + Math.cos(a) * 6, 1.6 + Math.sin(a) * 4, -16);
    }
    for (let i = 0; i < 6; i++) addCoin(24 + i * 3, 3.2, 6);
    addCoin(-7, 14.5, -16);
    addCoin(18, 13, 26);

    // ---- Goombas (decorative patrol; stompable) -------------------
    type Goomba = { group: THREE.Group; base: THREE.Vector3; dir: number; alive: boolean };
    const goombas: Goomba[] = [];
    const makeGoomba = (x: number, z: number, dir: number) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 12), mat(C.goomba));
      body.scale.y = 0.85;
      body.position.y = 1.1;
      body.castShadow = true;
      const foot1 = new THREE.Mesh(box1, mat(C.brown));
      foot1.scale.set(0.7, 0.4, 0.9);
      foot1.position.set(-0.5, 0.2, 0);
      const foot2 = foot1.clone();
      foot2.position.x = 0.5;
      const eyeMat = mat(0xffffff);
      const eye1 = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), eyeMat);
      eye1.position.set(-0.35, 1.45, 0.9);
      const eye2 = eye1.clone();
      eye2.position.x = 0.35;
      const pupilMat = mat(0x000000);
      const p1 = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), pupilMat);
      p1.position.set(-0.35, 1.45, 1.05);
      const p2 = p1.clone();
      p2.position.x = 0.35;
      g.add(body, foot1, foot2, eye1, eye2, p1, p2);
      g.position.set(x, 0, z);
      scene.add(g);
      goombas.push({ group: g, base: new THREE.Vector3(x, 0, z), dir, alive: true });
    };
    makeGoomba(0, -22, 1);
    makeGoomba(-14, -10, -1);
    makeGoomba(20, 0, 1);

    // ==============================================================
    // HIDDEN UNDERGROUND ROOM (off the map, far below)
    // ==============================================================
    const UNDER_Y = -100;
    const under = new THREE.Group();
    under.position.y = UNDER_Y;
    scene.add(under);
    const underGround = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40), brickMat);
    underGround.receiveShadow = true;
    under.add(underGround);
    // brick walls + ceiling for a cozy cave
    const wallMat = mat(0x6b2a08, { roughness: 1 });
    const walls = [
      [0, 8, -20, 40, 16, 1],
      [0, 8, 20, 40, 16, 1],
      [-20, 8, 0, 1, 16, 40],
      [20, 8, 0, 1, 16, 40],
      [0, 16, 0, 40, 1, 40],
    ];
    for (const [x, y, z, w, h, d] of walls) {
      const m = new THREE.Mesh(box1, wallMat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      under.add(m);
    }
    // glow coins underground
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      addCoin(Math.cos(a) * 7, UNDER_Y + 2.2, Math.sin(a) * 7, true);
    }
    // THE SECRET POWER STAR
    const starShape = new THREE.Group();
    const starMat = mat(C.star, { emissive: C.star, emissiveIntensity: 0.9, metalness: 0.4, roughness: 0.2 });
    const starBody = new THREE.Mesh(new THREE.IcosahedronGeometry(2, 0), starMat);
    starShape.add(starBody);
    for (let i = 0; i < 5; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 6), starMat);
      const a = (i / 5) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 0);
      spike.rotation.z = a - Math.PI / 2;
      starShape.add(spike);
    }
    starShape.position.set(0, UNDER_Y + 5, 0);
    under.add(starShape);
    const starLight = new THREE.PointLight(C.star, 2, 40);
    starLight.position.set(0, UNDER_Y + 5, 0);
    under.add(starLight);
    let starCollected = false;
    // a return pipe in the underground room
    const returnPipe = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5, 18), mat(C.pipe));
    returnPipe.position.set(15, UNDER_Y + 3, 15);
    under.add(returnPipe);

    // ==============================================================
    // PLAYER (blocky Mario-ish character)
    // ==============================================================
    const player = new THREE.Group();
    const torso = new THREE.Mesh(box1, mat(C.red));
    torso.scale.set(1.3, 1.1, 0.9);
    torso.position.y = 1.6;
    const overalls = new THREE.Mesh(box1, mat(C.blue));
    overalls.scale.set(1.35, 0.9, 0.95);
    overalls.position.y = 1.0;
    const head = new THREE.Mesh(box1, mat(C.skin));
    head.scale.set(1.1, 0.9, 1);
    head.position.y = 2.5;
    const cap = new THREE.Mesh(box1, mat(C.red));
    cap.scale.set(1.2, 0.5, 1.1);
    cap.position.y = 3.0;
    const brim = new THREE.Mesh(box1, mat(C.red));
    brim.scale.set(1.2, 0.18, 0.5);
    brim.position.set(0, 2.85, 0.7);
    const stache = new THREE.Mesh(box1, mat(C.brown));
    stache.scale.set(0.9, 0.22, 0.2);
    stache.position.set(0, 2.3, 0.55);
    const legL = new THREE.Mesh(box1, mat(C.brown));
    legL.scale.set(0.5, 0.8, 0.5);
    legL.position.set(-0.35, 0.4, 0);
    const legR = legL.clone();
    legR.position.x = 0.35;
    const armL = new THREE.Mesh(box1, mat(C.red));
    armL.scale.set(0.4, 0.9, 0.4);
    armL.position.set(-0.95, 1.6, 0);
    const armR = armL.clone();
    armR.position.x = 0.95;
    [torso, overalls, head, cap, brim, stache, legL, legR, armL, armR].forEach((m) => {
      m.castShadow = true;
      player.add(m);
    });
    player.position.set(0, 0, 0);
    scene.add(player);

    // ---- player state / controls ----------------------------------
    const pos = new THREE.Vector3(0, OVER_Y, 0);
    const vel = new THREE.Vector3();
    let onGround = true;
    let facing = 0;
    let inUnderworld = false;
    const PLAYER_R = 0.7;
    const PLAYER_H = 3.2;
    const GRAVITY = -38;
    const JUMP_V = 15;
    const WALK = 9;
    const RUN = 16;

    const keys: Record<string, boolean> = {};
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true;
      if ([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
      ].includes(e.code)) e.preventDefault();
      if (e.code === "Space") jumpRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
      if (e.code === "Space") jumpRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // camera orbit (drag)
    let yaw = Math.PI;
    let pitch = 0.35;
    let dist = 16;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.005;
      pitch = Math.max(-0.2, Math.min(1.2, pitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      dist = Math.max(8, Math.min(34, dist + e.deltaY * 0.02));
    };
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: true });

    // ---- collision helpers ----------------------------------------
    const insideXZ = (b: Box, x: number, z: number, pad: number) =>
      x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad;

    const resolveHorizontal = (nx: number, nz: number) => {
      // returns adjusted position after pushing out of box sides
      let rx = nx;
      let rz = nz;
      for (const b of colliders) {
        const top = b.max.y;
        const bottom = b.min.y;
        // only blocks at our body height block us horizontally
        if (pos.y + PLAYER_H * 0.4 < bottom || pos.y + 0.4 > top) continue;
        if (insideXZ(b, rx, pos.z, PLAYER_R)) rx = nx < pos.x ? b.max.x + PLAYER_R : b.min.x - PLAYER_R;
        if (insideXZ(b, pos.x, rz, PLAYER_R)) rz = nz < pos.z ? b.max.z + PLAYER_R : b.min.z - PLAYER_R;
      }
      return { rx, rz };
    };

    const groundHeightAt = (x: number, z: number) => {
      let g = inUnderworld ? UNDER_Y + 0.5 : OVER_Y;
      if (!inUnderworld) {
        for (const b of colliders) {
          if (insideXZ(b, x, z, PLAYER_R * 0.7) && b.max.y > g && b.max.y <= pos.y + 1.5) g = b.max.y;
        }
      }
      return g;
    };

    // ---- warp logic -----------------------------------------------
    const tryWarp = () => {
      if (inUnderworld) {
        // return pipe is at (15,15) in underworld space
        const dx = pos.x - 15;
        const dz = pos.z - 15;
        if (Math.hypot(dx, dz) < 3) {
          inUnderworld = false;
          audioRef.current?.warp();
          pos.set(34, OVER_Y, -22); // pop out beside the secret pipe
          vel.set(0, 0, 0);
          scene.fog = new THREE.Fog(C.sky, 90, 200);
          scene.background = new THREE.Color(C.sky);
        }
        return;
      }
      // overworld: are we standing on / dropping into the secret pipe?
      const dx = pos.x - secretPipe.x;
      const dz = pos.z - secretPipe.z;
      if (Math.hypot(dx, dz) < 2.4 && pos.y <= secretPipe.top + 1.5) {
        inUnderworld = true;
        audioRef.current?.warp();
        pos.set(0, UNDER_Y + 8, 8);
        vel.set(0, 0, 0);
        scene.fog = new THREE.Fog(0x1a0d00, 20, 70);
        scene.background = new THREE.Color(0x1a0d00);
      }
    };

    // ---- resize ---------------------------------------------------
    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // ---- main loop ------------------------------------------------
    const clock = new THREE.Clock();
    let raf = 0;
    let coinSpinAcc = 0;
    const tmp = new THREE.Vector3();

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      // ---- input → desired movement (camera-relative) ----
      let ix = 0;
      let iz = 0;
      if (keys["KeyW"] || keys["ArrowUp"]) iz -= 1;
      if (keys["KeyS"] || keys["ArrowDown"]) iz += 1;
      if (keys["KeyA"] || keys["ArrowLeft"]) ix -= 1;
      if (keys["KeyD"] || keys["ArrowRight"]) ix += 1;
      ix += moveRef.current.x;
      iz += moveRef.current.y;
      const running = keys["ShiftLeft"] || keys["ShiftRight"] || Math.hypot(ix, iz) > 0.85;
      const speed = running ? RUN : WALK;

      const len = Math.hypot(ix, iz);
      if (len > 0.01) {
        const nx = ix / Math.max(len, 1);
        const nz = iz / Math.max(len, 1);
        // rotate by camera yaw
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        const wx = nx * cos - nz * sin;
        const wz = nx * sin + nz * cos;
        const mag = Math.min(len, 1) * speed;
        const desiredX = pos.x + wx * mag * dt;
        const desiredZ = pos.z + wz * mag * dt;
        const { rx, rz } = resolveHorizontal(desiredX, desiredZ);
        pos.x = rx;
        pos.z = rz;
        facing = Math.atan2(wx, wz);
      }

      // ---- jump + gravity ----
      const wantJump = jumpRef.current || keys["Space"];
      if (wantJump && onGround) {
        vel.y = JUMP_V;
        onGround = false;
        audioRef.current?.jump();
      }
      vel.y += GRAVITY * dt;
      pos.y += vel.y * dt;
      const gh = groundHeightAt(pos.x, pos.z);
      if (pos.y <= gh) {
        pos.y = gh;
        vel.y = 0;
        onGround = true;
      } else {
        onGround = false;
      }

      // keep inside the world
      if (!inUnderworld) {
        const r = Math.hypot(pos.x, pos.z);
        if (r > 140) {
          pos.x = (pos.x / r) * 140;
          pos.z = (pos.z / r) * 140;
        }
      }

      tryWarp();

      // ---- apply to player mesh + walk bob ----
      player.position.set(pos.x, pos.y, pos.z);
      player.rotation.y = facing;
      const moving = len > 0.05 && onGround;
      const bob = moving ? Math.sin(t * (running ? 16 : 11)) : 0;
      legL.rotation.x = bob * 0.6;
      legR.rotation.x = -bob * 0.6;
      armL.rotation.x = -bob * 0.5;
      armR.rotation.x = bob * 0.5;
      player.position.y += onGround ? Math.abs(bob) * 0.08 : 0;

      // ---- camera follow ----
      const camTarget = tmp.set(pos.x, pos.y + 2.5, pos.z);
      const cx = pos.x - Math.sin(yaw) * Math.cos(pitch) * dist;
      const cz = pos.z - Math.cos(yaw) * Math.cos(pitch) * dist;
      const cy = pos.y + 2.5 + Math.sin(pitch) * dist;
      camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.12);
      camera.lookAt(camTarget);

      // ---- coins spin + collect ----
      coinSpinAcc += dt;
      let collectedNow = false;
      for (const c of coinList) {
        if (c.got) continue;
        c.mesh.rotation.z += dt * 4;
        c.mesh.position.y += Math.sin(t * 3 + c.mesh.position.x) * 0.004;
        const cpZ = c.under ? c.mesh.position.z : c.mesh.position.z;
        const cpY = c.under ? c.mesh.position.y : c.mesh.position.y;
        // only collect coins in the world we're in
        if (c.under !== inUnderworld) continue;
        const d = Math.hypot(pos.x - c.mesh.position.x, pos.z - cpZ);
        if (d < 1.6 && Math.abs(pos.y + 1.6 - cpY) < 2.4) {
          c.got = true;
          c.mesh.visible = false;
          collectedNow = true;
        }
      }
      if (collectedNow) {
        audioRef.current?.coin();
        setCoinsRef.current((n) => n + 1);
      }

      // ---- goombas patrol + stomp ----
      for (const g of goombas) {
        if (!g.alive) continue;
        g.group.position.x = g.base.x + Math.sin(t * 0.8 * g.dir + g.base.z) * 6;
        g.group.position.z = g.base.z;
        const d = Math.hypot(pos.x - g.group.position.x, pos.z - g.group.position.z);
        if (d < 1.8) {
          if (vel.y < 0 && pos.y > 1.4) {
            // stomp!
            g.alive = false;
            g.group.scale.y = 0.2;
            g.group.position.y = -0.6;
            vel.y = JUMP_V * 0.6;
            audioRef.current?.stomp();
          } else {
            // bumped — gently knock the player back
            const a = Math.atan2(pos.x - g.group.position.x, pos.z - g.group.position.z);
            pos.x += Math.sin(a) * 0.4;
            pos.z += Math.cos(a) * 0.4;
          }
        }
      }

      // ---- secret star ----
      if (inUnderworld && !starCollected) {
        starShape.rotation.y += dt * 1.5;
        starBody.rotation.x += dt;
        const d = Math.hypot(pos.x - 0, pos.z - 0);
        if (d < 3.5 && Math.abs(pos.y - 5) < 4) {
          starCollected = true;
          starShape.visible = false;
          starLight.visible = false;
          audioRef.current?.oneUp();
          setSecretRef.current(true);
          confetti({
            particleCount: 220,
            spread: 110,
            origin: { y: 0.6 },
            colors: ["#ffe000", "#e52521", "#2038ec", "#4cbb17", "#ffffff"],
          });
        }
      }

      // ---- ambient: drift clouds, bob flag ----
      for (const cl of clouds) {
        cl.position.x += dt * 0.6;
        if (cl.position.x > 95) cl.position.x = -95;
      }
      flag.rotation.y = Math.sin(t * 2) * 0.15;

      renderer.render(scene, camera);
    };
    tick();

    // ---- cleanup --------------------------------------------------
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", onResize);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // ---- music toggle -----------------------------------------------
  const toggleMusic = () => {
    if (!audioRef.current) audioRef.current = createMarioJazz();
    const next = !musicOn;
    setMusicOn(next);
    audioRef.current?.setPlaying(next);
  };

  useEffect(() => () => audioRef.current?.dispose(), []);

  const fontStack = '"Press Start 2P", "Trebuchet MS", system-ui, sans-serif';

  return (
    <div ref={mountRef} style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#5c94fc" }}>
      {/* ---- Title ---- */}
      <div
        style={{
          position: "absolute", top: 16, left: 0, right: 0, textAlign: "center",
          pointerEvents: "none", fontFamily: fontStack, userSelect: "none",
        }}
      >
        <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", textShadow: "3px 3px 0 #000, -1px -1px 0 #e52521", letterSpacing: 1 }}>
          SUPER DUPER MARIO
        </div>
      </div>

      {/* ---- Coin counter ---- */}
      <div
        style={{
          position: "absolute", top: 14, left: 14, display: "flex", alignItems: "center", gap: 8,
          fontFamily: fontStack, color: "#fff", textShadow: "2px 2px 0 #000",
          background: "rgba(0,0,0,0.35)", padding: "8px 12px", borderRadius: 10, border: "2px solid #ffd700",
        }}
      >
        <span style={{ display: "inline-block", width: 18, height: 18, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #fff6b0, #ffd700 60%, #b8860b)", boxShadow: "0 0 6px #ffd700" }} />
        <span style={{ fontSize: 16, fontWeight: 900 }}>× {coins}</span>
      </div>

      {/* ---- Music toggle ---- */}
      <button
        onClick={toggleMusic}
        style={{
          position: "absolute", top: 14, right: 14, fontFamily: fontStack, fontSize: 11,
          color: "#fff", background: musicOn ? "#e52521" : "rgba(0,0,0,0.4)",
          border: "2px solid #fff", borderRadius: 10, padding: "10px 12px", cursor: "pointer",
          textShadow: "1px 1px 0 #000",
        }}
      >
        {musicOn ? "♪ JAZZ ON" : "♪ JAZZ OFF"}
      </button>

      {/* ---- Intro nudge ---- */}
      {showIntro && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.55)", zIndex: 10, fontFamily: fontStack, padding: 20,
          }}
          onClick={() => {
            setShowIntro(false);
            if (!musicOn) toggleMusic();
          }}
        >
          <div
            style={{
              maxWidth: 460, textAlign: "center", color: "#fff",
              background: "linear-gradient(#2038ec, #1020a0)", border: "4px solid #ffd700",
              borderRadius: 16, padding: "26px 24px", boxShadow: "0 10px 0 #000a, 6px 6px 0 #000",
            }}
          >
            <div style={{ fontSize: 22, color: "#ffd700", textShadow: "2px 2px 0 #000", marginBottom: 14 }}>
              IT'S-A YOU!
            </div>
            <p style={{ fontSize: 11, lineHeight: 1.9, margin: 0 }}>
              Welcome to SUPER DUPER MARIO!<br /><br />
              <b>WASD / arrows</b> to walk · <b>Shift</b> to run<br />
              <b>Space</b> to jump · <b>drag</b> to look around<br /><br />
              Grab the coins, stomp a Goomba, and find the{" "}
              <span style={{ color: "#00e0b0" }}>glowing teal pipe</span> by the castle —
              drop in for a secret!
            </p>
            <div style={{ marginTop: 18, fontSize: 12, color: "#ffd700", animation: "pulse 1s infinite" }}>
              ▶ CLICK / TAP TO START
            </div>
          </div>
        </div>
      )}

      {/* ---- Secret reward toast ---- */}
      {secret && (
        <div
          style={{
            position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)",
            fontFamily: fontStack, fontSize: 13, color: "#000",
            background: "linear-gradient(#ffe000,#ffb800)", border: "3px solid #000",
            borderRadius: 12, padding: "14px 18px", textAlign: "center", zIndex: 11,
            boxShadow: "4px 4px 0 #000", maxWidth: "90vw",
          }}
        >
          ⭐ YOU FOUND THE SECRET POWER STAR! ⭐<br />
          <span style={{ fontSize: 10 }}>Hop in the green pipe to head back up.</span>
        </div>
      )}

      {/* ---- Mobile touch controls ---- */}
      <MarioTouch moveRef={moveRef} jumpRef={jumpRef} fontStack={fontStack} />

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  );
}

/** Phone-only virtual joystick + jump (A) button, written into refs. */
function MarioTouch({
  moveRef,
  jumpRef,
  fontStack,
}: {
  moveRef: React.MutableRefObject<{ x: number; y: number }>;
  jumpRef: React.MutableRefObject<boolean>;
  fontStack: string;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });
  const [show, setShow] = useState(false);
  const active = useRef<number | null>(null);
  const R = 46;

  useEffect(() => {
    setShow(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  if (!show) return null;

  const update = (cx: number, cy: number) => {
    const base = baseRef.current;
    if (!base) return;
    const r = base.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2);
    let dy = cy - (r.top + r.height / 2);
    const l = Math.hypot(dx, dy);
    if (l > R) {
      dx = (dx / l) * R;
      dy = (dy / l) * R;
    }
    setThumb({ x: dx, y: dy });
    moveRef.current = { x: dx / R, y: dy / R };
  };
  const reset = () => {
    setThumb({ x: 0, y: 0 });
    moveRef.current = { x: 0, y: 0 };
    active.current = null;
  };

  return (
    <>
      <div
        ref={baseRef}
        onPointerDown={(e) => {
          active.current = e.pointerId;
          update(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (active.current === e.pointerId) update(e.clientX, e.clientY);
        }}
        onPointerUp={reset}
        onPointerCancel={reset}
        style={{
          position: "absolute", left: 24, bottom: 32, width: 120, height: 120,
          borderRadius: "50%", background: "rgba(0,0,0,0.3)", border: "3px solid #fff",
          touchAction: "none", zIndex: 12,
        }}
      >
        <div
          style={{
            position: "absolute", left: "50%", top: "50%",
            transform: `translate(calc(-50% + ${thumb.x}px), calc(-50% + ${thumb.y}px))`,
            width: 52, height: 52, borderRadius: "50%",
            background: "radial-gradient(circle at 35% 30%, #fff, #e52521 70%)",
            border: "2px solid #fff",
          }}
        />
      </div>
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          jumpRef.current = true;
        }}
        onPointerUp={() => (jumpRef.current = false)}
        onPointerLeave={() => (jumpRef.current = false)}
        style={{
          position: "absolute", right: 28, bottom: 44, width: 86, height: 86, borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, #fff, #2038ec 70%)", border: "4px solid #fff",
          color: "#fff", fontFamily: fontStack, fontSize: 18, fontWeight: 900, textShadow: "2px 2px 0 #000",
          touchAction: "none", zIndex: 12, cursor: "pointer",
        }}
      >
        A
      </button>
    </>
  );
}
