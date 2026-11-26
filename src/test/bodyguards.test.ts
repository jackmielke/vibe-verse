import { describe, expect, it } from "vitest";
import { formationSlot, leashFor, pickThreat } from "@/city/bodyguards";
import { parseSquadCommand, whoIn } from "@/city/squadCommands";

describe("bodyguard formation", () => {
  it("stands everyone behind the player, whichever way they face", () => {
    for (const yaw of [0, 1, Math.PI, -2]) {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      for (let i = 0; i < 3; i++) {
        const s = formationSlot(i, 3, yaw);
        expect(s.x * fx + s.z * fz).toBeLessThan(-1.5); // behind
        expect(Math.hypot(s.x, s.z)).toBeLessThan(5);
      }
    }
  });
  it("never stacks two guards on one spot", () => {
    const a = formationSlot(0, 3, 0.4), b = formationSlot(1, 3, 0.4), c = formationSlot(2, 3, 0.4);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5);
    expect(Math.hypot(b.x - c.x, b.z - c.z)).toBeGreaterThan(1.5);
  });
});

describe("picking a fight", () => {
  const cops = [{ x: 50, z: 0 }, { x: 10, z: 0 }, { x: -12, z: 3 }];
  it("goes for the nearest cruiser inside the leash", () => {
    expect(pickThreat(-5, 0, 0, 0, 26, cops)).toBe(2);
  });
  it("ignores anything outside the leash of the point it defends", () => {
    expect(pickThreat(0, 0, 0, 0, 8, cops)).toBe(-1);
    expect(pickThreat(45, 0, 0, 0, 26, cops)).toBe(1);
  });
  it("peace and cheer never fight; attack ranges furthest", () => {
    expect(leashFor("peace")).toBe(0);
    expect(leashFor("cheer")).toBe(0);
    expect(leashFor("attack")).toBeGreaterThan(leashFor("follow"));
    expect(leashFor("follow")).toBeGreaterThan(leashFor("stay"));
  });
});

describe("typed squad orders", () => {
  const first = (t: string) => parseSquadCommand(t)[0];
  it("hires", () => {
    expect(first("protect me")).toEqual({ name: "hire_bodyguards", args: { who: "all" } });
    expect(first("call Hana")).toEqual({ name: "hire_bodyguards", args: { who: "hana" } });
  });
  it("orders", () => {
    expect(first("get the cops!")?.args.order).toBe("attack");
    expect(first("Goro, take them out")).toEqual({ name: "command_bodyguards", args: { who: "goro", order: "attack" } });
    expect(first("stay here")?.args.order).toBe("stay");
    expect(first("follow me")?.args.order).toBe("follow");
    expect(first("stand down")?.args.order).toBe("peace");
    expect(first("hold your fire")?.args.order).toBe("peace");
    expect(first("let's celebrate")?.args.order).toBe("cheer");
  });
  it("dismisses and reports", () => {
    expect(first("go home Kenji")).toEqual({ name: "dismiss_bodyguards", args: { who: "kenji" } });
    expect(first("status report")?.name).toBe("squad_status");
  });
  it("names one guard or all of them", () => {
    expect(whoIn("kenji and hana")).toBe("all");
    expect(whoIn("the big guy")).toBe("goro");
    expect(parseSquadCommand("what a lovely tree")).toEqual([]);
  });
});
