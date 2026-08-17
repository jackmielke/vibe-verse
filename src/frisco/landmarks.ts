/**
 * landmarks.ts — the twelve buildings that make it San Francisco.
 *
 * Everything in `city.ts` is generated: three thousand blocks that are correct
 * in aggregate and anonymous one at a time. That is the right way to build a
 * city and it is completely unable to build a *place*. Nobody has ever said
 * "meet me at the fourth block up from Market"; they say the Ferry Building,
 * and they mean a specific silhouette they have known since they were eight.
 *
 * So these twelve are authored by hand, from the actual buildings, and they
 * follow two rules the generated city does not:
 *
 *  - **Silhouette before detail.** A landmark has to be recognisable at
 *    eight hundred metres, from the air, at fifty pixels tall — that is how
 *    most people will meet it. The Transamerica is a triangle with two wings.
 *    Coit Tower is a white cylinder with a crown. Salesforce is a fat tapered
 *    round thing. Get the outline right and the rest is decoration; get it
 *    wrong and no amount of window detail rescues it.
 *  - **They get outlines.** `look.ts` reserves the inverted-hull outline for
 *    the objects that carry the world's identity, and this is that list. It
 *    costs a second draw of a few thousand triangles and it is what makes them
 *    read as drawn rather than extruded.
 *
 * Positions come from `map.ts` and nowhere else, so the block generator's
 * exclusion zones and these can never drift apart.
 */
import { Batch, rgb, shade } from "./batch";
import { COLORS } from "./look";
import { landmarkPositions, roadAt, walkHeight, type Vec2 } from "./map";
import type { BuildingBox } from "./city";

type C = [number, number, number];

/* ------------------------------------------------------------------ *
 * The buildings
 * ------------------------------------------------------------------ */

/**
 * The Transamerica Pyramid.
 *
 * Four sloped faces to a point, plus the two blank "wings" partway up that
 * hold the lifts and the stairs — and the wings are the whole recognition
 * cue. A plain pyramid is a shape; a pyramid with two rectangular ears is
 * *that* building. The real one is 260 m to the tip of the spire on a 53 m
 * square base, which is a taper steep enough that it reads as a spike from
 * every direction.
 */
function transamerica(b: Batch, p: Vec2, base: number): void {
  const white = rgb(0xf4f1ea);
  const shadow = rgb(0xd9d5cc);
  const H = 212;
  const HW = 26;
  const yaw = -0.045;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [
    p.x + lx * cs - lz * sn, base + ly, p.z + lx * sn + lz * cs,
  ];

  /* The four sloped faces, each split into bands so the toon ramp has
     something to bite on and the windows have somewhere to be.

     The winding is derived rather than case-split, and that is deliberate.
     The first version had a hand-written `if (ax === 1 || az === -1)
     reverse-the-order` and it was right for two faces out of four: the
     pyramid came out with its east and south sides inside out, which under
     back-face culling means you see straight through them to the black
     outline shell behind. Half a black pyramid, and it looks like a shading
     bug rather than a winding one.

     For an outward axis `n` in the XZ plane, the screen-right direction seen
     from outside is `r = up x n`, and listing the corners bottom-left,
     bottom-right, top-right, top-left in that frame is counter-clockwise from
     outside for every face, with no special cases left to get wrong. */
  const BANDS = 26;
  const faces: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [ax, az] of faces) {
    const rx = az;
    const rz = -ax;
    for (let i = 0; i < BANDS; i++) {
      const y0 = (H * i) / BANDS;
      const y1 = (H * (i + 1)) / BANDS;
      const w0 = HW * (1 - i / BANDS);
      const w1 = HW * (1 - (i + 1) / BANDS);
      const col: C = i % 2 === 1 ? shade(shadow, 0.94) : white;
      b.quad(
        P(ax * w0 - rx * w0, y0, az * w0 - rz * w0),
        P(ax * w0 + rx * w0, y0, az * w0 + rz * w0),
        P(ax * w1 + rx * w1, y1, az * w1 + rz * w1),
        P(ax * w1 - rx * w1, y1, az * w1 - rz * w1),
        col,
      );
    }
  }

  // The wings: two blank slabs on the east and west flanks, starting a third
  // of the way up and running most of the rest.
  for (const s of [-1, 1]) {
    const y0 = H * 0.28;
    const y1 = H * 0.82;
    const w = HW * (1 - y0 / H) + 1.2;
    b.box(
      p.x + s * w * cs, base + y0, p.z + s * w * sn,
      3.0, y1 - y0, 5.2, shade(white, 0.97), 1, yaw,
    );
  }

  // The spire.
  b.cylinder(p.x, base + H, p.z, 1.6, 0.25, 34, 6, shade(white, 1.04), false);
}

/**
 * Salesforce Tower: a tall rounded rectangle that tapers all the way up and
 * stops without a top. Sixty-one sides is not the point — the point is that
 * it has no corners and no crown, which is exactly what makes it read as
 * itself next to the Transamerica's spike.
 */
function salesforce(b: Batch, p: Vec2, base: number): void {
  const skin = rgb(0xa9bccd);
  const glass = rgb(0x7f9fbb);
  const H = 268;
  const BANDS = 22;
  for (let i = 0; i < BANDS; i++) {
    const t0 = i / BANDS;
    const t1 = (i + 1) / BANDS;
    const y0 = base + H * t0;
    const r0 = 21 * (1 - 0.42 * t0 * t0);
    const r1 = 21 * (1 - 0.42 * t1 * t1);
    b.cylinder(p.x, y0, p.z, r0, r1, H * (t1 - t0), 16, i % 2 ? glass : skin, false);
  }
  // A soft cap so it does not read as a cut-off tube from above.
  b.cylinder(p.x, base + H, p.z, 21 * 0.58, 21 * 0.5, 5, 16, shade(skin, 1.06));
}

/**
 * Coit Tower: a plain white fluted column with a crown of arches, standing on
 * a stepped plinth on top of Telegraph Hill. Everybody thinks it is a fire
 * hose nozzle; the architect denied it his whole life.
 */
function coit(b: Batch, p: Vec2, base: number): void {
  const stone = rgb(0xece7dc);
  const dark = rgb(0xc9c2b3);
  b.cylinder(p.x, base, p.z, 12, 11, 2.4, 12, shade(stone, 0.9));
  b.cylinder(p.x, base + 2.4, p.z, 8.4, 7.6, 2.2, 12, shade(stone, 0.95));
  // The shaft, in flutes: sixteen sides is enough to read as fluting at range
  // and cheap enough to leave alone.
  b.cylinder(p.x, base + 4.6, p.z, 6.4, 5.7, 42, 16, stone, false);
  // The crown: a ring of arches, then the observation deck.
  b.cylinder(p.x, base + 46.6, p.z, 6.9, 6.9, 1.6, 16, shade(dark, 1.0), false);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(
      p.x + Math.cos(a) * 6.2, base + 48.2, p.z + Math.sin(a) * 6.2,
      1.1, 7.2, 1.1, shade(stone, 1.02), 1, -a,
    );
  }
  b.cylinder(p.x, base + 55.4, p.z, 7.2, 6.2, 2.6, 16, shade(stone, 1.06));
  b.cylinder(p.x, base + 58, p.z, 4.4, 0, 6, 12, shade(dark, 1.05), false);
}

/**
 * The Ferry Building: a long low arcade with a clock tower in the middle,
 * modelled on the Giralda in Seville. It sits square across the foot of
 * Market, which is why every street downtown seems to be aiming at it.
 */
function ferry(b: Batch, p: Vec2, base: number): void {
  const stone = rgb(0xe8e0cf);
  const roof = rgb(0x9a8f7c);
  const gold = rgb(COLORS.gold);
  // The arcade runs along the waterfront, which here means along Market's
  // normal — the building faces the street head on.
  const yaw = Math.PI / 2 + 0.36;
  b.bandedBox(p.x, base, p.z, 84, 16, 13, stone, shade(stone, 0.9), 3, 1, yaw);
  b.box(p.x, base + 16, p.z, 86, 1.4, 14, shade(roof, 1.0), 1, yaw);
  // The tower.
  b.bandedBox(p.x, base, p.z, 11, 52, 11, stone, shade(stone, 0.92), 9, 0.94, yaw);
  b.box(p.x, base + 52, p.z, 11.6, 2, 11.6, shade(roof, 0.95), 1, yaw);
  /* The clock faces: one on each side, and they are the reason anybody looks.
     A flat slab standing against the wall rather than `cylinder`, because
     `cylinder` stands on Y — a short one is a dinner plate lying face up, and
     four gold dinner plates halfway up a tower is not a clock. */
  for (const [ax, az] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ox = ax * c - az * s;
    const oz = ax * s + az * c;
    b.box(
      p.x + ox * 10.6, base + 40.6, p.z + oz * 10.6,
      3.4, 6.8, 0.4, gold, 1, Math.atan2(-ox, oz),
    );
  }
  // The lantern on top.
  b.bandedBox(p.x, base + 54, p.z, 6.2, 12, 6.2, stone, gold, 3, 0.8, yaw);
  b.cylinder(p.x, base + 66, p.z, 5.4, 0, 10, 8, shade(roof, 1.05), false);
}

/**
 * Grace Cathedral: a French Gothic cathedral in reinforced concrete, on the
 * top of Nob Hill. Two square west towers, a long nave, a rose window. It is
 * the most recognisable thing on the hill and the hill is what you see it
 * against.
 */
function grace(b: Batch, p: Vec2, base: number): void {
  const stone = rgb(0xdcd6c8);
  const shadowed = rgb(0xbcb5a5);
  const rose = rgb(0x6fa8d8);
  const yaw = -0.045 + Math.PI / 2;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (lx: number, lz: number): Vec2 => ({
    x: p.x + lx * cs - lz * sn,
    z: p.z + lx * sn + lz * cs,
  });

  // The nave, with a steeper roof on top of it.
  b.bandedBox(p.x, base, p.z, 34, 22, 12, stone, shadowed, 3, 1, yaw);
  b.gable(p.x, base + 22, p.z, 34, 7, 12.4, shade(shadowed, 0.95), yaw);
  // Transepts, so it is a cross from the air rather than a shed.
  b.bandedBox(p.x, base, p.z, 11, 20, 22, stone, shadowed, 3, 1, yaw);
  b.gable(p.x, base + 20, p.z, 22.4, 6, 11, shade(shadowed, 0.95), yaw + Math.PI / 2);
  // The two west towers.
  for (const s of [-1, 1]) {
    const t = at(-31, s * 9);
    b.bandedBox(t.x, base, t.z, 6.5, 40, 6.5, stone, shadowed, 6, 0.93, yaw);
    b.box(t.x, base + 40, t.z, 7.2, 1.4, 7.2, shade(shadowed, 1.0), 1, yaw);
    b.cylinder(t.x, base + 41.4, t.z, 5.4, 0, 9, 4, shade(shadowed, 1.05), false);
  }
  // The rose window, standing in the west front facing down the hill. Same
  // trap as the Ferry Building's clocks: a short cylinder lies flat.
  const w = at(-34.4, 0);
  b.box(w.x, base + 21, w.z, 0.5, 10.4, 10.4, rose, 1, yaw);
}

/**
 * The Dragon Gate at Grant and Bush: a green-tiled paifang with three
 * openings, two stone lions, and a lot of gold. It is the front door of
 * Chinatown and it is small — fourteen metres — which is worth knowing before
 * you look for it from the air.
 */
function dragonGate(b: Batch, p: Vec2, base: number): void {
  const green = rgb(0x3f8f5c);
  const red = rgb(0xc0392b);
  const gold = rgb(COLORS.gold);
  const stone = rgb(COLORS.stone);
  const r = roadAt(p.x, p.z);
  const yaw = Math.atan2(r.dir.z, r.dir.x) + Math.PI / 2;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (lx: number, lz: number): Vec2 => ({
    x: p.x + lx * cs - lz * sn, z: p.z + lx * sn + lz * cs,
  });

  // Four pillars: two tall in the middle, two short outside.
  for (const [off, h] of [[-9.5, 6.5], [-3.4, 10.5], [3.4, 10.5], [9.5, 6.5]] as const) {
    const q = at(off, 0);
    b.box(q.x, base, q.z, 0.9, h, 0.9, red, 1, yaw);
    b.box(q.x, base, q.z, 1.4, 1.2, 1.4, stone, 1, yaw);
  }
  // Three tiled roofs, the middle one higher — the shape that says paifang.
  const roof = (lx: number, y: number, halfW: number) => {
    const q = at(lx, 0);
    b.box(q.x, base + y, q.z, halfW, 0.5, 2.4, gold, 1, yaw);
    b.gable(q.x, base + y + 0.5, q.z, halfW + 0.8, 1.6, 3.0, green, yaw);
  };
  roof(0, 10.5, 4.6);
  roof(-6.4, 6.5, 3.6);
  roof(6.4, 6.5, 3.6);
  // The lions.
  for (const s of [-1, 1]) {
    const q = at(s * 12.4, 0);
    b.box(q.x, base, q.z, 1.0, 1.6, 1.0, stone, 1, yaw);
    b.box(q.x, base + 1.6, q.z, 0.7, 1.1, 0.9, shade(stone, 1.05), 1, yaw);
  }
}

/**
 * Union Square: the Dewey Monument — a granite column with Victory on top —
 * standing in a plaza of palms. The plaza itself is `OPEN_SPACES`' job; this
 * is the column, the steps, and the palms.
 */
function unionSquare(b: Batch, p: Vec2, base: number): void {
  const stone = rgb(COLORS.stone);
  const gold = rgb(COLORS.gold);
  const trunk = rgb(COLORS.trunk);
  const palm = rgb(COLORS.palmLeaf);
  const paving = rgb(0xd6cfc0);

  b.box(p.x, base, p.z, 34, 0.5, 34, paving);
  for (let i = 0; i < 3; i++) {
    b.box(p.x, base + 0.5 + i * 0.45, p.z, 6 - i * 1.4, 0.45, 6 - i * 1.4, shade(stone, 0.95 + i * 0.03));
  }
  b.cylinder(p.x, base + 1.85, p.z, 1.5, 1.2, 24, 12, stone, false);
  b.cylinder(p.x, base + 25.85, p.z, 1.8, 1.6, 1.2, 12, shade(stone, 1.05));
  // Victory, as a suggestion rather than a statue.
  b.box(p.x, base + 27.05, p.z, 0.55, 2.6, 0.55, gold);
  b.box(p.x, base + 28.4, p.z, 1.9, 0.28, 0.35, gold);

  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const px = p.x + Math.cos(a) * 26;
    const pz = p.z + Math.sin(a) * 26;
    b.cylinder(px, base, pz, 0.5, 0.34, 11, 6, trunk, false);
    for (let f = 0; f < 6; f++) {
      const fa = (f / 6) * Math.PI * 2;
      b.box(
        px + Math.cos(fa) * 2.2, base + 10.8, pz + Math.sin(fa) * 2.2,
        2.6, 0.22, 0.7, shade(palm, 0.9 + 0.2 * (f % 2)), 1, -fa,
      );
    }
  }
}

/**
 * Pier 39: two rows of shingled sheds on a deck out over the water, with the
 * float of sea lions alongside. Built on piles, because the whole reason it
 * looks the way it does is that it is standing in the bay.
 */
function pier39(b: Batch, p: Vec2, base: number): void {
  const deck = rgb(0xb99a72);
  const shed = rgb(0xcfc0a6);
  const roof = rgb(0x8b7d68);
  const pile = rgb(0x6f5a44);
  // The pier runs out into the bay — northward, away from the shore.
  const yaw = 0.2;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (lx: number, lz: number): Vec2 => ({
    x: p.x + lx * cs - lz * sn, z: p.z + lx * sn + lz * cs,
  });

  const DECK_Y = base + 3.4;
  b.box(p.x, DECK_Y, p.z, 26, 0.8, 62, deck, 1, yaw);
  // Piles under it. They are only visible from the water, which is exactly
  // where you arrive from with a jetpack.
  for (let i = -3; i <= 3; i++) {
    for (let j = -7; j <= 7; j++) {
      const q = at(i * 8, j * 8.4);
      b.cylinder(q.x, base - 3, q.z, 0.5, 0.45, DECK_Y - base + 3, 5, pile, false);
    }
  }
  // Two rows of sheds with a lane between them.
  for (const s of [-1, 1]) {
    for (let j = 0; j < 7; j++) {
      const q = at(s * 15, -50 + j * 15);
      b.bandedBox(q.x, DECK_Y + 0.8, q.z, 6.4, 6, 6.4, shed, shade(shed, 0.86), 2, 1, yaw);
      b.gable(q.x, DECK_Y + 6.8, q.z, 6.8, 2.6, 6.8, roof, yaw + Math.PI / 2);
    }
  }
}

/**
 * The crooked block of Lombard Street: eight switchbacks down a hill too steep
 * to drive straight. The hedges between the turns are the part everybody
 * photographs, so they are geometry rather than a colour on the ground.
 */
function lombard(b: Batch, p: Vec2, base: number): void {
  void base;
  const brick = rgb(0xb0563f);
  const hedge = rgb(0x4e8a44);
  const flower = rgb(0xd8628f);
  const kerb = rgb(COLORS.sidewalk);
  const TURNS = 8;
  const LEN = 84;
  const WIDE = 11;

  /* The road is a `ribbon`, not hand-rolled quads, and that is the second time
     this file has learned it. The first version emitted the switchbacks as
     four-corner quads with an explicit up-normal — which fixes the *lighting*
     and does nothing about the *winding*, so all eight of them were built
     facing down into the hill and culled away. What was left was eight black
     edge-on slivers and a row of hedges standing in a field.

     `ribbon` is the same code every road in the city goes through: it winds
     correctly and it samples the terrain per vertex, which matters more here
     than anywhere else in the world, because a switchback that does not follow
     the hill is just a zigzag painted on a slope. */
  const pts: Vec2[] = [];
  for (let i = 0; i <= TURNS; i++) {
    const t = i / TURNS;
    const s = i % 2 === 0 ? 1 : -1;
    pts.push({ x: p.x - LEN / 2 + LEN * t, z: p.z + s * WIDE * 0.5 });
  }
  b.ribbon(pts, 3.4, 0.16, brick, walkHeight);

  /* A planted bed in the crook of each hairpin, which is the part everybody
     photographs. It goes *inside* the turn — between the two legs of road that
     meet there — not outside it, which is where the first version put them and
     which scattered eight flowerbeds across the neighbours' gardens. */
  const bedW = LEN / (TURNS * 2) - 0.8;
  for (let i = 0; i <= TURNS; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const mx = p.x - LEN / 2 + (LEN * i) / TURNS;
    const mz = p.z + s * WIDE * 0.22;
    const my = walkHeight(mx, mz);
    b.box(mx, my, mz, bedW, 1.1, WIDE * 0.16, hedge);
    b.box(mx, my + 1.1, mz, bedW - 0.5, 0.3, WIDE * 0.13, flower);
  }
  // A kerb down each side of the block, so the switchbacks read as contained.
  for (const s of [-1, 1]) {
    for (let i = 0; i < TURNS * 2; i++) {
      const kx = p.x - LEN / 2 + (LEN * (i + 0.5)) / (TURNS * 2);
      const kz = p.z + s * (WIDE * 0.5 + 4.2);
      b.box(kx, walkHeight(kx, kz), kz, LEN / (TURNS * 4) - 0.2, 0.32, 1.4, kerb);
    }
  }
}

/**
 * The Powell Street cable car turnaround: a wooden turntable in the road, a
 * car sitting on it, and the queue rail. It is the smallest landmark here and
 * the one people are most likely to walk into by accident, which is the whole
 * reason to build it.
 */
function cableCar(b: Batch, p: Vec2, base: number): void {
  const wood = rgb(0x8e7350);
  const car = rgb(0xb03a2e);
  const cream = rgb(0xf0e6cf);
  const rail = rgb(COLORS.metal);
  b.cylinder(p.x, base, p.z, 8.4, 8.4, 0.35, 20, wood);
  b.cylinder(p.x, base + 0.35, p.z, 7.2, 7.2, 0.12, 20, shade(wood, 1.06));
  // The car.
  b.box(p.x, base + 0.6, p.z, 4.4, 0.6, 1.7, shade(wood, 0.8));
  b.bandedBox(p.x, base + 1.2, p.z, 4.2, 2.4, 1.6, car, cream, 3);
  b.box(p.x, base + 3.6, p.z, 4.5, 0.3, 1.8, cream);
  for (const s of [-1, 1]) {
    b.cylinder(p.x + s * 3.2, base + 3.9, p.z, 0.09, 0.09, 1.1, 4, rail, false);
  }
  // The queue rail, because the queue is the landmark.
  for (let i = 0; i < 8; i++) {
    const a = Math.PI * 0.15 + (i / 8) * Math.PI * 0.7;
    b.cylinder(p.x + Math.cos(a) * 11, base, p.z + Math.sin(a) * 11, 0.1, 0.1, 1.1, 4, rail, false);
  }
}

/**
 * The Bay Bridge, western span: two suspension spans hung off a central
 * anchorage, running east off the edge of the map. Only the first tower and a
 * few hundred metres are inside the world — which is fine, because that is
 * exactly how much of it you can see from downtown anyway.
 */
function bayBridge(b: Batch, p: Vec2, base: number): void {
  const steel = rgb(0xa8b0b8);
  const deck = rgb(0x8d9299);
  const cable = rgb(0xd8dde1);
  const DECK_Y = 58;
  const RUN = 620;
  const dir = { x: 0.94, z: -0.34 };
  const at = (t: number, off = 0): Vec2 => ({
    x: p.x + dir.x * t - dir.z * off,
    z: p.z + dir.z * t + dir.x * off,
  });

  // The deck, as one long ribbon at a constant height.
  const pts: Vec2[] = [];
  for (let t = -60; t <= RUN; t += 40) pts.push(at(t));
  b.ribbon(pts, 12, 0, deck, () => base + DECK_Y);
  b.ribbon(pts, 12.6, -1.6, shade(deck, 0.8), () => base + DECK_Y);

  // Two towers, and the catenary between them drawn as a chain of short bars.
  const towers = [140, 470];
  for (const tt of towers) {
    for (const s of [-1, 1]) {
      const q = at(tt, s * 10);
      b.box(q.x, base, q.z, 3.4, DECK_Y + 62, 3.4, steel);
    }
    const a = at(tt, -12);
    const c = at(tt, 12);
    b.box((a.x + c.x) / 2, base + DECK_Y + 54, (a.z + c.z) / 2, 12, 2.2, 2.2,
      shade(steel, 1.05), 1, Math.atan2(c.z - a.z, c.x - a.x));
  }
  for (const s of [-1, 1]) {
    const SEG = 26;
    for (let i = 0; i < SEG; i++) {
      const t0 = towers[0] + ((towers[1] - towers[0]) * i) / SEG;
      const t1 = towers[0] + ((towers[1] - towers[0]) * (i + 1)) / SEG;
      const sag = (u: number) => {
        const m = (u - 0.5) * 2;
        return DECK_Y + 6 + 50 * m * m;
      };
      const q0 = at(t0, s * 10);
      const q1 = at(t1, s * 10);
      const y0 = base + sag(i / SEG);
      const y1 = base + sag((i + 1) / SEG);
      const len = Math.hypot(q1.x - q0.x, q1.z - q0.z, y1 - y0);
      const mid = { x: (q0.x + q1.x) / 2, z: (q0.z + q1.z) / 2 };
      b.box(mid.x, (y0 + y1) / 2, mid.z, len / 2, 0.7, 0.7, cable, 1,
        Math.atan2(q1.z - q0.z, q1.x - q0.x));
      // A hanger down to the deck.
      if (i % 2 === 0) {
        b.box(q0.x, base + DECK_Y, q0.z, 0.18, sag(i / SEG) - DECK_Y, 0.18, cable);
      }
    }
  }
}

/**
 * Alcatraz: the cellhouse along the ridge, the lighthouse at the south end,
 * and the water tower. The island itself is terrain — see `map.ts` — so this
 * is only what somebody built on it.
 */
function alcatraz(b: Batch, p: Vec2, base: number): void {
  const cell = rgb(0xd8d2c4);
  const roof = rgb(0x9b8f7c);
  const trim = rgb(0xb0432f);
  const white = rgb(0xf2efe6);
  const yaw = 0.5;
  b.bandedBox(p.x, base, p.z, 46, 13, 11, cell, shade(cell, 0.84), 3, 1, yaw);
  b.box(p.x, base + 13, p.z, 47, 1.2, 12, roof, 1, yaw);
  b.bandedBox(p.x - 14, base + 14.2, p.z + 6, 8, 9, 6, cell, trim, 2, 1, yaw);
  b.box(p.x - 14, base + 23.2, p.z + 6, 8.6, 1, 6.6, roof, 1, yaw);
  // The lighthouse.
  b.cylinder(p.x + 34, base, p.z + 22, 3.4, 3.4, 2, 10, shade(white, 0.92));
  b.cylinder(p.x + 34, base + 2, p.z + 22, 2.4, 1.9, 22, 10, white, false);
  b.cylinder(p.x + 34, base + 24, p.z + 22, 2.8, 2.8, 2.4, 10, trim);
  b.cylinder(p.x + 34, base + 26.4, p.z + 22, 2.4, 0, 3, 10, shade(white, 1.05), false);
  // The water tower, on legs.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.78;
    b.cylinder(p.x - 36 + Math.cos(a) * 3.4, base, p.z - 14 + Math.sin(a) * 3.4,
      0.4, 0.3, 16, 4, shade(roof, 0.9), false);
  }
  b.cylinder(p.x - 36, base + 16, p.z - 14, 4.6, 4.6, 7, 10, shade(white, 0.96));
  b.cylinder(p.x - 36, base + 23, p.z - 14, 4.6, 0, 3.4, 10, trim, false);
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

type Builder = (b: Batch, p: Vec2, base: number) => void;

const BUILDERS: Record<string, Builder> = {
  transamerica,
  salesforce,
  coit,
  ferry,
  grace,
  dragon: dragonGate,
  dewey: unionSquare,
  pier39,
  lombard,
  cablecar: cableCar,
  baybridge: bayBridge,
  alcatraz,
};

/**
 * Boxes the player should collide with, for the landmarks that are solid.
 *
 * Not every landmark gets one, and that is a design decision rather than an
 * omission: the Dragon Gate is a thing you walk *under*, Lombard is a road,
 * and the cable car turnaround is flush with the street. Giving those a box
 * would put an invisible wall across a pavement, which is the single most
 * infuriating bug a walkable world can have.
 */
const SOLID: Record<string, { hw: number; hd: number; h: number }> = {
  transamerica: { hw: 26, hd: 26, h: 212 },
  salesforce: { hw: 21, hd: 21, h: 268 },
  coit: { hw: 12, hd: 12, h: 61 },
  ferry: { hw: 15, hd: 84, h: 66 },
  grace: { hw: 40, hd: 24, h: 41 },
  pier39: { hw: 26, hd: 62, h: 13 },
  alcatraz: { hw: 46, hd: 24, h: 14 },
};

export function buildLandmarks(b: Batch, colliders: BuildingBox[]): number {
  let built = 0;
  for (const site of landmarkPositions()) {
    const make = BUILDERS[site.key];
    if (!make) continue;
    const base = walkHeight(site.x, site.z);
    make(b, { x: site.x, z: site.z }, base);
    built++;
    const solid = SOLID[site.key];
    if (solid) {
      colliders.push({
        x: site.x, z: site.z, hw: solid.hw, hd: solid.hd,
        yaw: 0, baseY: base, roofY: base + solid.h,
      });
    }
  }
  return built;
}
