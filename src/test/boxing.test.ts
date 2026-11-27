/**
 * Haymaker: the body reader and the fight rules, with synthetic arms.
 *
 * There is nobody in front of the sandbox's camera, so these are what stands
 * between "the classifier compiles" and "a jab is a jab": a fast arm going
 * out is a punch, the same arm coming back is not, fists by the face is a
 * guard, a lean is a lean, and a slipped punch opens the opponent up.
 */
import { describe, it, expect } from "vitest";
import { BodyReader, TUNING, type Landmark } from "@/boxing/pose";
import { Bout, ROSTER, SLIP, type PlayerInput } from "@/boxing/fight";

/** A body facing the camera. x is the raw (unmirrored) image coordinate. */
function body(opts: { nose?: number; lw?: [number, number, number?]; rw?: [number, number, number?] } = {}): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const nose = opts.nose ?? 0.5;
  lm[0] = { x: nose, y: 0.25, z: 0, visibility: 1 };
  // the player's left shoulder is on the right of the raw image
  lm[11] = { x: 0.6, y: 0.4, z: 0, visibility: 1 };
  lm[12] = { x: 0.4, y: 0.4, z: 0, visibility: 1 };
  // resting fists: chest high, in front of each shoulder
  const lw = opts.lw ?? [0.62, 0.55];
  const rw = opts.rw ?? [0.38, 0.55];
  lm[15] = { x: lw[0], y: lw[1], z: lw[2] ?? 0, visibility: 1 };
  lm[16] = { x: rw[0], y: rw[1], z: rw[2] ?? 0, visibility: 1 };
  return lm;
}

/** Move the left wrist from a to b over `ms`, sampled at 30 fps. */
function sweep(r: BodyReader, t0: number, a: [number, number, number?], b: [number, number, number?], ms: number) {
  const out = [];
  const n = Math.max(2, Math.round(ms / 33));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p: [number, number, number] = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * u];
    out.push(r.read(body({ lw: p }), t0 + (i * ms) / n));
  }
  return out;
}

describe("reading a body", () => {
  it("sees nobody when there is nobody", () => {
    const r = new BodyReader();
    expect(r.read(null, 0).present).toBe(false);
    expect(r.read([], 0).present).toBe(false);
  });

  it("mirrors, so the player's left hand is on screen left", () => {
    const r = new BodyReader();
    const b = r.read(body(), 0);
    expect(b.present).toBe(true);
    expect(b.fists.L.sx).toBeLessThan(0.5);
    expect(b.fists.R.sx).toBeGreaterThan(0.5);
  });

  it("calls a fast jab out from the chin a punch, with the hand that threw it", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.56, 0.38] }), t);
    // out and toward the camera, fast
    const reads = sweep(r, 300, [0.56, 0.38], [0.52, 0.3, -0.5], 120);
    const punches = reads.flatMap((x) => x.punches);
    expect(punches.length).toBe(1);
    expect(punches[0].hand).toBe("L");
    expect(punches[0].power).toBeGreaterThan(0.15);
  });

  it("does not call pulling the fist back in a punch", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.5, 0.3, -0.5] }), t);
    const reads = sweep(r, 300, [0.5, 0.3, -0.5], [0.6, 0.42, 0], 120);
    expect(reads.flatMap((x) => x.punches)).toHaveLength(0);
  });

  it("does not call a slow reach a punch", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.56, 0.38] }), t);
    const reads = sweep(r, 300, [0.56, 0.38], [0.52, 0.3, -0.5], 1500);
    expect(reads.flatMap((x) => x.punches)).toHaveLength(0);
  });

  it("calls a fist driven straight up an uppercut", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.55, 0.6] }), t);
    const reads = sweep(r, 300, [0.55, 0.6], [0.53, 0.32, -0.2], 130);
    // it is held for a moment in case the other fist comes up too
    for (let t = 450; t < 650; t += 33) reads.push(r.read(body({ lw: [0.53, 0.32, -0.2] }), t));
    const p = reads.flatMap((x) => x.punches);
    expect(p).toHaveLength(1);
    expect(p[0].kind).toBe("uppercut");
  });

  it("does not call both fists coming up into a guard a double uppercut", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.58, 0.62], rw: [0.42, 0.62] }), t);
    const punches = [];
    for (let i = 0; i <= 10; i++) {
      const u = Math.min(1, i / 4);
      const y = 0.62 + (0.3 - 0.62) * u;
      punches.push(...r.read(body({ lw: [0.58 - 0.04 * u, y], rw: [0.42 + 0.04 * u, y] }), 300 + i * 33).punches);
    }
    expect(punches).toHaveLength(0);
  });

  it("throws once per punch, not once per frame", () => {
    const r = new BodyReader();
    for (let t = 0; t < 300; t += 33) r.read(body({ lw: [0.56, 0.38] }), t);
    const reads = sweep(r, 300, [0.56, 0.38], [0.4, 0.3, -0.8], 260);
    expect(reads.flatMap((x) => x.punches).length).toBe(1);
    expect(TUNING.cooldownMs).toBeGreaterThan(100);
  });

  it("sees a guard when both fists are up by the face", () => {
    const r = new BodyReader();
    const b = r.read(body({ lw: [0.54, 0.3], rw: [0.46, 0.3] }), 0);
    expect(b.guard).toBe(true);
    expect(r.read(body(), 33).guard).toBe(false);
  });

  it("measures a lean against where the player stands", () => {
    const r = new BodyReader();
    r.read(body({ nose: 0.5 }), 0);
    // raw x up is screen left once mirrored
    const b = r.read(body({ nose: 0.6 }), 33);
    expect(b.lean).toBeLessThan(-SLIP);
    const c = r.read(body({ nose: 0.4 }), 66);
    expect(c.lean).toBeGreaterThan(SLIP);
  });
});

const still: PlayerInput = { guard: false, lean: 0, punches: [] };

function runUntil(b: Bout, phase: string, input: PlayerInput = still, max = 30): boolean {
  for (let t = 0; t < max; t += 1 / 30) {
    b.step(1 / 30, input);
    if (b.opp.phase === phase) return true;
  }
  return false;
}

describe("a bout", () => {
  it("has four original opponents, each harder than the last", () => {
    expect(ROSTER).toHaveLength(4);
    for (let i = 1; i < ROSTER.length; i++) {
      expect(ROSTER[i].windup).toBeLessThan(ROSTER[i - 1].windup);
      expect(ROSTER[i].hp).toBeGreaterThan(ROSTER[i - 1].hp);
    }
  });

  it("winds up before every punch, so there is always time to react", () => {
    const b = new Bout(ROSTER[0], { seed: 3 });
    b.start();
    expect(runUntil(b, "windup")).toBe(true);
    expect(b.opp.len).toBeGreaterThan(0.4);
  });

  it("hurts you if you stand there", () => {
    const b = new Bout({ ...ROSTER[0], guardiness: 0, feint: 0 }, { seed: 5 });
    b.start();
    runUntil(b, "recover");
    expect(b.playerHp).toBeLessThan(100);
  });

  it("opens them up when you slip away from the glove, and a counter hits double", () => {
    const opp = { ...ROSTER[0], guardiness: 0, feint: 0, combo: 0 };
    const b = new Bout(opp, { seed: 9 });
    b.start();
    runUntil(b, "windup");
    const lean = b.opp.side === "R" ? -1 : 1;
    expect(runUntil(b, "open", { guard: false, lean, punches: [] })).toBe(true);
    expect(b.playerHp).toBe(100);
    const before = b.opp.hp;
    const ev = b.step(1 / 30, { guard: false, lean: 0, punches: [{ hand: "L", kind: "jab", power: 0.5 }] });
    const hit = ev.find((e) => e.type === "hit");
    expect(hit && hit.type === "hit" && hit.counter).toBe(true);
    const plain = new Bout(opp, { seed: 9 });
    plain.start();
    plain.step(1 / 30, { guard: false, lean: 0, punches: [{ hand: "L", kind: "jab", power: 0.5 }] });
    expect(before - b.opp.hp).toBeGreaterThan((opp.hp - plain.opp.hp) * 1.8);
  });

  it("leaning into the punch is not a slip", () => {
    const b = new Bout({ ...ROSTER[0], guardiness: 0, feint: 0, combo: 0 }, { seed: 11 });
    b.start();
    runUntil(b, "windup");
    const wrong = b.opp.side === "R" ? 1 : -1;
    runUntil(b, "recover", { guard: false, lean: wrong, punches: [] });
    expect(b.playerHp).toBeLessThan(100);
  });

  it("a guard takes most of it", () => {
    const b = new Bout({ ...ROSTER[0], guardiness: 0, feint: 0, combo: 0 }, { seed: 13 });
    b.start();
    runUntil(b, "recover", { guard: true, lean: 0, punches: [] });
    expect(b.playerHp).toBeGreaterThan(100 - ROSTER[0].damage);
    expect(b.stats.blocked).toBe(1);
  });

  it("their guard stops jabs but not an uppercut", () => {
    const b = new Bout({ ...ROSTER[1], guardiness: 1 }, { seed: 2 });
    b.start();
    expect(runUntil(b, "guard")).toBe(true);
    const hp = b.opp.hp;
    const ev = b.step(1 / 30, { guard: false, lean: 0, punches: [{ hand: "R", kind: "jab", power: 1 }] });
    expect(ev.some((e) => e.type === "blocked")).toBe(true);
    expect(b.opp.hp).toBe(hp);
    b.step(1 / 30, { guard: false, lean: 0, punches: [{ hand: "R", kind: "uppercut", power: 1 }] });
    expect(b.opp.hp).toBeLessThan(hp);
  });

  it("ends in a knockout when they run out", () => {
    const b = new Bout(ROSTER[0], { seed: 1 });
    b.start();
    let ko = false;
    for (let i = 0; i < 200 && !ko; i++) {
      const ev = b.step(1 / 30, { guard: true, lean: 0, punches: [{ hand: i % 2 ? "L" : "R", kind: "uppercut", power: 1 }] });
      ko = ev.some((e) => e.type === "ko");
    }
    expect(ko).toBe(true);
    expect(b.winner).toBe("player");
    expect(b.stage).toBe("over");
  });

  it("goes the distance and is decided on points", () => {
    const b = new Bout({ ...ROSTER[0], damage: 0 }, { seed: 4 });
    b.start();
    let decided = false;
    for (let t = 0; t < 60 * 3 + 6 * 2 + 5 && !decided; t += 1 / 30) {
      decided = b.step(1 / 30, { guard: true, lean: 0, punches: [] }).some((e) => e.type === "decision");
    }
    expect(decided).toBe(true);
    expect(b.round).toBe(3);
  });
});
