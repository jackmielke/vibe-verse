/**
 * Agentocracy: the map.
 *
 * A cardboard Bainbridge Island at kid scale, on blue paper. Everything here
 * is a number, so the engine and the tests read the same island. Units are
 * metres in the world; the island is about 140 wide and 170 tall, with
 * Eagle Harbor cut into the east side and a cardboard Seattle across the
 * sound.
 *
 * No three import in this file, on purpose.
 */

export interface District {
  key: string;
  name: string;
  x: number;
  z: number;
  /** How far the district's residents wander from its centre. */
  r: number;
  /** Chalk line from the plaza? Every district except the plaza itself. */
  chalk: boolean;
}

/** The plaza is at Winslow, because that is where the ferry is. */
export const PLAZA = { x: 0, z: 0 };

export const DISTRICTS: District[] = [
  { key: "plaza", name: "Winslow Plaza", x: 0, z: 0, r: 9, chalk: false },
  { key: "dock", name: "Ferry Dock", x: 14, z: 3, r: 4, chalk: true },
  { key: "debate", name: "Debate Corner", x: -12, z: 12, r: 4, chalk: true },
  { key: "snack", name: "Snack Bay", x: 14, z: -24, r: 6, chalk: true },
  { key: "freesnack", name: "Free Snack Stand", x: 14, z: -36, r: 4, chalk: false },
  { key: "school", name: "Bainbridge High", x: -34, z: 30, r: 9, chalk: true },
  { key: "church", name: "The Church", x: -30, z: -26, r: 6, chalk: true },
  { key: "slide", name: "Water Slide", x: -50, z: 4, r: 6, chalk: true },
  { key: "field", name: "Sports Field", x: -8, z: 54, r: 10, chalk: true },
  { key: "craft", name: "Fashion & Craft", x: 26, z: 40, r: 7, chalk: true },
  { key: "tree", name: "Dream Tree", x: -46, z: -50, r: 7, chalk: true },
  { key: "ninja", name: "Ninja HQ", x: -58, z: 34, r: 6, chalk: true },
  { key: "jerry", name: "Jerry's Plaza", x: 30, z: -56, r: 6, chalk: true },
  { key: "zip", name: "Zip Line", x: 40, z: 26, r: 6, chalk: true },
  { key: "tower", name: "Salesforce Tower", x: 46, z: -34, r: 6, chalk: true },
  { key: "museum", name: "Pop-up Museum", x: -14, z: -48, r: 6, chalk: true },
];

export function district(key: string): District {
  const d = DISTRICTS.find((x) => x.key === key);
  if (!d) throw new Error(`no district ${key}`);
  return d;
}

/** The harbour: a notch in the island's east side, from the dock out to the sound. */
export const HARBOR = { x0: 16, x1: 90, halfWidth: 13 };

/** Where the ferry goes. Winslow to a cardboard Seattle, on a timetable. */
export const FERRY = {
  winslow: { x: 22, z: 0 },
  seattle: { x: 104, z: 0 },
  /** Seconds each way. It is thirty-five minutes in life. */
  crossing: 9,
  /** Seconds tied up at each end. */
  dwell: 2,
};

export const SEATTLE = { x: 122, z: 0 };

/** The island outline, counter-clockwise, as (x, z). An ellipse with the harbour cut in. */
export function islandOutline(): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  const rx = 72;
  const rz = 86;
  const mouth = Math.asin(HARBOR.halfWidth / rz);
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const t = mouth + (i / n) * (Math.PI * 2 - mouth * 2);
    pts.push({ x: Math.cos(t) * rx, z: Math.sin(t) * rz });
  }
  // Back in along the south shore of the harbour, round the head at the dock, out along the north.
  pts.push({ x: HARBOR.x0 + 2, z: -HARBOR.halfWidth });
  pts.push({ x: HARBOR.x0, z: -HARBOR.halfWidth * 0.6 });
  pts.push({ x: HARBOR.x0, z: HARBOR.halfWidth * 0.6 });
  pts.push({ x: HARBOR.x0 + 2, z: HARBOR.halfWidth });
  return pts;
}

/** Is this point on the cardboard, and not in the harbour? */
export function onIsland(x: number, z: number): boolean {
  if ((x / 72) ** 2 + (z / 86) ** 2 > 1) return false;
  if (x > HARBOR.x0 && Math.abs(z) < HARBOR.halfWidth) return false;
  return true;
}

export interface CowSpot {
  x: number;
  z: number;
  placard: string;
}

/**
 * Twenty invisible cows, each with a placard on a stick and no cow. The
 * museum's main exhibit. There is a contest to find them all.
 */
export const COW_SPOTS: CowSpot[] = [
  { x: -6, z: -10, placard: "COW 1 of 20: Marigold. She is right here. Look harder." },
  { x: 22, z: -18, placard: "COW 2: Buttercup. Prefers not to be perceived." },
  { x: -40, z: 18, placard: "COW 3: Steve. Invisible since Tuesday, by choice." },
  { x: -22, z: -36, placard: "COW 4: Clementine. If you can see her, tell the museum immediately." },
  { x: 10, z: 10, placard: "COW 5: The Ferry Cow. Commutes. Has never missed the boat by one car." },
  { x: -56, z: -20, placard: "COW 6: Pearl. Standing very still, which is why you cannot see her. That is not how it works. She believes it." },
  { x: 4, z: 68, placard: "COW 7: Bainbridge. Named after the island. The island was named first." },
  { x: 20, z: -46, placard: "COW 8: Dolores. Ate a token. Now technically a bank." },
  { x: -20, z: 46, placard: "COW 9: Moo. The kids named this one. The kids were right." },
  { x: 6, z: -4, placard: "COW 10: Winslow. Lives at the plaza. Attends every debate. Never votes." },
  { x: 52, z: -44, placard: "COW 11: Salesforce. Very tall. Invisible in every direction." },
  { x: -8, z: -58, placard: "COW 12: Greta. On loan from a museum that could not find her either." },
  { x: 30, z: 18, placard: "COW 13: Eagle Harbor. Has been to Seattle. Was not impressed." },
  { x: 12, z: -12, placard: "COW 14: Paddle. Named after the thing that scrapes the keel. Also invisible. Also works." },
  { x: 36, z: 50, placard: "COW 15: Contest cow. Find all twenty and you win a thing. Tell Mitra." },
  { x: -62, z: 8, placard: "COW 16: Norma. Placard slightly crooked. The cow is fine." },
  { x: -50, z: 44, placard: "COW 17: Ninja. The spiritual centre's spiritual cow." },
  { x: -26, z: 40, placard: "COW 18: Detour. Has been waiting behind the high school for three months." },
  { x: -4, z: 14, placard: "COW 19: Skipper's friend. Rolls alongside the cart. Neither of them minds." },
  { x: -34, z: -62, placard: "COW 20: Sam. Actually the cat. Not helping." },
];

/** Readable signs around the island: where they stand and what they say. */
export interface SignSpot {
  x: number;
  z: number;
  label: string;
  text: string;
}

export const SIGNS: SignSpot[] = [
  { x: -30, z: -20, label: "THE SHOE", text: "During a kicking contest, a shoe left a foot and landed on this roof. It is still there. The church has decided it is a feature." },
  { x: -26, z: 24, label: "DETOUR", text: "ROAD CLOSED AT THE HEAD OF THE BAY. All ferry traffic via the high school. Three months. Somebody missed the boat by one car. Somebody is still talking about it." },
  { x: 14, z: -20, label: "SNACK BAY", text: "Two tokens to start. Earn more through good deeds. Three tokens make one money. Bottle caps only. No, the free stand across the road is not affiliated." },
  { x: 14, z: -32, label: "FREE SNACKS", text: "FREE. Yes, free. No tokens. No good deeds. No business model. Please stop asking about the business model." },
  { x: -12, z: 16, label: "DEBATE CORNER", text: "Disputes are settled here. Fines for hitting: two tokens. A witness is required. The snail is not a witness." },
  { x: -50, z: 10, label: "SAFETY SYSTEM", text: "The water slide's safety system is a person with a whistle at the bottom. It is the best system we have. Do not go until the whistle." },
  { x: 13, z: -9, label: "THE SAILBOAT", text: "Lived on for twelve years. The keel is scraped with a stand-up-paddleboard paddle, because it works. The paddle is leaning right there. Do not move the paddle." },
  { x: -14, z: -44, label: "POP-UP MUSEUM", text: "Main exhibit: twenty invisible cows, each with a placard. Contest: find them all. Press E at a placard. The cows are real. The cows are invisible. Both are true." },
  { x: 30, z: -52, label: "JERRY'S PLAZA", text: "Jerry's Plaza, with a snail on top. The snail was an accident. The plaza was on purpose. Together they are the second-most-visited landmark after the shoe." },
  { x: -46, z: -44, label: "DREAM TREE", text: "For nourishment. Water it. Somebody water it. It has been since Tuesday." },
  { x: -58, z: 28, label: "NINJA HQ", text: "The spiritual centre of the village. No roof. Ninjas get wet. There is a proposal about this." },
  { x: 46, z: -28, label: "SALESFORCE TOWER", text: "Eleven boxes and one act of faith. Taller than the Dream Tree, the ferry and the mountain. There is a proposal about this too." },
  { x: 40, z: 22, label: "ZIP LINE", text: "One line. One rider. The queue is longer than the line. The waiting is character-building, according to a grandparent." },
  { x: 13, z: 8, label: "FERRY", text: "Winslow to Seattle, thirty-five minutes, every time the horn goes. The horn also opens a round of the Agentocracy. That was not planned. It works." },
];
