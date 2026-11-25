import { describe, it, expect } from "vitest";
import { placeSticker, sanitizeStickers } from "@/components/city/stickers";

describe("body stickers", () => {
  it("drops unknown art and slots from the wire", () => {
    expect(sanitizeStickers([{ art: "<script>", slot: "chest" }, { art: "⭐", slot: "toe" }, { art: "🔥", slot: "back" }])).toEqual([{ art: "🔥", slot: "back" }]);
  });
  it("placing on a filled spot replaces it", () => {
    expect(placeSticker([{ art: "⭐", slot: "chest" }], { art: "🔥", slot: "chest" })).toEqual([{ art: "🔥", slot: "chest" }]);
  });
});
