/**
 * When each world was born — GENERATED, do not edit by hand.
 *
 * Regenerate with `npm run chronicle`. `born` is the committer date of the
 * first commit that ever touched the world's `source` paths; `commits` and
 * `hands` are the work and the people since.
 *
 * Committed rather than fetched, for the reason every generated file here is:
 * the browser has no git, and `/chronicle` must keep working when there is no
 * network and no server left to ask. See `scripts/chronicle.mjs`.
 */

export interface WorldLife {
  /** ISO date of the first commit at this world's current address. */
  born: string;
  /** Commits touching it, ever. */
  commits: number;
  /** Distinct authors who have touched it. */
  hands: number;
}

/** The repository itself, for the page's opening line. */
export const REPO_LIFE = {
  "born": "2026-04-14T01:06:26+00:00",
  "firstWords": "Work in progress",
  "commits": 1759,
  "hands": 5
} as const;

export const WORLD_LIFE: Record<string, WorldLife> = {
  "2048": {"born":"2026-08-10T23:18:12+00:00","commits":1,"hands":1},
  "about": {"born":"2026-05-08T23:21:56-07:00","commits":2,"hands":1},
  "agent-lobby": {"born":"2026-06-18T03:33:59+00:00","commits":4,"hands":2},
  "airplane": {"born":"2026-08-02T07:13:32+00:00","commits":1,"hands":1},
  "arcade": {"born":"2026-08-06T06:19:50+00:00","commits":6,"hands":1},
  "blob": {"born":"2026-08-08T05:45:14+00:00","commits":2,"hands":1},
  "blob-battle": {"born":"2026-08-09T07:49:03+00:00","commits":2,"hands":1},
  "blue-angels": {"born":"2026-08-02T02:33:05+00:00","commits":8,"hands":1},
  "characters": {"born":"2026-07-01T12:12:14-07:00","commits":3,"hands":2},
  "chronicle": {"born":"2026-08-14T06:58:33+00:00","commits":1,"hands":1},
  "city": {"born":"2026-06-11T07:44:57+00:00","commits":603,"hands":3},
  "coil": {"born":"2026-08-11T00:01:59+00:00","commits":2,"hands":1},
  "coin": {"born":"2026-05-11T11:40:19-07:00","commits":26,"hands":3},
  "companions": {"born":"2026-07-12T12:49:55+00:00","commits":2,"hands":1},
  "drop-zero": {"born":"2026-08-01T17:13:00+00:00","commits":35,"hands":2},
  "edm-town": {"born":"2026-06-17T20:19:43+00:00","commits":2,"hands":2},
  "evolve": {"born":"2026-06-12T00:17:23+00:00","commits":2,"hands":2},
  "fnaf": {"born":"2026-08-01T18:50:32+00:00","commits":12,"hands":1},
  "garden": {"born":"2026-05-10T00:13:12-07:00","commits":18,"hands":3},
  "globetrotter": {"born":"2026-07-27T04:50:37+00:00","commits":1,"hands":1},
  "go": {"born":"2026-07-04T18:30:13+00:00","commits":2,"hands":1},
  "golf": {"born":"2026-07-30T16:15:42+00:00","commits":8,"hands":1},
  "home-alone": {"born":"2026-08-02T09:14:33+00:00","commits":6,"hands":1},
  "i-spy": {"born":"2026-08-02T05:02:07+00:00","commits":10,"hands":2},
  "island": {"born":"2026-06-11T17:38:17+00:00","commits":294,"hands":3},
  "island-2": {"born":"2026-07-29T03:41:33+00:00","commits":2,"hands":1},
  "island-explorer": {"born":"2026-06-19T23:49:52+00:00","commits":12,"hands":3},
  "kart": {"born":"2026-07-31T16:45:51+00:00","commits":14,"hands":2},
  "lobby": {"born":"2026-05-08T22:05:23-07:00","commits":24,"hands":3},
  "manifesto": {"born":"2026-08-10T02:02:03+00:00","commits":1,"hands":1},
  "moon": {"born":"2026-06-11T17:38:17+00:00","commits":294,"hands":3},
  "museum": {"born":"2026-05-14T02:40:59+00:00","commits":9,"hands":1},
  "ninja": {"born":"2026-06-12T02:00:05+00:00","commits":2,"hands":1},
  "orbit": {"born":"2026-08-07T06:58:26+00:00","commits":1,"hands":1},
  "passport": {"born":"2026-08-10T03:06:30+00:00","commits":2,"hands":1},
  "portal": {"born":"2026-08-09T07:49:03+00:00","commits":3,"hands":1},
  "run": {"born":"2026-08-02T07:24:16+00:00","commits":1,"hands":1},
  "san-palmas": {"born":"2026-07-28T05:38:54+00:00","commits":10,"hands":1},
  "seafair": {"born":"2026-07-31T14:56:54+00:00","commits":5,"hands":1},
  "sf": {"born":"2026-07-28T05:56:20+00:00","commits":13,"hands":2},
  "shop": {"born":"2026-08-07T04:14:36+00:00","commits":4,"hands":1},
  "ski": {"born":"2026-06-11T17:38:17+00:00","commits":294,"hands":3},
  "space": {"born":"2026-05-07T20:25:53-07:00","commits":67,"hands":2},
  "splash-royale": {"born":"2026-08-01T17:13:00+00:00","commits":35,"hands":2},
  "strange-new-worlds": {"born":"2026-08-07T01:20:45+00:00","commits":6,"hands":2},
  "submit-world": {"born":"2026-06-15T22:23:49+00:00","commits":1,"hands":1},
  "terminal": {"born":"2026-07-29T05:13:04+00:00","commits":5,"hands":2},
  "times": {"born":"2026-07-18T02:43:29+00:00","commits":4,"hands":1},
  "trek": {"born":"2026-08-02T06:42:46+00:00","commits":7,"hands":1},
  "vibestar": {"born":"2026-06-11T17:38:17+00:00","commits":294,"hands":3},
  "vibeverse": {"born":"2026-07-31T17:39:03+00:00","commits":27,"hands":1},
  "village": {"born":"2026-04-14T01:10:35+00:00","commits":106,"hands":4},
  "world-builder": {"born":"2026-06-16T22:01:52+00:00","commits":28,"hands":1},
};
