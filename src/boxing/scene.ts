/**
 * The drawing half of the boxing game: the opponent, your gloves, the sparks.
 *
 * It reads a `Bout` and a `BodyRead` and moves meshes toward where they should
 * be; it never changes the fight. In camera mode the canvas is transparent and
 * sits on top of the mirrored video, so the opponent is standing in your room
 * and your gloves are drawn on your own fists. Without a camera it builds a
 * ring around the opponent instead.
 *
 * Everybody here is built from primitives in code: no model files to fetch,
 * nothing to license, and each one reads at a glance on a phone propped up
 * two metres away.
 */
import * as THREE from "three";
import type { Bout, Opponent, Side } from "./fight";
import type { BodyRead, Hand } from "./pose";

const tmpV = new THREE.Vector3();
/** How far away the opponent stands. Close enough to fill a portrait phone. */
const OPP_Z = -1.95;

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...opts });
}

interface Rig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  gloves: Record<Side, THREE.Group>;
  gloveMats: Record<Side, THREE.MeshStandardMaterial>;
  pupils: THREE.Mesh[];
  mouth: THREE.Mesh;
  brows: THREE.Mesh[];
  stars: THREE.Group;
  /** Every material, so a hit can flash them all white. */
  mats: THREE.MeshStandardMaterial[];
  headY: number;
}

function glove(color: number, mats: THREE.MeshStandardMaterial[]): { g: THREE.Group; m: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.35, emissive: 0x000000 });
  mats.push(m);
  const fist = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 18), m);
  fist.scale.set(1, 0.92, 1.18);
  g.add(fist);
  const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), m);
  thumb.position.set(0.11, 0.06, 0.05);
  g.add(thumb);
  const cuffM = mat(0xffffff, { roughness: 0.6 });
  mats.push(cuffM);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.12, 18), cuffM);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = -0.2;
  g.add(cuff);
  return { g, m };
}

function face(o: Opponent, mats: THREE.MeshStandardMaterial[], scale: number): { g: THREE.Group; pupils: THREE.Mesh[]; mouth: THREE.Mesh; brows: THREE.Mesh[] } {
  const g = new THREE.Group();
  const white = mat(0xffffff, { roughness: 0.3 });
  const eyeM = mat(o.colors.eye, { roughness: 0.2, emissive: o.shape === "can" || o.shape === "rock" ? o.colors.eye : 0x000000, emissiveIntensity: 0.6 });
  const dark = mat(0x1a1420, { roughness: 0.4 });
  mats.push(white, eyeM, dark);
  const pupils: THREE.Mesh[] = [];
  const brows: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075 * scale, 16, 12), white);
    eye.scale.set(1, 1.15, 0.5);
    eye.position.set(s * 0.1 * scale, 0.04 * scale, 0);
    g.add(eye);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.04 * scale, 12, 10), eyeM);
    p.position.set(s * 0.1 * scale, 0.04 * scale, 0.035 * scale);
    p.userData.bx = p.position.x;
    g.add(p);
    pupils.push(p);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.11 * scale, 0.025 * scale, 0.02 * scale), dark);
    brow.position.set(s * 0.1 * scale, 0.15 * scale, 0.03 * scale);
    brow.rotation.z = s * -0.25;
    g.add(brow);
    brows.push(brow);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.06 * scale, 0.014 * scale, 8, 20, Math.PI), dark);
  mouth.rotation.z = Math.PI;
  mouth.position.set(0, -0.1 * scale, 0.02 * scale);
  g.add(mouth);
  return { g, pupils, mouth, brows };
}

export function buildOpponent(o: Opponent): Rig {
  const mats: THREE.MeshStandardMaterial[] = [];
  const root = new THREE.Group();
  const body = new THREE.Group();
  const head = new THREE.Group();
  root.add(body);
  const bodyM = mat(o.colors.body, o.shape === "can" ? { metalness: 0.75, roughness: 0.3 } : o.shape === "rock" ? { flatShading: true, roughness: 0.9 } : {});
  const trimM = mat(o.colors.trim, o.shape === "rock" ? { flatShading: true, roughness: 1 } : {});
  mats.push(bodyM, trimM);
  let headY = 1.65;
  let faceZ = 0.3;
  let faceScale = 1;

  if (o.shape === "can") {
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.36, 0.95, 32), bodyM);
    torso.position.y = 1.0;
    body.add(torso);
    for (const y of [0.62, 1.0, 1.38]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.385, 0.018, 8, 40), trimM);
      rib.rotation.x = Math.PI / 2;
      rib.position.y = y;
      body.add(rib);
    }
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.3, 32, 1, true, -0.9, 1.8), trimM);
    label.position.y = 1.0;
    body.add(label);
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.34, 28), bodyM);
    head.add(h);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8), trimM);
    ant.position.y = 0.28;
    head.add(ant);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), mat(o.colors.eye, { emissive: o.colors.eye, emissiveIntensity: 1 }));
    bulb.position.y = 0.4;
    head.add(bulb);
    headY = 1.72;
    faceZ = 0.24;
  } else if (o.shape === "bun") {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.58, 40, 30), bodyM);
    bun.scale.set(1, 0.85, 0.9);
    bun.position.y = 1.0;
    body.add(bun);
    // the pleats on top
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const pleat = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), bodyM);
      pleat.scale.set(0.5, 1.4, 0.5);
      pleat.position.set(Math.cos(a) * 0.15, 1.46, Math.sin(a) * 0.15);
      pleat.rotation.z = Math.cos(a) * 0.5;
      pleat.rotation.x = -Math.sin(a) * 0.5;
      body.add(pleat);
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 10, 40), trimM);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.7;
    body.add(band);
    const cheeks = mat(0xff9fb8, { roughness: 0.8 });
    mats.push(cheeks);
    for (const s of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), cheeks);
      c.scale.set(1, 0.6, 0.3);
      c.position.set(s * 0.26, -0.1, 0.02);
      head.add(c);
    }
    headY = 1.12;
    faceZ = 0.5;
    faceScale = 1.5;
  } else if (o.shape === "rock") {
    const torso = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6, 0), bodyM);
    torso.scale.set(1.05, 0.9, 0.8);
    torso.position.y = 1.0;
    body.add(torso);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), bodyM);
    h.scale.set(1.1, 0.9, 0.9);
    head.add(h);
    const moss = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), trimM);
    moss.scale.set(1.3, 0.45, 1.1);
    moss.position.y = 0.22;
    head.add(moss);
    for (const s of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), trimM);
      sh.scale.set(1.2, 0.5, 1);
      sh.position.set(s * 0.5, 1.42, 0);
      body.add(sh);
    }
    headY = 1.72;
    faceZ = 0.25;
    faceScale = 1.1;
  } else {
    const puffs: [number, number, number, number][] = [
      [0, 1.05, 0, 0.5], [-0.42, 0.95, -0.05, 0.36], [0.42, 0.95, -0.05, 0.36], [-0.25, 1.4, -0.1, 0.32],
      [0.25, 1.42, -0.1, 0.34], [0, 0.65, 0, 0.36], [0, 1.55, -0.15, 0.3],
    ];
    for (const [x, y, z, r] of puffs) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), bodyM);
      p.position.set(x, y, z);
      body.add(p);
    }
    const bolt = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.35, 3), mat(0xfff36b, { emissive: 0xffd400, emissiveIntensity: 1.2 }));
    bolt.position.set(0.05, 0.42, 0.25);
    bolt.rotation.set(0.2, 0, 2.9);
    body.add(bolt);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 10, 40), mat(0xffc94a, { metalness: 0.9, roughness: 0.25 }));
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.72;
    body.add(belt);
    headY = 1.08;
    faceZ = 0.45;
    faceScale = 1.5;
  }

  const f = face(o, mats, faceScale);
  f.g.position.z = faceZ;
  head.add(f.g);
  head.position.y = headY;
  body.add(head);

  const gl = glove(o.colors.glove, mats);
  const gr = glove(o.colors.glove, mats);
  root.add(gl.g, gr.g);

  // dizzy stars, shown when wide open
  const stars = new THREE.Group();
  const starM = new THREE.MeshBasicMaterial({ color: 0xffe066 });
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), starM);
    s.userData.a = (i / 4) * Math.PI * 2;
    stars.add(s);
  }
  stars.visible = false;
  root.add(stars);

  // stubby legs and feet
  const feetM = mat(0x222230);
  mats.push(feetM);
  const legTop = o.shape === "cloud" ? 0.4 : 0.62;
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, legTop - 0.1, 12), trimM);
    leg.position.set(s * 0.18, (legTop + 0.1) / 2, 0);
    root.add(leg);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), feetM);
    foot.scale.set(1, 0.6, 1.4);
    foot.position.set(s * 0.2, 0.1, 0.05);
    root.add(foot);
  }
  root.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = true; });

  return {
    root, body, head, gloves: { L: gl.g, R: gr.g }, gloveMats: { L: gl.m, R: gr.m },
    pupils: f.pupils, mouth: f.mouth, brows: f.brows, stars, mats, headY: headY,
  };
}

function ring(): THREE.Group {
  const g = new THREE.Group();
  const matC = document.createElement("canvas");
  matC.width = matC.height = 512;
  const c = matC.getContext("2d")!;
  c.fillStyle = "#1f4fa8";
  c.fillRect(0, 0, 512, 512);
  c.strokeStyle = "rgba(255,255,255,0.9)";
  c.lineWidth = 14;
  c.strokeRect(24, 24, 464, 464);
  c.fillStyle = "rgba(255,255,255,0.12)";
  c.font = "bold 120px system-ui, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("VIBE", 256, 256);
  const tex = new THREE.CanvasTexture(matC);
  tex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 7), [
    mat(0x14161f), mat(0x14161f), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }), mat(0x14161f), mat(0x101218), mat(0x101218),
  ]);
  floor.position.set(0, -0.2, -2.4);
  floor.receiveShadow = true;
  g.add(floor);
  const postM = mat(0xd8d8e0, { metalness: 0.8, roughness: 0.3 });
  const ropeCols = [0xe5484d, 0xffffff, 0x3b6bff];
  const corners: [number, number][] = [[-3.3, -5.7], [3.3, -5.7], [-3.3, 0.9], [3.3, 0.9]];
  for (const [x, z] of corners) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 12), postM);
    p.position.set(x, 0.8, z);
    g.add(p);
  }
  const rope = (a: [number, number], b: [number, number], y: number, col: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 8), mat(col, { roughness: 0.6 }));
    r.position.set((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2);
    r.rotation.z = Math.PI / 2;
    r.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    g.add(r);
  };
  [0.55, 0.95, 1.35].forEach((y, i) => {
    rope(corners[0], corners[1], y, ropeCols[i]);
    rope(corners[0], corners[2], y, ropeCols[i]);
    rope(corners[1], corners[3], y, ropeCols[i]);
  });
  // a crowd that is only ever a twinkle of camera flashes in the dark
  const flashGeo = new THREE.BufferGeometry();
  const pts: number[] = [];
  for (let i = 0; i < 400; i++) {
    const a = Math.PI * (0.15 + Math.random() * 0.7);
    const r = 9 + Math.random() * 6;
    pts.push(Math.cos(a) * r * (Math.random() < 0.5 ? -1 : 1) * 0.9, 0.6 + Math.random() * 4, -2.4 - Math.sin(a) * r);
  }
  flashGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const flashes = new THREE.Points(flashGeo, new THREE.PointsMaterial({ color: 0xfff2cc, size: 0.06, transparent: true, opacity: 0.6 }));
  flashes.name = "crowd";
  g.add(flashes);
  return g;
}

interface Spark { mesh: THREE.Mesh; v: THREE.Vector3; life: number }

export class BoxingScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
  private rig: Rig | null = null;
  private ringGroup: THREE.Group | null = null;
  private myGloves: Record<Hand, THREE.Group>;
  private punchT: Record<Hand, number> = { L: 9, R: 9 };
  private sparks: Spark[] = [];
  private flash = 0;
  private t = 0;
  private shake = 0;
  private sway = 0;
  private spot: THREE.SpotLight;

  constructor(private canvas: HTMLCanvasElement, private ar: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: ar, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !ar;
    if (ar) this.renderer.setClearColor(0x000000, 0);
    this.camera.position.set(0, 1.5, 0);
    this.camera.lookAt(0, 1.3, OPP_Z);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xfff4e8, 0x40384a, ar ? 1.5 : 0.9));
    const key = new THREE.DirectionalLight(0xffffff, ar ? 1.6 : 1.2);
    key.position.set(1.5, 4, 2);
    this.scene.add(key);
    this.spot = new THREE.SpotLight(0xfff1d6, ar ? 0 : 60, 14, 0.55, 0.5, 1.2);
    this.spot.position.set(0, 6.5, -1.2);
    this.spot.target.position.set(0, 0, -2.4);
    this.spot.castShadow = true;
    this.scene.add(this.spot, this.spot.target);

    if (!ar) {
      this.scene.background = new THREE.Color(0x07070d);
      this.scene.fog = new THREE.Fog(0x07070d, 7, 20);
      this.ringGroup = ring();
      this.scene.add(this.ringGroup);
    }

    const mk = (col: number) => {
      const g = new THREE.Group();
      const m = mat(col, { roughness: 0.35 });
      const fist = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 18), m);
      fist.scale.set(1, 0.9, 1.25);
      g.add(fist);
      const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), m);
      thumb.position.set(0, 0.045, -0.03);
      g.add(thumb);
      // a lace stripe across the back of the hand, which is the side you see
      const lace = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.12), mat(0xffffff, { roughness: 0.6 }));
      lace.position.set(0, 0.066, 0.01);
      g.add(lace);
      return g;
    };
    this.myGloves = { L: mk(0xffb020), R: mk(0xffb020) };
    this.camera.add(this.myGloves.L, this.myGloves.R);
  }

  setOpponent(o: Opponent): void {
    if (this.rig) {
      this.scene.remove(this.rig.root);
      this.rig.root.traverse((m) => { const mesh = m as THREE.Mesh; if (mesh.isMesh) mesh.geometry.dispose(); });
      this.rig.mats.forEach((m) => m.dispose());
    }
    this.rig = buildOpponent(o);
    this.rig.root.position.set(0, 0, OPP_Z);
    this.scene.add(this.rig.root);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    // keep about 46 degrees across in portrait, and the whole fighter, head
    // to feet, up and down in landscape
    const hfov = 46 * (Math.PI / 180);
    const vFromH = 2 * Math.atan(Math.tan(hfov / 2) / aspect) * (180 / Math.PI);
    this.camera.fov = Math.max(64, Math.min(85, vFromH));
    this.camera.updateProjectionMatrix();
  }

  /** A punch of yours landed (or not): send the glove out. */
  throwGlove(hand: Hand): void { this.punchT[hand] = 0; }

  burst(counter: boolean): void {
    if (!this.rig) return;
    const at = this.rig.head.getWorldPosition(tmpV).clone();
    at.z += 0.35;
    const n = counter ? 18 : 10;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(counter ? 0.05 : 0.035, 0), new THREE.MeshBasicMaterial({ color: counter ? 0xffe066 : 0xffffff, transparent: true }));
      m.position.copy(at);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() * 0.6).normalize().multiplyScalar(2 + Math.random() * 2.5);
      this.scene.add(m);
      this.sparks.push({ mesh: m, v, life: 0.45 });
    }
    this.flash = 1;
  }

  /** You got hit. */
  jolt(): void { this.shake = 1; }

  /**
   * Your fists, in mirrored screen space, from the camera. `null` puts the
   * gloves at rest in the bottom corners, which is where they live without a
   * body to sit on.
   */
  /** The splash wants the opponent alone. */
  showGloves = true;
  /** Lining up wants you alone, so you can see yourself. */
  showOpponent = true;

  private placeGloves(dt: number, body: BodyRead | null, guard: boolean): void {
    for (const h of ["L", "R"] as Hand[]) {
      const g = this.myGloves[h];
      if (!this.showGloves) { g.visible = false; continue; }
      const s = h === "L" ? -1 : 1;
      this.punchT[h] += dt;
      const p = this.punchT[h];
      const thrust = p < 0.09 ? p / 0.09 : p < 0.25 ? 1 - (p - 0.09) / 0.16 : 0;
      const target = new THREE.Vector3();
      const f = body?.fists[h];
      if (this.ar && body?.present && f?.seen) {
        // unproject the fist onto a plane 0.75 m in front of the lens
        const ndc = new THREE.Vector3(f.sx * 2 - 1, -(f.sy * 2 - 1), 0.5);
        ndc.unproject(this.camera);
        const dir = ndc.sub(this.camera.position).normalize();
        const local = this.camera.worldToLocal(this.camera.position.clone().add(dir.multiplyScalar(0.75)));
        target.copy(local);
        target.z -= thrust * 0.5;
        g.visible = true;
        // in the mirror your fist points at the lens and the cuff goes back toward you
        g.rotation.set(0.2, Math.PI + s * 0.2, -s * 0.15);
        g.scale.setScalar(0.85);
        g.position.lerp(target, 1 - Math.exp(-dt * 30));
        continue;
      } else {
        const rest = guard ? new THREE.Vector3(s * 0.08, -0.07, -0.4) : new THREE.Vector3(s * 0.15, -0.24, -0.58);
        const out = new THREE.Vector3(s * 0.04, -0.03, -1.0);
        target.copy(rest).lerp(out, thrust);
        g.visible = !this.ar || !body?.present;
      }
      g.scale.setScalar(1);
      g.position.lerp(target, 1 - Math.exp(-dt * 30));
      // knuckles forward and a little up, so you see the back of your glove
      g.rotation.set(0.25, s * 0.2, s * 0.15);
    }
  }

  frame(dt: number, bout: Bout | null, body: BodyRead | null, guard: boolean, cameraLean: number): void {
    this.t += dt;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);

    // You slip a punch and the world slides: the view sways with your lean.
    this.sway += (cameraLean - this.sway) * k(10);
    this.shake = Math.max(0, this.shake - dt * 3);
    const sh = this.shake * this.shake * 0.06;
    this.camera.position.set(
      (this.ar ? 0 : this.sway * 0.18) + (Math.random() - 0.5) * sh,
      1.5 + (Math.random() - 0.5) * sh,
      0,
    );
    this.camera.lookAt(this.ar ? 0 : this.sway * 0.05, 1.3, OPP_Z);

    this.placeGloves(dt, body, guard);

    const r = this.rig;
    if (r) r.root.visible = this.showOpponent;
    if (r && bout) {
      const o = bout.opp;
      const ph = o.phase;
      const sideX = (s: Side) => (s === "L" ? -1 : 1);
      const bob = Math.sin(this.t * 4.2) * 0.03;
      const weave = Math.sin(this.t * 1.7) * 0.08;

      // where each glove wants to be, local to the root
      const want: Record<Side, THREE.Vector3> = {
        L: new THREE.Vector3(-0.34, 1.35 + bob, 0.38),
        R: new THREE.Vector3(0.34, 1.35 - bob, 0.38),
      };
      let lean = 0, twist = 0, tiltX = 0, drop = 0, glow = 0;
      let headKnock = new THREE.Vector2(0, 0);
      let rate = 12;
      const u = Math.min(1, o.t / Math.max(0.01, o.len));

      switch (ph) {
        case "idle":
        case "intro":
          r.root.position.x = weave;
          break;
        case "guard":
          want.L.set(-0.13, r.headY + 0.02, 0.5);
          want.R.set(0.13, r.headY + 0.02, 0.5);
          tiltX = 0.12;
          break;
        case "windup": {
          const s = o.side;
          want[s].set(sideX(s) * 0.62, r.headY - 0.05, -0.2);
          lean = sideX(s) * 0.12 * u;
          twist = -sideX(s) * 0.35 * u;
          glow = 0.4 + 0.6 * Math.abs(Math.sin(this.t * 18)) * u;
          rate = 8;
          break;
        }
        case "strike": {
          const s = o.side;
          const reach = o.feinting ? 0.9 : 2.05;
          want[s].set(sideX(s) * 0.12, 1.48, reach);
          twist = sideX(s) * 0.35;
          lean = -sideX(s) * 0.05;
          glow = 1;
          rate = 40;
          break;
        }
        case "recover":
          rate = 6;
          break;
        case "open":
          want.L.set(-0.42, 0.85, 0.25);
          want.R.set(0.42, 0.85, 0.25);
          lean = Math.sin(this.t * 3) * 0.12;
          tiltX = -0.08;
          rate = 6;
          break;
        case "hurt":
          tiltX = -0.25;
          break;
        case "down":
          want.L.set(-0.6, 0.4, 0.1);
          want.R.set(0.6, 0.4, 0.1);
          drop = Math.min(1, bout.stageT / 0.8);
          rate = 5;
          break;
        case "win":
          want.L.set(-0.35, r.headY + 0.45 + Math.abs(Math.sin(this.t * 6)) * 0.12, 0.1);
          want.R.set(0.35, r.headY + 0.45 + Math.abs(Math.sin(this.t * 6 + 1)) * 0.12, 0.1);
          r.root.position.y = Math.abs(Math.sin(this.t * 6)) * 0.08;
          break;
      }

      // The last punch you landed snaps the head away from it and fades.
      const kn = o.knock;
      if (kn.t < 0.5) {
        const a = (1 - kn.t / 0.5) ** 2 * (0.6 + kn.power);
        if (kn.kind === "uppercut") headKnock = new THREE.Vector2(0, a * 0.5);
        else headKnock = new THREE.Vector2(sideX(kn.side) * a * (kn.kind === "hook" ? 0.6 : 0.35), a * 0.1);
      }

      for (const s of ["L", "R"] as Side[]) {
        r.gloves[s].position.lerp(want[s], k(rate));
        r.gloves[s].rotation.set(0, sideX(s) * -0.2, 0);
        const gm = r.gloveMats[s];
        const on = (ph === "windup" || ph === "strike") && o.side === s ? glow : 0;
        gm.emissive.setRGB(on * 1.4, on * 0.25, on * 0.05);
        r.gloves[s].scale.setScalar(1 + on * 0.18);
      }
      r.body.rotation.z += (-lean - headKnock.x * 0.3 - r.body.rotation.z) * k(10);
      r.body.rotation.y += (twist - r.body.rotation.y) * k(10);
      r.body.rotation.x += (tiltX - headKnock.y * 0.4 - r.body.rotation.x) * k(10);
      r.head.rotation.z = -headKnock.x;
      r.head.rotation.x = -headKnock.y;
      if (ph !== "win") r.root.position.y += (0 - r.root.position.y) * k(8);
      r.root.rotation.x += (-drop * 1.35 - r.root.rotation.x) * k(4);
      r.root.position.z = OPP_Z - drop * 0.4;
      if (ph !== "idle" && ph !== "intro") r.root.position.x += (0 - r.root.position.x) * k(4);

      // eyes follow you, and narrow on the wind-up
      const look = Math.max(-1, Math.min(1, cameraLean));
      r.pupils.forEach((p) => { p.position.x = (p.userData.bx as number) + look * 0.012; });
      const angry = ph === "windup" || ph === "strike" ? 0.5 : ph === "open" || ph === "hurt" || ph === "down" ? -0.3 : 0.15;
      r.brows.forEach((b, i) => { b.rotation.z += ((i === 0 ? -1 : 1) * -angry - b.rotation.z) * k(10); });
      const shock = ph === "open" || ph === "hurt" || ph === "down";
      r.mouth.rotation.z = shock ? 0 : Math.PI;
      r.mouth.scale.setScalar(shock ? 1.3 : 1);

      r.stars.visible = ph === "open" || ph === "down";
      if (r.stars.visible) {
        const hp = r.head.getWorldPosition(tmpV);
        r.stars.children.forEach((s) => {
          const a = s.userData.a + this.t * 4;
          s.position.set(Math.cos(a) * 0.32, hp.y - r.root.position.y + 0.28 + Math.sin(a * 2) * 0.03, Math.sin(a) * 0.32);
          s.rotation.y = this.t * 6;
        });
      }

      // flash white on a hit
      this.flash = Math.max(0, this.flash - dt * 6);
      for (const m of r.mats) {
        if (m === r.gloveMats.L || m === r.gloveMats.R) continue;
        m.emissiveIntensity = 1;
        if (!m.userData.baseEmissive) m.userData.baseEmissive = m.emissive.clone();
        const b = m.userData.baseEmissive as THREE.Color;
        m.emissive.setRGB(b.r + this.flash * 0.6, b.g + this.flash * 0.6, b.b + this.flash * 0.6);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      s.v.y -= 6 * dt;
      s.mesh.position.addScaledVector(s.v, dt);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, s.life / 0.45);
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
        this.sparks.splice(i, 1);
      }
    }

    const crowd = this.ringGroup?.getObjectByName("crowd") as THREE.Points | undefined;
    if (crowd) (crowd.material as THREE.PointsMaterial).opacity = 0.35 + Math.random() * 0.4;

    this.renderer.render(this.scene, this.camera);
  }

  /** The frame as a JPEG, with the camera picture under it in camera mode. */
  snapshot(video: HTMLVideoElement | null): string {
    const c = this.canvas;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    if (this.ar && video && video.videoWidth) {
      const s = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
      const w = video.videoWidth * s, h = video.videoHeight * s;
      ctx.save();
      ctx.translate(out.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, (out.width - w) / 2, (out.height - h) / 2, w, h);
      ctx.restore();
    }
    this.renderer.render(this.scene, this.camera);
    ctx.drawImage(c, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  }

  dispose(): void {
    this.sparks.forEach((s) => { s.mesh.geometry.dispose(); (s.mesh.material as THREE.Material).dispose(); });
    this.scene.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh || (m as THREE.Points).isPoints) {
        mesh.geometry?.dispose();
        const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        ms.forEach((x) => { const t = (x as THREE.MeshStandardMaterial)?.map; t?.dispose(); x?.dispose(); });
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
