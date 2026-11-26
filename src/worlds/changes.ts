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
    { sha: "79f1ff93", iso: "2026-08-10T23:18:12+00:00", subject: "Add Neon 2048 — the sliding-tile game in BLOB's colours" },
  ],
  "about": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "2565fa32", iso: "2026-05-10T17:24:25-07:00", subject: "Mobile: push page chrome below the global nav strip" },
    { sha: "6c1cfa19", iso: "2026-05-08T23:21:56-07:00", subject: "Hover labels actually hidden + closer fly-in + 3D About page" },
  ],
  "agent-lobby": [
    { sha: "1dae49ae", iso: "2026-06-21T02:08:47+00:00", subject: "Changes" },
    { sha: "433a560a", iso: "2026-06-21T02:08:42+00:00", subject: "Changes" },
    { sha: "ba2e953f", iso: "2026-06-18T04:29:51+00:00", subject: "Point /world at the live vibe-world backend; drop redundant agent-lobby" },
    { sha: "809331d4", iso: "2026-06-18T03:33:59+00:00", subject: "Add Agent Lobby — an always-on world agents can join over HTTP" },
  ],
  "agentocracy": [
    { sha: "944f5361", iso: "2026-09-04T09:21:30+00:00", subject: "Add Agentocracy: a cardboard Bainbridge Island run by fifty AI agents" },
  ],
  "airplane": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "01117ab9", iso: "2026-08-02T07:13:32+00:00", subject: "The crew had the fish, and you are in the left seat" },
  ],
  "airship": [
    { sha: "10b01051", iso: "2026-09-03T06:49:42+00:00", subject: "Four worlds from one week: the Dipsea, Pathfinder, Developer Trail, Duck On My Head" },
  ],
  "arcade": [
    { sha: "56590fb9", iso: "2026-08-10T02:02:03+00:00", subject: "The shop window shows the characters instead of naming them" },
    { sha: "88a12640", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
    { sha: "bc6bf8c4", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643ea", iso: "2026-08-08T21:32:20+00:00", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "382e5e39", iso: "2026-08-07T20:52:32+00:00", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "544acf60", iso: "2026-08-06T06:19:50+00:00", subject: "🪙 Vibecoin becomes a currency: a balance in every corner, and an arcade to spend it in" },
  ],
  "beck-road": [
    { sha: "d86c52ad", iso: "2026-09-09T04:04:33+00:00", subject: "Merge branch 'worktree-agent-afb7155b3c8a2f330'" },
    { sha: "871977b4", iso: "2026-09-09T04:04:33+00:00", subject: "Merge branch 'worktree-agent-af5a3f4ff2d1cb9dd'" },
    { sha: "bfa4b97f", iso: "2026-09-09T04:04:33+00:00", subject: "Merge branch 'worktree-agent-aedf1e557329c24a3'" },
    { sha: "ab434a2f", iso: "2026-09-09T04:04:33+00:00", subject: "Merge branch 'worktree-agent-ab75a3148a6c811a7'" },
    { sha: "ae012cda", iso: "2026-09-09T04:04:21+00:00", subject: "Beck Road: Puget Sound light, sky and post" },
    { sha: "30e05a25", iso: "2026-09-09T04:04:21+00:00", subject: "Beck Road: buildings from the footprints, with roofs that follow them" },
  ],
  "better-fortnite": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "c2dec86b", iso: "2026-09-02T15:47:54+00:00", subject: "Phones: a real layout for the royale HUD and San Francisco, not the desktop one squeezed" },
    { sha: "999d2a42", iso: "2026-09-02T08:13:54+00:00", subject: "Locker: fit skins off a render, hang the weapon on the bone three actually names" },
    { sha: "f34a3411", iso: "2026-09-02T06:56:05+00:00", subject: "Locker: posed bounds for skinned previews, harness telemetry for skins" },
    { sha: "2b7b92ac", iso: "2026-09-02T06:27:29+00:00", subject: "Play the island as anybody in the vibeverse (checkpoint)" },
    { sha: "666ad323", iso: "2026-09-02T05:20:44+00:00", subject: "BETTER FORTNITE: eat the augment digit in fixed(), harness filter, card art" },
  ],
  "blob": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "64140cc0", iso: "2026-08-10T23:09:13+00:00", subject: "BLOB: a phone sets a course, and a room code shares the dish" },
    { sha: "9423a4a4", iso: "2026-08-08T05:45:14+00:00", subject: "BLOB: agar.io in the vibeverse — one dish, twenty-four rivals" },
  ],
  "blob-battle": [
    { sha: "1ece01a5", iso: "2026-08-10T07:08:13+00:00", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a12640", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "blue-angels": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "9c4cb916", iso: "2026-08-06T06:39:05+00:00", subject: "Race a hydroplane" },
    { sha: "ecff667a", iso: "2026-08-06T06:11:14+00:00", subject: "Left turns left, and the crash hits like one" },
    { sha: "04da790e", iso: "2026-08-04T18:54:40+00:00", subject: "Point where you want to go" },
    { sha: "7512e1f9", iso: "2026-08-02T18:29:32+00:00", subject: "Start on the Space Needle, and blow up when you hit it" },
    { sha: "349d5c1c", iso: "2026-08-02T14:27:36+00:00", subject: "On a desktop, the cursor is the stick" },
  ],
  "bots": [
    { sha: "9666825b", iso: "2026-10-03T15:21:23-07:00", subject: "Bot Battle (/bots): X handle -> AI bot -> coached RPS match -> share card -> challenge link" },
  ],
  "cannon-run": [
    { sha: "29a13d97", iso: "2026-11-26T07:49:52+00:00", subject: "Cannon Chase: the finale, a pie showdown at Dot's Diner" },
    { sha: "4fcd3f09", iso: "2026-11-26T07:18:22+00:00", subject: "Cannon Chase: Gatch News covers the chase live, truck radio between bulletins" },
    { sha: "78583a05", iso: "2026-11-26T07:09:28+00:00", subject: "Cannon Chase: comic out of the game, Thanksgiving mode, Linda grinds her teeth" },
    { sha: "771b53db", iso: "2026-11-26T06:53:05+00:00", subject: "Cannon Chase: Lunatic Linda joins two-player; junkyard henchmen" },
    { sha: "68ed9c02", iso: "2026-11-26T06:43:53+00:00", subject: "Cannon Chase: train finale, 18-wheeler after the cement truck, aurora sky" },
    { sha: "45b45535", iso: "2026-11-26T06:43:53+00:00", subject: "Cannon Run is now Cannon Chase" },
  ],
  "characters": [
    { sha: "991bdec5", iso: "2026-07-09T00:55:22+00:00", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "d9cd716c", iso: "2026-07-02T19:19:25+00:00", subject: "Vibe karts, cleaner clouds, VibeVerse marquee, saved character" },
    { sha: "9064949f", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
  ],
  "chronicle": [
    { sha: "7d18916b", iso: "2026-08-15T15:25:14+00:00", subject: "Every day of the vibeverse, one square each" },
    { sha: "7dad4f4a", iso: "2026-08-14T06:58:33+00:00", subject: "The Chronicle: every world, in the order it appeared" },
  ],
  "city": [
    { sha: "1456de8e", iso: "2026-11-26T06:32:54+00:00", subject: "Vibe Island on phones: controls clear of the joystick; ride Pegasus by walking up and pressing F" },
    { sha: "2015a8ac", iso: "2026-11-26T05:35:30+00:00", subject: "Vibe Island driving: crashes, damage, explosions, a monster truck and a rare Comet" },
    { sha: "09531b8e", iso: "2026-11-25T20:07:55+00:00", subject: "Add body stickers on Vibe Island, visible to other players" },
    { sha: "a2573c5a", iso: "2026-11-25T19:28:36+00:00", subject: "Vibe Island character button opens the picture grid of all characters" },
    { sha: "6479738c", iso: "2026-11-25T19:15:35+00:00", subject: "Add rideable sky mounts, aerial tag, and fix multiplayer identities" },
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
  ],
  "coast-road": [
    { sha: "7101a68e", iso: "2026-09-06T21:28:22+00:00", subject: "Coast Road: a longboard down a headland to the sea, in two looks" },
  ],
  "coil": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "ab05b31a", iso: "2026-08-11T06:19:41+00:00", subject: "Fourteen characters that are not a person in a costume" },
    { sha: "85559428", iso: "2026-08-11T00:01:59+00:00", subject: "COIL: slither, with your shop character riding the front" },
  ],
  "coin": [
    { sha: "51778ca0", iso: "2026-08-12T06:08:52+00:00", subject: "The wink arrives as a picture, then wakes up" },
    { sha: "bad92a2a", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "d7e7287f", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "cf59d395", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "d6a41e17", iso: "2026-08-09T19:09:20+00:00", subject: "Changes" },
    { sha: "bc6bf8c4", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
  ],
  "companions": [
    { sha: "eef5ac55", iso: "2026-07-13T09:47:28+00:00", subject: "✨ Agent Lab: hatched companions gently bob (feel alive)" },
    { sha: "cdcbd134", iso: "2026-07-12T12:49:55+00:00", subject: "🧪 Agent Lab — hatch your own companion (chunk 1)" },
  ],
  "conservatory": [
    { sha: "694c6c71", iso: "2026-08-18T23:27:42+00:00", subject: "Three things you could only see from the wrong end of the room" },
    { sha: "9eb66186", iso: "2026-08-18T23:18:08+00:00", subject: "Sweep the Conservatory less often" },
    { sha: "2b13d314", iso: "2026-08-18T23:01:23+00:00", subject: "Furnish the Conservatory, and let three sparrows in" },
    { sha: "8fa0918a", iso: "2026-08-18T22:26:17+00:00", subject: "The Conservatory: forty-eight metres of glasshouse, and a walk" },
  ],
  "deep": [
    { sha: "18b88dcb", iso: "2026-08-17T06:36:43+00:00", subject: "🔦 The Midnight Zone was unplayable, and none of it showed up in a build" },
    { sha: "df6f7646", iso: "2026-08-16T09:33:15+00:00", subject: "🔦 THE MIDNIGHT ZONE: eight kilometres straight down, and the light runs out" },
  ],
  "developer-trail": [
    { sha: "10b01051", iso: "2026-09-03T06:49:42+00:00", subject: "Four worlds from one week: the Dipsea, Pathfinder, Developer Trail, Duck On My Head" },
  ],
  "dipsea": [
    { sha: "10b01051", iso: "2026-09-03T06:49:42+00:00", subject: "Four worlds from one week: the Dipsea, Pathfinder, Developer Trail, Duck On My Head" },
  ],
  "drop-zero": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "c2dec86b", iso: "2026-09-02T15:47:54+00:00", subject: "Phones: a real layout for the royale HUD and San Francisco, not the desktop one squeezed" },
    { sha: "999d2a42", iso: "2026-09-02T08:13:54+00:00", subject: "Locker: fit skins off a render, hang the weapon on the bone three actually names" },
    { sha: "f34a3411", iso: "2026-09-02T06:56:05+00:00", subject: "Locker: posed bounds for skinned previews, harness telemetry for skins" },
    { sha: "2b7b92ac", iso: "2026-09-02T06:27:29+00:00", subject: "Play the island as anybody in the vibeverse (checkpoint)" },
    { sha: "666ad323", iso: "2026-09-02T05:20:44+00:00", subject: "BETTER FORTNITE: eat the augment digit in fixed(), harness filter, card art" },
  ],
  "duck": [
    { sha: "10b01051", iso: "2026-09-03T06:49:42+00:00", subject: "Four worlds from one week: the Dipsea, Pathfinder, Developer Trail, Duck On My Head" },
  ],
  "dunes": [
    { sha: "271da818", iso: "2026-08-16T20:40:40+00:00", subject: "The Dune Sea was drawing the sky where the ground should be" },
    { sha: "c7d5b2c6", iso: "2026-08-16T18:38:10+00:00", subject: "The Dune Sea: sandboarding a sunset, on one function" },
  ],
  "edm-town": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "2e62671b", iso: "2026-08-01T06:06:01+00:00", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "c02b5ca9", iso: "2026-06-17T20:19:43+00:00", subject: "Changes" },
  ],
  "empyrean": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "8328bd37", iso: "2026-08-20T21:32:15+00:00", subject: "Write down the night's four features and its two worst lessons" },
    { sha: "613a2edd", iso: "2026-08-20T21:28:28+00:00", subject: "You can ride the ring tram, and a moving floor is now a primitive" },
    { sha: "9ecb358d", iso: "2026-08-20T20:20:20+00:00", subject: "The camera rig allocated two vectors a frame" },
    { sha: "52c5fd20", iso: "2026-08-20T20:15:20+00:00", subject: "The black rectangle was one NaN, and four rooms somebody lives in" },
    { sha: "10eb3a5e", iso: "2026-08-20T18:50:36+00:00", subject: "A camp on the ice, a festival after dark, a camera, and the bridges back" },
  ],
  "evolve": [
    { sha: "9064949f", iso: "2026-07-01T12:12:14-07:00", subject: "Add universal character selector" },
    { sha: "aa74eae3", iso: "2026-06-12T00:17:23+00:00", subject: "Evolve world (genesis-bloom-evolve) + voice conversations with Vibey" },
  ],
  "first-light": [
    { sha: "a86765f9", iso: "2026-08-18T22:28:16+00:00", subject: "First Light — a lake at dawn, and one quality ladder for everybody" },
  ],
  "fnaf": [
    { sha: "11e5487b", iso: "2026-11-26T05:03:09+00:00", subject: "Five Nights: a real desk fan sound, and the band poster draws Bonnie and Chica as themselves" },
    { sha: "757ca68f", iso: "2026-08-02T05:26:54+00:00", subject: "Take the intercom back out" },
    { sha: "1554778b", iso: "2026-08-02T04:52:36+00:00", subject: "Vibey moves in, and Freddy stops owning one corridor" },
    { sha: "451190be", iso: "2026-08-02T03:47:44+00:00", subject: "Chica's beak was inside her head" },
    { sha: "001bc7af", iso: "2026-08-02T03:34:25+00:00", subject: "Faces that survive being looked at" },
    { sha: "b9912596", iso: "2026-08-02T00:05:06+00:00", subject: "Thirty seconds up, then the system falls over" },
  ],
  "fogcity": [
    { sha: "3b479f42", iso: "2026-11-22T04:29:14+00:00", subject: "Fog City: a new open-world San Francisco, built from scratch to run fast" },
  ],
  "frisco": [
    { sha: "07bca5b8", iso: "2026-08-19T05:26:25+00:00", subject: "Towers meet the ground now, and the card art stopped being a rooftop" },
    { sha: "57ae7cce", iso: "2026-08-19T05:18:21+00:00", subject: "Streets that are lit at night, and headlights on the traffic" },
    { sha: "939bb6fb", iso: "2026-08-18T22:49:12+00:00", subject: "Sixteen hundred people who turn corners instead of vanishing" },
    { sha: "a12f0c34", iso: "2026-08-18T22:34:28+00:00", subject: "Twenty-five foot lots, garage doors, and the long way out of a terrace" },
    { sha: "bdf0cd6c", iso: "2026-08-18T22:18:06+00:00", subject: "Chunk the city so it can be frustum-culled" },
    { sha: "4ab570fe", iso: "2026-08-18T22:07:20+00:00", subject: "Fire escapes, lane markings, and two districts you can start in" },
  ],
  "garden": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "1bf8d5ab", iso: "2026-08-01T22:52:51+00:00", subject: "Flux everywhere, via one shared character rig" },
    { sha: "2e62671b", iso: "2026-08-01T06:06:01+00:00", subject: "The passport: nine worlds that finally know about each other" },
    { sha: "9c12ce60", iso: "2026-05-14T04:34:55+00:00", subject: "Changes" },
    { sha: "cc0a14b8", iso: "2026-05-14T04:34:45+00:00", subject: "Changes" },
    { sha: "a761af7f", iso: "2026-05-14T04:34:27+00:00", subject: "Changes" },
  ],
  "glass-lake": [
    { sha: "f30d5d94", iso: "2026-08-16T18:06:05+00:00", subject: "The Glass Lake: it is you out there now, and the steering woke up" },
    { sha: "82036eb4", iso: "2026-08-16T10:10:03+00:00", subject: "The Glass Lake: black ice, a live aurora, and the reflection for free" },
  ],
  "globetrotter": [
    { sha: "550ec4e7", iso: "2026-07-27T04:50:37+00:00", subject: "🌍 Globetrotter — the world, inside the world" },
  ],
  "go": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "0ebad2b8", iso: "2026-07-04T19:35:41+00:00", subject: "VIBE FM retro deck, Cloud Kingdom physics fix, VIBE GO gets AR + avatar" },
    { sha: "28f6b299", iso: "2026-07-04T18:30:13+00:00", subject: "VIBE GO — catch the VibeVerse in the real world (/go)" },
  ],
  "goggles": [
    { sha: "7353a30f", iso: "2026-09-04T09:21:20+00:00", subject: "Add The Half-Blind Triathlon at /goggles" },
  ],
  "golf": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "d21c8abb", iso: "2026-07-30T23:34:15+00:00", subject: "Merge origin/main into the golf branch" },
    { sha: "25360b18", iso: "2026-07-30T21:22:57+00:00", subject: "Vibe Golf joins the vibeverse" },
    { sha: "7c41123c", iso: "2026-07-30T20:30:09+00:00", subject: "Vibe Golf: first critic-panel fixes" },
    { sha: "7197ce11", iso: "2026-07-30T19:44:33+00:00", subject: "Vibe Golf: gate the fairway-pop grade on saturation" },
    { sha: "9aa36c8d", iso: "2026-07-30T19:43:20+00:00", subject: "Vibe Golf: art direction, grading, audio, and portrait framing" },
  ],
  "home-alone": [
    { sha: "04452764", iso: "2026-08-02T18:22:49+00:00", subject: "Home Alone: infinite bricks" },
    { sha: "0ab21791", iso: "2026-08-02T14:42:55+00:00", subject: "Home Alone: nobody is made of boxes any more" },
    { sha: "d6c8aeea", iso: "2026-08-02T14:17:18+00:00", subject: "Home Alone: the controls were lying about which way is forward" },
    { sha: "e65cc93f", iso: "2026-08-02T09:25:58+00:00", subject: "Home Alone: the stairs no longer eat the camera" },
    { sha: "eef0d16d", iso: "2026-08-02T09:14:33+00:00", subject: "Home Alone: put the lights up, and let them talk" },
    { sha: "502f02a5", iso: "2026-08-02T09:14:33+00:00", subject: "Home Alone: a house you can walk, and two men who want it" },
  ],
  "horizon": [
    { sha: "3b7e9af8", iso: "2026-10-09T09:22:41-07:00", subject: "Horizon Garden: retire Ten Sports a Year, 22 frontiers" },
    { sha: "bab3a010", iso: "2026-10-06T22:30:29-07:00", subject: "Horizon Garden: films for the last six stations, arrival sweep, generated garden sounds, phone layout fixes" },
    { sha: "33be83f4", iso: "2026-10-06T22:25:22-07:00", subject: "Horizon Garden: live real-sun sky and clock, station films, visitors and notes, other walkers, decluttered labels, smooth mode" },
    { sha: "8f65a8bd", iso: "2026-10-06T21:50:27-07:00", subject: "Horizon Garden: Vibe Island-style controls (orbit tilt, zoom to bird's-eye map, run, jump, joystick, minimap), fly-around and station videos" },
    { sha: "c8d520f2", iso: "2026-10-06T17:36:15-07:00", subject: "Horizon Garden: look picker with Photoreal, Golden Hour, Vibe Island, Night, Neon, Winter and Live" },
    { sha: "1c472096", iso: "2026-10-05T23:23:22-07:00", subject: "Horizon Garden: Personal Computers 2.0 and Abundant Energy; pop-up cities reach space, kids station cites Taking Children Seriously" },
  ],
  "i-spy": [
    { sha: "e29527aa", iso: "2026-08-18T22:20:14+00:00", subject: "Light the level, and stack it into a Spire" },
    { sha: "a409687e", iso: "2026-08-06T17:20:04+00:00", subject: "Eleven levels, one per corner of the vibeverse" },
    { sha: "dbac9dba", iso: "2026-08-04T18:19:03+00:00", subject: "Three ways to play" },
    { sha: "05f01ed4", iso: "2026-08-04T17:47:22+00:00", subject: "Changes" },
    { sha: "29b3b62b", iso: "2026-08-02T21:21:35+00:00", subject: "Every spike is a real spike" },
    { sha: "ee1f96cf", iso: "2026-08-02T21:05:51+00:00", subject: "Nothing is spawned. It is drawn." },
  ],
  "island": [
    { sha: "09531b8e", iso: "2026-11-25T20:07:55+00:00", subject: "Add body stickers on Vibe Island, visible to other players" },
    { sha: "a2573c5a", iso: "2026-11-25T19:28:36+00:00", subject: "Vibe Island character button opens the picture grid of all characters" },
    { sha: "6479738c", iso: "2026-11-25T19:15:35+00:00", subject: "Add rideable sky mounts, aerial tag, and fix multiplayer identities" },
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
    { sha: "2c812ab4", iso: "2026-11-25T18:18:18+00:00", subject: "Updated session expiry and auth" },
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
  ],
  "island-2": [
    { sha: "0779cb94", iso: "2026-07-29T16:57:01+00:00", subject: "Island II: hanging roots, rope bridges, and the White Peak" },
    { sha: "023e4d39", iso: "2026-07-29T03:41:33+00:00", subject: "Vibe Island II — first light: the archipelago, the sky, the carved lagoon" },
  ],
  "island-explorer": [
    { sha: "999d2a42", iso: "2026-09-02T08:13:54+00:00", subject: "Locker: fit skins off a render, hang the weapon on the bone three actually names" },
    { sha: "f34a3411", iso: "2026-09-02T06:56:05+00:00", subject: "Locker: posed bounds for skinned previews, harness telemetry for skins" },
    { sha: "e506684a", iso: "2026-08-10T02:54:21+00:00", subject: "Tapping a character opens that character, and you can dress it" },
    { sha: "382e5e39", iso: "2026-08-07T20:52:32+00:00", subject: "Arcade: a character shop with six originals you can buy and wear" },
    { sha: "e6d6df50", iso: "2026-08-06T17:19:43+00:00", subject: "🦇 Four new code-built characters, and the heist stops nagging" },
    { sha: "262ce61b", iso: "2026-08-01T19:03:01+00:00", subject: "The character picker was rendering everyone as a silhouette" },
  ],
  "kart": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "26a8a939", iso: "2026-08-07T16:36:48+00:00", subject: "🏁 One Vibe Kart, and a lobby that starts the race for you" },
    { sha: "10c85339", iso: "2026-08-04T17:48:06+00:00", subject: "Changes" },
    { sha: "2dd76057", iso: "2026-08-04T17:47:56+00:00", subject: "Changes" },
    { sha: "ff173129", iso: "2026-08-04T17:47:51+00:00", subject: "Changes" },
  ],
  "lobby": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "1bf8d5ab", iso: "2026-08-01T22:52:51+00:00", subject: "Flux everywhere, via one shared character rig" },
    { sha: "991bdec5", iso: "2026-07-09T00:55:22+00:00", subject: "🫂 New arrivals land in the world, near people — not stranded on Vibe Island" },
    { sha: "a7f37098", iso: "2026-06-24T21:06:00+00:00", subject: "Changes" },
    { sha: "fd40c52a", iso: "2026-06-24T21:05:53+00:00", subject: "Changes" },
  ],
  "magician": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "f59aaba5", iso: "2026-09-28T06:12:27+00:00", subject: "Magician: phones cast spells onto a projector; Vibey remembers you" },
    { sha: "85b66e42", iso: "2026-09-26T19:20:57+00:00", subject: "Magician: film real footage frame by frame; 'stop the rain' stops it" },
    { sha: "5860ef00", iso: "2026-09-26T18:09:58+00:00", subject: "Magician: Zombie Tag in the play menu and by voice; Vibey in front of you" },
    { sha: "ff4ffb4b", iso: "2026-09-25T17:15:09+00:00", subject: "Oni is Zombie Tag now: green zombies, not horned oni" },
    { sha: "30cb1d49", iso: "2026-09-25T03:27:57+00:00", subject: "Magician: pick a character, see everyone as theirs, and play tag in the valley" },
  ],
  "manifesto": [
    { sha: "56590fb9", iso: "2026-08-10T02:02:03+00:00", subject: "The shop window shows the characters instead of naming them" },
  ],
  "mars": [
    { sha: "f4715e0e", iso: "2026-09-04T09:28:00+00:00", subject: "Mars College: ten weeks in the desert on one wheel, at /mars" },
  ],
  "moon": [
    { sha: "09531b8e", iso: "2026-11-25T20:07:55+00:00", subject: "Add body stickers on Vibe Island, visible to other players" },
    { sha: "a2573c5a", iso: "2026-11-25T19:28:36+00:00", subject: "Vibe Island character button opens the picture grid of all characters" },
    { sha: "6479738c", iso: "2026-11-25T19:15:35+00:00", subject: "Add rideable sky mounts, aerial tag, and fix multiplayer identities" },
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
    { sha: "2c812ab4", iso: "2026-11-25T18:18:18+00:00", subject: "Updated session expiry and auth" },
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
  ],
  "museum": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "f4e5d7cd", iso: "2026-05-14T04:35:45+00:00", subject: "Changes" },
    { sha: "c5f68f35", iso: "2026-05-14T04:35:33+00:00", subject: "Changes" },
    { sha: "e35b0e52", iso: "2026-05-14T04:35:24+00:00", subject: "Changes" },
    { sha: "f9feeb9d", iso: "2026-05-14T04:35:09+00:00", subject: "Changes" },
    { sha: "44a693cc", iso: "2026-05-14T02:56:14+00:00", subject: "Changes" },
  ],
  "newsroom": [
    { sha: "99e4d5bf", iso: "2026-08-18T22:03:15+00:00", subject: "🗂 Small ads, bylines, and a spike by the door" },
    { sha: "68719881", iso: "2026-08-18T21:35:37+00:00", subject: "🗞 The Newsroom, and a paper that can be subscribed to" },
  ],
  "ninja": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "42322506", iso: "2026-06-12T02:52:26+00:00", subject: "Changes" },
    { sha: "efe0b65f", iso: "2026-06-12T02:00:05+00:00", subject: "Changes" },
  ],
  "oni": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "f59aaba5", iso: "2026-09-28T06:12:27+00:00", subject: "Magician: phones cast spells onto a projector; Vibey remembers you" },
    { sha: "ff4ffb4b", iso: "2026-09-25T17:15:09+00:00", subject: "Oni is Zombie Tag now: green zombies, not horned oni" },
    { sha: "30cb1d49", iso: "2026-09-25T03:27:57+00:00", subject: "Magician: pick a character, see everyone as theirs, and play tag in the valley" },
    { sha: "e5e81273", iso: "2026-09-25T02:49:46+00:00", subject: "Oni: point and click to run, in VR and on the flat" },
    { sha: "745d9fdf", iso: "2026-09-25T02:42:52+00:00", subject: "Oni: infection tag for the whole room, on phones, laptops and VR" },
  ],
  "orbit": [
    { sha: "08687746", iso: "2026-08-07T06:58:26+00:00", subject: "🛰️ ORBIT, invite links and a pot: the vibeverse gets something to bet on" },
  ],
  "passport": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "c53bd6d7", iso: "2026-08-17T07:15:04+00:00", subject: "Exploring pays, because nothing else did" },
    { sha: "9e1e6e4e", iso: "2026-08-14T13:41:03+00:00", subject: "Your own line in the history" },
    { sha: "51778ca0", iso: "2026-08-12T06:08:52+00:00", subject: "The wink arrives as a picture, then wakes up" },
    { sha: "7c30fbba", iso: "2026-08-10T03:06:30+00:00", subject: "The passport is a book now, not a fraction" },
  ],
  "phangan": [
    { sha: "7596d371", iso: "2026-09-04T09:24:59+00:00", subject: "Add Flow Phangan: scooter world at /phangan" },
  ],
  "portal": [
    { sha: "b6b15b85", iso: "2026-08-12T20:33:43+00:00", subject: "The form fills itself in while you type" },
    { sha: "1ece01a5", iso: "2026-08-10T07:08:13+00:00", subject: "Anybody can hand the arcade a game now" },
    { sha: "88a12640", iso: "2026-08-09T07:49:03+00:00", subject: "The portal: other people's games, paying real Vibey Coins" },
  ],
  "run": [
    { sha: "1109f8c7", iso: "2026-08-02T07:24:16+00:00", subject: "A whole life, at a run" },
  ],
  "san-palmas": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "ecc0a094", iso: "2026-08-02T06:03:08+00:00", subject: "San Palmas: a squad that walks with you, and a spawn that is not under a bridge" },
    { sha: "d21c8abb", iso: "2026-07-30T23:34:15+00:00", subject: "Merge origin/main into the golf branch" },
    { sha: "109f0ec0", iso: "2026-07-30T15:53:11+00:00", subject: "San Palmas: vegetation and the traversal kit" },
    { sha: "6c1b4a2e", iso: "2026-07-29T02:32:18+00:00", subject: "San Palmas: resolve the spawn against live services, not captured ones" },
    { sha: "4a91051f", iso: "2026-07-28T14:50:44+00:00", subject: "San Palmas: the city and the post-processing chain" },
  ],
  "seafair": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "0a2e4a2a", iso: "2026-08-02T01:55:00+00:00", subject: "Seafair: stop the sky blooming over the whole frame, and shrink the weapon" },
    { sha: "26cbabdd", iso: "2026-08-02T00:32:12+00:00", subject: "Seafair: a weapon, an enemy, ground worth standing on, and a lake" },
    { sha: "9a02babb", iso: "2026-08-01T18:35:31+00:00", subject: "Seafair: spawn facing the lake, not the hillside behind it" },
    { sha: "2d1b3ea5", iso: "2026-08-01T18:27:23+00:00", subject: "Seafair: fix the blown-out sky, and add a screenshot harness" },
    { sha: "2dd0e1ee", iso: "2026-07-31T14:56:54+00:00", subject: "Add SEAFAIR 2117 — future Seattle FPS at /seafair" },
  ],
  "sf": [
    { sha: "74e199a7", iso: "2026-11-22T04:33:32+00:00", subject: "Free Fall: draw the water and the weapon effects, skip the night shadow pass, open in daylight" },
    { sha: "7e6ae7b4", iso: "2026-11-22T03:27:43+00:00", subject: "San Francisco: fix the white roofs, relight for hard sun and a real sunset, /free-fall opens the game" },
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "c2dec86b", iso: "2026-09-02T15:47:54+00:00", subject: "Phones: a real layout for the royale HUD and San Francisco, not the desktop one squeezed" },
    { sha: "52d6e227", iso: "2026-08-29T07:01:41+00:00", subject: "The real weather, and a painted mountain on Twin Peaks" },
    { sha: "9fd6cfae", iso: "2026-08-28T08:23:33+00:00", subject: "The day passes now, and you can wave at people" },
  ],
  "shop": [
    { sha: "64186e31", iso: "2026-08-10T06:39:09+00:00", subject: "Thirty more characters, and the shop finally sells characters" },
    { sha: "bc6bf8c4", iso: "2026-08-09T06:54:22+00:00", subject: "main did not compile, and the play coin gets its own name" },
    { sha: "3f0643ea", iso: "2026-08-08T21:32:20+00:00", subject: "Rock paper scissors leads the arcade, and the shop grows a second tab" },
    { sha: "fe9bd3e8", iso: "2026-08-07T04:14:36+00:00", subject: "🛍️ Vibecoin buys something you keep: cosmetics move onto the ledger" },
  ],
  "ski": [
    { sha: "09531b8e", iso: "2026-11-25T20:07:55+00:00", subject: "Add body stickers on Vibe Island, visible to other players" },
    { sha: "a2573c5a", iso: "2026-11-25T19:28:36+00:00", subject: "Vibe Island character button opens the picture grid of all characters" },
    { sha: "6479738c", iso: "2026-11-25T19:15:35+00:00", subject: "Add rideable sky mounts, aerial tag, and fix multiplayer identities" },
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
    { sha: "2c812ab4", iso: "2026-11-25T18:18:18+00:00", subject: "Updated session expiry and auth" },
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
  ],
  "space": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "5445c68f", iso: "2026-07-19T06:36:25+00:00", subject: "Changes" },
    { sha: "4dcdc8d4", iso: "2026-05-14T04:34:10+00:00", subject: "Changes" },
    { sha: "1217c56c", iso: "2026-05-14T04:33:57+00:00", subject: "Changes" },
    { sha: "c89a83ed", iso: "2026-05-14T04:33:49+00:00", subject: "Changes" },
    { sha: "45648c1d", iso: "2026-05-14T04:33:38+00:00", subject: "Changes" },
  ],
  "splash-royale": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "c2dec86b", iso: "2026-09-02T15:47:54+00:00", subject: "Phones: a real layout for the royale HUD and San Francisco, not the desktop one squeezed" },
    { sha: "999d2a42", iso: "2026-09-02T08:13:54+00:00", subject: "Locker: fit skins off a render, hang the weapon on the bone three actually names" },
    { sha: "f34a3411", iso: "2026-09-02T06:56:05+00:00", subject: "Locker: posed bounds for skinned previews, harness telemetry for skins" },
    { sha: "2b7b92ac", iso: "2026-09-02T06:27:29+00:00", subject: "Play the island as anybody in the vibeverse (checkpoint)" },
    { sha: "666ad323", iso: "2026-09-02T05:20:44+00:00", subject: "BETTER FORTNITE: eat the augment digit in fixed(), harness filter, card art" },
  ],
  "strange-new-worlds": [
    { sha: "b919650d", iso: "2026-08-08T21:04:25+00:00", subject: "Changes" },
    { sha: "c396353b", iso: "2026-08-07T06:25:08+00:00", subject: "Air you can see through, and water on the worlds that have some" },
    { sha: "cd1d2ae3", iso: "2026-08-07T05:14:27+00:00", subject: "The Odyssey gets a hull, and the planets get an atmosphere" },
    { sha: "296027af", iso: "2026-08-07T04:56:34+00:00", subject: "People you can stand in front of, and columns that are not clip art" },
    { sha: "73405066", iso: "2026-08-07T04:36:31+00:00", subject: "A real renderer: HDR post, baked PBR surfacing, sky-probe IBL, ground scatter" },
    { sha: "99439c83", iso: "2026-08-07T01:20:45+00:00", subject: "🖖 Strange New Worlds — twelve real Star Trek systems, and everyone on them talks back" },
  ],
  "submit-world": [
    { sha: "1a0094c6", iso: "2026-06-15T22:23:49+00:00", subject: "Changes" },
  ],
  "terminal": [
    { sha: "e7f01015", iso: "2026-08-17T15:57:50+00:00", subject: "Changes" },
    { sha: "d6c34722", iso: "2026-08-05T22:37:49+00:00", subject: "Changes" },
    { sha: "3503cdaa", iso: "2026-08-02T14:17:10+00:00", subject: "One way home, in the same corner of every world" },
    { sha: "bed57ee9", iso: "2026-08-01T19:54:56+00:00", subject: "Fix the Terminal on phones, and say what this project actually is" },
    { sha: "0e6a9ed1", iso: "2026-07-29T16:47:45+00:00", subject: "Terminal: real card art, a bluer sky, and an island that reads as an island" },
    { sha: "9ba14608", iso: "2026-07-29T05:13:04+00:00", subject: "THE TERMINAL — the Vibeverse's front door, at /terminal" },
  ],
  "thalassa": [
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
    { sha: "f6742350", iso: "2026-10-10T19:58:27+00:00", subject: "Thalassa: a Greek harbour town you can walk, swim and visit in VR" },
  ],
  "times": [
    { sha: "67f2af31", iso: "2026-08-18T22:20:23+00:00", subject: "🖨 The paper survives Ctrl-P" },
    { sha: "99e4d5bf", iso: "2026-08-18T22:03:15+00:00", subject: "🗂 Small ads, bylines, and a spike by the door" },
    { sha: "68719881", iso: "2026-08-18T21:35:37+00:00", subject: "🗞 The Newsroom, and a paper that can be subscribed to" },
    { sha: "caccb2a5", iso: "2026-08-17T06:56:21+00:00", subject: "✉️ The paper takes letters, and Vibey finally reads it out loud" },
    { sha: "7318d507", iso: "2026-08-08T20:01:49+00:00", subject: "🕕 Every edition says what time it came off the presses" },
    { sha: "480cd7dc", iso: "2026-08-08T05:26:39+00:00", subject: "📰 The Vibe Times prints itself every morning, with a wire desk" },
  ],
  "trek": [
    { sha: "50900813", iso: "2026-08-18T22:28:17+00:00", subject: "Every world now hands its WebGL context back" },
    { sha: "3503cdaa", iso: "2026-08-02T14:17:10+00:00", subject: "One way home, in the same corner of every world" },
    { sha: "d3d3f485", iso: "2026-08-02T10:17:20+00:00", subject: "A silicon lifeform does not have deflector screens" },
    { sha: "ceafd63f", iso: "2026-08-02T10:13:31+00:00", subject: "Let go of the trigger between episodes" },
    { sha: "2eed69db", iso: "2026-08-02T10:07:34+00:00", subject: "The bridge talks to itself on a quiet watch" },
    { sha: "fb4e2dc9", iso: "2026-08-02T10:01:00+00:00", subject: "Two ways to end Balance of Terror, and one fewer way to lose unfairly" },
  ],
  "venus": [
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
    { sha: "7c896d5a", iso: "2026-09-30T21:07:35+00:00", subject: "Venus Rising: drop the dedication line from the title" },
    { sha: "1c696c6e", iso: "2026-09-30T20:47:17+00:00", subject: "Venus Rising: a darker scrim behind the title on phones" },
    { sha: "badf8d38", iso: "2026-09-30T20:45:00+00:00", subject: "Venus Rising: softer lanterns at night, lighter keel" },
    { sha: "99192bb2", iso: "2026-09-30T20:42:17+00:00", subject: "Venus Rising: night is a moment, not a stall" },
    { sha: "311cf459", iso: "2026-09-30T20:25:55+00:00", subject: "Venus Rising: a palace for the Habsburg season, four moods of light" },
  ],
  "vibestar": [
    { sha: "09531b8e", iso: "2026-11-25T20:07:55+00:00", subject: "Add body stickers on Vibe Island, visible to other players" },
    { sha: "a2573c5a", iso: "2026-11-25T19:28:36+00:00", subject: "Vibe Island character button opens the picture grid of all characters" },
    { sha: "6479738c", iso: "2026-11-25T19:15:35+00:00", subject: "Add rideable sky mounts, aerial tag, and fix multiplayer identities" },
    { sha: "1286e73b", iso: "2026-11-25T18:20:32+00:00", subject: "Add Pegasus flying over Vibe Island; fix typecheck errors" },
    { sha: "2c812ab4", iso: "2026-11-25T18:18:18+00:00", subject: "Updated session expiry and auth" },
    { sha: "2a5b64e4", iso: "2026-10-01T16:56:25-07:00", subject: "App Store edition: report/block, terms gate, iOS-only world list, account deletion" },
  ],
  "vibeverse": [
    { sha: "fc206f2a", iso: "2026-09-30T20:54:00+00:00", subject: "Vibeverse: Venus reads as a pearl from orbit; number keys go to 6" },
    { sha: "d9f2363b", iso: "2026-09-30T20:01:15+00:00", subject: "Venus Rising: walk the deck, neighbours on the wind, and a gauntlet of fixes" },
    { sha: "cae1ead5", iso: "2026-09-09T12:01:53+00:00", subject: "Beck Road: the five elements merged, card art, passport cap" },
    { sha: "da791439", iso: "2026-09-03T19:20:24+00:00", subject: "Card art, stamped dates and a wider passport panel for the four new worlds" },
    { sha: "207af005", iso: "2026-08-18T22:36:55+00:00", subject: "Passport rows to forty-two, and stop raising it one world at a time" },
    { sha: "a86765f9", iso: "2026-08-18T22:28:16+00:00", subject: "First Light — a lake at dawn, and one quality ladder for everybody" },
  ],
  "village": [
    { sha: "fbba2b4f", iso: "2026-06-12T04:25:29+00:00", subject: "Nav and flow reorganization: hero chips, full gallery, island spawn" },
    { sha: "fbc3fe02", iso: "2026-06-12T00:01:16+00:00", subject: "World picker: choose your world after the splash" },
    { sha: "7e79b7ac", iso: "2026-05-21T20:24:01+00:00", subject: "Changes" },
    { sha: "e2e95682", iso: "2026-05-18T03:22:24+00:00", subject: "Changes" },
    { sha: "e24af186", iso: "2026-05-14T04:26:51+00:00", subject: "Changes" },
    { sha: "2cffbb45", iso: "2026-05-14T01:31:28+00:00", subject: "Changes" },
  ],
  "world-builder": [
    { sha: "e2a757a5", iso: "2026-06-16T22:42:01+00:00", subject: "Changes" },
    { sha: "1979a512", iso: "2026-06-16T22:41:55+00:00", subject: "Changes" },
    { sha: "b3379195", iso: "2026-06-16T22:41:50+00:00", subject: "Changes" },
    { sha: "7fd383f2", iso: "2026-06-16T22:41:39+00:00", subject: "Changes" },
    { sha: "029cfdb9", iso: "2026-06-16T22:41:15+00:00", subject: "Changes" },
    { sha: "42134685", iso: "2026-06-16T22:41:06+00:00", subject: "Changes" },
  ],
};
