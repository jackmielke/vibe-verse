import { describe, expect, it } from "vitest";
import { fbm2, makeRng } from "@/shared/proc/rng";
import { DECKS, ISLAND_Y, KEEL_DEPTH, PLATEAU_R } from "@/empyrean/config";

describe("keel envelope", () => {
  it("measures", () => {
    const topY = DECKS[DECKS.length - 1].y - 6;
    const tipY = ISLAND_Y - KEEL_DEPTH;
    const topR = DECKS[DECKS.length - 1].outer * 0.99;
    const profile = (t: number) => Math.pow(1 - t, 1.22) * (1 - 0.12 * Math.sin(t * Math.PI * 2.1));
    const rows: string[] = [];
    for (let y = topY; y >= tipY; y -= 20) {
      const t = (topY - y) / (topY - tipY);
      const baseR = topR * profile(t);
      let max = 0;
      for (let j = 0; j <= 256; j++) {
        const a = (j / 256) * Math.PI * 2;
        const lobe = 1 + Math.sin(a * 4 + 0.7) * 0.10 + Math.sin(a * 3 - 2.1) * 0.06;
        const flute = 1 + Math.sin(a * 17 + t * 2.2) * 0.055 * (0.35 + t);
        const rough = 1 + fbm2(Math.cos(a) * 2.6 + t * 3.1, Math.sin(a) * 2.6, 4, 2, 0.5, 404) * 0.34 * (0.3 + t * 1.1);
        max = Math.max(max, baseR * lobe * flute * rough);
      }
      rows.push(`y=${y.toFixed(0)} t=${t.toFixed(2)} rockMax=${max.toFixed(0)}`);
    }
    console.log(rows.join("\n"));

    // spikes, exactly as keel.ts seeds them? unknown seed/count -> bound them
    const rng = makeRng("guess");
    void rng;
    // extent of the scattered spikes by construction
    let sMinY = Infinity, sMaxY = -Infinity, sMaxR = 0;
    for (let i = 0; i < 1000; i++) {
      const rr = PLATEAU_R * (0.24 + (i / 1000) * (0.9 - 0.24));
      const len = 200 * (1 - (rr / PLATEAU_R) * 0.28);
      const yTop = ISLAND_Y - 190 - Math.pow(rr / PLATEAU_R, 2.4) * 220 - 0;
      const yBot = ISLAND_Y - 190 - Math.pow(rr / PLATEAU_R, 2.4) * 220 - 90 - len;
      sMinY = Math.min(sMinY, yBot); sMaxY = Math.max(sMaxY, yTop);
      sMaxR = Math.max(sMaxR, rr + 30 + 0.22 * rr);
    }
    console.log("spikes y", sMinY.toFixed(0), sMaxY.toFixed(0), "maxR", sMaxR.toFixed(0));
    expect(1).toBe(1);
  });
});
