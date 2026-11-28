/**
 * The Vibe Bowl: an open-air amphitheatre on the quiet south-east corner of
 * Vibe City (cell 8,6), with the beach and the sea behind the stage.
 *
 * A bandshell of four telescoping arches over a stage, an LED wall, a truss of
 * moving heads, lasers, flame jets, five curved terraces round a pit, and an
 * original band (The Static Bloom, `band.ts`) playing an original set
 * (`show.ts`, `music.ts`) on the city clock, so everybody in the bowl is at
 * the same chorus. The crowd in the pit is the city's dance crowd
 * (`danceCrowd.ts`): dance with them and they are dancing with you.
 *
 * Get up the steps at either front corner of the stage and the crowd turns to
 * you; take a solo (E) and the band drops into it, the flame jets go and the
 * pit roars.
 *
 * Like the arcade: no real lights. Every beam is an additive cone, every glow
 * an unlit surface, so the city's materials never recompile.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { cityBeats, DANCES } from "@/components/city/dances";
import { createDanceCrowd, type CrowdSpot, type DanceCrowd } from "@/components/city/danceCrowd";
import { buildBand } from "./band";
import { createConcertMusic, type ConcertMusic } from "./music";
import { BAND_NAME, SETLIST, VENUE_NAME, secondsToNextSong, showAt, type ShowState } from "./show";

export { BAND_NAME, VENUE_NAME } from "./show";

/** Cell (8,6) of the 9×9 district: world (160, 80). */
export const CONCERT_AT: [number, number] = [160, 80];
export const CONCERT_RESERVE = { gx: 8, gz: 6, ground: "pave" as const, trees: false };

const CX = CONCERT_AT[0];
const CZ = CONCERT_AT[1];
/** The stage front's centre: the bowl's terraces are rings round it. */
const FX = CX + 3;
const FZ = CZ;
const DECK_Y = 1.2;
const DECK = { minX: FX, maxX: CX + 13, minZ: CZ - 11, maxZ: CZ + 11 };
const TIERS = 5;
const TIER_R0 = 9.2;
const TIER_W = 1.6;
const TIER_H = 0.4;
const TIER_ARC = (50 * Math.PI) / 180;
const AISLE = (5 * Math.PI) / 180;

export interface NowPlaying {
  band: string;
  venue: string;
  title: string;
  section: string;
  inBreak: boolean;
  next: string;
  nextIn: number;
  soloing: boolean;
}

export interface Concert {
  group: THREE.Group;
  boxes: WorldBox[];
  /** In the aisle at the back, looking at the stage: "take me to the concert". */
  entrance: THREE.Vector3;
  music: ConcertMusic;
  /** Close enough to be at the show (the HUD shows what is playing). */
  near(p: THREE.Vector3): boolean;
  /** Up on the stage. */
  onStage(p: THREE.Vector3): boolean;
  /** Take a solo: four bars, starting on the next bar line. */
  solo(): void;
  nowPlaying(): NowPlaying;
  /** The visitor's own music is playing (Spotify): the band mimes, quietly. */
  setExternal(on: boolean): void;
  update(dt: number, player: THREE.Vector3): void;
  dispose(): void;
}

function canvasTex(w: number, h: number, draw?: (x: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  draw?.(x);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { t, c, x };
}

/** A beam's fade: bright at the lamp, nothing at the far end, soft at the edges. */
function beamTexture() {
  return canvasTex(8, 256, (x) => {
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.4)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 8, 256);
  }).t;
}

function glowTexture() {
  return canvasTex(64, 64, (x) => {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
  }).t;
}

/** An annulus sector in the XZ plane, extruded up `h` from y = 0. */
function sector(r0: number, r1: number, a0: number, a1: number, h: number) {
  const s = new THREE.Shape();
  // Shape space is (x, y) = (world x offset, -world z offset) before the rotation below.
  const p = (r: number, a: number) => new THREE.Vector2(-Math.cos(a) * r, Math.sin(a) * r);
  const steps = 18;
  s.moveTo(p(r0, a0).x, p(r0, a0).y);
  for (let i = 1; i <= steps; i++) {
    const v = p(r0, a0 + ((a1 - a0) * i) / steps);
    s.lineTo(v.x, v.y);
  }
  for (let i = steps; i >= 0; i--) {
    const v = p(r1, a0 + ((a1 - a0) * i) / steps);
    s.lineTo(v.x, v.y);
  }
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function buildConcert(opts: { lowDetail?: boolean } = {}): Concert {
  const low = !!opts.lowDetail;
  const group = new THREE.Group();
  group.name = "vibe-bowl";
  const boxes: WorldBox[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const box = (minX: number, maxX: number, minZ: number, maxZ: number, height: number, base = 0) =>
    boxes.push({ minX, maxX, minZ, maxZ, base, height });

  const concrete = keep(new THREE.MeshStandardMaterial({ color: 0xb9b4c4, roughness: 0.92 }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x15131c, roughness: 0.7, metalness: 0.2 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: 0x3a3a44, roughness: 0.45, metalness: 0.7 }));
  const shellMat = keep(new THREE.MeshStandardMaterial({ color: 0xf1eef6, roughness: 0.6, side: THREE.DoubleSide, emissive: 0x7a3cff, emissiveIntensity: 0.2 }));
  const violet = keep(new THREE.MeshBasicMaterial({ color: 0x9b5cff }));
  const cyan = keep(new THREE.MeshBasicMaterial({ color: 0x38e8ff }));
  const beamTex = keep(beamTexture());
  const glow = keep(glowTexture());

  // ---- The pit ----------------------------------------------------------------
  {
    const pit = new THREE.Mesh(keep(new THREE.CircleGeometry(TIER_R0, 48, Math.PI / 2, Math.PI)), keep(new THREE.MeshStandardMaterial({ color: 0x2a2633, roughness: 0.85 })));
    pit.rotation.x = -Math.PI / 2;
    pit.position.set(FX, 0.03, FZ);
    group.add(pit);
    // A pale ring at the barrier line, so the pit reads from the terraces.
    const rim = new THREE.Mesh(keep(new THREE.RingGeometry(TIER_R0 - 0.12, TIER_R0, 48, 1, Math.PI / 2, Math.PI)), cyan);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(FX, 0.045, FZ);
    group.add(rim);
  }

  // ---- The terraces -----------------------------------------------------------
  /*
   * Five curved steps, 40 cm each, which is what the walker can step up
   * (`City.tsx` steps up to 42 cm), with a level aisle down the middle so the
   * pit is reachable from the street behind without climbing. Collision is a
   * fan of small boxes along each ring: an axis-aligned box cannot be curved,
   * but twelve of them per side are within a hand's width of the curve.
   */
  const ledMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < TIERS; i++) {
    const r0 = TIER_R0 + i * TIER_W;
    const r1 = TIER_R0 + TIERS * TIER_W; // each tier runs to the back, so there is no gap underneath
    const h = TIER_H * (i + 1);
    for (const [a0, a1] of [[-TIER_ARC, -AISLE], [AISLE, TIER_ARC]]) {
      const m = new THREE.Mesh(keep(sector(r0, r1, a0, a1, h)), concrete);
      m.position.set(FX, 0, FZ);
      m.receiveShadow = true;
      group.add(m);
      // The riser's light strip.
      const led = keep(new THREE.MeshBasicMaterial({ color: i % 2 ? 0x9b5cff : 0x38e8ff, transparent: true, opacity: 0.9 }));
      ledMats.push(led);
      const strip = new THREE.Mesh(keep(sector(r0 - 0.03, r0 + 0.02, a0, a1, 0.06)), led);
      strip.position.set(FX, h - 0.1, FZ);
      group.add(strip);
      const segs = 12;
      for (let s = 0; s < segs; s++) {
        const sa = a0 + ((a1 - a0) * s) / segs;
        const sb = a0 + ((a1 - a0) * (s + 1)) / segs;
        const xs: number[] = [];
        const zs: number[] = [];
        for (const a of [sa, sb]) for (const r of [r0 + 0.25, r0 + TIER_W]) {
          xs.push(FX - Math.cos(a) * r);
          zs.push(FZ - Math.sin(a) * r);
        }
        box(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), h);
      }
    }
  }

  // ---- The stage ----------------------------------------------------------------
  {
    const w = DECK.maxX - DECK.minX;
    const d = DECK.maxZ - DECK.minZ;
    const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(w, DECK_Y, d)), dark);
    deck.position.set((DECK.minX + DECK.maxX) / 2, DECK_Y / 2, CZ);
    deck.receiveShadow = true;
    group.add(deck);
    box(DECK.minX, DECK.maxX, DECK.minZ, DECK.maxZ, DECK_Y);
    const lip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.06, 0.08, d)), cyan);
    lip.position.set(DECK.minX - 0.03, DECK_Y - 0.06, CZ);
    group.add(lip);
    // Steps up at both front corners.
    for (const sz of [-1, 1]) {
      const z0 = sz < 0 ? DECK.minZ : DECK.maxZ - 2.4;
      for (const [x0, x1, h] of [[FX - 1.6, FX - 0.8, 0.4], [FX - 0.8, FX, 0.8]] as const) {
        const st = new THREE.Mesh(keep(new THREE.BoxGeometry(x1 - x0, h, 2.4)), dark);
        st.position.set((x0 + x1) / 2, h / 2, z0 + 1.2);
        group.add(st);
        const edge = new THREE.Mesh(keep(new THREE.BoxGeometry(0.04, 0.03, 2.4)), violet);
        edge.position.set(x0 + 0.02, h + 0.01, z0 + 1.2);
        group.add(edge);
        box(x0, x1, z0, z0 + 2.4, h);
      }
    }
    // The drum riser.
    const riser = new THREE.Mesh(keep(new THREE.BoxGeometry(3.2, 0.45, 3.4)), dark);
    riser.position.set(CX + 9.6, DECK_Y + 0.225, CZ);
    group.add(riser);
    const rlip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.05, 3.4)), violet);
    rlip.position.set(CX + 8.0, DECK_Y + 0.43, CZ);
    group.add(rlip);
    box(CX + 8, CX + 11.2, CZ - 1.7, CZ + 1.7, 0.45, DECK_Y);
    // Speaker stacks on the wings.
    const grille = keep(canvasTex(128, 256, (x) => {
      x.fillStyle = "#121117";
      x.fillRect(0, 0, 128, 256);
      x.fillStyle = "#050507";
      for (const [cy, r] of [[50, 40], [140, 40], [215, 22]]) {
        x.beginPath();
        x.arc(64, cy, r, 0, Math.PI * 2);
        x.fill();
      }
    }).t);
    const spkMats = [dark, dark, dark, dark, keep(new THREE.MeshStandardMaterial({ map: grille, roughness: 0.8 })), dark];
    for (const sz of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const spk = new THREE.Mesh(keep(new THREE.BoxGeometry(1.4, 1.6, 1.2)), spkMats);
        spk.rotation.y = -Math.PI / 2;
        spk.position.set(FX + 1.2, DECK_Y + 0.8 + k * 1.6, CZ + sz * 9.6);
        group.add(spk);
      }
      box(FX + 0.5, FX + 1.9, CZ + sz * 9.6 - 0.7, CZ + sz * 9.6 + 0.7, 3.2, DECK_Y);
    }
  }

  // ---- The bandshell ------------------------------------------------------------
  /*
   * Four half-pipes, each a little smaller and further back, which is what
   * makes a bandshell read from across the city. The inner faces take the
   * show's colour through their emissive, a single uniform per frame.
   */
  const SHELLS = [11, 10, 9, 8];
  const SHELL_LEN = 2.5;
  {
    for (const [i, r] of SHELLS.entries()) {
      const geo = keep(new THREE.CylinderGeometry(r, r, SHELL_LEN, 40, 1, true, 0, Math.PI));
      geo.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(geo, shellMat);
      m.position.set(FX + 1.25 + i * SHELL_LEN, DECK_Y, CZ);
      m.castShadow = true;
      group.add(m);
      // Light along each arch's front edge.
      const rib = new THREE.Mesh(keep(new THREE.TorusGeometry(r - 0.05, 0.07, 6, 48, Math.PI)), i % 2 ? cyan : violet);
      rib.rotation.y = Math.PI / 2;
      rib.position.set(FX + i * SHELL_LEN + 0.02, DECK_Y, CZ);
      group.add(rib);
    }
    // The back of the shell, a half disc, so there is no seeing through to the beach.
    const back = new THREE.Mesh(keep(new THREE.CircleGeometry(SHELLS[3], 40, 0, Math.PI)), dark);
    back.rotation.y = -Math.PI / 2;
    back.position.set(FX + SHELLS.length * SHELL_LEN, DECK_Y, CZ);
    group.add(back);
    box(DECK.maxX - 0.4, DECK.maxX, DECK.minZ, DECK.maxZ, 9, DECK_Y);
  }

  // ---- The LED wall -------------------------------------------------------------
  const screen = canvasTex(512, 256);
  keep(screen.t);
  {
    const s = new THREE.Mesh(keep(new THREE.PlaneGeometry(9, 4.5)), keep(new THREE.MeshBasicMaterial({ map: screen.t, toneMapped: false })));
    s.rotation.y = -Math.PI / 2;
    s.position.set(FX + SHELLS.length * SHELL_LEN - 0.05, DECK_Y + 3.9, CZ);
    group.add(s);
  }

  // ---- Truss, moving heads, washes ------------------------------------------------
  interface Beam { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; base: THREE.Vector3; phase: number; side: number }
  const beams: Beam[] = [];
  const washes: Beam[] = [];
  const beamGeo = keep(new THREE.CylinderGeometry(0.08, 1.4, 1, 20, 1, true));
  beamGeo.translate(0, -0.5, 0); // lamp at the origin, beam down -Y
  const aimAt = (m: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) => {
    const dir = to.clone().sub(from);
    const len = dir.length();
    m.position.copy(from);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
  };
  {
    const TRUSS_X = FX + 1.2;
    const TRUSS_Y = DECK_Y + 7.6;
    const bar = new THREE.Mesh(keep(new THREE.BoxGeometry(0.35, 0.35, 13)), steel);
    bar.position.set(TRUSS_X, TRUSS_Y, CZ);
    group.add(bar);
    const n = low ? 4 : 8;
    for (let i = 0; i < n; i++) {
      const z = CZ - 6 + (12 * i) / (n - 1);
      const head = new THREE.Mesh(keep(new THREE.BoxGeometry(0.4, 0.45, 0.4)), dark);
      head.position.set(TRUSS_X, TRUSS_Y - 0.4, z);
      group.add(head);
      const lens = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      lens.scale.set(0.9, 0.9, 1);
      lens.position.set(TRUSS_X - 0.2, TRUSS_Y - 0.55, z);
      group.add(lens);
      const mat = keep(new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      beams.push({ mesh, mat, base: new THREE.Vector3(TRUSS_X - 0.2, TRUSS_Y - 0.6, z), phase: i * 0.7, side: i < n / 2 ? -1 : 1 });
    }
    // Washes from the second arch onto the band.
    for (const z of [CZ - 4.5, CZ, CZ + 4.5]) {
      const mat = keep(new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffffff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.frustumCulled = false;
      const from = new THREE.Vector3(FX + 4, DECK_Y + 8.6, z);
      aimAt(mesh, from, new THREE.Vector3(FX + 4.5, DECK_Y, z));
      mesh.scale.x = mesh.scale.z = 1.8;
      group.add(mesh);
      washes.push({ mesh, mat, base: from, phase: z, side: 0 });
    }
  }

  // ---- Lasers ---------------------------------------------------------------------
  const LASERS = low ? 6 : 12;
  const laserMat = keep(new THREE.MeshBasicMaterial({ color: 0x3dffb0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  const laserGeo = keep(new THREE.BoxGeometry(0.06, 0.06, 1));
  laserGeo.translate(0, 0, 0.5);
  const laserOrigin = new THREE.Vector3(FX + SHELLS.length * SHELL_LEN - 0.3, DECK_Y + 1.4, CZ);
  const lasers: THREE.Mesh[] = [];
  for (let i = 0; i < LASERS; i++) {
    const l = new THREE.Mesh(laserGeo, laserMat);
    l.position.copy(laserOrigin);
    l.scale.z = 60;
    l.visible = false;
    l.frustumCulled = false;
    group.add(l);
    lasers.push(l);
  }

  // ---- Flame jets -----------------------------------------------------------------
  const flameMat = keep(new THREE.SpriteMaterial({ map: glow, color: 0xff8a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const jets: THREE.Sprite[][] = [];
  for (const z of [CZ - 8, CZ - 3.5, CZ + 3.5, CZ + 8]) {
    const nozzle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10)), steel);
    nozzle.position.set(FX + 0.5, DECK_Y + 0.15, z);
    group.add(nozzle);
    const col: THREE.Sprite[] = [];
    for (let k = 0; k < 6; k++) {
      const s = new THREE.Sprite(flameMat);
      s.position.set(FX + 0.5, DECK_Y + 0.5 + k * 0.7, z);
      s.scale.setScalar(1.6 - k * 0.15);
      s.visible = false;
      group.add(s);
      col.push(s);
    }
    jets.push(col);
  }

  // ---- Confetti, for the last chord ----------------------------------------------
  const CONFETTI = low ? 150 : 500;
  const confPos = new Float32Array(CONFETTI * 3);
  const confVel = new Float32Array(CONFETTI * 3);
  const confCol = new Float32Array(CONFETTI * 3);
  const palette = [0xff3fd1, 0x38e8ff, 0xffd23f, 0x9b5cff, 0x3dffb0].map((h) => new THREE.Color(h));
  for (let i = 0; i < CONFETTI; i++) {
    const c = palette[i % palette.length];
    confCol.set([c.r, c.g, c.b], i * 3);
  }
  const confGeo = keep(new THREE.BufferGeometry());
  confGeo.setAttribute("position", new THREE.BufferAttribute(confPos, 3));
  confGeo.setAttribute("color", new THREE.BufferAttribute(confCol, 3));
  const confetti = new THREE.Points(confGeo, keep(new THREE.PointsMaterial({ size: 0.18, vertexColors: true })));
  confetti.visible = false;
  confetti.frustumCulled = false;
  group.add(confetti);
  let confettiT = 0;
  let confettiBar = -1;
  const burst = () => {
    for (let i = 0; i < CONFETTI; i++) {
      confPos.set([FX + 1 + Math.random() * 2, DECK_Y + 7, CZ + (Math.random() - 0.5) * 10], i * 3);
      confVel.set([-(3 + Math.random() * 7), 2 + Math.random() * 4, (Math.random() - 0.5) * 9], i * 3);
    }
    confettiT = 7;
    confetti.visible = true;
  };

  // ---- The sign over the back aisle ------------------------------------------------
  {
    const sign = canvasTex(1024, 256, (x) => {
      x.fillStyle = "#07040f";
      x.fillRect(0, 0, 1024, 256);
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.font = "900 112px system-ui, sans-serif";
      x.shadowColor = "#ff3fd1";
      x.shadowBlur = 28;
      x.fillStyle = "#ffe6fb";
      x.fillText(VENUE_NAME.toUpperCase(), 512, 108);
      x.font = "700 44px system-ui, sans-serif";
      x.shadowColor = "#38e8ff";
      x.fillStyle = "#d8fbff";
      x.fillText(`LIVE TONIGHT: ${BAND_NAME.toUpperCase()}`, 512, 200);
    }).t;
    keep(sign);
    const R = TIER_R0 + TIERS * TIER_W + 0.25;
    const sx = FX - R;
    const posts = [-2.4, 2.4];
    for (const dz of posts) {
      const p = new THREE.Mesh(keep(new THREE.BoxGeometry(0.25, 5.4, 0.25)), steel);
      p.position.set(sx, 2.7, CZ + dz);
      group.add(p);
      box(sx - 0.15, sx + 0.15, CZ + dz - 0.15, CZ + dz + 0.15, 5.4);
    }
    const face = keep(new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }));
    const board = new THREE.Mesh(keep(new THREE.BoxGeometry(0.3, 1.5, 6)), [dark, dark, dark, dark, dark, dark]);
    board.position.set(sx, 5.4 + 0.75, CZ);
    group.add(board);
    for (const [dx, ry] of [[-0.16, -Math.PI / 2], [0.16, Math.PI / 2]] as const) {
      const f = new THREE.Mesh(keep(new THREE.PlaneGeometry(6, 1.5)), face);
      f.rotation.y = ry;
      f.position.set(sx + dx, 5.4 + 0.75, CZ);
      group.add(f);
    }
  }

  // ---- The band -------------------------------------------------------------------
  const band = buildBand();
  const SPOT: Record<string, [number, number, number]> = {
    vocals: [FX + 1.6, DECK_Y, CZ],
    guitar: [FX + 2.6, DECK_Y, CZ - 4.6],
    bass: [FX + 2.6, DECK_Y, CZ + 4.6],
    keys: [FX + 5.6, DECK_Y, CZ + 6.4],
    drums: [CX + 9.8, DECK_Y + 0.45, CZ],
  };
  for (const m of band.members) {
    m.group.position.set(...SPOT[m.role]);
    // Face the crowd, who are at -X; the keys player angles in toward the band.
    m.group.rotation.y = -Math.PI / 2 + (m.role === "keys" ? -0.5 : m.role === "guitar" ? 0.2 : m.role === "bass" ? -0.2 : 0);
    group.add(m.group);
  }

  // ---- The crowd ------------------------------------------------------------------
  const designs = ["pixel", "bumble", "chrome", "sable", "eddie", "flux", "nightcape", "whiskers", "emberwing", "marshmallow", "gilt", "bounty", "medic", "emerald", "titan", "phase", "cinder", "frostbite", "mothling", "prickle", "origami", "aurora", "hexen", "monarch", "basilisk", "stinger"];
  const spots: CrowdSpot[] = [];
  {
    const count = low ? 10 : 26;
    const rnd = (n: number) => {
      const x = Math.sin(n * 91.7 + 3.1) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; spots.length < count && i < count * 10; i++) {
      // Denser at the front, like any pit.
      const r = 2.2 + Math.pow(rnd(i), 1.4) * (TIER_R0 - 3);
      const a = (rnd(i + 50) - 0.5) * 2 * 1.25;
      const x = FX - Math.cos(a) * r;
      const z = FZ - Math.sin(a) * r;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 1.25)) continue;
      spots.push({
        x, z, y: 0.05,
        design: designs[spots.length % designs.length],
        yaw: Math.atan2(FX + 2 - x, FZ - z) + (rnd(i + 9) - 0.5) * 0.4,
        order: spots.length % 6,
      });
    }
  }
  const crowd: DanceCrowd = createDanceCrowd({ spots, seed: 8, sway: 0.22, dances: DANCES });
  group.add(crowd.group);

  // ---- The show ------------------------------------------------------------------------
  const music = createConcertMusic();
  let external = false;
  let lastScreen = 0;
  let lastState: ShowState = showAt(cityBeats());
  const tmpTo = new THREE.Vector3();
  const tmpCol = new THREE.Color();
  const colA = new THREE.Color();
  const colB = new THREE.Color();
  const entrance = new THREE.Vector3(FX - (TIER_R0 + TIERS * TIER_W) - 2.5, 0.2, CZ);

  const drawScreen = (st: ShowState, beats: number, soloing: boolean) => {
    const { x } = screen;
    const W = 512;
    const H = 256;
    const [a, b] = st.song.colors;
    const pulse = 1 - (beats % 1);
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#07040f");
    g.addColorStop(1, st.inBreak ? "#140a24" : "#0d0618");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.textAlign = "center";
    x.textBaseline = "middle";
    if (st.inBreak) {
      x.font = "900 54px system-ui, sans-serif";
      x.fillStyle = "#fff";
      x.shadowColor = a;
      x.shadowBlur = 24;
      x.fillText("THANK YOU!", W / 2, 90);
      x.shadowBlur = 0;
      const next = SETLIST[(st.songIndex + 1) % SETLIST.length];
      x.font = "700 28px system-ui, sans-serif";
      x.fillStyle = b;
      x.fillText(`NEXT: ${next.title.toUpperCase()}`, W / 2, 170);
      screen.t.needsUpdate = true;
      return;
    }
    // Bars that bounce with the kick and lean with the melody.
    const n = 24;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.9 + beats * 1.7)) * 0.5 + Math.abs(Math.sin(i * 0.37 - beats * 0.6)) * 0.3;
      const h = (0.15 + v * st.energy + pulse * 0.25 * st.energy) * H * 0.85;
      x.fillStyle = i % 2 ? a : b;
      x.globalAlpha = 0.55 + 0.45 * st.energy;
      x.fillRect(8 + i * (W - 16) / n, H - h, (W - 16) / n - 4, h);
    }
    x.globalAlpha = 1;
    x.shadowColor = a;
    x.shadowBlur = 20;
    x.fillStyle = "#fff";
    if (soloing) {
      x.font = "900 76px system-ui, sans-serif";
      x.fillText("🎸 SOLO!", W / 2, 90);
    } else if (st.section === "intro" || st.barInSong < 6) {
      x.font = "900 40px system-ui, sans-serif";
      x.fillText(BAND_NAME.toUpperCase(), W / 2, 70);
      x.font = "700 30px system-ui, sans-serif";
      x.fillStyle = b;
      x.fillText(`“${st.song.title}”`, W / 2, 122);
    } else if (st.section === "chorus") {
      x.font = "900 64px system-ui, sans-serif";
      x.fillText(st.song.title.toUpperCase(), W / 2, 84);
    } else {
      x.font = "800 34px system-ui, sans-serif";
      x.fillText(BAND_NAME.toUpperCase(), W / 2, 60);
    }
    x.shadowBlur = 0;
    screen.t.needsUpdate = true;
  };

  const onStage = (p: THREE.Vector3) =>
    p.x > DECK.minX && p.x < DECK.maxX - 0.4 && p.z > DECK.minZ && p.z < DECK.maxZ && p.y > DECK_Y - 0.3 && p.y < DECK_Y + 3;

  return {
    group,
    boxes,
    entrance,
    music,
    near(p) {
      return Math.hypot(p.x - FX, p.z - FZ) < 34;
    },
    onStage,
    solo() {
      if (lastState.inBreak) return;
      music.solo(4);
    },
    nowPlaying() {
      const st = lastState;
      const beats = cityBeats();
      return {
        band: BAND_NAME,
        venue: VENUE_NAME,
        title: st.song.title,
        section: st.section,
        inBreak: st.inBreak,
        next: SETLIST[(st.songIndex + 1) % SETLIST.length].title,
        nextIn: secondsToNextSong(beats),
        soloing: music.soloing(beats),
      };
    },
    setExternal(on) {
      external = on;
    },
    update(dt, player) {
      const d = Math.hypot(player.x - FX, player.z - FZ);
      // Sound: full in the bowl, gone a few blocks away.
      music.setLevel(external ? 0 : THREE.MathUtils.clamp(1 - (d - 26) / 90, 0, 1));
      if (d > 260) return; // nothing here is worth animating from across the map
      const beats = cityBeats();
      const st = showAt(beats);
      lastState = st;
      const soloing = music.soloing(beats);
      const e = st.inBreak ? 0.15 : Math.max(st.energy, soloing ? 1 : 0);
      const pulse = Math.pow(1 - (beats % 1), 2);
      colA.set(st.song.colors[0]);
      colB.set(st.song.colors[1]);

      // The shell and the risers breathe in the song's colours.
      tmpCol.copy(colA).lerp(colB, 0.5 + 0.5 * Math.sin(beats * Math.PI * 0.25));
      shellMat.emissive.copy(tmpCol);
      shellMat.emissiveIntensity = 0.12 + 0.35 * e * (0.6 + 0.4 * pulse);
      for (const [i, m] of ledMats.entries()) {
        m.color.copy(i % 2 ? colA : colB);
        m.opacity = 0.35 + 0.65 * (st.section === "chorus" ? pulse : 0.6);
      }

      // Moving heads: they sweep the crowd, wider and faster on a chorus.
      const sweep = st.section === "chorus" || soloing ? 1 : st.section === "bridge" ? 0.25 : 0.6;
      for (const b of beams) {
        const t = beats * Math.PI * (st.section === "chorus" ? 0.5 : 0.25) + b.phase;
        const ax = FX - 10 - 6 * Math.sin(t * 0.7) * sweep;
        const az = FZ + b.side * 4 + Math.sin(t) * 9 * sweep;
        tmpTo.set(ax, 0, az);
        aimAt(b.mesh, b.base, tmpTo);
        b.mesh.scale.x = b.mesh.scale.z = 1;
        b.mat.color.copy(b.side < 0 ? colA : colB);
        b.mat.opacity = st.inBreak ? 0.12 : (0.18 + 0.4 * e) * (st.section === "chorus" ? 0.6 + 0.4 * pulse : 1);
      }
      for (const [i, w] of washes.entries()) {
        w.mat.color.copy(i === 1 ? colB : colA);
        w.mat.opacity = 0.2 + 0.25 * e * pulse;
      }

      // Lasers: a fan on every chorus and through a solo.
      const lasersOn = !st.inBreak && (st.section === "chorus" || st.section === "solo" || soloing) && (st.beatInBar < 3.5 || soloing);
      laserMat.color.copy(st.chorusIndex % 2 ? colA : colB);
      for (const [i, l] of lasers.entries()) {
        l.visible = lasersOn;
        if (!lasersOn) continue;
        const f = i / (lasers.length - 1) - 0.5;
        const yaw = Math.PI + f * 1.6 + Math.sin(beats * Math.PI * 0.25) * 0.35;
        const pitch = 0.05 + 0.12 * Math.sin(beats * Math.PI * 0.5 + i * 0.4);
        l.lookAt(laserOrigin.x + Math.cos(yaw) * 40, laserOrigin.y + Math.sin(pitch) * 40, laserOrigin.z + Math.sin(yaw) * 40);
      }

      // Flames: on the downbeat of every fourth bar of a chorus, and every beat of your solo.
      const flameBar = st.section === "chorus" && st.barInSection % 4 === 0 && st.beatInBar < 1.2;
      const flameSolo = soloing && st.beatInBar % 1 < 0.45;
      const lastHit = st.section === "outro" && st.barInSection === st.sectionBars - 1 && st.beatInBar < 1.5;
      const flame = flameBar || flameSolo || lastHit;
      for (const col of jets) {
        for (const [k, s] of col.entries()) {
          s.visible = flame;
          if (flame) {
            const flick = 0.85 + Math.random() * 0.3;
            s.scale.setScalar((1.7 - k * 0.18) * flick);
            s.position.x = FX + 0.5 + (Math.random() - 0.5) * 0.15;
          }
        }
      }
      flameMat.color.setHex(k_color(beats));

      // Confetti on the final chord.
      if (lastHit && confettiBar !== st.bar) {
        confettiBar = st.bar;
        burst();
      }
      if (confettiT > 0) {
        confettiT -= dt;
        for (let i = 0; i < CONFETTI; i++) {
          const o = i * 3;
          confVel[o] *= 0.985;
          confVel[o + 2] *= 0.985;
          confVel[o + 1] = Math.max(confVel[o + 1] - 9.8 * dt * 0.35, -1.2);
          confPos[o] += confVel[o] * dt + Math.sin(i + confettiT * 3) * 0.01;
          confPos[o + 1] = Math.max(0.05, confPos[o + 1] + confVel[o + 1] * dt);
          confPos[o + 2] += confVel[o + 2] * dt;
        }
        (confGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        if (confettiT <= 0) confetti.visible = false;
      }

      // The screen, at about fifteen frames a second.
      const now = performance.now();
      if (now - lastScreen > 66 && d < 160) {
        lastScreen = now;
        drawScreen(st, beats, soloing);
      }

      // The band and the crowd.
      if (d < 140) {
        band.update(dt, beats, st, soloing);
        const watch = onStage(player) ? player : tmpTo.set(FX + 1.6, 1.5, FZ);
        crowd.update(dt, watch, !st.inBreak);
      }
    },
    dispose() {
      music.dispose();
      band.dispose();
      crowd.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Flame colour, warming and cooling a little with the beat. */
function k_color(beats: number) {
  return Math.sin(beats * 7.3) > 0 ? 0xff8a2a : 0xffb347;
}
