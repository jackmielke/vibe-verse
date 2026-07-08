/**
 * wishGarden — 🌸 the place where God Orb wishes become visible.
 *
 * A flower bed on Vibe Island's south lawn that grows one plant per
 * wish from `universe_requests` (via the `orb_wishes_public` view):
 *
 *   granted wish → a full glowing bloom (petals hashed from the text)
 *   pending wish → a softly-pulsing cyan bud, still growing
 *
 * Walk up to a plant and its wish floats above it — «text» — author.
 * Together with the Mission Control board this closes the loop you can
 * see from anywhere on the island: whisper to the orb, watch it land
 * on the board, and when it ships, something blooms.
 */
import * as THREE from "three";

export interface WishRow {
  text: string;
  author: string;
  status?: string | null;
}

export interface WishGarden {
  group: THREE.Group;
  update(dt: number, now: number, playerPos?: THREE.Vector3): void;
  /** Rebuild the bed from fresh wishes (blooms + buds). */
  setWishes(rows: WishRow[]): void;
}

const BED_R = 3.4;
const PETAL_COLORS = ["#ff7a9e", "#ffd166", "#b78aff", "#7ad7ff", "#ff9a5c", "#5fd068"];

const hashOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// Shared soft radial glow texture (blooms, buds, fireflies).
const makeGlowTexture = () => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(255,244,214,0.9)");
  grad.addColorStop(0.5, "rgba(255,226,150,0.35)");
  grad.addColorStop(1, "rgba(255,226,150,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
};

export function buildWishGarden(): WishGarden {
  const group = new THREE.Group();
  const glowTex = makeGlowTexture();

  // ---- The bed: soil disc + stone ring + wooden sign ----------------
  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(BED_R, BED_R + 0.3, 0.22, 22),
    new THREE.MeshStandardMaterial({ color: "#4a3628", roughness: 1 }),
  );
  soil.position.y = 0.11;
  group.add(soil);
  const stoneMat = new THREE.MeshStandardMaterial({ color: "#9aa3ad", roughness: 0.9, flatShading: true });
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34 + (i % 3) * 0.1, 0), stoneMat);
    stone.position.set(Math.cos(a) * (BED_R + 0.55), 0.22, Math.sin(a) * (BED_R + 0.55));
    stone.rotation.set(i * 1.3, i * 0.7, 0);
    group.add(stone);
  }

  // Sign, SnackFe-chalkboard style, facing the plaza (group +z).
  {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 288;
    const x = c.getContext("2d")!;
    x.fillStyle = "#173022";
    x.fillRect(0, 0, 512, 288);
    x.strokeStyle = "rgba(255,233,179,0.7)";
    x.lineWidth = 8;
    x.strokeRect(10, 10, 492, 268);
    x.textAlign = "center";
    x.fillStyle = "#ffe9b3";
    x.font = "bold 58px 'Sora', system-ui, sans-serif";
    x.fillText("🌸 WISH GARDEN", 256, 96);
    x.fillStyle = "#bfe8cd";
    x.font = "italic 30px 'Manrope', sans-serif";
    x.fillText("whisper to the God Orb —", 256, 168);
    x.fillText("when it's built, it blooms", 256, 214);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Off to the bed's west corner and angled in, so the flowers stay
    // visible from the plaza approach instead of hiding behind it.
    const postMat = new THREE.MeshStandardMaterial({ color: "#8a6a4d", roughness: 0.9 });
    const signG = new THREE.Group();
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.1, 8), postMat);
      post.position.set(s * 1.55, 1.05, 0);
      signG.add(post);
    }
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 2.0),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    panel.position.set(0, 2.2, 0);
    signG.add(panel);
    signG.position.set(-(BED_R + 0.9), 0, BED_R - 0.4);
    signG.rotation.y = -0.5;
    group.add(signG);
  }

  // Fireflies drifting over the bed.
  const flies: THREE.Sprite[] = [];
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.7, depthWrite: false, fog: false }),
    );
    s.scale.setScalar(0.35);
    group.add(s);
    flies.push(s);
  }

  // ---- Plants (rebuilt by setWishes) ---------------------------------
  interface Plant {
    holder: THREE.Group;
    sway: THREE.Group;
    phase: number;
    granted: boolean;
    label: THREE.Sprite;
    glow: THREE.Sprite;
    labelY: number;
  }
  let plants: Plant[] = [];
  const plantsGroup = new THREE.Group();
  group.add(plantsGroup);

  const makeLabel = (row: WishRow, granted: boolean) => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const x = c.getContext("2d")!;
    x.fillStyle = "rgba(10,16,32,0.88)";
    x.beginPath();
    x.roundRect(4, 4, 504, 152, 22);
    x.fill();
    x.strokeStyle = granted ? "rgba(255,209,102,0.65)" : "rgba(122,240,255,0.55)";
    x.lineWidth = 4;
    x.stroke();
    x.textAlign = "center";
    x.font = "italic 30px 'Manrope', sans-serif";
    x.fillStyle = "#ffe9b3";
    let line = `“${row.text}”`;
    while (x.measureText(line).width > 470 && line.length > 6) line = line.slice(0, -2);
    if (!line.endsWith("”")) line += "…";
    x.fillText(line, 256, 62);
    x.font = "24px 'Manrope', sans-serif";
    x.fillStyle = "#9fb2c4";
    x.fillText(
      granted ? `— ${row.author} · 🌸 granted` : `— ${row.author} · 🌱 still growing`,
      256,
      116,
    );
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    label.scale.set(3.4, 1.06, 1);
    return label;
  };

  const setWishes = (rows: WishRow[]) => {
    for (const p of plants) {
      ((p.label.material as THREE.SpriteMaterial).map as THREE.Texture | null)?.dispose();
      p.label.material.dispose();
    }
    plantsGroup.clear();
    plants = [];
    rows.slice(0, 24).forEach((row, i) => {
      const granted = row.status === "granted";
      const h = hashOf(row.text || String(i));
      // Golden-angle spiral keeps any count of plants evenly spread.
      const a = i * 2.399963 + 0.8;
      const r = Math.min(0.8 * Math.sqrt(i + 0.6), BED_R - 0.8);
      const holder = new THREE.Group();
      holder.position.set(Math.cos(a) * r, 0.2, Math.sin(a) * r);
      const sway = new THREE.Group();
      holder.add(sway);

      const stemH = granted ? 1.5 + (h % 5) * 0.16 : 0.9 + (h % 3) * 0.12;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.1, stemH, 6),
        new THREE.MeshStandardMaterial({ color: "#3f8a4a", roughness: 0.9 }),
      );
      stem.position.y = stemH / 2;
      sway.add(stem);
      const leaf = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 6, 5),
        new THREE.MeshStandardMaterial({ color: "#4aa554", roughness: 0.9, flatShading: true }),
      );
      leaf.scale.set(1.6, 0.5, 0.8);
      leaf.position.set(0.22, stemH * 0.45, 0);
      leaf.rotation.z = -0.5;
      sway.add(leaf);

      if (granted) {
        const color = PETAL_COLORS[h % PETAL_COLORS.length];
        const petalMat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.5,
          roughness: 0.7,
          flatShading: true,
        });
        for (let p = 0; p < 6; p++) {
          const pa = (p / 6) * Math.PI * 2;
          const petal = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.6, 5), petalMat);
          petal.position.set(Math.cos(pa) * 0.3, stemH, Math.sin(pa) * 0.3);
          petal.rotation.set(Math.sin(pa) * 1.15, 0, -Math.cos(pa) * 1.15);
          sway.add(petal);
        }
        const heart = new THREE.Mesh(
          new THREE.SphereGeometry(0.21, 10, 8),
          new THREE.MeshBasicMaterial({ color: "#fff4d6" }),
        );
        heart.position.y = stemH;
        sway.add(heart);
      } else {
        const bud = new THREE.Mesh(
          new THREE.ConeGeometry(0.24, 0.55, 7),
          new THREE.MeshStandardMaterial({
            color: "#9ee7ff",
            emissive: "#5fd0e8",
            emissiveIntensity: 0.4,
            roughness: 0.6,
            flatShading: true,
          }),
        );
        bud.position.y = stemH + 0.2;
        sway.add(bud);
      }

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: granted ? "#ffe9b3" : "#9ee7ff",
          transparent: true,
          opacity: granted ? 0.75 : 0.45,
          depthWrite: false,
          fog: false,
        }),
      );
      glow.scale.setScalar(granted ? 1.9 : 1.15);
      glow.position.y = stemH + (granted ? 0 : 0.2);
      sway.add(glow);

      const label = makeLabel(row, granted);
      const labelY = stemH + 1.15;
      label.position.set(holder.position.x, labelY, holder.position.z);
      plantsGroup.add(label);

      plantsGroup.add(holder);
      plants.push({ holder, sway, phase: (h % 100) / 16, granted, label, glow, labelY });
    });
  };

  const worldPos = new THREE.Vector3();
  const update = (dt: number, now: number, playerPos?: THREE.Vector3) => {
    const t = now * 0.001;
    for (const p of plants) {
      p.sway.rotation.z = Math.sin(t * 1.1 + p.phase) * 0.06;
      p.sway.rotation.x = Math.cos(t * 0.9 + p.phase) * 0.04;
      const pulse = p.granted ? 1 + Math.sin(t * 1.6 + p.phase) * 0.1 : 1 + Math.sin(t * 2.4 + p.phase) * 0.18;
      p.glow.scale.setScalar((p.granted ? 1.9 : 1.15) * pulse);
      p.label.position.y = p.labelY + Math.sin(t * 1.2 + p.phase) * 0.05;
    }
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      f.position.set(
        Math.sin(t * 0.24 + i * 2.3) * (BED_R - 1.2),
        1.1 + Math.sin(t * 0.7 + i * 1.4) * 0.5,
        Math.cos(t * 0.31 + i * 1.9) * (BED_R - 1.2),
      );
      (f.material as THREE.SpriteMaterial).opacity = 0.45 + Math.sin(t * 1.8 + i) * 0.25;
    }
    // The nearest plant within reach shows its wish; the rest fade out.
    let nearest: Plant | null = null;
    let best = 36; // 6m squared
    if (playerPos) {
      for (const p of plants) {
        p.holder.getWorldPosition(worldPos);
        const d = worldPos.distanceToSquared(playerPos);
        if (d < best) {
          best = d;
          nearest = p;
        }
      }
    }
    for (const p of plants) {
      const m = p.label.material as THREE.SpriteMaterial;
      const want = p === nearest ? 1 : 0;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 6);
      p.label.visible = m.opacity > 0.02;
    }
  };

  return { group, setWishes, update };
}
