/**
 * What counts as a phone. Pure, so every HUD that branches on it is testing
 * the same rule.
 */
import { describe, it, expect } from "vitest";
import { shapeFor } from "@/lib/screen";

describe("the shape of a screen", () => {
  it("calls a phone a phone either way up", () => {
    expect(shapeFor(393, 852, true)).toMatchObject({ phone: true, short: false, portrait: true });
    expect(shapeFor(852, 393, true)).toMatchObject({ phone: true, short: true, portrait: false });
    expect(shapeFor(430, 932, true)).toMatchObject({ phone: true, portrait: true });
  });

  it("does not call a tablet or a laptop a phone", () => {
    expect(shapeFor(744, 1133, true)).toMatchObject({ phone: false, short: false });
    expect(shapeFor(1024, 768, true)).toMatchObject({ phone: false, short: false });
    expect(shapeFor(1440, 900, false)).toMatchObject({ phone: false, short: false, touch: false });
  });

  it("keeps touch and size separate — a mouse on a small window is not a thumb", () => {
    const s = shapeFor(800, 480, false);
    expect(s.touch).toBe(false);
    expect(s.short).toBe(true);
  });
});
