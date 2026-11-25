/** Draws body stickers as small emoji decals attached to a character's model. */
import * as THREE from "three";
import { SLOT_PLACE, type Sticker } from "./stickers";

const NAME = "__stickers";
const texCache = new Map<string, THREE.Texture>();
function tex(art: string) {
  let t = texCache.get(art);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.font = "100px serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(art, 64, 70);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(art, t);
  }
  return t;
}

/** Rebuilds the decals on `holder` (sized from its own meshes, in holder space). */
export function applyStickers(holder: THREE.Object3D, list: Sticker[]) {
  const old = holder.getObjectByName(NAME);
  if (old) {
    holder.remove(old);
    old.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  }
  if (!list.length) return;
  holder.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const meshes: THREE.Mesh[] = [];
  holder.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    for (let a: THREE.Object3D | null = m; a && a !== holder; a = a.parent) if (!a.visible) return;
    const mat = m.material as THREE.Material;
    if (mat && !Array.isArray(mat) && mat.transparent) return; // flames, glows, shadows
    meshes.push(m);
  });
  // A rigged body is the skinned meshes; anything else rigid (jetpack, hat) is gear, not body.
  const skinned = meshes.filter((m) => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh[];
  // Skinned bounds come back with the transform applied twice in some rigs, so only the
  // world box's *size* is trusted; the body is assumed centred on the holder with feet at its origin.
  const world = new THREE.Box3();
  for (const m of skinned.length ? skinned : meshes) world.union(tmp.setFromObject(m, !skinned.length));
  if (!world.isEmpty()) {
    const ws = world.getSize(new THREE.Vector3());
    const hw = Math.max(ws.x, ws.z) / 2, hd = Math.min(ws.x, ws.z) / 2;
    const sc = new THREE.Vector3().setFromMatrixScale(holder.matrixWorld);
    box.set(new THREE.Vector3(-hw / sc.x, 0, -hd / sc.z), new THREE.Vector3(hw / sc.x, ws.y / sc.y, hd / sc.z));
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const group = new THREE.Group();
  group.name = NAME;
  for (const s of list) {
    const p = SLOT_PLACE[s.slot];
    const d = p.size * size.y;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(d, d),
      new THREE.MeshBasicMaterial({ map: tex(s.art), transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    const x = box.min.x + p.fx * size.x;
    const y = box.min.y + p.fy * size.y;
    if (p.face === 0) {
      mesh.position.set(p.fx > 0.5 ? box.max.x + 0.01 : box.min.x - 0.01, y, (box.min.z + box.max.z) / 2);
      mesh.rotation.y = p.fx > 0.5 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      // Inset from the box so it sits on the torso rather than floating at the arms' extent.
      const zFront = box.max.z - size.z * 0.12, zBack = box.min.z + size.z * 0.12;
      mesh.position.set(x, y, p.face > 0 ? zFront : zBack);
      if (p.face < 0) mesh.rotation.y = Math.PI;
    }
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  holder.add(group);
}
