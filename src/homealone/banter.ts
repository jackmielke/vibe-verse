/**
 * Everything anybody says.
 *
 * Harry and Marv talk *constantly* in the film, and that is most of why two
 * men breaking into a house is funny rather than frightening. A silent burglar
 * is a horror-game monster; one who yells "you little jerk" from the bottom of
 * the stairs is a cartoon you are winning against, and the difference is
 * entirely in this file.
 *
 * Lines are picked by situation and spoken with a cooldown, so they punctuate
 * rather than chatter. Each character keeps its own bag and shuffles rather
 * than rolling, which is the difference between "he says something new every
 * time" and "he said that four times in a row".
 */

export type Who = "harry" | "marv" | "kevin" | "marley";

export type Beat =
  | "enter"        // coming through a door
  | "prowl"        // wandering, nobody in sight
  | "spot"         // just saw you
  | "chase"        // still after you
  | "lost"         // lost you again
  | "trap"         // just took one in the face
  | "hurt"         // getting up, second time
  | "flee"         // done, going home
  | "taunt"        // Kevin shouting at them
  | "gotcha";      // he has you

const LINES: Record<Who, Partial<Record<Beat, string[]>>> = {
  harry: {
    enter: ["Silent night… holy night…", "It's a kid. How much trouble can a kid be.", "Nobody home. I told ya."],
    prowl: ["Kid? Come out, come out.", "Marv! Will you keep it down!", "This place is full of good stuff.", "I know you're in here."],
    spot: ["There you are.", "Come here, you little—", "Got you now, kid."],
    chase: ["You can't hide forever!", "Get back here!", "Marv! He's over here!"],
    lost: ["Where'd he go…", "Marv, did you see him?", "He's around here somewhere."],
    trap: ["ARGH!", "You little jerk!", "That's it. That's IT."],
    hurt: ["I'm gonna get that kid.", "This is not worth it.", "Marv, I'm bleedin'."],
    flee: ["Forget it! FORGET IT!", "I'm going to the van.", "That house is cursed."],
    gotcha: ["Gotcha.", "End of the line, kid."],
  },
  marv: {
    enter: ["Harry, I'm scared.", "Let's leave the water running. The Wet Bandits!", "It's cold out here."],
    prowl: ["Nice house.", "Harry? Harry, where'd you go?", "Kid? We just wanna talk to ya.", "Ooh, a Christmas tree."],
    spot: ["HARRY! I found him!", "Hey! Hey, kid!", "There he is!"],
    chase: ["Come here!", "You're not getting away!", "Harry! HARRY!"],
    lost: ["He was right here…", "Harry, I lost him.", "Kid? Little buddy?"],
    trap: ["AAAAAH!", "My face! MY FACE!", "OW! OW OW OW!"],
    hurt: ["Harry, I don't feel so good.", "That really hurt.", "I want to go home."],
    flee: ["Harry, I'm out! I'm OUT!", "Nope. Nope nope nope.", "Merry Christmas! Bye!"],
    gotcha: ["Got him! HARRY, I GOT HIM!", "Hiya, kid."],
  },
  kevin: {
    taunt: [
      "Hey! I'm up here, you big horse's ass! Come and get me!",
      "You guys give up, or are you thirsty for more?",
      "Down here, ya filthy animals!",
      "Come on! I'm right here!",
      "Hey! Over here!",
    ],
    trap: ["Yes!", "That's what I'm talking about.", "This is my house. I have to defend it.", "Merry Christmas."],
    spot: ["Uh oh.", "Okay. Okay okay okay.", "Don't panic. DON'T PANIC."],
    enter: ["They're in.", "It's showtime.", "This is it. Nine o'clock."],
  },
  marley: {
    prowl: ["Evening.", "Cold one tonight.", "You be careful out here."],
    trap: ["I think you've had enough.", "That's about enough of that."],
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
    // Deterministic-ish shuffle: no seeded RNG needed, and a repeat across a
    // reload is not something anybody will notice.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    bags.set(key, bag);
  }
  return bag.pop() ?? null;
}

/** Forget every bag. Called when a level restarts so it does not open mid-set. */
export function resetBanter() {
  bags.clear();
}
