/**
 * The bridge. A circular room eleven metres across with six people in it, and
 * the only place in this world the player actually is.
 *
 * The set is reconstructed from the 1966 plans rather than from memory, and
 * the differences between those two things are most of what makes a room read
 * as *that* room:
 *
 * - **The pit is real.** The centre of the bridge is a step *down*, and the
 *   perimeter stations stand on a raised ring behind a rail. Build it flat and
 *   every proportion is right and the room is still wrong, because the captain
 *   is supposed to be sitting below the officers who report to him.
 * - **The helm is between the captain and the screen.** Two heads in the
 *   bottom third of frame, backs to you, silhouetted against the viewscreen.
 *   That is the composition of nearly every bridge shot ever filmed, and it
 *   comes free the moment the console is in the right place.
 * - **The walls are warm.** Everyone remembers the bridge as grey. It is a
 *   warm sand, and the railing is a dark coral rather than a fire-engine red.
 *   Get those two wrong and no amount of correct geometry rescues it.
 * - **Nothing is still.** Every console has buttons blinking on its own
 *   schedule. It costs one canvas redraw per frame spread across eight
 *   stations, and it is the difference between a set and a photograph of one.
 *
 * The viewscreen is a plane with the space render target on it. That is the
 * entire trick of this world, and it is four lines of code — see `screenMat`.
 */
import * as THREE from "three";
import {
  BUTTON_COLOURS,
  PALETTE,
  clamp,
  type AlertLevel,
  type BridgeService,
  type System,
  type TrekCtx,
  type ViewscreenService,
} from "../types";

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

interface LivePanel {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  draw: (t: number) => void;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/**
 * A console face: the jelly-bean button grid.
 *
 * Redrawn on demand with a different random phase, which is how the blinking
 * happens. The buttons are large, chunky and *unlabelled*, because that is
 * what they are — nobody on that show ever pressed a button with a word on it.
 */
function makeButtonPanel(seed: number, w = 512, h = 256): LivePanel {
  const [canvas, g] = makeCanvas(w, h);
  const rows = 4;
  const cols = 11;
  const cells: { x: number; y: number; w: number; h: number; colour: string; rate: number; phase: number }[] = [];
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const padX = w * 0.05;
  const padY = h * 0.12;
  const cw = (w - padX * 2) / cols;
  const ch = (h - padY * 2) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rnd() < 0.12) continue;
      cells.push({
        x: padX + c * cw + cw * 0.12,
        y: padY + r * ch + ch * 0.16,
        w: cw * 0.76 * (rnd() < 0.15 ? 2 : 1),
        h: ch * 0.68,
        colour: BUTTON_COLOURS[Math.floor(rnd() * BUTTON_COLOURS.length)],
        rate: 0.25 + rnd() * 2.4,
        phase: rnd() * 10,
      });
    }
  }

  const draw = (t: number) => {
    g.fillStyle = "#0a0a0e";
    g.fillRect(0, 0, w, h);
    // Faint panel seams.
    g.strokeStyle = "rgba(120,120,140,0.14)";
    g.lineWidth = 2;
    g.strokeRect(4, 4, w - 8, h - 8);
    for (const cell of cells) {
      const lit = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * cell.rate + cell.phase));
      g.globalAlpha = 0.28 + lit * 0.72;
      g.fillStyle = cell.colour;
      g.fillRect(cell.x, cell.y, cell.w, cell.h);
      // A highlight along the top edge — these are lit tiles, not stickers.
      g.globalAlpha = 0.18 + lit * 0.3;
      g.fillStyle = "#ffffff";
      g.fillRect(cell.x, cell.y, cell.w, Math.max(1, cell.h * 0.16));
    }
    g.globalAlpha = 1;
  };

  draw(0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, texture, draw };
}

/**
 * A station readout: the scrolling black-and-white schematics on the screens
 * above each console. Deliberately illegible — they are texture, not UI.
 */
function makeReadout(seed: number, tint = "#8fd8ff"): LivePanel {
  const w = 256;
  const h = 160;
  const [canvas, g] = makeCanvas(w, h);
  let s = seed;
  const rnd = () => {
    s = (s * 22695477 + 1) >>> 0;
    return s / 4294967296;
  };
  const bars = Array.from({ length: 18 }, () => ({ v: rnd(), rate: 0.4 + rnd() * 2 }));
  const kind = Math.floor(rnd() * 3);

  const draw = (t: number) => {
    g.fillStyle = "#05070c";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = tint;
    g.fillStyle = tint;

    if (kind === 0) {
      // A bar chart that breathes.
      const bw = w / bars.length;
      for (let i = 0; i < bars.length; i++) {
        const v = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * bars[i].rate + i));
        g.globalAlpha = 0.5 + v * 0.5;
        g.fillRect(i * bw + 1, h - v * h * 0.85, bw - 2, v * h * 0.85);
      }
    } else if (kind === 1) {
      // A sweeping trace.
      g.globalAlpha = 0.85;
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const y = h / 2 + Math.sin(x * 0.07 + t * 2.2) * h * 0.22 * Math.sin(x * 0.013 + t * 0.6);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      const sweep = ((t * 60) % w) | 0;
      g.globalAlpha = 0.35;
      g.fillRect(sweep, 0, 3, h);
    } else {
      // Concentric scan rings with a rotating bearing line.
      g.globalAlpha = 0.6;
      g.lineWidth = 1.5;
      for (let r = 16; r < h * 0.6; r += 16) {
        g.beginPath();
        g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
        g.stroke();
      }
      const a = t * 1.6;
      g.beginPath();
      g.moveTo(w / 2, h / 2);
      g.lineTo(w / 2 + Math.cos(a) * h * 0.55, h / 2 + Math.sin(a) * h * 0.55);
      g.stroke();
      g.globalAlpha = 0.9;
      g.fillRect(w / 2 + Math.cos(a * 0.7) * 40 - 2, h / 2 + Math.sin(a * 0.7) * 30 - 2, 4, 4);
    }
    g.globalAlpha = 1;
    // Scan lines, because these are CRTs in 2266 the same as they were in 1966.
    g.fillStyle = "rgba(0,0,0,0.28)";
    for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  };

  draw(0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, texture, draw };
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

interface Crewman {
  group: THREE.Group;
  head: THREE.Object3D;
  arms: [THREE.Object3D, THREE.Object3D];
  phase: number;
  /** Set while this officer is speaking, so the right person turns round. */
  attention: number;
}

/**
 * One officer, at eleven primitives.
 *
 * They are seen almost entirely from behind at four metres, so detail spent on
 * faces is detail wasted. What is *not* wasted: the tunic colour, the black
 * collar band, and hands that move. A still figure at a console is a mannequin
 * no matter how good the head is.
 */
function buildCrewman(tunic: number, skin: number, seated: boolean): Crewman {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: tunic, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: PALETTE.trousers, roughness: 0.9 });
  const flesh = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x1c1512, roughness: 0.95 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.34, 4, 12), uniform);
  torso.scale.set(1.1, 1, 0.72);
  torso.position.y = seated ? 0.94 : 1.18;
  group.add(torso);

  // The black collar band — a tiny detail that does an enormous amount of
  // work, because it is the one piece of a TOS uniform that reads at distance.
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.175, 0.07, 14), dark);
  collar.scale.z = 0.8;
  collar.position.y = (seated ? 0.94 : 1.18) + 0.29;
  group.add(collar);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.07, 0.08, 10), flesh);
  neck.position.y = collar.position.y + 0.06;
  group.add(neck);

  const head = new THREE.Group();
  head.position.y = neck.position.y + 0.13;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.108, 18, 14), flesh);
  skull.scale.set(0.92, 1.12, 1);
  head.add(skull);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.113, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), hair);
  cap.scale.set(0.94, 1.05, 1.02);
  cap.position.y = 0.012;
  head.add(cap);
  group.add(head);

  const arms: [THREE.Object3D, THREE.Object3D] = [new THREE.Group(), new THREE.Group()];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const shoulder = arms[i];
    shoulder.position.set(side * 0.21, torso.position.y + 0.17, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.2, 3, 8), uniform);
    upper.position.y = -0.13;
    shoulder.add(upper);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.2, 3, 8), uniform);
    fore.position.set(0, -0.3, 0.1);
    fore.rotation.x = -0.9;
    shoulder.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), flesh);
    hand.position.set(0, -0.36, 0.27);
    shoulder.add(hand);
    group.add(shoulder);
  }

  if (seated) {
    for (const side of [-1, 1]) {
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.22, 3, 8), dark);
      thigh.rotation.x = Math.PI / 2;
      thigh.position.set(side * 0.1, 0.66, -0.17);
      group.add(thigh);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.26, 3, 8), dark);
      shin.position.set(side * 0.1, 0.44, -0.29);
      group.add(shin);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.2), new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.6 }));
      boot.position.set(side * 0.1, 0.26, -0.33);
      group.add(boot);
    }
  } else {
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.56, 3, 8), dark);
      leg.position.set(side * 0.1, 0.48, 0);
      group.add(leg);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.6 }));
      boot.position.set(side * 0.1, 0.06, 0.03);
      group.add(boot);
    }
  }

  return { group, head, arms, phase: Math.random() * 10, attention: 0 };
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

const ROOM_R = 5.6;
const PIT_R = 3.5;
const RING_Y = 0.4;

export function createBridge(ctx: TrekCtx): System {
  const { bridge, rng, quality } = ctx;
  const panels: LivePanel[] = [];
  const alertPanels: THREE.Mesh[] = [];
  const crew: Record<string, Crewman> = {};
  const roomLights: THREE.Light[] = [];
  const ceilingMats: THREE.MeshStandardMaterial[] = [];

  const sand = new THREE.MeshStandardMaterial({ color: PALETTE.bulkhead, roughness: 0.92 });
  const sandDark = new THREE.MeshStandardMaterial({ color: PALETTE.bulkheadDark, roughness: 0.95 });
  const black = new THREE.MeshStandardMaterial({ color: PALETTE.consoleBody, roughness: 0.7, metalness: 0.1 });
  const trim = new THREE.MeshStandardMaterial({ color: PALETTE.consoleTrim, roughness: 0.6, metalness: 0.35 });
  const coral = new THREE.MeshStandardMaterial({ color: PALETTE.railing, roughness: 0.55, metalness: 0.2 });
  const deckMat = new THREE.MeshStandardMaterial({ color: PALETTE.deck, roughness: 0.95 });

  // -- Deck, ring and wall ---------------------------------------------------
  const pit = new THREE.Mesh(new THREE.CircleGeometry(PIT_R, 48), deckMat);
  pit.rotation.x = -Math.PI / 2;
  bridge.add(pit);

  const ring = new THREE.Mesh(new THREE.RingGeometry(PIT_R, ROOM_R, 48), deckMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = RING_Y;
  bridge.add(ring);

  const riser = new THREE.Mesh(new THREE.CylinderGeometry(PIT_R, PIT_R, RING_Y, 48, 1, true), sandDark);
  riser.position.y = RING_Y / 2;
  riser.material.side = THREE.DoubleSide;
  bridge.add(riser);

  // The wall: sand panels with vertical dividers, and the black band the
  // stations are set into.
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(ROOM_R, ROOM_R, 3.1, 64, 1, true), sand);
  wall.material.side = THREE.BackSide;
  wall.position.y = RING_Y + 1.55;
  bridge.add(wall);

  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const divider = new THREE.Mesh(new THREE.BoxGeometry(0.07, 3.0, 0.09), sandDark);
    divider.position.set(Math.sin(a) * (ROOM_R - 0.05), RING_Y + 1.55, Math.cos(a) * (ROOM_R - 0.05));
    divider.rotation.y = a;
    bridge.add(divider);
  }

  // Ceiling: a shallow dome with a lit ring under it. The ring is the room's
  // main light source and the thing that turns red on alert.
  // Warm, closed, and not black. The captain's eyeline sits low in a room
  // three and a half metres tall, so the ceiling is a third of every frame —
  // leave it open and a third of the picture is a void with a set underneath
  // it. Flat rather than domed, because the set is flat: a shallow lid with a
  // lighting grid in it.
  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(ROOM_R, 48),
    new THREE.MeshStandardMaterial({ color: 0x5c5344, roughness: 1 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3.46;
  bridge.add(ceiling);

  for (const [radius, width, base] of [
    [3.2, 0.34, 0.75],
    [1.7, 0.3, 0.6],
  ] as const) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffeed6,
      emissive: 0xffeed6,
      emissiveIntensity: base,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    mat.userData.base = base;
    ceilingMats.push(mat);
    const band = new THREE.Mesh(new THREE.RingGeometry(radius - width, radius, 48), mat);
    band.rotation.x = Math.PI / 2;
    band.position.y = 3.42;
    bridge.add(band);
  }

  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfff0d8,
      emissive: 0xfff0d8,
      emissiveIntensity: 1.1,
      roughness: 1,
    });
    mat.userData.base = 1.1;
    ceilingMats.push(mat);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.36), mat);
    lamp.position.set(Math.sin(a) * (ROOM_R - 0.75), 3.28, Math.cos(a) * (ROOM_R - 0.75));
    lamp.rotation.y = a;
    bridge.add(lamp);
  }

  const keyLight = new THREE.PointLight(0xfff0dc, 26, 20, 2);
  keyLight.position.set(0, 3.0, 0);
  bridge.add(keyLight);
  roomLights.push(keyLight);
  const fillLight = new THREE.PointLight(0xffe6c8, 9, 16, 2);
  fillLight.position.set(0, 1.6, -2.4);
  bridge.add(fillLight);
  roomLights.push(fillLight);
  // A warm ambient floor. Too high to be physical; exactly right to keep the
  // far side of the room from going to black when the alert lighting drops.
  const ambient = new THREE.AmbientLight(0x5e5648, 1.1);
  bridge.add(ambient);

  // -- Railing ---------------------------------------------------------------
  // The horseshoe: it runs round the *back* of the pit and stops either side of
  // the helm, which is what gives the room its open front.
  //
  // Angles here are measured with `(sin a, cos a)`, so **a = 0 is aft** — the
  // wall behind the captain — and **a = π is the viewscreen**. Getting that
  // backwards puts the railing straight across the middle of the picture and
  // the turbolift where the main viewer should be, which is exactly what the
  // first build of this room did.
  {
    const from = Math.PI + 0.52;
    const to = 3 * Math.PI - 0.52;
    const curve = new THREE.CatmullRomCurve3(
      Array.from({ length: 40 }, (_, i) => {
        const a = from + (i / 39) * (to - from);
        return new THREE.Vector3(Math.sin(a) * (PIT_R + 0.14), RING_Y + 0.62, Math.cos(a) * (PIT_R + 0.14));
      }),
    );
    const rail = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.055, 8, false), coral);
    bridge.add(rail);
    for (let i = 0; i < 11; i++) {
      const a = from + (i / 10) * (to - from);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.62, 8), coral);
      post.position.set(Math.sin(a) * (PIT_R + 0.14), RING_Y + 0.31, Math.cos(a) * (PIT_R + 0.14));
      bridge.add(post);
    }
    // The kick panel under the rail, in the same coral.
    const kick = new THREE.Mesh(new THREE.CylinderGeometry(PIT_R + 0.16, PIT_R + 0.16, 0.2, 48, 1, true, from, to - from), coral);
    kick.position.y = RING_Y + 0.1;
    kick.material.side = THREE.DoubleSide;
    bridge.add(kick);
  }

  // -- Viewscreen ------------------------------------------------------------
  // The four lines this entire world is built around.
  const rtSize = quality === "low" ? [768, 326] : quality === "ultra" ? [1600, 680] : [1280, 544];
  const target = new THREE.WebGLRenderTarget(rtSize[0], rtSize[1], {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
  });
  const screenMat = new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: false });
  const SCREEN_W = 4.6;
  const SCREEN_H = SCREEN_W / 2.35;
  // Note the Z: the screen is a *flat* rectangle inside a *round* room, so it
  // cannot sit on the wall radius — at 2.3 m off centre the wall has already
  // curved past it and the corners would poke through into the corridor. 4.8
  // is where a 4.6 m screen still clears the curve, and it puts the picture
  // 5.5 m from the chair: about 47% of the frame's width, which is the TOS
  // composition.
  const SCREEN_Z = -4.8;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat);
  screen.position.set(0, RING_Y + 1.45, SCREEN_Z);
  bridge.add(screen);

  // The bezel: a heavy bronze surround, wider at the bottom, on a black
  // recess. The three layers have to stack in this order and it is easy to get
  // backwards — the camera is at +Z, so *more negative is further away*: the
  // recess sits behind the screen, and the bezel in front of it.
  {
    const recess = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_W + 0.3, SCREEN_H + 0.55),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.9 }),
    );
    recess.position.set(0, RING_Y + 1.44, SCREEN_Z - 0.08);
    bridge.add(recess);
    const bezelMat = new THREE.MeshStandardMaterial({ color: PALETTE.screenBezel, roughness: 0.42, metalness: 0.6 });
    const edges: [number, number, number, number][] = [
      [SCREEN_W + 0.34, 0.17, 0, SCREEN_H / 2 + 0.085],
      [SCREEN_W + 0.34, 0.3, 0, -SCREEN_H / 2 - 0.15],
      [0.17, SCREEN_H + 0.34, -SCREEN_W / 2 - 0.085, 0],
      [0.17, SCREEN_H + 0.34, SCREEN_W / 2 + 0.085, 0],
    ];
    for (const [w, h, x, y] of edges) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.14), bezelMat);
      bar.position.set(x, RING_Y + 1.45 + y, SCREEN_Z + 0.1);
      bridge.add(bar);
    }
  }

  // The screen throws light back into the room, which is most of why a
  // viewscreen feels like a window rather than a poster.
  const screenLight = new THREE.PointLight(0x8fb8ff, 3.2, 12, 2);
  screenLight.position.set(0, RING_Y + 1.4, SCREEN_Z + 1.1);
  bridge.add(screenLight);

  // -- Helm / navigation console --------------------------------------------
  const helmGroup = new THREE.Group();
  {
    const arcFrom = -0.86;
    const arcTo = 0.86;
    const R = 2.35;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.42, R + 0.5, 0.92, 40, 1, true, Math.PI + arcFrom, arcTo - arcFrom),
      black,
    );
    body.material.side = THREE.DoubleSide;
    body.position.y = 0.46;
    helmGroup.add(body);
    const inner = new THREE.Mesh(
      new THREE.CylinderGeometry(R - 0.42, R - 0.42, 0.92, 40, 1, true, Math.PI + arcFrom, arcTo - arcFrom),
      black,
    );
    inner.material.side = THREE.DoubleSide;
    inner.position.y = 0.46;
    helmGroup.add(inner);

    // A bright band round the outside of the horseshoe. The captain looks at
    // the *back* of this console all episode, and without the trim it is a
    // black bar across the bottom third of every single frame.
    for (const [radius, y] of [
      [R + 0.47, 0.9],
      [R + 0.47, 0.06],
    ] as const) {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.1, 40, 1, true, Math.PI + arcFrom, arcTo - arcFrom),
        trim,
      );
      band.material.side = THREE.DoubleSide;
      band.position.y = y;
      helmGroup.add(band);
    }

    // The slanted working surface, in segments so the buttons follow the arc.
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + arcFrom + ((i + 0.5) / 7) * (arcTo - arcFrom);
      const panel = makeButtonPanel(0x51 + i * 7717, 256, 128);
      panels.push(panel);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.66, 0.62),
        new THREE.MeshStandardMaterial({ map: panel.texture, emissiveMap: panel.texture, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.5 }),
      );
      face.position.set(Math.sin(a) * R, 0.9, Math.cos(a) * R);
      // Yaw round the arc first, then tilt the working surface back toward the
      // officer sitting at it. YXZ, or the tilt happens in the wrong frame and
      // the panels fan out like a hand of cards.
      face.rotation.order = "YXZ";
      face.rotation.set(-1.02, a + Math.PI, 0, "YXZ");
      helmGroup.add(face);
    }

    // The astrogator: the lit column in the middle of the horseshoe that
    // Chekov leans into. Kept low on purpose — at head height it stands
    // directly between the captain and the bottom of the viewscreen, which is
    // where half the action happens.
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.42, 20), trim);
    column.position.set(0, 0.86, -R + 0.05);
    helmGroup.add(column);
    const astro = makeReadout(0x9911, "#ffd08a");
    panels.push(astro);
    const astroFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 24),
      new THREE.MeshStandardMaterial({ map: astro.texture, emissiveMap: astro.texture, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.4 }),
    );
    astroFace.position.set(0, 1.075, -R + 0.05);
    astroFace.rotation.x = -Math.PI / 2.4;
    helmGroup.add(astroFace);
  }
  helmGroup.position.set(0, 0, -0.15);
  bridge.add(helmGroup);

  // Helm and navigator, backs to the captain.
  {
    const seats: [string, number, number][] = [
      ["SULU", -0.62, PALETTE.tunicGold],
      ["CHEKOV", 0.62, PALETTE.tunicGold],
    ];
    for (const [who, x, tunic] of seats) {
      const c = buildCrewman(tunic, who === "SULU" ? PALETTE.skinDark : PALETTE.skinLight, true);
      c.group.position.set(x, 0, -1.42);
      c.group.rotation.y = Math.PI + (x < 0 ? 0.18 : -0.18);
      // The chair.
      const chair = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.46), black);
      chair.position.set(x, 0.62, -1.4);
      bridge.add(chair);
      // Low-backed. A tall chair back at this distance is a black slab across
      // a quarter of the frame, and the officer sitting in it disappears.
      const backRest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.08), black);
      backRest.position.set(x, 0.79, -1.14);
      bridge.add(backRest);
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.6, 10), trim);
      stalk.position.set(x, 0.3, -1.4);
      bridge.add(stalk);
      bridge.add(c.group);
      crew[who] = c;
    }
  }

  // -- The captain's chair ---------------------------------------------------
  {
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.14, 0.62), black);
    seat.position.y = 0.5;
    chair.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.86, 0.14), black);
    back.position.set(0, 0.95, 0.3);
    chair.add(back);
    const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.16), black);
    headrest.position.set(0, 1.44, 0.3);
    chair.add(headrest);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 0.5, 16), trim);
    base.position.y = 0.25;
    chair.add(base);
    // The armrest panels — the only console in the room the captain touches,
    // and the reason a Star Trek captain never has to stand up.
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.56), black);
      arm.position.set(side * 0.4, 0.74, 0.02);
      chair.add(arm);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), black);
      brace.position.set(side * 0.4, 0.62, 0.24);
      chair.add(brace);
      const panel = makeButtonPanel(0x1701 + side * 91, 128, 64);
      panels.push(panel);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.13, 0.4),
        new THREE.MeshStandardMaterial({ map: panel.texture, emissiveMap: panel.texture, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5 }),
      );
      face.position.set(side * 0.4, 0.795, 0.02);
      face.rotation.x = -Math.PI / 2;
      face.rotation.z = Math.PI / 2;
      chair.add(face);
    }
    chair.position.set(0, 0, 0.85);
    bridge.add(chair);
  }

  // -- Perimeter stations ----------------------------------------------------
  /**
   * Eight stations, at the angles they occupy on the set.
   *
   * Same convention as the railing: **a = 0 is aft, a = π is the viewscreen**,
   * and positive is starboard. So science sits forward on your right, where
   * Spock can turn from the hooded viewer straight to the screen; engineering
   * is behind your left shoulder; and nothing at all stands between π ± 0.5,
   * because that arc is the main viewer.
   */
  const STATIONS: { name: string; angle: number; crew?: string; tunic?: number; skin?: number; scope?: boolean }[] = [
    { name: "SCIENCE", angle: 2.15, crew: "SPOCK", tunic: PALETTE.tunicBlue, skin: PALETTE.skinVulcan, scope: true },
    { name: "COMMUNICATIONS", angle: 1.35, crew: "UHURA", tunic: PALETTE.tunicRed, skin: PALETTE.skinDark },
    { name: "LIBRARY", angle: 0.66 },
    { name: "ENGINEERING", angle: -1.35, crew: "SCOTT", tunic: PALETTE.tunicRed, skin: PALETTE.skinLight },
    { name: "DAMAGE CONTROL", angle: -0.66 },
    { name: "DEFENSE", angle: -2.15 },
    { name: "ENVIRONMENT", angle: -2.68 },
    { name: "GANG WAY", angle: 2.68 },
  ];

  for (const st of STATIONS) {
    const a = st.angle;
    const sx = Math.sin(a);
    const cz = Math.cos(a);
    const group = new THREE.Group();
    group.position.set(sx * (ROOM_R - 0.62), RING_Y, cz * (ROOM_R - 0.62));
    group.rotation.y = a;

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.98, 0.72), black);
    body.position.y = 0.49;
    group.add(body);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.06, 0.8), trim);
    lip.position.y = 0.99;
    group.add(lip);
    // A second bright edge at the kick. Two lit lines are what make a dark
    // console read as an object with a shape rather than a rectangle of night.
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.09, 0.78), trim);
    base.position.y = 0.05;
    group.add(base);

    const panel = makeButtonPanel(0x2001 + Math.round(a * 1000), 512, 200);
    panels.push(panel);
    // The sloped working surface, sitting on the lip and tilted up toward
    // whoever is standing at it. Local +Z is *outward*, so this has to clear
    // the console body (which spans ±0.36) rather than sit inside it.
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(1.42, 0.5),
      new THREE.MeshStandardMaterial({ map: panel.texture, emissiveMap: panel.texture, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.5 }),
    );
    face.position.set(0, 1.07, -0.1);
    face.rotation.x = -1.28;
    group.add(face);

    // The upright display above the console.
    const backing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.15, 0.12), black);
    backing.position.set(0, 1.72, 0.28);
    group.add(backing);
    for (let i = 0; i < 3; i++) {
      const readout = makeReadout(0x33 + i * 3121 + Math.round(a * 700), i === 1 ? "#ffd08a" : "#8fd8ff");
      panels.push(readout);
      const scr = new THREE.Mesh(
        new THREE.PlaneGeometry(0.4, 0.3),
        new THREE.MeshBasicMaterial({ map: readout.texture, toneMapped: false }),
      );
      // Clear of the backing's front face (0.22) or the two z-fight and the
      // screens flicker between black and picture as the head moves.
      scr.position.set((i - 1) * 0.46, 1.86, 0.16);
      scr.rotation.y = Math.PI;
      group.add(scr);
    }
    // Two alert strips per station: these are what actually go red.
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.6 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.1), mat);
      strip.position.set(side * 0.79, 1.72, 0.2);
      group.add(strip);
      alertPanels.push(strip);
    }

    if (st.scope) {
      // Spock's hooded viewer. The blue glow on his face is the single most
      // recognisable lighting cue on the entire set — so the hood leans back
      // *into* the room, toward the officer, rather than sitting flat on the
      // console where nothing would ever be lit by it.
      const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.32, 16, 1, true), black);
      hood.material.side = THREE.DoubleSide;
      hood.rotation.x = 0.55;
      hood.position.set(-0.45, 1.34, -0.12);
      group.add(hood);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.16, 20),
        new THREE.MeshBasicMaterial({ color: 0x4aa8ff, toneMapped: false }),
      );
      glow.rotation.x = Math.PI / 2 + 0.55;
      glow.position.set(-0.45, 1.2, -0.21);
      group.add(glow);
      const scopeLight = new THREE.PointLight(0x4aa8ff, 1.6, 2.2, 2);
      scopeLight.position.set(-0.45, 1.16, -0.34);
      group.add(scopeLight);
    }

    if (st.crew) {
      // Standing *inside* the ring with their back to the captain, working a
      // console set into the wall. Getting this the wrong way round puts the
      // whole senior staff facing the middle of the room like a briefing,
      // which is not a thing that ever happens on that bridge.
      const c = buildCrewman(st.tunic!, st.skin!, false);
      c.group.position.set(st.scope ? -0.4 : 0.06, 0, -0.52);
      group.add(c.group);
      crew[st.crew] = c;
    }

    bridge.add(group);
  }

  // -- Turbolift -------------------------------------------------------------
  // Directly aft — a = 0 — which is why the whole crew turns to look over the
  // captain's head every time somebody arrives.
  {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.3, 0.2), coral);
    frame.position.set(0, RING_Y + 1.15, ROOM_R - 0.1);
    bridge.add(frame);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x8a8172, roughness: 0.55, metalness: 0.4 });
    for (const side of [-1, 1]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.62, 2.1, 0.1), doorMat);
      door.position.set(side * 0.33, RING_Y + 1.1, ROOM_R - 0.22);
      bridge.add(door);
    }
    const indicator = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.12, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xffb648, emissive: 0xffb648, emissiveIntensity: 1.4, roughness: 0.5 }),
    );
    indicator.position.set(0, RING_Y + 2.26, ROOM_R - 0.24);
    bridge.add(indicator);
  }

  // -- Services --------------------------------------------------------------

  let alert: AlertLevel = "normal";
  let alertPhase = 0;
  let jolt = 0;
  let disruption = 0;
  let commFace: string | null = null;

  const viewscreen: ViewscreenService = {
    target,
    disrupt(amount) {
      disruption = Math.max(disruption, amount);
    },
    showComm(who) {
      commFace = who;
      void commFace;
    },
  };
  ctx.services.viewscreen = viewscreen;

  const service: BridgeService = {
    eyePosition: new THREE.Vector3(0, 1.36, 0.72),
    setAlert(level) {
      alert = level;
    },
    jolt(amount) {
      jolt = Math.min(1.4, jolt + amount);
    },
  };
  ctx.services.bridge = service;

  // A console goes up when the ship takes a heavy hit. It is the oldest gag on
  // the show and it still works, because it is the only time the room itself
  // is dangerous.
  const blowLight = new THREE.PointLight(0xffc070, 0, 7, 2);
  bridge.add(blowLight);
  const sparkPool: { sprite: THREE.Sprite; life: number; vel: THREE.Vector3 }[] = [];
  const sparkTex = (() => {
    const [c, g] = makeCanvas(32, 32);
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,240,1)");
    grad.addColorStop(0.4, "rgba(255,190,90,0.7)");
    grad.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  function blowConsole(): void {
    const st = STATIONS[rng.int(0, STATIONS.length - 1)];
    const a = st.angle;
    const at = new THREE.Vector3(Math.sin(a) * (ROOM_R - 0.7), RING_Y + 1.3, Math.cos(a) * (ROOM_R - 0.7));
    for (let i = 0; i < 22; i++) {
      let s = sparkPool.find((p) => p.life <= 0);
      if (!s) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: sparkTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
        );
        sprite.scale.setScalar(0.13);
        bridge.add(sprite);
        s = { sprite, life: 0, vel: new THREE.Vector3() };
        sparkPool.push(s);
      }
      s.life = rng.range(0.4, 1.3);
      s.sprite.position.copy(at);
      s.sprite.visible = true;
      s.vel.set(rng.gauss() * 1.6, rng.range(0.6, 3.4), rng.gauss() * 1.6);
    }
    // One permanent light, moved and re-lit. *Adding* a light to the scene
    // changes the light count and makes three recompile every material in the
    // room — a hitch at the exact moment the ship is being hit, which is the
    // worst possible moment for the frame rate to fall over.
    blowLight.position.copy(at);
    blowLight.intensity = 40;
    ctx.services.audio?.cue("consoleBlow");
  }
  const offHit = ctx.on("trek:hullHit", (payload: never) => {
    const p = payload as unknown as { ship: { id: number }; amount: number };
    const player = ctx.services.fleet?.player;
    if (!player || p.ship.id !== player.id) return;
    service.jolt(clamp(p.amount / 120, 0.15, 1.2));
    if (p.amount > 55 && rng.chance(0.5)) blowConsole();
  });
  const offShield = ctx.on("trek:shieldHit", (payload: never) => {
    const p = payload as unknown as { ship: { id: number }; amount: number };
    const player = ctx.services.fleet?.player;
    if (!player || p.ship.id !== player.id) return;
    service.jolt(clamp(p.amount / 400, 0.02, 0.35));
  });

  /** Turn the officer who is speaking toward the captain, briefly. */
  const offLine = ctx.on("trek:line", (payload: never) => {
    const { who } = payload as unknown as { who: string };
    const c = crew[who.toUpperCase().replace("MR. ", "")];
    if (c) c.attention = 2.6;
  });

  // -------------------------------------------------------------------------

  let panelCursor = 0;

  return {
    update(dt, c) {
      const t = c.elapsed;

      // Blink the consoles. One canvas per frame, round-robin: the whole room
      // is alive and the cost is a single 512×200 redraw.
      if (panels.length) {
        for (let n = 0; n < (quality === "low" ? 1 : 2); n++) {
          const p = panels[panelCursor % panels.length];
          p.draw(t);
          p.texture.needsUpdate = true;
          panelCursor++;
        }
      }

      // Alert lighting. Red alert does not just add red — it *removes* the
      // warm key, which is why the set looks like a different room.
      alertPhase += dt * (alert === "red" ? 3.0 : 1.6);
      const pulse = alert === "normal" ? 0 : 0.5 + 0.5 * Math.sin(alertPhase);
      const alertColour = alert === "red" ? 0xff2b1a : 0xffc21a;
      for (const strip of alertPanels) {
        const mat = strip.material as THREE.MeshStandardMaterial;
        mat.emissive.setHex(alertColour);
        mat.emissiveIntensity = alert === "normal" ? 0 : pulse * 2.4;
        mat.color.setHex(alert === "normal" ? 0x2a2a30 : alertColour);
      }
      const dim = alert === "red" ? 0.3 + pulse * 0.12 : alert === "yellow" ? 0.72 : 1;
      keyLight.intensity = 26 * dim;
      fillLight.intensity = 9 * dim;
      keyLight.color.setHex(alert === "red" ? 0xff8070 : 0xfff0dc);
      for (const mat of ceilingMats) {
        mat.emissiveIntensity = ((mat.userData.base as number) ?? 1.1) * dim;
        mat.emissive.setHex(alert === "red" ? 0xff6050 : 0xfff0d8);
      }

      // Sparks.
      blowLight.intensity = Math.max(0, blowLight.intensity - dt * 130);
      for (const s of sparkPool) {
        if (s.life <= 0) continue;
        s.life -= dt;
        s.vel.y -= 4.2 * dt;
        s.sprite.position.addScaledVector(s.vel, dt);
        s.sprite.material.opacity = clamp(s.life * 1.4, 0, 1);
        if (s.life <= 0) s.sprite.visible = false;
      }

      // Crew idle: hands working, the odd glance, and a turn toward the chair
      // when they are the one talking.
      for (const key of Object.keys(crew)) {
        const person = crew[key];
        person.phase += dt;
        const w = person.phase;
        person.arms[0].rotation.x = 0.1 + Math.sin(w * 2.1) * 0.09;
        person.arms[1].rotation.x = 0.1 + Math.sin(w * 1.7 + 1.2) * 0.09;
        person.arms[0].rotation.z = 0.16 + Math.sin(w * 0.9) * 0.05;
        person.arms[1].rotation.z = -0.16 - Math.sin(w * 1.1) * 0.05;
        person.attention = Math.max(0, person.attention - dt);
        // An over-the-shoulder glance, not a head swivel. Everyone on this
        // bridge has their back to the captain, so the temptation is to rotate
        // the head by a full half-turn — which is anatomically ridiculous and
        // reads as a bug. A little over sixty degrees is all it takes.
        const look = person.attention > 0 ? 1 : 0;
        const wantY = look ? (key === "SULU" || key === "CHEKOV" ? 1.15 : -1.15) : 0;
        person.head.rotation.y += (wantY + Math.sin(w * 0.7) * 0.12 - person.head.rotation.y) * Math.min(1, dt * 4);
        person.head.rotation.x = Math.sin(w * 0.53) * 0.06 - (look ? 0.05 : 0);
      }

      // Camera: the captain's head, plus whatever the ship is doing to it.
      jolt = Math.max(0, jolt - dt * 1.9);
      disruption = Math.max(0, disruption - dt * 1.2);
      const shake = jolt * 0.06;
      c.eyeCam.position.copy(service.eyePosition);
      c.eyeCam.position.x += (Math.random() - 0.5) * shake;
      c.eyeCam.position.y += (Math.random() - 0.5) * shake;
      c.eyeCam.rotation.y = c.input.lookYaw + (Math.random() - 0.5) * shake * 0.6;
      c.eyeCam.rotation.x = c.input.lookPitch + (Math.random() - 0.5) * shake * 0.6;
      c.eyeCam.rotation.z = Math.sin(t * 9) * jolt * 0.02;

      // The screen lights the room it is in, and its colour follows what is on
      // it: a nebula makes the bridge magenta, and that is free drama.
      screenLight.intensity = 3.2 * (0.7 + 0.3 * Math.sin(t * 1.3)) * (1 - disruption * 0.7);
      screenMat.color.setScalar(1 - disruption * 0.55);
    },

    dispose() {
      offHit();
      offShield();
      offLine();
      target.dispose();
      sparkTex.dispose();
      for (const p of panels) p.texture.dispose();
    },
  };
}
