import { describe, it, expect, vi } from "vitest";
import { buildRemotePilot, remoteName } from "../components/city/remoteIdentity";

describe("City remote identity", () => {
  it("builds Toadstool rather than the default robot", () => {
    const factory = vi.fn((_: undefined, id: string) => ({ design: id }));
    expect(buildRemotePilot("toadstool", factory).design).toBe("toadstool");
    expect(factory).toHaveBeenCalledWith(undefined, "toadstool");
  });
  it("builds Jelly rather than the default robot", () => {
    const factory = vi.fn((_: undefined, id: string) => ({ design: id }));
    expect(buildRemotePilot("jelly", factory).design).toBe("jelly");
    expect(factory).toHaveBeenCalledWith(undefined, "jelly");
  });
  it("replaces the previous friend's name with their latest name", () => {
    expect(remoteName("Jack Mielke", "pilot")).toBe("Jack Mielke");
  });
  it("preserves a known name when an old packet omits it", () => {
    expect(remoteName(undefined, "Jack Mielke")).toBe("Jack Mielke");
  });
});