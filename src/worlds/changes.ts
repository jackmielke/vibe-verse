/**
 * What changed in each world lately — GENERATED, do not edit by hand.
 *
 * Regenerate with `npm run stamp`. The last 6 commits touching each
 * world's `source` paths, so a card can answer "what actually changed?" without
 * calling GitHub from the browser.
 *
 * Kept apart from `updated.ts` on purpose: every card reads a date, almost
 * nobody opens the history, and this file is twenty times the size.
 */
export interface WorldChange {
  /** Short hash — links to the commit on GitHub. */
  sha: string;
  iso: string;
  /** The commit subject line, verbatim. */
  subject: string;
}

export const REPO_URL = "https://github.com/jackmielke/vibe-verse";

export const WORLD_CHANGES: Record<string, WorldChange[]> = {
  "2048": [
    { sha: "79f1ff9", iso: "2026-08-10T23:18:12+00:00", subject: "Add Neon 2048 — the sliding-tile game in BLOB's colours" },
  ],
  "about": [
    { sha: "2565fa3", iso: "2026-05-10T17:24:25-07:00", subject: "Mobile: push page chrome below the global nav strip" },
    { sha: "6c1cfa1", iso: "2026-05-08T23:21:56-07:00", subject: "Hover labels actually hidden + closer fly-in + 3D About page" },
  ],
  "agent-lobby": [
    { sha: "1dae49a", iso: "2026-06-21T02:08:47+00:00", subject: "Changes" },
    { sha: "433a560", iso: "2026-06-21T02:08:42+00:00", subject: "Changes" },
    { sha: "ba2e953", iso: "2026-06-18T04:29:51+00:00", subject: "Point /world at the live vibe-world backend; drop redundant agent-lobby" },
    { sha: "809331d", iso: "2026-06-18T03:33:59+00:00", subject: "Add Agent Lobby — an always-on world agents can join over HTTP" },
  ],
  "airplane": [
    { sha: "01117ab", iso: "2026-08-02T07:13:32+00:00", subject: "The crew had the fish, and you are in the left seat" },
  ],
  "arcade": [
    { sha: "56590fb", iso: "2026-08-10T02:02:03+00:00", subject: "The shop window shows the characters instead of naming them" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20+00:00", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "382e5e3", iso: "2026-08-07T20:52:32+00:00", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "544acf6", iso: "2026-08-06T06:19:50+00:00", subject: "🪙 Vibecoin becomes a currency: a balance in every corner, and an arcade to spend it in" },
  ],
  "blob": [
    { sha: "64140cc", iso: "2026-08-10T23:09:13+00:00", subject: "BLOB: a phone sets a course, and a room code shares the dish" },
    { sha: "9423a4a", iso: "2026-08-08T05:45:14+00:00", subject: "BLOB: agar.io in the vibeverse — one dish, twenty-four rivals" },
  ],
  "blob-battle": [
    { sha: "1ece01a", iso: "2026-08-10T07:08:13+00:00", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "blue-angels": [
    { sha: "9c4cb91", iso: "2026-08-06T06:39:05+00:00", subject: "Race a hydroplane" },
    { sha: "ecff667", iso: "2026-08-06T06:11:14+00:00", subject: "Left turns left, and the crash hits like one" },
    { sha: "04da790", iso: "2026-08-04T18:54:40+00:00", subject: "Point where you want to go" },
    { sha: "7512e1f", iso: "2026-08-02T18:29:32+00:00", subject: "Start on the Space Needle, and blow up when you hit it" },
    { sha: "349d5c1", iso: "2026-08-02T14:27:36+00:00", subject: "On a desktop, the cursor is the stick" },
    { sha: "5d2184a", iso: "2026-08-02T03:38:24+00:00", subject: "There was no way into the game on a phone" },
  ],
  "characters": [
    { sha: "991bdec", iso: "2026-07-09T00:55:22+00:00", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "d9cd716", iso: "2026-07-02T19:19:25+00:00", subject: "Vibe karts, cleaner clouds, VibeVerse marquee, saved character" },
    { sha: "9064949", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
  ],
  "chronicle": [
    { sha: "7d18916", iso: "2026-08-15T15:25:14+00:00", subject: "Every day of the vibeverse, one square each" },
    { sha: "7dad4f4", iso: "2026-08-14T06:58:33+00:00", subject: "The Chronicle: every world, in the order it appeared" },
  ],
  "city": [
    { sha: "1244104", iso: "2026-08-18T21:25:35+00:00", subject: "Made the dancers people rather than four copies of one person" },
    { sha: "5a0721d", iso: "2026-08-17T16:54:36+00:00", subject: "The jetpack is on your back now, and the sea stops following you home" },
    { sha: "52261cf", iso: "2026-08-17T16:24:27+00:00", subject: "A dance floor in the plaza, with regulars who join in" },
    { sha: "ec4175d", iso: "2026-08-17T07:39:19+00:00", subject: "Put the city on a beat, and made a crowd sound like one" },
    { sha: "6896dbb", iso: "2026-08-17T06:39:11+00:00", subject: "The bay has something in it, and you can finally look up" },
    { sha: "461d142", iso: "2026-08-17T05:14:33+00:00", subject: "Traffic can knock you over, water muffles the world, and /city got measured" },
  ],
  "coil": [
    { sha: "ab05b31", iso: "2026-08-11T06:19:41+00:00", subject: "Fourteen characters that are not a person in a costume" },
    { sha: "8555942", iso: "2026-08-11T00:01:59+00:00", subject: "COIL: slither, with your shop character riding the front" },
  ],
  "coin": [
    { sha: "51778ca", iso: "2026-08-12T06:08:52+00:00", subject: "The wink arrives as a picture, then wakes up" },
    { sha: "bad92a2", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "d7e7287", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "cf59d39", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "d6a41e1", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
  ],
  "companions": [
    { sha: "eef5ac5", iso: "2026-07-13T09:47:28+00:00", subject: "✨ Agent Lab: hatched companions gently bob (feel alive)" },
    { sha: "cdcbd13", iso: "2026-07-12T12:49:55+00:00", subject: "🧪 Agent Lab — hatch your own companion (chunk 1)" },
  ],
  "deep": [
    { sha: "18b88dc", iso: "2026-08-17T06:36:43+00:00", subject: "🔦 The Midnight Zone was unplayable, and none of it showed up in a build" },
    { sha: "df6f764", iso: "2026-08-16T09:33:15+00:00", subject: "🔦 THE MIDNIGHT ZONE: eight kilometres straight down, and the light runs out" },
  ],
  "drop-zero": [
    { sha: "92c749d", iso: "2026-08-17T08:14:47+00:00", subject: "The water soundscape, and an ending nobody had ever reached" },
    { sha: "819ed12", iso: "2026-08-16T00:41:18-07:00", subject: "The teammate stopped standing in a field, and started keeping score" },
    { sha: "18bc6e8", iso: "2026-08-09T21:12:47-07:00", subject: "A voice in the booth calls the match" },
    { sha: "e3f8766", iso: "2026-08-09T20:58:42-07:00", subject: "Players can finally soak each other" },
    { sha: "8a0487a", iso: "2026-08-09T20:26:21-07:00", subject: "The end card says Play again" },
    { sha: "e0e8052", iso: "2026-08-09T20:07:35-07:00", subject: "Escape gives the mouse back instead of throwing you out" },
  ],
  "dunes": [
    { sha: "271da81", iso: "2026-08-16T20:40:40+00:00", subject: "The Dune Sea was drawing the sky where the ground should be" },
    { sha: "c7d5b2c", iso: "2026-08-16T18:38:10+00:00", subject: "The Dune Sea: sandboarding a sunset, on one function" },
  ],
  "edm-town": [
    { sha: "2e62671", iso: "2026-08-01T06:06:01+00:00", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "c02b5ca", iso: "2026-06-17T20:19:43+00:00", subject: "Changes" },
  ],
  "evolve": [
    { sha: "9064949", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
    { sha: "aa74eae", iso: "2026-06-12T00:17:23+00:00", subject: "Evolve world (genesis-bloom-evolve) + voice conversations with Vibey" },
  ],
  "fnaf": [
    { sha: "757ca68", iso: "2026-08-02T05:26:54+00:00", subject: "Take the intercom back out" },
    { sha: "1554778", iso: "2026-08-02T04:52:36+00:00", subject: "Vibey moves in, and Freddy stops owning one corridor" },
    { sha: "451190b", iso: "2026-08-02T03:47:44+00:00", subject: "Chica's beak was inside her head" },
    { sha: "001bc7a", iso: "2026-08-02T03:34:25+00:00", subject: "Faces that survive being looked at" },
    { sha: "b991259", iso: "2026-08-02T00:05:06+00:00", subject: "Thirty seconds up, then the system falls over" },
    { sha: "0a6ba9a", iso: "2026-08-01T22:59:20+00:00", subject: "Six seconds before you can look again" },
  ],
  "frisco": [
    { sha: "74ca69d", iso: "2026-08-18T21:47:54+00:00", subject: "Traffic that stops at the lights, and fifteen hundred cars at the kerb" },
    { sha: "151c50c", iso: "2026-08-18T21:20:21+00:00", subject: "Crossings, shopfronts, roof clutter — and the camera that would not move" },
    { sha: "7ec4acf", iso: "2026-08-17T18:32:49+00:00", subject: "The frame counter was lying, and now the world can act on the truth" },
    { sha: "2c4cd3e", iso: "2026-08-17T18:16:16+00:00", subject: "The Powell Street cable car, and you can ride it" },
    { sha: "ba32f69", iso: "2026-08-17T17:55:13+00:00", subject: "Karl comes in" },
    { sha: "b4ba187", iso: "2026-08-17T17:43:08+00:00", subject: "Bay windows, which is the most San Francisco thing there is" },
  ],
  "garden": [
    { sha: "1bf8d5a", iso: "2026-08-01T22:52:51+00:00", subject: "Flux everywhere, via one shared character rig" },
    { sha: "2e62671", iso: "2026-08-01T06:06:01+00:00", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "9c12ce6", iso: "2026-05-14T04:34:55+00:00", subject: "Changes" },
    { sha: "cc0a14b", iso: "2026-05-14T04:34:45+00:00", subject: "Changes" },
    { sha: "a761af7", iso: "2026-05-14T04:34:27+00:00", subject: "Changes" },
    { sha: "8f21d79", iso: "2026-05-14T03:26:15+00:00", subject: "Changes" },
  ],
  "glass-lake": [
    { sha: "f30d5d9", iso: "2026-08-16T18:06:05+00:00", subject: "The Glass Lake: it is you out there now, and the steering woke up" },
    { sha: "82036eb", iso: "2026-08-16T10:10:03+00:00", subject: "The Glass Lake: black ice, a live aurora, and the reflection for free" },
  ],
  "globetrotter": [
    { sha: "550ec4e", iso: "2026-07-27T04:50:37+00:00", subject: "🌍 Globetrotter — the world, inside the world" },
  ],
  "go": [
    { sha: "0ebad2b", iso: "2026-07-04T19:35:41+00:00", subject: "VIBE FM retro deck, Cloud Kingdom physics fix, VIBE GO gets AR + avatar" },
    { sha: "28f6b29", iso: "2026-07-04T18:30:13+00:00", subject: "VIBE GO — catch the VibeVerse in the real world (/go)" },
  ],
  "golf": [
    { sha: "d21c8ab", iso: "2026-07-30T23:34:15+00:00", subject: "Merge origin/main into the golf branch" },
    { sha: "25360b1", iso: "2026-07-30T21:22:57+00:00", subject: "Vibe Golf joins the vibeverse" },
    { sha: "7c41123", iso: "2026-07-30T20:30:09+00:00", subject: "Vibe Golf: first critic-panel fixes" },
    { sha: "7197ce1", iso: "2026-07-30T19:44:33+00:00", subject: "Vibe Golf: gate the fairway-pop grade on saturation" },
    { sha: "9aa36c8", iso: "2026-07-30T19:43:20+00:00", subject: "Vibe Golf: art direction, grading, audio, and portrait framing" },
    { sha: "3c49770", iso: "2026-07-30T18:13:20+00:00", subject: "Vibe Golf: courses, hazards, portals, power-ups, character, HUD" },
  ],
  "home-alone": [
    { sha: "0445276", iso: "2026-08-02T18:22:49+00:00", subject: "Home Alone: infinite bricks" },
    { sha: "0ab2179", iso: "2026-08-02T14:42:55+00:00", subject: "Home Alone: nobody is made of boxes any more" },
    { sha: "d6c8aee", iso: "2026-08-02T14:17:18+00:00", subject: "Home Alone: the controls were lying about which way is forward" },
    { sha: "e65cc93", iso: "2026-08-02T09:25:58+00:00", subject: "Home Alone: the stairs no longer eat the camera" },
    { sha: "eef0d16", iso: "2026-08-02T09:14:33+00:00", subject: "Home Alone: put the lights up, and let them talk" },
    { sha: "502f02a", iso: "2026-08-02T09:14:33+00:00", subject: "Home Alone: a house you can walk, and two men who want it" },
  ],
  "i-spy": [
    { sha: "a409687", iso: "2026-08-06T17:20:04+00:00", subject: "Eleven levels, one per corner of the vibeverse" },
    { sha: "dbac9db", iso: "2026-08-04T18:19:03+00:00", subject: "Three ways to play" },
    { sha: "05f01ed", iso: "2026-08-04T17:47:22+00:00", subject: "Changes" },
    { sha: "29b3b62", iso: "2026-08-02T21:21:35+00:00", subject: "Every spike is a real spike" },
    { sha: "ee1f96c", iso: "2026-08-02T21:05:51+00:00", subject: "Nothing is spawned. It is drawn." },
    { sha: "b9cee40", iso: "2026-08-02T14:46:26+00:00", subject: "Nothing floats but the gears" },
  ],
  "island": [
    { sha: "1244104", iso: "2026-08-18T21:25:35+00:00", subject: "Made the dancers people rather than four copies of one person" },
    { sha: "52261cf", iso: "2026-08-17T16:24:27+00:00", subject: "A dance floor in the plaza, with regulars who join in" },
    { sha: "ec4175d", iso: "2026-08-17T07:39:19+00:00", subject: "Put the city on a beat, and made a crowd sound like one" },
    { sha: "5dfcd2b", iso: "2026-08-12T20:24:30+00:00", subject: "Hats that are actually on the head, and three more of them" },
    { sha: "7077dd7", iso: "2026-08-12T19:53:02+00:00", subject: "Swimming, and snow that settles" },
    { sha: "fb1d219", iso: "2026-08-12T07:05:02+00:00", subject: "Gave Vibe Island a town plan" },
  ],
  "island-2": [
    { sha: "0779cb9", iso: "2026-07-29T16:57:01+00:00", subject: "Island II: hanging roots, rope bridges, and the White Peak" },
    { sha: "023e4d3", iso: "2026-07-29T03:41:33+00:00", subject: "Vibe Island II — first light: the archipelago, the sky, the carved lagoon" },
  ],
  "island-explorer": [
    { sha: "e506684", iso: "2026-08-10T02:54:21+00:00", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "382e5e3", iso: "2026-08-07T20:52:32+00:00", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "e6d6df5", iso: "2026-08-06T17:19:43+00:00", subject: "🦇 Four new code-built characters, and the heist stops nagging" },
    { sha: "262ce61", iso: "2026-08-01T19:03:01+00:00", subject: "The character picker was rendering everyone as a silhouette" },
    { sha: "d8bd9f9", iso: "2026-08-01T19:03:00+00:00", subject: "Flux: a pilot with no model file, animated from its own motion" },
    { sha: "cab33d8", iso: "2026-07-03T05:12:25+00:00", subject: "Shared world physics, clickable mini emblem, de-glitched ground + signs" },
  ],
  "kart": [
    { sha: "26a8a93", iso: "2026-08-07T16:36:48+00:00", subject: "🏁 One Vibe Kart, and a lobby that starts the race for you" },
    { sha: "10c8533", iso: "2026-08-04T17:48:06+00:00", subject: "Changes" },
    { sha: "2dd7605", iso: "2026-08-04T17:47:56+00:00", subject: "Changes" },
    { sha: "ff17312", iso: "2026-08-04T17:47:51+00:00", subject: "Changes" },
    { sha: "c1bf108", iso: "2026-08-04T17:47:40+00:00", subject: "Changes" },
    { sha: "05f01ed", iso: "2026-08-04T17:47:22+00:00", subject: "Changes" },
  ],
  "lobby": [
    { sha: "1bf8d5a", iso: "2026-08-01T22:52:51+00:00", subject: "Flux everywhere, via one shared character rig" },
    { sha: "991bdec", iso: "2026-07-09T00:55:22+00:00", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "a7f3709", iso: "2026-06-24T21:06:00+00:00", subject: "Changes" },
    { sha: "fd40c52", iso: "2026-06-24T21:05:53+00:00", subject: "Changes" },
    { sha: "21f5a45", iso: "2026-06-24T21:05:46+00:00", subject: "Changes" },
    { sha: "3931acd", iso: "2026-06-24T21:05:38+00:00", subject: "Changes" },
  ],
  "manifesto": [
    { sha: "56590fb", iso: "2026-08-10T02:02:03+00:00", subject: "The shop window shows the characters instead of naming them" },
  ],
  "moon": [
    { sha: "1244104", iso: "2026-08-18T21:25:35+00:00", subject: "Made the dancers people rather than four copies of one person" },
    { sha: "52261cf", iso: "2026-08-17T16:24:27+00:00", subject: "A dance floor in the plaza, with regulars who join in" },
    { sha: "ec4175d", iso: "2026-08-17T07:39:19+00:00", subject: "Put the city on a beat, and made a crowd sound like one" },
    { sha: "5dfcd2b", iso: "2026-08-12T20:24:30+00:00", subject: "Hats that are actually on the head, and three more of them" },
    { sha: "7077dd7", iso: "2026-08-12T19:53:02+00:00", subject: "Swimming, and snow that settles" },
    { sha: "fb1d219", iso: "2026-08-12T07:05:02+00:00", subject: "Gave Vibe Island a town plan" },
  ],
  "museum": [
    { sha: "f4e5d7c", iso: "2026-05-14T04:35:45+00:00", subject: "Changes" },
    { sha: "c5f68f3", iso: "2026-05-14T04:35:33+00:00", subject: "Changes" },
    { sha: "e35b0e5", iso: "2026-05-14T04:35:24+00:00", subject: "Changes" },
    { sha: "f9feeb9", iso: "2026-05-14T04:35:09+00:00", subject: "Changes" },
    { sha: "44a693c", iso: "2026-05-14T02:56:14+00:00", subject: "Changes" },
    { sha: "1020159", iso: "2026-05-14T02:41:35+00:00", subject: "Changes" },
  ],
  "newsroom": [
    { sha: "99e4d5b", iso: "2026-08-18T22:03:15+00:00", subject: "🗂 Small ads, bylines, and a spike by the door" },
    { sha: "6871988", iso: "2026-08-18T21:35:37+00:00", subject: "🗞 The Newsroom, and a paper that can be subscribed to" },
  ],
  "ninja": [
    { sha: "4232250", iso: "2026-06-12T02:52:26+00:00", subject: "Changes" },
    { sha: "efe0b65", iso: "2026-06-12T02:00:05+00:00", subject: "Changes" },
  ],
  "orbit": [
    { sha: "0868774", iso: "2026-08-07T06:58:26+00:00", subject: "🛰️ ORBIT, invite links and a pot: the vibeverse gets something to bet on" },
  ],
  "passport": [
    { sha: "c53bd6d", iso: "2026-08-17T07:15:04+00:00", subject: "Exploring pays, because nothing else did" },
    { sha: "9e1e6e4", iso: "2026-08-14T13:41:03+00:00", subject: "Your own line in the history" },
    { sha: "51778ca", iso: "2026-08-12T06:08:52+00:00", subject: "The wink arrives as a picture, then wakes up" },
    { sha: "7c30fbb", iso: "2026-08-10T03:06:30+00:00", subject: "The passport is a book now, not a fraction" },
  ],
  "portal": [
    { sha: "b6b15b8", iso: "2026-08-12T20:33:43+00:00", subject: "The form fills itself in while you type" },
    { sha: "1ece01a", iso: "2026-08-10T07:08:13+00:00", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "run": [
    { sha: "1109f8c", iso: "2026-08-02T07:24:16+00:00", subject: "A whole life, at a run" },
  ],
  "san-palmas": [
    { sha: "ecc0a09", iso: "2026-08-02T06:03:08+00:00", subject: "San Palmas: a squad that walks with you, and a spawn that is not under a bridge" },
    { sha: "d21c8ab", iso: "2026-07-30T23:34:15+00:00", subject: "Merge origin/main into the golf branch" },
    { sha: "109f0ec", iso: "2026-07-30T15:53:11+00:00", subject: "San Palmas: vegetation and the traversal kit" },
    { sha: "6c1b4a2", iso: "2026-07-29T02:32:18+00:00", subject: "San Palmas: resolve the spawn against live services, not captured ones" },
    { sha: "4a91051", iso: "2026-07-28T14:50:44+00:00", subject: "San Palmas: the city and the post-processing chain" },
    { sha: "11dba7d", iso: "2026-07-28T14:03:22+00:00", subject: "San Palmas: hero landmarks" },
  ],
  "seafair": [
    { sha: "0a2e4a2", iso: "2026-08-02T01:55:00+00:00", subject: "Seafair: stop the sky blooming over the whole frame, and shrink the weapon" },
    { sha: "26cbabd", iso: "2026-08-02T00:32:12+00:00", subject: "Seafair: a weapon, an enemy, ground worth standing on, and a lake" },
    { sha: "9a02bab", iso: "2026-08-01T18:35:31+00:00", subject: "Seafair: spawn facing the lake, not the hillside behind it" },
    { sha: "2d1b3ea", iso: "2026-08-01T18:27:23+00:00", subject: "Seafair: fix the blown-out sky, and add a screenshot harness" },
    { sha: "2dd0e1e", iso: "2026-07-31T14:56:54+00:00", subject: "Add SEAFAIR 2117 — future Seattle FPS at /seafair" },
  ],
  "sf": [
    { sha: "a13e984", iso: "2026-08-17T02:54:08+00:00", subject: "Spawn on the plaza, not inside it" },
    { sha: "60b25c0", iso: "2026-08-17T02:10:52+00:00", subject: "Walk San Francisco, and stop the city boiling while you do" },
    { sha: "05f01ed", iso: "2026-08-04T17:47:22+00:00", subject: "Changes" },
    { sha: "3503cda", iso: "2026-08-02T14:17:10+00:00", subject: "One way home, in the same corner of every world" },
    { sha: "4640558", iso: "2026-07-29T10:14:23+00:00", subject: "SF: eight subsystems land — postfx, physics, player, weapons, vfx, ai, vehicles, audio" },
    { sha: "9ba1460", iso: "2026-07-29T05:13:04+00:00", subject: "THE TERMINAL — the Vibeverse's front door, at /terminal" },
  ],
  "shop": [
    { sha: "64186e3", iso: "2026-08-10T06:39:09+00:00", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20+00:00", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "fe9bd3e", iso: "2026-08-07T04:14:36+00:00", subject: "🛍️ Vibecoin buys something you keep: cosmetics move onto the ledger" },
  ],
  "ski": [
    { sha: "1244104", iso: "2026-08-18T21:25:35+00:00", subject: "Made the dancers people rather than four copies of one person" },
    { sha: "52261cf", iso: "2026-08-17T16:24:27+00:00", subject: "A dance floor in the plaza, with regulars who join in" },
    { sha: "ec4175d", iso: "2026-08-17T07:39:19+00:00", subject: "Put the city on a beat, and made a crowd sound like one" },
    { sha: "5dfcd2b", iso: "2026-08-12T20:24:30+00:00", subject: "Hats that are actually on the head, and three more of them" },
    { sha: "7077dd7", iso: "2026-08-12T19:53:02+00:00", subject: "Swimming, and snow that settles" },
    { sha: "fb1d219", iso: "2026-08-12T07:05:02+00:00", subject: "Gave Vibe Island a town plan" },
  ],
  "space": [
    { sha: "5445c68", iso: "2026-07-19T06:36:25+00:00", subject: "Changes" },
    { sha: "4dcdc8d", iso: "2026-05-14T04:34:10+00:00", subject: "Changes" },
    { sha: "1217c56", iso: "2026-05-14T04:33:57+00:00", subject: "Changes" },
    { sha: "c89a83e", iso: "2026-05-14T04:33:49+00:00", subject: "Changes" },
    { sha: "45648c1", iso: "2026-05-14T04:33:38+00:00", subject: "Changes" },
    { sha: "d577da6", iso: "2026-05-14T04:33:23+00:00", subject: "Changes" },
  ],
  "splash-royale": [
    { sha: "92c749d", iso: "2026-08-17T08:14:47+00:00", subject: "The water soundscape, and an ending nobody had ever reached" },
    { sha: "819ed12", iso: "2026-08-16T00:41:18-07:00", subject: "The teammate stopped standing in a field, and started keeping score" },
    { sha: "18bc6e8", iso: "2026-08-09T21:12:47-07:00", subject: "A voice in the booth calls the match" },
    { sha: "e3f8766", iso: "2026-08-09T20:58:42-07:00", subject: "Players can finally soak each other" },
    { sha: "8a0487a", iso: "2026-08-09T20:26:21-07:00", subject: "The end card says Play again" },
    { sha: "e0e8052", iso: "2026-08-09T20:07:35-07:00", subject: "Escape gives the mouse back instead of throwing you out" },
  ],
  "strange-new-worlds": [
    { sha: "b919650", iso: "2026-08-08T21:04:25+00:00", subject: "Changes" },
    { sha: "c396353", iso: "2026-08-07T06:25:08+00:00", subject: "Air you can see through, and water on the worlds that have some" },
    { sha: "cd1d2ae", iso: "2026-08-07T05:14:27+00:00", subject: "The Odyssey gets a hull, and the planets get an atmosphere" },
    { sha: "296027a", iso: "2026-08-07T04:56:34+00:00", subject: "People you can stand in front of, and columns that are not clip art" },
    { sha: "7340506", iso: "2026-08-07T04:36:31+00:00", subject: "A real renderer: HDR post, baked PBR surfacing, sky-probe IBL, ground scatter" },
    { sha: "99439c8", iso: "2026-08-07T01:20:45+00:00", subject: "🖖 Strange New Worlds — twelve real Star Trek systems, and everyone on them talks back" },
  ],
  "submit-world": [
    { sha: "1a0094c", iso: "2026-06-15T22:23:49+00:00", subject: "Changes" },
  ],
  "terminal": [
    { sha: "e7f0101", iso: "2026-08-17T15:57:50+00:00", subject: "Changes" },
    { sha: "d6c3472", iso: "2026-08-05T22:37:49+00:00", subject: "Changes" },
    { sha: "3503cda", iso: "2026-08-02T14:17:10+00:00", subject: "One way home, in the same corner of every world" },
    { sha: "bed57ee", iso: "2026-08-01T19:54:56+00:00", subject: "Fix the Terminal on phones, and say what this project actually is" },
    { sha: "0e6a9ed", iso: "2026-07-29T16:47:45+00:00", subject: "Terminal: real card art, a bluer sky, and an island that reads as an island" },
    { sha: "9ba1460", iso: "2026-07-29T05:13:04+00:00", subject: "THE TERMINAL — the Vibeverse's front door, at /terminal" },
  ],
  "times": [
    { sha: "99e4d5b", iso: "2026-08-18T22:03:15+00:00", subject: "🗂 Small ads, bylines, and a spike by the door" },
    { sha: "6871988", iso: "2026-08-18T21:35:37+00:00", subject: "🗞 The Newsroom, and a paper that can be subscribed to" },
    { sha: "caccb2a", iso: "2026-08-17T06:56:21+00:00", subject: "✉️ The paper takes letters, and Vibey finally reads it out loud" },
    { sha: "7318d50", iso: "2026-08-08T20:01:49+00:00", subject: "🕕 Every edition says what time it came off the presses" },
    { sha: "480cd7d", iso: "2026-08-08T05:26:39+00:00", subject: "📰 The Vibe Times prints itself every morning, with a wire desk" },
    { sha: "cacc859", iso: "2026-08-02T00:00:17+00:00", subject: "The Vibe Times starts actually coming out" },
  ],
  "trek": [
    { sha: "3503cda", iso: "2026-08-02T14:17:10+00:00", subject: "One way home, in the same corner of every world" },
    { sha: "d3d3f48", iso: "2026-08-02T10:17:20+00:00", subject: "A silicon lifeform does not have deflector screens" },
    { sha: "ceafd63", iso: "2026-08-02T10:13:31+00:00", subject: "Let go of the trigger between episodes" },
    { sha: "2eed69d", iso: "2026-08-02T10:07:34+00:00", subject: "The bridge talks to itself on a quiet watch" },
    { sha: "fb4e2dc", iso: "2026-08-02T10:01:00+00:00", subject: "Two ways to end Balance of Terror, and one fewer way to lose unfairly" },
    { sha: "371f817", iso: "2026-08-02T09:48:15+00:00", subject: "Not everything out here is a ship" },
  ],
  "vibestar": [
    { sha: "1244104", iso: "2026-08-18T21:25:35+00:00", subject: "Made the dancers people rather than four copies of one person" },
    { sha: "52261cf", iso: "2026-08-17T16:24:27+00:00", subject: "A dance floor in the plaza, with regulars who join in" },
    { sha: "ec4175d", iso: "2026-08-17T07:39:19+00:00", subject: "Put the city on a beat, and made a crowd sound like one" },
    { sha: "5dfcd2b", iso: "2026-08-12T20:24:30+00:00", subject: "Hats that are actually on the head, and three more of them" },
    { sha: "7077dd7", iso: "2026-08-12T19:53:02+00:00", subject: "Swimming, and snow that settles" },
    { sha: "fb1d219", iso: "2026-08-12T07:05:02+00:00", subject: "Gave Vibe Island a town plan" },
  ],
  "vibeverse": [
    { sha: "53371bc", iso: "2026-08-17T08:08:54+00:00", subject: "Vibe Francisco: a toy San Francisco you can fly around" },
    { sha: "df6f764", iso: "2026-08-16T09:33:15+00:00", subject: "🔦 THE MIDNIGHT ZONE: eight kilometres straight down, and the light runs out" },
    { sha: "0868774", iso: "2026-08-07T06:58:26+00:00", subject: "🛰️ ORBIT, invite links and a pot: the vibeverse gets something to bet on" },
    { sha: "99439c8", iso: "2026-08-07T01:20:45+00:00", subject: "🖖 Strange New Worlds — twelve real Star Trek systems, and everyone on them talks back" },
    { sha: "544acf6", iso: "2026-08-06T06:19:50+00:00", subject: "🪙 Vibecoin becomes a currency: a balance in every corner, and an arcade to spend it in" },
    { sha: "7533666", iso: "2026-08-02T13:54:08+00:00", subject: "One grid, two columns, and cards that go where they say" },
  ],
  "village": [
    { sha: "fbba2b4", iso: "2026-06-12T04:25:29+00:00", subject: "Nav and flow reorganization: hero chips, full gallery, island spawn" },
    { sha: "fbc3fe0", iso: "2026-06-12T00:01:16+00:00", subject: "World picker: choose your world after the splash" },
    { sha: "7e79b7a", iso: "2026-05-21T20:24:01+00:00", subject: "Changes" },
    { sha: "e2e9568", iso: "2026-05-18T03:22:24+00:00", subject: "Changes" },
    { sha: "e24af18", iso: "2026-05-14T04:26:51+00:00", subject: "Changes" },
    { sha: "2cffbb4", iso: "2026-05-14T01:31:28+00:00", subject: "Changes" },
  ],
  "world-builder": [
    { sha: "e2a757a", iso: "2026-06-16T22:42:01+00:00", subject: "Changes" },
    { sha: "1979a51", iso: "2026-06-16T22:41:55+00:00", subject: "Changes" },
    { sha: "b337919", iso: "2026-06-16T22:41:50+00:00", subject: "Changes" },
    { sha: "7fd383f", iso: "2026-06-16T22:41:39+00:00", subject: "Changes" },
    { sha: "029cfdb", iso: "2026-06-16T22:41:15+00:00", subject: "Changes" },
    { sha: "4213468", iso: "2026-06-16T22:41:06+00:00", subject: "Changes" },
  ],
};
