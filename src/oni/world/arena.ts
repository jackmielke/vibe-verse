/**
 * The square: a summer festival at dusk.
 *
 * A paved circle with a yagura in the middle (the drum tower Bon dancers
 * circle), strings of chōchin running from its roof out to poles round the
 * edge, stalls, stone lanterns and sakura to dodge behind, and a torii where
 * you came in. Everything here is decoration except what `OBSTACLES` in
 * `rules.ts` says is solid, and everything is placed from that list, so the
 * picture and the physics cannot disagree.
 *
 * The props that exist in the valley (stone lanterns, the torii, the sakura)
 * are the valley's own, so the two places read as one village.
 */
import * as THREE from "three";
import { buildProp, type PropContext, type PropObject } from "@/magician/world/props";
import { ARENA_R, OBSTACLES } from "../rules";

export interface Arena {
  group: THREE.Group;
  /** `eye` and `subject` let a tree between the camera and the player fade out of the way. */
  update(dt: number, time: number, eye?: THREE.Vector3, subject?: THREE.Vector3): void;
  dispose(): void;
}

const CTX: PropContext = { wind: 0.25, windDir: 0.6, season: "spring", lanterns: true, night: 0.55, snow: 0 };

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildArena(opts: { light?: boolean } = {}): Arena {
  const group = new THREE.Group();
  group.name = "arena";
  const disposables: Array<{ dispose(): void }> = [];
  const own = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const props: PropObject[] = [];
  // Trees that can fade: each gets its own copies of its materials.
  const fading: Array<{ x: number; z: number; mats: THREE.Material[]; o: number }> = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  // ---- sky ---------------------------------------------------------------
  const sky = new THREE.Mesh(
    own(new THREE.SphereGeometry(400, 32, 16)),
    own(new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 top = vec3(0.10, 0.12, 0.30);
          vec3 mid = vec3(0.55, 0.36, 0.55);
          vec3 low = vec3(1.00, 0.62, 0.42);
          vec3 c = mix(low, mid, smoothstep(0.0, 0.18, h));
          c = mix(c, top, smoothstep(0.16, 0.7, h));
          // The sun just gone, a warm glow low in the west.
          float sun = pow(max(0.0, dot(normalize(vDir), normalize(vec3(-0.8, 0.08, -0.6)))), 12.0);
          c += vec3(1.0, 0.55, 0.3) * sun * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    })),
  );
  sky.renderOrder = -1;
  group.add(sky);

  // ---- ground ------------------------------------------------------------
  const grassTex = own(canvasTexture(256, 256, (g) => {
    g.fillStyle = "#4e7a3a"; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2200; i++) {
      const l = 30 + Math.random() * 25;
      g.fillStyle = `hsl(${95 + Math.random() * 25}, 38%, ${l}%)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 3 + Math.random() * 4);
    }
  }));
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(40, 40);
  const grass = new THREE.Mesh(own(new THREE.CircleGeometry(160, 48)), own(new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 })));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  group.add(grass);

  const paveTex = own(canvasTexture(512, 512, (g) => {
    g.fillStyle = "#8d8577"; g.fillRect(0, 0, 512, 512);
    // Irregular flagstones, rows of offset rectangles with mortar between.
    for (let row = 0; row < 8; row++) {
      let x = (row % 2) * -32;
      while (x < 512) {
        const w = 48 + Math.random() * 44;
        const l = 52 + Math.random() * 14;
        g.fillStyle = `hsl(${30 + Math.random() * 16}, ${8 + Math.random() * 8}%, ${l}%)`;
        g.fillRect(x + 2, row * 64 + 2, w - 4, 60);
        for (let k = 0; k < 30; k++) {
          g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
          g.fillRect(x + Math.random() * w, row * 64 + Math.random() * 60, 3, 3);
        }
        x += w;
      }
    }
  }));
  paveTex.wrapS = paveTex.wrapT = THREE.RepeatWrapping;
  paveTex.repeat.set(7, 7);
  const pave = new THREE.Mesh(own(new THREE.CircleGeometry(ARENA_R + 0.6, 72)), own(new THREE.MeshStandardMaterial({ map: paveTex, roughness: 0.95 })));
  pave.rotation.x = -Math.PI / 2;
  pave.receiveShadow = true;
  group.add(pave);
  // A dance ring painted round the tower, where the Bon dancers go.
  const ring = new THREE.Mesh(own(new THREE.RingGeometry(6.2, 6.5, 64)), own(new THREE.MeshBasicMaterial({ color: "#f2e6cf", transparent: true, opacity: 0.35 })));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
  group.add(ring);

  // ---- the edge: a low bamboo fence --------------------------------------
  {
    const n = 120;
    const postGeo = own(new THREE.CylinderGeometry(0.06, 0.07, 0.9, 6));
    const bamboo = own(new THREE.MeshStandardMaterial({ color: "#b59a5a", roughness: 0.8 }));
    const posts = new THREE.InstancedMesh(postGeo, bamboo, n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // The gap under the torii is the way in.
      const x = Math.cos(a) * (ARENA_R + 0.4), z = Math.sin(a) * (ARENA_R + 0.4);
      const y = Math.abs(x) < 3 && z > 0 ? -5 : 0.45;
      m.makeTranslation(x, y, z);
      posts.setMatrixAt(i, m);
    }
    posts.castShadow = true;
    group.add(posts);
    for (const h of [0.35, 0.75]) {
      const rail = new THREE.Mesh(own(new THREE.TorusGeometry(ARENA_R + 0.4, 0.035, 5, 160, Math.PI * 2 - 0.26)), bamboo);
      rail.rotation.x = Math.PI / 2;
      rail.rotation.z = Math.PI / 2 + 0.13;
      rail.position.y = h;
      group.add(rail);
    }
  }

  // ---- the yagura ----------------------------------------------------------
  const red = own(new THREE.MeshStandardMaterial({ color: "#b8322a", roughness: 0.6 }));
  const wood = own(new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.9 }));
  const dark = own(new THREE.MeshStandardMaterial({ color: "#2e2420", roughness: 0.9 }));
  {
    const y = new THREE.Group();
    const leg = own(new THREE.BoxGeometry(0.22, 4.2, 0.22));
    for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const l = new THREE.Mesh(leg, wood); l.position.set(x, 2.1, z); l.castShadow = true; y.add(l);
    }
    // The red and white striped skirt (kōhaku maku) round the platform.
    const stripes = own(canvasTexture(512, 64, (g) => {
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? "#f7f1e6" : "#c7302a"; g.fillRect(i * 32, 0, 32, 64); }
    }));
    stripes.wrapS = THREE.RepeatWrapping; stripes.repeat.set(2, 1);
    const skirt = new THREE.Mesh(own(new THREE.CylinderGeometry(2.9, 2.9, 1.1, 4, 1, true)), own(new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.9, side: THREE.DoubleSide })));
    skirt.rotation.y = Math.PI / 4;
    skirt.position.y = 2.1;
    skirt.scale.set(1, 1, 1);
    y.add(skirt);
    const deck = new THREE.Mesh(own(new THREE.BoxGeometry(4.6, 0.18, 4.6)), wood);
    deck.position.y = 2.7; deck.castShadow = true; deck.receiveShadow = true;
    y.add(deck);
    // Railing.
    const railGeo = own(new THREE.BoxGeometry(4.6, 0.08, 0.08));
    for (let i = 0; i < 4; i++) {
      const r = new THREE.Mesh(railGeo, red);
      const a = (i * Math.PI) / 2;
      r.position.set(Math.sin(a) * 2.3, 3.35, Math.cos(a) * 2.3);
      r.rotation.y = a;
      y.add(r);
    }
    // The drum, and the roof over it.
    const drum = new THREE.Mesh(own(new THREE.CylinderGeometry(0.62, 0.62, 0.9, 20)), own(new THREE.MeshStandardMaterial({ color: "#7a3b22", roughness: 0.6 })));
    drum.rotation.z = Math.PI / 2; drum.position.set(0, 3.45, 0);
    y.add(drum);
    const skin = own(new THREE.MeshStandardMaterial({ color: "#efe3c8", roughness: 0.8 }));
    for (const s of [-1, 1]) {
      const face = new THREE.Mesh(own(new THREE.CircleGeometry(0.6, 20)), skin);
      face.position.set(s * 0.46, 3.45, 0); face.rotation.y = s * Math.PI / 2;
      y.add(face);
    }
    const roof = new THREE.Mesh(own(new THREE.ConeGeometry(3.6, 1.5, 4, 1)), dark);
    roof.rotation.y = Math.PI / 4; roof.position.y = 5.1; roof.castShadow = true;
    y.add(roof);
    const post = own(new THREE.BoxGeometry(0.14, 1.4, 0.14));
    for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const p = new THREE.Mesh(post, red); p.position.set(x, 3.6, z); y.add(p);
    }
    // The mast the lantern strings hang from.
    const mast = new THREE.Mesh(own(new THREE.CylinderGeometry(0.09, 0.12, 4.8, 8)), red);
    mast.position.y = 8.0;
    y.add(mast);
    group.add(y);
  }

  // ---- lantern strings -------------------------------------------------------
  // From the yagura's eaves to poles round the edge, a paper lantern every
  // metre and a half, red and white. Instanced: two draw calls for all of them.
  const lanternGlow: THREE.MeshStandardMaterial[] = [];
  {
    const spokes = 12;
    const perString = 11;
    const geo = own(new THREE.SphereGeometry(0.22, 10, 8));
    geo.scale(1, 1.25, 1);
    const mats = ["#ff4a3a", "#fff1d6"].map((c) => {
      const m = own(new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.3, roughness: 0.6 }));
      lanternGlow.push(m);
      return m;
    });
    const counts = [0, 0];
    const insts = mats.map((m) => new THREE.InstancedMesh(geo, m, spokes * perString));
    const cord = own(new THREE.LineBasicMaterial({ color: "#2a1c14" }));
    const poleGeo = own(new THREE.CylinderGeometry(0.08, 0.1, 8.8, 6));
    const mtx = new THREE.Matrix4();
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2 + 0.13;
      const from = new THREE.Vector3(Math.cos(a) * 0.2, 10.2, Math.sin(a) * 0.2);
      const to = new THREE.Vector3(Math.cos(a) * (ARENA_R - 1.5), 8.6, Math.sin(a) * (ARENA_R - 1.5));
      const pole = new THREE.Mesh(poleGeo, wood); pole.position.set(to.x, 4.4, to.z); pole.castShadow = true;
      group.add(pole);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const p = from.clone().lerp(to, t);
        p.y -= Math.sin(t * Math.PI) * 0.7;
        pts.push(p);
      }
      group.add(new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(pts)), cord));
      for (let i = 1; i <= perString; i++) {
        const t = 0.12 + (i / (perString + 1)) * 0.88;
        const p = from.clone().lerp(to, t);
        p.y -= Math.sin(t * Math.PI) * 0.7 + 0.3;
        const k = (i + s) % 2;
        mtx.makeTranslation(p.x, p.y, p.z);
        insts[k].setMatrixAt(counts[k]++, mtx);
      }
    }
    insts.forEach((im, k) => { im.count = counts[k]; group.add(im); });
  }

  // ---- props that are also obstacles ----------------------------------------
  const noren = ["金魚", "たこ焼", "かき氷", "りんご飴"];
  const norenCols = ["#2a4d8f", "#b8322a", "#2f7d6d", "#c78a1e"];
  let stall = 0;
  for (const o of OBSTACLES) {
    if (o.kind === "sakura" || o.kind === "lantern") {
      const p = buildProp(o.kind, "spring");
      p.group.position.set(o.x, 0, o.z);
      p.group.rotation.y = rnd() * Math.PI * 2;
      if (o.kind === "sakura") {
        p.group.scale.setScalar(1.25);
        const mats: THREE.Material[] = [];
        p.group.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (!mesh.isMesh) return;
          const c = (mesh.material as THREE.Material).clone();
          c.transparent = true;
          own(c);
          mats.push(c);
          mesh.material = c;
        });
        fading.push({ x: o.x, z: o.z, mats, o: 1 });
      }
      if (p.lamp) { (p.lamp.glow as THREE.MeshStandardMaterial).emissiveIntensity = 1.4; }
      group.add(p.group);
      props.push(p);
    } else if (o.kind === "stall") {
      // A yatai: a counter, four posts, a slanted roof, a noren with its wares.
      const g = new THREE.Group();
      const counter = new THREE.Mesh(own(new THREE.BoxGeometry(2.8, 1, 1.4)), wood); counter.position.y = 0.5; counter.castShadow = true;
      g.add(counter);
      for (const [x, z] of [[-1.35, -0.65], [1.35, -0.65], [-1.35, 0.65], [1.35, 0.65]]) {
        const p = new THREE.Mesh(own(new THREE.BoxGeometry(0.1, 2.4, 0.1)), wood); p.position.set(x, 1.2, z); g.add(p);
      }
      const col = norenCols[stall % norenCols.length];
      const roof = new THREE.Mesh(own(new THREE.BoxGeometry(3.2, 0.1, 1.9)), own(new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 })));
      roof.position.y = 2.45; roof.rotation.x = -0.18; roof.castShadow = true;
      g.add(roof);
      const word = noren[stall % noren.length];
      const tex = own(canvasTexture(512, 128, (c) => {
        c.fillStyle = col; c.fillRect(0, 0, 512, 128);
        c.fillStyle = "#fff6e8"; c.font = "bold 84px serif"; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText(word, 256, 68);
      }));
      const cloth = new THREE.Mesh(own(new THREE.PlaneGeometry(2.9, 0.62)), own(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 })));
      cloth.position.set(0, 2.05, 0.96);
      g.add(cloth);
      const lamp = new THREE.Mesh(own(new THREE.SphereGeometry(0.2, 10, 8)), lanternGlow[0]);
      lamp.position.set(1.1, 1.85, 0.9);
      g.add(lamp);
      g.position.set(o.x, 0, o.z);
      g.rotation.y = Math.atan2(-o.x, -o.z);
      group.add(g);
      stall++;
    } else if (o.kind === "well") {
      const g = new THREE.Group();
      const stone = own(new THREE.MeshStandardMaterial({ color: "#8e8a82", roughness: 1 }));
      const wall = new THREE.Mesh(own(new THREE.CylinderGeometry(0.95, 1.0, 0.8, 16, 1, true)), stone); wall.position.y = 0.4; wall.castShadow = true;
      const water = new THREE.Mesh(own(new THREE.CircleGeometry(0.9, 16)), own(new THREE.MeshStandardMaterial({ color: "#1e3b4a", roughness: 0.2 })));
      water.rotation.x = -Math.PI / 2; water.position.y = 0.5;
      g.add(wall, water);
      for (const s of [-1, 1]) { const p = new THREE.Mesh(own(new THREE.BoxGeometry(0.1, 1.9, 0.1)), wood); p.position.set(s * 0.9, 0.95, 0); g.add(p); }
      const beam = new THREE.Mesh(own(new THREE.BoxGeometry(2.2, 0.12, 0.12)), wood); beam.position.y = 1.9; g.add(beam);
      const roof = new THREE.Mesh(own(new THREE.ConeGeometry(1.4, 0.6, 4)), dark); roof.position.y = 2.3; roof.rotation.y = Math.PI / 4; g.add(roof);
      g.position.set(o.x, 0, o.z);
      group.add(g);
    }
  }
  {
    const t = buildProp("torii", "spring");
    t.group.position.set(0, 0, 21);
    t.group.scale.setScalar(1.4);
    group.add(t.group);
    props.push(t);
  }

  // ---- outside: hills and trees ---------------------------------------------
  {
    const hillMat = own(new THREE.MeshStandardMaterial({ color: "#35523f", roughness: 1, flatShading: true }));
    const hillGeo = own(new THREE.IcosahedronGeometry(1, 1));
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rnd() * 0.3;
      const r = 95 + rnd() * 60;
      const h = new THREE.Mesh(hillGeo, hillMat);
      h.position.set(Math.cos(a) * r, -6, Math.sin(a) * r);
      h.scale.set(30 + rnd() * 30, 18 + rnd() * 26, 30 + rnd() * 30);
      group.add(h);
    }
    const n = 90;
    const coneGeo = own(new THREE.ConeGeometry(1.4, 5, 7));
    const trunkGeo = own(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6));
    const needles = own(new THREE.MeshStandardMaterial({ color: "#2c5a3e", roughness: 0.9, flatShading: true }));
    const cones = new THREE.InstancedMesh(coneGeo, needles, n);
    const trunks = new THREE.InstancedMesh(trunkGeo, wood, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      if (Math.abs(Math.cos(a)) < 0.12 && Math.sin(a) > 0) continue; // keep the view out of the torii clear
      const r = ARENA_R + 5 + rnd() * 30;
      const s = 0.8 + rnd() * 1.1;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      sc.set(s, s, s);
      m.compose(new THREE.Vector3(x, 1.4 * s + 2.5 * s, z), q, sc); cones.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 0.7 * s, z), q, sc); trunks.setMatrixAt(i, m);
    }
    cones.castShadow = true;
    group.add(cones, trunks);
  }

  // ---- light -----------------------------------------------------------------
  const hemi = new THREE.HemisphereLight("#ffd8c0", "#5a4a60", 1.9);
  group.add(hemi);
  const sun = new THREE.DirectionalLight("#ffb07a", 1.9);
  sun.position.set(-30, 26, -22);
  sun.castShadow = !opts.light;
  sun.shadow.mapSize.set(opts.light ? 512 : 1024, opts.light ? 512 : 1024);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0008;
  group.add(sun, sun.target);
  // A soft fill from the other side, so a player seen with the sun behind them
  // is a character and not a silhouette.
  const fill = new THREE.DirectionalLight("#ffe6d2", 1.1);
  fill.position.set(24, 20, 26);
  group.add(fill);
  // A warm pool round the tower, which is where the eye should go.
  const warm = new THREE.PointLight("#ffa060", 30, 22, 1.6);
  warm.position.set(0, 4, 0);
  group.add(warm);

  // ---- petals ------------------------------------------------------------------
  const N_PETALS = opts.light ? 120 : 260;
  const petalPos = new Float32Array(N_PETALS * 3);
  const petalSeed = new Float32Array(N_PETALS);
  for (let i = 0; i < N_PETALS; i++) {
    petalPos[i * 3] = (rnd() - 0.5) * 60;
    petalPos[i * 3 + 1] = rnd() * 12;
    petalPos[i * 3 + 2] = (rnd() - 0.5) * 60;
    petalSeed[i] = rnd() * 10;
  }
  const petalGeo = own(new THREE.BufferGeometry());
  petalGeo.setAttribute("position", new THREE.BufferAttribute(petalPos, 3));
  const petals = new THREE.Points(petalGeo, own(new THREE.PointsMaterial({ color: "#ffc4dc", size: 0.12, transparent: true, opacity: 0.9, depthWrite: false })));
  petals.frustumCulled = false;
  group.add(petals);

  return {
    group,
    update(dt, time, eye, subject) {
      for (const p of props) p.update?.(dt, time, CTX);
      for (const f of fading) {
        let target = 1;
        if (eye && subject) {
          // Distance from the tree to the eye-subject line, on the ground, and
          // whether the tree is on the camera's side of the player.
          const ex = eye.x, ez = eye.z, sx = subject.x - ex, sz = subject.z - ez;
          const len2 = sx * sx + sz * sz || 1;
          const t = ((f.x - ex) * sx + (f.z - ez) * sz) / len2;
          if (t > -0.15 && t < 1.05) {
            const px = ex + sx * t, pz = ez + sz * t;
            if (Math.hypot(f.x - px, f.z - pz) < 3.4) target = 0.18;
          }
        }
        f.o += (target - f.o) * Math.min(1, dt * 6);
        for (const m of f.mats) { m.opacity = f.o; m.depthWrite = f.o > 0.95; }
      }
      for (const m of lanternGlow) m.emissiveIntensity = 1.2 + Math.sin(time * 2.3) * 0.08;
      for (let i = 0; i < N_PETALS; i++) {
        const o = i * 3;
        petalPos[o] += (0.6 + Math.sin(time + petalSeed[i]) * 0.4) * dt;
        petalPos[o + 1] -= (0.35 + (petalSeed[i] % 1) * 0.3) * dt;
        petalPos[o + 2] += Math.cos(time * 0.7 + petalSeed[i]) * 0.3 * dt;
        if (petalPos[o + 1] < 0) { petalPos[o + 1] = 10 + petalSeed[i] % 3; petalPos[o] = (Math.random() - 0.5) * 60; petalPos[o + 2] = (Math.random() - 0.5) * 60; }
      }
      (petalGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    },
    dispose() {
      for (const p of props) p.dispose();
      for (const d of disposables) d.dispose();
      group.traverse((o) => { const im = o as THREE.InstancedMesh; if (im.isInstancedMesh) im.dispose(); });
    },
  };
}
