/**
 * ninjaPalace — THE PALACE, the VibeVerse's ninja reality show.
 *
 * Five ninja housemates live in the courtyard of Ninja's Palace on
 * Vibe Island. Each is a real talkable agent (their personas ride the
 * same unit7-chat edge function as Jerry and Vibey), they patrol the
 * courtyard with name tags overhead, and a show board sets the stakes:
 * season one, the Grand Ninja throne is empty, the island votes at the
 * finale. The running episode beat lives in City's persona prefixes so
 * every housemate gossips about the SAME drama from their own angle.
 *
 * Attention is the product: these five exist to be entertaining.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CHARACTERS } from "@/lib/characters";

export interface NinjaCastMember {
  /** Chat key — also the npcTarget id in City. */
  key: "kage" | "ember" | "miso" | "pixel" | "shuri";
  name: string;
  title: string;
  color: string;
  /** Which catalog character renders them. */
  charId: string;
  /** Patrol waypoints, relative to the island center (y = lawn). */
  path: Array<[number, number]>;
  scale?: number;
}

export const NINJA_CAST: NinjaCastMember[] = [
  {
    key: "kage", name: "Kage", title: "the strategist", color: "#b18cff",
    charId: "Ninja_Male", path: [[17, -13], [13, -15]],
  },
  {
    key: "ember", name: "Ember", title: "the hothead", color: "#ff6b57",
    charId: "Ninja_Female", path: [[17, -23], [13.5, -21]],
  },
  {
    key: "miso", name: "Miso", title: "the soup sage", color: "#8ad48a",
    charId: "Ninja_Sand", path: [[11.5, -19], [14.5, -18]],
  },
  {
    key: "pixel", name: "Pixel", title: "the streamer", color: "#7ad7ff",
    charId: "Ninja_Sand_Female", path: [[15, -16.5], [18.5, -12.5]],
  },
  {
    key: "shuri", name: "Grandma Shuri", title: "the retired legend", color: "#ffd166",
    charId: "Ninja_Male", path: [[18.8, -21.8], [17.6, -20.6]], scale: 0.9,
  },
];

const WALK_MPS = 1.1; // stroll speed — housemates, not athletes

function nameTagTexture(name: string, color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 128);
  // Pill.
  const r = 46;
  ctx.beginPath();
  ctx.moveTo(64 + r, 22);
  ctx.arcTo(448, 22, 448, 106, r);
  ctx.arcTo(448, 106, 64, 106, r);
  ctx.arcTo(64, 106, 64, 22, r);
  ctx.arcTo(64, 22, 448, 22, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(10, 12, 18, 0.72)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(104, 64, 16, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = "bold 44px 'Sora', 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(name, 136, 66, 296);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function showBoardTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 768;
  c.height = 384;
  const ctx = c.getContext("2d")!;
  const bg = ctx.createLinearGradient(0, 0, 0, 384);
  bg.addColorStop(0, "#2a1330");
  bg.addColorStop(1, "#4a1a28");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 768, 384);
  ctx.strokeStyle = "#f2a134";
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, 740, 356);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd9a0";
  ctx.font = "bold 30px 'Sora', 'Segoe UI', sans-serif";
  ctx.fillText("🥷  NOW FILMING  🥷", 384, 70);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 84px 'Sora', 'Segoe UI', sans-serif";
  ctx.fillText("THE PALACE", 384, 165);
  ctx.fillStyle = "#f2a134";
  ctx.font = "600 34px 'Sora', 'Segoe UI', sans-serif";
  ctx.fillText("season one · five ninjas · one throne", 384, 230);
  ctx.fillStyle = "#ffd9a0";
  ctx.font = "italic 28px Georgia, serif";
  ctx.fillText("talk to the cast · take sides ·", 384, 300);
  ctx.fillText("the island votes at the finale", 384, 340);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface NinjaRig {
  spec: NinjaCastMember;
  holder: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  /** Patrol state. */
  from: THREE.Vector2;
  to: THREE.Vector2;
  t: number;
  pause: number;
  segLen: number;
}

export function buildNinjaPalaceShow(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
}): {
  group: THREE.Group;
  update(dt: number, now: number): void;
  positions(): Array<{ key: NinjaCastMember["key"]; name: string; pos: THREE.Vector3 }>;
} {
  const { centerX, centerZ, topY } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ);

  // ---- Courtyard dressing --------------------------------------------
  // Red carpet from the palace door out toward the plaza.
  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(7.4, 2.2),
    new THREE.MeshStandardMaterial({ color: "#a31f2e", roughness: 0.9 }),
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(15.6, 0.06, -18);
  group.add(carpet);
  const trim = new THREE.Mesh(
    new THREE.PlaneGeometry(7.6, 2.4),
    new THREE.MeshStandardMaterial({ color: "#ffd166", roughness: 0.8 }),
  );
  trim.rotation.x = -Math.PI / 2;
  trim.position.set(15.6, 0.045, -18);
  group.add(trim);

  // Paper lanterns on posts around the courtyard.
  const lanternGlows: THREE.MeshStandardMaterial[] = [];
  for (const [lx, lz] of [[12, -13], [12, -23], [19, -11.5], [19, -24.5]] as Array<[number, number]>) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.12, 3.1, 8),
      new THREE.MeshStandardMaterial({ color: "#3a2a20", roughness: 0.9 }),
    );
    post.position.set(lx, 1.55, lz);
    group.add(post);
    const glowMat = new THREE.MeshStandardMaterial({
      color: "#ff8c69",
      emissive: "#ff5f3c",
      emissiveIntensity: 1.1,
      roughness: 0.6,
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), glowMat);
    lamp.scale.y = 1.25;
    lamp.position.set(lx, 3.3, lz);
    group.add(lamp);
    lanternGlows.push(glowMat);
  }
  const courtLight = new THREE.PointLight(0xff9d6b, 16, 26, 1.9);
  courtLight.position.set(15.5, 5, -18);
  group.add(courtLight);

  // The show board, angled toward arrivals from the plaza.
  {
    const board = new THREE.Group();
    board.position.set(10.6, 0, -24.6);
    board.rotation.y = Math.atan2(15.5 - 10.6, -18 + 24.6); // face courtyard center
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 2.8),
      new THREE.MeshBasicMaterial({ map: showBoardTexture(), side: THREE.DoubleSide }),
    );
    face.position.set(0, 2.5, 0.07);
    board.add(face);
    const backer = new THREE.Mesh(
      new THREE.BoxGeometry(5.9, 3.1, 0.16),
      new THREE.MeshStandardMaterial({ color: "#2c1a10", roughness: 0.9 }),
    );
    backer.position.set(0, 2.5, -0.06);
    board.add(backer);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.13, 1.1, 8),
        new THREE.MeshStandardMaterial({ color: "#2c1a10", roughness: 0.9 }),
      );
      leg.position.set(side * 2.5, 0.55, 0);
      board.add(leg);
    }
    group.add(board);
  }

  // Miso's soup pot — a prop that pays off the episode lore.
  {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.42, 0.62, 14),
      new THREE.MeshStandardMaterial({ color: "#2f3438", roughness: 0.5, metalness: 0.35 }),
    );
    pot.position.set(10.6, 0.31, -20.6);
    group.add(pot);
    const soup = new THREE.Mesh(
      new THREE.CircleGeometry(0.48, 14),
      new THREE.MeshStandardMaterial({ color: "#c8963c", emissive: "#7a4f14", emissiveIntensity: 0.4, roughness: 0.4 }),
    );
    soup.rotation.x = -Math.PI / 2;
    soup.position.set(10.6, 0.63, -20.6);
    group.add(soup);
    // The hidden sword hilt poking out of the soup. Season one canon.
    const hilt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: "#7a4a86", roughness: 0.6 }),
    );
    hilt.position.set(10.85, 0.9, -20.45);
    hilt.rotation.z = 0.35;
    group.add(hilt);
  }

  // ---- The cast --------------------------------------------------------
  const rigs: NinjaRig[] = [];
  const loader = new GLTFLoader();
  for (const spec of NINJA_CAST) {
    const holder = new THREE.Group();
    holder.position.set(spec.path[0][0], 0, spec.path[0][1]);
    group.add(holder);

    // Name tag floats overhead from frame one (model streams in async).
    const tag = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: nameTagTexture(spec.name, spec.color), transparent: true, depthWrite: false }),
    );
    tag.scale.set(2.1, 0.53, 1);
    tag.position.y = 2.35;
    holder.add(tag);

    // Colored spotlight ring on the lawn — their "confessional mark".
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.66, 24),
      new THREE.MeshBasicMaterial({
        color: spec.color, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    holder.add(ring);

    const rig: NinjaRig = {
      spec,
      holder,
      mixer: null,
      idle: null,
      walk: null,
      from: new THREE.Vector2(spec.path[0][0], spec.path[0][1]),
      to: new THREE.Vector2(spec.path[1][0], spec.path[1][1]),
      t: Math.random(),
      pause: Math.random() * 3,
      segLen: 1,
    };
    rig.segLen = rig.from.distanceTo(rig.to);
    rigs.push(rig);

    const char = CHARACTERS.find((ch) => ch.id === spec.charId);
    if (!char) continue;
    loader.load(char.url, (gltf) => {
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = (1.85 * (spec.scale ?? 1)) / Math.max(size.x, size.y, size.z, 0.0001);
      model.scale.setScalar(fit);
      model.updateMatrixWorld(true);
      const scaled = new THREE.Box3().setFromObject(model);
      model.position.y = -scaled.min.y;
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const apply = (mat: THREE.Material) => {
          const std = mat as THREE.MeshStandardMaterial;
          if (std && "metalness" in std) {
            std.metalness = Math.min(std.metalness, 0.3);
            std.roughness = Math.max(std.roughness, 0.45);
            std.needsUpdate = true;
          }
        };
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach(apply);
        else if (mat) apply(mat);
      });
      holder.add(model);
      // Team-color sash so the cast reads apart at a glance.
      const sash = new THREE.Mesh(
        new THREE.TorusGeometry(0.34, 0.05, 8, 20),
        new THREE.MeshStandardMaterial({
          color: spec.color, emissive: spec.color, emissiveIntensity: 0.4, roughness: 0.5,
        }),
      );
      sash.rotation.x = Math.PI / 2;
      sash.position.y = 1.0 * (spec.scale ?? 1);
      holder.add(sash);
      if (gltf.animations.length) {
        rig.mixer = new THREE.AnimationMixer(model);
        const findAction = (re: RegExp) => {
          const clip = gltf.animations.find((cl) => re.test(cl.name));
          return clip ? rig.mixer!.clipAction(clip) : null;
        };
        rig.idle = findAction(/^idle$/i) ?? findAction(/idle/i);
        rig.walk = findAction(/^walk$/i) ?? findAction(/walk/i);
        rig.idle?.play();
      }
    });
  }

  const setAnim = (rig: NinjaRig, walking: boolean) => {
    if (!rig.mixer || !rig.idle || !rig.walk) return;
    const on = walking ? rig.walk : rig.idle;
    const off = walking ? rig.idle : rig.walk;
    if (!on.isRunning()) {
      on.reset().fadeIn(0.25).play();
      off.fadeOut(0.25);
    }
  };

  return {
    group,
    positions() {
      return rigs.map((r) => ({
        key: r.spec.key,
        name: r.spec.name,
        pos: new THREE.Vector3(
          centerX + r.holder.position.x,
          topY + 1,
          centerZ + r.holder.position.z,
        ),
      }));
    },
    update(dt, now) {
      for (const rig of rigs) {
        rig.mixer?.update(dt);
        if (rig.pause > 0) {
          rig.pause -= dt;
          setAnim(rig, false);
          continue;
        }
        rig.t += (WALK_MPS * dt) / Math.max(rig.segLen, 0.001);
        setAnim(rig, true);
        if (rig.t >= 1) {
          // Arrive, breathe, turn around.
          rig.t = 0;
          rig.pause = 2.5 + Math.random() * 4;
          const tmp = rig.from;
          rig.from = rig.to;
          rig.to = tmp;
        }
        const x = THREE.MathUtils.lerp(rig.from.x, rig.to.x, rig.t);
        const z = THREE.MathUtils.lerp(rig.from.y, rig.to.y, rig.t);
        rig.holder.position.set(x, 0, z);
        const dx = rig.to.x - rig.from.x;
        const dz = rig.to.y - rig.from.y;
        const targetYaw = Math.atan2(dx, dz);
        let d = targetYaw - rig.holder.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        rig.holder.rotation.y += d * Math.min(1, dt * 8);
      }
      // Lanterns breathe.
      lanternGlows.forEach((m, i) => {
        m.emissiveIntensity = 1.0 + Math.sin(now * 0.002 + i * 1.4) * 0.35;
      });
      courtLight.intensity = 15 + Math.sin(now * 0.0016) * 3;
    },
  };
}
