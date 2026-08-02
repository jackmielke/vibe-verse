/**
 * The six things that happen. This file is the film.
 *
 * Everything here is data: a chapter is a palette, a road, a list of what is
 * beside it, a list of what is in the way, and the lines Vibey says as you
 * pass certain points. Five of them hand that data to `RunChapter` and one of
 * them is ping-pong. Adding a seventh beat means adding an object to the array
 * at the bottom and nothing else.
 *
 * The ordering is the life, not a difficulty curve — but it happens to be one
 * anyway, because the life gets faster.
 */
import * as THREE from "three";
import {
  bike,
  barn,
  buoy,
  bush,
  cactus,
  car,
  chocolateBox,
  crabPot,
  crater,
  fallenSoldier,
  fenceRun,
  firewall,
  goalpost,
  grandstand,
  hayBale,
  logProp,
  mailbox,
  mesa,
  oakTree,
  oilRig,
  palm,
  pineTree,
  powerPole,
  puddle,
  reefRock,
  roadSign,
  shrimpBoat,
  shrimpProp,
  tractor,
  trawler,
  waterTower,
} from "./props";
import {
  desertGround,
  dirtRoad,
  footballField,
  grassGround,
  gulfWater,
  highway,
  jungleGround,
  jungleTrack,
  turfGround,
} from "./textures";
import { LOOKS, makeHuman, type HumanSpec } from "./rig";
import { RunChapter, type RunSpec } from "./runner";
import { PingPongChapter } from "./pingpong";
import type { Chapter, ChapterCtx, ChapterId } from "./types";

/* -------------------------------------------------------------- helpers */

const YARDS = (m: number): [string, string] => [String(Math.floor(m * 1.09361)), "YARDS"];
const METRES = (m: number): [string, string] => [String(Math.floor(m)), "METRES"];
const MILES = (m: number): [string, string] => [(m / 1609.34).toFixed(2), "MILES"];
const NAUTICAL = (m: number): [string, string] => [(m / 1852).toFixed(1), "NM"];

/**
 * A person used as an obstacle: a defender braced for the tackle, a reporter
 * stepping into the road with a camera. Posed once and left — they slide
 * toward you at running speed, which reads as backpedalling, and a rig that
 * animated as well would cost a per-frame update for a prop you clear in a
 * quarter of a second.
 */
function standing(spec: HumanSpec, poseEffort = 0.5, phase = 1.1) {
  return () => {
    const h = makeHuman(spec);
    h.pose(phase, poseEffort);
    h.group.rotation.y = Math.PI;
    return h.group;
  };
}

const defender = standing({
  shirt: 0x1c2b4a,
  pants: 0xd8d3c6,
  hat: "football",
  hatColor: 0x1c2b4a,
  shoes: 0x1c1a18,
});

const reporter = standing(
  { shirt: 0xd8cfa8, pants: 0x3b4a63, hair: 0x3a2c1e, hairStyle: "short" },
  0.2,
  0.4,
);

/* ============================================================== GREENBOW */

const greenbow: RunSpec = {
  goal: 950,
  halfWidth: 5.4,
  start: 5.5,
  max: 15.5,
  accel: 1.1,
  boost: 1.16,
  terrain: { texture: grassGround, tile: 9 },
  road: { texture: dirtRoad, tile: 16, width: 14 },
  sky: [0x7fc0e8, 0xd8e4d0, 0xc6d6c0, 0.0055],
  hero: LOOKS.boy,
  surface: "dirt",
  scenery: [
    { make: oakTree, every: 17, offset: [9, 26], scale: [0.85, 1.35] },
    { make: fenceRun, every: 11, offset: [7.2, 8.2] },
    { make: mailbox, every: 70, offset: [6.8, 7.6] },
    { make: powerPole, every: 48, offset: [9.5, 10.5], side: "right" },
    { make: barn, every: 210, offset: [24, 36] },
    { make: waterTower, every: 520, offset: [28, 40] },
  ],
  obstacles: [
    { key: "puddle", make: puddle, radius: 1.4, height: 0.2, weight: 3 },
    { key: "hay", make: hayBale, radius: 1.15, height: 1.35, weight: 3 },
    { key: "log", make: logProp, radius: 2.3, height: 0.95, weight: 2 },
    { key: "tractor", make: () => tractor(), radius: 1.7, height: 9, weight: 1 },
  ],
  obstacleEvery: [50, 27],
  pickup: { make: chocolateBox, every: 33, label: "CHOCOLATES" },
  chase: {
    make: (r) => {
      const g = new THREE.Group();
      const b = bike(r);
      g.add(b);
      g.userData.wheels = b.userData.wheels;
      return g;
    },
    count: 3,
    gap: 26,
    close: 9,
    label: "BULLIES",
    human: {
      height: 1.42,
      shirt: 0x8a3a3a,
      pants: 0x4a4a52,
      hair: 0x3a2c1e,
      hairStyle: "short",
    },
  },
  lives: 3,
  beats: [
    { at: 0.035, say: "Run, Vibey — RUN!" },
    {
      at: 0.16,
      say: "The braces come off. Nobody in Greenbow ever ran like that.",
      effect: "braces",
    },
    { at: 0.45, say: "You can't catch him. Nobody can." },
    { at: 0.78, say: "Just keep on going." },
  ],
  music: [196, 0.36],
  stat: YARDS,
};

/* ============================================================== FOOTBALL */

const football: RunSpec = {
  goal: 780,
  halfWidth: 6.4,
  start: 9,
  max: 18.5,
  accel: 1.5,
  boost: 1.15,
  terrain: { texture: turfGround, tile: 11 },
  // The texture draws a yard line every 5 yards across 20 yards of canvas.
  road: { texture: footballField, tile: 18.29, width: 48.8 },
  sky: [0x5aa8e0, 0xbdd8e8, 0xa8c4d4, 0.006],
  hero: LOOKS.football,
  surface: "grass",
  scenery: [
    { make: (r) => grandstand(r, 12, 34), every: 37, offset: [29, 29], side: "both", faceRoad: true, exact: true },
    { make: () => goalpost(), every: 420, offset: [0, 0], side: "left" },
    { make: (r) => pineTree(r), every: 130, offset: [58, 78] },
  ],
  obstacles: [
    { key: "def", make: defender, radius: 1.05, height: 2.1, weight: 6, homing: 0.55 },
    { key: "def2", make: defender, radius: 1.05, height: 2.1, weight: 3, homing: 1.1 },
    { key: "hay", make: hayBale, radius: 1.15, height: 1.35, weight: 1 },
  ],
  obstacleEvery: [34, 17],
  pickup: { make: chocolateBox, every: 30, label: "CHOCOLATES" },
  chase: {
    make: (r) => {
      void r;
      return new THREE.Group();
    },
    count: 3,
    gap: 30,
    close: 7,
    label: "DEFENSE",
    human: { shirt: 0x1c2b4a, pants: 0xd8d3c6, hat: "football", hatColor: 0x1c2b4a, shoes: 0x1c1a18 },
  },
  lives: 3,
  beats: [
    { at: 0.035, say: "He's got the ball. GO." },
    { at: 0.35, say: "He is not slowing down." },
    { at: 0.65, say: "That's a touchdown — and he keeps running." },
    { at: 0.94, say: "Somebody stop him. He'll run clean out of the stadium.", effect: "endzone" },
  ],
  music: [220, 0.3],
  stat: YARDS,
};

/* ============================================================== VIETNAM */

const vietnam: RunSpec = {
  goal: 900,
  halfWidth: 6,
  start: 8,
  max: 16,
  accel: 1.2,
  boost: 1.2,
  terrain: { texture: jungleGround, tile: 8 },
  road: { texture: jungleTrack, tile: 14, width: 15 },
  sky: [0x3a4a38, 0x66735a, 0x616d55, 0.024],
  hero: LOOKS.army,
  surface: "mud",
  scenery: [
    { make: bush, every: 4, offset: [8.6, 12], side: "both", scale: [1, 1.5] },
    { make: palm, every: 7, offset: [10, 30], scale: [0.9, 1.4] },
    { make: pineTree, every: 9, offset: [13, 44], scale: [0.9, 1.4] },
    { make: bush, every: 5, offset: [14, 34] },
    { make: (r) => crater(r), every: 90, offset: [10, 20] },
  ],
  obstacles: [
    { key: "crater", make: crater, radius: 1.7, height: 0.45, weight: 4 },
    { key: "log", make: logProp, radius: 2.3, height: 0.95, weight: 3 },
    { key: "bush", make: bush, radius: 1.3, height: 1.5, weight: 2 },
  ],
  obstacleEvery: [44, 24],
  pickup: {
    make: fallenSoldier,
    every: 185,
    label: "BROUGHT OUT",
    carried: true,
    single: true,
  },
  chase: {
    make: () => firewall(),
    count: 1,
    gap: 44,
    close: 11,
    label: "FIRE",
  },
  lives: 3,
  beats: [
    {
      at: 0.035,
      say: "It started raining, and it did not quit for four months. Get to the treeline.",
      effect: "storm",
      sky: [0x2b3628, 0x54604a, 0x505c48, 0.032],
    },
    { at: 0.3, say: "Somebody's down out there. Go back for him." },
    { at: 0.62, say: "That's Bubba. Pick him up and run." },
    { at: 0.88, say: "Treeline's close. Don't stop now." },
  ],
  music: [147, 0.44],
  stat: METRES,
};

/* ================================================================ SHRIMP */

const shrimp: RunSpec = {
  goal: 1500,
  halfWidth: 9,
  start: 10,
  max: 19,
  accel: 0.9,
  boost: 1.14,
  terrain: { texture: gulfWater, tile: 26, width: 460 },
  sky: [0x63b4e0, 0xd6e6ea, 0xbcd4dc, 0.006],
  hero: { ...LOOKS.captain },
  surface: "wood",
  vehicle: () => {
    const b = shrimpBoat();
    // Eighty-five percent. At full size the wheelhouse eats a third of the
    // screen and you cannot see the water you are supposed to be reading.
    b.scale.setScalar(0.85);
    return b;
  },
  deck: 0.9,
  deckZ: -2.6,
  water: { amp: 0.16, stormAmp: 1.25 },
  scenery: [
    { make: buoy, every: 34, offset: [13, 34] },
    { make: (r) => trawler(r), every: 150, offset: [24, 52] },
    { make: () => oilRig(), every: 640, offset: [55, 85] },
    { make: palm, every: 300, offset: [60, 90], scale: [1, 1.6] },
  ],
  obstacles: [
    { key: "pot", make: () => crabPot(), radius: 1.3, height: 40, weight: 4 },
    { key: "reef", make: reefRock, radius: 2.4, height: 40, weight: 3 },
    { key: "wreck", make: (r) => trawler(r, true), radius: 3.2, height: 40, weight: 1, closing: 0.25 },
  ],
  obstacleEvery: [46, 26],
  pickup: { make: shrimpProp, every: 24, value: 260, label: "BUBBA GUMP" },
  lives: 3,
  beats: [
    { at: 0.035, say: "Nothin' out here but rocks and shrimp. Find the shrimp." },
    {
      at: 0.4,
      say: "Storm's coming in. Hold her steady.",
      effect: "storm",
      sky: [0x2c3742, 0x59636b, 0x555f68, 0.016],
    },
    { at: 0.7, say: "Every other boat in the gulf is on the bottom." },
    {
      at: 0.86,
      say: "After that, shrimping was easy.",
      effect: "clear",
      sky: [0x63b4e0, 0xe8d8c0, 0xdcd4c4, 0.005],
    },
  ],
  music: [175, 0.4],
  stat: NAUTICAL,
};

/* =============================================================== AMERICA */

const america: RunSpec = {
  goal: 5200,
  halfWidth: 7,
  start: 10,
  max: 21,
  accel: 1.1,
  boost: 1.22,
  terrain: { texture: desertGround, tile: 10 },
  road: { texture: highway, tile: 16, width: 16 },
  sky: [0xe8a765, 0xf2d8b0, 0xe6c8a4, 0.007],
  hero: LOOKS.beard,
  surface: "road",
  scenery: [
    { make: cactus, every: 15, offset: [11, 34], scale: [0.8, 1.4] },
    { make: mesa, every: 78, offset: [48, 150], scale: [0.7, 1.6], sink: 1.5 },
    { make: () => roadSign(), every: 78, offset: [10.5, 11.5] },
    { make: powerPole, every: 42, offset: [12, 13.5], side: "right" },
    { make: pineTree, every: 44, offset: [16, 46], scale: [0.8, 1.3] },
  ],
  obstacles: [
    { key: "car", make: car, radius: 1.5, height: 40, weight: 5, closing: 0.55 },
    { key: "cactus", make: cactus, radius: 0.9, height: 40, weight: 3 },
    { key: "press", make: reporter, radius: 0.9, height: 2.1, weight: 2, homing: 0.35 },
  ],
  obstacleEvery: [46, 25],
  pickup: { make: chocolateBox, every: 27, label: "CHOCOLATES", recruits: true },
  followers: { max: 40, per: 1 },
  lives: 4,
  beats: [
    { at: 0.035, say: "That day, for no particular reason, I decided to go for a little run." },
    { at: 0.12, say: "So I ran to the end of the road. And I kept on going." },
    {
      at: 0.24,
      say: "People started running with me.",
      effect: "crowd",
      sky: [0x4f9fd8, 0xcfe4ea, 0xb8d0da, 0.006],
    },
    {
      at: 0.42,
      say: "I ran clear across the country. Three years, two months, fourteen days.",
      sky: [0x0d1b33, 0x27405e, 0x253c58, 0.011],
    },
    {
      at: 0.58,
      say: "When I got hungry, I ate. When I got tired, I slept.",
      effect: "crowd",
      sky: [0xe07a4a, 0xf2c890, 0xe4b488, 0.008],
    },
    {
      at: 0.74,
      say: "They said here was a man with an answer for everything.",
      effect: "cheer",
      sky: [0x4f9fd8, 0xdce8e4, 0xc4d8d4, 0.005],
    },
    { at: 0.9, say: "I'm pretty tired. I think I'll go home now." },
  ],
  music: [262, 0.32],
  stat: MILES,
};

/* ============================================================= the index */

export interface ChapterMeta {
  id: ChapterId;
  icon: string;
  /** Short label under the timeline dot. */
  tab: string;
  title: string;
  where: string;
  /** The line on the title card, before you start. */
  card: string;
  /** Said over the beat card once you clear it. */
  outro: string;
  /** Said when you do not. */
  fail: string;
  /** One line of how-to, tailored to the chapter. */
  how: string;
  accent: string;
}

export const CHAPTERS: ChapterMeta[] = [
  {
    id: "greenbow",
    icon: "🏃",
    tab: "Greenbow",
    title: "Run, Vibey, Run",
    where: "Greenbow, Alabama",
    card: "There are three boys on bikes behind you and steel on both your legs. Run anyway.",
    outro: "From that day on, if he was going somewhere, he was running.",
    fail: "They caught him. They always caught him — until the day they didn't.",
    how: "Steer around what's in the road. The braces come off on their own.",
    accent: "#c9a24a",
  },
  {
    id: "football",
    icon: "🏈",
    tab: "The Field",
    title: "All-American",
    where: "University of Alabama",
    card: "Somebody handed him the ball, and nobody told him where to stop.",
    outro: "They put him on the All-American team. He just liked running.",
    fail: "Tackled. Coach is not happy.",
    how: "The defense homes in on your lane. Jump the tackle or get outside it.",
    accent: "#a6192e",
  },
  {
    id: "vietnam",
    icon: "🌧️",
    tab: "The Rain",
    title: "The Treeline",
    where: "Vietnam",
    card: "Four men are down in that field and there is fire coming up the valley.",
    outro: "He kept going back. He said he was looking for Bubba.",
    fail: "The fire got there first.",
    how: "Run over a man to pick him up and he rides out on your back. Beat the fire to the treeline.",
    accent: "#4d7a3a",
  },
  {
    id: "pingpong",
    icon: "🏓",
    tab: "Ping-Pong",
    title: "Ping-Pong Diplomacy",
    where: "Peking",
    card: "All you have to do is keep your eye on the ball. First to eleven.",
    outro: "He was on every magazine in the country. He never blinked once.",
    fail: "Eleven to them. Even he lost some.",
    how: "Slide across to meet the ball, then tap to swing. Lean as you hit and it goes that way.",
    accent: "#e0b53a",
  },
  {
    id: "shrimp",
    icon: "🦐",
    tab: "The Boat",
    title: "Bubba Gump",
    where: "Bayou La Batre",
    card: "One boat, a lot of water, and a promise to a friend. Go find the shrimp.",
    outro: "Then Lieutenant Dan put the money in some kind of fruit company.",
    fail: "The Jenny went down with everybody else's.",
    how: "No jumping out here. Steer through the pots and the reefs and net every shrimp.",
    accent: "#f08a7a",
  },
  {
    id: "america",
    icon: "🇺🇸",
    tab: "The Run",
    title: "The Run",
    where: "Across America",
    card: "For no particular reason at all. Just keep running until you're done.",
    outro: "And then, for no particular reason, he stopped. And went home.",
    fail: "He sat down. Miles short.",
    how: "Every box of chocolates brings somebody with you. Hold BOOST on the open stretches.",
    accent: "#3d7dd8",
  },
];

/**
 * The five running specs, for the tests. A chapter whose obstacles are wider
 * than the gaps between them is unwinnable and looks completely fine in a
 * screenshot, so the invariants are checked rather than eyeballed.
 */
export const RUN_SPECS_FOR_TEST: Record<string, RunSpec> = {
  greenbow,
  football,
  vietnam,
  shrimp,
  america,
};

/** The one place that knows which chapter is which kind of game. */
export function makeChapter(id: ChapterId, ctx: ChapterCtx): Chapter {
  switch (id) {
    case "greenbow":
      return new RunChapter(ctx, greenbow);
    case "football":
      return new RunChapter(ctx, football);
    case "vietnam":
      return new RunChapter(ctx, vietnam);
    case "pingpong":
      return new PingPongChapter(ctx);
    case "shrimp":
      return new RunChapter(ctx, shrimp);
    case "america":
      return new RunChapter(ctx, america);
  }
}
