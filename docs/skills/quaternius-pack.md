# Skill: Adding a Quaternius Asset Pack

Quaternius (https://quaternius.com) ships a ton of free low-poly asset packs.
This is the playbook for getting one into the project, regardless of whether
it's a "scatter pack" (trees / rocks / props) or a "single animated character".

## 0. Inspect the pack

Quaternius packs ship as a folder with subfolders for `Blends/`, `FBX/`, and
sometimes `OBJ/`. Look at the file count and whether they're animated.

- Many small static models → **scatter pack** (use NaturePackLayer pattern)
- One or two `.fbx` with bones → **animated character** (use alien prop pattern)

## 1. Convert to GLB

Three.js loads GLB way more reliably than FBX or OBJ — and our pipeline already
uses GLTFLoader everywhere. Convert once, commit the GLBs, throw away the
source files.

### OBJ → GLB (no animations)

```bash
cd "/path/to/Pack/OBJ" && for f in *.obj; do
  npx -y obj2gltf -i "$f" -o "/path/to/edgeesmeralda/src/assets/glb/<packname>/${f%.obj}.glb" -b
done
```

`-b` produces a single binary GLB instead of `.gltf` + `.bin`. Output is small
(low-poly Quaternius models compress to a few KB each).

### FBX → GLB (preserves animations)

```bash
brew install assimp   # one time
assimp export "/path/to/Character.fbx" \
  src/assets/glb/<filename>.glb -fglb2
```

Animations get baked into the GLB and are accessible via `gltf.animations` at
load time.

## 2. Decide which pattern

### Scatter pack → new Mapbox layer

Use this when you want to mark a venue with a cluster of repeated low-poly
items (a park's grove, a beach's umbrellas, a vineyard's rows of vines).

Reference: `src/components/map/NaturePackLayer.ts`.

The shape:
1. Import every GLB at the top of the file as a Vite asset URL
2. `buildScatter(seed, radius)` returns deterministic positions + scales +
   rotations using a seeded PRNG so the layout is stable across reloads
3. The Three.js scene loads each GLB once and clones instances per scatter
   item — geometry/material is shared
4. `render()` rotates each item slightly via `sin(t + phase) * amplitude` so
   the cluster sways like wind. Skip sway for rocks.
5. Always include sun + sky-fill `DirectionalLight`s so MeshPhongMaterial
   exports actually have shape

Wire it up in `MapView.tsx`:
- Add `markerStyle: "your-pack"` to the `VILLAGE_LOCATIONS` entry
- In `addVenueBeaconLayers`, branch on `markerStyle === "your-pack"` and call
  your new `createYourPackLayer(...)` instead of the beam factory
- Pass `loc.id` as the seed so each venue gets a unique-but-stable layout

### Single character → playground prop

Use this when you want a character or hero object that the user can spawn
into the Vibey 2.0 playground (`/space`).

Reference: the `alien` entry in `src/pages/Unit7Playground.tsx`.

The shape:
1. Import the GLB at the top: `import xyzUrl from "@/assets/glb/xyz.glb"`
2. Add the id to the `PropId` union
3. Add an entry to `PROP_CFG` inside the spawnable-props effect:
   ```ts
   xyz: {
     url: xyzUrl,
     target: 2.4,                       // approx height in scene units
     position: [-2.4, 0.1, -1.2],       // somewhere on/near the platform
     rotationY: 0.6,
     spin: 0,                           // 0 = no auto-rotate
     bob: 0,                            // 0 = no auto-bob
     playClip: true,                    // play the first animation clip
   }
   ```
4. Add a button to the Props panel grid:
   ```tsx
   { id: "xyz" as const, label: "👽 Xyz" },
   ```

The PROP_CFG load callback already handles the mixer when `playClip: true`:

```ts
if (cfg.playClip && gltf.animations?.length) {
  const mixer = new THREE.AnimationMixer(m);
  mixer.clipAction(gltf.animations[0]).play();
  placeholder.userData.mixer = mixer;
}
```

…and the render tick advances every prop's mixer if it has one.

## 3. PBR material clamp (always)

Both Quaternius and Meshy GLBs ship PBR materials whose `metalness` is often
near 1.0. Without an environment map for them to reflect, they render
*pure black*. The fix is the same in every layer:

```ts
m.traverse((obj) => {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh) return;
  const apply = (mat: THREE.Material) => {
    const std = mat as THREE.MeshStandardMaterial;
    if (std && "metalness" in std) {
      std.metalness = Math.min(std.metalness, 0.3);
      std.roughness = Math.max(std.roughness, 0.45);
      std.envMapIntensity = 1.0;
      std.needsUpdate = true;
    }
  };
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach(apply);
  else if (mat) apply(mat);
});
```

(Quaternius's older OBJ packs ship MeshPhongMaterial after `obj2gltf`, which
doesn't have `metalness` — the guard `"metalness" in std` makes the clamp a
no-op for those, so the same block is safe to copy-paste anywhere.)

## 4. Don't refresh GLB layers on every map update

If you tear down + re-add your custom layer on every `sourcedata` event, the
GLB re-loads on every pan/zoom and the cluster flickers. Seat once.

Pattern in `MapView.tsx`:
```ts
const beaconsSeatedRef = useRef(false);
m.on("style.load", () => { beaconsSeatedRef.current = false; });
m.on("sourcedata", (e) => {
  if (e.sourceId === "mapbox-dem" && e.isSourceLoaded) {
    if (!beaconsSeatedRef.current) {
      refreshVenueBeacons(m);
      beaconsSeatedRef.current = true;
    }
  }
});
```

## 5. Commit

GLBs are small (<2 MB usually) and live alongside source — they go in git.
Mention in the commit message which pack they came from + the conversion
command so future-you (or future-Claude) can repro.

---

## Adding more packs from Quaternius

The pattern scales. Some natural pairings if you grab more from
https://quaternius.com :

| Pack | Use as |
|---|---|
| Simple Nature Pack | Park scatter (trees + bushes + rocks) |
| Ultimate Furniture | Indoor venue (CraftWork, Hotel Trio) scatter |
| Stylized Stages | Main Stage venue scatter (riser + speakers + lights) |
| Modular Buildings | Replace a beam with a proper 3D building structure |
| Animated Characters | New playground props (alien-style, animated) |
| Animated Animals | Wandering critters at Giorgi Park |
| Stylized Cars | Animated traffic along Healdsburg Ave |

Each one follows steps 1–4 above with a different scatter rule or prop
position.
