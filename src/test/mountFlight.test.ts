import { describe, it, expect } from "vitest";
import { stepMount, type FlightState } from "../components/city/mountFlight";
import { canSkyTag, initialTagger, acceptSkyTag } from "../components/city/aerialTag";
const flight = (): FlightState => ({ x: 0, y: 40, z: 0, yaw: Math.PI, speed: 22, lift: 0, bank: 0 });
describe("flying mounts", () => {
  it("flies forward and gains height when flapping", () => {
    const s = flight(); for (let i=0;i<60;i++) stepMount(s, { throttle: 1, steer: 0, flap: true, dive: false }, 1/60, 0);
    expect(s.z).toBeLessThan(-22); expect(s.y).toBeGreaterThan(45);
  });
  it("steers screen right from a rear chase camera", () => {
    const s=flight(); for(let i=0;i<60;i++) stepMount(s,{throttle:0,steer:1,flap:false,dive:false},1/60,0);
    expect(s.x).toBeGreaterThan(8);
  });
  it("does not fly through the floor", () => {
    const s=flight(); s.y=3; for(let i=0;i<180;i++) stepMount(s,{throttle:0,steer:0,flap:false,dive:true},1/60,0);
    expect(s.y).toBe(2.5);
  });
});
describe("multiplayer aerial tag", () => {
  const a={id:"a",name:"Jack",x:0,y:40,z:0,playing:true};
  const b={id:"b",name:"Friend",x:2,y:40,z:0,playing:true};
  it("chooses the same first tagger on both clients",()=>expect(initialTagger([b,a])).toBe("a"));
  it("tags another mounted player nearby",()=>expect(canSkyTag(a,b,5000,0)).toBe(true));
  it("cannot tag through altitude differences",()=>expect(canSkyTag(a,{...b,y:60},5000,0)).toBe(false));
  it("requires both players to opt in",()=>expect(canSkyTag(a,{...b,playing:false},5000,0)).toBe(false));
  it("prevents instant tag backs",()=>expect(canSkyTag(a,b,5000,4000)).toBe(false));
  it("ignores old tag events",()=>expect(acceptSkyTag({from:"a",to:"b",at:5000},{from:"b",to:"a",at:4000})?.to).toBe("b"));
});