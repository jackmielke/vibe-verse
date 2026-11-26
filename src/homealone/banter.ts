/**
 * Everything anybody says.
 *
 * The intruders talk constantly, and that is most of why people breaking into
 * a house is funny rather than frightening. A silent intruder is a horror-game
 * monster; one who complains about his knees from the bottom of the stairs is
 * a cartoon you are winning against, and the difference is entirely in this
 * file.
 *
 * Lines are picked by situation and spoken with a cooldown, so they punctuate
 * rather than chatter. Each voice keeps its own bag and shuffles rather than
 * rolling, which is the difference between "he says something new every time"
 * and "he said that four times in a row".
 *
 * There are two adult voices, one per body: the stocky ones talk like `gus`
 * and the tall ones like `lenny`. Five intruders with five scripts would be
 * five times the writing for a difference nobody hears in a shouting match.
 */

export type Who = "gus" | "lenny" | "kid";

export type Beat =
  | "enter"        // coming through a door
  | "prowl"        // wandering, nobody in sight
  | "spot"         // just saw you
  | "chase"        // still after you
  | "lost"         // lost you again
  | "trap"         // just took one in the face
  | "hurt"         // getting up, second time
  | "flee"         // done, going home
  | "grab"         // filling his bag
  | "disarm"       // found one of your traps
  | "taunt"        // the kid shouting at them
  | "chain"        // the kid, watching one thing lead to another
  | "gotcha";      // he has you

const LINES: Record<Who, Partial<Record<Beat, string[]>>> = {
  gus: {
    enter: ["In and out. Ten minutes.", "Nobody's home. I checked twice.", "Wipe your feet. We're professionals."],
    prowl: ["Something's off about this place.", "Keep it down, will you.", "Good stuff in here. Old money.", "I can hear you breathing, kid."],
    spot: ["There!", "Hold it right there!", "Oh, you're in for it now."],
    chase: ["You can't run forever!", "Get back here!", "Somebody cut him off!"],
    lost: ["Where'd he go…", "He was right here.", "Check behind the couch."],
    trap: ["GAAH!", "Who PUTS that there!", "My back. My actual back."],
    hurt: ["I'm too old for this.", "That one I felt in my teeth.", "This was meant to be easy."],
    flee: ["Forget it! FORGET IT!", "I'm going to the van.", "This house has a problem with me."],
    grab: ["Come to papa.", "This'll do nicely.", "Bag it."],
    disarm: ["Well, well. What's this.", "Not today, kid."],
    gotcha: ["Gotcha.", "End of the line."],
  },
  lenny: {
    enter: ["I don't like this.", "It's very dark in here.", "Did you hear that? I heard that."],
    prowl: ["Nice house.", "Hello? Anybody?", "We only want to talk.", "Ooh, a tree."],
    spot: ["FOUND HIM!", "Hey! Hey, you!", "There he is!"],
    chase: ["Come here!", "Stop running, it's rude!", "Wait up!"],
    lost: ["He was right here…", "I lost him.", "Little buddy?"],
    trap: ["AAAAAH!", "NOT AGAIN!", "OW! OW OW OW!"],
    hurt: ["I don't feel so good.", "That really hurt.", "I want to go home."],
    flee: ["I'm out! I'M OUT!", "Nope. Nope nope nope.", "Happy holidays! Bye!"],
    grab: ["Ooh. Shiny.", "Mine now.", "Don't mind if I do."],
    disarm: ["Somebody's been busy.", "Careful… careful… got it."],
    gotcha: ["Got him! I GOT HIM!", "Hiya."],
  },
  kid: {
    taunt: [
      "Hey! Up here, you big lump!",
      "Had enough yet?",
      "Yoo-hoo! Over here!",
      "Come on! I'm right here!",
      "You call that sneaking?",
    ],
    trap: ["Yes!", "That's what I'm talking about.", "House rules.", "Mind the step."],
    chain: ["Did you SEE that?", "Oh, that was beautiful.", "And another one!", "I planned that. I definitely planned that."],
    spot: ["Uh oh.", "Okay. Okay okay okay.", "Don't panic. DON'T PANIC."],
    enter: ["They're in.", "Showtime.", "Here we go."],
  },
};

/** One shuffled bag per (who, beat), so nothing repeats until it has to. */
const bags = new Map<string, string[]>();

export function line(who: Who, beat: Beat): string | null {
  const pool = LINES[who]?.[beat];
  if (!pool?.length) return null;
  const key = `${who}:${beat}`;
  let bag = bags.get(key);
  if (!bag || !bag.length) {
    bag = [...pool];
    // No seeded RNG needed: a repeat across a reload is not something anybody
    // will notice.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    bags.set(key, bag);
  }
  return bag.pop() ?? null;
}

/** Forget every bag. Called when a night restarts so it does not open mid-set. */
export function resetBanter() {
  bags.clear();
}
