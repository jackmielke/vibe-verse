import * as THREE from "three";
import type { QualityProfile } from "../core/Settings";
import type { TerrainRig } from "./Terrain";

/**
 * The Space Needle — occupied. Faithful proportions (184m to the roof, 158m
 * observation deck, three tapering legs, saucer with the halo ring) with an
 * alien graft: a Covenant-style hardlight spire punched through the core,
 * plasma conduits down the legs, and a rotating gravity ring above the saucer.
 *
 * It is the skybox landmark AND the campaign objective, so it is built at full
 * detail and never culled.
 */

export interface NeedleRig {
  group: THREE.Group;
  /** World position of the saucer centre — used for objective markers. */
  saucerPosition: THREE.Vector3;
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

export function createSpaceNeedle(
  scene: THREE.Scene,
  profile: QualityProfile,
  terrain: TerrainRig,
  position = new THREE.Vector3(-980, 0, 1720),
): NeedleRig {
  const group = new THREE.Group();
  const baseY = terrain.height(position.x, position.z);
  group.position.set(position.x, baseY, position.z);
  scene.add(group);

  const SCALE = 1.0;
  const H_DECK = 158 * SCALE;
  const H_ROOF = 184 * SCALE;

  const seg = profile.tier === "low" ? 16 : profile.tier === "medium" ? 24 : 40;

  const steel = new THREE.MeshStandardMaterial({
    color: 0xd8d2c6,
    roughness: 0.42,
    metalness: 0.85,
  });
  const paintedOrange = new THREE.MeshStandardMaterial({
    color: 0xd4643a,
    roughness: 0.55,
    metalness: 0.35,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fc6dd,
    roughness: 0.08,
    metalness: 0.1,
    transmission: 0.72,
    thickness: 0.6,
    transparent: true,
    opacity: 0.82,
    ior: 1.45,
  });
  const alienEmissive = new THREE.MeshStandardMaterial({
    color: 0x0a2230,
    emissive: 0x36d7ff,
    emissiveIntensity: 3.4,
    roughness: 0.3,
    metalness: 0.6,
  });
  const alienHull = new THREE.MeshStandardMaterial({
    color: 0x2b3f4d,
    roughness: 0.35,
    metalness: 0.78,
  });

  // --- three legs: hyperboloid curves splaying to a 40m footprint ---
  const legRadiusBottom = 21 * SCALE;
  const legRadiusTop = 3.4 * SCALE;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const pts: THREE.Vector3[] = [];
    const steps = 24;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Real Needle legs bow outward near the base then run near-vertical.
      const r = THREE.MathUtils.lerp(legRadiusBottom, legRadiusTop, Math.pow(t, 0.62));
      pts.push(new THREE.Vector3(Math.cos(a) * r, t * H_DECK * 0.94, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const legGeo = new THREE.TubeGeometry(curve, steps, 2.6 * SCALE, Math.max(6, seg / 3), false);
    const leg = new THREE.Mesh(legGeo, steel);
    leg.castShadow = true;
    leg.receiveShadow = true;
    group.add(leg);

    // Plasma conduit spiralling up each leg — alien retrofit.
    const conduitPts = pts.map((p, s) => {
      const t = s / steps;
      const twist = t * Math.PI * 2.2;
      const rr = 3.2 * SCALE;
      return new THREE.Vector3(
        p.x + Math.cos(a + twist) * rr,
        p.y,
        p.z + Math.sin(a + twist) * rr,
      );
    });
    const conduit = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(conduitPts), steps, 0.42 * SCALE, 6, false),
      alienEmissive,
    );
    group.add(conduit);
  }

  // --- central core shaft (elevator column) ---
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(4.2 * SCALE, 6.4 * SCALE, H_DECK, seg, 1, true),
    steel,
  );
  core.position.y = H_DECK / 2;
  core.castShadow = true;
  group.add(core);

  // --- saucer: the tophouse. Real profile is a flying-saucer disc with a
  // wide overhanging halo ring and a restaurant band below the deck. ---
  const saucer = new THREE.Group();
  saucer.position.y = H_DECK;
  group.add(saucer);

  // underside cone
  const under = new THREE.Mesh(
    new THREE.ConeGeometry(23 * SCALE, 16 * SCALE, seg, 1, true),
    paintedOrange,
  );
  under.position.y = -6 * SCALE;
  under.rotation.x = Math.PI;
  under.castShadow = true;
  saucer.add(under);

  // restaurant / observation band
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(23.5 * SCALE, 23.5 * SCALE, 7.2 * SCALE, seg, 1, true),
    glass,
  );
  band.position.y = 2 * SCALE;
  saucer.add(band);

  // deck floor + roof
  const deckFloor = new THREE.Mesh(new THREE.CylinderGeometry(24 * SCALE, 24 * SCALE, 0.8 * SCALE, seg), steel);
  deckFloor.position.y = -1.8 * SCALE;
  deckFloor.receiveShadow = true;
  saucer.add(deckFloor);

  const roof = new THREE.Mesh(new THREE.CylinderGeometry(21 * SCALE, 24 * SCALE, 3.2 * SCALE, seg), paintedOrange);
  roof.position.y = 7.2 * SCALE;
  roof.castShadow = true;
  saucer.add(roof);

  // the wide halo ring that gives the Needle its silhouette
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(27.5 * SCALE, 1.5 * SCALE, 10, seg * 2),
    steel,
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 5.4 * SCALE;
  halo.castShadow = true;
  saucer.add(halo);

  // radial ribs from the ring back to the roof
  const ribGeo = new THREE.BoxGeometry(0.5 * SCALE, 0.5 * SCALE, 6.5 * SCALE);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rib = new THREE.Mesh(ribGeo, steel);
    rib.position.set(Math.cos(a) * 24.6 * SCALE, 5.6 * SCALE, Math.sin(a) * 24.6 * SCALE);
    rib.lookAt(0, 6.4 * SCALE, 0);
    saucer.add(rib);
  }

  // --- mast + the original spire ---
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1 * SCALE, 2.6 * SCALE, H_ROOF - H_DECK, 12),
    steel,
  );
  mast.position.y = H_DECK + (H_ROOF - H_DECK) / 2;
  group.add(mast);

  // --- ALIEN GRAFT: hardlight spire driven through the mast ---
  const spire = new THREE.Mesh(
    new THREE.ConeGeometry(3.6 * SCALE, 74 * SCALE, 6),
    alienHull,
  );
  spire.position.y = H_ROOF + 24 * SCALE;
  spire.castShadow = true;
  group.add(spire);

  const spireGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(1.0 * SCALE, 1.4 * SCALE, 96 * SCALE, 8),
    alienEmissive,
  );
  spireGlow.position.y = H_ROOF + 16 * SCALE;
  group.add(spireGlow);

  // Rotating gravity ring hovering above the saucer
  const gravRing = new THREE.Mesh(
    new THREE.TorusGeometry(38 * SCALE, 2.4 * SCALE, 12, seg * 2),
    alienHull,
  );
  gravRing.rotation.x = Math.PI / 2;
  gravRing.position.y = H_DECK + 34 * SCALE;
  gravRing.castShadow = true;
  group.add(gravRing);

  const gravGlow = new THREE.Mesh(
    new THREE.TorusGeometry(38 * SCALE, 0.9 * SCALE, 8, seg * 2),
    alienEmissive,
  );
  gravGlow.rotation.x = Math.PI / 2;
  gravGlow.position.y = H_DECK + 34 * SCALE;
  group.add(gravGlow);

  // Beam of light connecting spire to ring
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2 * SCALE, 8 * SCALE, 400 * SCALE, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x4fe3ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  beam.position.y = H_ROOF + 200 * SCALE;
  group.add(beam);

  // Point light so the graft actually illuminates the structure
  const alienLight = new THREE.PointLight(0x36d7ff, 380, 260, 2);
  alienLight.position.y = H_DECK + 20 * SCALE;
  group.add(alienLight);

  const saucerPosition = new THREE.Vector3(position.x, baseY + H_DECK, position.z);

  let t = 0;
  const update = (dt: number, elapsed: number) => {
    t += dt;
    gravRing.rotation.z += dt * 0.22;
    gravGlow.rotation.z -= dt * 0.35;
    const pulse = 0.72 + 0.28 * Math.sin(elapsed * 1.6);
    alienEmissive.emissiveIntensity = 2.6 + pulse * 1.6;
    alienLight.intensity = 260 + pulse * 220;
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.1 + pulse * 0.1;
  };

  return {
    group,
    saucerPosition,
    update,
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      [steel, paintedOrange, glass, alienEmissive, alienHull].forEach((m) => m.dispose());
      scene.remove(group);
    },
  };
}
