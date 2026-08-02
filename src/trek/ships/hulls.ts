/**
 * Every hull in the episode, built from primitives at the real published
 * dimensions. Nothing is downloaded.
 *
 * The Constitution class is the one that has to be right, because it is the
 * only object in the vibeverse that everybody in the audience already knows by
 * heart. Three details do almost all of that work, and all three are cheap:
 *
 * 1. **The proportions are the published ones** — 288.6 m long, a 127 m
 *    saucer, 153.6 m nacelles. Guess these and you get a starship. Use them
 *    and you get *the* starship.
 * 2. **The bussard collectors are domes with spikes**, not glowing discs. The
 *    refit has the flat lit ones; the original has the amber ball and the
 *    spike, and that silhouette is the single fastest way to say "1966"
 *    rather than "1979".
 * 3. **The registry is painted on.** `discDecal` conforms a flat, top-down
 *    texture to the saucer's curve so `NCC-1701-V` reads correctly from above
 *    instead of smearing round a lathe's polar UVs. Without it the ship is a
 *    grey model; with it, it is a *ship*.
 *
 * Local axes throughout: **forward is −Z**, up is +Y. That matches what
 * `Object3D.getWorldDirection` returns, so nothing anywhere else has to
 * remember a sign convention.
 */
import * as THREE from "three";
import { PALETTE, type HullClass } from "../types";

// ---------------------------------------------------------------------------
// Materials and helpers
// ---------------------------------------------------------------------------

function hullMat(colour: number, opts: { metal?: number; rough?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: colour,
    metalness: opts.metal ?? 0.22,
    roughness: opts.rough ?? 0.62,
  });
}

function glowMat(colour: number, intensity = 2.2, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: colour,
    emissive: colour,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0,
    transparent: opacity < 1,
    opacity,
  });
}

/** A canvas texture, made once and handed to whoever asked. */
function canvasTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * A flat top-down decal, bent to sit just above a curved surface.
 *
 * Lathe UVs are polar, so painting straight text onto one smears it round the
 * hull. This builds a disc whose *vertices* follow the saucer profile while
 * its *UVs* stay planar, so the registry can be drawn the way it is actually
 * painted: viewed from directly above, reading across the ship.
 */
function discDecal(
  radius: number,
  profileY: (r: number) => number,
  texture: THREE.Texture,
  lift: number,
  flip = false,
): THREE.Mesh {
  const rings = 14;
  const seg = 96;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const r = (i / rings) * radius;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      pos.push(r * cx, profileY(r) + lift, r * cz);
      uv.push(0.5 + 0.5 * (r / radius) * cx, 0.5 + 0.5 * (r / radius) * cz);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      if (flip) idx.push(a, a + 1, b, a + 1, b + 1, b);
      else idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.7,
      metalness: 0.1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * The saucer's registry markings, drawn the way they are painted.
 *
 * Two rows of text across the disc, the pennant stripe, and the faint panel
 * seams that keep 127 metres of hull from reading as a plastic plate.
 */
function registryTexture(registry: string, name: string, top: boolean): THREE.CanvasTexture {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;

    // Panel seams — concentric, and faint enough to be texture rather than
    // decoration.
    g.strokeStyle = "rgba(90,100,112,0.16)";
    g.lineWidth = 2;
    for (let r = 60; r < w / 2; r += 46) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 120, cy + Math.sin(a) * 120);
      g.lineTo(cx + Math.cos(a) * (w / 2 - 8), cy + Math.sin(a) * (w / 2 - 8));
      g.stroke();
    }

    // The pennant: two blue-grey wedges either side of the registry, the mark
    // that reads at a distance long after the text has stopped being legible.
    g.fillStyle = "rgba(66,80,96,0.55)";
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + side * 200, cy - 286);
      g.lineTo(cx + side * 420, cy - 336);
      g.lineTo(cx + side * 420, cy - 294);
      g.lineTo(cx + side * 200, cy - 250);
      g.closePath();
      g.fill();
    }

    g.textAlign = "center";
    g.textBaseline = "middle";
    /*
     * Which way up the text goes.
     *
     * `discDecal`'s UVs, the texture's flip and the way you look at a saucer
     * from above compose to *the identity* — the canvas lands on the hull
     * exactly as drawn, with canvas +Y running toward the bow. So the markings
     * are simply painted the right way up, sat aft of the bridge dome, with
     * the ship's name forward of her registry the way it is on the real one.
     *
     * That was arrived at by photographing the hull and reading it, after two
     * confident derivations produced a mirrored registry and an upside-down
     * one. A reversed NCC-1701 is the most conspicuous possible error on this
     * particular model, so it is worth the two extra captures.
     */
    g.save();
    g.translate(cx, cy);
    // The underside is read from the far side, which mirrors X and nothing else.
    if (!top) g.scale(-1, 1);

    g.fillStyle = "rgba(28,34,44,0.9)";
    g.font = "bold 46px 'Arial Narrow', Impact, sans-serif";
    // Both lines sit well aft of the bridge dome, which is at the middle of
    // the disc and will happily eat a line of text placed near it.
    g.fillText(name, 0, -170);
    g.font = "bold 108px 'Arial Narrow', Impact, sans-serif";
    g.fillText(registry, 0, -258);
    g.restore();
  });
}

/** A band of lit windows, as a texture wrapped round a rim. */
function windowStrip(count: number, colour = "#ffe7bd"): THREE.CanvasTexture {
  const t = canvasTexture(1024, 32, (g, w, h) => {
    g.fillStyle = "#000000";
    g.fillRect(0, 0, w, h);
    g.fillStyle = colour;
    const step = w / count;
    for (let i = 0; i < count; i++) {
      if (Math.random() < 0.12) continue; // a few cabins are dark
      g.fillRect(i * step + step * 0.32, h * 0.36, Math.max(2, step * 0.22), h * 0.28);
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** The blue warp grille that runs down the outboard face of a nacelle. */
function grilleTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = "#0a1830";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = (i / 26) * w;
      const a = 0.55 + 0.45 * Math.sin(i * 1.7);
      g.fillStyle = `rgba(90,170,255,${a})`;
      g.fillRect(x + 1, 6, w / 26 - 3, h - 12);
    }
  });
}

// ---------------------------------------------------------------------------
// Constitution class
// ---------------------------------------------------------------------------

/** Saucer half-thickness as a function of radius, in metres. */
function saucerProfile(r: number): number {
  const R = 63.5;
  const t = Math.min(1, r / R);
  // Flat-ish middle, then a fast fall to a thin rim — the TOS saucer is much
  // flatter across the top than people draw it.
  return 10.5 * Math.cos((t * Math.PI) / 2) ** 0.75 + 0.9 * (1 - t);
}

function buildSaucer(registry: string, name: string): THREE.Group {
  const g = new THREE.Group();
  const R = 63.5;

  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 22; i++) {
    const r = (i / 22) * R;
    pts.push(new THREE.Vector2(Math.max(0.001, r), saucerProfile(r)));
  }
  // The underside: shallower, with the sensor dome hanging under the middle.
  for (let i = 22; i >= 0; i--) {
    const r = (i / 22) * R;
    const t = r / R;
    const under = -(6.5 * Math.cos((t * Math.PI) / 2) ** 0.8 + 0.9 * (1 - t));
    pts.push(new THREE.Vector2(Math.max(0.001, r), under));
  }

  const body = new THREE.Mesh(
    new THREE.LatheGeometry(pts, 72),
    hullMat(PALETTE.hullLight, { rough: 0.55 }),
  );
  g.add(body);

  // Rim: the lit band of windows round the edge of B deck.
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.995, R * 0.995, 3.6, 72, 1, true),
    new THREE.MeshStandardMaterial({
      map: windowStrip(120),
      emissiveMap: windowStrip(120),
      emissive: 0xffffff,
      emissiveIntensity: 1.6,
      color: 0x111318,
      roughness: 0.4,
      side: THREE.DoubleSide,
    }),
  );
  rim.position.y = 0.4;
  g.add(rim);

  // Bridge dome, and the sensor dome under the middle.
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 7.4, 3.4, 24), hullMat(PALETTE.hullLight));
  dome.position.y = saucerProfile(0) + 1.4;
  g.add(dome);
  const domeTop = new THREE.Mesh(new THREE.SphereGeometry(6.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hullMat(PALETTE.hullLight));
  domeTop.position.y = saucerProfile(0) + 3.1;
  g.add(domeTop);

  const sensor = new THREE.Mesh(new THREE.SphereGeometry(8.5, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), hullMat(PALETTE.hullShadow));
  sensor.position.y = -6.4;
  g.add(sensor);
  const sensorLamp = new THREE.Mesh(new THREE.SphereGeometry(3.1, 16, 8), glowMat(0x8fd9ff, 2.6));
  sensorLamp.position.y = -13.4;
  g.add(sensorLamp);

  g.add(discDecal(R * 0.99, saucerProfile, registryTexture(registry, name, true), 0.35));
  g.add(
    discDecal(
      R * 0.99,
      (r) => -(6.5 * Math.cos(((r / R) * Math.PI) / 2) ** 0.8 + 0.9 * (1 - r / R)),
      registryTexture(registry, name, false),
      -0.35,
      true,
    ),
  );

  // Phaser emitter housings — the pair on the underside forward. The beams in
  // combat leave from exactly here, so they need to be somewhere real.
  for (const side of [-1, 1]) {
    const emit = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), hullMat(PALETTE.hullShadow));
    emit.position.set(side * 22, -5.2, -34);
    g.add(emit);
  }

  return g;
}

function buildNacelle(mirrored: number): THREE.Group {
  const g = new THREE.Group();
  const L = 153.6;
  const R = 8.6;

  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L * 0.82, 26), hullMat(PALETTE.hullLight));
  body.rotation.x = Math.PI / 2;
  body.position.z = L * 0.06;
  g.add(body);

  // Aft cap, tapering to the amber exhaust.
  const aft = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.72, R, L * 0.16, 26), hullMat(PALETTE.hullShadow));
  aft.rotation.x = Math.PI / 2;
  aft.position.z = L * 0.55;
  g.add(aft);
  const exhaust = new THREE.Mesh(new THREE.CircleGeometry(R * 0.66, 22), glowMat(0xffb060, 2.4));
  exhaust.position.z = L * 0.63;
  exhaust.rotation.y = Math.PI;
  g.add(exhaust);

  // The bussard collector: an amber dome with a spike, not a flat lit disc.
  // This is the single most 1966 thing on the ship.
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 0.92, 5, 26), hullMat(PALETTE.hullShadow));
  collar.rotation.x = Math.PI / 2;
  collar.position.z = -L * 0.4;
  g.add(collar);

  const bussard = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.98, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: PALETTE.bussard,
      emissive: PALETTE.bussard,
      emissiveIntensity: 2.4,
      roughness: 0.3,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    }),
  );
  bussard.rotation.x = -Math.PI / 2;
  bussard.position.z = -L * 0.42;
  g.add(bussard);

  const spike = new THREE.Mesh(new THREE.ConeGeometry(1.5, 16, 12), hullMat(PALETTE.hullShadow, { metal: 0.6 }));
  spike.rotation.x = -Math.PI / 2;
  spike.position.z = -L * 0.53;
  g.add(spike);

  // The warp grille, on the outboard face only — which is where it is.
  const grille = new THREE.Mesh(
    new THREE.PlaneGeometry(L * 0.5, R * 0.9),
    new THREE.MeshStandardMaterial({
      map: grilleTexture(),
      emissiveMap: grilleTexture(),
      emissive: 0xffffff,
      emissiveIntensity: 1.9,
      color: 0x223,
      roughness: 0.4,
      side: THREE.DoubleSide,
    }),
  );
  grille.rotation.y = mirrored * (Math.PI / 2);
  grille.position.set(mirrored * R * 1.01, 0, L * 0.02);
  g.add(grille);

  // The little pod on top of each nacelle.
  const pod = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.2, 26), hullMat(PALETTE.hullShadow));
  pod.position.set(0, R * 0.92, L * 0.1);
  g.add(pod);

  g.userData.bussard = bussard;
  g.userData.grille = grille;
  g.userData.exhaust = exhaust;
  return g;
}

function buildSecondaryHull(): THREE.Group {
  const g = new THREE.Group();
  const L = 103;
  const R = 12;

  const pts: THREE.Vector2[] = [];
  const shape = (t: number) => {
    // A rounded nose, a long parallel body, a shallow taper to the hangar.
    if (t < 0.12) return R * Math.sqrt(Math.max(0, 1 - ((0.12 - t) / 0.12) ** 2));
    if (t < 0.72) return R;
    return R * (1 - 0.42 * ((t - 0.72) / 0.28));
  };
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    pts.push(new THREE.Vector2(Math.max(0.001, shape(t)), (t - 0.5) * L));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 36), hullMat(PALETTE.hullLight));
  body.rotation.x = -Math.PI / 2;
  g.add(body);

  // The deflector: a copper dish set into the bow, with its spike.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(8.4, 1.5, 10, 30), hullMat(PALETTE.hullShadow, { metal: 0.7 }));
  ring.position.z = -L * 0.485;
  g.add(ring);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(8.2, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.34),
    new THREE.MeshStandardMaterial({
      color: PALETTE.deflector,
      emissive: PALETTE.deflector,
      emissiveIntensity: 1.5,
      metalness: 0.6,
      roughness: 0.35,
    }),
  );
  dish.rotation.x = Math.PI / 2;
  dish.position.z = -L * 0.5;
  g.add(dish);
  const dspike = new THREE.Mesh(new THREE.ConeGeometry(0.9, 11, 10), hullMat(PALETTE.hullShadow, { metal: 0.7 }));
  dspike.rotation.x = -Math.PI / 2;
  dspike.position.z = -L * 0.57;
  g.add(dspike);

  // Hangar deck: the lit slot in the stern.
  const hangar = new THREE.Mesh(new THREE.PlaneGeometry(11, 5.5), glowMat(0xffcf8a, 1.4));
  hangar.position.z = L * 0.5 - 0.4;
  g.add(hangar);

  // Torpedo tubes, under the bow, either side of the dish.
  for (const side of [-1, 1]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 7, 10), hullMat(PALETTE.hullShadow));
    tube.rotation.x = Math.PI / 2;
    tube.position.set(side * 5.4, -8.5, -L * 0.4);
    g.add(tube);
  }

  const strip = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.005, R * 1.005, 2.4, 36, 1, true),
    new THREE.MeshStandardMaterial({
      map: windowStrip(64),
      emissiveMap: windowStrip(64),
      emissive: 0xffffff,
      emissiveIntensity: 1.4,
      color: 0x111318,
      roughness: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.z = -L * 0.1;
  g.add(strip);

  g.userData.dish = dish;
  return g;
}

/**
 * A Constitution-class heavy cruiser, 288.6 m from the bow of the saucer to
 * the aft cap of the nacelles.
 */
export function buildConstitution(registry: string, name: string): THREE.Group {
  const ship = new THREE.Group();

  const saucer = buildSaucer(registry, name);
  saucer.position.set(0, 16, -74);
  ship.add(saucer);

  const secondary = buildSecondaryHull();
  secondary.position.set(0, -22, 28);
  ship.add(secondary);

  // The dorsal: a swept, flattened strut from under the saucer to the top of
  // the engineering hull. Sheared rather than merely rotated, because a
  // straight box between those two points reads as scaffolding.
  const neck = new THREE.Mesh(new THREE.BoxGeometry(5, 46, 30), hullMat(PALETTE.hullLight));
  neck.geometry.translate(0, 0, 0);
  neck.position.set(0, -4, -26);
  neck.rotation.x = -0.42;
  ship.add(neck);

  const nacelles: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const n = buildNacelle(side);
    n.position.set(side * 41, 30, 22);
    ship.add(n);
    nacelles.push(n);

    // Pylon: out and up from the engineering hull to the nacelle.
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(3.2, 62, 26), hullMat(PALETTE.hullLight));
    pylon.position.set(side * 21, 5, 34);
    pylon.rotation.z = side * -0.62;
    pylon.rotation.x = 0.22;
    ship.add(pylon);
  }

  // Normalise to the published 288.6 m: the raw build comes out a little
  // short, and every range in the game is quoted against ship lengths.
  const box = new THREE.Box3().setFromObject(ship);
  const len = box.max.z - box.min.z;
  const k = 288.6 / len;
  ship.scale.setScalar(k);

  ship.userData.kind = "constitution";
  ship.userData.nacelles = nacelles;
  ship.userData.saucer = saucer;
  // Where the beams and torpedoes actually leave from, in local space.
  ship.userData.phaserPorts = [
    new THREE.Vector3(-22, 10, -108).multiplyScalar(k),
    new THREE.Vector3(22, 10, -108).multiplyScalar(k),
  ];
  ship.userData.torpedoPorts = [new THREE.Vector3(0, -30, -22).multiplyScalar(k)];
  return ship;
}

/**
 * A Miranda-class light cruiser: the same saucer and nacelles, no engineering
 * hull, and the rollbar over the top with the torpedo pods on it.
 */
export function buildMiranda(registry: string, name: string): THREE.Group {
  const ship = new THREE.Group();

  const saucer = buildSaucer(registry, name);
  saucer.position.set(0, 0, -18);
  ship.add(saucer);

  for (const side of [-1, 1] as const) {
    const n = buildNacelle(side);
    n.scale.setScalar(0.86);
    n.position.set(side * 44, -24, 34);
    ship.add(n);
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(3, 34, 22), hullMat(PALETTE.hullLight));
    pylon.position.set(side * 30, -14, 26);
    pylon.rotation.z = side * 0.5;
    ship.add(pylon);
  }

  // The rollbar — the whole silhouette of the class.
  const bar = new THREE.Mesh(new THREE.BoxGeometry(96, 4.5, 12), hullMat(PALETTE.hullLight));
  bar.position.set(0, 34, -12);
  ship.add(bar);
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(4, 32, 11), hullMat(PALETTE.hullLight));
    strut.position.set(side * 46, 18, -12);
    ship.add(strut);
    const pod = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 34), hullMat(PALETTE.hullShadow));
    pod.position.set(side * 40, 36, -14);
    ship.add(pod);
  }

  const box = new THREE.Box3().setFromObject(ship);
  const k = 243 / (box.max.z - box.min.z);
  ship.scale.setScalar(k);
  ship.userData.kind = "miranda";
  ship.userData.phaserPorts = [new THREE.Vector3(0, 36, -14).multiplyScalar(k)];
  ship.userData.torpedoPorts = [new THREE.Vector3(0, 34, -20).multiplyScalar(k)];
  return ship;
}

// ---------------------------------------------------------------------------
// Klingon D7 battlecruiser
// ---------------------------------------------------------------------------

/**
 * The D7. A bulbous command pod on a long thin neck, a swept wing body behind
 * it, nacelles at the wingtips — the shape is a bird of prey stooping, and the
 * whole read is that the head is *out in front and undefended*, which is the
 * most Klingon design decision in science fiction.
 */
export function buildD7(): THREE.Group {
  const ship = new THREE.Group();
  const mat = hullMat(PALETTE.klingonHull, { rough: 0.7, metal: 0.3 });
  const dark = hullMat(PALETTE.klingonAccent, { rough: 0.8 });

  // Command pod.
  const head = new THREE.Mesh(new THREE.CylinderGeometry(17, 20, 15, 8), mat);
  head.rotation.x = Math.PI / 2;
  head.position.z = -122;
  ship.add(head);
  const headNose = new THREE.Mesh(new THREE.CylinderGeometry(9, 17, 12, 8), mat);
  headNose.rotation.x = Math.PI / 2;
  headNose.position.z = -135;
  ship.add(headNose);
  const headBack = new THREE.Mesh(new THREE.CylinderGeometry(20, 12, 14, 8), mat);
  headBack.rotation.x = Math.PI / 2;
  headBack.position.z = -108;
  ship.add(headBack);
  const bridgeLight = new THREE.Mesh(new THREE.CircleGeometry(6, 16), glowMat(0xff8844, 1.6));
  bridgeLight.position.set(0, 0, -141.2);
  bridgeLight.rotation.y = Math.PI;
  ship.add(bridgeLight);
  // The forward disruptor cannon, in the throat of the pod.
  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.2, 20, 8), dark);
  cannon.rotation.x = Math.PI / 2;
  cannon.position.set(0, -11, -128);
  ship.add(cannon);

  // Neck.
  const neck = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 96), mat);
  neck.position.z = -56;
  ship.add(neck);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(3.5, 14, 90), dark);
  spine.position.set(0, 5, -56);
  ship.add(spine);

  // Main body: a flattened hexagonal block.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(26, 30, 74, 6), mat);
  body.rotation.x = Math.PI / 2;
  body.rotation.z = Math.PI / 6;
  body.scale.set(1, 1, 0.55);
  body.position.z = 24;
  ship.add(body);
  const stern = new THREE.Mesh(new THREE.CylinderGeometry(20, 26, 20, 6), dark);
  stern.rotation.x = Math.PI / 2;
  stern.rotation.z = Math.PI / 6;
  stern.scale.set(1, 1, 0.55);
  stern.position.z = 68;
  ship.add(stern);
  for (let i = 0; i < 3; i++) {
    const exhaust = new THREE.Mesh(new THREE.CircleGeometry(4.6, 14), glowMat(0xff6a2a, 2.2));
    exhaust.position.set((i - 1) * 12, 0, 78.2);
    ship.add(exhaust);
  }

  // Wings, swept back and down, with the nacelles on the tips.
  for (const side of [-1, 1] as const) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(78, 4.5, 44), mat);
    wing.position.set(side * 52, -4, 30);
    wing.rotation.y = side * 0.34;
    wing.rotation.z = side * 0.14;
    ship.add(wing);

    const nac = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 62, 14), mat);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(side * 86, -8, 26);
    ship.add(nac);
    const front = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glowMat(0xff5522, 1.9, 0.9));
    front.rotation.x = -Math.PI / 2;
    front.position.set(side * 86, -8, -6);
    ship.add(front);
    const rear = new THREE.Mesh(new THREE.CircleGeometry(7.4, 14), glowMat(0xff7a33, 2.2));
    rear.position.set(side * 86, -8, 57.2);
    ship.add(rear);
    // Wing edge trim, so the wings do not read as cardboard.
    const trim = new THREE.Mesh(new THREE.BoxGeometry(78, 2, 6), dark);
    trim.position.set(side * 52, -1.5, 51);
    trim.rotation.y = side * 0.34;
    ship.add(trim);
  }

  const box = new THREE.Box3().setFromObject(ship);
  const k = 228 / (box.max.z - box.min.z);
  ship.scale.setScalar(k);
  ship.userData.kind = "d7";
  ship.userData.phaserPorts = [new THREE.Vector3(0, -11, -140).multiplyScalar(k)];
  ship.userData.torpedoPorts = [new THREE.Vector3(0, -8, -140).multiplyScalar(k)];
  return ship;
}

// ---------------------------------------------------------------------------
// Romulan Bird-of-Prey
// ---------------------------------------------------------------------------

/**
 * The TOS Bird-of-Prey: a broad, flat, slightly organic delta with a bulbous
 * cockpit, and the raptor painted across the underside. The painting is not a
 * flourish — in "Balance of Terror" it is how you know what you are looking at
 * when it finally decloaks under you.
 */
export function buildBirdOfPrey(): THREE.Group {
  const ship = new THREE.Group();
  const mat = hullMat(PALETTE.romulanHull, { rough: 0.5, metal: 0.35 });
  const dark = hullMat(PALETTE.romulanAccent, { rough: 0.6 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(22, 26, 16), mat);
  body.scale.set(1.05, 0.5, 2.1);
  ship.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(11, 42, 16), mat);
  nose.rotation.x = -Math.PI / 2;
  nose.scale.set(1, 0.5, 1);
  nose.position.z = -58;
  ship.add(nose);
  // The plasma weapon port, dead centre of the bow.
  const port = new THREE.Mesh(new THREE.SphereGeometry(5.4, 16, 10), glowMat(PALETTE.plasma, 1.1));
  port.position.z = -76;
  ship.add(port);

  for (const side of [-1, 1] as const) {
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, -30);
    wingShape.quadraticCurveTo(46, -26, 78, 14);
    wingShape.quadraticCurveTo(58, 34, 20, 40);
    wingShape.quadraticCurveTo(6, 20, 0, -30);
    const wing = new THREE.Mesh(
      new THREE.ExtrudeGeometry(wingShape, { depth: 4.5, bevelEnabled: true, bevelSize: 1.6, bevelThickness: 1.2, bevelSegments: 2 }),
      mat,
    );
    wing.rotation.x = Math.PI / 2;
    wing.scale.x = side;
    wing.position.set(side * 14, 2, 6);
    ship.add(wing);

    const nac = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 74, 14), dark);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(side * 62, -4, 22);
    ship.add(nac);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(5.6, 14), glowMat(PALETTE.plasma, 2.1));
    glow.position.set(side * 62, -4, 59.2);
    ship.add(glow);
  }

  // The raptor. Two swept wedges and a body on the underside, in the deep
  // green of the Empire.
  const bird = canvasTexture(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(28,72,54,0.92)";
    g.beginPath();
    g.moveTo(256, 90);
    g.quadraticCurveTo(300, 180, 470, 250);
    g.quadraticCurveTo(330, 250, 292, 300);
    g.quadraticCurveTo(276, 420, 256, 452);
    g.quadraticCurveTo(236, 420, 220, 300);
    g.quadraticCurveTo(182, 250, 42, 250);
    g.quadraticCurveTo(212, 180, 256, 90);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(180,60,40,0.85)";
    g.beginPath();
    g.arc(256, 120, 16, 0, Math.PI * 2);
    g.fill();
  });
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({ map: bird, transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  decal.rotation.set(Math.PI / 2, 0, 0);
  decal.position.set(0, -11.5, 6);
  decal.renderOrder = 2;
  ship.add(decal);

  const box = new THREE.Box3().setFromObject(ship);
  const k = 132 / (box.max.z - box.min.z);
  ship.scale.setScalar(k);
  ship.userData.kind = "birdOfPrey";
  ship.userData.phaserPorts = [new THREE.Vector3(0, 0, -76).multiplyScalar(k)];
  ship.userData.torpedoPorts = [new THREE.Vector3(0, 0, -76).multiplyScalar(k)];
  return ship;
}

// ---------------------------------------------------------------------------
// The rest of the cast
// ---------------------------------------------------------------------------

/** A civilian hull: a bridge module, a spine, and whatever it is hauling. */
export function buildFreighter(): THREE.Group {
  const ship = new THREE.Group();
  const mat = hullMat(0x9aa0a6, { rough: 0.78 });
  const dark = hullMat(0x4a5058, { rough: 0.85 });

  const bridgeBlock = new THREE.Mesh(new THREE.BoxGeometry(26, 18, 30), mat);
  bridgeBlock.position.z = -68;
  ship.add(bridgeBlock);
  const windows = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), glowMat(0xffe0a0, 1.3));
  windows.position.set(0, 4, -83.2);
  windows.rotation.y = Math.PI;
  ship.add(windows);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 120), dark);
  ship.add(spine);
  for (let i = 0; i < 4; i++) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 26, 12), mat);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(i % 2 ? 17 : -17, i < 2 ? 12 : -12, -20 + Math.floor(i / 2) * 40);
    ship.add(pod);
  }
  const engines = new THREE.Mesh(new THREE.BoxGeometry(34, 20, 26), dark);
  engines.position.z = 72;
  ship.add(engines);
  for (const side of [-1, 1]) {
    const bell = new THREE.Mesh(new THREE.CircleGeometry(6.4, 14), glowMat(0x77bbff, 1.8));
    bell.position.set(side * 10, 0, 85.2);
    ship.add(bell);
  }

  const box = new THREE.Box3().setFromObject(ship);
  ship.scale.setScalar(180 / (box.max.z - box.min.z));
  ship.userData.kind = "freighter";
  ship.userData.phaserPorts = [];
  ship.userData.torpedoPorts = [];
  return ship;
}

/**
 * The planet killer. A kilometres-long horn of solid neutronium with a
 * furnace at the wide end.
 *
 * It gets exactly one trick and it is the right one: nothing about it is
 * symmetrical with the ships. No nacelles, no bridge, no windows, no lights
 * except the fire in its mouth. It is not a vessel with a crew — it is a
 * machine that eats, and the model should not offer the eye a single feature
 * that suggests otherwise.
 */
export function buildPlanetKiller(): THREE.Group {
  const ship = new THREE.Group();

  const L = 1400;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    // A cone that flares hard at the mouth and tapers to a blunt tail.
    const r = 40 + 300 * t ** 2.1;
    pts.push(new THREE.Vector2(Math.max(1, r), (t - 0.5) * L));
  }
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(pts, 40),
    new THREE.MeshStandardMaterial({ color: PALETTE.machineHull, roughness: 0.95, metalness: 0.55, flatShading: true }),
  );
  body.rotation.x = Math.PI / 2;
  // The mouth points forward.
  body.rotation.z = 0;
  body.scale.z = -1;
  ship.add(body);

  // Pitting: the hull is a mess of impact craters after eating a dozen
  // systems. Boxes half-sunk into the surface, which at this scale reads as
  // damage rather than as boxes.
  const rnd = (n: number) => Math.sin(n * 12.9898) * 43758.5453 % 1;
  for (let i = 0; i < 90; i++) {
    const t = Math.abs(rnd(i * 3.1)) ;
    const a = Math.abs(rnd(i * 7.7)) * Math.PI * 2;
    const r = 40 + 300 * t ** 2.1;
    const size = 12 + Math.abs(rnd(i * 1.3)) * 40;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color: 0x37332e, roughness: 1, metalness: 0.4, flatShading: true }),
    );
    chunk.position.set(Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94, -(t - 0.5) * L);
    chunk.rotation.set(a, t * 6, i);
    ship.add(chunk);
  }

  // The furnace.
  const maw = new THREE.Mesh(
    new THREE.CircleGeometry(320, 40),
    new THREE.MeshBasicMaterial({ color: PALETTE.machineMaw, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
  );
  maw.position.z = -L * 0.46;
  maw.rotation.y = Math.PI;
  ship.add(maw);
  const mawGlow = new THREE.PointLight(0xffdca0, 6, 5000, 2);
  mawGlow.position.z = -L * 0.5;
  ship.add(mawGlow);

  ship.userData.kind = "planetKiller";
  ship.userData.maw = maw;
  ship.userData.phaserPorts = [new THREE.Vector3(0, 0, -L * 0.46)];
  ship.userData.torpedoPorts = [];
  return ship;
}

/**
 * A living thing.
 *
 * The most important property of this model is that **nothing about it is
 * bilaterally symmetrical and nothing about it is straight**. Every other hull
 * in this file is a machine: mirrored, panelled, with an obvious front. This
 * one is a lump of hot rock that moves. If the player's first glance reads
 * "ship", the episode it appears in has already failed, because that episode
 * is entirely about whether you shoot before you look.
 *
 * It glows from within rather than being lit from without — silicon at a
 * temperature that would ruin a hull, banked in the crevices where a
 * creature's heat would actually show.
 */
export function buildCreature(): THREE.Group {
  const g = new THREE.Group();
  // 180 m across. Big enough to read on a viewscreen at one magnification —
  // which matters, because the player has to decide what it is from that
  // picture before deciding whether to shoot it.
  const R = 90;

  const geo = new THREE.IcosahedronGeometry(R, 3);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Deterministic lumpiness. Three octaves of cheap trig noise is plenty —
  // this is a rock, and rocks are not subtle.
  const wobble = (p: THREE.Vector3) =>
    0.22 * Math.sin(p.x * 0.055 + 1.3) * Math.cos(p.y * 0.048) +
    0.13 * Math.sin(p.y * 0.11 + 2.1) * Math.cos(p.z * 0.095) +
    0.07 * Math.sin(p.z * 0.21 + 0.7) * Math.cos(p.x * 0.19);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + wobble(v);
    // Flattened, and heavier underneath: it moves along things rather than
    // through them.
    pos.setXYZ(i, v.x * k * 1.12, v.y * k * 0.62, v.z * k);
  }
  geo.computeVertexNormals();

  const body = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x5f4a3a, roughness: 1, metalness: 0.1, flatShading: true }),
  );
  g.add(body);

  // Banked heat in the crevices. Small emissive nodules rather than a texture:
  // they catch the eye as the thing turns, which a baked map cannot do.
  const hot: THREE.Mesh[] = [];
  const glowGeo = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < 42; i++) {
    // Fibonacci sphere, so the nodules are evenly spread without clumping.
    const t = (i + 0.5) / 42;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    v.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.62, Math.sin(phi) * Math.sin(theta));
    const k = 1 + wobble(v.clone().multiplyScalar(R));
    const node = new THREE.Mesh(
      glowGeo,
      new THREE.MeshStandardMaterial({
        color: 0xff7a2a,
        emissive: 0xff6a1a,
        emissiveIntensity: 2.6,
        roughness: 0.6,
      }),
    );
    node.position.copy(v).multiplyScalar(R * k * 0.97);
    node.scale.setScalar(5 + (i % 5) * 2.8);
    node.userData.phase = i * 0.7;
    g.add(node);
    hot.push(node);
  }

  g.userData.kind = "creature";
  g.userData.hot = hot;
  g.userData.body = body;
  /*
   * A generic per-frame hook the fleet calls on any hull that declares one.
   *
   * It exists for this model above all: a rock that does not move is a rock,
   * and the single cheapest thing that makes something read as *alive* is that
   * it breathes. The nodules brighten out of phase with one another and the
   * whole body swells about four percent — barely visible, and the difference
   * between a creature and an asteroid with lights on.
   */
  g.userData.animate = (t: number) => {
    const breath = 1 + 0.04 * Math.sin(t * 0.9);
    body.scale.setScalar(breath);
    for (const node of hot) {
      const phase = node.userData.phase as number;
      const heat = 0.55 + 0.45 * Math.sin(t * 1.6 + phase);
      (node.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + heat * 2.6;
      node.scale.setScalar((5 + (phase % 4) * 2.4) * (0.9 + heat * 0.25));
    }
  };
  // It has no weapons. Not "weapons that do nothing" — none, so that anything
  // asking where its guns are gets an honest empty answer.
  g.userData.phaserPorts = [];
  g.userData.torpedoPorts = [];
  return g;
}

export function buildHull(kind: HullClass, registry: string, name: string): THREE.Group {
  switch (kind) {
    case "constitution":
      return buildConstitution(registry, name);
    case "miranda":
      return buildMiranda(registry, name);
    case "d7":
      return buildD7();
    case "birdOfPrey":
      return buildBirdOfPrey();
    case "freighter":
      return buildFreighter();
    case "planetKiller":
      return buildPlanetKiller();
    case "creature":
      return buildCreature();
    default:
      return buildFreighter();
  }
}

// ---------------------------------------------------------------------------
// Deflector screens
// ---------------------------------------------------------------------------

/**
 * The shield bubble.
 *
 * Invisible until something hits it, and then it is only bright *where* the
 * hit landed — a ring that spreads from the impact point and fades. That is
 * both what the show does and what the game needs, because it tells you which
 * facing just took the shot without a single word of HUD.
 */
export function buildShieldBubble(radius: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uHit: { value: new THREE.Vector3(0, 0, 1) },
      uHitAge: { value: 99 },
      uColour: { value: new THREE.Color(0x7fd8ff) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vLocal;
      varying vec3 vViewDir;
      void main() {
        vLocal = normalize(position);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vLocal;
      varying vec3 vViewDir;
      uniform float uTime;
      uniform float uStrength;
      uniform float uHitAge;
      uniform vec3 uHit;
      uniform vec3 uColour;

      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 2.6);

        // The hexagonal weave, only visible where the screen is excited.
        vec3 p = vLocal * 26.0;
        vec2 q = vec2(p.x + p.z * 0.5, p.y);
        vec2 g = abs(fract(q) - 0.5);
        float grid = smoothstep(0.42, 0.5, max(g.x, g.y));

        // Impact ring: expands from the hit point and dies in about a second.
        float d = acos(clamp(dot(normalize(vLocal), normalize(uHit)), -1.0, 1.0));
        float ring = 0.0;
        if (uHitAge < 1.2) {
          float r = uHitAge * 2.4;
          ring = smoothstep(0.34, 0.0, abs(d - r)) * (1.0 - uHitAge / 1.2);
          ring += smoothstep(1.1, 0.0, d) * exp(-uHitAge * 6.0) * 0.8;
        }

        // Nearly invisible at rest. An always-on bubble turns every ship into
        // a snow globe and hides the hull the model was built for; the screens
        // are supposed to be something you infer from the *hits*, and only see
        // directly when they are being hit.
        float a = (fres * 0.035 + grid * fres * 0.05) * uStrength + ring * 0.9;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColour * (0.7 + ring * 1.8), a);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 26), material);
  mesh.renderOrder = 6;
  return mesh;
}
