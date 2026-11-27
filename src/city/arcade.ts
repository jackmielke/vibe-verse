/**
 * arcade — the Vibe Arcade, a building on the block just east of the plaza
 * (cell 5,4) that you walk into as yourself and play the Vibe Verse's
 * table games in.
 *
 * Every game in here is a real station with a real thing to walk up to: a
 * pool table for the 8-Ball Club, a basketball machine for Vibe Hoops, a
 * foosball table for Vibe Cup, a card table for Solitaire, and upright
 * cabinets for the arcade games. Press E (or tap the pill) at one and the
 * game itself opens over the city in a cabinet frame (see
 * `src/components/city/ArcadeCabinet.tsx`), the same route that is on the
 * front page, so there is one copy of each game and the arcade never goes
 * stale. Closing it puts you back on your feet where you stood.
 *
 * Built in world space, +Y up, like `hideouts.ts`: walls are separate
 * collision boxes with a doorway left out, so you can walk (or drive) in.
 * The door is on the west side, facing the plaza.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";

/** World centre of the arcade's block: cell (5,4) with a 40 m pitch. */
export const ARCADE_AT: [number, number] = [40, 0];
/** The block `buildDistrict({ reserve })` leaves empty for it. */
export const ARCADE_RESERVE = { gx: 5, gz: 4, ground: "pave" as const, trees: false };

export interface ArcadeStation {
  key: string;
  /** What the pill says: "Play 8-Ball Club". */
  title: string;
  emoji: string;
  /** The game's own route, framed by the cabinet. */
  route: string;
  /** Neon colour for the cabinet frame. */
  accent: string;
  /** The thing you walk up to. */
  at: THREE.Vector3;
  /** How close counts as "at it", metres, measured on the ground. */
  reach: number;
}

export interface Arcade {
  group: THREE.Group;
  boxes: WorldBox[];
  stations: ArcadeStation[];
  /** Just inside the door, for "take me to the arcade". */
  entrance: THREE.Vector3;
  /** Inside the hall, where the chase camera must come in close. */
  contains(p: THREE.Vector3): boolean;
  /** The station within reach of the player, or null. */
  nearest(p: THREE.Vector3): ArcadeStation | null;
  update(dt: number, now: number, player: THREE.Vector3): void;
  dispose(): void;
}

const HX = 12.5;
const HZ = 12.5;
const H = 8.5;
const T = 0.4;
const DOOR = 3.2; // half width
const DOOR_H = 4.6;

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  draw(x);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A neon word: glowing coloured strokes on black. */
function neonTex(text: string, color: string, w = 1024, h = 256): THREE.CanvasTexture {
  return canvasTex(w, h, (x) => {
    x.fillStyle = "#07040f";
    x.fillRect(0, 0, w, h);
    let size = Math.round(h * 0.6);
    x.font = `900 ${size}px system-ui, sans-serif`;
    while (size > 12 && x.measureText(text).width > w * 0.9) {
      size -= 4;
      x.font = `900 ${size}px system-ui, sans-serif`;
    }
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = color;
    for (const blur of [h * 0.35, h * 0.18, h * 0.06]) {
      x.shadowBlur = blur;
      x.strokeStyle = color;
      x.lineWidth = h * 0.05;
      x.strokeText(text, w / 2, h / 2 + h * 0.03);
    }
    x.shadowBlur = h * 0.05;
    x.fillStyle = "#ffffff";
    x.fillText(text, w / 2, h / 2 + h * 0.03);
  });
}

/** A cabinet's attract screen: the game's name and emoji over a grid. */
function screenTex(title: string, emoji: string, color: string): THREE.CanvasTexture {
  const w = 256;
  const h = 320;
  return canvasTex(w, h, (x) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#120a2a");
    g.addColorStop(1, "#04020a");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.strokeStyle = color;
    x.globalAlpha = 0.35;
    x.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      const y = h * 0.62 + i * i * 1.4;
      x.beginPath();
      x.moveTo(0, y);
      x.lineTo(w, y);
      x.stroke();
    }
    for (let i = -6; i <= 6; i++) {
      x.beginPath();
      x.moveTo(w / 2 + i * 8, h * 0.62);
      x.lineTo(w / 2 + i * 60, h);
      x.stroke();
    }
    x.globalAlpha = 1;
    x.font = "110px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(emoji, w / 2, h * 0.34);
    x.font = "900 30px system-ui, sans-serif";
    x.shadowColor = color;
    x.shadowBlur = 14;
    x.fillStyle = "#ffffff";
    const words = title.toUpperCase().split(" ");
    const lines = words.length > 2 ? [words.slice(0, 2).join(" "), words.slice(2).join(" ")] : [words.join(" ")];
    lines.forEach((l, i) => x.fillText(l, w / 2, h * 0.66 + i * 34));
    x.font = "700 18px system-ui, sans-serif";
    x.fillStyle = color;
    x.fillText("PRESS E", w / 2, h * 0.9);
  });
}

/** The carpet: dark navy with the neon squiggles every arcade has. */
function carpetTex(): THREE.CanvasTexture {
  const t = canvasTex(512, 512, (x) => {
    x.fillStyle = "#0c0a24";
    x.fillRect(0, 0, 512, 512);
    const cols = ["#ff3fd1", "#38e8ff", "#ffe14d", "#7cff6b", "#a66bff"];
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    x.lineWidth = 5;
    x.lineCap = "round";
    for (let i = 0; i < 70; i++) {
      x.strokeStyle = cols[i % cols.length];
      const cx = rnd() * 512;
      const cy = rnd() * 512;
      const kind = i % 4;
      x.beginPath();
      if (kind === 0) {
        x.arc(cx, cy, 8 + rnd() * 10, 0, Math.PI * 2);
      } else if (kind === 1) {
        x.moveTo(cx - 14, cy);
        for (let k = 1; k <= 4; k++) x.lineTo(cx - 14 + k * 7, cy + (k % 2 ? -8 : 8));
      } else if (kind === 2) {
        const r = 10 + rnd() * 6;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + rnd();
          if (k === 0) x.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          else x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        x.closePath();
      } else {
        x.moveTo(cx - 10, cy - 10);
        x.lineTo(cx + 10, cy + 10);
      }
      x.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 5);
  return t;
}

export function buildArcade(opts: { lowDetail?: boolean } = {}): Arcade {
  const group = new THREE.Group();
  group.name = "vibe-arcade";
  const boxes: WorldBox[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <M extends THREE.Material>(m: M) => {
    mats.push(m);
    return m;
  };
  const tex = <X extends THREE.Texture>(t: X) => {
    texs.push(t);
    return t;
  };

  const [cx, cz] = ARCADE_AT;
  const x0 = cx - HX;
  const x1 = cx + HX;
  const z0 = cz - HZ;
  const z1 = cz + HZ;

  const solid = (
    m: THREE.Material, minX: number, maxX: number, minZ: number, maxZ: number, base: number, top: number,
    collide = true,
  ) => {
    const geo = new THREE.BoxGeometry(maxX - minX, top - base, maxZ - minZ);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((minX + maxX) / 2, (base + top) / 2, (minZ + maxZ) / 2);
    mesh.castShadow = !opts.lowDetail;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) boxes.push({ minX, maxX, minZ, maxZ, base, height: top });
    return mesh;
  };
  const plane = (m: THREE.Material, w: number, h: number, x: number, y: number, z: number, yaw: number) => {
    const geo = new THREE.PlaneGeometry(w, h);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    group.add(mesh);
    return mesh;
  };
  const cyl = (m: THREE.Material, r: number, h: number, x: number, y: number, z: number, seg = 16) => {
    const geo = new THREE.CylinderGeometry(r, r, h, seg);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  // ---- Materials -----------------------------------------------------------
  const shell = mat(new THREE.MeshStandardMaterial({ color: 0x2a1747, roughness: 0.6, metalness: 0.2 }));
  const inner = mat(new THREE.MeshStandardMaterial({ color: 0x3a2a6a, roughness: 0.8, emissive: 0x140a2a }));
  const roofM = mat(new THREE.MeshStandardMaterial({ color: 0x221436, roughness: 0.85 }));
  const pink = mat(new THREE.MeshBasicMaterial({ color: 0xff3fd1 }));
  const cyan = mat(new THREE.MeshBasicMaterial({ color: 0x38e8ff }));
  const yellow = mat(new THREE.MeshBasicMaterial({ color: 0xffe14d }));
  const black = mat(new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 0.5, metalness: 0.3 }));
  const wood = mat(new THREE.MeshStandardMaterial({ color: 0x6b3a1e, roughness: 0.55 }));
  const felt = mat(new THREE.MeshStandardMaterial({ color: 0x0f7a4a, roughness: 0.95 }));
  const blueFelt = mat(new THREE.MeshStandardMaterial({ color: 0x1d4fb8, roughness: 0.95 }));
  const chrome = mat(new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.25, metalness: 0.9 }));
  const orange = mat(new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.6 }));
  const red = mat(new THREE.MeshStandardMaterial({ color: 0xd8283a, roughness: 0.5 }));
  const blue = mat(new THREE.MeshStandardMaterial({ color: 0x2c6cf0, roughness: 0.5 }));

  // ---- The hall ------------------------------------------------------------
  {
    // Pulled toward the camera in the depth test: the street's own slab is
    // 4 cm below, and at the city's far plane that is close enough to fight.
    const carpet = mat(new THREE.MeshStandardMaterial({
      map: tex(carpetTex()), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
    solid(carpet, x0, x1, z0, z1, 0, 0.05, false);
    // Walls: north, south, east whole; west with the door left out.
    solid(shell, x0, x1, z1 - T, z1, 0, H);
    solid(shell, x0, x1, z0, z0 + T, 0, H);
    solid(shell, x1 - T, x1, z0 + T, z1 - T, 0, H);
    solid(shell, x0, x0 + T, z0 + T, cz - DOOR, 0, H);
    solid(shell, x0, x0 + T, cz + DOOR, z1 - T, 0, H);
    solid(shell, x0, x0 + T, cz - DOOR, cz + DOOR, DOOR_H, H);
    // Inner skin, a shade darker so the neon reads.
    solid(inner, x0 + T, x1 - T, z1 - T - 0.02, z1 - T, 0, H - 0.4, false);
    solid(inner, x0 + T, x1 - T, z0 + T, z0 + T + 0.02, 0, H - 0.4, false);
    solid(inner, x1 - T - 0.02, x1 - T, z0 + T, z1 - T, 0, H - 0.4, false);
    // Roof: a slab you can stand on and a ceiling you can bump into.
    solid(roofM, x0, x1, z0, z1, H - 0.4, H);
    solid(black, x0, x1, z1 - 0.3, z1, H, H + 0.5, false);
    solid(black, x0, x1, z0, z0 + 0.3, H, H + 0.5, false);
    solid(black, x1 - 0.3, x1, z0, z1, H, H + 0.5, false);
    solid(black, x0, x0 + 0.3, z0, z1, H, H + 0.5, false);

    // Neon bands round the outside: pink low, cyan high.
    const band = (m: THREE.Material, y: number) => {
      solid(m, x0 - 0.06, x1 + 0.06, z1, z1 + 0.06, y, y + 0.14, false);
      solid(m, x0 - 0.06, x1 + 0.06, z0 - 0.06, z0, y, y + 0.14, false);
      solid(m, x1, x1 + 0.06, z0, z1, y, y + 0.14, false);
      solid(m, x0 - 0.06, x0, z0, cz - DOOR, y, y + 0.14, false);
      solid(m, x0 - 0.06, x0, cz + DOOR, z1, y, y + 0.14, false);
    };
    band(pink, 0.9);
    band(cyan, H - 1.1);
    // Neon strips along the ceiling inside.
    for (const dz of [-7, 0, 7]) solid(dz === 0 ? pink : cyan, x0 + 1, x1 - 1, cz + dz - 0.06, cz + dz + 0.06, H - 0.48, H - 0.4, false);
  }

  // ---- The front: the sign, the marquee, the bulbs -------------------------
  const bulbs: THREE.Mesh[] = [];
  const bulbOn = mat(new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
  const bulbOff = mat(new THREE.MeshBasicMaterial({ color: 0x6d5a2a }));
  let signMesh: THREE.Mesh;
  {
    const signM = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("VIBE ARCADE", "#ff3fd1")) }));
    signMesh = plane(signM, 16, 4, x0 - 0.08, H - 2.6, cz, -Math.PI / 2);
    // The sign's twin on the roof's edge facing the plaza, readable from far.
    const roofSign = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("ARCADE", "#38e8ff", 1024, 256)), side: THREE.DoubleSide }));
    const rs = plane(roofSign, 10, 2.5, x0 + 1.2, H + 1.9, cz, -Math.PI / 2);
    solid(black, x0 + 1.1, x0 + 1.3, cz - 4.6, cz - 4.4, H, H + 3.2, false);
    solid(black, x0 + 1.1, x0 + 1.3, cz + 4.4, cz + 4.6, H, H + 3.2, false);
    void rs;
    // Marquee canopy over the door, with a ring of chasing bulbs.
    solid(black, x0 - 2.2, x0, cz - DOOR - 0.8, cz + DOOR + 0.8, DOOR_H + 0.1, DOOR_H + 0.5, false);
    solid(yellow, x0 - 2.26, x0 - 2.2, cz - DOOR - 0.8, cz + DOOR + 0.8, DOOR_H + 0.1, DOOR_H + 0.5, false);
    const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
    geos.push(bulbGeo);
    const n = opts.lowDetail ? 14 : 26;
    for (let i = 0; i < n; i++) {
      const z = cz - DOOR - 0.6 + ((DOOR + 0.6) * 2 * i) / (n - 1);
      const b = new THREE.Mesh(bulbGeo, bulbOn);
      b.position.set(x0 - 2.32, DOOR_H + 0.3, z);
      group.add(b);
      bulbs.push(b);
    }
    // Door frame, pink.
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz - DOOR - 0.12, cz - DOOR, 0, DOOR_H, false);
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz + DOOR, cz + DOOR + 0.12, 0, DOOR_H, false);
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz - DOOR - 0.12, cz + DOOR + 0.12, DOOR_H, DOOR_H + 0.12, false);
    // A red carpet out to the pavement.
    solid(mat(new THREE.MeshStandardMaterial({ color: 0xb3123a, roughness: 0.95 })), x0 - 3, x0, cz - 1.6, cz + 1.6, 0, 0.035, false);
  }

  // ---- Stations ------------------------------------------------------------
  const stations: ArcadeStation[] = [];
  const screens: Array<{ mesh: THREE.Mesh; m: THREE.MeshBasicMaterial; phase: number }> = [];
  const station = (s: Omit<ArcadeStation, "at"> & { at: [number, number] }) => {
    const st: ArcadeStation = { ...s, at: new THREE.Vector3(s.at[0], 0, s.at[1]) };
    stations.push(st);
    return st;
  };
  /** A floating neon label over a station. */
  const label = (text: string, color: string, x: number, y: number, z: number, yaw: number, w = 3.2) => {
    const m = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex(text, color, 768, 192)) }));
    plane(m, w, w / 4, x, y, z, yaw);
  };

  // 8-Ball Club: a real pool table, balls racked, a cue on the rail.
  {
    const tx = cx + 1;
    const tz = cz - 6.5;
    const L = 2.7;
    const W = 1.5;
    solid(wood, tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz - W / 2 - 0.12, tz + W / 2 + 0.12, 0.62, 0.82, false);
    boxes.push({ minX: tx - L / 2 - 0.12, maxX: tx + L / 2 + 0.12, minZ: tz - W / 2 - 0.12, maxZ: tz + W / 2 + 0.12, base: 0, height: 0.9 });
    solid(felt, tx - L / 2, tx + L / 2, tz - W / 2, tz + W / 2, 0.82, 0.84, false);
    for (const [a, b, c, d] of [
      [tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz - W / 2 - 0.12, tz - W / 2],
      [tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz + W / 2, tz + W / 2 + 0.12],
      [tx - L / 2 - 0.12, tx - L / 2, tz - W / 2, tz + W / 2],
      [tx + L / 2, tx + L / 2 + 0.12, tz - W / 2, tz + W / 2],
    ] as const) solid(wood, a, b, c, d, 0.82, 0.9, false);
    for (const px of [tx - L / 2 + 0.1, tx + L / 2 - 0.1]) for (const pz of [tz - W / 2 + 0.1, tz + W / 2 - 0.1]) {
      solid(wood, px - 0.09, px + 0.09, pz - 0.09, pz + 0.09, 0, 0.62, false);
    }
    // Pockets.
    for (const px of [tx - L / 2, tx, tx + L / 2]) for (const pz of [tz - W / 2, tz + W / 2]) cyl(black, 0.07, 0.02, px, 0.845, pz, 10);
    // The rack.
    const ballGeo = new THREE.SphereGeometry(0.045, 12, 8);
    geos.push(ballGeo);
    const ballCols = [0xffd21a, 0x1d4ed8, 0xdc2626, 0x6d28d9, 0xf97316, 0x15803d, 0x7f1d1d, 0x111111, 0xffd21a, 0x1d4ed8, 0xdc2626, 0x6d28d9, 0xf97316, 0x15803d, 0x7f1d1d];
    let k = 0;
    for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++) {
      const m = mat(new THREE.MeshStandardMaterial({ color: ballCols[k++ % ballCols.length], roughness: 0.25 }));
      const b = new THREE.Mesh(ballGeo, m);
      b.position.set(tx + 0.55 + row * 0.08, 0.885, tz + (i - row / 2) * 0.092);
      group.add(b);
    }
    const cue = new THREE.Mesh(ballGeo, white);
    cue.position.set(tx - 0.7, 0.885, tz);
    group.add(cue);
    // The cue stick, lying on the rail.
    const stickGeo = new THREE.CylinderGeometry(0.012, 0.022, 1.45, 8).rotateZ(Math.PI / 2);
    geos.push(stickGeo);
    const stick = new THREE.Mesh(stickGeo, wood);
    stick.position.set(tx, 0.93, tz + W / 2 + 0.06);
    group.add(stick);
    // A hanging lamp.
    solid(black, tx - 0.9, tx + 0.9, tz - 0.25, tz + 0.25, 2.55, 2.7, false);
    solid(yellow, tx - 0.85, tx + 0.85, tz - 0.2, tz + 0.2, 2.53, 2.55, false);
    solid(black, tx - 0.02, tx + 0.02, tz - 0.02, tz + 0.02, 2.7, H - 0.4, false);
    label("8-BALL CLUB", "#7cff6b", tx, 3.3, tz, -Math.PI / 2);
    label("8-BALL CLUB", "#7cff6b", tx, 3.3, tz, Math.PI / 2);
    station({ key: "pool", title: "8-Ball Club", emoji: "🎱", route: "/pool", accent: "#7cff6b", at: [tx, tz], reach: 2.6 });
  }

  // Vibe Hoops: a basketball machine against the east wall, ramp and all.
  {
    const hx = x1 - 2.2;
    const hz = cz - 7.5;
    // The cabinet ramp, sloping up toward the hoop.
    const ramp = solid(black, hx - 1.6, hx + 1.4, hz - 0.8, hz + 0.8, 0, 1.0);
    void ramp;
    solid(orange, hx - 1.6, hx + 1.4, hz - 0.82, hz - 0.78, 0.2, 0.9, false);
    solid(orange, hx - 1.6, hx + 1.4, hz + 0.78, hz + 0.82, 0.2, 0.9, false);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.06, 1.5), mat(new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.6 })));
    geos.push(deck.geometry);
    deck.position.set(hx - 0.1, 1.15, hz);
    deck.rotation.z = 0.12;
    group.add(deck);
    // Net cage.
    const net = mat(new THREE.MeshStandardMaterial({ color: 0x222233, transparent: true, opacity: 0.35, roughness: 0.9 }));
    solid(net, hx - 1.6, hx + 1.4, hz - 0.85, hz - 0.8, 1.0, 3.2, false);
    solid(net, hx - 1.6, hx + 1.4, hz + 0.8, hz + 0.85, 1.0, 3.2, false);
    // Backboard and hoop.
    solid(white, hx + 1.3, hx + 1.4, hz - 0.7, hz + 0.7, 2.2, 3.3, false);
    solid(orange, hx + 1.29, hx + 1.3, hz - 0.25, hz + 0.25, 2.4, 2.75, false);
    const rimGeo = new THREE.TorusGeometry(0.22, 0.02, 8, 24).rotateX(Math.PI / 2);
    geos.push(rimGeo);
    const rim = new THREE.Mesh(rimGeo, orange);
    rim.position.set(hx + 1.05, 2.45, hz);
    group.add(rim);
    // A few balls waiting in the trough.
    const bGeo = new THREE.SphereGeometry(0.12, 14, 10);
    geos.push(bGeo);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(bGeo, orange);
      b.position.set(hx - 1.35, 1.12, hz - 0.45 + i * 0.3);
      group.add(b);
    }
    // Score board above.
    const sm = mat(new THREE.MeshBasicMaterial({ map: tex(screenTex("Vibe Hoops", "🏀", "#ff7a1a")) }));
    const scr = plane(sm, 1.2, 1.5, hx + 1.25, 4.2, hz, -Math.PI / 2);
    screens.push({ mesh: scr, m: sm, phase: 0.3 });
    solid(black, hx + 1.3, hx + 1.4, hz - 0.7, hz + 0.7, 3.3, 5.1, false);
    station({ key: "hoops", title: "Vibe Hoops", emoji: "🏀", route: "/hoops", accent: "#ff7a1a", at: [hx - 1.6, hz], reach: 2.2 });
  }

  // Vibe Cup: a foosball table, red against blue.
  {
    const fx = cx + 1;
    const fz = cz + 6.5;
    const L = 1.5;
    const W = 0.85;
    solid(black, fx - L / 2 - 0.08, fx + L / 2 + 0.08, fz - W / 2 - 0.08, fz + W / 2 + 0.08, 0.55, 0.95, false);
    boxes.push({ minX: fx - L / 2 - 0.08, maxX: fx + L / 2 + 0.08, minZ: fz - W / 2 - 0.08, maxZ: fz + W / 2 + 0.08, base: 0, height: 0.95 });
    solid(felt, fx - L / 2, fx + L / 2, fz - W / 2, fz + W / 2, 0.95, 0.96, false);
    solid(white, fx - 0.01, fx + 0.01, fz - W / 2, fz + W / 2, 0.96, 0.965, false);
    for (const px of [fx - L / 2 + 0.05, fx + L / 2 - 0.05]) for (const pz of [fz - W / 2 + 0.05, fz + W / 2 - 0.05]) {
      solid(black, px - 0.05, px + 0.05, pz - 0.05, pz + 0.05, 0, 0.55, false);
    }
    // Rods and little players.
    const rodGeo = new THREE.CylinderGeometry(0.012, 0.012, W + 0.5, 6).rotateX(Math.PI / 2);
    const manGeo = new THREE.BoxGeometry(0.05, 0.14, 0.04);
    geos.push(rodGeo, manGeo);
    const rods = [-0.6, -0.36, -0.12, 0.12, 0.36, 0.6];
    rods.forEach((dx, i) => {
      const rod = new THREE.Mesh(rodGeo, chrome);
      rod.position.set(fx + dx, 1.08, fz);
      group.add(rod);
      const men = i === 0 || i === 5 ? 1 : i % 2 ? 3 : 2;
      for (let m = 0; m < men; m++) {
        const man = new THREE.Mesh(manGeo, i % 2 ? blue : red);
        man.position.set(fx + dx, 1.03, fz + (men === 1 ? 0 : (m / (men - 1) - 0.5) * W * 0.7));
        group.add(man);
      }
    });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), white);
    geos.push(ball.geometry);
    ball.position.set(fx + 0.05, 0.99, fz + 0.1);
    group.add(ball);
    label("VIBE CUP", "#38e8ff", fx, 2.6, fz, -Math.PI / 2, 2.6);
    label("VIBE CUP", "#38e8ff", fx, 2.6, fz, Math.PI / 2, 2.6);
    station({ key: "vibecup", title: "Vibe Cup", emoji: "⚽", route: "/vibe-cup", accent: "#38e8ff", at: [fx, fz], reach: 2.1 });
  }

  // Solitaire: a round card table under a lamp, a game laid out.
  {
    const sx = cx - 6;
    const sz = cz + 7.5;
    cyl(wood, 0.95, 0.06, sx, 0.78, sz, 28);
    cyl(blueFelt, 0.88, 0.01, sx, 0.815, sz, 28);
    cyl(black, 0.08, 0.76, sx, 0.38, sz, 10);
    cyl(black, 0.45, 0.04, sx, 0.02, sz, 18);
    boxes.push({ minX: sx - 0.9, maxX: sx + 0.9, minZ: sz - 0.9, maxZ: sz + 0.9, base: 0, height: 0.81 });
    const cardGeo = new THREE.BoxGeometry(0.1, 0.004, 0.14);
    geos.push(cardGeo);
    const back = mat(new THREE.MeshStandardMaterial({ color: 0xc81e4a, roughness: 0.7 }));
    for (let col = 0; col < 7; col++) for (let r = 0; r <= col; r++) {
      const c = new THREE.Mesh(cardGeo, r === col ? white : back);
      c.position.set(sx - 0.48 + col * 0.16, 0.82 + r * 0.002, sz - 0.25 + r * 0.05);
      group.add(c);
    }
    for (let f = 0; f < 4; f++) {
      const c = new THREE.Mesh(cardGeo, white);
      c.position.set(sx - 0.1 + f * 0.16, 0.82, sz - 0.5);
      group.add(c);
    }
    // Two stools.
    for (const [dx, dz] of [[-1.25, 0.2], [1.25, -0.2]] as const) {
      cyl(red, 0.25, 0.08, sx + dx, 0.62, sz + dz, 16);
      cyl(chrome, 0.03, 0.6, sx + dx, 0.3, sz + dz, 8);
    }
    solid(black, sx - 0.02, sx + 0.02, sz - 0.02, sz + 0.02, 2.4, H - 0.4, false);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 18, 1, true), mat(new THREE.MeshStandardMaterial({ color: 0x0f7a4a, side: THREE.DoubleSide })));
    geos.push(shade.geometry);
    shade.position.set(sx, 2.3, sz);
    group.add(shade);
    label("SOLITAIRE", "#ffe14d", sx, 3.2, sz, -Math.PI / 2, 2.8);
    label("SOLITAIRE", "#ffe14d", sx, 3.2, sz, Math.PI / 2, 2.8);
    station({ key: "solitaire", title: "Solitaire", emoji: "🃏", route: "/solitaire", accent: "#ffe14d", at: [sx, sz], reach: 2.2 });
  }

  // Upright cabinets along the east wall.
  const cabinet = (key: string, title: string, emoji: string, route: string, color: string, z: number) => {
    const bx = x1 - 1.1;
    const body = mat(new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.35), roughness: 0.5, metalness: 0.2 }));
    const trim = mat(new THREE.MeshBasicMaterial({ color }));
    // Body, control deck and marquee.
    solid(body, bx - 0.4, bx + 0.45, z - 0.45, z + 0.45, 0, 1.0);
    solid(body, bx - 0.55, bx + 0.45, z - 0.45, z + 0.45, 1.0, 1.15, false);
    solid(body, bx - 0.05, bx + 0.45, z - 0.45, z + 0.45, 1.15, 2.2, false);
    solid(trim, bx - 0.12, bx + 0.45, z - 0.47, z + 0.47, 2.2, 2.45, false);
    solid(trim, bx - 0.56, bx - 0.55, z - 0.45, z + 0.45, 1.0, 1.15, false);
    // Joystick and buttons.
    cyl(black, 0.015, 0.12, bx - 0.4, 1.2, z - 0.15, 6);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), red);
    geos.push(knob.geometry);
    knob.position.set(bx - 0.4, 1.27, z - 0.15);
    group.add(knob);
    for (let i = 0; i < 3; i++) cyl(i === 1 ? yellow : cyan, 0.025, 0.02, bx - 0.38 + (i % 2) * 0.05, 1.16, z + 0.05 + i * 0.09, 10);
    const sm = mat(new THREE.MeshBasicMaterial({ map: tex(screenTex(title, emoji, color)) }));
    const scr = plane(sm, 0.72, 0.9, bx - 0.07, 1.7, z, -Math.PI / 2);
    screens.push({ mesh: scr, m: sm, phase: z * 1.7 });
    station({ key, title, emoji, route, accent: color, at: [bx - 0.6, z], reach: 1.5 });
  };
  cabinet("mortmaze", "Mort Maze", "👻", "/mort-maze", "#a66bff", cz + 0.5);
  cabinet("boxing", "Haymaker Boxing", "🥊", "/boxing", "#ff3fd1", cz + 2.1);
  cabinet("2048", "2048", "🔢", "/2048", "#ffe14d", cz + 3.7);
  label("ARCADE CLASSICS", "#a66bff", x1 - 0.6, 3.6, cz + 2.1, -Math.PI / 2, 4.2);

  // A prize counter by the door, all style and no prizes yet.
  {
    const px = cx - 8;
    const pz = cz - 8;
    solid(black, px - 1.8, px + 1.8, pz - 0.5, pz + 0.5, 0, 1.05);
    solid(pink, px - 1.82, px + 1.82, pz + 0.5, pz + 0.52, 0.9, 1.0, false);
    const glass = mat(new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.25, roughness: 0.05 }));
    solid(glass, px - 1.75, px + 1.75, pz - 0.45, pz + 0.45, 1.05, 1.5, false);
    const prizeGeo = new THREE.SphereGeometry(0.12, 10, 8);
    geos.push(prizeGeo);
    const pcols = [pink, cyan, yellow, orange, blue, red];
    for (let i = 0; i < 9; i++) {
      const p = new THREE.Mesh(prizeGeo, pcols[i % pcols.length]);
      p.position.set(px - 1.5 + i * 0.37, 1.18, pz + (i % 2 ? 0.1 : -0.1));
      group.add(p);
    }
    label("PRIZES", "#ff3fd1", px, 2.4, pz - 0.6, 0, 2.4);
  }

  const entrance = new THREE.Vector3(x0 + 2.5, 0, cz);
  const flat = new THREE.Vector3();

  return {
    group,
    boxes,
    stations,
    entrance,
    contains(p) {
      return p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1 && p.y < H - 0.5;
    },
    nearest(p) {
      if (p.y > 2.5 || p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return null;
      flat.set(p.x, 0, p.z);
      let best: ArcadeStation | null = null;
      let bestD = Infinity;
      for (const s of stations) {
        const d = flat.distanceTo(s.at);
        if (d < s.reach && d < bestD) {
          best = s;
          bestD = d;
        }
      }
      return best;
    },
    update(_dt, now, player) {
      const near = Math.abs(player.x - cx) < 160 && Math.abs(player.z - cz) < 160;
      if (!near) return;
      const t = now / 1000;
      // Chasing bulbs: every third one lit, marching toward the door's middle.
      const step = Math.floor(t * 6);
      for (let i = 0; i < bulbs.length; i++) bulbs[i].material = (i + step) % 3 === 0 ? bulbOff : bulbOn;
      // The big sign buzzes now and then, like a real one.
      const buzz = Math.sin(t * 0.7) > 0.96 && Math.sin(t * 47) > 0;
      signMesh.visible = !buzz;
      // Screens breathe.
      for (const s of screens) {
        const v = 0.82 + 0.18 * Math.sin(t * 2.3 + s.phase);
        s.m.color.setRGB(v, v, v);
      }
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
    },
  };
}
