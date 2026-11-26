/**
 * heistChase — THE GETAWAY: the city heist you can actually foil.
 *
 * Every few minutes a gremlin cracks the city vault and tears off
 * through the streets in a stolen kart, loot sack strapped to the
 * back, golden sparkles spilling behind it. Chase it down — on foot,
 * in a kart, or by jetpack — and ram it to recover the loot.
 *
 * The kart runs a fixed zig-zag lap along the street centerlines
 * (they sit at ±20 and ±60 on the 40m city pitch), slowing slightly
 * into corners so a sprinting player can close the gap on straights.
 * If nobody stops it for ~100 seconds, it vanishes into an alley with
 * the loot.
 */
import * as THREE from "three";

const SPEED = 13.5; // m/s on straights — sprint (16) beats it, walk doesn't
const CORNER_SLOW = 0.6; // speed factor while braking into a waypoint
const CATCH_RADIUS = 2.6;
const ESCAPE_MS = 100_000;
const TRAIL_COUNT = 14;
const TRAIL_DROP_MS = 320;
const TRAIL_LIFE_MS = 2100;

// One big lap that uses both street rings, every leg axis-aligned on a
// street centerline. Starts (and loops) at the plaza's NE corner.
const ROUTE: Array<[number, number]> = [
  [20, 20],
  [20, -20],
  [60, -20],
  [60, -60],
  [-20, -60],
  [-20, 20],
  [-60, 20],
  [-60, 60],
  [20, 60],
];

export interface HeistChase {
  group: THREE.Group;
  start(now: number): void;
  /** Advance the sim. Returns "caught" / "escaped" on the frame the run ends. */
  update(dt: number, now: number, playerPos: THREE.Vector3, shredder?: boolean): "caught" | "escaped" | "busted" | null;
  /** True while a lawnmower is chewing the kart up; the page throws debris. */
  shredding(): boolean;
  isActive(): boolean;
  pos(): THREE.Vector3;
  /** The police got there first. Ends the run; `update` reports "busted". */
  bust(): void;
}

function lootTagTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const x = c.getContext("2d")!;
  x.clearRect(0, 0, 96, 96);
  x.font = "bold 64px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.shadowColor = "#ffd166";
  x.shadowBlur = 16;
  x.fillStyle = "#ffe9b3";
  x.fillText("✦", 48, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildHeistChase(): HeistChase {
  const group = new THREE.Group();
  group.visible = false;

  // ---- The getaway kart -------------------------------------------------
  const kart = new THREE.Group();
  group.add(kart);

  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.4, 2.2),
    new THREE.MeshStandardMaterial({ color: "#31161f", roughness: 0.5, metalness: 0.3 }),
  );
  chassis.position.y = 0.45;
  kart.add(chassis);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.28, 0.5),
    new THREE.MeshStandardMaterial({ color: "#521f2e", roughness: 0.5, metalness: 0.3 }),
  );
  nose.position.set(0, 0.5, 1.25);
  kart.add(nose);
  const wheelMat = new THREE.MeshStandardMaterial({ color: "#0d0d10", roughness: 0.9 });
  const wheels: THREE.Mesh[] = [];
  for (const [wx, wz] of [
    [-0.75, 0.8],
    [0.75, 0.8],
    [-0.75, -0.8],
    [0.75, -0.8],
  ] as const) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 12), wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.32, wz);
    kart.add(w);
    wheels.push(w);
  }

  // The gremlin driver: green, masked, extremely guilty.
  const gremlinGreen = new THREE.MeshStandardMaterial({ color: "#5fd068", roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), gremlinGreen);
  body.position.set(0, 0.95, -0.25);
  kart.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), gremlinGreen);
  head.position.set(0, 1.4, -0.25);
  kart.add(head);
  const mask = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.12, 0.2),
    new THREE.MeshStandardMaterial({ color: "#14141a", roughness: 0.4 }),
  );
  mask.position.set(0, 1.44, -0.06);
  kart.add(mask);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 8), gremlinGreen);
    ear.position.set(side * 0.24, 1.62, -0.25);
    ear.rotation.z = side * -0.5;
    kart.add(ear);
  }

  // The loot sack on the back, tagged with a floating ✦.
  const sack = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 10, 8),
    new THREE.MeshStandardMaterial({ color: "#8a6a45", roughness: 0.95 }),
  );
  sack.scale.y = 1.15;
  sack.position.set(0, 0.95, -0.95);
  kart.add(sack);
  const knot = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: "#6f5334", roughness: 0.95 }),
  );
  knot.position.set(0, 1.42, -0.95);
  kart.add(knot);
  const tag = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: lootTagTexture(), transparent: true, depthWrite: false }),
  );
  tag.scale.setScalar(0.6);
  tag.position.set(0, 2.0, -0.95);
  kart.add(tag);

  // Little siren so the crime reads from across the plaza.
  const sirenA = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.14, 0.16),
    new THREE.MeshBasicMaterial({ color: "#ff5b5b" }),
  );
  sirenA.position.set(-0.12, 1.82, -0.25);
  kart.add(sirenA);
  const sirenB = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.14, 0.16),
    new THREE.MeshBasicMaterial({ color: "#7ad7ff" }),
  );
  sirenB.position.set(0.12, 1.82, -0.25);
  kart.add(sirenB);
  const sirenLight = new THREE.PointLight(0xff5b5b, 0, 18, 1.8);
  sirenLight.position.set(0, 2.1, 0);
  kart.add(sirenLight);

  // ---- Sparkle trail ------------------------------------------------------
  const sparkTex = lootTagTexture();
  const trail: Array<{ s: THREE.Sprite; bornAt: number }> = [];
  for (let i = 0; i < TRAIL_COUNT; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sparkTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: "#ffd166",
      }),
    );
    s.scale.setScalar(0.42);
    group.add(s);
    trail.push({ s, bornAt: -Infinity });
  }
  let trailIdx = 0;
  let lastDropAt = 0;

  // ---- Run state ----------------------------------------------------------
  let active = false;
  let wpIdx = 1;
  let startedAt = 0;
  let shredT = -1;
  let busted = false;
  const SHRED_SECONDS = 1.1;

  const api: HeistChase = {
    group,
    isActive: () => active,
    pos: () => kart.position.clone(),
    shredding: () => active && shredT >= 0,
    start(now) {
      shredT = -1;
      active = true;
      startedAt = now;
      wpIdx = 1;
      kart.position.set(ROUTE[0][0], 0, ROUTE[0][1]);
      kart.scale.setScalar(1);
      group.visible = true;
      for (const t of trail) t.bornAt = -Infinity;
    },
    bust() {
      if (active) busted = true;
    },
    update(dt, now, playerPos, shredder = false) {
      if (!active) return null;
      if (busted) {
        busted = false;
        shredT = -1;
        kart.scale.setScalar(1);
        active = false;
        group.visible = false;
        return "busted";
      }

      // Under a lawnmower: stops dead, judders and is ground down to nothing.
      if (shredT < 0 && shredder && playerPos.distanceTo(kart.position) < CATCH_RADIUS + 1) shredT = 0;
      if (shredT >= 0) {
        shredT += dt;
        kart.scale.setScalar(Math.max(0.02, 1 - shredT / SHRED_SECONDS));
        kart.rotation.y += dt * 30;
        kart.position.y = Math.random() * 0.3;
        if (shredT >= SHRED_SECONDS) {
          shredT = -1;
          kart.scale.setScalar(1);
          active = false;
          group.visible = false;
          return "caught";
        }
        return null;
      }

      // Drive toward the next waypoint, braking into the turn.
      const [tx, tz] = ROUTE[wpIdx];
      const dx = tx - kart.position.x;
      const dz = tz - kart.position.z;
      const dist = Math.hypot(dx, dz);
      const speed = dist < 5 ? SPEED * CORNER_SLOW : SPEED;
      if (dist < 0.8) {
        wpIdx = (wpIdx + 1) % ROUTE.length;
      } else {
        kart.position.x += (dx / dist) * speed * dt;
        kart.position.z += (dz / dist) * speed * dt;
        const targetYaw = Math.atan2(dx, dz);
        let dyaw = targetYaw - kart.rotation.y;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        kart.rotation.y += dyaw * Math.min(1, dt * 9);
      }
      for (const w of wheels) w.rotation.x += speed * dt * 3;
      kart.position.y = Math.abs(Math.sin(now * 0.02)) * 0.05; // rattle

      // Siren strobe.
      const strobe = Math.sin(now * 0.02) > 0;
      (sirenA.material as THREE.MeshBasicMaterial).color.set(strobe ? "#ff5b5b" : "#5b1a1a");
      (sirenB.material as THREE.MeshBasicMaterial).color.set(strobe ? "#26404d" : "#7ad7ff");
      sirenLight.intensity = strobe ? 7 : 2;
      sirenLight.color.set(strobe ? 0xff5b5b : 0x7ad7ff);
      tag.position.y = 2.0 + Math.sin(now * 0.004) * 0.12;

      // Drop + fade the sparkle trail.
      if (now - lastDropAt > TRAIL_DROP_MS) {
        lastDropAt = now;
        const t = trail[trailIdx];
        trailIdx = (trailIdx + 1) % TRAIL_COUNT;
        t.bornAt = now;
        t.s.position.set(
          kart.position.x + (Math.random() - 0.5) * 0.8,
          0.5 + Math.random() * 0.5,
          kart.position.z + (Math.random() - 0.5) * 0.8,
        );
      }
      for (const t of trail) {
        const age = now - t.bornAt;
        (t.s.material as THREE.SpriteMaterial).opacity =
          age < TRAIL_LIFE_MS ? 0.85 * (1 - age / TRAIL_LIFE_MS) : 0;
      }

      // Caught?
      if (playerPos.distanceTo(kart.position) < CATCH_RADIUS) {
        active = false;
        group.visible = false;
        return "caught";
      }
      // Escaped?
      if (now - startedAt > ESCAPE_MS) {
        active = false;
        group.visible = false;
        return "escaped";
      }
      return null;
    },
  };
  return api;
}
