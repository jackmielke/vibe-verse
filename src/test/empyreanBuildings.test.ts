import { describe, expect, it } from "vitest";
import { cityPlan } from "@/empyrean/cityplan";

describe("scratch", () => {
  it("dumps", () => {
    const plan = cityPlan();
    const byUse: Record<string, number> = {};
    for (const l of plan.lots) byUse[l.use] = (byUse[l.use] ?? 0) + 1;
    console.log("lots", plan.lots.length, byUse);
    const polyLens = plan.lots.map((l) => l.poly.length);
    console.log("poly verts min/max", Math.min(...polyLens), Math.max(...polyLens));
    const hs = plan.lots.map((l) => l.height);
    console.log("height min/max", Math.min(...hs).toFixed(1), Math.max(...hs).toFixed(1));
    for (const u of ["tower","block","shop","civic","garden","pavilion","hangar"]) {
      const s = plan.lots.filter(l=>l.use===u);
      if (!s.length) { console.log(u, "none"); continue; }
      const h = s.map(l=>l.height);
      console.log(u, s.length, "h", Math.min(...h).toFixed(1), Math.max(...h).toFixed(1));
    }
    const l0 = plan.lots[0];
    console.log(JSON.stringify(l0, null, 1).slice(0, 1200));
    // area stats
    const area = (p: {x:number;z:number}[]) => { let a=0; for(let i=0;i<p.length;i++){const q=p[(i+1)%p.length]; a+=p[i].x*q.z-q.x*p[i].z;} return a/2; };
    const areas = plan.lots.map(l=>area(l.poly));
    console.log("area min/max/mean", Math.min(...areas).toFixed(1), Math.max(...areas).toFixed(1), (areas.reduce((a,b)=>a+b,0)/areas.length).toFixed(1));
    console.log("negative areas", areas.filter(a=>a<0).length);
    const fl = plan.lots.map(l=>l.frontLen);
    console.log("frontLen min/max", Math.min(...fl).toFixed(1), Math.max(...fl).toFixed(1));
    expect(1).toBe(1);
  });
});
