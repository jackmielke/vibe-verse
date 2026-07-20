/**
 * The Vibe Ventures Studio embassy — the studio's presence inside the
 * VibeVerse. A miniature of the studio site's network globe (the same
 * five real hubs, the same emerald arcs and traveling pulses) floats
 * over a stone plinth, ringed by light pylons, with a signboard and a
 * soft beacon so it reads from across the island at night.
 *
 * The bridge runs both ways: the studio site renders the Vibeverse as
 * a moon over its earth, and here the Vibeverse holds a small copy of
 * the studio's globe. Walk up → chip opens the studio site.
 */
import * as THREE from "three";

export interface StudioEmbassy {
  group: THREE.Group;
  update: (dt: number, now: number) => void;
  dispose: () => void;
}

// The studio's real footprint — mirrors HUBS in the studio repo's
// Globe.tsx, so both worlds show the same constellation.
const HUBS = [
  { name: "San Francisco", lat: 37.77, lon: -122.42 },
  { name: "Lisbon", lat: 38.72, lon: -9.14 },
  { name: "Vermont", lat: 44.48, lon: -73.21 },
  { name: "Patagonia", lat: -49.33, lon: -72.89 },
  { name: "Edge Esmeralda", lat: 38.61, lon: -122.87 },
];

const GLOBE_R = 1.15;
const GLOBE_Y = 3.4; // rest height of the globe's center above the plinth base

const EMERALD = new THREE.Color("rgb(90, 235, 190)");
const EMERALD_BRIGHT = new THREE.Color("rgb(140, 255, 215)");

const latLonToVec3 = (lat: number, lon: number, r: number) => {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
};

export function createStudioEmbassy(opts: {
  position: THREE.Vector3;
  rotationY?: number;
}): StudioEmbassy {
  const group = new THREE.Group();
  group.position.copy(opts.position);
  group.rotation.y = opts.rotationY ?? 0;

  // ---- Plinth: two stacked stone discs with an emerald trim ring ----
  const stone = new THREE.MeshLambertMaterial({ color: "#3a4148" });
  const stoneDark = new THREE.MeshLambertMaterial({ color: "#2c3238" });
  const step = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.3, 0.35, 28), stoneDark);
  step.position.y = 0.175;
  group.add(step);
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.55, 28), stone);
  plinth.position.y = 0.35 + 0.275;
  group.add(plinth);
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(2.32, 0.035, 8, 48),
    new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.85 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.92;
  group.add(trim);

  // ---- The miniature network globe ----
  const globe = new THREE.Group();
  globe.position.y = GLOBE_Y;
  group.add(globe);

  const POINTS = 320;
  const positions = new Float32Array(POINTS * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < POINTS; i++) {
    const y = 1 - (i / (POINTS - 1)) * 2;
    const rAt = Math.sqrt(1 - y * y);
    const theta = golden * i;
    positions[i * 3] = Math.cos(theta) * rAt * GLOBE_R;
    positions[i * 3 + 1] = y * GLOBE_R;
    positions[i * 3 + 2] = Math.sin(theta) * rAt * GLOBE_R;
  }
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  globe.add(
    new THREE.Points(
      pointsGeo,
      new THREE.PointsMaterial({
        color: EMERALD,
        size: 0.035,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  globe.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_R * 0.985, 20, 20),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("rgb(60, 140, 120)"),
        wireframe: true,
        transparent: true,
        opacity: 0.07,
      }),
    ),
  );
  // A dark inner sphere so the far side's points dim instead of
  // overlapping — gives the miniature real depth at street level.
  globe.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_R * 0.93, 24, 24),
      new THREE.MeshBasicMaterial({ color: "#0a1512", transparent: true, opacity: 0.75 }),
    ),
  );

  // Hub dots + halos
  const haloTexture = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(140,255,215,0.9)");
    grad.addColorStop(0.4, "rgba(90,235,190,0.28)");
    grad.addColorStop(1, "rgba(90,235,190,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const halos: THREE.Sprite[] = [];
  const hubPositions = HUBS.map((h) => latLonToVec3(h.lat, h.lon, GLOBE_R * 1.01));
  for (const pos of hubPositions) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 10),
      new THREE.MeshBasicMaterial({ color: EMERALD_BRIGHT }),
    );
    dot.position.copy(pos);
    globe.add(dot);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.scale.setScalar(0.22);
    halo.position.copy(pos);
    globe.add(halo);
    halos.push(halo);
  }

  // Arcs between every hub pair, each with one traveling pulse
  const pulses: {
    curve: THREE.QuadraticBezierCurve3;
    mesh: THREE.Mesh;
    offset: number;
    speed: number;
  }[] = [];
  for (let i = 0; i < hubPositions.length; i++) {
    for (let j = i + 1; j < hubPositions.length; j++) {
      const a = hubPositions[i];
      const b = hubPositions[j];
      const dist = a.distanceTo(b);
      const mid = a
        .clone()
        .add(b)
        .multiplyScalar(0.5)
        .normalize()
        .multiplyScalar(GLOBE_R * (1 + dist * 0.2));
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      globe.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)),
          new THREE.LineBasicMaterial({
            color: EMERALD,
            transparent: true,
            opacity: 0.3,
            blending: THREE.AdditiveBlending,
          }),
        ),
      );
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 8, 8),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color("rgb(190, 255, 235)"),
          transparent: true,
          opacity: 0.95,
        }),
      );
      globe.add(pulse);
      pulses.push({
        curve,
        mesh: pulse,
        offset: ((i * 7 + j * 13) % 10) / 10,
        speed: 0.12 + ((i + j) % 4) * 0.04,
      });
    }
  }

  // ---- Beacon: a soft light column above the globe ----
  const beaconMat = new THREE.MeshBasicMaterial({
    color: EMERALD,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.9, 34, 12, 1, true),
    beaconMat,
  );
  beacon.position.y = GLOBE_Y + 17.5;
  group.add(beacon);

  // ---- Light pylons around the plinth ----
  const pylonMat = new THREE.MeshLambertMaterial({ color: "#232a30" });
  const capMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.1, 0.22), pylonMat);
    pylon.position.set(Math.cos(a) * 3.6, 1.05, Math.sin(a) * 3.6);
    group.add(pylon);
    const capMat = new THREE.MeshBasicMaterial({
      color: EMERALD_BRIGHT,
      transparent: true,
      opacity: 0.9,
    });
    capMats.push(capMat);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), capMat);
    cap.position.set(Math.cos(a) * 3.6, 2.22, Math.sin(a) * 3.6);
    group.add(cap);
  }

  // ---- Signboard on two posts, facing the approach ----
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0b1310";
  ctx.fillRect(0, 0, 640, 400);
  ctx.strokeStyle = "rgba(90,235,190,0.55)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 620, 380);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgb(140,255,215)";
  ctx.font = "bold 44px 'Courier New', monospace";
  ctx.fillText("VIBE VENTURES", 320, 84);
  ctx.fillText("STUDIO", 320, 134);
  ctx.fillStyle = "rgba(230,255,246,0.75)";
  ctx.font = "22px 'Courier New', monospace";
  ctx.fillText("THE AI ACCELERATION ARM", 320, 190);
  ctx.fillText("OF MANY COMMUNITIES", 320, 218);
  ctx.fillStyle = "rgba(90,235,190,0.8)";
  ctx.font = "italic 20px Georgia, serif";
  ctx.fillText("one constellation, many campfires", 320, 268);
  ctx.fillStyle = "rgba(230,255,246,0.5)";
  ctx.font = "18px 'Courier New', monospace";
  ctx.fillText(HUBS.map((h) => h.name).join(" · "), 320, 318);
  ctx.fillStyle = "rgba(140,255,215,0.85)";
  ctx.font = "20px 'Courier New', monospace";
  ctx.fillText("— walk up to visit the studio —", 320, 366);
  const signTexture = new THREE.CanvasTexture(canvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;

  const sign = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: "#2c3238" });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.9, 0.12), postMat);
    post.position.set(s * 1.05, 0.95, 0);
    sign.add(post);
  }
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.5),
    new THREE.MeshBasicMaterial({ map: signTexture, side: THREE.DoubleSide }),
  );
  board.position.y = 1.75;
  sign.add(board);
  // Out in front of the plinth (local +Z is the facing direction,
  // set by rotationY at the call site).
  sign.position.set(0, 0, 4.4);
  group.add(sign);

  // ---- Postcard easel: photos from the physical world -----------------
  // The studio site's community photo library is public (same endpoint
  // its own gallery uses). Real moments from the hubs — SF, Lisbon,
  // Patagonia — cycling on an easel inside the digital world. If the
  // fetch fails we fall back to the town's own postcards, so the easel
  // never sits empty.
  const STUDIO_GALLERY =
    "https://vkfiehpsniioeqddxtwo.supabase.co/functions/v1/api-gallery?limit=40";
  const FALLBACK_CARDS = [
    "/postcards/plaza-day.jpg",
    "/postcards/arch-night.jpg",
    "/postcards/island-day.jpg",
    "/postcards/zeppelin-day.jpg",
    "/postcards/palace-night.jpg",
    "/postcards/snackfe-day.jpg",
  ];

  const easel = new THREE.Group();
  const legMat = new THREE.MeshLambertMaterial({ color: "#6b4d30" });
  for (const [lx, lz, tilt] of [
    [-0.55, 0.12, 0.16],
    [0.55, 0.12, -0.16],
    [0, -0.5, -0.3],
  ] as const) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.1, 0.09), legMat);
    leg.position.set(lx, 1.0, lz);
    leg.rotation.z = tilt * (lx === 0 ? 0 : 1);
    if (lx === 0) leg.rotation.x = tilt;
    easel.add(leg);
  }
  const tray = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.14), legMat);
  tray.position.set(0, 0.82, 0.2);
  easel.add(tray);

  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = 512;
  cardCanvas.height = 420;
  const cardCtx = cardCanvas.getContext("2d")!;
  const cardTexture = new THREE.CanvasTexture(cardCanvas);
  cardTexture.colorSpace = THREE.SRGBColorSpace;
  const cardBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(1.45, 1.19),
    new THREE.MeshBasicMaterial({ map: cardTexture, side: THREE.DoubleSide }),
  );
  cardBoard.position.set(0, 1.5, 0.16);
  cardBoard.rotation.x = -0.08;
  easel.add(cardBoard);
  // Between the sign and the plinth's left edge, angled at the path.
  easel.position.set(-3.2, 0, 2.6);
  easel.rotation.y = 0.5;
  group.add(easel);

  interface Postcard {
    img: HTMLImageElement;
    caption: string;
  }
  const deck: Postcard[] = [];
  let deckIdx = -1;
  let nextSwapAt = 0;

  const drawCard = (card: Postcard | null) => {
    const W = cardCanvas.width;
    const H = cardCanvas.height;
    cardCtx.fillStyle = "#0b1310";
    cardCtx.fillRect(0, 0, W, H);
    const frame = 14;
    if (card) {
      // Cover-fit the photo into the frame above the caption strip
      const ph = H - 74 - frame * 2;
      const pw = W - frame * 2;
      const scale = Math.max(pw / card.img.width, ph / card.img.height);
      const sw = pw / scale;
      const sh = ph / scale;
      cardCtx.save();
      cardCtx.beginPath();
      cardCtx.rect(frame, frame, pw, ph);
      cardCtx.clip();
      cardCtx.drawImage(
        card.img,
        (card.img.width - sw) / 2,
        (card.img.height - sh) / 2,
        sw,
        sh,
        frame,
        frame,
        pw,
        ph,
      );
      cardCtx.restore();
      cardCtx.fillStyle = "rgba(230,255,246,0.85)";
      cardCtx.font = "22px 'Courier New', monospace";
      cardCtx.textAlign = "center";
      cardCtx.fillText(card.caption.slice(0, 36), W / 2, H - 44);
    } else {
      cardCtx.fillStyle = "rgba(230,255,246,0.4)";
      cardCtx.font = "24px 'Courier New', monospace";
      cardCtx.textAlign = "center";
      cardCtx.fillText("developing…", W / 2, H / 2);
    }
    cardCtx.fillStyle = "rgba(90,235,190,0.7)";
    cardCtx.font = "16px 'Courier New', monospace";
    cardCtx.textAlign = "center";
    cardCtx.fillText("postcards from the physical world", cardCanvas.width / 2, H - 18);
    cardCtx.strokeStyle = "rgba(90,235,190,0.45)";
    cardCtx.lineWidth = 3;
    cardCtx.strokeRect(6, 6, W - 12, H - 12);
    cardTexture.needsUpdate = true;
  };
  drawCard(null);

  const addToDeck = (url: string, caption: string) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      deck.push({ img, caption });
      // First arrival goes straight onto the easel
      if (deckIdx === -1) {
        deckIdx = 0;
        drawCard(deck[0]);
      }
    };
    img.src = url;
  };

  fetch(STUDIO_GALLERY)
    .then((r) => r.json())
    .then((data: { photos?: { image_url: string; title?: string | null; residency_name?: string | null }[] }) => {
      const photos = (data.photos ?? []).filter((p) => p.image_url);
      if (photos.length === 0) throw new Error("empty gallery");
      for (const p of photos.slice(0, 24)) {
        addToDeck(p.image_url, p.residency_name || p.title || "the studio network");
      }
    })
    .catch(() => {
      for (const url of FALLBACK_CARDS) addToDeck(url, "vibe island");
    });

  // ---- Drifting motes: the same ambient constellation dust the studio
  // site now floats behind its globe, echoed here around the embassy so
  // both worlds share one visual signature. ----------------------------
  const MOTE_COUNT = 46;
  const moteBase: THREE.Vector3[] = [];
  const motePhase: number[] = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.6 + Math.random() * 2.6;
    moteBase.push(new THREE.Vector3(Math.cos(a) * r, 1.2 + Math.random() * 5.4, Math.sin(a) * r));
    motePhase.push(Math.random() * Math.PI * 2);
  }
  const motePositions = new Float32Array(MOTE_COUNT * 3);
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
  const motePoints = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      color: EMERALD_BRIGHT,
      size: 0.03,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(motePoints);

  const update = (dt: number, now: number) => {
    // Motes drift on slow independent sine paths — ambient, not busy.
    const mt = now / 1000;
    const posAttr = moteGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const b = moteBase[i];
      const ph = motePhase[i];
      posAttr.setXYZ(
        i,
        b.x + Math.sin(mt * 0.25 + ph) * 0.35,
        b.y + Math.sin(mt * 0.18 + ph * 1.7) * 0.4,
        b.z + Math.cos(mt * 0.22 + ph) * 0.35,
      );
    }
    posAttr.needsUpdate = true;

    // Postcard rotation — a new card every few seconds once loaded
    if (deck.length > 1 && now >= nextSwapAt) {
      nextSwapAt = now + 6500;
      deckIdx = (deckIdx + 1) % deck.length;
      drawCard(deck[deckIdx]);
    }
    const t = now / 1000;
    globe.rotation.y += dt * 0.25;
    globe.position.y = GLOBE_Y + Math.sin(t * 0.7) * 0.12;
    for (const p of pulses) {
      const u = (t * p.speed + p.offset) % 1;
      p.curve.getPoint(u, p.mesh.position);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(u * Math.PI) * 0.95;
    }
    const breathe = 0.5 + Math.sin(t * 1.4) * 0.5;
    for (let i = 0; i < halos.length; i++) {
      halos[i].scale.setScalar(0.2 + breathe * 0.08);
    }
    beaconMat.opacity = 0.07 + breathe * 0.05;
    for (let i = 0; i < capMats.length; i++) {
      capMats[i].opacity = 0.6 + Math.sin(t * 2 + i * 1.7) * 0.3;
    }
  };

  return {
    group,
    update,
    dispose() {
      haloTexture.dispose();
      signTexture.dispose();
      cardTexture.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh || (o as THREE.Points).type === "Points" || (o as THREE.Line).type === "Line") {
          (m.geometry as THREE.BufferGeometry | undefined)?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    },
  };
}
