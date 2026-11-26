/**
 * Thanksgiving on Vibe Island: harvest dressing, falling leaves and a parade.
 *
 * On by itself from the 20th of November to the end of the month, and a
 * button in the world controls turns it off (remembered per device, the way
 * Cannon Chase does it). `?thanksgiving` forces it on and `?thanksgiving=off`
 * forces it off, for screenshots either way.
 *
 * Everything here is decoration: nothing collides, so a hay bale can never
 * trap a kart or a spawn. The one thing with gameplay, the giant turkey you
 * ride, lives in `turkey.ts` and plugs into the same mount code as Pegasus.
 *
 * Island-local coordinates come from `islandPlan.ts`: the plaza is r = 11 at
 * the origin, the High Street (south avenue) runs down +z with shops at
 * |x| ~ 10, and the zipline hangs 5 m over the rim promenade, which is why the
 * parade stays on the High Street and never goes near the rim.
 */
import * as THREE from "three";

const KEY = "city.thanks";

/** Is it on for this visit? URL first, then the saved choice, then the date. */
export function thanksgivingOn(search = typeof window !== "undefined" ? window.location.search : "", now = new Date()): boolean {
  const q = new URLSearchParams(search);
  if (q.has("thanksgiving")) return q.get("thanksgiving") !== "off" && q.get("thanksgiving") !== "0";
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private window */ }
  if (saved === "on" || saved === "off") return saved === "on";
  return isThanksgivingSeason(now);
}

/** The 20th of November to the 30th, which always contains the holiday. */
export function isThanksgivingSeason(d: Date): boolean {
  return d.getMonth() === 10 && d.getDate() >= 20;
}

export function saveThanksgiving(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private window */ }
}

/** Where the turkey waits, island-local: the north lawn, facing the plaza. */
export const TURKEY_REST = { x: 6.5, z: -14, yaw: 0 };

/**
 * The parade route, island-local: a long narrow loop down the High Street and
 * back, lanes at x = +-2.5, turning at z = 14 (just off the plaza) and z = 33
 * (short of the Character Studio at z = 39).
 */
export const PARADE = { half: 2.5, z0: 14, z1: 33, speed: 2.2 };

/** Point and heading on the parade loop at distance `d` along it. */
export function paradeAt(d: number): { x: number; z: number; yaw: number } {
  const { half: r, z0, z1 } = PARADE;
  const straight = z1 - z0;
  const turn = Math.PI * r;
  const lap = 2 * straight + 2 * turn;
  let s = ((d % lap) + lap) % lap;
  // Out along the east lane (x = +r) heading +z...
  if (s < straight) return { x: r, z: z0 + s, yaw: 0 };
  s -= straight;
  if (s < turn) {
    const a = s / r; // 0..PI, round the far end
    return { x: Math.cos(a) * r, z: z1 + Math.sin(a) * r, yaw: -a };
  }
  s -= turn;
  // ...and back up the west lane heading -z.
  if (s < straight) return { x: -r, z: z1 - s, yaw: Math.PI };
  s -= straight;
  const a = s / r;
  return { x: -Math.cos(a) * r, z: z0 - Math.sin(a) * r, yaw: Math.PI - a };
}

export interface Thanksgiving {
  group: THREE.Group;
  /** The parade float, so the page can find it. World position. */
  float: THREE.Group;
  setOn(on: boolean): void;
  update(dt: number, now: number, camera: THREE.Camera): void;
  dispose(): void;
}

function textTexture(lines: string[], w: number, h: number, bg: string, fg: string, border: string) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = border; g.lineWidth = Math.round(h * 0.06);
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
  g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
  const size = Math.floor((h * 0.62) / lines.length);
  g.font = `900 ${size}px "Trebuchet MS", system-ui, sans-serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, h * ((i + 0.5) / lines.length) + size * 0.04));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function leafTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.translate(32, 32);
  g.rotate(-0.6);
  g.fillStyle = "#fff";
  g.beginPath();
  // A five-lobed maple-ish leaf.
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 27 : 13;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.95;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath(); g.fill();
  g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, 26); g.lineTo(0, -22); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildThanksgiving(opts: {
  /** Vibe Island's centre at its top surface, world coordinates. */
  island: THREE.Vector3;
  /** Low-end phones get fewer leaves. */
  lowDetail?: boolean;
  /** The float's star, a turkey built with its body origin at y = 2.5. */
  balloon?: { group: THREE.Object3D; update(dt: number, now: number): void };
}): Thanksgiving {
  const group = new THREE.Group();
  group.name = "thanksgiving";
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });
    mats.push(m);
    return m;
  };
  const geo = <G extends THREE.BufferGeometry>(g: G) => { geos.push(g); return g; };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => { const x = new THREE.Mesh(g, m); x.castShadow = true; x.receiveShadow = true; return x; };

  const pumpkinMat = std(0xe8771e, { emissive: 0x5a2205, emissiveIntensity: 0.35 });
  const pumpkinDeep = std(0xc95a12, { emissive: 0x4a1a04, emissiveIntensity: 0.35 });
  const stemMat = std(0x4f6b22);
  const hayMat = std(0xdcb45a, { emissive: 0x3a2c0a, emissiveIntensity: 0.3, roughness: 1 });
  const hayBand = std(0x8a6a2a);
  const cornMat = std(0xc9a85a, { emissive: 0x2a2008, emissiveIntensity: 0.25, roughness: 1, side: THREE.DoubleSide });
  const woodMat = std(0x6b4423);

  const pumpkinGeo = geo(new THREE.SphereGeometry(0.5, 14, 10));
  // Ribs: pull the sphere in along eight meridians.
  {
    const p = pumpkinGeo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const a = Math.atan2(v.z, v.x);
      const rib = 1 - 0.08 * Math.pow(Math.abs(Math.cos(a * 4)), 3);
      p.setXYZ(i, v.x * rib, v.y * 0.72, v.z * rib);
    }
    pumpkinGeo.computeVertexNormals();
  }
  const stemGeo = geo(new THREE.CylinderGeometry(0.05, 0.08, 0.22, 6));
  const pumpkin = (s: number, deep = false) => {
    const g = new THREE.Group();
    const b = mesh(pumpkinGeo, deep ? pumpkinDeep : pumpkinMat);
    b.scale.setScalar(s);
    b.position.y = 0.36 * s;
    g.add(b);
    const st = mesh(stemGeo, stemMat);
    st.scale.setScalar(s);
    st.position.y = 0.78 * s;
    st.rotation.z = 0.25;
    g.add(st);
    return g;
  };
  const baleGeo = geo(new THREE.BoxGeometry(1.6, 0.85, 0.95));
  const bandGeo = geo(new THREE.BoxGeometry(0.08, 0.88, 0.98));
  const bale = () => {
    const g = new THREE.Group();
    const b = mesh(baleGeo, hayMat);
    b.position.y = 0.425;
    g.add(b);
    for (const x of [-0.45, 0.45]) { const k = mesh(bandGeo, hayBand); k.position.set(x, 0.425, 0); g.add(k); }
    return g;
  };
  const stalkGeo = geo(new THREE.ConeGeometry(0.08, 2.6, 4, 1, true));
  const shock = () => {
    // A corn shock: stalks leaned together into a teepee, tied at the waist.
    const g = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const s = mesh(stalkGeo, cornMat);
      s.position.set(Math.cos(a) * 0.35, 1.2, Math.sin(a) * 0.35);
      s.rotation.set(Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22);
      g.add(s);
    }
    const tie = mesh(geo(new THREE.TorusGeometry(0.22, 0.05, 6, 12)), hayBand);
    tie.rotation.x = Math.PI / 2;
    tie.position.y = 1.5;
    g.add(tie);
    return g;
  };

  // ---- On the island ---------------------------------------------------
  const isle = new THREE.Group();
  isle.position.copy(opts.island);
  group.add(isle);
  const put = (o: THREE.Object3D, x: number, z: number, yaw = 0, parent: THREE.Object3D = isle) => {
    o.position.set(x, 0, z);
    o.rotation.y = yaw;
    parent.add(o);
    return o;
  };
  // Pumpkins along both kerbs of the High Street and the Approach, big and
  // small alternating, skipping the Welcome Arch's feet.
  let n = 0;
  for (const side of [-1, 1]) {
    for (let z = 12; z <= 37; z += 3.2) put(pumpkin(n++ % 3 === 0 ? 1.15 : 0.7, n % 2 === 0), side * 5.3, z + (side > 0 ? 1.6 : 0), n);
    for (let z = -13; z >= -38; z -= 3.6) {
      if (z < -17 && z > -23) continue;
      put(pumpkin(n++ % 3 === 0 ? 1.1 : 0.7, n % 2 === 0), side * 5.3, z, n);
    }
  }
  // Round the plaza rim, in the four quarters between the roads.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + Math.PI / 16;
    const x = Math.cos(a) * 12, z = Math.sin(a) * 12;
    if (Math.abs(x) < 5.5 || Math.abs(z) < 5.5) continue;
    // Pegasus and the dragon stand at (+-12, 8); leave them room.
    if (Math.abs(z - 8) < 3.5 && Math.abs(Math.abs(x) - 12) < 3.5) continue;
    put(pumpkin(0.85, i % 2 === 0), x, z, i);
  }
  // Hay bales with a pumpkin on top, and corn shocks either side of the arch.
  for (const [x, z, yaw] of [[-7.5, 13.5, 0.2], [7.6, -11.8, -0.3], [-7.4, -12.2, 0.4]] as const) {
    const b = put(bale(), x, z, yaw);
    const p = pumpkin(0.8);
    p.position.set(0.3, 0.85, 0);
    b.add(p);
  }
  for (const [x, z] of [[-5.6, -18.2], [5.6, -18.2], [-5.6, -21.8], [5.6, -21.8]] as const) put(shock(), x, z);

  // A banner across the High Street, high enough for the parade to pass under.
  const bannerTex = textTexture(["HAPPY THANKSGIVING"], 1024, 160, "#8a2a12", "#ffe6b0", "#f6b33a");
  texs.push(bannerTex);
  const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTex, side: THREE.DoubleSide, roughness: 0.8, emissive: 0xffffff, emissiveMap: bannerTex, emissiveIntensity: 0.45 });
  mats.push(bannerMat);
  const banner = new THREE.Group();
  banner.position.set(0, 0, 11.8);
  isle.add(banner);
  const poleGeo = geo(new THREE.CylinderGeometry(0.1, 0.12, 8.6, 8));
  for (const x of [-5.6, 5.6]) { const p = mesh(poleGeo, woodMat); p.position.set(x, 4.3, 0); banner.add(p); }
  const cloth = mesh(geo(new THREE.PlaneGeometry(10, 1.56)), bannerMat);
  cloth.position.y = 7.7;
  banner.add(cloth);
  // Bunting under it in harvest colours.
  const flagGeo = geo(new THREE.ConeGeometry(0.26, 0.55, 3));
  const flagMats = [std(0xc0392b, { side: THREE.DoubleSide }), std(0xe67e22, { side: THREE.DoubleSide }), std(0xf1c40f, { side: THREE.DoubleSide }), std(0x8e5a2b, { side: THREE.DoubleSide })];
  for (let i = 0; i < 17; i++) {
    const t = i / 16;
    const f = mesh(flagGeo, flagMats[i % 4]);
    f.rotation.x = Math.PI;
    f.scale.z = 0.15;
    f.position.set(-5.4 + t * 10.8, 6.6 - Math.sin(t * Math.PI) * 0.6, 0);
    banner.add(f);
  }

  // ---- The parade float -------------------------------------------------
  const float = new THREE.Group();
  float.name = "parade-float";
  isle.add(float);
  const skirtTex = textTexture(["HAPPY THANKSGIVING", "FROM VIBE ISLAND"], 1024, 200, "#d9641c", "#fff4d6", "#7a2a10");
  texs.push(skirtTex);
  const skirtMat = new THREE.MeshStandardMaterial({ map: skirtTex, roughness: 0.8, emissive: 0xffffff, emissiveMap: skirtTex, emissiveIntensity: 0.3 });
  mats.push(skirtMat);
  const deckMat = std(0x7a4a26);
  const fringeMat = std(0xf6c445, { emissive: 0x7a5a10, emissiveIntensity: 0.5 });
  const tyreMat = std(0x1a1a1a, { roughness: 0.9 });
  const deck = mesh(geo(new THREE.BoxGeometry(2.9, 0.3, 6)), deckMat);
  deck.position.y = 1.05;
  float.add(deck);
  const skirt = mesh(geo(new THREE.BoxGeometry(2.95, 0.75, 6.05)), std(0xd9641c));
  skirt.position.y = 0.6;
  float.add(skirt);
  // Signs on both long sides.
  for (const s of [-1, 1]) {
    const sign = mesh(geo(new THREE.PlaneGeometry(5.6, 1.1)), skirtMat);
    sign.position.set(1.49 * s, 0.75, 0);
    sign.rotation.y = s * Math.PI / 2;
    float.add(sign);
  }
  const fringe = mesh(geo(new THREE.BoxGeometry(3.05, 0.16, 6.15)), fringeMat);
  fringe.position.y = 1.2;
  float.add(fringe);
  const wheelGeo = geo(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 14));
  const wheels: THREE.Mesh[] = [];
  for (const sx of [-1.25, 1.25]) for (const sz of [-2.2, 2.2]) {
    const w = mesh(wheelGeo, tyreMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(sx, 0.38, sz);
    float.add(w);
    wheels.push(w);
  }
  // Harvest on the deck: bales at the front, pumpkins at the corners.
  for (const x of [-0.85, 0.85]) { const b = bale(); b.scale.setScalar(0.75); b.position.set(x, 1.2, 2.35); b.rotation.y = Math.PI / 2; float.add(b); }
  for (const [x, z, s] of [[-1.1, -2.5, 0.7], [1.1, -2.5, 0.8], [1.05, 1.4, 0.55], [-1.05, 1.4, 0.6]] as const) {
    const p = pumpkin(s, x > 0);
    p.position.set(x, 1.2, z);
    float.add(p);
  }
  if (opts.balloon) {
    // The float's star: a turkey, slightly smaller than the one you ride.
    opts.balloon.group.scale.setScalar(0.72);
    opts.balloon.group.position.set(0, 1.2, -0.3);
    float.add(opts.balloon.group);
  }
  let paradeD = 0;

  // ---- In the city below, a little harvest round the plaza -------------
  const town = new THREE.Group();
  group.add(town);
  for (const [x, z, yaw] of [[-6.2, -6.4, 0.5], [6.4, -6.2, -0.4]] as const) {
    const b = put(bale(), x, z, yaw, town);
    const p = pumpkin(0.75, true);
    p.position.set(-0.35, 0.85, 0);
    b.add(p);
  }
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * 1.08 + (i / 8) * Math.PI * 0.84;
    put(pumpkin(i % 3 === 0 ? 1 : 0.65, i % 2 === 1), Math.cos(a) * 6.3, Math.sin(a) * 6.3, i, town);
  }

  // ---- Leaves ------------------------------------------------------------
  const COUNT = opts.lowDetail ? 160 : 360;
  const BOX = 34;
  const leafPos = new Float32Array(COUNT * 3);
  const leafCol = new Float32Array(COUNT * 3);
  const leafSeed = new Float32Array(COUNT);
  const palette = [0xd2491b, 0xe8822a, 0xf2b636, 0xa8321c, 0x8a5a24, 0xe06a1e].map((h) => new THREE.Color(h));
  for (let i = 0; i < COUNT; i++) {
    leafPos[i * 3] = (Math.random() - 0.5) * BOX * 2;
    leafPos[i * 3 + 1] = Math.random() * 22;
    leafPos[i * 3 + 2] = (Math.random() - 0.5) * BOX * 2;
    const c = palette[i % palette.length];
    leafCol[i * 3] = c.r; leafCol[i * 3 + 1] = c.g; leafCol[i * 3 + 2] = c.b;
    leafSeed[i] = Math.random() * 100;
  }
  const leafGeo = geo(new THREE.BufferGeometry());
  leafGeo.setAttribute("position", new THREE.BufferAttribute(leafPos, 3));
  leafGeo.setAttribute("color", new THREE.BufferAttribute(leafCol, 3));
  const leafTex = leafTexture();
  texs.push(leafTex);
  const leafMat = new THREE.PointsMaterial({ size: 0.45, map: leafTex, vertexColors: true, transparent: true, alphaTest: 0.4, depthWrite: false });
  mats.push(leafMat);
  const leaves = new THREE.Points(leafGeo, leafMat);
  leaves.frustumCulled = false;
  group.add(leaves);
  // The leaves live in world space inside a box that follows the camera:
  // one that drifts out of the box on one side comes back in on the other,
  // so there are always some in view and never thousands to update.
  let seeded = false;
  let lastFloor = NaN;
  const camPos = new THREE.Vector3();
  const wrap = (v: number, c: number) => (v - c > BOX ? v - BOX * 2 : v - c < -BOX ? v + BOX * 2 : v);

  let on = true;
  return {
    group,
    float,
    setOn(v) {
      on = v;
      group.visible = v;
    },
    update(dt, now, camera) {
      if (!on) return;
      const s = now / 1000;
      // The parade.
      paradeD += dt * PARADE.speed;
      const p = paradeAt(paradeD);
      float.position.set(p.x, Math.sin(s * 3) * 0.02, p.z);
      float.rotation.y = p.yaw;
      for (const w of wheels) w.rotation.x -= (dt * PARADE.speed) / 0.38;
      opts.balloon?.update(dt, now);
      // Leaves: only near the island or down in the city, never on the Moon.
      camera.getWorldPosition(camPos);
      const nearIsland = Math.hypot(camPos.x - opts.island.x, camPos.z - opts.island.z) < 150 && camPos.y > opts.island.y - 40 && camPos.y < opts.island.y + 90;
      const inTown = camPos.y < 100 && Math.abs(camPos.x) < 260 && Math.abs(camPos.z) < 260;
      leaves.visible = nearIsland || inTown;
      if (!leaves.visible) return;
      const floorY = nearIsland ? opts.island.y : 0;
      if (!seeded || floorY !== lastFloor) {
        // First sight, or a jump between the island and the town: scatter
        // the whole lot round the camera again.
        for (let i = 0; i < COUNT; i++) {
          leafPos[i * 3] = camPos.x + (Math.random() - 0.5) * BOX * 2;
          leafPos[i * 3 + 1] = Math.random() * 22;
          leafPos[i * 3 + 2] = camPos.z + (Math.random() - 0.5) * BOX * 2;
        }
        seeded = true;
        lastFloor = floorY;
      }
      leaves.position.set(0, floorY, 0);
      const k = Math.min(dt, 0.05);
      for (let i = 0; i < COUNT; i++) {
        const j = i * 3;
        const sd = leafSeed[i];
        leafPos[j] += (Math.sin(s * 1.3 + sd) * 0.9 + 0.5) * k;
        leafPos[j + 1] -= (0.8 + (sd % 1) * 0.9) * k;
        leafPos[j + 2] += Math.cos(s * 1.1 + sd * 1.7) * 0.9 * k;
        if (leafPos[j + 1] < 0.05) {
          leafPos[j + 1] = 18 + Math.random() * 6;
          leafPos[j] = camPos.x + (Math.random() - 0.5) * BOX * 2;
          leafPos[j + 2] = camPos.z + (Math.random() - 0.5) * BOX * 2;
        }
        leafPos[j] = wrap(leafPos[j], camPos.x);
        leafPos[j + 2] = wrap(leafPos[j + 2], camPos.z);
      }
      leafGeo.attributes.position.needsUpdate = true;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
      group.removeFromParent();
    },
  };
}
