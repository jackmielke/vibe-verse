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
    { sha: "79f1ff9", iso: "2026-08-10T23:18:12Z", subject: "Add Neon 2048 — the sliding-tile game in BLOB's colours" },
  ],
  "about": [
    { sha: "2565fa3", iso: "2026-05-10T17:24:25-07:00", subject: "Mobile: push page chrome below the global nav strip" },
    { sha: "6c1cfa1", iso: "2026-05-08T23:21:56-07:00", subject: "Hover labels actually hidden + closer fly-in + 3D About page" },
  ],
  "agent-lobby": [
    { sha: "1dae49a", iso: "2026-06-21T02:08:47Z", subject: "Changes" },
    { sha: "433a560", iso: "2026-06-21T02:08:42Z", subject: "Changes" },
    { sha: "ba2e953", iso: "2026-06-18T04:29:51Z", subject: "Point /world at the live vibe-world backend; drop redundant agent-lobby" },
    { sha: "809331d", iso: "2026-06-18T03:33:59Z", subject: "Add Agent Lobby — an always-on world agents can join over HTTP" },
  ],
  "airplane": [
    { sha: "01117ab", iso: "2026-08-02T07:13:32Z", subject: "The crew had the fish, and you are in the left seat" },
  ],
  "arcade": [
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03Z", subject: "The portal: other people's games, paying real Vibey Coins" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22Z", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "382e5e3", iso: "2026-08-07T20:52:32Z", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "544acf6", iso: "2026-08-06T06:19:50Z", subject: "🪙 Vibecoin becomes a currency: a balance in every corner, and an arcade to spend it in" },
  ],
  "blob": [
    { sha: "64140cc", iso: "2026-08-10T23:09:13Z", subject: "BLOB: a phone sets a course, and a room code shares the dish" },
    { sha: "9423a4a", iso: "2026-08-08T05:45:14Z", subject: "BLOB: agar.io in the vibeverse — one dish, twenty-four rivals" },
  ],
  "blob-battle": [
    { sha: "1ece01a", iso: "2026-08-10T07:08:13Z", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03Z", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "blue-angels": [
    { sha: "9c4cb91", iso: "2026-08-06T06:39:05Z", subject: "Race a hydroplane" },
    { sha: "ecff667", iso: "2026-08-06T06:11:14Z", subject: "Left turns left, and the crash hits like one" },
    { sha: "04da790", iso: "2026-08-04T18:54:40Z", subject: "Point where you want to go" },
    { sha: "7512e1f", iso: "2026-08-02T18:29:32Z", subject: "Start on the Space Needle, and blow up when you hit it" },
    { sha: "349d5c1", iso: "2026-08-02T14:27:36Z", subject: "On a desktop, the cursor is the stick" },
    { sha: "5d2184a", iso: "2026-08-02T03:38:24Z", subject: "There was no way into the game on a phone" },
  ],
  "characters": [
    { sha: "991bdec", iso: "2026-07-09T00:55:22Z", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "d9cd716", iso: "2026-07-02T19:19:25Z", subject: "Vibe karts, cleaner clouds, VibeVerse marquee, saved character" },
    { sha: "9064949", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
  ],
  "city": [
    { sha: "0ff7358", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "14ffac3", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "6521988", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "faf2a48", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "8a777ce", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
  ],
  "coil": [
    { sha: "8555942", iso: "2026-08-11T00:01:59Z", subject: "COIL: slither, with your shop character riding the front" },
  ],
  "coin": [
    { sha: "bad92a2", iso: "2026-08-09T19:09:20Z", subject: "Changes" },
    { sha: "d7e7287", iso: "2026-08-09T19:09:20Z", subject: "Changes" },
    { sha: "cf59d39", iso: "2026-08-09T19:09:20Z", subject: "Changes" },
    { sha: "d6a41e1", iso: "2026-08-09T19:09:20Z", subject: "Changes" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22Z", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "6a03371", iso: "2026-08-09T06:21:36Z", subject: "Changes" },
  ],
  "companions": [
    { sha: "eef5ac5", iso: "2026-07-13T09:47:28Z", subject: "✨ Agent Lab: hatched companions gently bob (feel alive)" },
    { sha: "cdcbd13", iso: "2026-07-12T12:49:55Z", subject: "🧪 Agent Lab — hatch your own companion (chunk 1)" },
  ],
  "drop-zero": [
    { sha: "18bc6e8", iso: "2026-08-09T21:12:47-07:00", subject: "A voice in the booth calls the match" },
    { sha: "e3f8766", iso: "2026-08-09T20:58:42-07:00", subject: "Players can finally soak each other" },
    { sha: "8a0487a", iso: "2026-08-09T20:26:21-07:00", subject: "The end card says Play again" },
    { sha: "e0e8052", iso: "2026-08-09T20:07:35-07:00", subject: "Escape gives the mouse back instead of throwing you out" },
    { sha: "433accb", iso: "2026-08-09T16:46:10Z", subject: "Wire the soak burst to every death, and get the red out" },
    { sha: "7fef527", iso: "2026-08-09T16:01:45Z", subject: "Checkpoint: the water death pass, mid-flight but green" },
  ],
  "edm-town": [
    { sha: "2e62671", iso: "2026-08-01T06:06:01Z", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "c02b5ca", iso: "2026-06-17T20:19:43Z", subject: "Changes" },
  ],
  "evolve": [
    { sha: "9064949", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
    { sha: "aa74eae", iso: "2026-06-12T00:17:23Z", subject: "Evolve world (genesis-bloom-evolve) + voice conversations with Vibey" },
  ],
  "fnaf": [
    { sha: "757ca68", iso: "2026-08-02T05:26:54Z", subject: "Take the intercom back out" },
    { sha: "1554778", iso: "2026-08-02T04:52:36Z", subject: "Vibey moves in, and Freddy stops owning one corridor" },
    { sha: "451190b", iso: "2026-08-02T03:47:44Z", subject: "Chica's beak was inside her head" },
    { sha: "001bc7a", iso: "2026-08-02T03:34:25Z", subject: "Faces that survive being looked at" },
    { sha: "b991259", iso: "2026-08-02T00:05:06Z", subject: "Thirty seconds up, then the system falls over" },
    { sha: "0a6ba9a", iso: "2026-08-01T22:59:20Z", subject: "Six seconds before you can look again" },
  ],
  "garden": [
    { sha: "1bf8d5a", iso: "2026-08-01T22:52:51Z", subject: "Flux everywhere, via one shared character rig" },
    { sha: "2e62671", iso: "2026-08-01T06:06:01Z", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "9c12ce6", iso: "2026-05-14T04:34:55Z", subject: "Changes" },
    { sha: "cc0a14b", iso: "2026-05-14T04:34:45Z", subject: "Changes" },
    { sha: "a761af7", iso: "2026-05-14T04:34:27Z", subject: "Changes" },
    { sha: "8f21d79", iso: "2026-05-14T03:26:15Z", subject: "Changes" },
  ],
  "globetrotter": [
    { sha: "550ec4e", iso: "2026-07-27T04:50:37Z", subject: "🌍 Globetrotter — the world, inside the world" },
  ],
  "go": [
    { sha: "0ebad2b", iso: "2026-07-04T19:35:41Z", subject: "VIBE FM retro deck, Cloud Kingdom physics fix, VIBE GO gets AR + avatar" },
    { sha: "28f6b29", iso: "2026-07-04T18:30:13Z", subject: "VIBE GO — catch the VibeVerse in the real world (/go)" },
  ],
  "golf": [
    { sha: "d21c8ab", iso: "2026-07-30T23:34:15Z", subject: "Merge origin/main into the golf branch" },
    { sha: "25360b1", iso: "2026-07-30T21:22:57Z", subject: "Vibe Golf joins the vibeverse" },
    { sha: "7c41123", iso: "2026-07-30T20:30:09Z", subject: "Vibe Golf: first critic-panel fixes" },
    { sha: "7197ce1", iso: "2026-07-30T19:44:33Z", subject: "Vibe Golf: gate the fairway-pop grade on saturation" },
    { sha: "9aa36c8", iso: "2026-07-30T19:43:20Z", subject: "Vibe Golf: art direction, grading, audio, and portrait framing" },
    { sha: "3c49770", iso: "2026-07-30T18:13:20Z", subject: "Vibe Golf: courses, hazards, portals, power-ups, character, HUD" },
  ],
  "home-alone": [
    { sha: "0445276", iso: "2026-08-02T18:22:49Z", subject: "Home Alone: infinite bricks" },
    { sha: "0ab2179", iso: "2026-08-02T14:42:55Z", subject: "Home Alone: nobody is made of boxes any more" },
    { sha: "d6c8aee", iso: "2026-08-02T14:17:18Z", subject: "Home Alone: the controls were lying about which way is forward" },
    { sha: "e65cc93", iso: "2026-08-02T09:25:58Z", subject: "Home Alone: the stairs no longer eat the camera" },
    { sha: "eef0d16", iso: "2026-08-02T09:14:33Z", subject: "Home Alone: put the lights up, and let them talk" },
    { sha: "502f02a", iso: "2026-08-02T09:14:33Z", subject: "Home Alone: a house you can walk, and two men who want it" },
  ],
  "i-spy": [
    { sha: "a409687", iso: "2026-08-06T17:20:04Z", subject: "Eleven levels, one per corner of the vibeverse" },
    { sha: "dbac9db", iso: "2026-08-04T18:19:03Z", subject: "Three ways to play" },
    { sha: "05f01ed", iso: "2026-08-04T17:47:22Z", subject: "Changes" },
    { sha: "29b3b62", iso: "2026-08-02T21:21:35Z", subject: "Every spike is a real spike" },
    { sha: "ee1f96c", iso: "2026-08-02T21:05:51Z", subject: "Nothing is spawned. It is drawn." },
    { sha: "b9cee40", iso: "2026-08-02T14:46:26Z", subject: "Nothing floats but the gears" },
  ],
  "island": [
    { sha: "8a777ce", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "4ec0a9c", iso: "2026-08-10T05:15:29Z", subject: "Five characters that are not the same person in different paint" },
    { sha: "e506684", iso: "2026-08-10T02:54:21Z", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
  ],
  "island-2": [
    { sha: "0779cb9", iso: "2026-07-29T16:57:01Z", subject: "Island II: hanging roots, rope bridges, and the White Peak" },
    { sha: "023e4d3", iso: "2026-07-29T03:41:33Z", subject: "Vibe Island II — first light: the archipelago, the sky, the carved lagoon" },
  ],
  "island-explorer": [
    { sha: "e506684", iso: "2026-08-10T02:54:21Z", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "382e5e3", iso: "2026-08-07T20:52:32Z", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "e6d6df5", iso: "2026-08-06T17:19:43Z", subject: "🦇 Four new code-built characters, and the heist stops nagging" },
    { sha: "262ce61", iso: "2026-08-01T19:03:01Z", subject: "The character picker was rendering everyone as a silhouette" },
    { sha: "d8bd9f9", iso: "2026-08-01T19:03:00Z", subject: "Flux: a pilot with no model file, animated from its own motion" },
    { sha: "cab33d8", iso: "2026-07-03T05:12:25Z", subject: "Shared world physics, clickable mini emblem, de-glitched ground + signs" },
  ],
  "kart": [
    { sha: "26a8a93", iso: "2026-08-07T16:36:48Z", subject: "🏁 One Vibe Kart, and a lobby that starts the race for you" },
    { sha: "10c8533", iso: "2026-08-04T17:48:06Z", subject: "Changes" },
    { sha: "2dd7605", iso: "2026-08-04T17:47:56Z", subject: "Changes" },
    { sha: "ff17312", iso: "2026-08-04T17:47:51Z", subject: "Changes" },
    { sha: "c1bf108", iso: "2026-08-04T17:47:40Z", subject: "Changes" },
    { sha: "05f01ed", iso: "2026-08-04T17:47:22Z", subject: "Changes" },
  ],
  "lobby": [
    { sha: "1bf8d5a", iso: "2026-08-01T22:52:51Z", subject: "Flux everywhere, via one shared character rig" },
    { sha: "991bdec", iso: "2026-07-09T00:55:22Z", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "a7f3709", iso: "2026-06-24T21:06:00Z", subject: "Changes" },
    { sha: "fd40c52", iso: "2026-06-24T21:05:53Z", subject: "Changes" },
    { sha: "21f5a45", iso: "2026-06-24T21:05:46Z", subject: "Changes" },
    { sha: "3931acd", iso: "2026-06-24T21:05:38Z", subject: "Changes" },
  ],
  "manifesto": [
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
  ],
  "moon": [
    { sha: "8a777ce", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "4ec0a9c", iso: "2026-08-10T05:15:29Z", subject: "Five characters that are not the same person in different paint" },
    { sha: "e506684", iso: "2026-08-10T02:54:21Z", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
  ],
  "museum": [
    { sha: "f4e5d7c", iso: "2026-05-14T04:35:45Z", subject: "Changes" },
    { sha: "c5f68f3", iso: "2026-05-14T04:35:33Z", subject: "Changes" },
    { sha: "e35b0e5", iso: "2026-05-14T04:35:24Z", subject: "Changes" },
    { sha: "f9feeb9", iso: "2026-05-14T04:35:09Z", subject: "Changes" },
    { sha: "44a693c", iso: "2026-05-14T02:56:14Z", subject: "Changes" },
    { sha: "1020159", iso: "2026-05-14T02:41:35Z", subject: "Changes" },
  ],
  "ninja": [
    { sha: "4232250", iso: "2026-06-12T02:52:26Z", subject: "Changes" },
    { sha: "efe0b65", iso: "2026-06-12T02:00:05Z", subject: "Changes" },
  ],
  "orbit": [
    { sha: "0868774", iso: "2026-08-07T06:58:26Z", subject: "🛰️ ORBIT, invite links and a pot: the vibeverse gets something to bet on" },
  ],
  "passport": [
    { sha: "7c30fbb", iso: "2026-08-10T03:06:30Z", subject: "The passport is a book now, not a fraction" },
  ],
  "portal": [
    { sha: "1ece01a", iso: "2026-08-10T07:08:13Z", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a1264", iso: "2026-08-09T07:49:03Z", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "run": [
    { sha: "1109f8c", iso: "2026-08-02T07:24:16Z", subject: "A whole life, at a run" },
  ],
  "san-palmas": [
    { sha: "ecc0a09", iso: "2026-08-02T06:03:08Z", subject: "San Palmas: a squad that walks with you, and a spawn that is not under a bridge" },
    { sha: "d21c8ab", iso: "2026-07-30T23:34:15Z", subject: "Merge origin/main into the golf branch" },
    { sha: "109f0ec", iso: "2026-07-30T15:53:11Z", subject: "San Palmas: vegetation and the traversal kit" },
    { sha: "6c1b4a2", iso: "2026-07-29T02:32:18Z", subject: "San Palmas: resolve the spawn against live services, not captured ones" },
    { sha: "4a91051", iso: "2026-07-28T14:50:44Z", subject: "San Palmas: the city and the post-processing chain" },
    { sha: "11dba7d", iso: "2026-07-28T14:03:22Z", subject: "San Palmas: hero landmarks" },
  ],
  "seafair": [
    { sha: "0a2e4a2", iso: "2026-08-02T01:55:00Z", subject: "Seafair: stop the sky blooming over the whole frame, and shrink the weapon" },
    { sha: "26cbabd", iso: "2026-08-02T00:32:12Z", subject: "Seafair: a weapon, an enemy, ground worth standing on, and a lake" },
    { sha: "9a02bab", iso: "2026-08-01T18:35:31Z", subject: "Seafair: spawn facing the lake, not the hillside behind it" },
    { sha: "2d1b3ea", iso: "2026-08-01T18:27:23Z", subject: "Seafair: fix the blown-out sky, and add a screenshot harness" },
    { sha: "2dd0e1e", iso: "2026-07-31T14:56:54Z", subject: "Add SEAFAIR 2117 — future Seattle FPS at /seafair" },
  ],
  "sf": [
    { sha: "05f01ed", iso: "2026-08-04T17:47:22Z", subject: "Changes" },
    { sha: "3503cda", iso: "2026-08-02T14:17:10Z", subject: "One way home, in the same corner of every world" },
    { sha: "4640558", iso: "2026-07-29T10:14:23Z", subject: "SF: eight subsystems land — postfx, physics, player, weapons, vfx, ai, vehicles, audio" },
    { sha: "9ba1460", iso: "2026-07-29T05:13:04Z", subject: "THE TERMINAL — the Vibeverse's front door, at /terminal" },
    { sha: "eb067f3", iso: "2026-07-29T04:54:34Z", subject: "SF: land the VFX, AI, audio and vehicle subsystems (not yet mounted)" },
    { sha: "023e4d3", iso: "2026-07-29T03:41:33Z", subject: "Vibe Island II — first light: the archipelago, the sky, the carved lagoon" },
  ],
  "shop": [
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "bc6bf8c", iso: "2026-08-09T06:54:22Z", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "fe9bd3e", iso: "2026-08-07T04:14:36Z", subject: "🛍️ Vibecoin buys something you keep: cosmetics move onto the ledger" },
  ],
  "ski": [
    { sha: "8a777ce", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "4ec0a9c", iso: "2026-08-10T05:15:29Z", subject: "Five characters that are not the same person in different paint" },
    { sha: "e506684", iso: "2026-08-10T02:54:21Z", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
  ],
  "space": [
    { sha: "5445c68", iso: "2026-07-19T06:36:25Z", subject: "Changes" },
    { sha: "4dcdc8d", iso: "2026-05-14T04:34:10Z", subject: "Changes" },
    { sha: "1217c56", iso: "2026-05-14T04:33:57Z", subject: "Changes" },
    { sha: "c89a83e", iso: "2026-05-14T04:33:49Z", subject: "Changes" },
    { sha: "45648c1", iso: "2026-05-14T04:33:38Z", subject: "Changes" },
    { sha: "d577da6", iso: "2026-05-14T04:33:23Z", subject: "Changes" },
  ],
  "splash-royale": [
    { sha: "18bc6e8", iso: "2026-08-09T21:12:47-07:00", subject: "A voice in the booth calls the match" },
    { sha: "e3f8766", iso: "2026-08-09T20:58:42-07:00", subject: "Players can finally soak each other" },
    { sha: "8a0487a", iso: "2026-08-09T20:26:21-07:00", subject: "The end card says Play again" },
    { sha: "e0e8052", iso: "2026-08-09T20:07:35-07:00", subject: "Escape gives the mouse back instead of throwing you out" },
    { sha: "433accb", iso: "2026-08-09T16:46:10Z", subject: "Wire the soak burst to every death, and get the red out" },
    { sha: "7fef527", iso: "2026-08-09T16:01:45Z", subject: "Checkpoint: the water death pass, mid-flight but green" },
  ],
  "strange-new-worlds": [
    { sha: "b919650", iso: "2026-08-08T21:04:25Z", subject: "Changes" },
    { sha: "c396353", iso: "2026-08-07T06:25:08Z", subject: "Air you can see through, and water on the worlds that have some" },
    { sha: "cd1d2ae", iso: "2026-08-07T05:14:27Z", subject: "The Odyssey gets a hull, and the planets get an atmosphere" },
    { sha: "296027a", iso: "2026-08-07T04:56:34Z", subject: "People you can stand in front of, and columns that are not clip art" },
    { sha: "7340506", iso: "2026-08-07T04:36:31Z", subject: "A real renderer: HDR post, baked PBR surfacing, sky-probe IBL, ground scatter" },
    { sha: "99439c8", iso: "2026-08-07T01:20:45Z", subject: "🖖 Strange New Worlds — twelve real Star Trek systems, and everyone on them talks back" },
  ],
  "submit-world": [
    { sha: "1a0094c", iso: "2026-06-15T22:23:49Z", subject: "Changes" },
  ],
  "terminal": [
    { sha: "d6c3472", iso: "2026-08-05T22:37:49Z", subject: "Changes" },
    { sha: "3503cda", iso: "2026-08-02T14:17:10Z", subject: "One way home, in the same corner of every world" },
    { sha: "bed57ee", iso: "2026-08-01T19:54:56Z", subject: "Fix the Terminal on phones, and say what this project actually is" },
    { sha: "0e6a9ed", iso: "2026-07-29T16:47:45Z", subject: "Terminal: real card art, a bluer sky, and an island that reads as an island" },
    { sha: "9ba1460", iso: "2026-07-29T05:13:04Z", subject: "THE TERMINAL — the Vibeverse's front door, at /terminal" },
  ],
  "times": [
    { sha: "7318d50", iso: "2026-08-08T20:01:49Z", subject: "🕕 Every edition says what time it came off the presses" },
    { sha: "480cd7d", iso: "2026-08-08T05:26:39Z", subject: "📰 The Vibe Times prints itself every morning, with a wire desk" },
    { sha: "cacc859", iso: "2026-08-02T00:00:17Z", subject: "The Vibe Times starts actually coming out" },
    { sha: "2e13693", iso: "2026-07-18T02:43:29Z", subject: "📰 The Vibe Times — the world writes its own newspaper" },
  ],
  "trek": [
    { sha: "3503cda", iso: "2026-08-02T14:17:10Z", subject: "One way home, in the same corner of every world" },
    { sha: "d3d3f48", iso: "2026-08-02T10:17:20Z", subject: "A silicon lifeform does not have deflector screens" },
    { sha: "ceafd63", iso: "2026-08-02T10:13:31Z", subject: "Let go of the trigger between episodes" },
    { sha: "2eed69d", iso: "2026-08-02T10:07:34Z", subject: "The bridge talks to itself on a quiet watch" },
    { sha: "fb4e2dc", iso: "2026-08-02T10:01:00Z", subject: "Two ways to end Balance of Terror, and one fewer way to lose unfairly" },
    { sha: "371f817", iso: "2026-08-02T09:48:15Z", subject: "Not everything out here is a ship" },
  ],
  "vibestar": [
    { sha: "8a777ce", iso: "2026-08-10T23:24:32Z", subject: "Changes" },
    { sha: "64186e3", iso: "2026-08-10T06:39:09Z", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "4ec0a9c", iso: "2026-08-10T05:15:29Z", subject: "Five characters that are not the same person in different paint" },
    { sha: "e506684", iso: "2026-08-10T02:54:21Z", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "56590fb", iso: "2026-08-10T02:02:03Z", subject: "The shop window shows the characters instead of naming them" },
    { sha: "3f0643e", iso: "2026-08-08T21:32:20Z", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
  ],
  "vibeverse": [
    { sha: "0868774", iso: "2026-08-07T06:58:26Z", subject: "🛰️ ORBIT, invite links and a pot: the vibeverse gets something to bet on" },
    { sha: "99439c8", iso: "2026-08-07T01:20:45Z", subject: "🖖 Strange New Worlds — twelve real Star Trek systems, and everyone on them talks back" },
    { sha: "544acf6", iso: "2026-08-06T06:19:50Z", subject: "🪙 Vibecoin becomes a currency: a balance in every corner, and an arcade to spend it in" },
    { sha: "7533666", iso: "2026-08-02T13:54:08Z", subject: "One grid, two columns, and cards that go where they say" },
    { sha: "c5f07c9", iso: "2026-08-02T08:44:36Z", subject: "THE FINAL FRONTIER joins the vibeverse" },
    { sha: "77ca812", iso: "2026-08-02T06:51:59Z", subject: "Fly it with one hand on the mouse, and hit something hard enough to matter" },
  ],
  "village": [
    { sha: "fbba2b4", iso: "2026-06-12T04:25:29Z", subject: "Nav and flow reorganization: hero chips, full gallery, island spawn" },
    { sha: "fbc3fe0", iso: "2026-06-12T00:01:16Z", subject: "World picker: choose your world after the splash" },
    { sha: "7e79b7a", iso: "2026-05-21T20:24:01Z", subject: "Changes" },
    { sha: "e2e9568", iso: "2026-05-18T03:22:24Z", subject: "Changes" },
    { sha: "e24af18", iso: "2026-05-14T04:26:51Z", subject: "Changes" },
    { sha: "2cffbb4", iso: "2026-05-14T01:31:28Z", subject: "Changes" },
  ],
  "world-builder": [
    { sha: "e2a757a", iso: "2026-06-16T22:42:01Z", subject: "Changes" },
    { sha: "1979a51", iso: "2026-06-16T22:41:55Z", subject: "Changes" },
    { sha: "b337919", iso: "2026-06-16T22:41:50Z", subject: "Changes" },
    { sha: "7fd383f", iso: "2026-06-16T22:41:39Z", subject: "Changes" },
    { sha: "029cfdb", iso: "2026-06-16T22:41:15Z", subject: "Changes" },
    { sha: "4213468", iso: "2026-06-16T22:41:06Z", subject: "Changes" },
  ],
};
