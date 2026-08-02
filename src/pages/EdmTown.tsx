/**
 * EDM Town — a low-poly, neon, party-vibe festival town you can walk
 * around in. Built as a self-contained Three.js scene (no react-three-fiber)
 * so it stays light on mid-range mobile.
 *
 * Highlights:
 *  - Flat-shaded low-poly art (MeshLambertMaterial + flatShading where it
 *    matters), high-contrast neon palette.
 *  - WASD / arrows + mouse-look on desktop, on-screen joystick on mobile.
 *  - Spawn nudge to teach controls.
 *  - Photo mode (press P): hides HUD, lets you frame, click 📸 to download.
 *  - Guestbook obelisk near the main stage — walk up and press E to sign.
 *    Messages persist in public.edm_guestbook.
 *  - WebAudio-synthesized 4-on-the-floor festival loop (no asset needed).
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as THREE from "three";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useWorldStamp } from "@/hooks/use-world-stamp";

type GuestbookEntry = {
  id: string;
  name: string;
  message: string;
  created_at: string;
};

// Neon palette — keep these vivid; flat shading carries the rest.
const NEON_PINK = 0xff2bd6;
const NEON_CYAN = 0x22d3ee;
const NEON_PURPLE = 0x8b5cf6;
const NEON_LIME = 0xa3ff12;
const NEON_AMBER = 0xffb020;
const NIGHT_SKY = 0x0a0420;
const GROUND = 0x140826;

export default function EdmTown() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/edm-town", "EDM Town");

  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [photoMode, setPhotoMode] = useState(false);
  const photoModeRef = useRef(false);
  const [guestbookOpen, setGuestbookOpen] = useState(false);
  const [entries, setEntries] = useState<GuestbookEntry[]>([]);
  const [signName, setSignName] = useState(() => localStorage.getItem("edm.name") ?? "");
  const [signMsg, setSignMsg] = useState("");
  const [nearGuestbook, setNearGuestbook] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [musicOn, setMusicOn] = useState(false);
  const audioRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null);

  // Hide intro after a few seconds of movement
  useEffect(() => {
    const t = setTimeout(() => setShowIntro(false), 9000);
    return () => clearTimeout(t);
  }, []);

  // Load guestbook
  const loadGuestbook = async () => {
    const { data, error } = await supabase
      .from("edm_guestbook")
      .select("id,name,message,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error && data) setEntries(data as GuestbookEntry[]);
  };
  useEffect(() => { loadGuestbook(); }, []);

  // ===== Three.js scene =====
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: window.devicePixelRatio < 2,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(NIGHT_SKY);
    scene.fog = new THREE.Fog(NIGHT_SKY, 60, 240);

    const camera = new THREE.PerspectiveCamera(
      72,
      mount.clientWidth / mount.clientHeight,
      0.1,
      500,
    );
    camera.position.set(0, 1.7, 28);

    // ---- Lighting ----
    scene.add(new THREE.HemisphereLight(0x8844ff, 0x110022, 0.55));
    const stageKey = new THREE.PointLight(NEON_PINK, 3.2, 80, 1.6);
    stageKey.position.set(0, 14, -22);
    scene.add(stageKey);
    const stageFill = new THREE.PointLight(NEON_CYAN, 2.6, 80, 1.6);
    stageFill.position.set(-10, 12, -28);
    scene.add(stageFill);
    const stageWarm = new THREE.PointLight(NEON_AMBER, 1.8, 60, 1.6);
    stageWarm.position.set(10, 10, -28);
    scene.add(stageWarm);

    // ---- Ground (low-poly bumpy plaza) ----
    const groundGeo = new THREE.PlaneGeometry(220, 220, 36, 36);
    const gpos = groundGeo.attributes.position;
    for (let i = 0; i < gpos.count; i++) {
      const x = gpos.getX(i), y = gpos.getY(i);
      // keep the dance floor flat near center
      const flat = Math.max(0, 1 - Math.exp(-((x * x + y * y) / 900)));
      gpos.setZ(i, (Math.sin(x * 0.2) + Math.cos(y * 0.25)) * 0.35 * flat);
    }
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshLambertMaterial({ color: GROUND, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Glowing dance floor grid
    const danceFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 34, 10, 10),
      new THREE.MeshBasicMaterial({
        color: NEON_PURPLE,
        wireframe: true,
        transparent: true,
        opacity: 0.65,
      }),
    );
    danceFloor.rotation.x = -Math.PI / 2;
    danceFloor.position.y = 0.02;
    scene.add(danceFloor);

    // ---- Distant low-poly mountains ----
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r = 130 + Math.random() * 30;
      const h = 22 + Math.random() * 30;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(18 + Math.random() * 10, h, 5),
        new THREE.MeshLambertMaterial({
          color: i % 2 ? 0x2a0e44 : 0x140a2a,
          flatShading: true,
        }),
      );
      cone.position.set(Math.cos(a) * r, h / 2 - 1, Math.sin(a) * r);
      scene.add(cone);
    }

    // ---- Main stage ----
    const stage = new THREE.Group();
    stage.position.set(0, 0, -22);
    scene.add(stage);

    const stageBase = new THREE.Mesh(
      new THREE.BoxGeometry(26, 1.6, 10),
      new THREE.MeshLambertMaterial({ color: 0x1a0a2a, flatShading: true }),
    );
    stageBase.position.y = 0.8;
    stage.add(stageBase);

    // back wall LED
    const ledWall = new THREE.Mesh(
      new THREE.BoxGeometry(22, 9, 0.4),
      new THREE.MeshBasicMaterial({ color: NEON_PINK }),
    );
    ledWall.position.set(0, 5.5, -4.6);
    stage.add(ledWall);

    // Speaker stacks
    const speakerMat = new THREE.MeshLambertMaterial({ color: 0x111111, flatShading: true });
    const coneMat = new THREE.MeshLambertMaterial({ color: NEON_AMBER, flatShading: true });
    const speakers: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const stack = new THREE.Group();
      stack.position.set(side * 11, 0, -3);
      for (let i = 0; i < 4; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.8, 2.8), speakerMat);
        box.position.y = 1 + i * 1.9;
        stack.add(box);
        const cone = new THREE.Mesh(new THREE.CircleGeometry(0.7, 12), coneMat);
        cone.position.set(0, 1 + i * 1.9, 1.41);
        stack.add(cone);
      }
      stage.add(stack);
      speakers.push(stack);
    }

    // Truss
    const trussMat = new THREE.MeshLambertMaterial({ color: 0x555566, flatShading: true });
    const trussTop = new THREE.Mesh(new THREE.BoxGeometry(22, 0.4, 0.4), trussMat);
    trussTop.position.set(0, 10.5, -3);
    stage.add(trussTop);
    for (const side of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, 10.5, 0.4), trussMat);
      col.position.set(side * 11, 5.25, -3);
      stage.add(col);
    }

    // ---- DJ booth ----
    const booth = new THREE.Mesh(
      new THREE.BoxGeometry(4, 1.2, 2),
      new THREE.MeshLambertMaterial({ color: NEON_CYAN, flatShading: true }),
    );
    booth.position.set(0, 2.2, 0);
    stage.add(booth);
    // DJ
    const dj = new THREE.Group();
    dj.position.set(0, 1.6, -0.6);
    const djBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.6, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x111111, flatShading: true }),
    );
    djBody.position.y = 1.9;
    dj.add(djBody);
    const djHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xffd9a0, flatShading: true }),
    );
    djHead.position.y = 3.0;
    dj.add(djHead);
    stage.add(dj);

    // ---- Crowd: many low-poly dancing people ----
    const crowd: { group: THREE.Group; phase: number; baseY: number }[] = [];
    const bodyGeo = new THREE.BoxGeometry(0.7, 1.4, 0.4);
    const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const armGeo = new THREE.BoxGeometry(0.2, 1.0, 0.2);
    const skinColors = [0xffd9a0, 0xc28a5c, 0x7c4a26, 0x3a2010, 0xffe6c2];
    const fitColors = [NEON_PINK, NEON_CYAN, NEON_LIME, NEON_AMBER, NEON_PURPLE, 0xff6a3d];
    const CROWD = 90;
    for (let i = 0; i < CROWD; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.random() * 16;
      const x = Math.cos(angle) * dist;
      const z = -10 + Math.sin(angle) * dist;
      if (Math.abs(x) < 1 && Math.abs(z + 22) < 6) continue; // keep clear of stage
      const g = new THREE.Group();
      g.position.set(x, 0.7, z);
      g.rotation.y = Math.atan2(0 - x, -22 - z); // face stage
      const body = new THREE.Mesh(
        bodyGeo,
        new THREE.MeshLambertMaterial({
          color: fitColors[Math.floor(Math.random() * fitColors.length)],
          flatShading: true,
        }),
      );
      g.add(body);
      const head = new THREE.Mesh(
        headGeo,
        new THREE.MeshLambertMaterial({
          color: skinColors[Math.floor(Math.random() * skinColors.length)],
          flatShading: true,
        }),
      );
      head.position.y = 1.0;
      g.add(head);
      // arms up
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(
          armGeo,
          new THREE.MeshLambertMaterial({ color: 0x222233, flatShading: true }),
        );
        arm.position.set(side * 0.5, 0.6, 0);
        arm.rotation.z = side * 0.35;
        g.add(arm);
      }
      scene.add(g);
      crowd.push({ group: g, phase: Math.random() * Math.PI * 2, baseY: 0.7 });
    }

    // ---- Town: small low-poly buildings around the festival ----
    const townMats = [NEON_PINK, NEON_CYAN, NEON_LIME, NEON_AMBER, NEON_PURPLE].map(
      (c) => new THREE.MeshLambertMaterial({ color: 0x1a0e2a, flatShading: true, emissive: c, emissiveIntensity: 0.0 }),
    );
    const glowMats = [NEON_PINK, NEON_CYAN, NEON_LIME, NEON_AMBER, NEON_PURPLE].map(
      (c) => new THREE.MeshBasicMaterial({ color: c }),
    );
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const r = 55 + Math.random() * 30;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // keep stage area clear
      if (z < -10 && Math.abs(x) < 30) continue;
      const w = 4 + Math.random() * 5;
      const h = 5 + Math.random() * 10;
      const d = 4 + Math.random() * 5;
      const matIdx = Math.floor(Math.random() * townMats.length);
      const building = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), townMats[matIdx]);
      building.position.set(x, h / 2, z);
      building.rotation.y = Math.random() * Math.PI;
      scene.add(building);
      // glowing accent strip
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.3, d + 0.1), glowMats[matIdx]);
      strip.position.set(x, 1 + Math.random() * (h - 2), z);
      strip.rotation.y = building.rotation.y;
      scene.add(strip);
    }

    // ---- Food trucks / chill tents ----
    const tentColors = [NEON_PINK, NEON_CYAN, NEON_LIME, NEON_AMBER];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI + (i - 2.5) * 0.35;
      const r = 26;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r + 6;
      const tent = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 3, 4),
        new THREE.MeshLambertMaterial({ color: tentColors[i % tentColors.length], flatShading: true }),
      );
      tent.position.set(x, 1.5, z);
      tent.rotation.y = Math.PI / 4;
      scene.add(tent);
    }

    // ---- Guestbook obelisk ----
    const guestbook = new THREE.Group();
    guestbook.position.set(6, 0, 8);
    scene.add(guestbook);
    const gbBase = new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.4, 2),
      new THREE.MeshLambertMaterial({ color: 0x222233, flatShading: true }),
    );
    gbBase.position.y = 0.2;
    guestbook.add(gbBase);
    const gbPillar = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 2.6, 0.4),
      new THREE.MeshLambertMaterial({
        color: 0x150828,
        emissive: NEON_LIME,
        emissiveIntensity: 0.6,
        flatShading: true,
      }),
    );
    gbPillar.position.y = 1.7;
    guestbook.add(gbPillar);
    const gbHalo = new THREE.Mesh(
      new THREE.TorusGeometry(1.4, 0.08, 8, 24),
      new THREE.MeshBasicMaterial({ color: NEON_LIME }),
    );
    gbHalo.position.y = 3.4;
    gbHalo.rotation.x = Math.PI / 2;
    guestbook.add(gbHalo);
    const guestbookPos = new THREE.Vector3(6, 0, 8);

    // ---- Lasers (animated beams) ----
    const laserGeo = new THREE.CylinderGeometry(0.05, 0.05, 80, 6, 1, true);
    const lasers: { mesh: THREE.Mesh; offset: number; color: number }[] = [];
    [NEON_PINK, NEON_CYAN, NEON_LIME, NEON_AMBER, NEON_PURPLE].forEach((c, i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      for (let j = 0; j < 3; j++) {
        const beam = new THREE.Mesh(laserGeo, mat);
        beam.position.set(0, 10, -22);
        scene.add(beam);
        lasers.push({ mesh: beam, offset: i * 0.7 + j * 0.4, color: c });
      }
    });

    // ---- Floating stars ----
    const starsGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(400 * 3);
    for (let i = 0; i < 400; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 400;
      starPositions[i * 3 + 1] = 40 + Math.random() * 80;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 400;
    }
    starsGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(
      starsGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, sizeAttenuation: true }),
    );
    scene.add(stars);

    // ===== Controls =====
    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keys.add(k);
      if (k === "p") {
        photoModeRef.current = !photoModeRef.current;
        setPhotoMode(photoModeRef.current);
      }
      if (k === "e") {
        const dx = camera.position.x - guestbookPos.x;
        const dz = camera.position.z - guestbookPos.z;
        if (dx * dx + dz * dz < 12) setGuestbookOpen(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Mouse look (pointer lock on desktop)
    let yaw = 0, pitch = 0;
    const canvas = renderer.domElement;
    const onClick = () => {
      if (!photoModeRef.current) canvas.requestPointerLock?.();
    };
    canvas.addEventListener("click", onClick);
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement === canvas) {
        yaw -= e.movementX * 0.0025;
        pitch -= e.movementY * 0.0025;
        pitch = Math.max(-1.2, Math.min(1.2, pitch));
      }
    };
    window.addEventListener("mousemove", onMouseMove);

    // Touch joystick (mobile)
    const touch = { active: false, id: -1, sx: 0, sy: 0, dx: 0, dy: 0 };
    const lookTouch = { active: false, id: -1, lx: 0, ly: 0 };
    const onTouchStart = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth / 2 && !touch.active) {
          touch.active = true; touch.id = t.identifier;
          touch.sx = t.clientX; touch.sy = t.clientY;
          touch.dx = 0; touch.dy = 0;
        } else if (!lookTouch.active) {
          lookTouch.active = true; lookTouch.id = t.identifier;
          lookTouch.lx = t.clientX; lookTouch.ly = t.clientY;
        }
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === touch.id) {
          touch.dx = Math.max(-60, Math.min(60, t.clientX - touch.sx));
          touch.dy = Math.max(-60, Math.min(60, t.clientY - touch.sy));
        } else if (t.identifier === lookTouch.id) {
          yaw -= (t.clientX - lookTouch.lx) * 0.006;
          pitch -= (t.clientY - lookTouch.ly) * 0.006;
          pitch = Math.max(-1.2, Math.min(1.2, pitch));
          lookTouch.lx = t.clientX; lookTouch.ly = t.clientY;
        }
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === touch.id) { touch.active = false; touch.dx = 0; touch.dy = 0; }
        if (t.identifier === lookTouch.id) lookTouch.active = false;
      }
    };
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: true });
    canvas.addEventListener("touchend", onTouchEnd);

    // Resize
    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // ===== Animate =====
    const clock = new THREE.Clock();
    const tmp = new THREE.Vector3();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      const beat = (Math.sin(t * Math.PI * 2 * (128 / 60)) + 1) / 2; // 128 BPM

      // Movement
      const speed = 8 * dt;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const move = new THREE.Vector3();
      if (keys.has("w") || keys.has("arrowup")) move.add(fwd);
      if (keys.has("s") || keys.has("arrowdown")) move.sub(fwd);
      if (keys.has("a") || keys.has("arrowleft")) move.sub(right);
      if (keys.has("d") || keys.has("arrowright")) move.add(right);
      if (touch.active) {
        move.add(fwd.clone().multiplyScalar(-touch.dy / 60));
        move.add(right.clone().multiplyScalar(touch.dx / 60));
      }
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed);
        camera.position.add(move);
      }
      // Soft world bounds
      camera.position.x = Math.max(-90, Math.min(90, camera.position.x));
      camera.position.z = Math.max(-15, Math.min(90, camera.position.z));
      camera.position.y = 1.7 + Math.sin(t * 8) * 0.04 * (move.lengthSq() > 0 ? 1 : 0);

      // Look
      const lookDir = new THREE.Vector3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      );
      camera.lookAt(tmp.copy(camera.position).add(lookDir));

      // Near guestbook?
      const dx = camera.position.x - guestbookPos.x;
      const dz = camera.position.z - guestbookPos.z;
      const near = dx * dx + dz * dz < 12;
      setNearGuestbook((prev) => (prev !== near ? near : prev));

      // Crowd bounce on beat
      for (const c of crowd) {
        c.group.position.y = c.baseY + Math.abs(Math.sin(t * 4 + c.phase)) * 0.5 * (0.4 + beat);
        c.group.rotation.y += (Math.sin(t * 2 + c.phase) * 0.5) * dt;
      }

      // Speakers pulse
      for (const s of speakers) s.scale.y = 1 + beat * 0.06;

      // Lasers sweep
      for (const l of lasers) {
        const rx = Math.sin(t * 1.2 + l.offset) * 0.9;
        const rz = Math.cos(t * 0.9 + l.offset * 1.3) * 0.9;
        l.mesh.rotation.set(rx, 0, rz);
        (l.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 + beat * 0.4;
      }

      // LED wall hue
      const hue = (t * 0.05) % 1;
      (ledWall.material as THREE.MeshBasicMaterial).color.setHSL(hue, 1, 0.55);
      stageKey.intensity = 2.2 + beat * 2.4;
      stageFill.intensity = 2.0 + beat * 1.8;
      danceFloor.material.opacity = 0.4 + beat * 0.4;

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // ===== Photo download =====
  const handlePhoto = () => {
    const r = rendererRef.current;
    if (!r) return;
    // Render one extra frame to ensure the canvas reflects current state
    const url = r.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `edm-town-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success("Photo saved 📸");
  };

  // ===== Guestbook submit =====
  const handleSign = async () => {
    const name = signName.trim().slice(0, 40);
    const message = signMsg.trim().slice(0, 200);
    if (!name || !message) {
      toast.error("Add your name and a short message");
      return;
    }
    localStorage.setItem("edm.name", name);
    const { error } = await supabase.from("edm_guestbook").insert({ name, message });
    if (error) {
      toast.error("Couldn't sign guestbook");
      return;
    }
    setSignMsg("");
    toast.success("Signed! 🪩");
    loadGuestbook();
  };

  // ===== Music (simple WebAudio festival loop) =====
  const toggleMusic = async () => {
    if (audioRef.current) {
      audioRef.current.stop();
      audioRef.current.ctx.close();
      audioRef.current = null;
      setMusicOn(false);
      return;
    }
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);

    // Sidechain-ish ducked pad
    const pad = ctx.createOscillator();
    pad.type = "sawtooth";
    pad.frequency.value = 110;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.08;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 800;
    pad.connect(padFilter).connect(padGain).connect(master);
    pad.start();

    // Kick drum on the 4
    const bpm = 128;
    const beatLen = 60 / bpm;
    let step = 0;
    const interval = setInterval(() => {
      const now = ctx.currentTime;
      // kick
      const k = ctx.createOscillator();
      const kg = ctx.createGain();
      k.frequency.setValueAtTime(120, now);
      k.frequency.exponentialRampToValueAtTime(40, now + 0.18);
      kg.gain.setValueAtTime(0.9, now);
      kg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      k.connect(kg).connect(master);
      k.start(now);
      k.stop(now + 0.25);
      // hat every off-beat
      if (step % 2 === 1) {
        const buf = ctx.createBuffer(1, 1024, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        noise.loop = true;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.18, now);
        ng.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 7000;
        noise.connect(hp).connect(ng).connect(master);
        noise.start(now);
        noise.stop(now + 0.1);
      }
      // simple synth riff
      if (step % 4 === 0) {
        const notes = [220, 277, 330, 277];
        const f = notes[(step / 4) % notes.length];
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = "square";
        o.frequency.value = f;
        og.gain.setValueAtTime(0.0001, now);
        og.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
        og.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        const f2 = ctx.createBiquadFilter();
        f2.type = "lowpass";
        f2.frequency.value = 1800;
        o.connect(f2).connect(og).connect(master);
        o.start(now);
        o.stop(now + 0.65);
      }
      step++;
    }, beatLen * 500); // two events per beat (8ths)

    audioRef.current = {
      ctx,
      stop: () => {
        clearInterval(interval);
        try { pad.stop(); } catch {}
      },
    };
    setMusicOn(true);
  };

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.stop();
      audioRef.current.ctx.close();
      audioRef.current = null;
    }
  }, []);

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden">
      <div ref={mountRef} className="absolute inset-0" />

      {/* ===== HUD (hidden in photo mode) ===== */}
      {!photoMode && (
        <>
          {/* Top bar */}
          <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
            <Link
              to="/"
              className="px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-xs font-medium backdrop-blur hover:bg-black/80"
            >
              ← Worlds
            </Link>
            <div
              className="px-3 py-1.5 rounded-full bg-gradient-to-r from-fuchsia-500/80 to-cyan-400/80 text-xs font-bold tracking-wider uppercase shadow-lg shadow-fuchsia-500/40"
              style={{ fontFamily: "'Sora', system-ui, sans-serif" }}
            >
              🪩 EDM Town
            </div>
          </div>

          {/* Top right controls */}
          <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
            <button
              onClick={toggleMusic}
              className="px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-xs font-medium backdrop-blur hover:bg-black/80"
            >
              {musicOn ? "🔊 Music on" : "🔈 Music off"}
            </button>
            <button
              onClick={() => {
                photoModeRef.current = true;
                setPhotoMode(true);
              }}
              className="px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-xs font-medium backdrop-blur hover:bg-black/80"
            >
              📸 Photo (P)
            </button>
          </div>

          {/* Intro nudge */}
          {showIntro && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 max-w-sm text-center px-4 py-3 rounded-2xl bg-black/70 border border-fuchsia-400/40 backdrop-blur shadow-xl shadow-fuchsia-500/30 animate-in fade-in slide-in-from-bottom-4">
              <div className="text-sm font-semibold mb-1">Welcome to EDM Town 🪩</div>
              <div className="text-xs text-white/80 leading-relaxed">
                <span className="hidden md:inline">
                  <b>WASD</b> to move, click to look around. Press <b>P</b> for photo mode,{" "}
                  <b>E</b> near the green obelisk to sign the guestbook.
                </span>
                <span className="md:hidden">
                  Drag <b>left</b> to walk, <b>right</b> to look. Tap the obelisk button to sign the guestbook.
                </span>
              </div>
            </div>
          )}

          {/* Guestbook prompt */}
          {nearGuestbook && (
            <button
              onClick={() => setGuestbookOpen(true)}
              className="absolute bottom-28 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-full bg-lime-400 text-black text-sm font-bold shadow-lg shadow-lime-400/40 animate-pulse"
            >
              ✍️ Sign the guestbook (E)
            </button>
          )}

          {/* Mobile joystick visual hint (the actual logic is in canvas touch handlers) */}
          <div className="md:hidden absolute bottom-6 left-6 z-10 w-28 h-28 rounded-full border-2 border-white/30 bg-white/5 backdrop-blur pointer-events-none flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-white/30" />
          </div>
          <div className="md:hidden absolute bottom-6 right-6 z-10 text-[10px] text-white/60 pointer-events-none">
            drag to look
          </div>
        </>
      )}

      {/* Photo mode overlay */}
      {photoMode && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          {/* Cinematic bars */}
          <div className="absolute top-0 left-0 right-0 h-12 bg-black" />
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-black" />
          <div className="absolute top-0 left-0 right-0 p-3 flex justify-between items-center pointer-events-auto">
            <div className="text-xs uppercase tracking-widest text-white/70">Photo mode</div>
            <button
              onClick={() => {
                photoModeRef.current = false;
                setPhotoMode(false);
              }}
              className="px-3 py-1 rounded-full bg-white/10 border border-white/30 text-xs"
            >
              ✕ Exit (P)
            </button>
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-3 flex justify-center pointer-events-auto">
            <button
              onClick={handlePhoto}
              className="px-5 py-2 rounded-full bg-white text-black text-sm font-bold shadow-xl"
            >
              📸 Capture & download
            </button>
          </div>
        </div>
      )}

      {/* ===== Guestbook dialog ===== */}
      <Dialog open={guestbookOpen} onOpenChange={setGuestbookOpen}>
        <DialogContent className="max-w-md bg-zinc-950 text-white border-fuchsia-500/40">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              🪩 EDM Town Guestbook
            </DialogTitle>
            <DialogDescription className="text-white/60">
              Leave a short message for future visitors.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              placeholder="Your name"
              value={signName}
              onChange={(e) => setSignName(e.target.value)}
              maxLength={40}
              className="bg-zinc-900 border-white/20"
            />
            <Textarea
              placeholder="Say something nice…"
              value={signMsg}
              onChange={(e) => setSignMsg(e.target.value)}
              maxLength={200}
              rows={3}
              className="bg-zinc-900 border-white/20"
            />
            <Button
              onClick={handleSign}
              className="w-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-black font-bold hover:opacity-90"
            >
              Sign 🪩
            </Button>
          </div>
          <div className="mt-3 max-h-64 overflow-y-auto space-y-2 pr-1">
            {entries.length === 0 && (
              <div className="text-xs text-white/40 text-center py-4">
                Be the first to sign ✨
              </div>
            )}
            {entries.map((e) => (
              <div
                key={e.id}
                className="rounded-lg bg-white/5 border border-white/10 p-2"
              >
                <div className="text-xs text-fuchsia-300 font-semibold">{e.name}</div>
                <div className="text-sm text-white/90">{e.message}</div>
                <div className="text-[10px] text-white/40 mt-0.5">
                  {new Date(e.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
