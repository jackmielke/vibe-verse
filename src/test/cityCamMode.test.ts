import { describe, expect, it } from "vitest";
import { chaseYawStep, loadCamMode, nextCamMode, wrapAngle } from "@/city/camMode";

describe("city camera modes", () => {
  it("cycles default, chase, first person", () => {
    expect(nextCamMode("default")).toBe("chase");
    expect(nextCamMode("chase")).toBe("first");
    expect(nextCamMode("first")).toBe("default");
  });

  it("reads ?cam= before anything saved", () => {
    expect(loadCamMode("?cam=first")).toBe("first");
    expect(loadCamMode("?cam=nonsense")).toBe("default");
  });

  it("swings the chase cam in behind a runner", () => {
    // Facing +x (yaw PI/2), behind is camYaw = -PI/2. Start the camera off to the side.
    let cam = 0;
    for (let i = 0; i < 300; i++) cam += chaseYawStep(cam, Math.PI / 2, 6, 1 / 60);
    expect(Math.abs(wrapAngle(cam - (Math.PI / 2 + Math.PI)))).toBeLessThan(0.05);
  });

  it("leaves the camera alone standing still or running straight at it", () => {
    expect(chaseYawStep(0, 1, 0.2, 1 / 60)).toBe(0);
    // Camera at yaw 0 sits on +z; a body facing +z (yaw 0) runs at it.
    expect(chaseYawStep(0, 0, 8, 1 / 60)).toBe(0);
  });
});
