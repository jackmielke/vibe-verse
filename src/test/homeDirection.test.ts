/**
 * The front door opens on Postcard.
 *
 * The order of `DIRECTIONS` is the order of the Look switcher, and
 * `DEFAULT_DIRECTION` is what `/` shows when this device has never picked
 * one, which is also the only look a phone gets. A wide screen still prefers
 * a saved pick, and `?look=` still previews one without writing it.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_DIRECTION, DIRECTIONS } from "@/redesign/directions";

describe("front door look", () => {
  it("leads with Postcard, which is also the first visit", () => {
    expect(DIRECTIONS.map((d) => d.id)).toEqual(["postcard", "arcade", "sky"]);
    expect(DEFAULT_DIRECTION).toBe("postcard");
    expect(DIRECTIONS[0].id).toBe(DEFAULT_DIRECTION);
  });
});
