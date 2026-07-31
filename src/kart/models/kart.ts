/**
 * Vibe Kart — the vehicle.
 *
 * One builder, eight cars. Everything that distinguishes Baron Bolt's armoured
 * slab from Zippa's darter comes out of the `KartStyle` record: overall scale,
 * track width, ride height, nose treatment, spoiler, engine, roll cage and
 * wheel package. Nothing here is hard-coded to a character.
 *
 * The section drawing (`bodySections`) is the important part. It is a real car
 * profile: a pinched nose, a waist at the driver's hips, haunches over the rear
 * axle and a taper into the tail, with the beltline sweeping upward the whole
 * way. Read the numbers as a side elevation and you can see the car.
 *
 * Draw-call discipline: every part is sorted into a material bucket and merged,
 * so a fully dressed kart is 12 draws — three paint colours, chrome, dark
 * plastic, two light groups, the plate, the steering wheel, and three instanced
 * wheel meshes covering all four corners. Times eight racers that is ~100 of the
 * frame's budget, which is what the whole design is arranged around.
 *
 * Local space: -Z forward, +X right, +Y up, y = 0 is the ground plane.
 */
import * as THREE from "three";
import { TAU } from "./math";
import {
  loft,
  mergeAll,
  mirrorX,
  place,
  rimFace,
  rimHub,
  roundedBox,
  triangleCount,
  tube,
  tyre,
  withUv1,
  type LoftSection,
} from "./geometry";
import type { CharacterKit, ModelQuality, RigMaterials } from "./materials";
import type { KartStyle } from "./roster";

/** Tyre geometry is authored once at this size and scaled per instance. */
const TYRE_BASE = { radius: 0.36, width: 0.32, rimRadius: 0.212 };

export interface WheelSpec {
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  front: boolean;
}

export interface KartAssembly {
  group: THREE.Group;
  wheels: WheelSpec[];
  tyres: THREE.InstancedMesh;
  rims: THREE.InstancedMesh;
  hubs: THREE.InstancedMesh | null;
  /** Steering wheel pivot — the pose system spins this. */
  steering: THREE.Object3D;
  /** Where the driver rig is parented. */
  seat: THREE.Object3D;
  /** Exhaust tips, published as VFX attachment points. */
  exhausts: THREE.Object3D[];
  /** Rear-facing anchor at the tail, for drift sparks and item drops. */
  tail: THREE.Object3D;
  geometries: THREE.BufferGeometry[];
  meshes: THREE.Mesh[];
  triangles: number;
  /** Half-extents of the finished body, for the contact shadow. */
  footprint: { x: number; z: number };
}

// ---------------------------------------------------------------------------
// The section drawing
// ---------------------------------------------------------------------------

function bodySections(style: KartStyle, W: number, H: number, S: number): LoftSection[] {
  // z, halfW, top, bottom, centre y, corner sharpness
  const base: Array<[number, number, number, number, number, number]> = [
    [-1.0, 0.2, 0.06, 0.05, 0.26, 3.0],
    [-0.88, 0.32, 0.09, 0.08, 0.255, 3.4],
    [-0.7, 0.44, 0.12, 0.11, 0.25, 3.8],
    [-0.45, 0.52, 0.15, 0.14, 0.26, 4.2],
    [-0.15, 0.56, 0.17, 0.16, 0.27, 4.4],
    [0.15, 0.58, 0.18, 0.17, 0.28, 4.6],
    [0.45, 0.6, 0.2, 0.18, 0.29, 4.8],
    [0.72, 0.58, 0.22, 0.17, 0.3, 5.0],
    [0.88, 0.5, 0.2, 0.14, 0.31, 4.6],
    [0.95, 0.4, 0.15, 0.1, 0.31, 4.0],
  ];

  // The nose is the character's handshake — it is the first thing a rival sees
  // in their mirror, so each style rewrites the first two sections outright.
  switch (style.nose) {
    case "wedge":
      base[0] = [-1.04, 0.13, 0.035, 0.04, 0.215, 2.6];
      base[1] = [-0.9, 0.28, 0.075, 0.07, 0.235, 3.0];
      break;
    case "snub":
      base[0] = [-0.94, 0.3, 0.11, 0.1, 0.29, 2.8];
      base[1] = [-0.86, 0.38, 0.13, 0.11, 0.285, 3.2];
      break;
    case "plough":
      base[0] = [-1.02, 0.48, 0.07, 0.06, 0.2, 6.0];
      base[1] = [-0.9, 0.5, 0.1, 0.09, 0.22, 5.5];
      break;
    case "bullet":
      base[0] = [-1.02, 0.22, 0.13, 0.13, 0.27, 2.4];
      base[1] = [-0.88, 0.34, 0.15, 0.14, 0.27, 2.8];
      break;
  }

  return base.map(([z, halfW, top, bottom, y, sharp]) => ({
    z: z * S,
    halfW: halfW * W,
    top: top * H,
    bottom: bottom * H,
    y: y * H,
    sharp,
  }));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildKartOptions {
  style: KartStyle;
  kit: CharacterKit;
  rig: RigMaterials;
  quality: ModelQuality;
}

export function buildKart(opts: BuildKartOptions): KartAssembly {
  const { style, kit, rig, quality } = opts;
  const S = style.scale;
  const W = style.width * style.scale;
  const H = style.ride * style.scale;
  const detail = quality.detail;
  const seg = (n: number) => Math.max(4, Math.round(n * detail));

  const group = new THREE.Group();
  group.name = "kart";

  // Material buckets. Everything lands in one of these and is merged once.
  const paint: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const lampFront: THREE.BufferGeometry[] = [];
  const lampRear: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const plates: THREE.BufferGeometry[] = [];

  /** Scaled rounded box: dimensions are given in base units. */
  const box = (w: number, h: number, d: number, r: number, s = 6) =>
    roundedBox(w * W, h * H, d * S, r * Math.min(W, H, S), seg(s));

  const at = (
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rot?: [number, number, number],
  ) => place(geo, { position: [x * W, y * H, z * S], rotation: rot });

  const both = (geo: THREE.BufferGeometry, bin: THREE.BufferGeometry[]) => {
    bin.push(geo, mirrorX(geo));
  };

  // -- chassis ---------------------------------------------------------------

  // The hero mesh. `vRepeat` is 1 so the livery maps nose (v=0) to tail (v=1).
  paint.push(loft(bodySections(style, W, H, S), { points: seg(26), vRepeat: 1 }));

  // Floor tray: wider than the body and darker, so the car has a visible sole
  // and never looks like it is floating over its own shadow. Kept narrow enough
  // that the painted flanks still carry the silhouette from above.
  dark.push(at(box(1.06, 0.05, 1.5, 0.045, 5), 0, 0.1, 0.02));

  // Side pods. Lofted rather than boxed because a pod is all shoulder — it has
  // to swell over the rear wheel and die into the bodywork at the front.
  const podSections: LoftSection[] = [
    [-0.32, 0.045, 0.035, 0.035],
    [-0.14, 0.1, 0.085, 0.07],
    [0.1, 0.125, 0.105, 0.085],
    [0.32, 0.115, 0.095, 0.075],
    [0.44, 0.05, 0.04, 0.035],
  ].map(([z, halfW, top, bottom]) => ({
    z: z * S,
    halfW: halfW * W,
    top: top * H,
    bottom: bottom * H,
    sharp: 3.4,
  }));
  const pod = place(loft(podSections, { points: seg(16) }), {
    position: [0.63 * W, 0.27 * H, 0.24 * S],
  });
  both(pod, accent);

  // A trim blade along the top of each pod: three colours on a car is a
  // deliberate choice, and the third one wants a clean line to live on. Long
  // and thin — a short fat one reads as a box someone left on the deck.
  const podBlade = at(box(0.055, 0.022, 0.86, 0.011, 4), 0.63, 0.378, 0.22);
  both(podBlade, trim);

  // -- nose furniture --------------------------------------------------------

  const noseZ = style.nose === "snub" ? -0.9 : -0.98;
  // Bumper bar, hugging the nose profile.
  chrome.push(
    tube(
      [
        [-0.5 * W, 0.19 * H, (noseZ + 0.22) * S],
        [-0.34 * W, 0.185 * H, (noseZ + 0.04) * S],
        [0, 0.18 * H, (noseZ - 0.03) * S],
        [0.34 * W, 0.185 * H, (noseZ + 0.04) * S],
        [0.5 * W, 0.19 * H, (noseZ + 0.22) * S],
      ],
      0.032 * S,
      seg(18),
      seg(7),
    ),
  );

  // Headlights: a rounded lens in a chrome eyebrow. Two of them, high and
  // close together — the kart equivalent of eye placement, and the reason the
  // car reads as a *face* from the front.
  const lens = at(place(box(0.2, 0.15, 0.1, 0.045, 6), { scale: [1, 1, 1] }), 0.25, 0.3, noseZ + 0.06);
  both(lens, lampFront);
  const brow = place(new THREE.TorusGeometry(0.115 * W, 0.022 * S, seg(6), seg(14)), {
    position: [0.25 * W, 0.3 * H, (noseZ + 0.07) * S],
    rotation: [0, 0, 0],
  });
  both(brow, chrome);

  // Nose plate.
  plates.push(place(new THREE.PlaneGeometry(0.36 * W, 0.2 * H), {
    position: [0, 0.31 * H, (noseZ - 0.045) * S],
    rotation: [0, Math.PI, 0],
  }));

  // -- cockpit ---------------------------------------------------------------

  // Tub: the recess the driver drops into. Cut visually rather than
  // geometrically — a dark tray sunk into the deck reads as an opening at a
  // fraction of the cost of a real boolean. Deliberately small: every square
  // centimetre it covers is a square centimetre of livery nobody sees.
  dark.push(at(box(0.6, 0.09, 0.66, 0.08, 6), 0, 0.44, -0.02));
  // Footwell: the driver's boots have to land *in* something, or they read as
  // two blocks left on the bonnet. Narrower than the tub, and it doubles as the
  // dark inset that gives the nose its length.
  dark.push(at(box(0.46, 0.1, 0.56, 0.07, 5), 0, 0.4, -0.42));

  const seatBase = at(box(0.5, 0.12, 0.48, 0.06, 6), 0, 0.5, 0.16);
  dark.push(seatBase);
  // Low-backed on purpose. A tall bucket hides the driver's shoulders, and the
  // driver is the half of this rig that carries the character.
  const seatBack = at(box(0.52, 0.4, 0.16, 0.07, 6), 0, 0.69, 0.4, [-0.22, 0, 0]);
  dark.push(seatBack);
  // Cushion insert in the trim colour: one accent inside the cockpit is worth
  // more than three on the outside, because the chase camera looks straight
  // down into it all race.
  trim.push(at(box(0.36, 0.05, 0.36, 0.05, 5), 0, 0.555, 0.15));
  trim.push(at(box(0.36, 0.27, 0.06, 0.05, 5), 0, 0.69, 0.335, [-0.22, 0, 0]));
  const headrest = at(box(0.32, 0.16, 0.13, 0.055, 6), 0, 0.92, 0.45, [-0.22, 0, 0]);
  dark.push(headrest);

  // Steering column and wheel, on their own pivot node. The wheel sits close to
  // the driver's chest — kart-style, not saloon-style — which is what lets the
  // arms hold a natural bend instead of reaching for the horizon.
  dark.push(
    place(new THREE.CylinderGeometry(0.035 * S, 0.05 * S, 0.34 * S, seg(10)), {
      position: [0, 0.66 * H, 0.02 * S],
      rotation: [Math.PI / 2 - 0.75, 0, 0],
    }),
  );

  const steering = new THREE.Object3D();
  steering.position.set(0, 0.82 * H, -0.12 * S);
  steering.rotation.x = -0.5;
  group.add(steering);
  {
    const rimR = 0.17 * Math.min(W, S);
    const parts: THREE.BufferGeometry[] = [
      new THREE.TorusGeometry(rimR, 0.028 * S, seg(6), seg(18)),
    ];
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * TAU;
      parts.push(
        place(new THREE.BoxGeometry(rimR * 0.9, 0.03 * S, 0.045 * S), {
          position: [Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5, 0],
          rotation: [0, 0, a],
        }),
      );
    }
    parts.push(place(new THREE.CylinderGeometry(rimR * 0.28, rimR * 0.3, 0.05 * S, seg(12)), { rotation: [Math.PI / 2, 0, 0] }));
    const wheelGeo = withUv1(mergeAll(parts));
    const wheelMesh = new THREE.Mesh(wheelGeo, kit.dark);
    wheelMesh.name = "steeringWheel";
    steering.add(wheelMesh);
    // Tracked below with the rest so it is disposed with the rig.
    steering.userData.geometry = wheelGeo;
  }

  const seat = new THREE.Object3D();
  seat.position.set(0, 0.56 * H, 0.2 * S);
  group.add(seat);

  // -- roll structure --------------------------------------------------------

  const barR = 0.036 * S;
  const hoop = (dx: number, top: number, z: number) =>
    tube(
      [
        [(-0.46 + dx) * W, 0.34 * H, z * S],
        [(-0.42 + dx) * W, top * 0.72 * H, (z + 0.02) * S],
        [(-0.22 + dx) * W, top * H, (z + 0.04) * S],
        [(0.22 + dx) * W, top * H, (z + 0.04) * S],
        [(0.42 + dx) * W, top * 0.72 * H, (z + 0.02) * S],
        [(0.46 + dx) * W, 0.34 * H, z * S],
      ],
      barR,
      seg(24),
      seg(7),
    );

  if (style.rollbar === "hoop") {
    chrome.push(hoop(0, 1.12, 0.5));
  } else if (style.rollbar === "twin") {
    chrome.push(hoop(0, 1.12, 0.52), hoop(0, 0.86, 0.7));
  } else {
    chrome.push(hoop(0, 1.16, 0.48));
    // Cage: longitudinal braces from the hoop down to the nose deck. The extra
    // horizontals are what make the heavy classes read as *armoured*.
    const brace = tube(
      [
        [0.3 * W, 1.14 * H, 0.5 * S],
        [0.34 * W, 0.86 * H, -0.05 * S],
        [0.32 * W, 0.52 * H, -0.55 * S],
      ],
      barR * 0.85,
      seg(14),
      seg(6),
    );
    both(brace, chrome);
  }

  // -- engine ----------------------------------------------------------------

  const engineY = 0.52;
  const engineZ = 0.72;
  switch (style.engine) {
    case "twin": {
      dark.push(at(box(0.6, 0.28, 0.44, 0.08, 6), 0, engineY, engineZ));
      const pot = place(new THREE.CylinderGeometry(0.12 * S, 0.13 * S, 0.3 * S, seg(14)), {
        position: [0.26 * W, (engineY + 0.06) * H, (engineZ - 0.02) * S],
        rotation: [0, 0, Math.PI / 2],
      });
      both(pot, chrome);
      break;
    }
    case "stack": {
      dark.push(at(box(0.68, 0.42, 0.46, 0.08, 6), 0, engineY + 0.06, engineZ));
      // Smokestack: the single tallest thing on the car, and Baron Bolt's
      // whole silhouette from behind.
      chrome.push(
        place(new THREE.CylinderGeometry(0.085 * S, 0.1 * S, 0.5 * S, seg(14)), {
          position: [-0.2 * W, (engineY + 0.5) * H, (engineZ + 0.06) * S],
          rotation: [0.12, 0, 0.06],
        }),
      );
      chrome.push(
        place(new THREE.CylinderGeometry(0.115 * S, 0.09 * S, 0.09 * S, seg(14)), {
          position: [-0.2 * W, (engineY + 0.76) * H, (engineZ + 0.08) * S],
        }),
      );
      break;
    }
    case "turbine": {
      dark.push(at(box(0.52, 0.3, 0.5, 0.12, 7), 0, engineY + 0.02, engineZ));
      chrome.push(
        place(new THREE.TorusGeometry(0.19 * S, 0.045 * S, seg(7), seg(20)), {
          position: [0, (engineY + 0.02) * H, (engineZ + 0.22) * S],
        }),
      );
      // Compressor face: a ring of blades, visible straight down the exhaust.
      for (let i = 0; i < seg(9); i++) {
        const a = (i / seg(9)) * TAU;
        chrome.push(
          place(new THREE.BoxGeometry(0.03 * S, 0.15 * S, 0.02 * S), {
            position: [Math.sin(a) * 0.1 * S, (engineY + 0.02) * H + Math.cos(a) * 0.1 * S, (engineZ + 0.2) * S],
            rotation: [0, 0, -a + 0.5],
          }),
        );
      }
      break;
    }
    case "boxer": {
      dark.push(at(box(0.5, 0.24, 0.42, 0.07, 6), 0, engineY - 0.02, engineZ));
      const jug = place(new THREE.CylinderGeometry(0.14 * S, 0.14 * S, 0.22 * S, seg(12)), {
        position: [0.34 * W, engineY * H, engineZ * S],
        rotation: [0, 0, Math.PI / 2],
      });
      both(jug, dark);
      for (let i = 0; i < 4; i++) {
        const fin = place(new THREE.CylinderGeometry(0.16 * S, 0.16 * S, 0.02 * S, seg(12)), {
          position: [(0.28 + i * 0.05) * W, engineY * H, engineZ * S],
          rotation: [0, 0, Math.PI / 2],
        });
        both(fin, chrome);
      }
      break;
    }
  }

  // Exhaust tips: chrome outer, emissive inner. The glow is driven by rpm, and
  // it is the cheapest possible read on "this engine is working".
  const exhausts: THREE.Object3D[] = [];
  for (const side of [-1, 1] as const) {
    const tipX = side * 0.22 * W;
    const tipY = (engineY + 0.18) * H;
    const tipZ = (engineZ + 0.3) * S;
    chrome.push(
      place(new THREE.CylinderGeometry(0.062 * S, 0.05 * S, 0.34 * S, seg(12), 1, true), {
        position: [tipX, tipY, tipZ],
        rotation: [Math.PI / 2 - 0.28, 0, 0],
      }),
    );
    glow.push(
      place(new THREE.CircleGeometry(0.052 * S, seg(12)), {
        position: [tipX, tipY + 0.045 * H, tipZ + 0.15 * S],
        rotation: [-0.28, 0, 0],
      }),
    );
    const anchor = new THREE.Object3D();
    anchor.position.set(tipX, tipY + 0.05 * H, tipZ + 0.17 * S);
    group.add(anchor);
    exhausts.push(anchor);
  }

  // -- tail ------------------------------------------------------------------

  const tailZ = 0.96;
  const taillight = at(box(0.22, 0.1, 0.05, 0.025, 5), 0.26, 0.36, tailZ);
  both(taillight, lampRear);
  plates.push(place(new THREE.PlaneGeometry(0.34 * W, 0.2 * H), {
    position: [0, 0.37 * H, (tailZ + 0.03) * S],
  }));
  chrome.push(
    tube(
      [
        [-0.44 * W, 0.22 * H, (tailZ - 0.16) * S],
        [0, 0.2 * H, (tailZ + 0.02) * S],
        [0.44 * W, 0.22 * H, (tailZ - 0.16) * S],
      ],
      0.03 * S,
      seg(14),
      seg(7),
    ),
  );

  // Spoiler.
  const wingY = 0.86;
  const wingZ = 0.92;
  const wingBlade = (y: number, chord: number, span: number) =>
    place(roundedBox(span * W, 0.045 * H, chord * S, 0.02 * Math.min(W, S), seg(5)), {
      position: [0, y * H, wingZ * S],
      rotation: [0.16, 0, 0],
    });
  const wingMount = () =>
    place(roundedBox(0.05 * W, 0.3 * H, 0.12 * S, 0.02 * Math.min(W, S), seg(4)), {
      position: [0.3 * W, (wingY - 0.16) * H, (wingZ - 0.02) * S],
    });

  switch (style.spoiler) {
    case "wing": {
      accent.push(wingBlade(wingY, 0.3, 1.12));
      both(wingMount(), chrome);
      const endplate = place(roundedBox(0.035 * W, 0.18 * H, 0.34 * S, 0.015 * Math.min(W, S), seg(4)), {
        position: [0.56 * W, (wingY + 0.02) * H, wingZ * S],
      });
      both(endplate, trim);
      break;
    }
    case "double": {
      accent.push(wingBlade(wingY + 0.12, 0.24, 1.04));
      accent.push(wingBlade(wingY - 0.1, 0.28, 1.12));
      both(wingMount(), chrome);
      const endplate = place(roundedBox(0.03 * W, 0.28 * H, 0.3 * S, 0.014 * Math.min(W, S), seg(4)), {
        position: [0.54 * W, wingY * H, wingZ * S],
      });
      both(endplate, trim);
      break;
    }
    case "ducktail": {
      // Lofted off the tail rather than bolted on: the cruisers get bodywork,
      // not aero.
      const lipSections: LoftSection[] = [
        [0.7, 0.5, 0.06, 0.06, 0.5],
        [0.88, 0.54, 0.1, 0.07, 0.56],
        [1.0, 0.46, 0.06, 0.05, 0.6],
      ].map(([z, halfW, top, bottom, y]) => ({
        z: z * S,
        halfW: halfW * W,
        top: top * H,
        bottom: bottom * H,
        y: y * H,
        sharp: 5,
      }));
      accent.push(loft(lipSections, { points: seg(16) }));
      break;
    }
    case "fin": {
      // A shark fin, lofted so it tapers front to back instead of being a slab.
      const finSections: LoftSection[] = [
        [0.62, 0.03, 0.06, 0.06, 0.62],
        [0.8, 0.045, 0.2, 0.05, 0.76],
        [0.98, 0.04, 0.13, 0.04, 0.84],
      ].map(([z, halfW, top, bottom, y]) => ({
        z: z * S,
        halfW: halfW * W,
        top: top * H,
        bottom: bottom * H,
        y: y * H,
        sharp: 3,
      }));
      accent.push(loft(finSections, { points: seg(12) }));
      trim.push(
        place(roundedBox(0.055 * W, 0.05 * H, 0.3 * S, 0.018 * Math.min(W, S), seg(4)), {
          position: [0, 0.94 * H, 0.84 * S],
        }),
      );
      break;
    }
  }

  // Side nerf bars. Karts have these instead of mirrors — a chrome hoop from
  // the floor pan out past the pod — and they do the job mirrors were doing
  // here (breaking the flank silhouette, catching a specular flick in a turn)
  // without floating off the bodywork like a pair of paddles.
  const nerf = tube(
    [
      [0.5 * W, 0.16 * H, -0.5 * S],
      [0.86 * W, 0.19 * H, -0.2 * S],
      [0.88 * W, 0.19 * H, 0.18 * S],
      [0.56 * W, 0.16 * H, 0.42 * S],
    ],
    0.028 * S,
    seg(16),
    seg(6),
  );
  both(nerf, chrome);

  // -- wheels ----------------------------------------------------------------

  const w = style.wheels;
  const wheels: WheelSpec[] = [
    { x: -0.74 * W, y: w.frontRadius, z: -0.66 * S, radius: w.frontRadius, width: w.frontWidth, front: true },
    { x: 0.74 * W, y: w.frontRadius, z: -0.66 * S, radius: w.frontRadius, width: w.frontWidth, front: true },
    { x: -0.78 * W, y: w.rearRadius, z: 0.62 * S, radius: w.rearRadius, width: w.rearWidth, front: false },
    { x: 0.78 * W, y: w.rearRadius, z: 0.62 * S, radius: w.rearRadius, width: w.rearWidth, front: false },
  ];

  const radial = seg(28);
  const tyreGeo = withUv1(
    tyre({
      radius: TYRE_BASE.radius,
      width: TYRE_BASE.width,
      rimRadius: TYRE_BASE.rimRadius,
      // Four segments per block: three of land, one of groove.
      blocks: Math.max(4, Math.round(radial / 4)),
      radial,
    }),
  );
  const rimR = TYRE_BASE.rimRadius * 0.995;
  const rimGeo = withUv1(rimFace({ radius: rimR, width: TYRE_BASE.width, spokes: w.spokes, twist: w.twist }));
  const hubGeo = quality.frills ? withUv1(rimHub({ radius: rimR, width: TYRE_BASE.width })) : null;

  const tyres = new THREE.InstancedMesh(tyreGeo, kit.rubber, 4);
  const rims = new THREE.InstancedMesh(rimGeo, kit.rim, 4);
  const hubs = hubGeo ? new THREE.InstancedMesh(hubGeo, kit.chrome, 4) : null;
  for (const m of [tyres, rims, hubs]) {
    if (!m) continue;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = quality.castShadows;
    m.receiveShadow = false;
    // One bounding volume covering all four corners, pinned rather than
    // derived: the instance matrices change every frame, and a rim whose
    // sphere was computed from a smaller geometry culls a frame before its
    // tyre does — which shows up as hollow wheels at the edge of the screen.
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.35 * H, 0), 1.6 * Math.max(W, S));
    group.add(m);
  }

  // -- assemble the buckets --------------------------------------------------

  const geometries: THREE.BufferGeometry[] = [tyreGeo, rimGeo];
  if (hubGeo) geometries.push(hubGeo);
  const meshes: THREE.Mesh[] = [];

  const emit = (parts: THREE.BufferGeometry[], material: THREE.Material, name: string, shadow = true) => {
    if (parts.length === 0) return null;
    const geo = mergeAll(parts);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `kart.${name}`;
    mesh.castShadow = shadow && quality.castShadows;
    mesh.receiveShadow = shadow && quality.castShadows;
    group.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  // On `low` the third paint colour is folded into the accent bucket: the
  // silhouette survives, one draw call per kart does not.
  if (!quality.frills) {
    accent.push(...trim);
    trim.length = 0;
  }

  emit(paint, kit.paint, "body");
  emit(accent, kit.accent, "accent");
  emit(trim, kit.trim, "trim");
  emit(chrome, kit.chrome, "chrome");
  emit(dark, kit.dark, "dark");
  emit(lampFront, rig.headlight, "headlights", false);
  emit(lampRear, rig.brake, "taillights", false);
  emit(glow, rig.exhaust, "exhaustGlow", false);
  emit(plates, rig.plate, "plates", false);

  // The steering wheel mesh was parented under its pivot; collect its geometry.
  const steeringGeo = (steering.userData as { geometry?: THREE.BufferGeometry }).geometry;
  if (steeringGeo) geometries.push(steeringGeo);

  const tail = new THREE.Object3D();
  tail.position.set(0, 0.2 * H, (tailZ + 0.08) * S);
  group.add(tail);

  let triangles = 0;
  for (const g of geometries) triangles += triangleCount(g);
  triangles += triangleCount(tyreGeo) * 3 + triangleCount(rimGeo) * 3;

  return {
    group,
    wheels,
    tyres,
    rims,
    hubs,
    steering,
    seat,
    exhausts,
    tail,
    geometries,
    meshes,
    triangles,
    footprint: { x: 0.95 * W, z: 1.15 * S },
  };
}

export { TYRE_BASE };
