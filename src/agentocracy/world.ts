/**
 * Agentocracy: the engine.
 *
 * A cardboard Bainbridge Island at kid scale: kraft boxes with marker
 * outlines, chalk lines from every district to the plaza at Winslow, blue
 * paper for Eagle Harbor, a cardboard ferry that sails to a cardboard
 * Seattle and honks. Fifty cutout agents wander it. The horn opens a round;
 * a proposal is read at the plaza, three or four agents say their piece,
 * and you delegate, override or abstain. Twelve rounds, then the ending the
 * WHEEL meter has earned.
 *
 * The rules live in `village.ts` and know nothing about three. The map lives
 * in `layout.ts`. This file is the cardboard.
 */
import * as THREE from "three";
import {
  COW_SPOTS,
  DISTRICTS,
  FERRY,
  HARBOR,
  PLAZA,
  SEATTLE,
  SIGNS,
  district,
  islandOutline,
  onIsland,
} from "./layout";
import {
  ROUNDS,
  agentLine,
  createVillage,
  decide,
  endCard,
  idleLine,
  openRound,
  tokens,
  wheel,
  type Agent,
  type Choice,
  type EndCard,
  type OpenRound,
  type Personality,
  type RoundResult,
  type Village,
} from "./village";

export interface Speaker {
  name: string;
  personality: Personality;
  line: string;
  colour: string;
}

export interface AgentocracyState {
  /** Rounds completed, 0..12. */
  round: number;
  phase: "waiting" | "open" | "over";
  proposal: { title: string; thing: string; cost: number; pitch: string } | null;
  /** The lines that have been said so far this round, in order. */
  speakers: Speaker[];
  /** Everybody has spoken; it is your call. */
  decisionOpen: boolean;
  /** You pressed OVERRIDE and it is waiting on yes or no. */
  overrideMenu: boolean;
  /** Seconds before your agent takes the wheel because you did not. */
  timeLeft: number;
  treasury: number;
  tokens: number;
  wheel: number;
  delegated: number;
  overridden: number;
  abstained: number;
  constitution: string[];
  showConstitution: boolean;
  cows: number;
  note: string | null;
  /** Somebody talking to you. */
  bubble: { name: string; text: string; colour: string } | null;
  /** What E would do right now. */
  near: { kind: "agent" | "placard" | "sign"; label: string } | null;
  lastResult: RoundResult | null;
  end: EndCard | null;
  ferry: "winslow" | "to-seattle" | "seattle" | "to-winslow";
  /** The pitch is being read at the plaza and the lines are arriving. */
  deliberating: boolean;
}

export interface AgentocracyStick {
  x: number;
  y: number;
}

export interface AgentocracyWorld {
  readonly stick: AgentocracyStick;
  interact(): void;
  choose(choice: "delegate" | "override" | "abstain"): void;
  vote(yes: boolean): void;
  toggleConstitution(): void;
  restart(): void;
  dispose(): void;
}

export interface AgentocracyOptions {
  container: HTMLElement;
  onState: (s: AgentocracyState) => void;
  seed?: number;
}

// ---------------------------------------------------------------------------
// The palette. Kraft brown, marker black, chalk white, one blue.
// ---------------------------------------------------------------------------

const KRAFT = 0xc9a878;
const KRAFT_DARK = 0xa88a5c;
const MARKER = 0x1a1611;
const CHALK = 0xf6f1e4;
const WATER = 0x4d8fd8;
const PAPER = 0xe9dcc3;
const TOKEN = 0xf2c531;

const TOP = 0.8;
const OUTLINE = 0.14;
const DECISION_SECONDS = 25;
const LINE_GAP = 2.4;

// ---------------------------------------------------------------------------
// Canvas helpers: everything here is drawn with a marker.
// ---------------------------------------------------------------------------

const MARKER_FONT = "'Permanent Marker', 'Marker Felt', 'Comic Sans MS', 'Chalkboard SE', cursive";

function kraftTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#c9a878";
  ctx.fillRect(0, 0, 256, 256);
  // Corrugation: faint ridges, the way a flattened box looks from above.
  ctx.strokeStyle = "rgba(120, 90, 50, 0.16)";
  ctx.lineWidth = 2;
  for (let y = 4; y < 256; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  // Fibre speckle.
  for (let i = 0; i < 400; i++) {
    const x = (i * 97) % 256;
    const y = (i * 53) % 256;
    ctx.fillStyle = i % 3 === 0 ? "rgba(255,240,210,0.25)" : "rgba(90,60,30,0.14)";
    ctx.fillRect(x, y, 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function waterTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#4d8fd8";
  ctx.fillRect(0, 0, 256, 256);
  // Wave scribbles in a lighter blue, the way a kid draws the sea.
  ctx.strokeStyle = "rgba(220, 235, 255, 0.55)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let r = 0; r < 7; r++) {
    const y = 20 + r * 34;
    const x0 = (r * 41) % 60;
    ctx.beginPath();
    for (let x = x0; x < x0 + 70; x += 2) {
      const yy = y + Math.sin((x - x0) / 8) * 4;
      if (x === x0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let x = x0 + 130; x < x0 + 190; x += 2) {
      const yy = y + 12 + Math.sin((x - x0) / 8) * 4;
      if (x === x0 + 130) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function labelSprite(text: string, size = 3, colour = "#1a1611", bg = "rgba(246,241,228,0.92)"): THREE.Sprite {
  const c = document.createElement("canvas");
  const font = `bold 44px ${MARKER_FONT}`;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const w = Math.min(1024, Math.ceil(measure.measureText(text).width) + 40);
  c.width = w;
  c.height = 72;
  const ctx = c.getContext("2d")!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, 72);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, w - 6, 66);
  }
  ctx.fillStyle = colour;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, w / 2, 38);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true }));
  s.scale.set((w / 72) * size * 0.45, size * 0.45, 1);
  return s;
}

type CutoutKind = "agent" | "player" | "clipboard";

function cutoutTexture(kind: CutoutKind, name: string, personality: Personality | null, shirt: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 192;
  const ctx = c.getContext("2d")!;
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#1a1611";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const kraft = "#c9a878";
  // Legs.
  ctx.fillStyle = kraft;
  for (const x of [44, 70]) {
    ctx.beginPath();
    ctx.roundRect(x, 130, 16, 34, 4);
    ctx.fill();
    ctx.stroke();
  }
  // Body: a shirt.
  ctx.fillStyle = kind === "clipboard" ? "#f6f1e4" : shirt;
  ctx.beginPath();
  ctx.moveTo(40, 72);
  ctx.lineTo(88, 72);
  ctx.lineTo(98, 136);
  ctx.lineTo(30, 136);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Arms.
  ctx.fillStyle = kraft;
  ctx.beginPath();
  ctx.roundRect(20, 78, 14, 44, 6);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(94, 78, 14, 44, 6);
  ctx.fill();
  ctx.stroke();
  // Head.
  ctx.fillStyle = kraft;
  ctx.beginPath();
  ctx.arc(64, 42, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Face.
  ctx.fillStyle = "#1a1611";
  const eyes = (open: boolean) => {
    for (const x of [53, 75]) {
      ctx.beginPath();
      if (open) {
        ctx.arc(x, 38, 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(x - 5, 38);
        ctx.lineTo(x + 5, 38);
        ctx.stroke();
      }
    }
  };
  const smile = (r: number, up = true) => {
    ctx.beginPath();
    if (up) ctx.arc(64, 48, r, 0.15 * Math.PI, 0.85 * Math.PI);
    else ctx.arc(64, 60, r, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();
  };
  switch (personality) {
    case "kid":
      eyes(true);
      smile(11);
      break;
    case "grandparent":
      eyes(true);
      smile(8);
      for (const x of [53, 75]) {
        ctx.beginPath();
        ctx.arc(x, 38, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(62, 38);
      ctx.lineTo(66, 38);
      ctx.stroke();
      break;
    case "vc":
      ctx.fillRect(44, 32, 18, 10);
      ctx.fillRect(66, 32, 18, 10);
      smile(7);
      // A tie.
      ctx.fillStyle = "#1a1611";
      ctx.beginPath();
      ctx.moveTo(60, 74);
      ctx.lineTo(68, 74);
      ctx.lineTo(66, 110);
      ctx.lineTo(62, 110);
      ctx.closePath();
      ctx.fill();
      break;
    case "safety":
      eyes(true);
      smile(6);
      ctx.fillStyle = "#f2c531";
      ctx.beginPath();
      ctx.arc(64, 26, 24, Math.PI, 0);
      ctx.fill();
      ctx.stroke();
      break;
    case "meditator":
      eyes(false);
      smile(7);
      break;
    case "contrarian":
      eyes(true);
      ctx.beginPath();
      ctx.moveTo(70, 26);
      ctx.lineTo(82, 30);
      ctx.stroke();
      smile(7, false);
      break;
    case "artist":
      eyes(true);
      smile(8);
      ctx.fillStyle = "#1a1611";
      ctx.beginPath();
      ctx.ellipse(56, 18, 26, 9, -0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "builder":
      eyes(true);
      smile(8);
      ctx.fillStyle = "#e6a817";
      ctx.fillRect(40, 12, 48, 8);
      ctx.strokeRect(40, 12, 48, 8);
      break;
    case "sailor":
      eyes(true);
      smile(7);
      ctx.fillStyle = "#3b7dd8";
      ctx.beginPath();
      ctx.arc(64, 22, 22, Math.PI, 0);
      ctx.fill();
      ctx.stroke();
      ctx.fillRect(40, 20, 48, 6);
      break;
    case "yesand":
      eyes(true);
      ctx.fillStyle = "#1a1611";
      ctx.beginPath();
      ctx.ellipse(64, 54, 10, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "frugal":
      eyes(true);
      ctx.beginPath();
      ctx.moveTo(56, 54);
      ctx.lineTo(72, 54);
      ctx.stroke();
      break;
    default:
      eyes(true);
      smile(9);
  }
  if (kind === "clipboard") {
    ctx.fillStyle = "#8a6a40";
    ctx.fillRect(84, 96, 26, 34);
    ctx.strokeRect(84, 96, 26, 34);
    ctx.fillStyle = "#f6f1e4";
    ctx.fillRect(88, 102, 18, 26);
    ctx.fillStyle = "#1a1611";
    for (let i = 0; i < 4; i++) ctx.fillRect(90, 106 + i * 5, 14, 2);
  }
  // Name tag.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(22, 160, 84, 28);
  ctx.strokeStyle = kind === "player" ? "#e04b4b" : "#1a1611";
  ctx.lineWidth = 3;
  ctx.strokeRect(22, 160, 84, 28);
  ctx.fillStyle = kind === "player" ? "#e04b4b" : "#1a1611";
  ctx.font = `bold ${name.length > 7 ? 15 : 18}px ${MARKER_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 64, 175);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function dogTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#1a1611";
  ctx.lineJoin = "round";
  ctx.fillStyle = "#c9a878";
  ctx.beginPath();
  ctx.ellipse(70, 56, 44, 24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(122, 40, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Ear, eye, nose, tail.
  ctx.beginPath();
  ctx.ellipse(106, 30, 8, 16, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1a1611";
  ctx.beginPath();
  ctx.arc(128, 36, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(142, 44, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(28, 48);
  ctx.quadraticCurveTo(10, 30, 18, 14);
  ctx.stroke();
  // Grey muzzle: she is older now.
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.arc(136, 46, 8, 0, Math.PI * 2);
  ctx.fill();
  // Name tag.
  ctx.fillStyle = "#fff";
  ctx.fillRect(48, 66, 50, 18);
  ctx.strokeStyle = "#1a1611";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 66, 50, 18);
  ctx.fillStyle = "#1a1611";
  ctx.font = `bold 13px ${MARKER_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SKIPPER", 73, 75);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function catTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#1a1611";
  ctx.lineJoin = "round";
  ctx.fillStyle = "#5c5c5c";
  ctx.beginPath();
  ctx.ellipse(48, 62, 26, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(48, 34, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(34, 24);
  ctx.lineTo(36, 8);
  ctx.lineTo(46, 20);
  ctx.moveTo(62, 24);
  ctx.lineTo(60, 8);
  ctx.lineTo(50, 20);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f2c531";
  for (const x of [41, 55]) {
    ctx.beginPath();
    ctx.ellipse(x, 34, 3, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(70, 70);
  ctx.quadraticCurveTo(92, 60, 84, 40);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cardTexture(lines: string[], found = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 160;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = found ? "#dff0d0" : "#f6f1e4";
  ctx.fillRect(0, 0, 256, 160);
  ctx.strokeStyle = "#1a1611";
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, 248, 152);
  ctx.fillStyle = "#1a1611";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.font = `bold ${i === 0 ? 30 : 20}px ${MARKER_FONT}`;
    ctx.fillText(l, 128, 44 + i * 36);
  });
  if (found) {
    ctx.strokeStyle = "#2e8b57";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(190, 110);
    ctx.lineTo(210, 132);
    ctx.lineTo(244, 84);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Obstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface Walker {
  agent: Agent;
  group: THREE.Group;
  plane: THREE.Mesh;
  x: number;
  z: number;
  tx: number;
  tz: number;
  pause: number;
  heading: number;
  /** Called to the plaza for this round. */
  summoned: { x: number; z: number } | null;
  bob: number;
}

export function createAgentocracy(options: AgentocracyOptions): AgentocracyWorld {
  const { container, onState } = options;
  const shotMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.setClearColor(PAPER, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(PAPER, 140, 420);
  const camera = new THREE.PerspectiveCamera(55, (container.clientWidth || 1) / (container.clientHeight || 1), 0.2, 800);

  scene.add(new THREE.HemisphereLight(0xfff6e6, 0x9a7a4a, 1.15));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.1);
  sun.position.set(-80, 140, 60);
  scene.add(sun);

  // ---- Shared materials and geometry ------------------------------------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const kraftTex = kraftTexture();
  const kraftMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: kraftTex });
  const kraftPlain = new THREE.MeshLambertMaterial({ color: KRAFT });
  const kraftSide = new THREE.MeshLambertMaterial({ color: KRAFT_DARK });
  const markerMat = new THREE.MeshBasicMaterial({ color: MARKER, side: THREE.BackSide });
  const chalkMat = new THREE.MeshBasicMaterial({ color: CHALK, transparent: true, opacity: 0.9 });
  const tokenMat = new THREE.MeshLambertMaterial({ color: TOKEN });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf6f1e4 });
  const obstacles: Obstacle[] = [];
  const disposables: { dispose(): void }[] = [unitBox, kraftTex, kraftMat, kraftPlain, kraftSide, markerMat, chalkMat, tokenMat, whiteMat];

  /** A cardboard box with a marker outline, base at y = 0 of its group. */
  const box = (w: number, h: number, d: number, mat: THREE.Material = kraftMat): THREE.Group => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(w, h, d);
    m.position.y = h / 2;
    const o = new THREE.Mesh(unitBox, markerMat);
    o.scale.set(w + OUTLINE, h + OUTLINE, d + OUTLINE);
    o.position.y = h / 2;
    g.add(m, o);
    return g;
  };

  const place = (g: THREE.Object3D, x: number, z: number, y = TOP, ry = 0): THREE.Object3D => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    scene.add(g);
    return g;
  };

  const block = (x: number, z: number, w: number, d: number) => {
    obstacles.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  };

  const building = (x: number, z: number, w: number, h: number, d: number, label?: string, mat?: THREE.Material, ry = 0): THREE.Group => {
    const g = box(w, h, d, mat);
    place(g, x, z, TOP, ry);
    block(x, z, Math.max(w, d) * (ry ? 1 : 1) + 0.6, Math.max(w, d) * (ry ? 1 : 1) + 0.6);
    if (label) {
      const s = labelSprite(label, 3.2);
      s.position.set(x, TOP + h + 2.2, z);
      scene.add(s);
    }
    return g;
  };

  // ---- The sea, the island, and Seattle ---------------------------------
  const waterTex = waterTexture();
  waterTex.repeat.set(40, 40);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshLambertMaterial({ color: 0xffffff, map: waterTex }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = 0.02;
  scene.add(sea);
  disposables.push(sea.geometry, sea.material as THREE.Material, waterTex);

  const islandShape = new THREE.Shape();
  islandOutline().forEach((p, i) => (i === 0 ? islandShape.moveTo(p.x, -p.z) : islandShape.lineTo(p.x, -p.z)));
  islandShape.closePath();
  const islandGeo = new THREE.ExtrudeGeometry(islandShape, { depth: TOP, bevelEnabled: false });
  const kraftTop = kraftMat.clone();
  kraftTop.map = kraftTex.clone();
  kraftTop.map.repeat.set(1 / 6, 1 / 6);
  kraftTop.map.needsUpdate = true;
  const island = new THREE.Mesh(islandGeo, [kraftTop, kraftSide]);
  island.rotation.x = -Math.PI / 2;
  scene.add(island);
  disposables.push(islandGeo, kraftTop, kraftTop.map);
  // An outline around the island's edge, in marker.
  const edgePts = islandOutline().map((p) => new THREE.Vector3(p.x, TOP + 0.03, p.z));
  edgePts.push(edgePts[0].clone());
  const edgeGeo = new THREE.BufferGeometry().setFromPoints(edgePts);
  const edgeMat = new THREE.LineBasicMaterial({ color: MARKER });
  scene.add(new THREE.Line(edgeGeo, edgeMat));
  disposables.push(edgeGeo, edgeMat);

  // Seattle: a cardboard slab across the sound with a skyline on it.
  const seattleSlab = box(44, TOP, 80, kraftMat);
  place(seattleSlab, SEATTLE.x, SEATTLE.z, 0);
  const skyline = [
    [-14, -26, 6, 14], [-6, -20, 5, 22], [4, -18, 7, 12], [12, -24, 5, 18], [-10, -4, 8, 26], [2, -2, 6, 30],
    [12, 2, 5, 16], [-14, 10, 6, 10], [-4, 14, 7, 20], [6, 18, 6, 24], [14, 22, 5, 12], [-10, 28, 8, 14],
  ];
  for (const [dx, dz, w, h] of skyline) {
    const b = box(w, h, w, kraftMat);
    place(b, SEATTLE.x + dx, SEATTLE.z + dz);
  }
  // The Space Needle: a stalk with a disc.
  const needle = new THREE.Group();
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.6, 30, 8), kraftPlain);
  stalk.position.y = 15;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(6, 4, 3, 12), kraftPlain);
  disc.position.y = 30;
  const discO = new THREE.Mesh(new THREE.CylinderGeometry(6.15, 4.15, 3.2, 12), markerMat);
  discO.position.y = 30;
  needle.add(stalk, disc, discO);
  place(needle, SEATTLE.x - 16, SEATTLE.z - 36);
  disposables.push(stalk.geometry, disc.geometry, discO.geometry);
  const seattleLabel = labelSprite("SEATTLE (also cardboard)", 6);
  seattleLabel.position.set(SEATTLE.x, TOP + 40, SEATTLE.z);
  scene.add(seattleLabel);

  // ---- Chalk: a line from the plaza to every district, and outlines ------
  const chalkLine = (ax: number, az: number, bx: number, bz: number, width = 0.5) => {
    const n = 4;
    let px = ax;
    let pz = az;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const wob = i === n ? 0 : (Math.sin(i * 3.7 + ax) * 1.4);
      const nx = ax + (bx - ax) * t + wob * ((bz - az) / Math.hypot(bx - ax, bz - az));
      const nz = az + (bz - az) * t - wob * ((bx - ax) / Math.hypot(bx - ax, bz - az));
      const len = Math.hypot(nx - px, nz - pz);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, width), chalkMat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = -Math.atan2(nz - pz, nx - px);
      m.position.set((px + nx) / 2, TOP + 0.03, (pz + nz) / 2);
      scene.add(m);
      disposables.push(m.geometry);
      px = nx;
      pz = nz;
    }
  };
  const chalkRing = (x: number, z: number, r: number) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.3, r, 40), chalkMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, TOP + 0.03, z);
    scene.add(m);
    disposables.push(m.geometry);
  };
  for (const d of DISTRICTS) {
    if (d.chalk) chalkLine(PLAZA.x, PLAZA.z, d.x, d.z);
    chalkRing(d.x, d.z, d.r + 1.5);
    const s = labelSprite(d.name, 2.6, "#f6f1e4", "rgba(26,22,17,0.85)");
    s.position.set(d.x, TOP + 0.6, d.z + d.r + 2.2);
    scene.add(s);
  }
  chalkRing(PLAZA.x, PLAZA.z, 11);

  // ---- The plaza at Winslow --------------------------------------------
  const podium = box(3, 0.8, 3);
  place(podium, 0, 0);
  block(0, 0, 3.6, 3.6);
  const podiumSign = labelSprite("AGENTOCRACY", 3.6);
  podiumSign.position.set(0, TOP + 3.2, 0);
  scene.add(podiumSign);
  // The treasury: an open box of yellow bottle caps.
  const chest = box(2.4, 1, 1.6);
  place(chest, 4, 3);
  block(4, 3, 3, 2.2);
  const capGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.1, 10);
  disposables.push(capGeo);
  const caps = new THREE.InstancedMesh(capGeo, tokenMat, 60);
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < 60; i++) {
    mtx.makeTranslation(4 + ((i % 6) - 2.5) * 0.36, TOP + 1.05 + Math.floor(i / 24) * 0.1, 3 + ((Math.floor(i / 6) % 4) - 1.5) * 0.36);
    caps.setMatrixAt(i, mtx);
  }
  scene.add(caps);
  const chestLabel = labelSprite("TREASURY", 2);
  chestLabel.position.set(4, TOP + 2.4, 3);
  scene.add(chestLabel);
  // Benches for the grandparents.
  for (const [bx, bz] of [[-6, -4], [6, -5], [-3, 6]]) {
    const b = box(2.4, 0.5, 0.7);
    place(b, bx, bz);
  }

  // ---- The dock, the sailboat, the ferry ----------------------------------
  const dock = district("dock");
  const pier = box(10, 0.4, 2.2, kraftMat);
  place(pier, HARBOR.x0 + 4, dock.z, TOP - 0.2);
  // The sailboat, tied up, with the paddle leaning on it.
  const boat = new THREE.Group();
  const hull = box(5.5, 1.1, 1.8, whiteMat);
  hull.position.y = -0.3;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 6), kraftPlain);
  mast.position.set(0.5, 3.2, 0);
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0);
  sailShape.lineTo(0, 5.5);
  sailShape.lineTo(-3, 0.6);
  sailShape.closePath();
  const sailGeo = new THREE.ShapeGeometry(sailShape);
  const sail = new THREE.Mesh(sailGeo, new THREE.MeshLambertMaterial({ color: 0xf6f1e4, side: THREE.DoubleSide }));
  sail.position.set(0.5, 0.9, 0);
  const paddle = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), kraftPlain);
  const blade = box(0.35, 0.7, 0.06, kraftMat);
  blade.position.y = 1.2;
  paddle.add(shaft, blade);
  paddle.position.set(-2.4, 0.9, 1.3);
  paddle.rotation.z = 0.35;
  boat.add(hull, mast, sail, paddle);
  place(boat, HARBOR.x0 + 6, -HARBOR.halfWidth + 3.5, TOP + 0.1, 0.2);
  disposables.push(mast.geometry, sailGeo, sail.material as THREE.Material, shaft.geometry);
  const boatLabel = labelSprite("DAD'S BOAT (12 years)", 2.2);
  boatLabel.position.set(HARBOR.x0 + 6, TOP + 7.2, -HARBOR.halfWidth + 3.5);
  scene.add(boatLabel);

  // The ferry: white with a green stripe, the way the real ones are.
  const ferry = new THREE.Group();
  const fHull = box(9, 1.6, 3.6, whiteMat);
  const stripe = box(9.1, 0.35, 3.7, new THREE.MeshLambertMaterial({ color: 0x2f8f5b }));
  stripe.position.y = 0.9;
  const cabin = box(6.5, 1.4, 3, whiteMat);
  cabin.position.y = 1.6;
  const bridge = box(3, 1, 2.4, whiteMat);
  bridge.position.y = 3;
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0x2f8f5b }));
  funnel.position.set(0, 4.5, 0);
  ferry.add(fHull, stripe, cabin, bridge, funnel);
  const ferryLabel = labelSprite("WSF (cardboard)", 2);
  ferryLabel.position.y = 6;
  ferry.add(ferryLabel);
  scene.add(ferry);
  disposables.push(funnel.geometry, funnel.material as THREE.Material, stripe.children[0] && ((stripe.children[0] as THREE.Mesh).material as THREE.Material));

  // ---- The kid districts --------------------------------------------------
  // Snack Bay: a counter, an awning, and yellow bottle caps.
  const snack = district("snack");
  building(snack.x, snack.z, 6, 1.3, 2.2, "SNACK BAY");
  const awning = box(6.6, 0.15, 3, new THREE.MeshLambertMaterial({ color: 0xe8d27a }));
  place(awning, snack.x, snack.z, TOP + 3.2, 0);
  for (const [px, pz] of [[-3, -1.4], [3, -1.4], [-3, 1.4], [3, 1.4]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6), kraftPlain);
    pole.position.set(snack.x + px, TOP + 1.6, snack.z + pz);
    scene.add(pole);
    disposables.push(pole.geometry);
  }
  const counterCaps = new THREE.InstancedMesh(capGeo, tokenMat, 10);
  for (let i = 0; i < 10; i++) {
    mtx.makeTranslation(snack.x - 2.2 + i * 0.5, TOP + 1.36, snack.z + (i % 2 ? 0.4 : -0.4));
    counterCaps.setMatrixAt(i, mtx);
  }
  scene.add(counterCaps);
  // The free-snack stand, across the road, undercutting.
  const free = district("freesnack");
  building(free.x, free.z, 3.2, 1.1, 1.6, "FREE SNACKS (no business model)");

  // The debate corner: a chalk square and three stools.
  const debate = district("debate");
  for (const [sx, sz] of [[-1.5, -1], [1.5, -1], [0, 1.6]]) {
    const st = box(0.8, 0.6, 0.8);
    place(st, debate.x + sx, debate.z + sz);
  }
  const debateChalk = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), chalkMat);
  debateChalk.rotation.x = -Math.PI / 2;
  debateChalk.position.set(debate.x, TOP + 0.025, debate.z);
  scene.add(debateChalk);
  disposables.push(debateChalk.geometry);
  const debateInner = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), kraftPlain);
  debateInner.rotation.x = -Math.PI / 2;
  debateInner.position.set(debate.x, TOP + 0.03, debate.z);
  scene.add(debateInner);
  disposables.push(debateInner.geometry);

  // Bainbridge High, with the detour signs.
  const school = district("school");
  building(school.x, school.z, 18, 4.5, 8, "BAINBRIDGE HIGH");
  const orange = new THREE.MeshLambertMaterial({ color: 0xf28c28 });
  disposables.push(orange);
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2, 6), kraftPlain);
    post.position.y = 1;
    const board = box(1.6, 0.9, 0.1, orange);
    board.position.y = 1.9;
    board.rotation.z = Math.PI / 4;
    g.add(post, board);
    place(g, school.x - 12 + i * 6, school.z - 7 - i * 1.5, TOP, -0.4);
    disposables.push(post.geometry);
  }
  const detourLabel = labelSprite("DETOUR: ALL FERRY TRAFFIC (3 months)", 2.4, "#1a1611", "rgba(242,140,40,0.95)");
  detourLabel.position.set(school.x - 6, TOP + 3.4, school.z - 9);
  scene.add(detourLabel);

  // The church, with one shoe on the roof.
  const church = district("church");
  building(church.x, church.z, 8, 5, 10, "THE CHURCH");
  const steeple = box(2, 8, 2);
  place(steeple, church.x - 2.5, church.z - 3.5);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3, 4), kraftPlain);
  spire.position.set(church.x - 2.5, TOP + 9.5, church.z - 3.5);
  spire.rotation.y = Math.PI / 4;
  scene.add(spire);
  disposables.push(spire.geometry);
  const shoe = box(0.6, 0.35, 1.2, new THREE.MeshLambertMaterial({ color: 0x3b3b3b }));
  place(shoe, church.x + 2.2, church.z + 2.5, TOP + 5, 0.6);
  disposables.push(((shoe.children[0] as THREE.Mesh).material as THREE.Material));
  const shoeLabel = labelSprite("the shoe (still there)", 1.6);
  shoeLabel.position.set(church.x + 2.2, TOP + 6.4, church.z + 2.5);
  scene.add(shoeLabel);

  // The water slide, with its safety system.
  const slide = district("slide");
  building(slide.x - 4, slide.z, 3, 6, 3, "WATER SLIDE");
  const ramp = box(2.2, 0.4, 11, new THREE.MeshLambertMaterial({ color: WATER }));
  ramp.rotation.x = 0.5;
  place(ramp, slide.x + 1, slide.z, TOP + 3.2);
  ramp.rotation.x = 0.5;
  disposables.push(((ramp.children[0] as THREE.Mesh).material as THREE.Material));
  const pool = new THREE.Mesh(new THREE.CircleGeometry(4, 24), new THREE.MeshLambertMaterial({ color: WATER }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(slide.x + 6, TOP + 0.04, slide.z);
  scene.add(pool);
  disposables.push(pool.geometry, pool.material as THREE.Material);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1, 8), orange);
  cone.position.set(slide.x + 9, TOP + 0.5, slide.z + 2);
  scene.add(cone);
  disposables.push(cone.geometry);
  const safetyLabel = labelSprite("SAFETY SYSTEM: a person with a whistle", 2, "#1a1611", "rgba(242,197,49,0.95)");
  safetyLabel.position.set(slide.x + 8, TOP + 2.6, slide.z + 3);
  scene.add(safetyLabel);

  // The sports field: green paper, chalk lines, two goals.
  const field = district("field");
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(22, 14), new THREE.MeshLambertMaterial({ color: 0x74a85c }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(field.x, TOP + 0.02, field.z);
  scene.add(grass);
  disposables.push(grass.geometry, grass.material as THREE.Material);
  chalkLine(field.x - 11, field.z - 7, field.x + 11, field.z - 7, 0.35);
  chalkLine(field.x - 11, field.z + 7, field.x + 11, field.z + 7, 0.35);
  chalkLine(field.x, field.z - 7, field.x, field.z + 7, 0.35);
  chalkRing(field.x, field.z, 3);
  for (const gx of [field.x - 11, field.x + 11]) {
    for (const gz of [field.z - 2, field.z + 2]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 6), whiteMat);
      post.position.set(gx, TOP + 0.9, gz);
      scene.add(post);
      disposables.push(post.geometry);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 6), whiteMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(gx, TOP + 1.8, field.z);
    scene.add(bar);
    disposables.push(bar.geometry);
  }
  const fieldLabel = labelSprite("SOCCER (varsity, allegedly)", 2.2);
  fieldLabel.position.set(field.x, TOP + 3.5, field.z);
  scene.add(fieldLabel);

  // Fashion and craft: a tent and paper scraps.
  const craft = district("craft");
  building(craft.x, craft.z, 6, 2.5, 6, "FASHION & CRAFT");
  const tent = new THREE.Mesh(new THREE.ConeGeometry(4.6, 3, 4), new THREE.MeshLambertMaterial({ color: 0xd84b8e }));
  tent.position.set(craft.x, TOP + 4, craft.z);
  tent.rotation.y = Math.PI / 4;
  scene.add(tent);
  disposables.push(tent.geometry, tent.material as THREE.Material);
  const scraps = ["#e04b4b", "#3b7dd8", "#e6a817", "#3aa35b", "#8e4bd8", "#2fb3b3"];
  scraps.forEach((col, i) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), new THREE.MeshLambertMaterial({ color: col }));
    s.rotation.x = -Math.PI / 2;
    s.rotation.z = i * 0.9;
    s.position.set(craft.x - 5 + (i % 3) * 3.5, TOP + 0.03, craft.z + 5 + Math.floor(i / 3) * 2);
    scene.add(s);
    disposables.push(s.geometry, s.material as THREE.Material);
  });

  // The Dream Tree: a trunk, a flat green paper canopy, notes hanging off it.
  const tree = district("tree");
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, 9, 8), kraftPlain);
  trunk.position.set(tree.x, TOP + 4.5, tree.z);
  scene.add(trunk);
  block(tree.x, tree.z, 3, 3);
  const trunkO = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.4, 9.1, 8), markerMat);
  trunkO.position.copy(trunk.position);
  scene.add(trunkO);
  disposables.push(trunk.geometry, trunkO.geometry);
  const canopyMat = new THREE.MeshLambertMaterial({ color: 0x5c9e4a });
  disposables.push(canopyMat);
  for (const [dx, dy, dz, r] of [[0, 10, 0, 5], [-3.5, 8.5, 1, 3.4], [3.5, 8.8, -1, 3.2], [0, 8, 3.5, 3]]) {
    const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 7), canopyMat);
    blob.scale.y = 0.55;
    blob.position.set(tree.x + dx, TOP + dy, tree.z + dz);
    scene.add(blob);
    const bo = new THREE.Mesh(new THREE.SphereGeometry(r + 0.12, 10, 7), markerMat);
    bo.scale.y = 0.55;
    bo.position.copy(blob.position);
    scene.add(bo);
    disposables.push(blob.geometry, bo.geometry);
  }
  for (let i = 0; i < 8; i++) {
    const note = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), new THREE.MeshLambertMaterial({ color: 0xf6f1e4, side: THREE.DoubleSide }));
    const a = (i / 8) * Math.PI * 2;
    note.position.set(tree.x + Math.cos(a) * 4.5, TOP + 6.8 - (i % 3) * 0.5, tree.z + Math.sin(a) * 4.5);
    note.rotation.y = -a;
    scene.add(note);
    disposables.push(note.geometry, note.material as THREE.Material);
  }
  const treeLabel = labelSprite("DREAM TREE (for nourishment)", 2.6);
  treeLabel.position.set(tree.x, TOP + 14.5, tree.z);
  scene.add(treeLabel);

  // Ninja HQ: dark, roofless, spiritual.
  const ninja = district("ninja");
  const ninjaMat = new THREE.MeshLambertMaterial({ color: 0x3a3632 });
  disposables.push(ninjaMat);
  building(ninja.x, ninja.z, 7, 5, 7, "NINJA HQ (spiritual centre, no roof)", ninjaMat);

  // Jerry's Plaza, with a snail on top.
  const jerry = district("jerry");
  building(jerry.x, jerry.z, 9, 1, 9, "JERRY'S PLAZA");
  const snail = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 10), new THREE.MeshLambertMaterial({ color: 0x9a6a3a }));
  shell.position.set(-0.4, 1.5, 0);
  const shellO = new THREE.Mesh(new THREE.SphereGeometry(1.62, 12, 10), markerMat);
  shellO.position.copy(shell.position);
  const snailBody = box(4, 0.8, 1.2, new THREE.MeshLambertMaterial({ color: 0xd9c08a }));
  snailBody.position.x = 0.6;
  snail.add(shell, shellO, snailBody);
  for (const dz of [-0.35, 0.35]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 5), kraftPlain);
    stalk.position.set(2.4, 1.3, dz);
    stalk.rotation.z = -0.3;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 6), markerMat);
    eye.position.set(2.6, 1.9, dz);
    snail.add(stalk, eye);
    disposables.push(stalk.geometry, eye.geometry);
  }
  place(snail, jerry.x, jerry.z, TOP + 1, 0.4);
  disposables.push(shell.geometry, shell.material as THREE.Material, shellO.geometry, ((snailBody.children[0] as THREE.Mesh).material as THREE.Material));
  const snailLabel = labelSprite("the snail (an accident)", 1.8);
  snailLabel.position.set(jerry.x, TOP + 4.6, jerry.z);
  scene.add(snailLabel);

  // The zip line: two poles, one string, one rider.
  const zip = district("zip");
  const zipA = new THREE.Vector3(zip.x - 6, TOP + 8, zip.z - 6);
  const zipB = new THREE.Vector3(zip.x + 8, TOP + 3, zip.z + 8);
  for (const [p, h] of [[zipA, 8], [zipB, 3]] as [THREE.Vector3, number][]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, h, 8), kraftPlain);
    pole.position.set(p.x, TOP + h / 2, p.z);
    scene.add(pole);
    disposables.push(pole.geometry);
    block(p.x, p.z, 1, 1);
  }
  const zipGeo = new THREE.BufferGeometry().setFromPoints([zipA, zipB]);
  scene.add(new THREE.Line(zipGeo, edgeMat));
  disposables.push(zipGeo);
  const rider = box(0.7, 1.4, 0.4, new THREE.MeshLambertMaterial({ color: 0x3b7dd8 }));
  scene.add(rider);
  disposables.push(((rider.children[0] as THREE.Mesh).material as THREE.Material));
  const zipLabel = labelSprite("ZIP LINE (the queue is longer)", 2.4);
  zipLabel.position.set(zip.x, TOP + 11, zip.z);
  scene.add(zipLabel);

  // The Salesforce Tower: eleven boxes and one act of faith.
  const tower = district("tower");
  building(tower.x, tower.z, 5.5, 24, 5.5, "SALESFORCE TOWER");
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.9, 2.2, 12), kraftPlain);
  cap.position.set(tower.x, TOP + 25.1, tower.z);
  scene.add(cap);
  const capO = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 3.05, 2.35, 12), markerMat);
  capO.position.copy(cap.position);
  scene.add(capO);
  disposables.push(cap.geometry, capO.geometry);

  // The pop-up museum.
  const museum = district("museum");
  building(museum.x, museum.z, 9, 4, 6, "POP-UP MUSEUM: 20 INVISIBLE COWS");

  // ---- Cow placards, signs ------------------------------------------------
  const placardGeo = new THREE.PlaneGeometry(1.4, 0.9);
  const stickGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.4, 5);
  const cowTex = cardTexture(["INVISIBLE COW", "(press E)", "you cannot see her"]);
  const cowFoundTex = cardTexture(["INVISIBLE COW", "FOUND", "still invisible"], true);
  const cowMat = new THREE.MeshBasicMaterial({ map: cowTex, side: THREE.DoubleSide });
  const cowFoundMat = new THREE.MeshBasicMaterial({ map: cowFoundTex, side: THREE.DoubleSide });
  disposables.push(placardGeo, stickGeo, cowTex, cowFoundTex, cowMat, cowFoundMat);
  const placards = COW_SPOTS.map((c, i) => {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(stickGeo, kraftPlain);
    stick.position.y = 0.7;
    const card = new THREE.Mesh(placardGeo, cowMat);
    card.position.y = 1.7;
    g.add(stick, card);
    place(g, c.x, c.z, TOP, (i * 1.3) % (Math.PI * 2));
    return { x: c.x, z: c.z, card, found: false, placard: c.placard };
  });
  const signs = SIGNS.map((s, i) => {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(stickGeo, kraftPlain);
    stick.position.y = 0.7;
    stick.scale.y = 1.3;
    const tex = cardTexture([s.label, "(press E to read)"]);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    disposables.push(tex, mat);
    const card = new THREE.Mesh(placardGeo, mat);
    card.scale.setScalar(1.4);
    card.position.y = 2.2;
    g.add(stick, card);
    place(g, s.x, s.z, TOP, (i * 0.9) % (Math.PI * 2));
    return { x: s.x, z: s.z, label: s.label, text: s.text, card };
  });

  // ---- Cutouts: the player, fifty agents, Skipper, Sam ------------------
  const cutoutGeo = new THREE.PlaneGeometry(1.4, 2.1);
  const footGeo = new THREE.BoxGeometry(1, 0.12, 0.5);
  disposables.push(cutoutGeo, footGeo);
  const cutout = (tex: THREE.CanvasTexture): { group: THREE.Group; plane: THREE.Mesh } => {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    disposables.push(tex, mat);
    const plane = new THREE.Mesh(cutoutGeo, mat);
    plane.position.y = 1.15;
    const foot = new THREE.Mesh(footGeo, kraftPlain);
    foot.position.y = 0.06;
    const g = new THREE.Group();
    g.add(plane, foot);
    return { group: g, plane };
  };

  const player = cutout(cutoutTexture("player", "YOU", null, "#e04b4b"));
  scene.add(player.group);
  let px = -6;
  let pz = 8;
  let pMoving = false;

  // Seeded, so a run replays; in shot mode the seed is fixed so the card is stable.
  const seed = options.seed ?? (shotMode ? 3 : (Date.now() % 100000) + 1);
  let village: Village = createVillage(seed);

  const walkers: Walker[] = village.agents.map((a, i) => {
    const home = district(a.home);
    const c = cutout(cutoutTexture("agent", a.name, a.personality, a.colour));
    scene.add(c.group);
    const ang = (i * 2.4) % (Math.PI * 2);
    const w: Walker = {
      agent: a,
      group: c.group,
      plane: c.plane,
      x: home.x + Math.cos(ang) * home.r * 0.7,
      z: home.z + Math.sin(ang) * home.r * 0.7,
      tx: home.x,
      tz: home.z,
      pause: (i % 5) * 0.6,
      heading: 0,
      summoned: null,
      bob: i,
    };
    if (!onIsland(w.x, w.z)) {
      w.x = home.x;
      w.z = home.z;
    }
    c.group.position.set(w.x, TOP, w.z);
    return w;
  });

  // Skipper, in her cart, doing laps of the plaza.
  const skipper = new THREE.Group();
  const dogMat = new THREE.MeshBasicMaterial({ map: dogTexture(), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const dogGeo = new THREE.PlaneGeometry(2, 1.2);
  disposables.push(dogMat, dogMat.map!, dogGeo);
  const dog = new THREE.Mesh(dogGeo, dogMat);
  dog.position.y = 0.95;
  const cart = box(1.3, 0.12, 0.7);
  cart.position.set(-0.4, 0.28, 0);
  const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.1, 10);
  disposables.push(wheelGeo);
  const wheels: THREE.Mesh[] = [];
  for (const dz of [-0.42, 0.42]) {
    const wh = new THREE.Mesh(wheelGeo, markerMat.clone());
    (wh.material as THREE.MeshBasicMaterial).side = THREE.FrontSide;
    disposables.push(wh.material as THREE.Material);
    wh.rotation.x = Math.PI / 2;
    wh.position.set(-0.6, 0.28, dz);
    wheels.push(wh);
    skipper.add(wh);
  }
  skipper.add(dog, cart);
  scene.add(skipper);
  let skipperAngle = 0;

  // Sam the cat, near the museum, not helping.
  const catMat = new THREE.MeshBasicMaterial({ map: catTexture(), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const catGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(catMat, catMat.map!, catGeo);
  const cat = new THREE.Mesh(catGeo, catMat);
  cat.position.set(museum.x + 6, TOP + 0.5, museum.z + 2);
  scene.add(cat);
  const catLabel = labelSprite("Sam (not helping)", 1.4);
  catLabel.position.set(museum.x + 6, TOP + 1.6, museum.z + 2);
  scene.add(catLabel);

  // The AI safety people, who arrive at the end if you let go of the wheel.
  const clipboards: THREE.Group[] = [];

  // ---- Sound: the ferry horn ----------------------------------------------
  let audio: AudioContext | null = null;
  const ensureAudio = () => {
    if (audio || shotMode) return;
    try {
      audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      audio = null;
    }
  };
  const horn = () => {
    if (!audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.08);
    gain.gain.setValueAtTime(0.25, t0 + 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    gain.connect(audio.destination);
    for (const f of [110, 165, 220]) {
      const o = audio.createOscillator();
      o.type = f === 220 ? "triangle" : "sawtooth";
      o.frequency.value = f;
      o.connect(gain);
      o.start(t0);
      o.stop(t0 + 1.15);
    }
  };

  // ---- Game state ---------------------------------------------------------
  const stick: AgentocracyStick = { x: 0, y: 0 };
  let elapsed = 0;
  let current: OpenRound | null = null;
  let spoken = 0;
  let nextLineIn = 0;
  let decisionOpen = false;
  let overrideMenu = false;
  let timeLeft = 0;
  let lastResult: RoundResult | null = null;
  let resultUntil = 0;
  let end: EndCard | null = null;
  let note: string | null = null;
  let noteUntil = 0;
  let bubble: AgentocracyState["bubble"] = null;
  let bubbleUntil = 0;
  let showConstitution = false;
  let ferryPhase: AgentocracyState["ferry"] = "winslow";
  let ferryT = 0;
  const spokenLines: Speaker[] = [];

  const say = (text: string, seconds = 5) => {
    note = text;
    noteUntil = elapsed + seconds;
  };

  const plazaSpot = (i: number) => {
    const a = -0.6 + i * 0.8;
    return { x: PLAZA.x + Math.sin(a) * 5, z: PLAZA.z + Math.cos(a) * 5 + 1 };
  };

  const startRound = () => {
    if (village.phase !== "waiting" || current) return;
    current = openRound(village);
    spoken = 0;
    spokenLines.length = 0;
    nextLineIn = 2.2;
    decisionOpen = false;
    overrideMenu = false;
    timeLeft = DECISION_SECONDS;
    lastResult = null;
    for (const w of walkers) w.summoned = null;
    current.speakers.forEach((s, i) => {
      walkers[s.agentId].summoned = plazaSpot(i);
    });
    say(`Round ${current.index + 1} of ${ROUNDS}. The horn. A proposal at the plaza.`, 4);
  };

  const resolve = (choice: Choice, why?: string) => {
    if (!current || village.phase !== "open") return;
    const result = decide(village, choice);
    lastResult = result;
    resultUntil = elapsed + 9;
    current = null;
    decisionOpen = false;
    overrideMenu = false;
    for (const w of walkers) w.summoned = null;
    const verdict = result.passed ? (result.unfunded ? "passed, unfunded" : "passed") : "failed";
    say(`${why ? why + " " : ""}${result.proposal.title}: ${verdict}, ${result.yes} to ${result.no}.${result.reason ? " " + result.reason : ""}`, 8);
    if (village.round >= ROUNDS) {
      end = endCard(village);
      if (end.ending === "wheel") {
        for (let i = 0; i < 3; i++) {
          const c = cutout(cutoutTexture("clipboard", ["AI SAFETY", "CLIPBOARD", "OBSERVER"][i], "safety", "#f6f1e4"));
          c.group.position.set(PLAZA.x - 3 + i * 3, TOP, PLAZA.z - 7);
          scene.add(c.group);
          clipboards.push(c.group);
        }
      }
    }
  };

  const choose = (choice: "delegate" | "override" | "abstain") => {
    ensureAudio();
    if (!current || !decisionOpen || village.phase !== "open") return;
    if (choice === "override") {
      overrideMenu = true;
      return;
    }
    resolve(choice);
  };

  const vote = (yes: boolean) => {
    if (!current || !decisionOpen || !overrideMenu) return;
    resolve({ override: yes });
  };

  const cowsFound = () => placards.filter((p) => p.found).length;

  const nearest = (): { kind: "agent" | "placard" | "sign"; label: string; hit: Walker | (typeof placards)[number] | (typeof signs)[number] } | null => {
    let best: ReturnType<typeof nearest> = null;
    let bestD = 3.2;
    for (const w of walkers) {
      const d = Math.hypot(w.x - px, w.z - pz);
      if (d < bestD) {
        bestD = d;
        best = { kind: "agent", label: w.agent.name, hit: w };
      }
    }
    for (const p of placards) {
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < bestD) {
        bestD = d;
        best = { kind: "placard", label: p.found ? "a cow you found" : "an invisible cow", hit: p };
      }
    }
    for (const s of signs) {
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bestD) {
        bestD = d;
        best = { kind: "sign", label: s.label, hit: s };
      }
    }
    return best;
  };

  const interact = () => {
    ensureAudio();
    const n = nearest();
    if (!n) {
      say("Nobody here. Follow a chalk line.", 2.5);
      return;
    }
    if (n.kind === "agent") {
      const w = n.hit as Walker;
      const line = current
        ? agentLine(w.agent, current.proposal, current.stances[w.agent.id], village.rng)
        : idleLine(w.agent, village.rng);
      bubble = { name: w.agent.name, text: line, colour: w.agent.colour };
      bubbleUntil = elapsed + 6;
      return;
    }
    if (n.kind === "placard") {
      const p = n.hit as (typeof placards)[number];
      if (!p.found) {
        p.found = true;
        p.card.material = cowFoundMat;
        const n2 = cowsFound();
        bubble = { name: "Placard", text: p.placard, colour: "#8a6a40" };
        bubbleUntil = elapsed + 7;
        say(n2 >= 20 ? "All twenty invisible cows. You win a thing. Tell Mitra." : `Cow found. ${n2} of 20.`, 4);
      } else {
        bubble = { name: "Placard", text: p.placard, colour: "#8a6a40" };
        bubbleUntil = elapsed + 6;
      }
      return;
    }
    const s = n.hit as (typeof signs)[number];
    bubble = { name: s.label, text: s.text, colour: "#8a6a40" };
    bubbleUntil = elapsed + 8;
  };

  const reset = () => {
    village = createVillage(seed + village.history.length + 1);
    walkers.forEach((w, i) => {
      w.agent = village.agents[i];
      w.summoned = null;
    });
    for (const c of clipboards) scene.remove(c);
    clipboards.length = 0;
    current = null;
    spokenLines.length = 0;
    decisionOpen = false;
    overrideMenu = false;
    lastResult = null;
    end = null;
    for (const p of placards) {
      p.found = false;
      p.card.material = cowMat;
    }
    px = -6;
    pz = 8;
    ferryPhase = "winslow";
    ferryT = 0;
    say("Cardboard Bainbridge. Fifty agents, one treasury, twelve ferries. Walk the chalk lines. Press E to talk. The horn opens a round.", 7);
  };
  reset();

  // ---- Input --------------------------------------------------------------
  const keys = new Set<string>();
  let camYaw = Math.atan2(district("dock").x - px, district("dock").z - pz) + Math.PI;
  let camPitch = 0.5;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Tab") e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    ensureAudio();
    if (e.code === "KeyE" || e.code === "Enter") interact();
    if (e.code === "Digit1" || e.code === "Numpad1") choose("delegate");
    if (e.code === "Digit2" || e.code === "Numpad2") choose("override");
    if (e.code === "Digit3" || e.code === "Numpad3") choose("abstain");
    if (e.code === "KeyY") vote(true);
    if (e.code === "KeyN") vote(false);
    if (e.code === "Tab") showConstitution = !showConstitution;
    if (e.code === "Escape") {
      overrideMenu = false;
      showConstitution = false;
    }
    if (e.code === "KeyR") reset();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    ensureAudio();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    camYaw -= (e.clientX - lastX) * 0.006;
    camPitch = Math.max(0.15, Math.min(1.2, camPitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  // ---- Movement helpers ---------------------------------------------------
  const pushOut = (x: number, z: number, r: number): [number, number] => {
    for (const o of obstacles) {
      if (x + r < o.x0 || x - r > o.x1 || z + r < o.z0 || z - r > o.z1) continue;
      const dl = x + r - o.x0;
      const dr = o.x1 - (x - r);
      const dt = z + r - o.z0;
      const db = o.z1 - (z - r);
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) x = o.x0 - r;
      else if (m === dr) x = o.x1 + r;
      else if (m === dt) z = o.z0 - r;
      else z = o.z1 + r;
    }
    return [x, z];
  };

  const insideObstacle = (x: number, z: number) => obstacles.some((o) => x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1);

  const stepWalker = (w: Walker, dt: number) => {
    const goal = w.summoned ?? { x: w.tx, z: w.tz };
    const dx = goal.x - w.x;
    const dz = goal.z - w.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.4) {
      const sp = w.summoned ? 3.2 : 1.5;
      const step = Math.min(d, sp * dt);
      let nx = w.x + (dx / d) * step;
      let nz = w.z + (dz / d) * step;
      [nx, nz] = pushOut(nx, nz, 0.5);
      if (onIsland(nx, nz)) {
        w.x = nx;
        w.z = nz;
      } else {
        w.tx = district(w.agent.home).x;
        w.tz = district(w.agent.home).z;
      }
      w.heading = Math.atan2(dx, dz);
      w.group.position.y = TOP + Math.abs(Math.sin(elapsed * 8 + w.bob)) * 0.08;
    } else if (!w.summoned) {
      w.pause -= dt;
      if (w.pause <= 0) {
        const home = district(w.agent.home);
        const rng = village.rng;
        // Sometimes a walk to the plaza, mostly a shuffle around home.
        const toPlaza = rng.next() < 0.12;
        const cx = toPlaza ? PLAZA.x : home.x;
        const cz = toPlaza ? PLAZA.z : home.z;
        const r = toPlaza ? 9 : home.r;
        for (let k = 0; k < 6; k++) {
          const a = rng.next() * Math.PI * 2;
          const rr = Math.sqrt(rng.next()) * r;
          const tx = cx + Math.cos(a) * rr;
          const tz = cz + Math.sin(a) * rr;
          if (onIsland(tx, tz) && !insideObstacle(tx, tz)) {
            w.tx = tx;
            w.tz = tz;
            break;
          }
        }
        w.pause = 1.5 + rng.next() * 5;
      }
      w.group.position.y = TOP;
    }
    w.group.position.x = w.x;
    w.group.position.z = w.z;
    // A cutout always faces the camera, so the name tag reads and never mirrors.
    w.group.rotation.y = camYaw;
  };

  // ---- Loop ---------------------------------------------------------------
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;
  let firstFrame = true;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // ---- The player -----------------------------------------------------
    let ix = stick.x;
    let iz = stick.y;
    if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
    const mag = Math.hypot(ix, iz);
    pMoving = mag > 0.1 && !showConstitution && !end;
    if (pMoving) {
      ix /= Math.max(1, mag);
      iz /= Math.max(1, mag);
      // Relative to the camera: forward is away from the camera.
      const fx = -Math.sin(camYaw);
      const fz = -Math.cos(camYaw);
      const rx = Math.cos(camYaw);
      const rz = -Math.sin(camYaw);
      const vx = (fx * -iz + rx * ix) * 6.5;
      const vz = (fz * -iz + rz * ix) * 6.5;
      let nx = px + vx * dt;
      let nz = pz + vz * dt;
      [nx, nz] = pushOut(nx, nz, 0.6);
      if (onIsland(nx, pz)) px = nx;
      if (onIsland(px, nz)) pz = nz;
    }
    player.group.position.set(px, TOP + (pMoving ? Math.abs(Math.sin(elapsed * 9)) * 0.1 : 0), pz);
    player.group.rotation.y = camYaw;

    // ---- The ferry ------------------------------------------------------
    ferryT += dt;
    if (ferryPhase === "winslow" && ferryT >= FERRY.dwell) {
      ferryPhase = "to-seattle";
      ferryT = 0;
      horn();
      startRound();
    } else if (ferryPhase === "to-seattle" && ferryT >= FERRY.crossing) {
      ferryPhase = "seattle";
      ferryT = 0;
    } else if (ferryPhase === "seattle" && ferryT >= FERRY.dwell) {
      ferryPhase = "to-winslow";
      ferryT = 0;
      horn();
    } else if (ferryPhase === "to-winslow" && ferryT >= FERRY.crossing) {
      ferryPhase = "winslow";
      ferryT = 0;
    }
    {
      let t = 0;
      let dir = 1;
      if (ferryPhase === "to-seattle") t = ferryT / FERRY.crossing;
      else if (ferryPhase === "seattle") t = 1;
      else if (ferryPhase === "to-winslow") {
        t = 1 - ferryT / FERRY.crossing;
        dir = -1;
      }
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      ferry.position.set(FERRY.winslow.x + (FERRY.seattle.x - FERRY.winslow.x) * ease, 0.35 + Math.sin(elapsed * 1.8) * 0.08, FERRY.winslow.z);
      ferry.rotation.z = Math.sin(elapsed * 1.3) * 0.02;
      ferry.rotation.y = dir === 1 ? 0 : Math.PI;
    }
    boat.position.y = TOP + 0.1 + Math.sin(elapsed * 1.1) * 0.06;
    boat.rotation.z = Math.sin(elapsed * 0.9) * 0.03;

    // ---- Skipper does her laps, the zip line runs -------------------------
    skipperAngle += dt * 0.12;
    skipper.position.set(PLAZA.x + Math.cos(skipperAngle) * 13, TOP, PLAZA.z + Math.sin(skipperAngle) * 13);
    skipper.rotation.y = -skipperAngle;
    dog.rotation.y = camYaw - skipper.rotation.y;
    for (const wh of wheels) wh.rotation.y += dt * 4;
    {
      const zt = (elapsed * 0.18) % 1;
      const zz = zt < 0.8 ? zt / 0.8 : 1;
      rider.position.lerpVectors(zipA, zipB, zz);
      rider.position.y -= 1.5;
    }

    // ---- The agents ----------------------------------------------------------
    for (const w of walkers) stepWalker(w, dt);
    for (const c of clipboards) c.rotation.y = camYaw;
    cat.rotation.y = camYaw;

    // ---- The round --------------------------------------------------------
    if (current && village.phase === "open") {
      if (spoken < current.speakers.length) {
        nextLineIn -= dt;
        if (nextLineIn <= 0) {
          const s = current.speakers[spoken++];
          spokenLines.push({ name: s.name, personality: s.personality, line: s.line, colour: walkers[s.agentId].agent.colour });
          nextLineIn = LINE_GAP;
          if (spoken >= current.speakers.length) {
            decisionOpen = true;
            timeLeft = DECISION_SECONDS;
          }
        }
      } else if (decisionOpen && !shotMode) {
        timeLeft -= dt;
        if (timeLeft <= 0) {
          resolve("delegate", "You were off looking for cows, so your agent took the wheel.");
        }
      }
    }
    if (note && elapsed > noteUntil) note = null;
    if (bubble && elapsed > bubbleUntil) bubble = null;
    if (lastResult && elapsed > resultUntil) lastResult = null;

    // ---- Camera ---------------------------------------------------------
    const dist = 11;
    camGoal.set(
      px + Math.sin(camYaw) * Math.cos(camPitch) * dist,
      TOP + 1 + Math.sin(camPitch) * dist,
      pz + Math.cos(camYaw) * Math.cos(camPitch) * dist,
    );
    if (firstFrame) camPos.copy(camGoal);
    else camPos.lerp(camGoal, Math.min(1, dt * 6));
    camera.position.copy(camPos);
    look.set(px, TOP + 1.4, pz);
    camera.lookAt(look);
    firstFrame = false;

    renderer.render(scene, camera);

    // ---- Report -----------------------------------------------------------
    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      const n = nearest();
      onState({
        round: village.round,
        phase: village.phase,
        proposal: current
          ? { title: current.proposal.title, thing: current.proposal.thing, cost: current.proposal.cost, pitch: current.proposal.pitch }
          : null,
        speakers: [...spokenLines],
        decisionOpen: decisionOpen && village.phase === "open",
        overrideMenu,
        timeLeft: Math.max(0, timeLeft),
        treasury: village.treasury,
        tokens: tokens(village.treasury),
        wheel: wheel(village),
        delegated: village.delegated,
        overridden: village.overridden,
        abstained: village.abstained,
        constitution: [...village.constitution],
        showConstitution,
        cows: cowsFound(),
        note,
        bubble,
        near: n ? { kind: n.kind, label: n.label } : null,
        lastResult,
        end,
        ferry: ferryPhase,
        deliberating: !!current && !decisionOpen,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    stick,
    interact,
    choose,
    vote,
    toggleConstitution() {
      showConstitution = !showConstitution;
    },
    restart: reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      if (audio) {
        void audio.close().catch(() => {});
        audio = null;
      }
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          const tex = (m as THREE.MeshBasicMaterial).map;
          tex?.dispose();
          m.dispose();
        }
      });
      for (const d of disposables) d?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
