import { describe, expect, it } from "vitest";
import { BREAK_BARS, SET_BARS, SETLIST, SONG_BARS, chordFor, pentatonic, secondsToNextSong, showAt } from "@/city/concert/show";
import { parseSpotify } from "@/city/concert/spotify";

describe("the Vibe Bowl's setlist", () => {
  it("opens the set on the first song's intro", () => {
    const st = showAt(0);
    expect(st.songIndex).toBe(0);
    expect(st.section).toBe("intro");
    expect(st.inBreak).toBe(false);
    expect(st.barInSong).toBe(0);
  });

  it("plays every song through its form, then breaks, then moves on", () => {
    const kinds: string[] = [];
    for (let bar = 0; bar < SONG_BARS; bar++) {
      const k = showAt(bar * 4 + 1).section;
      if (kinds[kinds.length - 1] !== k) kinds.push(k);
    }
    expect(kinds).toEqual(["intro", "verse", "chorus", "verse", "chorus", "bridge", "solo", "chorus", "outro"]);
    expect(showAt(SONG_BARS * 4).inBreak).toBe(true);
    expect(showAt((SONG_BARS + BREAK_BARS) * 4).songIndex).toBe(1);
    expect(showAt((SONG_BARS + BREAK_BARS) * 4).section).toBe("intro");
  });

  it("counts its choruses, which is what the lasers alternate on", () => {
    const seen = new Set<number>();
    for (let bar = 0; bar < SONG_BARS; bar++) {
      const st = showAt(bar * 4);
      if (st.section === "chorus") seen.add(st.chorusIndex);
      else expect(st.chorusIndex).toBe(-1);
    }
    expect([...seen]).toEqual([0, 1, 2]);
  });

  it("loops the whole set, so the wall clock can be anything", () => {
    const a = showAt(123.5);
    const b = showAt(123.5 + SET_BARS * 4 * 1000);
    expect(b.songIndex).toBe(a.songIndex);
    expect(b.section).toBe(a.section);
    expect(b.barInSong).toBe(a.barInSong);
    expect(b.beatInBar).toBeCloseTo(a.beatInBar, 6);
    // And today's real clock lands somewhere sensible.
    const now = showAt((Date.now() / 1000) * 2);
    expect(now.songIndex).toBeGreaterThanOrEqual(0);
    expect(now.songIndex).toBeLessThan(SETLIST.length);
  });

  it("keeps the voice and the chords in key", () => {
    const am = SETLIST[0];
    expect(chordFor(am, 0)).toEqual({ root: 57, minor: true });
    expect(chordFor(am, 1).root).toBe(53);
    expect(pentatonic(am, 0)).toBe(57);
    expect(pentatonic(am, 5)).toBe(69);
    for (const song of SETLIST) {
      expect(song.chords.length).toBe(song.chordMinor.length);
      expect(song.verse.length).toBe(16);
      expect(song.chorus.length).toBe(16);
    }
  });

  it("knows how long until the next song", () => {
    expect(secondsToNextSong(0)).toBeCloseTo((SONG_BARS + BREAK_BARS) * 2, 6);
    expect(secondsToNextSong(SONG_BARS * 4)).toBeCloseTo(BREAK_BARS * 2, 6);
  });
});

describe("pasting a Spotify link", () => {
  it("reads share links, intl links and URIs", () => {
    expect(parseSpotify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123")?.embed)
      .toBe("https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M?utm_source=generator&theme=0");
    expect(parseSpotify("open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy")?.kind).toBe("album");
    expect(parseSpotify("spotify:track:11dFghVXANMlKmJXsNCbNl")?.id).toBe("11dFghVXANMlKmJXsNCbNl");
    expect(parseSpotify("https://open.spotify.com/embed/artist/0OdUWJ0sBjDrqHygGUXeCF")?.kind).toBe("artist");
  });

  it("refuses anything that is not Spotify, so nothing else gets framed", () => {
    expect(parseSpotify("")).toBeNull();
    expect(parseSpotify("https://evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M")).toBeNull();
    expect(parseSpotify("https://open.spotify.com.evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M")).toBeNull();
    expect(parseSpotify("https://open.spotify.com/user/someone")).toBeNull();
    expect(parseSpotify("javascript:alert(1)")).toBeNull();
    expect(parseSpotify("https://open.spotify.com/playlist/../../x")).toBeNull();
  });
});
