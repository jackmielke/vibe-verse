/**
 * VibeGallery — a 3D photo gallery you can walk around in.
 *
 * Pulls the same `gallery_photos` rows the /space TV uses, but renders
 * each photo as a real framed painting hung on a wall in a small
 * indoor exhibition room. You walk Vibey down the corridor and click
 * a painting to read its title / description / residency tag.
 *
 * Reuses the click-to-move + character picker + theme pattern from
 * MemoryGarden but the world is now an interior room with spotlit
 * paintings, not an open landscape.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { motion, AnimatePresence } from "framer-motion";
import { X, Image as ImageIcon, Sun, Moon, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

import robotVibeyUrl from "@/assets/glb/robot-expressive.glb";
import alienUrl from "@/assets/glb/alien.glb";

const QUATERNIUS_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
function quaternius(name: string): string | undefined {
  const entry = Object.entries(QUATERNIUS_URLS).find(([path]) =>
    path.endsWith(`/${name}.glb`),
  );
  return entry?.[1];
}

interface CharacterOption {
  id: string;
  label: string;
  emoji: string;
  url: string;
}
const CHARACTERS: CharacterOption[] = [
  { id: "vibey", label: "Vibey", emoji: "🤖", url: robotVibeyUrl },
  { id: "alien", label: "Alien", emoji: "👽", url: alienUrl },
  { id: "wizard", label: "Wizard", emoji: "🧙", url: quaternius("Wizard") ?? robotVibeyUrl },
  { id: "knight", label: "Knight", emoji: "🛡", url: quaternius("Knight_Male") ?? robotVibeyUrl },
  { id: "ninja", label: "Ninja", emoji: "🥷", url: quaternius("Ninja_Male") ?? robotVibeyUrl },
  { id: "chef", label: "Chef", emoji: "🥘", url: quaternius("Chef_Female") ?? robotVibeyUrl },
  { id: "elf", label: "Elf", emoji: "🧝", url: quaternius("Elf") ?? robotVibeyUrl },
  { id: "skeleton", label: "Skeleton", emoji: "💀", url: quaternius("Skeleton_Minion") ?? robotVibeyUrl },
];

const CHAR_KEY = "gallery.character.v1";
const THEME_KEY = "gallery.theme.v1";

type Theme = "day" | "night";
const EDGE_COMMUNITY_ID = "4202857f-13fd-4407-8906-3f8ffe63e510";

interface Photo {
  id: string;
  image_url: string;
  title: string | null;
  description: string | null;
  residency_name: string | null;
}

// Painting layout: how many photos per long wall, spacing between
// them, height off the floor, and the painting's physical size in
// world meters. Numbers chosen so the room reads as a comfortable
// art-walk corridor — not too tight, not too sparse.
const PAINTINGS_PER_WALL = 6;
const PAINTING_SPACING = 4.2; // meters between painting centers
const PAINTING_HEIGHT_Y = 2.2; // center of the painting on the wall
const PAINTING_W = 2.4;
const PAINTING_H = 1.6;
const ROOM_LENGTH = PAINTINGS_PER_WALL * PAINTING_SPACING + 4; // hallway length
const ROOM_WIDTH = 9; // distance between the two long walls
const ROOM_HEIGHT = 5;
const WALK_HALF_LEN = ROOM_LENGTH / 2 - 1.5;
const WALK_HALF_WID = ROOM_WIDTH / 2 - 1.5;

export default function VibeGallery() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photosStatus, setPhotosStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [activePhoto, setActivePhoto] = useState<Photo | null>(null);
  const [hint, setHint] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = (typeof localStorage !== "undefined" && localStorage.getItem(THEME_KEY)) as Theme | null;
    return saved === "day" || saved === "night" ? saved : "night";
  });
  const [characterId, setCharacterId] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(CHAR_KEY) : null;
    return CHARACTERS.find((c) => c.id === saved)?.id ?? "vibey";
  });
  useEffect(() => { try { localStorage.setItem(THEME_KEY, theme); } catch { /* */ } }, [theme]);
  useEffect(() => { try { localStorage.setItem(CHAR_KEY, characterId); } catch { /* */ } }, [characterId]);

  const activeRef = useRef<Photo | null>(null);
  useEffect(() => { activeRef.current = activePhoto; }, [activePhoto]);

  // Fetch photos once on mount. They feed the texture load below.
  useEffect(() => {
    let cancelled = false;
    setPhotosStatus("loading");
    supabase
      .from("gallery_photos")
      .select("id, image_url, title, description, residency_name")
      .eq("community_id", EDGE_COMMUNITY_ID)
      .eq("is_visible", true)
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(PAINTINGS_PER_WALL * 2)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setPhotosStatus("error"); return; }
        const list = (data ?? []).filter((p) => p.image_url);
        setPhotos(list);
        setPhotosStatus(list.length ? "ready" : "empty");
      });
    return () => { cancelled = true; };
  }, []);

  // Memoize photos so the scene effect's dep stays stable on
  // unrelated re-renders (theme/character toggles do their own re-init).
  const photosKey = useMemo(() => photos.map((p) => p.id).join(","), [photos]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const characterUrl = CHARACTERS.find((c) => c.id === characterId)?.url ?? robotVibeyUrl;

    // Theme palette — gallery-appropriate. Day = bright museum,
    // night = atmospheric warm-lit gallery hours.
    const palette = theme === "day"
      ? {
          fog: 0xf5f0e6,
          floor: 0xe8d8b8,
          wall: 0xf3ece0,
          ceiling: 0xfdf6e3,
          ambient: 1.1,
          spot: 1.6,
          spotColor: 0xfff2d6,
          rim: 0xffd2a0,
          frame: 0xb8915a,
        }
      : {
          fog: 0x1a1326,
          floor: 0x2c2236,
          wall: 0x3a2e44,
          ceiling: 0x231a30,
          ambient: 0.35,
          spot: 2.6,
          spotColor: 0xffe0a8,
          rim: 0x9b7bff,
          frame: 0xd4a85a,
        };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(palette.fog, 12, 36);
    scene.background = new THREE.Color(palette.fog);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

    // Ambient + a soft hemisphere fill so the room isn't pitch black.
    scene.add(new THREE.AmbientLight(0xffffff, palette.ambient));
    scene.add(new THREE.HemisphereLight(0xffffff, palette.wall, theme === "night" ? 0.25 : 0.5));

    // ---- Room geometry ---------------------------------------------
    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_LENGTH + 8, ROOM_WIDTH + 8),
      new THREE.MeshStandardMaterial({
        color: palette.floor,
        roughness: 0.7,
        metalness: 0.05,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.kind = "ground";
    scene.add(floor);

    // Ceiling.
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_LENGTH + 8, ROOM_WIDTH + 8),
      new THREE.MeshStandardMaterial({
        color: palette.ceiling,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = ROOM_HEIGHT;
    scene.add(ceiling);

    // Walls — long ones on the +Z and -Z sides hold paintings.
    // Material is shared so all walls feel like one continuous space.
    const wallMat = new THREE.MeshStandardMaterial({
      color: palette.wall,
      roughness: 0.9,
      metalness: 0,
    });
    const longWallGeo = new THREE.BoxGeometry(ROOM_LENGTH + 0.4, ROOM_HEIGHT, 0.4);
    const wallNorth = new THREE.Mesh(longWallGeo, wallMat);
    wallNorth.position.set(0, ROOM_HEIGHT / 2, -ROOM_WIDTH / 2);
    wallNorth.receiveShadow = true;
    scene.add(wallNorth);
    const wallSouth = new THREE.Mesh(longWallGeo, wallMat);
    wallSouth.position.set(0, ROOM_HEIGHT / 2, ROOM_WIDTH / 2);
    wallSouth.receiveShadow = true;
    scene.add(wallSouth);
    const shortWallGeo = new THREE.BoxGeometry(0.4, ROOM_HEIGHT, ROOM_WIDTH + 0.4);
    const wallEast = new THREE.Mesh(shortWallGeo, wallMat);
    wallEast.position.set(ROOM_LENGTH / 2, ROOM_HEIGHT / 2, 0);
    wallEast.receiveShadow = true;
    scene.add(wallEast);
    const wallWest = new THREE.Mesh(shortWallGeo, wallMat);
    wallWest.position.set(-ROOM_LENGTH / 2, ROOM_HEIGHT / 2, 0);
    wallWest.receiveShadow = true;
    scene.add(wallWest);

    // Subtle baseboard line so the corner doesn't read as a flat join.
    const baseboardMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
    const bbLong = new THREE.BoxGeometry(ROOM_LENGTH + 0.4, 0.1, 0.05);
    const bbN = new THREE.Mesh(bbLong, baseboardMat);
    bbN.position.set(0, 0.05, -ROOM_WIDTH / 2 + 0.21);
    scene.add(bbN);
    const bbS = new THREE.Mesh(bbLong, baseboardMat);
    bbS.position.set(0, 0.05, ROOM_WIDTH / 2 - 0.21);
    scene.add(bbS);

    // ---- Paintings -------------------------------------------------
    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = "anonymous";

    interface Painting {
      photo: Photo;
      mesh: THREE.Mesh; // hit target = the canvas itself
    }
    const paintings: Painting[] = [];
    const allPositions: Array<{ x: number; z: number; faceZ: number }> = [];
    // Lay out paintings along both walls, alternating so the visitor
    // sees a piece on either side as they walk forward.
    photos.slice(0, PAINTINGS_PER_WALL * 2).forEach((photo, i) => {
      const wallIdx = i % 2; // 0 = north (-Z), 1 = south (+Z)
      const slot = Math.floor(i / 2); // 0..PAINTINGS_PER_WALL-1
      const x =
        -ROOM_LENGTH / 2 +
        2 + // start offset from west wall
        slot * PAINTING_SPACING +
        PAINTING_SPACING / 2;
      const z = wallIdx === 0 ? -ROOM_WIDTH / 2 + 0.22 : ROOM_WIDTH / 2 - 0.22;
      const faceZ = wallIdx === 0 ? 1 : -1; // painting normal points into room
      allPositions.push({ x, z, faceZ });

      // Frame: a slightly larger box behind the canvas.
      const frameGeo = new THREE.BoxGeometry(PAINTING_W + 0.22, PAINTING_H + 0.22, 0.08);
      const frameMat = new THREE.MeshStandardMaterial({
        color: palette.frame,
        roughness: 0.4,
        metalness: 0.55,
      });
      const frame = new THREE.Mesh(frameGeo, frameMat);
      frame.position.set(x, PAINTING_HEIGHT_Y, z);
      frame.rotation.y = wallIdx === 0 ? 0 : Math.PI;
      frame.castShadow = true;
      frame.receiveShadow = true;
      scene.add(frame);

      // Canvas — the thing the photo lands on. Defaults to a soft
      // placeholder grey so a slow texture load isn't a black void.
      const canvasMat = new THREE.MeshStandardMaterial({
        color: 0x9a8c7a,
        roughness: 0.55,
        metalness: 0,
      });
      const canvasGeo = new THREE.PlaneGeometry(PAINTING_W, PAINTING_H);
      const canvasMesh = new THREE.Mesh(canvasGeo, canvasMat);
      canvasMesh.position.set(x, PAINTING_HEIGHT_Y, z + 0.06 * faceZ);
      // Face into the room.
      canvasMesh.rotation.y = wallIdx === 0 ? 0 : Math.PI;
      canvasMesh.userData.photoId = photo.id;
      scene.add(canvasMesh);
      paintings.push({ photo, mesh: canvasMesh });

      // Spotlight from the ceiling pointed at the painting.
      const spot = new THREE.SpotLight(
        palette.spotColor,
        palette.spot,
        9,
        Math.PI / 7,
        0.4,
        1.2,
      );
      spot.position.set(x, ROOM_HEIGHT - 0.4, z + (wallIdx === 0 ? 1.4 : -1.4));
      const spotTarget = new THREE.Object3D();
      spotTarget.position.set(x, PAINTING_HEIGHT_Y, z);
      scene.add(spotTarget);
      spot.target = spotTarget;
      scene.add(spot);

      // Async texture load — once it lands, swap the material's map.
      textureLoader.load(
        photo.image_url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          // Cover-fit: scale UVs so the photo fills the canvas without
          // squishing — the canvas plane is fixed PAINTING_W × _H, so
          // we adjust UVs based on the image aspect ratio.
          const img = tex.image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
          const iw = img.naturalWidth ?? img.width ?? PAINTING_W;
          const ih = img.naturalHeight ?? img.height ?? PAINTING_H;
          const canvasAR = PAINTING_W / PAINTING_H;
          const photoAR = iw / ih;
          if (photoAR > canvasAR) {
            // Photo is wider — crop sides.
            const k = canvasAR / photoAR;
            tex.repeat.x = k;
            tex.offset.x = (1 - k) / 2;
          } else {
            // Photo is taller — crop top/bottom.
            const k = photoAR / canvasAR;
            tex.repeat.y = k;
            tex.offset.y = (1 - k) / 2;
          }
          canvasMat.map = tex;
          canvasMat.color.set(0xffffff); // unmask the placeholder grey
          canvasMat.needsUpdate = true;
        },
        undefined,
        () => { /* leave placeholder grey on error */ },
      );
    });

    // ---- Character + walking ---------------------------------------
    const vibeyGroup = new THREE.Group();
    scene.add(vibeyGroup);
    let vibey: THREE.Group | null = null;
    let vibeyMixer: THREE.AnimationMixer | null = null;
    let walkAction: THREE.AnimationAction | null = null;
    let idleAction: THREE.AnimationAction | null = null;
    const vibeyState = {
      pos: new THREE.Vector3(-ROOM_LENGTH / 2 + 2.5, 0, 0),
      target: new THREE.Vector3(-ROOM_LENGTH / 2 + 2.5, 0, 0),
      heading: Math.PI / 2, // face down the corridor (+x)
      walking: false,
    };
    vibeyGroup.position.copy(vibeyState.pos);
    vibeyGroup.rotation.y = vibeyState.heading;
    {
      const camTargetX = vibeyState.pos.x - Math.sin(vibeyState.heading) * 6.5;
      const camTargetZ = vibeyState.pos.z - Math.cos(vibeyState.heading) * 6.5;
      const camTargetY = vibeyState.pos.y + 3.4;
      camera.position.set(camTargetX, camTargetY, camTargetZ);
      camera.lookAt(vibeyState.pos.x, vibeyState.pos.y + 1.6, vibeyState.pos.z);
    }

    const targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.7, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.position.y = 0.02;
    scene.add(targetRing);

    const loader = new GLTFLoader();
    loader.load(characterUrl, (gltf) => {
      vibey = gltf.scene;
      vibey.position.set(0, 0, 0);
      vibey.scale.setScalar(1);
      vibey.updateMatrixWorld(true);
      const box0 = new THREE.Box3().setFromObject(vibey);
      const size0 = new THREE.Vector3();
      box0.getSize(size0);
      const fit = 1.6 / Math.max(size0.y, 0.01);
      vibey.scale.setScalar(fit);
      vibey.updateMatrixWorld(true);
      const box1 = new THREE.Box3().setFromObject(vibey);
      vibey.position.y = -box1.min.y;
      const c = new THREE.Vector3();
      box1.getCenter(c);
      vibey.position.x = -c.x;
      vibey.position.z = -c.z;
      vibey.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
        }
      });
      vibeyGroup.add(vibey);
      if (gltf.animations && gltf.animations.length > 0) {
        vibeyMixer = new THREE.AnimationMixer(vibey);
        const idleClip =
          gltf.animations.find((c) => /idle|breath|stand/i.test(c.name)) ?? gltf.animations[0];
        const walkClip =
          gltf.animations.find((c) => /walk|run/i.test(c.name)) ?? idleClip;
        if (idleClip) {
          idleAction = vibeyMixer.clipAction(idleClip);
          idleAction.play();
        }
        if (walkClip && walkClip !== idleClip) {
          walkAction = vibeyMixer.clipAction(walkClip);
          walkAction.setLoop(THREE.LoopRepeat, Infinity);
          walkAction.weight = 0;
          walkAction.play();
        }
      }
    });

    // ---- Click handling --------------------------------------------
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const handlePointer = (clientX: number, clientY: number) => {
      if (activeRef.current) return;
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      // 1. Painting hit?
      const meshes = paintings.map((p) => p.mesh);
      const paintingHit = raycaster.intersectObjects(meshes, false)[0];
      if (paintingHit) {
        const id = (paintingHit.object as THREE.Mesh).userData.photoId as string;
        const photo = paintings.find((p) => p.photo.id === id)?.photo;
        if (photo) setActivePhoto(photo);
        return;
      }
      // 2. Floor → walk target.
      const groundHit = raycaster.intersectObject(floor, false)[0];
      if (groundHit) {
        vibeyState.target.copy(groundHit.point);
        vibeyState.walking = true;
        targetRing.position.set(groundHit.point.x, 0.02, groundHit.point.z);
        (targetRing.material as THREE.MeshBasicMaterial).opacity = 0.9;
        setHint(false);
      }
    };

    const onClick = (e: MouseEvent) => handlePointer(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      handlePointer(e.touches[0].clientX, e.touches[0].clientY);
    };
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("touchstart", onTouch, { passive: true });

    const keys: Record<string, boolean> = {};
    const onKeyDown = (e: KeyboardEvent) => { keys[e.key.toLowerCase()] = true; };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.key.toLowerCase()] = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const dt = Math.min(0.05, clock.getDelta());

      // Keyboard nudge.
      const kx = (keys["d"] ? 1 : 0) - (keys["a"] ? 1 : 0);
      const kz = (keys["s"] ? 1 : 0) - (keys["w"] ? 1 : 0);
      if (kx !== 0 || kz !== 0) {
        vibeyState.target.x = vibeyState.pos.x + kx * 4;
        vibeyState.target.z = vibeyState.pos.z + kz * 4;
        vibeyState.walking = true;
        targetRing.visible = false;
      } else {
        targetRing.visible = true;
      }

      // Clamp target inside the room.
      vibeyState.target.x = THREE.MathUtils.clamp(vibeyState.target.x, -WALK_HALF_LEN, WALK_HALF_LEN);
      vibeyState.target.z = THREE.MathUtils.clamp(vibeyState.target.z, -WALK_HALF_WID, WALK_HALF_WID);

      if (vibeyState.walking) {
        const dx = vibeyState.target.x - vibeyState.pos.x;
        const dz = vibeyState.target.z - vibeyState.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.15) {
          vibeyState.walking = false;
          (targetRing.material as THREE.MeshBasicMaterial).opacity = 0;
        } else {
          const speed = 4.0;
          const step = Math.min(speed * dt, dist);
          vibeyState.pos.x += (dx / dist) * step;
          vibeyState.pos.z += (dz / dist) * step;
          const targetHeading = Math.atan2(dx, dz);
          const dh = ((targetHeading - vibeyState.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          vibeyState.heading += dh * Math.min(1, dt * 8);
        }
      }
      vibeyState.pos.x = THREE.MathUtils.clamp(vibeyState.pos.x, -WALK_HALF_LEN, WALK_HALF_LEN);
      vibeyState.pos.z = THREE.MathUtils.clamp(vibeyState.pos.z, -WALK_HALF_WID, WALK_HALF_WID);
      vibeyGroup.position.copy(vibeyState.pos);
      vibeyGroup.rotation.y = vibeyState.heading;

      if (walkAction && idleAction) {
        const targetWalkW = vibeyState.walking ? 1 : 0;
        walkAction.weight += (targetWalkW - walkAction.weight) * Math.min(1, dt * 6);
        idleAction.weight += ((1 - targetWalkW) - idleAction.weight) * Math.min(1, dt * 6);
      }
      vibeyMixer?.update(dt);

      // Camera: third-person chase, biased a touch higher than the
      // garden cam so we can see the paintings on the walls.
      const camTargetX = vibeyState.pos.x - Math.sin(vibeyState.heading) * 6.5;
      const camTargetZ = vibeyState.pos.z - Math.cos(vibeyState.heading) * 6.5;
      const camTargetY = vibeyState.pos.y + 3.4;
      camera.position.x += (camTargetX - camera.position.x) * Math.min(1, dt * 2.4);
      camera.position.y += (camTargetY - camera.position.y) * Math.min(1, dt * 2.4);
      camera.position.z += (camTargetZ - camera.position.z) * Math.min(1, dt * 2.4);
      camera.lookAt(vibeyState.pos.x, vibeyState.pos.y + 1.6, vibeyState.pos.z);

      // Fade the target ring opacity.
      if (!vibeyState.walking) {
        const m = targetRing.material as THREE.MeshBasicMaterial;
        m.opacity += (0 - m.opacity) * Math.min(1, dt * 3);
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("touchstart", onTouch as EventListener);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      ro.disconnect();
      renderer.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    };
  }, [characterId, theme, photosKey]);

  const activeChar = CHARACTERS.find((c) => c.id === characterId) ?? CHARACTERS[0];

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ touchAction: "none" }}
      />

      {/* Header */}
      <div className="absolute top-14 md:top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
        <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Vibe Gallery
          </span>
        </div>
        <div className="hidden sm:flex glass-panel rounded-full px-3 py-2 text-[11px] text-muted-foreground items-center gap-2">
          {photosStatus === "loading" && "Hanging the paintings…"}
          {photosStatus === "ready" && `${photos.length} pieces hanging`}
          {photosStatus === "empty" && "Walls are bare — upload some photos in /space"}
          {photosStatus === "error" && "Couldn't reach the gallery server"}
        </div>
      </div>

      {/* Theme + character (mirrors MemoryGarden's shell so they feel
          like part of the same series) */}
      <div className="absolute top-14 md:top-3 right-3 z-10 flex items-center gap-2">
        <button
          onClick={() => setTheme((t) => (t === "day" ? "night" : "day"))}
          className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted/40 transition-colors"
          title={theme === "day" ? "Switch to night mode" : "Switch to day mode"}
        >
          {theme === "day" ? (
            <Sun className="w-4 h-4 text-primary" />
          ) : (
            <Moon className="w-4 h-4 text-primary" />
          )}
          <span className="text-[10.5px] font-heading font-semibold tracking-widest uppercase hidden sm:inline">
            {theme === "day" ? "Day" : "Night"}
          </span>
        </button>
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="glass-panel rounded-full pl-2 pr-3 py-2 flex items-center gap-2 hover:bg-muted/40 transition-colors"
            title="Change character"
          >
            <span className="text-base leading-none">{activeChar.emoji}</span>
            <span className="text-[10.5px] font-heading font-semibold tracking-widest uppercase hidden sm:inline">
              {activeChar.label}
            </span>
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ duration: 0.16 }}
                className="absolute top-full right-0 mt-2 glass-panel rounded-xl p-2 w-[220px] grid grid-cols-4 gap-1"
              >
                {CHARACTERS.map((c) => {
                  const on = c.id === characterId;
                  return (
                    <button
                      key={c.id}
                      onClick={() => { setCharacterId(c.id); setPickerOpen(false); }}
                      className={`flex flex-col items-center gap-0.5 rounded-lg border transition-all py-1.5 px-1 ${
                        on
                          ? "border-primary/70 bg-primary/15"
                          : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10"
                      }`}
                      title={c.label}
                    >
                      <span className="text-lg leading-none">{c.emoji}</span>
                      <span className="text-[8px] font-heading font-semibold text-foreground/85 leading-tight text-center break-words">
                        {c.label}
                      </span>
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Tutorial hint */}
      <AnimatePresence>
        {hint && photosStatus === "ready" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.4 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 glass-panel rounded-full px-4 py-2.5 text-xs text-foreground/85 flex items-center gap-2 max-w-[90vw]"
          >
            <span className="text-base">🖼️</span>
            <span>Click the floor to walk · click a painting to read about it</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty / error states */}
      {photosStatus !== "loading" && photosStatus !== "ready" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="glass-panel rounded-2xl px-5 py-4 max-w-sm text-center pointer-events-auto">
            <p className="text-sm text-foreground/85 mb-1">
              {photosStatus === "empty" ? "Nothing hung yet" : "Couldn't reach the gallery"}
            </p>
            <p className="text-xs text-muted-foreground">
              {photosStatus === "empty"
                ? "Upload photos to the community gallery to see them here as paintings."
                : "Supabase didn't answer. Try again in a moment."}
            </p>
          </div>
        </div>
      )}

      {/* Painting detail card */}
      <AnimatePresence>
        {activePhoto && (
          <motion.div
            key="photo-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-30 flex items-end md:items-center justify-center bg-black/55 backdrop-blur-[2px] p-4"
            onClick={() => setActivePhoto(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ type: "spring", damping: 22, stiffness: 240 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-2xl rounded-2xl glass-panel overflow-hidden border border-primary/30"
              style={{
                boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 0 60px hsl(var(--primary) / 0.15)",
              }}
            >
              <button
                onClick={() => setActivePhoto(null)}
                className="absolute top-3 right-3 z-10 p-1.5 rounded-md bg-black/40 hover:bg-black/60 transition-colors"
                title="Close"
              >
                <X className="w-4 h-4 text-white" />
              </button>
              <img
                src={activePhoto.image_url}
                alt={activePhoto.title ?? "Gallery photo"}
                className="w-full max-h-[60vh] object-contain bg-black"
              />
              <div className="p-4">
                {activePhoto.residency_name && (
                  <p className="text-[10px] uppercase tracking-widest text-primary/85 font-heading font-semibold mb-1">
                    {activePhoto.residency_name}
                  </p>
                )}
                <h2 className="font-heading text-lg font-bold tracking-tight text-foreground mb-1">
                  {activePhoto.title ?? "Untitled"}
                </h2>
                {activePhoto.description && (
                  <p className="text-sm text-foreground/85 leading-relaxed">
                    {activePhoto.description}
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
