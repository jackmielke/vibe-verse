/**
 * Vibe Kart — the driver.
 *
 * A kart with an empty seat is a toy; a kart with somebody *in* it, leaning
 * into the corner and gritting their teeth, is a game. So the driver gets more
 * animation budget than the vehicle does: a two-bone CPU skin on the arms so
 * the hands actually hold the wheel through a full lock, a head on its own
 * pivot that turns into corners and swivels on look-back, and a face texture
 * that changes expression with what the racer is doing.
 *
 * Proportions are chibi — roughly three heads tall, seated. That is not a
 * shortcut, it is the readability budget: a big head means a big face, and the
 * face is the only part of a driver anybody looks at from a chase camera.
 *
 * Driver-local space: origin at the hips (the kart's seat anchor), -Z forward,
 * +Y up. Everything below is authored in metres in that frame.
 */
import * as THREE from "three";
import { TAU } from "./math";
import {
  applySkin,
  buildSkin,
  loft,
  mergeAll,
  mirrorX,
  place,
  ribbon,
  roundedBox,
  triangleCount,
  tube,
  withUv1,
  type LimbBone,
  type LoftSection,
  type Ribbon,
  type Skin,
} from "./geometry";
import type { CharacterKit, ModelQuality, RigMaterials } from "./materials";
import type { DriverStyle, RacerLook } from "./roster";

interface BuildSpec {
  torsoH: number;
  shoulderHalf: number;
  hipHalf: number;
  chestDepth: number;
  armR: number;
  legR: number;
}

const BUILDS: Record<DriverStyle["build"], BuildSpec> = {
  tiny: { torsoH: 0.34, shoulderHalf: 0.135, hipHalf: 0.125, chestDepth: 0.11, armR: 0.043, legR: 0.055 },
  slim: { torsoH: 0.42, shoulderHalf: 0.155, hipHalf: 0.135, chestDepth: 0.12, armR: 0.046, legR: 0.058 },
  stocky: { torsoH: 0.4, shoulderHalf: 0.185, hipHalf: 0.17, chestDepth: 0.15, armR: 0.055, legR: 0.07 },
  broad: { torsoH: 0.45, shoulderHalf: 0.215, hipHalf: 0.19, chestDepth: 0.17, armR: 0.062, legR: 0.078 },
  blocky: { torsoH: 0.47, shoulderHalf: 0.235, hipHalf: 0.2, chestDepth: 0.18, armR: 0.068, legR: 0.082 },
};

export interface ArmChainRest {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
}

export interface DriverAssembly {
  group: THREE.Group;
  /** Hip pivot — braces, leans and squashes. */
  torso: THREE.Object3D;
  /** Neck pivot — the head turns and tilts here. */
  head: THREE.Object3D;
  headMesh: THREE.Mesh;
  /** Skinned arm mesh, deformed on the CPU every frame. */
  arms: {
    mesh: THREE.Mesh;
    skin: Skin;
    rest: ArmChainRest[];
    bones: Array<{ upper: LimbBone; fore: LimbBone }>;
  };
  /** Optional trailing cloth. Owned here, parented at the racer root. */
  scarf: { mesh: THREE.Mesh; ribbon: Ribbon; anchor: THREE.Vector3; length: number; segments: number } | null;
  /** Small high-contrast pieces (visors, lenses, soles) — dropped on `low`. */
  detail: THREE.Mesh | null;
  geometries: THREE.BufferGeometry[];
  meshes: THREE.Mesh[];
  triangles: number;
  /** Head centre in driver space, for the scarf anchor and camera framing. */
  headCentre: THREE.Vector3;
}

/** A tapered, capsule-ended limb segment between two points. */
function bone(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg: number): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = Math.max(1e-3, dir.length());
  const shaft = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const capA = new THREE.SphereGeometry(r0, seg, Math.max(4, Math.round(seg / 2)));
  capA.translate(0, -len / 2, 0);
  const capB = new THREE.SphereGeometry(r1, seg, Math.max(4, Math.round(seg / 2)));
  capB.translate(0, len / 2, 0);
  const merged = mergeAll([shaft, capA, capB]);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  merged.applyQuaternion(q);
  merged.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return merged;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface BuildDriverOptions {
  look: RacerLook;
  kit: CharacterKit;
  rig: RigMaterials;
  quality: ModelQuality;
  /** Where the hands must end up, in driver space — the steering wheel rim. */
  grip: { x: number; y: number; z: number };
}

export function buildDriver(opts: BuildDriverOptions): DriverAssembly {
  const { look, kit, rig, quality } = opts;
  const style = look.driver;
  const b = BUILDS[style.build];
  const detailLevel = quality.detail;
  const seg = (n: number) => Math.max(4, Math.round(n * detailLevel));

  const group = new THREE.Group();
  group.name = "driver";
  const torso = new THREE.Object3D();
  torso.name = "torso";
  group.add(torso);

  const bodyParts: THREE.BufferGeometry[] = [];
  const bodyGear: THREE.BufferGeometry[] = [];
  const headGear: THREE.BufferGeometry[] = [];
  const detailParts: THREE.BufferGeometry[] = [];

  // -- torso -----------------------------------------------------------------

  // Lofted along Z then stood upright: the loft's "top" becomes the chest and
  // its "bottom" the back, which is exactly the control a torso wants.
  const torsoSections: LoftSection[] = [
    [-0.06, b.hipHalf * 0.9, b.chestDepth * 0.86, b.chestDepth * 0.8],
    [0.1, b.hipHalf, b.chestDepth * 0.94, b.chestDepth * 0.86],
    [0.26, b.shoulderHalf * 0.96, b.chestDepth, b.chestDepth * 0.86],
    [b.torsoH * 0.92, b.shoulderHalf, b.chestDepth * 0.84, b.chestDepth * 0.74],
    [b.torsoH, b.shoulderHalf * 0.62, b.chestDepth * 0.55, b.chestDepth * 0.5],
  ].map(([z, halfW, top, bottom]) => ({ z, halfW, top, bottom, sharp: 3.2 }));
  const torsoGeo = loft(torsoSections, { points: seg(18) });
  torsoGeo.rotateX(-Math.PI / 2);
  bodyParts.push(torsoGeo);

  // -- legs ------------------------------------------------------------------

  const hip = v3(b.hipHalf * 0.72, -0.04, -0.05);
  const knee = v3(b.hipHalf * 0.86, -0.16, -0.34);
  // Deep enough that the boots sit down inside the kart's footwell. Feet on top
  // of the bodywork read as two slippers left on a table.
  const ankle = v3(b.hipHalf * 0.86, -0.2, -0.54);
  const thigh = bone(hip, knee, b.legR * 1.1, b.legR * 0.9, seg(10));
  const shin = bone(knee, ankle, b.legR * 0.9, b.legR * 0.72, seg(10));
  bodyParts.push(thigh, mirrorX(thigh), shin, mirrorX(shin));

  const boot = place(roundedBox(b.legR * 1.9, b.legR * 1.3, 0.15, 0.032, seg(5)), {
    position: [ankle.x, ankle.y + 0.01, ankle.z - 0.05],
    rotation: [-0.35, 0, 0],
  });
  bodyGear.push(boot, mirrorX(boot));
  const sole = place(roundedBox(b.legR * 1.85, b.legR * 0.45, 0.14, 0.02, seg(4)), {
    position: [ankle.x, ankle.y - b.legR * 0.5, ankle.z - 0.06],
    rotation: [-0.35, 0, 0],
  });
  detailParts.push(sole, mirrorX(sole));

  // Collar and belt: two rings of the gear colour that break the suit up and
  // give the torso a waist at chase-camera distance.
  bodyGear.push(
    place(new THREE.TorusGeometry(b.shoulderHalf * 0.66, 0.026, seg(6), seg(16)), {
      position: [0, b.torsoH * 0.9, 0],
      rotation: [Math.PI / 2, 0, 0],
    }),
  );
  detailParts.push(
    place(roundedBox(b.hipHalf * 2.1, 0.05, b.chestDepth * 2.0, 0.02, seg(4)), {
      position: [0, 0.08, 0],
    }),
  );

  // -- arms ------------------------------------------------------------------

  const shoulderY = b.torsoH * 0.78;
  const grip = opts.grip;
  const rest: ArmChainRest[] = [];
  const armParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const shoulder = v3(side * b.shoulderHalf * 0.98, shoulderY, 0.01);
    const wrist = v3(side * Math.abs(grip.x), grip.y, grip.z);
    // Elbow: dropped and pushed outboard from the midpoint. Straight-line arms
    // read as a mannequin; the outboard break is what makes it look like
    // somebody is holding on.
    const mid = shoulder.clone().lerp(wrist, 0.52);
    const elbow = v3(mid.x + side * 0.075, mid.y - 0.075, mid.z + 0.03);
    rest.push({ shoulder, elbow, wrist });
    armParts.push(bone(shoulder, elbow, b.armR * 1.12, b.armR * 0.92, seg(9)));
    armParts.push(bone(elbow, wrist, b.armR * 0.92, b.armR * 0.8, seg(9)));
    // Mitt: a chunky glove, angled to wrap the rim.
    armParts.push(
      place(roundedBox(b.armR * 2.1, b.armR * 2.5, b.armR * 2.2, b.armR * 0.8, seg(5)), {
        position: [wrist.x, wrist.y, wrist.z - 0.01],
        rotation: [0.3, 0, side * -0.25],
      }),
    );
  }
  const armsGeo = withUv1(mergeAll(armParts));
  const skin = buildSkin(
    armsGeo,
    rest.map((r) => ({ shoulder: r.shoulder, elbow: r.elbow, wrist: r.wrist })),
    b.armR * 1.4,
  );
  const armsMesh = new THREE.Mesh(armsGeo, kit.outfit);
  armsMesh.name = "driver.arms";
  armsMesh.castShadow = quality.castShadows;
  // The skin rewrites positions every frame; recomputing bounds eight times a
  // frame is pure waste when the arms never leave a half-metre ball.
  armsGeo.boundingSphere = new THREE.Sphere(v3(0, shoulderY, -0.2), 0.9);
  armsMesh.frustumCulled = true;
  torso.add(armsMesh);

  const bones: Array<{ upper: LimbBone; fore: LimbBone }> = rest.map((r) => ({
    upper: { pivot: r.shoulder.clone(), rotation: new THREE.Quaternion() },
    fore: { pivot: r.elbow.clone(), rotation: new THREE.Quaternion() },
  }));

  // -- head ------------------------------------------------------------------

  const headR = 0.185 * style.headScale;
  const headCentre = v3(0, b.torsoH + headR * 0.82, -0.01);
  const neck = new THREE.Object3D();
  neck.name = "head";
  neck.position.copy(headCentre);
  torso.add(neck);

  const headGeo = new THREE.SphereGeometry(headR, seg(22), seg(16));
  headGeo.scale(1, 1.06, 0.98);
  // The face atlas is equirectangular: u = 0.5 sits on +X, so a quarter turn
  // puts it dead ahead on -Z.
  headGeo.rotateY(Math.PI / 2);
  withUv1(headGeo);
  const headMesh = new THREE.Mesh(headGeo, rig.head);
  headMesh.name = "driver.head";
  headMesh.castShadow = quality.castShadows;
  neck.add(headMesh);

  // Neck stub, in the suit colour so no face texels leak below the jaw.
  bodyParts.push(
    place(new THREE.CylinderGeometry(headR * 0.42, headR * 0.5, 0.09, seg(10)), {
      position: [0, b.torsoH + 0.02, -0.01],
    }),
  );

  // -- costume ---------------------------------------------------------------

  const gearHead: THREE.BufferGeometry[] = headGear;
  const detailHead: THREE.BufferGeometry[] = [];

  switch (style.hat) {
    case "goggles": {
      // Pushed up on the forehead — the universal shorthand for "just arrived,
      // in a hurry".
      gearHead.push(
        place(new THREE.TorusGeometry(headR * 0.98, headR * 0.14, seg(7), seg(20)), {
          position: [0, headR * 0.42, 0],
          rotation: [Math.PI / 2 - 0.35, 0, 0],
        }),
      );
      const lens = place(new THREE.CylinderGeometry(headR * 0.32, headR * 0.32, headR * 0.16, seg(12)), {
        position: [headR * 0.42, headR * 0.62, -headR * 0.72],
        rotation: [Math.PI / 2 - 0.5, 0, 0],
      });
      detailHead.push(lens, mirrorX(lens));
      // Spiky hair tufts: the silhouette read for the fastest character.
      for (let i = 0; i < 5; i++) {
        const a = -0.9 + i * 0.45;
        gearHead.push(
          place(new THREE.ConeGeometry(headR * 0.2, headR * 0.75, seg(6)), {
            position: [Math.sin(a) * headR * 0.55, headR * 0.85, Math.cos(a) * headR * 0.35 + headR * 0.2],
            rotation: [-0.5 + Math.cos(a) * 0.3, 0, Math.sin(a) * -0.6],
          }),
        );
      }
      break;
    }
    case "bowl": {
      // A full weather dome. The detail material is swapped to glass for this
      // character, so it costs nothing extra.
      detailHead.push(new THREE.SphereGeometry(headR * 1.22, seg(18), seg(14)));
      gearHead.push(
        place(new THREE.TorusGeometry(headR * 1.18, headR * 0.1, seg(7), seg(20)), {
          position: [0, -headR * 0.32, 0],
          rotation: [Math.PI / 2, 0, 0],
        }),
      );
      gearHead.push(
        place(new THREE.SphereGeometry(headR * 0.16, seg(8), seg(6)), {
          position: [0, headR * 1.42, 0],
        }),
      );
      break;
    }
    case "cap": {
      const dome = new THREE.SphereGeometry(headR * 1.05, seg(18), seg(12), 0, TAU, 0, Math.PI * 0.52);
      dome.translate(0, headR * 0.12, 0);
      gearHead.push(dome);
      gearHead.push(
        place(roundedBox(headR * 1.5, headR * 0.16, headR * 1.0, headR * 0.07, seg(5)), {
          position: [0, headR * 0.36, -headR * 1.02],
          rotation: [-0.18, 0, 0],
        }),
      );
      break;
    }
    case "antenna": {
      for (const side of [-1, 1] as const) {
        gearHead.push(
          tube(
            [
              [side * headR * 0.35, headR * 0.8, headR * 0.1],
              [side * headR * 0.7, headR * 1.35, -headR * 0.15],
              [side * headR * 1.15, headR * 1.6, -headR * 0.5],
            ],
            headR * 0.055,
            seg(10),
            seg(6),
          ),
        );
        gearHead.push(
          place(new THREE.SphereGeometry(headR * 0.15, seg(8), seg(6)), {
            position: [side * headR * 1.18, headR * 1.62, -headR * 0.54],
            scale: [1, 0.8, 1.6],
          }),
        );
      }
      break;
    }
    case "aviator": {
      const helm = new THREE.SphereGeometry(headR * 1.09, seg(20), seg(14), 0, TAU, 0, Math.PI * 0.62);
      helm.translate(0, headR * 0.06, 0);
      gearHead.push(helm);
      // Ear flaps and a chin strap: three shapes, and it reads as flight kit.
      const flap = place(new THREE.SphereGeometry(headR * 0.42, seg(10), seg(8)), {
        position: [headR * 0.92, -headR * 0.1, 0],
        scale: [0.55, 1, 0.9],
      });
      gearHead.push(flap, mirrorX(flap));
      const strap = place(new THREE.TorusGeometry(headR * 0.95, headR * 0.06, seg(6), seg(18)), {
        position: [0, -headR * 0.22, 0],
        rotation: [Math.PI / 2 - 0.2, 0, 0],
      });
      detailHead.push(strap);
      const lens = place(new THREE.CylinderGeometry(headR * 0.34, headR * 0.34, headR * 0.14, seg(12)), {
        position: [headR * 0.44, headR * 0.68, -headR * 0.66],
        rotation: [Math.PI / 2 - 0.45, 0, 0],
      });
      detailHead.push(lens, mirrorX(lens));
      break;
    }
    case "swirl": {
      // Soft-serve: a shrinking stack of spheres on a spiral. Pure silhouette.
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const a = t * TAU * 1.1;
        gearHead.push(
          place(new THREE.SphereGeometry(headR * (0.55 - t * 0.4), seg(10), seg(8)), {
            position: [Math.cos(a) * headR * 0.16 * (1 - t), headR * (0.85 + t * 0.62), Math.sin(a) * headR * 0.16 * (1 - t)],
          }),
        );
      }
      gearHead.push(
        place(new THREE.SphereGeometry(headR * 0.19, seg(8), seg(6)), {
          position: [0, headR * 1.62, 0],
        }),
      );
      break;
    }
    case "visor": {
      const helm = new THREE.SphereGeometry(headR * 1.1, seg(20), seg(14), 0, TAU, 0, Math.PI * 0.55);
      helm.translate(0, headR * 0.08, 0);
      gearHead.push(helm);
      // Visor band straight across the eyes. On a robot this is the face.
      detailHead.push(
        place(roundedBox(headR * 1.9, headR * 0.5, headR * 1.7, headR * 0.18, seg(6)), {
          position: [0, headR * 0.28, -headR * 0.16],
        }),
      );
      gearHead.push(
        place(roundedBox(headR * 2.0, headR * 0.14, headR * 1.75, headR * 0.06, seg(5)), {
          position: [0, headR * 0.56, -headR * 0.16],
        }),
      );
      break;
    }
    case "crest": {
      for (let i = 0; i < 3; i++) {
        const t = (i - 1) * 0.42;
        gearHead.push(
          place(roundedBox(headR * 0.28, headR * (0.9 - Math.abs(t) * 0.6), headR * 0.5, headR * 0.06, seg(4)), {
            position: [t * headR * 1.1, headR * 1.0 - Math.abs(t) * headR * 0.25, headR * 0.1],
            rotation: [0.1, 0, t * 0.5],
          }),
        );
      }
      break;
    }
  }

  switch (style.ears) {
    case "fox": {
      const ear = place(new THREE.ConeGeometry(headR * 0.34, headR * 0.85, seg(7)), {
        position: [headR * 0.62, headR * 0.92, headR * 0.12],
        rotation: [-0.1, 0, 0.28],
      });
      gearHead.push(ear, mirrorX(ear));
      const inner = place(new THREE.ConeGeometry(headR * 0.2, headR * 0.5, seg(6)), {
        position: [headR * 0.63, headR * 0.9, headR * 0.0],
        rotation: [-0.2, 0, 0.28],
      });
      detailHead.push(inner, mirrorX(inner));
      break;
    }
    case "moth": {
      for (const side of [-1, 1] as const) {
        gearHead.push(
          tube(
            [
              [side * headR * 0.4, headR * 0.85, headR * 0.05],
              [side * headR * 0.85, headR * 1.15, -headR * 0.35],
              [side * headR * 1.0, headR * 1.05, -headR * 0.85],
            ],
            headR * 0.05,
            seg(10),
            seg(5),
          ),
        );
      }
      break;
    }
    case "rock": {
      const slab = place(roundedBox(0.16, 0.13, 0.2, 0.045, seg(5)), {
        position: [b.shoulderHalf * 1.02, b.torsoH * 0.82, 0],
        rotation: [0.1, 0.2, 0.35],
      });
      bodyGear.push(slab, mirrorX(slab));
      break;
    }
    case "fin": {
      gearHead.push(
        place(roundedBox(headR * 0.16, headR * 0.8, headR * 1.3, headR * 0.07, seg(5)), {
          position: [0, headR * 0.95, headR * 0.1],
          rotation: [0.25, 0, 0],
        }),
      );
      break;
    }
    case "none":
      break;
  }

  // -- emit ------------------------------------------------------------------

  const geometries: THREE.BufferGeometry[] = [armsGeo, headGeo];
  const meshes: THREE.Mesh[] = [armsMesh, headMesh];

  const emit = (parts: THREE.BufferGeometry[], material: THREE.Material, parent: THREE.Object3D, name: string) => {
    if (parts.length === 0) return null;
    const geo = mergeAll(parts);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `driver.${name}`;
    mesh.castShadow = quality.castShadows;
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  if (!quality.frills) {
    // No dark-detail pass on `low`: fold what would have been contrast pieces
    // into the gear mesh so the silhouette is unchanged and the draw call goes.
    bodyGear.push(...detailParts);
    gearHead.push(...detailHead);
    detailParts.length = 0;
    detailHead.length = 0;
  }

  emit(bodyParts, kit.outfit, torso, "body");
  emit(bodyGear, kit.gear, torso, "gear");
  emit(gearHead, kit.gear, neck, "headGear");

  // Bloop's weather dome wants glass; every other character's contrast pieces
  // want black plastic. Same mesh, same draw call, different material.
  const detailMat = style.hat === "bowl" ? kit.glass : kit.dark;
  const detailBody = emit(detailParts, detailMat, torso, "detail");
  const detailHeadMesh = emit(detailHead, detailMat, neck, "headDetail");
  const detail = detailHeadMesh ?? detailBody;

  // -- scarf -----------------------------------------------------------------

  let scarf: DriverAssembly["scarf"] = null;
  if (style.scarf && quality.frills) {
    const s = style.scarf;
    const segments = Math.max(6, Math.round(s.segments * detailLevel));
    const rb = ribbon(segments);
    const mat = kit.cloth.clone() as THREE.MeshStandardMaterial;
    if (mat.color) mat.color.set(s.color);
    // Drop the weave albedo and keep its normal: the scarf is a two-metre
    // ribbon of the character's colour seen at speed, and a mid-grey weave
    // multiplied into it just makes every scarf in the game look muddy.
    mat.map = null;
    mat.side = THREE.DoubleSide;
    mat.needsUpdate = true;
    const mesh = new THREE.Mesh(rb.geometry, mat);
    mesh.name = "driver.scarf";
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    geometries.push(rb.geometry);
    meshes.push(mesh);
    scarf = {
      mesh,
      ribbon: rb,
      // Head-local, because that is the node the sim reads it through: the
      // nape of the neck, so the cloth pivots when the driver looks round.
      anchor: v3(0, -headR * 0.72, headR * 0.45),
      length: s.length,
      segments,
    };
    // The scarf material is a per-rig clone; the desk does not know about it,
    // so it is disposed with the rig's own material list.
    mesh.userData.ownedMaterial = mat;
    mesh.userData.width = s.width;
  }

  let triangles = 0;
  for (const g of geometries) triangles += triangleCount(g);

  return {
    group,
    torso,
    head: neck,
    headMesh,
    arms: { mesh: armsMesh, skin, rest, bones },
    scarf,
    detail,
    geometries,
    meshes,
    triangles,
    headCentre,
  };
}

/** Re-deform the arms from the current bone rotations. */
export function poseArms(assembly: DriverAssembly): void {
  applySkin(assembly.arms.mesh.geometry, assembly.arms.skin, assembly.arms.bones);
}
