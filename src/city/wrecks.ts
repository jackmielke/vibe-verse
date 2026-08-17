/**
 * Things on the bottom of the bay.
 *
 * The sea got waves, then a floor, then caustics on the floor, then fish over
 * the caustics, then a way to swim down and look at all of it. What it never
 * got was a reason. You dive once, see the best-looking thing in the world,
 * and surface, because there is nothing down there — which makes three
 * commits' worth of ocean a very good set and not a place.
 *
 * So: five sites on the seabed, each with something worth the swim.
 *
 * ## Why they are hard to find, on purpose
 *
 * Underwater visibility is forty metres. The bay is hundreds across. That
 * means a site is genuinely searched for rather than walked to, and it is the
 * one piece of level design here — everything else is a consequence of the
 * fog number that was already chosen for looking pretty.
 *
 * Two things follow from it that are worth stating, because both were
 * deliberate and both look like oversights:
 *
 *  - **The sites are on a fixed seeded ring, not scattered randomly.** A
 *    player who finds one learns roughly where the others are, which turns the
 *    second dive from a random walk into a hunt. Uniformly random placement in
 *    a two-hundred-metre bay with forty metres of visibility is not a search,
 *    it is a lottery.
 *  - **Each one glints.** A slow pulse, visible a little further than the site
 *    itself. Without it the fog is not a challenge, it is a wall, and the
 *    honest failure mode of "hidden treasure in heavy fog" is that nobody ever
 *    finds any and concludes there is nothing there — which is exactly the
 *    state this is trying to fix.
 *
 * ## Found is forever
 *
 * A chest pays once per browser, tracked in `localStorage`. Not per session:
 * a per-session flag means reloading re-arms every chest in the bay, and a
 * payout you can farm with F5 is not a discovery, it is a button.
 */
import * as THREE from "three";
import { waterDepthAt, CITY_HALF } from "@/city/ocean";

const STORE = "city.wrecks.found";

export interface WreckSite {
  id: string;
  x: number;
  z: number;
  /** Seabed height at the site, so callers can aim a camera at it. */
  y: number;
  label: string;
  reward: number;
  found: boolean;
}

export interface Wrecks {
  group: THREE.Group;
  sites: WreckSite[];
  /**
   * Advance the glints and test for a collection.
   *
   * Returns the site just collected, or null. `swimmer` is where the player
   * is; `submerged` gates the whole thing — you cannot collect a chest twelve
   * metres down by driving a boat over it.
   */
  update(dt: number, timeSec: number, swimmer: THREE.Vector3, submerged: boolean): WreckSite | null;
  /** Forget every find. Dev only — see `__cityWrecksReset`. */
  reset(): void;
  dispose(): void;
}

/** Radius at which the reach test fires. Generous: this is not a precision toy. */
const REACH = 3.2;

function loadFound(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Private mode, quota, a corrupt value somebody hand-edited. None of those
    // should cost anybody the sea.
    return new Set();
  }
}

function saveFound(found: Set<string>) {
  try {
    localStorage.setItem(STORE, JSON.stringify([...found]));
  } catch { /* see loadFound */ }
}

/**
 * Where the five sites go.
 *
 * A ring at a fixed bearing set, pushed out to wherever the water is deep
 * enough to be worth diving into. The push is a search along the bearing
 * rather than a fixed radius because the coast is a scalloped p-norm, not a
 * circle — a fixed radius would put one site in nine metres of water and the
 * next one on a beach.
 */
function siteSpots(): Array<{ x: number; z: number; y: number }> {
  const BEARINGS = [0.4, 1.75, 2.9, 4.1, 5.4];
  const out: Array<{ x: number; z: number; y: number }> = [];
  for (const a of BEARINGS) {
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    // Walk out until it is at least five metres deep, then a little further.
    let r = CITY_HALF + 40;
    let found = false;
    for (let i = 0; i < 200; i++) {
      if (waterDepthAt(dx * r, dz * r) > 5) { found = true; break; }
      r += 4;
    }
    if (!found) continue;
    r += 25;
    const x = dx * r;
    const z = dz * r;
    out.push({ x, z, y: -waterDepthAt(x, z) });
  }
  return out;
}

const LOOT: Array<{ label: string; reward: number }> = [
  { label: "Barnacled strongbox", reward: 18 },
  { label: "Ship's bell", reward: 12 },
  { label: "Waterlogged suitcase", reward: 15 },
  { label: "Anchor chain hoard", reward: 22 },
  { label: "Someone's lost kart keys", reward: 9 },
];

/**
 * A chest: a box, a domed lid, two bands and a clasp.
 *
 * The lid comes back with it, because a chest emptied during THIS session has
 * to open too. Building the open/closed state once at construction covers the
 * chests you found on a previous visit and silently leaves the one you just
 * swam into sitting there shut, which reads as the collection not having
 * worked — the coins arrive and the world disagrees.
 */
function buildChest(
  open: boolean,
  wood: THREE.Material,
  iron: THREE.Material,
): { group: THREE.Group; lid: THREE.Object3D } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.72, 0.85), wood);
  body.position.y = 0.36;
  g.add(body);
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.43, 0.43, 1.25, 12, 1, false, 0, Math.PI),
    wood,
  );
  lid.rotation.z = Math.PI / 2;
  lid.position.y = 0.72;
  // An emptied chest is left standing open, so a site you have already done
  // reads as done from as far away as you can see it at all.
  if (open) openLid(lid);
  g.add(lid);
  for (const z of [-0.3, 0.3]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.78, 0.07), iron);
    band.position.set(0, 0.38, z);
    g.add(band);
  }
  const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, 0.1), iron);
  clasp.position.set(0, 0.66, 0.44);
  g.add(clasp);
  return { group: g, lid };
}

/** Where an open lid sits, so collecting one at runtime matches one loaded open. */
function openLid(lid: THREE.Object3D) {
  lid.position.z = -0.34;
  lid.rotation.x = -1.15;
}

export function createWrecks(): Wrecks {
  const group = new THREE.Group();
  const trash: Array<{ dispose(): void }> = [];
  const found = loadFound();

  const spots = siteSpots();
  const sites: WreckSite[] = spots.map((s, i) => ({
    id: `wreck-${i}`,
    x: s.x,
    z: s.z,
    y: s.y,
    label: LOOT[i % LOOT.length].label,
    reward: LOOT[i % LOOT.length].reward,
    found: found.has(`wreck-${i}`),
  }));

  /**
   * The glint: an additive sprite that pulses, hung above each site.
   *
   * Not a light. Five point lights on the seabed would be five more forward
   * lights in every material in the city for the sake of something you are
   * within forty metres of about once a session, and this world already
   * carries twenty-nine of them.
   */
  const glintTex = (() => {
    const S = 64;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / (S - 1)) * 2 - 1;
        const v = (y / (S - 1)) * 2 - 1;
        const r = Math.hypot(u, v);
        // A soft core with a four-point star through it, which is what the eye
        // reads as "something metal caught the light" rather than "a dot".
        const core = Math.pow(Math.max(0, 1 - r), 2.6);
        const star = Math.pow(Math.max(0, 1 - Math.abs(u) * 7), 2) * Math.pow(Math.max(0, 1 - r), 1.4)
          + Math.pow(Math.max(0, 1 - Math.abs(v) * 7), 2) * Math.pow(Math.max(0, 1 - r), 1.4);
        const a = Math.min(1, core + star * 0.5);
        const o = (y * S + x) * 4;
        img.data[o] = 255;
        img.data[o + 1] = 246;
        img.data[o + 2] = 200;
        img.data[o + 3] = Math.round(255 * a);
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const glintMat = new THREE.SpriteMaterial({
    map: glintTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // The glint is the thing that has to punch through forty metres of fog.
    // Fogged, it is exactly as invisible as the chest it is advertising.
    fog: false,
  });
  trash.push(glintTex, glintMat);

  // Shared across all five: five chests do not need ten materials, and one
  // material is one thing to dispose rather than ten to remember.
  const wood = new THREE.MeshStandardMaterial({ color: "#5b432c", roughness: 0.85, metalness: 0.05 });
  const iron = new THREE.MeshStandardMaterial({ color: "#6d7379", roughness: 0.5, metalness: 0.75 });
  trash.push(wood, iron);

  const glints: THREE.Sprite[] = [];
  const lids: THREE.Object3D[] = [];
  for (const site of sites) {
    const chest = buildChest(site.found, wood, iron);
    chest.group.position.set(site.x, site.y + 0.05, site.z);
    // Rotated off the grid and tipped, because nothing that sank landed square.
    chest.group.rotation.y = site.x * 0.37 + site.z * 0.11;
    chest.group.rotation.z = 0.12 * Math.sin(site.x * 0.3);
    group.add(chest.group);
    lids.push(chest.lid);
    chest.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) trash.push(m.geometry);
    });

    const glint = new THREE.Sprite(glintMat.clone());
    glint.position.set(site.x, site.y + 1.5, site.z);
    glint.scale.setScalar(1.4);
    glint.visible = !site.found;
    group.add(glint);
    glints.push(glint);
  }

  const tmp = new THREE.Vector3();

  return {
    group,
    sites,

    update(dt, timeSec, swimmer, submerged) {
      void dt;
      let collected: WreckSite | null = null;
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        const glint = glints[i];
        if (site.found) {
          glint.visible = false;
          continue;
        }
        // Slow, uneven pulse — offset per site so five of them in view do not
        // blink in unison like a runway.
        const pulse = 0.55 + 0.45 * Math.sin(timeSec * 1.6 + i * 1.7);
        glint.visible = true;
        glint.scale.setScalar(1.1 + pulse * 0.9);
        (glint.material as THREE.SpriteMaterial).opacity = 0.35 + pulse * 0.5;

        if (!submerged || collected) continue;
        tmp.set(site.x, site.y + 0.6, site.z);
        if (tmp.distanceTo(swimmer) < REACH) {
          site.found = true;
          found.add(site.id);
          saveFound(found);
          glint.visible = false;
          openLid(lids[i]);
          collected = site;
        }
      }
      return collected;
    },

    reset() {
      found.clear();
      saveFound(found);
      for (let i = 0; i < sites.length; i++) {
        sites[i].found = false;
        // Shut them again, or a reset gives you five open chests that pay out.
        lids[i].position.z = 0;
        lids[i].rotation.x = 0;
      }
    },

    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
