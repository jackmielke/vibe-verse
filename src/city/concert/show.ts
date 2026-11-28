/**
 * show — the Vibe Bowl's setlist, as a pure function of the city clock.
 *
 * Nobody hosts the concert. Every client works out where the band is from
 * `cityBeats()` (the wall clock at the city's 120 BPM, the same clock the
 * dance floor, the club and every dancer use), so two people standing in the
 * pit on two phones hear the same chorus land on the same downbeat and see the
 * same lasers fire, and a dancer in the crowd is on the beat by construction.
 *
 * One tempo for the whole set is a feature, not a shortcut: songs differ by
 * feel instead (straight rock eighths, four on the floor, a half-time ballad,
 * a double-time closer), which is how a band plays one click track anyway.
 */

export type Feel = "rock" | "disco" | "halftime" | "punk";

export type SectionKind = "intro" | "verse" | "chorus" | "bridge" | "solo" | "outro";

export interface Section {
  kind: SectionKind;
  bars: number;
}

export interface Song {
  title: string;
  /** MIDI note of the key's root, in the bass octave's register + 24. */
  root: number;
  /** Minor key (natural minor scale) or major. */
  minor: boolean;
  /** One chord per bar, looped: semitone offsets of each chord's root. */
  chords: number[];
  /** Whether each chord in `chords` is minor. */
  chordMinor: boolean[];
  feel: Feel;
  /** Scale degrees (0..7 within the pentatonic) for the verse and chorus hooks, one per eighth, -1 = rest. */
  verse: number[];
  chorus: number[];
  /** LED wall palette: two colours the show leans on. */
  colors: [string, string];
}

/** The band. Original, like everything they play. */
export const BAND_NAME = "The Static Bloom";
export const VENUE_NAME = "The Vibe Bowl";

const FORM: Section[] = [
  { kind: "intro", bars: 4 },
  { kind: "verse", bars: 8 },
  { kind: "chorus", bars: 8 },
  { kind: "verse", bars: 8 },
  { kind: "chorus", bars: 8 },
  { kind: "bridge", bars: 4 },
  { kind: "solo", bars: 8 },
  { kind: "chorus", bars: 8 },
  { kind: "outro", bars: 4 },
];

export const SETLIST: Song[] = [
  {
    title: "Neon Tide",
    root: 57, // A minor
    minor: true,
    chords: [0, -4, 3, -2], // Am F C G
    chordMinor: [true, false, false, false],
    feel: "rock",
    verse: [0, -1, 2, 3, -1, 2, 1, -1, 0, -1, 2, 4, -1, 3, 2, -1],
    chorus: [4, -1, 4, 5, 4, -1, 3, 2, 4, -1, 4, 6, 5, -1, 4, -1],
    colors: ["#ff3fd1", "#38e8ff"],
  },
  {
    title: "Paper Planets",
    root: 62, // D major
    minor: false,
    chords: [0, 7, 9, 5], // D A Bm G
    chordMinor: [false, false, true, false],
    feel: "disco",
    verse: [2, -1, 2, 1, 0, -1, 1, -1, 2, -1, 3, 2, 1, -1, 0, -1],
    chorus: [5, 4, -1, 5, 6, -1, 5, 4, 3, -1, 4, 5, 4, -1, 2, -1],
    colors: ["#ffd23f", "#7a3cff"],
  },
  {
    title: "Slow Static",
    root: 64, // E minor
    minor: true,
    chords: [0, -4, 3, -2], // Em C G D
    chordMinor: [true, false, false, false],
    feel: "halftime",
    verse: [0, -1, -1, 1, 2, -1, -1, -1, 3, -1, 2, -1, 1, -1, -1, -1],
    chorus: [4, -1, -1, 5, 4, -1, 3, -1, 2, -1, -1, 3, 4, -1, -1, -1],
    colors: ["#5b8cff", "#c9b6ff"],
  },
  {
    title: "Run the Lights",
    root: 55, // G major
    minor: false,
    chords: [0, 7, 9, 5], // G D Em C
    chordMinor: [false, false, true, false],
    feel: "punk",
    verse: [0, 0, 2, -1, 0, 0, 3, -1, 2, 2, 1, -1, 0, -1, 1, -1],
    chorus: [4, 4, 5, -1, 4, 4, 6, -1, 5, 5, 4, -1, 3, -1, 4, -1],
    colors: ["#ff6a3d", "#3dffb0"],
  },
];

/** Bars of applause between songs. */
export const BREAK_BARS = 4;
export const SONG_BARS = FORM.reduce((n, s) => n + s.bars, 0);
export const SET_BARS = SETLIST.length * (SONG_BARS + BREAK_BARS);

/** How hard each section hits, 0..1: what the lights and the crowd follow. */
export const ENERGY: Record<SectionKind, number> = {
  intro: 0.45,
  verse: 0.55,
  chorus: 1,
  bridge: 0.35,
  solo: 0.85,
  outro: 0.6,
};

export interface ShowState {
  song: Song;
  songIndex: number;
  /** Applause between songs: the band is not playing. */
  inBreak: boolean;
  section: SectionKind;
  /** Which chorus this is (0, 1, 2), or -1 outside one. Lasers count on it. */
  chorusIndex: number;
  barInSong: number;
  barInSection: number;
  sectionBars: number;
  /** 0..4 within the current bar. */
  beatInBar: number;
  /** Bars since the set began, whole. */
  bar: number;
  energy: number;
}

/** Where the show is at `beats` on the city clock. */
export function showAt(beats: number): ShowState {
  const totalBars = beats / 4;
  const bar = Math.floor(totalBars);
  const beatInBar = (totalBars - bar) * 4;
  const inSet = ((bar % SET_BARS) + SET_BARS) % SET_BARS;
  const slot = SONG_BARS + BREAK_BARS;
  const songIndex = Math.floor(inSet / slot);
  const song = SETLIST[songIndex];
  const barInSong = inSet - songIndex * slot;
  if (barInSong >= SONG_BARS) {
    return {
      song, songIndex, inBreak: true, section: "outro", chorusIndex: -1,
      barInSong, barInSection: barInSong - SONG_BARS, sectionBars: BREAK_BARS,
      beatInBar, bar, energy: 0.15,
    };
  }
  let at = 0;
  let chorus = 0;
  for (const s of FORM) {
    if (barInSong < at + s.bars) {
      return {
        song, songIndex, inBreak: false, section: s.kind,
        chorusIndex: s.kind === "chorus" ? chorus : -1,
        barInSong, barInSection: barInSong - at, sectionBars: s.bars,
        beatInBar, bar, energy: ENERGY[s.kind],
      };
    }
    if (s.kind === "chorus") chorus++;
    at += s.bars;
  }
  // Unreachable: barInSong < SONG_BARS.
  throw new Error("showAt: fell off the form");
}

/** The chord (root offset, minor) for a bar of a song. */
export function chordFor(song: Song, barInSong: number): { root: number; minor: boolean } {
  const i = ((barInSong % song.chords.length) + song.chords.length) % song.chords.length;
  return { root: song.root + song.chords[i], minor: song.chordMinor[i] };
}

/** A pentatonic degree (may run past 4 into the next octave) as MIDI, in the song's key. */
export function pentatonic(song: Song, degree: number): number {
  const steps = song.minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
  const oct = Math.floor(degree / 5);
  const d = ((degree % 5) + 5) % 5;
  return song.root + steps[d] + oct * 12;
}

/** Seconds until the next song starts, for the "next up" line on the board. */
export function secondsToNextSong(beats: number, bpm = 120): number {
  const bar = beats / 4;
  const slot = SONG_BARS + BREAK_BARS;
  const into = ((bar % slot) + slot) % slot;
  return ((slot - into) * 4 * 60) / bpm;
}
