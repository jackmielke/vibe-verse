/**
 * Driving into the sea.
 *
 * The failure this replaced could not be caught by a build, a typecheck or a
 * screenshot: `CollisionWorld` floors everything at y=0 so nothing can fall
 * out of the world, and over open water that floor is a phantom plate with no
 * mesh under it — so every ground query a car made answered "sea level, go
 * ahead", and a kart driven off the quay carried on driving across the bay on
 * top of the waves. A still of that is a still of a car near some water.
 *
 * What is checkable here is the arithmetic the sequence rests on, and the
 * source-level wiring that would silently un-ship it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { waterDepthAt, bedHeight } from "@/city/ocean";

const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");
const sinkSrc = readFileSync(resolve(__dirname, "../city/carSink.ts"), "utf8");
const trafficSrc = readFileSync(resolve(__dirname, "../city/traffic.ts"), "utf8");

/** The constants the sequence is tuned around, read from the source. */
const num = (re: RegExp) => {
  const m = citySrc.match(re);
  expect(m, `no match for ${re}`).not.toBeNull();
  return Number(m![1]);
};
const SINK_DEPTH = num(/const SINK_DEPTH = ([\d.]+);/);
const SINK_EJECT = num(/const SINK_EJECT = ([\d.]+);/);
const SINK_RECOVER = num(/const SINK_RECOVER = ([\d.]+);/);

describe("where a car drowns", () => {
  it("leaves the shallows driveable", () => {
    // The shore shelves out gently on purpose — that is what gives the surf
    // zone room to shoal and break — and a car that dies the instant a wave
    // washes over the sand would make the whole beach a kill zone.
    expect(SINK_DEPTH).toBeGreaterThan(1);
  });

  it("is shallow enough that the water reaches it before the seabed drops away", () => {
    // The threshold has to be reachable on the gentle beach face, not only off
    // a cliff — otherwise driving into the sea from the city does nothing.
    expect(SINK_DEPTH).toBeLessThan(2.5);
  });

  it("finds water that deep within a short drive of the city edge", () => {
    // Straight out from the middle of one side. If this ever needs a
    // kilometre of open water to trigger, nobody will ever see it.
    let found = -1;
    for (let x = 180; x < 400; x += 1) {
      if (waterDepthAt(x, 0) > SINK_DEPTH) {
        found = x;
        break;
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(found - 180).toBeLessThan(90);
  });

  it("has a seabed under it that keeps going down", () => {
    // The car settles on `-waterDepthAt`, so that had better be a real floor
    // that gets deeper offshore rather than a step.
    expect(bedHeight(260, 0)).toBeLessThan(bedHeight(220, 0));
    expect(bedHeight(400, 0)).toBeLessThan(bedHeight(260, 0));
  });
});

describe("the order things happen in", () => {
  it("gets the driver out well before the car reaches the bottom", () => {
    // Riding it all the way down is a nice shot and a bad experience: the
    // player has no controls for the duration.
    expect(SINK_EJECT).toBeLessThan(2);
    expect(SINK_EJECT).toBeGreaterThan(0.4);
  });

  it("gives the kart back, and not so fast that it pops", () => {
    // A world that permanently loses one of its two karts to the bay every
    // time somebody tries this runs out of karts, and swimming down to push it
    // home is not a thing a player can do.
    expect(SINK_RECOVER).toBeGreaterThan(SINK_EJECT * 4);
    expect(SINK_RECOVER).toBeLessThan(30);
  });

  it("waits for nobody to be watching before teleporting it home", () => {
    // A kart that blinks out three metres in front of a player treading water
    // over it is worse than the problem the recovery solves.
    expect(citySrc).toMatch(/watcher > 30 \|\| k\.sink >= SINK_RECOVER \* 3/);
  });

  it("does not release a drowning city car back to the traffic fleet", () => {
    // `release` snaps a claimed car to the nearest lane. Calling the normal
    // exit path on the way down would teleport the car you just sank back onto
    // the road, dry, while you are still watching the bubbles.
    const bail = citySrc.slice(
      citySrc.indexOf("if (prev < SINK_EJECT"),
      citySrc.indexOf("// Give it back."),
    );
    expect(bail.length).toBeGreaterThan(100);
    // The CALL, not the name — the comment in that block explains at length
    // why `exitKartRef` is not used, so a bare substring match finds itself.
    expect(bail).not.toMatch(/exitKartRef\s*\.\s*current/);
    expect(bail).not.toMatch(/traffic\s*\.\s*release\s*\(/);
  });
});

describe("the wiring that would silently un-ship it", () => {
  it("runs the water check for every vehicle, not just the driven one", () => {
    // Hop out mid-plunge and the car has to keep going down without you, or
    // abandoning it at the waterline leaves a kart bobbing on the surface —
    // the exact thing this replaced.
    expect(citySrc).toMatch(/for \(let i = 0; i < kartStates\.length; i\+\+\) sinkTick\(/);
  });

  it("skips the normal ground follow while sinking", () => {
    // The ground follow snaps a kart to `supportHeightAt`, which over water is
    // the phantom plate at y=0. Left running, it lifts the car straight back
    // to the surface every frame and nothing sinks at all.
    expect(citySrc).toContain("const drowning = kart.sink > 0;");
    expect(citySrc).toMatch(/if \(!drowning\) \{/);
  });

  it("lets the camera follow the car under the water", () => {
    // Clamped to the plate, the camera stops dead at the surface and you watch
    // your own car leave without you — which is the whole shot.
    expect(citySrc).toContain("eyeMayGoUnder");
  });

  it("can pitch a commandeered city car", () => {
    // Traffic is axis-aligned and flat by construction, so `pose` took a yaw
    // and nothing else. A sinking car noses over; without this it goes down
    // perfectly level, like a lift.
    expect(trafficSrc).toMatch(/pitch = 0, roll = 0/);
    expect(trafficSrc).toContain('PE.set(pitch, yaw, roll, "YXZ")');
  });

  it("faces the spray at the camera after the camera has moved", () => {
    // The quads have no billboard material; they are faced by copying the
    // camera's world quaternion. Done before the camera block, every particle
    // is aimed one frame behind — which shows up as the plume shearing
    // whenever the view swings, i.e. during a crash.
    const camAt = citySrc.indexOf("const eyeMayGoUnder");
    const sprayAt = citySrc.indexOf("carSink.update(dt, camera)");
    expect(camAt).toBeGreaterThan(0);
    expect(sprayAt).toBeGreaterThan(camAt);
  });
});

describe("the effect", () => {
  it("scales the impact off the speed the car arrived at", () => {
    // Rolling off the slipway and launching off the sea wall producing the
    // same splash is the difference between an effect and a trigger.
    expect(sinkSrc).toMatch(/const s = THREE\.MathUtils\.clamp\(\(speed - 4\) \/ 26, 0, 1\);/);
    expect(sinkSrc).toMatch(/const power = 0\.25 \+ s \* s \* [\d.]+;/);
  });

  it("kills bubbles at the surface on the same frame", () => {
    // A bubble that swims out into the air and keeps going is the tell that
    // nothing here knows where the water is.
    expect(sinkSrc).toMatch(/if \(p\.y > 0\) \{[\s\S]{0,120}?setMatrixAt\(i, HIDDEN\);[\s\S]{0,40}?continue;/);
  });

  it("keeps the foam rings small enough to still read as rings", () => {
    // The annulus scales uniformly, so its band grows with its radius: at
    // fourteen metres the 0.28-unit band is four metres wide and additively
    // blended over dark water it is a grey plate, not foam.
    const m = sinkSrc.match(/ring\.to = \(([\d.]+) \+ power \* ([\d.]+)\) \* \(1 \+ i \* ([\d.]+)\)/);
    expect(m).not.toBeNull();
    // Worst case: power is 0.25 + 1.6 = 1.85, and `i` reaches 1 on the outer
    // of the two rings.
    const maxRadius = (Number(m![1]) + Number(m![2]) * 1.85) * (1 + Number(m![3]));
    expect(maxRadius).toBeLessThan(12);
  });

  it("does not stack the swimmer's splash on top of the car's", () => {
    // `buildSplash` draws its own four expanding rings and square `Points`
    // droplets. Fired at the same instant as these two soft ones, the six
    // together read as a bullseye painted on the sea — which is invisible in
    // the frame 0.4 s later that this was originally judged on, and the only
    // thing you can see in the frame 0.16 s after the hit.
    const entry = citySrc.slice(
      citySrc.indexOf("const hit = Math.hypot(k.speed, k.vy);"),
      citySrc.indexOf("k.pitch = -(0.55"),
    );
    expect(entry.length).toBeGreaterThan(100);
    expect(entry).not.toMatch(/splash\s*\.\s*burst\s*\(/);
  });

  it("is pooled, so repeated crashes do not grow the scene", () => {
    // Entering water is a thing that happens over and over, and a particle
    // system per entry is how a world starts hitching after ten minutes.
    expect(sinkSrc).toContain("InstancedMesh");
    expect(sinkSrc).toMatch(/sprayNext\+\+ % SPRAY/);
    expect(sinkSrc).toMatch(/bubbleNext\+\+ % BUBBLES/);
  });
});
