# World Building with Lovable

Everything we learned building **Edge Esmeralda** — a 3D, geospatial, social, multi-world web app — distilled into one file so you can skip the roadblocks and start building your own world today.

This is opinionated. Every recommendation here is something we tried, broke, fixed, and shipped. Where there's a sharp edge, we say so.

> **Stack at a glance:** Vite + React + TypeScript + Tailwind + shadcn/ui · **Mapbox GL JS** for the basemap · **Three.js** (GLTF + Draco) for 3D · **Lovable Cloud** (Supabase under the hood) for auth, DB, storage, edge functions · **Bun** for installs.

---

## 0. The mental model

A "world" in this codebase is just three layers stacked on top of a real-world map:

```
┌──────────────────────────────────────────┐
│  React UI  (shadcn panels, chat, menus)  │   ← normal web app
├──────────────────────────────────────────┤
│  Three.js custom layers on Mapbox        │   ← characters, buildings, vehicles
│  (each layer = one createCustomLayer)    │
├──────────────────────────────────────────┤
│  Mapbox GL JS                            │   ← real streets, terrain, 3D buildings
│  (style + DEM source + extrusion layer)  │
└──────────────────────────────────────────┘
```

Everything — Vibey hovering above the plaza, the helicopter you can fly, the floating island, the Death Star — is a **Mapbox custom layer** (`type: "custom", renderingMode: "3d"`) that runs its own Three.js scene, and shares the map's GL context and projection matrix every frame.

Internalize that and the rest of the codebase reads itself.

---

## 1. Why these choices

| Decision | Why | Alternative we considered |
|---|---|---|
| **Mapbox GL JS** | Real streets, terrain DEM, 3D buildings out of the box. Custom layers expose the GL context so Three.js can render in the same projection. | CesiumJS (overkill — planet-scale), MapLibre (works, but Mapbox's 3D buildings + terrain are smoother), Leaflet (no 3D). |
| **Three.js** (not r3f) | Mapbox custom layers want raw `onAdd(map, gl)` / `render(gl, matrix)` callbacks. r3f's reconciler doesn't fit that lifecycle cleanly. | r3f is great for full-screen 3D scenes (see `/space`, `/lobby`, `/garden` — they DO use Three.js directly too because we wanted one mental model). |
| **GLB** for every asset | Single binary, embeds textures + animations, smallest reliable file, native to GLTFLoader. | OBJ (no animations, no PBR), FBX (heavy loader, weird scale), GLTF+bin (two files, fragile). |
| **Draco compression** | Cuts most GLBs 5–10×. Mandatory for anything over a few MB. | Meshopt (also good, less universal). Uncompressed GLB is fine under ~2 MB. |
| **Lovable Cloud** | Auth + Postgres + storage + edge functions with no setup. Same RLS model as Supabase. | Self-hosted Supabase (more setup), Firebase (NoSQL hurts when you want SQL joins). |
| **`/public` for heavy GLBs, `src/assets` for small ones** | `src/assets` imports get bundled into the JS chunk. `public/` is served as static files and lazy-fetched. The 272 MB Edge Island would crash the bundler. | None — this one's a hard rule. |

---

## 2. Mapbox: the basemap that makes it feel real

### Tokens

Mapbox `pk.*` tokens are publishable. They're safe in client code (commit them, they're scoped at the Mapbox dashboard by URL). Don't put `sk.*` server tokens in the frontend.

We keep ours in `src/config/mapbox.ts`:
```ts
export const MAPBOX_TOKEN = "pk.ey...";
export const VILLAGE_CENTER = { lng: -122.87007, lat: 38.61080, zoom: 16 };
```

### The base map setup that always works

```ts
const map = new mapboxgl.Map({
  container,
  style: "mapbox://styles/mapbox/standard",   // or .../satellite-streets-v12
  center: [VILLAGE_CENTER.lng, VILLAGE_CENTER.lat],
  zoom: 16,
  pitch: 60,                                  // tilt for depth
  bearing: -20,
  antialias: true,
});

map.on("style.load", () => {
  // Terrain — without this everything is a flat plane
  map.addSource("mapbox-dem", {
    type: "raster-dem",
    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });

  // Sky
  map.setFog({ color: "#0d1b2a", "horizon-blend": 0.2 });

  // 3D buildings (extrude OSM footprints with the `height` property)
  map.addLayer({
    id: "3d-buildings",
    source: "composite",
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 14,
    paint: {
      "fill-extrusion-color": "#2dd4a8",
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": ["get", "min_height"],
      "fill-extrusion-opacity": 0.85,
      "fill-extrusion-vertical-gradient": true,
    },
  });
});
```

### Sharp edges nobody warns you about

1. **Custom layers get wiped on style toggle.** When the user swaps from "Standard" to "Satellite", every `addLayer(...)` call you made is gone. Re-mount everything inside `map.on("style.load", ...)` — and use a `seatedRef` so you don't add the same layer twice during a single style cycle.

2. **`queryTerrainElevation` returns `null` until the DEM tiles are loaded.** Listen for the `sourcedata` event on `mapbox-dem` with `isSourceLoaded: true` before placing anything that needs to sit on the ground.
   ```ts
   m.on("sourcedata", (e) => {
     if (e.sourceId === "mapbox-dem" && e.isSourceLoaded) {
       seatLandmarks(m);
     }
   });
   ```

3. **Healdsburg sits ~32 m above sea level.** If you place a model at `altitude: 0`, it renders **underground**. Always:
   ```ts
   const elev = m.queryTerrainElevation([lng, lat], { exaggerated: true }) ?? 0;
   const altitude = elev + offsetAboveGround;
   ```

4. **Map resize is a global window event.** When your sidebar opens/closes the map container resizes but Mapbox doesn't observe it. Fire a window resize after the layout settles:
   ```ts
   useEffect(() => {
     const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 320);
     return () => clearTimeout(t);
   }, [sidebarOpen]);
   ```

5. **Mobile Safari hates `100vh`.** Use `100dvh` (dynamic viewport) so the map doesn't get cut off by the URL bar.

---

## 3. The custom-layer pattern (write once, reuse forever)

Every 3D thing in the world follows the same shape. Internalize this and you can ship a new landmark in 20 minutes.

```ts
import mapboxgl from "mapbox-gl";
import * as THREE from "three";

export function createMyThingLayer(
  id: string,
  state: { lng: number; lat: number; altitude: number; heading: number },
): mapboxgl.CustomLayerInterface {
  const SCALE_METERS = 14;
  let camera: THREE.Camera, scene: THREE.Scene, renderer: THREE.WebGLRenderer;
  let mapRef: mapboxgl.Map | null = null;

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(0, -50, 80).normalize();
      scene.add(sun);

      // ...build geometry or load a GLB into `scene`...

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      // Read state every frame so the React layer can drive position/rotation.
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        state.altitude,
      );
      const meterScale = mercator.meterInMercatorCoordinateUnits() * SCALE_METERS;

      // Mapbox is Z-up, Three.js is Y-up — rotate the model into the map's frame.
      const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(mercator.x, mercator.y, mercator.z)
        // NOTE the negative Y scale — Mapbox's Y axis is flipped vs. Three's.
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
        .multiply(rotX);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);

      // Force a continuous repaint so animations run even when the map is idle.
      mapRef?.triggerRepaint();
    },
  };
}
```

The **mutable `state` object passed in** is the secret to making these feel alive. React owns it; the render loop reads from it every frame. No prop drilling, no event bus, just a shared object.

```ts
// In React:
const stateRef = useRef({ lng, lat, altitude, heading: 0 });
useKeyboard((dx, dy) => { stateRef.current.heading += dx * 0.05; });
map.addLayer(createMyThingLayer("nimbus", stateRef.current));
```

---

## 4. Three.js inside Mapbox — the gotchas

These are the "model loaded but nothing's on screen" debugging checklist:

1. **Draco compression is the #1 silent failure.** Many GLBs (Littlest Tokyo, anything from threejs.org examples, anything you optimized with `gltf-transform`) ship Draco-compressed meshes. Without a `DRACOLoader` registered, GLTFLoader returns empty geometry — no error, just invisible.
   ```ts
   const draco = new DRACOLoader();
   draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
   const loader = new GLTFLoader();
   loader.setDRACOLoader(draco);
   ```

2. **PBR materials with `metalness: 1.0` render pure black** without an environment map. Quaternius and Meshy GLBs both ship like this. Clamp them on load:
   ```ts
   gltf.scene.traverse((obj) => {
     const mesh = obj as THREE.Mesh;
     if (!mesh.isMesh) return;
     const std = mesh.material as THREE.MeshStandardMaterial;
     if (std && "metalness" in std) {
       std.metalness = Math.min(std.metalness, 0.3);
       std.roughness = Math.max(std.roughness, 0.45);
       std.envMapIntensity = 1.0;
       std.needsUpdate = true;
     }
   });
   ```

3. **Always normalize model size.** GLBs come in wildly different scales (some are in cm, some in m, some in arbitrary blender units). Fit into a known box, then control real-world size via `scaleMeters`:
   ```ts
   const box = new THREE.Box3().setFromObject(model);
   const size = new THREE.Vector3(); box.getSize(size);
   const fit = 2 / Math.max(size.x, size.y, size.z);
   model.scale.setScalar(fit);
   ```

4. **Anchor at bottom vs. center is a different decision.** Buildings should sit on the ground (`y = -box.min.y * fit`). Floating islands should be centered (`y = -center.y * fit`). We made `bottomAnchor: boolean` an explicit flag in `SpawnableLayer`.

5. **Skinned animations need a mixer that you tick every frame.** Don't forget the delta:
   ```ts
   if (gltf.animations.length) {
     mixer = new THREE.AnimationMixer(model);
     gltf.animations.forEach((c) => mixer.clipAction(c).play());
   }
   // in render():
   const delta = (now - lastTime) / 1000;
   mixer?.update(delta);
   ```

6. **`renderer.autoClear = false`** is non-negotiable. Without it your Three scene wipes the Mapbox tiles every frame and you get a black map.

7. **Triggering repaint.** Mapbox only renders when something changes. If you want continuous animation, call `map.triggerRepaint()` at the end of every `render()` — it's cheap.

---

## 5. The asset pipeline

### Where files live

```
src/assets/glb/   → small (<2 MB), bundled into JS, available via `import url from "..."`
public/models/    → heavy assets, served as static files, lazy-fetched at runtime
```

Rule of thumb: anything over **2 MB** belongs in `public/`. The Edge Island (272 MB) and Death Star (60 MB) are gitignored and dropped in by the user.

### Format choices, ranked

| Format | Use it for | Notes |
|---|---|---|
| **GLB** (binary glTF) | Everything. | Single file, embeds textures + animations, every loader supports it. |
| GLTF + .bin + textures | Never, when you could ship GLB. | Two-file format breaks if relative paths drift. |
| OBJ | Static low-poly props from old asset packs. | Convert with `npx obj2gltf -i in.obj -o out.glb -b`. No animations, no PBR. |
| FBX | Animated characters from Mixamo / Quaternius. | Convert with `assimp export in.fbx out.glb -fglb2`. Animations bake into GLB cleanly. |
| STL / DAE / PLY | Don't. | Convert in Blender. |

### Compression

Run every GLB over ~2 MB through:
```bash
npx -y @gltf-transform/cli optimize input.glb output.glb --compress draco
```
Typical reductions: 60–90%. Or use the visual tool at [gltf.report](https://gltf.report).

### Where to find assets

- **[Quaternius](https://quaternius.com)** — free CC0 low-poly packs. We use their nature, characters, pirates, animals. Step-by-step playbook in [`docs/skills/quaternius-pack.md`](docs/skills/quaternius-pack.md).
- **[Poly Haven](https://polyhaven.com)** — CC0 PBR materials, HDRIs, models.
- **[Sketchfab](https://sketchfab.com)** — huge marketplace, lots of free CC0.
- **[Mixamo](https://www.mixamo.com)** — free auto-rigging + walk/run/dance animations for any humanoid.
- **[Meshy](https://www.meshy.ai)** — text/image-to-3D. Used for the Edge Island, Death Star, and most of the `/space` props.
- **[Luma AI](https://lumalabs.ai)** — text-to-3D plus NeRF (turn a real video into a 3D scene).
- **[threejs.org/examples](https://threejs.org/examples/)** — every model in their gallery is fetchable. Littlest Tokyo lives here.

---

## 6. Physics and movement

Edge Esmeralda doesn't use a physics engine — every flying/walking entity is **direct kinematic control**. That's a deliberate choice: physics engines (Rapier, cannon-es) are amazing but they want their own world frame, and bridging them through Mapbox's mercator projection is more pain than it's worth for "fly a helicopter over a town."

The pattern, lifted from `MapView.tsx` flight controls:

```ts
// Per-frame in your React rAF loop (separate from the Mapbox render):
const dt = (now - last) / 1000;
const speed = throttle * MAX_SPEED;                       // m/s
const vNorth = Math.cos(state.heading) * speed;
const vEast  = Math.sin(state.heading) * speed;

// Convert m/s into degrees of lng/lat (the mercator-aware way)
const dLat = (vNorth * dt) / 111_111;
const dLng = (vEast  * dt) / (111_111 * Math.cos(state.lat * Math.PI / 180));
state.lat += dLat;
state.lng += dLng;
state.altitude += vUp * dt;
state.heading  += yawInput * TURN_RATE * dt;
state.bank      = lerp(state.bank, -yawInput * MAX_BANK, 0.1);
```

That's it. ~30 lines and you have a flyable craft. The `bank` is purely cosmetic — applied as a Z-rotation in the render() of the layer — but it sells the feel.

If you want **real physics** (collisions, gravity, character controllers), use [Rapier](https://rapier.rs) inside an `r3f` scene that's NOT bridged to Mapbox — make it a separate `/playground` route. That's how `/space`, `/lobby`, and `/garden` work in this project.

### Chase camera

When the user is "piloting" an entity, the map camera follows it. Compute an offset behind/above the entity in mercator space and call `map.jumpTo`:

```ts
const offsetMeters = 110;
const back = {
  lng: state.lng - Math.sin(state.heading) * offsetMeters / (111_111 * Math.cos(state.lat * Math.PI/180)),
  lat: state.lat - Math.cos(state.heading) * offsetMeters / 111_111,
};
map.jumpTo({
  center: [back.lng, back.lat],
  bearing: state.heading * 180 / Math.PI,
  pitch: 70,
  zoom: 18,
});
```

`jumpTo` (not `easeTo`) — easeTo will fight your every frame.

---

## 7. Lovable Cloud / Supabase patterns

Lovable Cloud is Supabase under the hood, with auto-provisioning and a friendlier UX. You write the same SQL, RLS, and edge functions.

### What we used it for

- **Auth** — magic links + Telegram. Lovable Cloud handles the JWT, the client just calls `supabase.auth.signInWithOtp({ email })`.
- **`user_locations` table** — opt-in live location sharing among community members.
- **Edge functions** — `unit7-chat` (LLM proxy), `vibey-monologue` (beat generator), `community-stats` (joined queries the client can't do efficiently).
- **Storage** — community-uploaded photos that float as orbs in `/space`.

### Roles, RLS, and the trap everyone falls into

**Never put a `role` column on `users` or `profiles`.** It's a privilege escalation waiting to happen. Roles go in their own table with their own RLS, and you query them through a `SECURITY DEFINER` function:

```sql
create type public.app_role as enum ('admin', 'moderator', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  );
$$;

create policy "Admins read all" on public.some_table
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));
```

The `SECURITY DEFINER` + `set search_path = public` is what stops infinite recursion when an RLS policy on `user_roles` references itself. We learned this the hard way.

### Edge functions

Use them for:
- LLM calls (keep API keys server-side)
- Joins / aggregations the client shouldn't see raw rows for
- Webhook receivers
- Anything that needs to write with elevated privileges

The `unit7-chat` function is a good reference — it proxies OpenRouter, validates the user's session, rate-limits, and streams the response back.

### Realtime presence (location sharing)

For "see other people on the map" features, two patterns work:

1. **Postgres + polling** (what we shipped). Cheap, simple, slightly stale. Fine for <100 concurrent users.
2. **Supabase Realtime channels** (`presence`). Lower latency, per-channel cost. Use this when you want sub-second updates or typing indicators.

Either way, **default to OFF**. Location sharing is opt-in, with an explicit toggle, an `expires_at` timestamp on every record, and visibility scoped to community peers (not the public). We have a `viewer_shares_community_with_user(viewer, target)` helper function that the RLS policy calls.

---

## 8. The events-app + community-chat shell

The thing you noticed — the "events app with a map" feel — is mostly two patterns:

### Split-screen with a collapsible sidebar

On desktop: map on the left, panel on the right, a 7px tab to collapse/expand. On mobile: full-screen map with a bottom nav (`BottomNav.tsx`) that swaps between Map / Events / Community as separate sections, with the map kept mounted but hidden so switching back is instant.

```tsx
{tab === "events" && <motion.section className="absolute inset-0 ..."><EventsPanel /></motion.section>}
```

### Location-aware feed

When a user clicks a venue marker on the map, the right-hand `EventsPanel` filters to events at that venue. The `selectedLocation` lives in the page-level state and is passed to both the map and the panel. One source of truth, no event bus.

This is the magic of "events app + 3D world": the **map is the navigation**. Tapping a building IS tapping a filter.

### Community chat / presence

Each venue has a chat thread keyed by `venue_id`. We use Supabase realtime channels for live messages. Avatars float over the venue beacon when people are "checked in."

---

## 9. UI: making the chrome feel like part of the world

A few specific moves that bought a lot of polish:

- **`glass-panel` utility** — a single Tailwind class with `backdrop-blur-xl bg-card/60 border border-border/40`. Use it everywhere for floating UI. Makes the map feel like it's underneath, not behind.
- **`framer-motion` for every panel transition** — `initial={{ opacity: 0, y: 12 }}` is the default. Never let UI pop in.
- **Splash screen** — `<SplashScreen onEnter={...} />` gates the first paint. Buys time for Mapbox to load tiles + DEM, and lets you do a dramatic camera fly-in once the user clicks "Enter."
- **Cinematic camera on landmark click** — `map.flyTo({ center, zoom: 18, pitch: 75, bearing, duration: 2000, essential: true })`. The `essential: true` is critical or `prefers-reduced-motion` users see an instant jump.
- **Hover labels, not always-on labels** — the map gets noisy fast. Show venue names only on hover/tap.

The visual identity (Neon Mint: dark base, electric green) is in `index.css` as HSL design tokens. Never hardcode colors in components — extend the token system.

---

## 10. Performance budget

Real numbers from this project running smooth on an iPhone 12:

| Layer | Budget | Notes |
|---|---|---|
| Initial JS bundle | < 1 MB | Use `import.meta.glob` for character packs so Vite code-splits per route. |
| First-load GLBs | < 6 MB total | `src/assets/glb/` total. Anything heavier → `public/`, fetched on demand. |
| On-demand GLBs (per spawn) | < 30 MB | Compressed with Draco. Show a progress bar — `GLTFLoader.load(url, onLoad, onProgress)` gives you bytes streamed. |
| Custom layers active at once | ~10 | Each is its own Three scene. Past ~10 you start eating frame budget. |
| Active animation mixers | ~5 | Each tick is cheap, but they add up. |
| Map zoom for 3D buildings | ≥ 14 | Below this the building data isn't loaded; don't bother extruding. |

When you cross a budget: lazy-load (the SpawnableLayer pattern), instance shared geometry (one GLB → many `Mesh.clone()`s), or fall back to a `fill-extrusion` block.

---

## 11. The 5-step recipe for a new world

Here's the speedrun. Use it as a checklist when you fork this repo for World Building with Lovable.

1. **Pick your anchor.** Find a real place on Mapbox, grab `lng/lat`, drop it in a `WORLD_CENTER` constant. Set `pitch: 60`, `zoom: 16`.

2. **Theme the basemap.** Pick a Mapbox style (`mapbox://styles/mapbox/standard` is great), tint your 3D buildings via `fill-extrusion-color`, set fog color to match your palette. Five minutes, huge vibe shift.

3. **Drop in 1–3 hero landmarks.** Either:
   - **Procedural Three.js** (cylinders + spheres + glow) for stylized stuff — see `PlazaLayer.ts` / `ObservatoryLayer.ts`. Tiny, animatable, themeable.
   - **GLB with `SpawnableLayer`** for sourced models — one line: `createSpawnableLayer("dome", state, { modelUrl: "/models/dome.glb" })`.

4. **Add one character.** Vibey is just a GLB hovering with a bob + slow yaw. Mixamo a walk cycle onto a humanoid, save as GLB, copy `VibeyLayer.ts`, swap the model URL. You now have a mascot.

5. **Wire Lovable Cloud.** Enable it from the Lovable UI (no API keys), add `auth.users` magic-link login, create a `posts` or `events` table, build a panel that lists rows next to the map. The "events + map + community" feel is genuinely just that.

After that, every additional feature — flying vehicles, spawnable worlds, shared presence — follows one of the patterns in this file.

---

## 12. Things we'd do differently next time

- **Type the mutable state objects more aggressively.** We pass `stateRef.current` into ten different layers; a stricter `WorldEntityState` interface would have caught a few bugs.
- **Use a single `WorldBus`** event emitter instead of plumbing callbacks for "Vibey was clicked" / "helicopter landed." We didn't, and it's fine, but it'd scale better past ~20 entities.
- **Bake more elevations.** `queryTerrainElevation` is async-ish (depends on tiles). For a fixed set of venues, just hardcode the heights in a JSON and skip the dance.
- **Move heavy GLBs to a CDN.** Right now they sit in `/public/`. For a real launch, S3 + CloudFront with `Cache-Control: immutable` is way faster.
- **Build the multiplayer layer earlier.** Adding presence / cursors / shared spawns retroactively is harder than designing for it from frame one. If multiplayer is your goal, look at [Hyperfy](https://hyperfy.io) or [PartyKit](https://partykit.io) on day one.

---

## 13. Curated reading list

If you want to go deep, these are the resources worth your time:

- **[Three.js examples gallery](https://threejs.org/examples/)** — every interaction pattern you'll need has a precedent here.
- **[Bruno Simon's Three.js Journey](https://threejs-journey.com/)** — best paid course on the planet for WebGL/Three.
- **[WebGLFundamentals](https://webglfundamentals.org/)** — when you eventually need to write a shader.
- **[glTF 2.0 spec](https://github.com/KhronosGroup/glTF)** — skim once, save hours of debugging when textures or animations don't load.
- **[Mapbox custom layer docs](https://docs.mapbox.com/mapbox-gl-js/example/custom-style-layer/)** — the official Three.js bridge example. Our `SpawnableLayer` is this, generalized.
- **[Supabase RLS docs](https://supabase.com/docs/guides/auth/row-level-security)** — read it once, all the way through. RLS bugs are nasty in production.
- **[Lovable docs](https://docs.lovable.dev)** — Lovable Cloud, AI Gateway, custom emails, deployment.

---

## 14. License + attribution

This codebase ships under MIT (see `LICENSE`). The 3D assets keep their original licenses:

- **Quaternius packs** — CC0
- **Meshy / Luma generated assets** — owned by the user who generated them; if you fork, regenerate your own
- **Mapbox tiles** — covered by your Mapbox account's plan
- **threejs.org example models** (Littlest Tokyo, etc.) — CC-BY, see threejs.org/examples
- **Lovable Cloud** — usage-based, free tier covers prototypes

When you ship your own world, list your assets and their licenses in your README. Future you will thank present you.

---

## 15. Now go build

The fastest way to internalize all of this is to fork the repo, swap `VILLAGE_CENTER` to your hometown, change one landmark to a building you know, and fly Vibey over your own street. Once that loop closes you'll have the muscle memory for the rest.

Ship something weird. Make a world that couldn't exist anywhere but the browser. That's the whole point.

— *the Edge Esmeralda team*

---

## 16. VR / Headset support (WebXR)

Pure-Three.js scenes (Lobby, Unit7 stage, Memory Garden) ship with WebXR enabled. Open `https://edgeesmeralda.lovable.app/lobby` (or `/garden`) in the **Quest Browser**, **Pico Browser**, or any WebXR-capable browser, and tap the **"Enter VR"** pill in the bottom-right of the canvas. Works on Quest 2/3/Pro, Pico 4, Valve Index, and anything else that exposes `navigator.xr`.

The Mapbox-based worlds (the village map, helicopter, saucer) are **not** VR-able as-is — Mapbox GL is a 2D-projected canvas with our Three.js custom layers riding on top, so the camera model doesn't translate to immersive XR. To put the village in VR you'd build a parallel pure-Three.js scene that loads the same GLB assets onto a flat ground plane (or a baked terrain mesh from Mapbox elevation) and skips the map tiles entirely. All the GLBs are already in `src/assets/glb/` and `public/models/` — see `src/components/map/*Layer.ts` for how each one is positioned.

### Adding WebXR to a new Three.js scene

The helper lives in `src/lib/webxr.ts`. Three lines:

```ts
import { enableVR } from "@/lib/webxr";

const disposeVR = enableVR(renderer, canvas.parentElement!, {
  referenceSpace: "local-floor",
});
renderer.setAnimationLoop(tick); // not requestAnimationFrame!
// cleanup: disposeVR(); renderer.setAnimationLoop(null);
```

**Critical**: replace `requestAnimationFrame(tick)` with `renderer.setAnimationLoop(tick)`. In an XR session, three drives the loop from headset vsync — rAF won't fire and your scene freezes.

Locomotion (teleport, controllers, hand tracking) isn't included yet — scenes are "viewing" experiences for now. When you add it, build on `THREE.XRControllerModelFactory` plus a teleport-ray helper. Quest controllers expose trigger + thumbstick; teleport on trigger-release is the comfortable default and avoids sim sickness.
