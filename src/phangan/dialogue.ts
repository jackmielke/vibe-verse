/**
 * Flow Phangan: everything anybody says.
 *
 * April 18 to May 18, 2025. A month-long villa on the west side of Koh Phangan
 * that Jack co-hosted with Atin for AI nerds and remote builders: five in the
 * house, eighty-odd within a ten-minute scooter ride, a hundred in the
 * Telegram. Muay Thai at 8:30 whether you are ready or not, coworking by the
 * pool, pad thai delivered for three dollars, and a weekly meetup that had to
 * move to secret locations once the authorities started shutting down events,
 * even the free ones.
 *
 * The voice is first person, specific, and warm. Real people are first names
 * only, and nothing here is anybody's private business.
 */

export interface GuestDef {
  name: string;
  colour: string;
  /** Told on the back of the scooter, one bubble at a time. */
  story: string[];
  /** Said at the meetup when they get off. The punchline. */
  arrival: string;
  /** Said when they get off early, story unfinished. */
  early: string;
  /** Said when you press E next to them. */
  hop: string;
}

export const GUEST_POOL: GuestDef[] = [
  {
    name: "Atin",
    colour: "#ffd27f",
    hop: "Jack! Perfect. I have a question for the whole island and it starts with you.",
    story: [
      "Last night in the living room I asked everyone whether a superintelligence would enjoy Koh Phangan.",
      "Half the room said it would optimise the sunsets away. The other half went to get pad thai.",
      "I think it would rent a scooter. Five dollars a day. Even a god likes a deal.",
    ],
    arrival: "Anyway. Would it come to the meetup? That is the real question tonight.",
    early: "I have more on this. I will find you at the bar. Bring the other half of the room.",
  },
  {
    name: "Josh",
    colour: "#8fd3ff",
    hop: "Is this the secret scooter? Good. I am not getting in a songthaew with a slideshow.",
    story: [
      "I ran three workshops here and by the third one we were doing them at a secret location.",
      "The police started shutting down events. Free ones! A free workshop about prompts!",
      "So now I text people a pin twenty minutes before. Feels like a rave. It is a slideshow.",
    ],
    arrival: "Do not drive past the checkpoint with me on the back. I am a known slideshow guy.",
    early: "Okay, dropping me early, very secret, I respect it.",
  },
  {
    name: "Eddy",
    colour: "#c8ff8f",
    hop: "Oh nice, a lift. My bot said you would be here. It is right about one thing a day.",
    story: [
      "I came here for one week of yoga. That was six weeks ago.",
      "Between classes I built a Telegram bot that tells me which beach has the fewest people.",
      "It has one user. Me. The retention is incredible.",
    ],
    arrival: "It says Haad Salad is empty right now. I am going with it. After this.",
    early: "Fine, the bot says here is good. The bot says everywhere is good.",
  },
  {
    name: "Mariella",
    colour: "#f7a1c4",
    hop: "Hi! Can you go slow past the hammock? My investors think I live there.",
    story: [
      "I moved here on the DTV visa. Five years, remote work, and nobody asks what my company does.",
      "My company does not do anything yet. My company is a Notion page and a feeling.",
      "But I take calls from a hammock and the investors think it is a branding choice.",
    ],
    arrival: "Is that the ocean? Put me down near the ocean. For the branding.",
    early: "Here is fine. I can pitch from anywhere. It is mostly the feeling.",
  },
  {
    name: "Noah",
    colour: "#7fe0d0",
    hop: "Careful with my ribs. Muay Thai this morning. Ready or not, and it was not.",
    story: [
      "Muay Thai at 8:30, every morning, whether you are ready or not.",
      "I was not ready. I have never been ready. The trainer calls me Farang Number Two.",
      "Number One is a Swedish guy who cries during the clinch and keeps coming back.",
    ],
    arrival: "I have never been this fit. I have also never been this bruised. Correlated.",
    early: "Thanks. I will walk the rest. The trainer says walking is also training.",
  },
  {
    name: "Brennan",
    colour: "#c9a6ff",
    hop: "Hey. Before we go: there is a dog asleep in the road up ahead and he does not care about you.",
    story: [
      "I have been on this island nine days and I have seen the same dog in four places, asleep in all of them.",
      "I think he is the mayor. I think we should ask him about the permit situation.",
      "He has never once moved for a scooter. That is leadership.",
    ],
    arrival: "Slow down, we are here. Do not wake the mayor.",
    early: "This is good. The mayor is probably around here somewhere.",
  },
  {
    name: "Priya",
    colour: "#ffb35c",
    hop: "You are the seventh vehicle of my day. Do not take it personally.",
    story: [
      "I flew Bangalore, Bangkok, Samui, then the ferry, then a songthaew, then your scooter.",
      "Seven hops to sit by a pool and ship code. My mother thinks I have joined a cult.",
      "She is not entirely wrong. We say now build a lot.",
    ],
    arrival: "Tell Jack the villa Wi-Fi is faster than my office. I have measured it. Twice.",
    early: "Sure, here. Eighth hop. The cult can come to me.",
  },
  {
    name: "Lars",
    colour: "#9ad0ff",
    hop: "No talking for the first minute please. I am still integrating from Sunday.",
    story: [
      "I went to ecstatic dance on Sunday to be ironic and I have been back four times since.",
      "There is no talking allowed and it is the best meeting I have had all month.",
      "I closed a deal in the car park afterwards. No words. Just eye contact and a Stripe link.",
    ],
    arrival: "Nobody at the meetup is allowed to talk to me for ten minutes. I am integrating.",
    early: "Here works. Silence is silence anywhere.",
  },
  {
    name: "Tomasz",
    colour: "#ff8f8f",
    hop: "Watch the north road. I have history there. Monkey history.",
    story: [
      "A monkey took my pad thai on the north road. Reached down from a branch, very calm, very professional.",
      "I respected it. He knew what he wanted and he had a plan. More than most founders.",
      "I ordered another one. Three dollars. The monkey does not get a second one.",
    ],
    arrival: "If there is a monkey at the meetup, he is not with me.",
    early: "Fine. But if a monkey shows up, I was never here.",
  },
  {
    name: "Ines",
    colour: "#ffe680",
    hop: "Can we stop at a 7-Eleven? I am joking. I am not joking.",
    story: [
      "Every 7-Eleven on this island is a temple and the toastie is the sacrament.",
      "I have coworked from four of them. The air con is free and the Wi-Fi asks no questions.",
      "The villa pool is nicer. But the 7-Eleven has never once asked me to join a group discussion.",
    ],
    arrival: "Right. Okay. I will join the discussion. But I brought a toastie.",
    early: "There is a 7-Eleven near here. There is a 7-Eleven near everywhere. Go.",
  },
  {
    name: "Kenji",
    colour: "#b8f5a0",
    hop: "One second, my agent is booking something. It is always booking something.",
    story: [
      "The ferry from Samui is thirty minutes and I wrote an entire agent on it.",
      "Then I realised I had written it to book ferries. From the ferry. Very recursive.",
      "It has now booked me the ferry home three times. I keep cancelling. I am not leaving.",
    ],
    arrival: "This is the meetup? Good. Somebody hold my laptop while I look at the sea.",
    early: "Here is fine. My agent will find me. It always finds me. That is the problem.",
  },
];

export type PlaceKey = "haad-salad" | "thong-sala" | "waterfall" | "villa" | "chaloklum";

export interface PlaceDef {
  key: PlaceKey;
  name: string;
  /** How the pin describes it, in the message everybody got twenty minutes ago. */
  pin: string;
  /** What you see when you arrive. */
  arrive: string;
}

export const SECRET_PLACES: PlaceDef[] = [
  {
    key: "haad-salad",
    name: "a beach bar at Haad Salad",
    pin: "Tonight: the beach bar at Haad Salad. Tell nobody. Tell everybody, quietly.",
    arrive: "Haad Salad. Bar on the sand, fairy lights, somebody already arguing about agents.",
  },
  {
    key: "thong-sala",
    name: "a rooftop in Thong Sala",
    pin: "Tonight: a rooftop in Thong Sala, above the pharmacy. Knock twice. Do not park out front.",
    arrive: "The rooftop. Above the pharmacy. Eleven laptops and a view of the pier.",
  },
  {
    key: "waterfall",
    name: "the waterfall",
    pin: "Tonight: the waterfall, up the summit road. Bring a torch, the path is more of a rumour.",
    arrive: "The waterfall. Somebody brought a speaker. Somebody brought a whiteboard.",
  },
  {
    key: "villa",
    name: "the villa",
    pin: "Tonight: the villa. Long pool, jungle, ocean, no permit required.",
    arrive: "The villa. Forty-five feet of pool and the whole island underneath it.",
  },
  {
    key: "chaloklum",
    name: "the pier at Chaloklum",
    pin: "Tonight: the pier at Chaloklum. Longtails, squid lamps, and no police for twelve kilometres.",
    arrive: "Chaloklum pier. Squid boats, green lamps, the sea doing nothing at all.",
  },
];

export const NARRATION = {
  open: "4pm. Weekly meetup tonight, secret location, guests all over the island. Rain is somewhere out east. Muay Thai is at 8:30 whether you are ready or not.",
  padThai: "Pad thai. Three dollars. Energy restored, life restored.",
  padThaiFull: "You are full. The pad thai guy waves. Come back later.",
  monkeys: "Monkeys on the road. Slow down or they will take something.",
  swerve: "You swerved. A monkey has your sunglasses now.",
  dog: "A dog asleep in the road. He is not moving. Go around.",
  dogBump: "You clipped the sleeping dog. He opened one eye. Go around next time.",
  checkpoint: "Checkpoint. They are asking where the party is. It is a secret. That cost you a minute.",
  checkpointWarn: "Police checkpoint ahead. Do not lead a convoy past it. Take the long way with a guest on the back.",
  rainWall: "That dark wall out east is the rain. It arrives fast here.",
  rain: "The rain is here. The road is a slip and slide now.",
  sunset: "The sun is going into the sea. Everybody stops for this. Even the scooters.",
  dark: "Dark. Headlight on. The dogs are still asleep.",
  bell: "8:30. Muay Thai. Ready or not.",
  tired: "Energy gone. The scooter is fine, you are not. Find pad thai.",
  boost: "Full throttle up the hill. Your legs have opinions.",
  offRoad: "Gravel. The back wheel has ideas of its own.",
  outro: "We are in paradise, now build.",
};

export const MUAY_THAI_MOVES = ["jab", "cross", "hook", "elbow", "knee", "teep", "low kick", "clinch", "uppercut", "high kick"];

export function readyLine(score: number): string {
  if (score >= 9) return "Ready. The trainer nodded. He has never nodded.";
  if (score >= 7) return "Ready enough. Farang Number Three, promoted.";
  if (score >= 4) return "Not ready. Farang Number Two. Same time tomorrow.";
  return "Not ready. The Swedish guy stopped crying to watch you.";
}

export function deliveredLine(delivered: number, total: number): string {
  if (delivered >= total) return "Everybody made it. Village beats a single big house, every time.";
  if (delivered >= total - 1) return "One short. They will find it. The pin is in the Telegram.";
  if (delivered >= total / 2) return "Half the island made it. The other half is at a 7-Eleven, happy.";
  if (delivered > 0) return "A quiet meetup. Deep connection from day one, with fewer people.";
  return "Nobody. The bar was lovely though, and the rain was warm.";
}
