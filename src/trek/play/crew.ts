/**
 * The crew: who says what, when, and what stops them saying it.
 *
 * This is the system that makes the difference between a space shooter and
 * Star Trek, and it is almost all *restraint*. Three rules do the work:
 *
 * **One voice at a time.** A line holds the floor for its duration. Anything
 * that arrives while somebody is talking either waits, or — if it is
 * low-priority chatter — is thrown away. Two officers talking over each other
 * is the single fastest way to make a bridge crew sound like a slot machine.
 *
 * **Nothing repeats inside its own cooldown.** Shield reports have a floor of
 * six seconds. Without it, sustained fire produces "shields at forty-one
 * percent, shields at forty percent, shields at thirty-nine percent" and the
 * illusion is over for the rest of the session.
 *
 * **Every report is somebody's job.** Sensors are Spock, helm is Sulu,
 * weapons and navigation are Chekov, communications are Uhura, engines are
 * Scott. A line delivered by the wrong station is worse than no line, because
 * the audience knows this crew better than they know their colleagues.
 */
import type { CrewLine, Ship, System, TrekCtx } from "../types";
import { FACING_NAMES } from "../types";

type Bank = readonly { who: string; text: string }[];

const pick = <T,>(arr: readonly T[], last: T | null): T => {
  if (arr.length === 1) return arr[0];
  let choice = arr[Math.floor(Math.random() * arr.length)];
  let guard = 0;
  while (choice === last && guard++ < 4) choice = arr[Math.floor(Math.random() * arr.length)];
  return choice;
};

/** Every reactive bark in the game, filed by the event that triggers it. */
const BANKS: Record<string, Bank> = {
  shieldsUp: [
    { who: "CHEKOV", text: "Deflector shields up, Captain." },
    { who: "CHEKOV", text: "Shields at full strength, sir." },
    { who: "SULU", text: "Screens up and holding." },
  ],
  shieldsDown: [
    { who: "CHEKOV", text: "Shields down, sir." },
    { who: "SULU", text: "Lowering deflector screens." },
  ],
  redAlert: [
    { who: "SULU", text: "Red alert. All decks to battle stations." },
    { who: "CHEKOV", text: "Red alert, sir. Weapons crews standing by." },
  ],
  standDown: [
    { who: "SULU", text: "Securing from general quarters." },
    { who: "UHURA", text: "Stand down from alert, all decks acknowledge." },
  ],
  targetAcquired: [
    { who: "CHEKOV", text: "Target locked, Captain. Phasers and torpedoes ready." },
    { who: "CHEKOV", text: "Firing solution plotted, sir." },
    { who: "SULU", text: "Locked on. Standing by to fire." },
  ],
  noTarget: [
    { who: "SPOCK", text: "No hostile contacts within sensor range, Captain." },
    { who: "CHEKOV", text: "I have nothing to shoot at, sir." },
  ],
  phasersFired: [
    { who: "CHEKOV", text: "Phasers away." },
    { who: "SULU", text: "Firing phasers." },
  ],
  phasersDepleted: [
    { who: "SCOTT", text: "Phaser banks are drained, Captain. Give me a moment to recharge." },
    { who: "SCOTT", text: "There's no power left in the banks. I need thirty seconds." },
  ],
  torpedoAway: [
    { who: "CHEKOV", text: "Torpedo away." },
    { who: "SULU", text: "Photon torpedo running." },
  ],
  torpedoesEmpty: [
    { who: "CHEKOV", text: "Torpedo bays are empty, Captain." },
    { who: "SCOTT", text: "That was the last of the photons, sir." },
  ],
  enemyDestroyed: [
    { who: "SPOCK", text: "The target is destroyed, Captain. No survivors registering." },
    { who: "CHEKOV", text: "Direct hit! She's breaking up, sir!" },
    { who: "SULU", text: "Target destroyed, Captain." },
  ],
  allyLost: [
    { who: "UHURA", text: "Captain — I've lost their signal. They're gone." },
    { who: "SPOCK", text: "The vessel has been destroyed, Captain." },
  ],
  hullBreach: [
    { who: "SCOTT", text: "We've got a hull breach on the lower decks! Emergency force fields holding — barely." },
    { who: "SCOTT", text: "She's taking a beating, Captain. I can't hold her together much longer." },
    { who: "MCCOY", text: "Sickbay's filling up down here, Jim. Whatever you're doing, do it fast." },
  ],
  critical: [
    { who: "SPOCK", text: "Hull integrity is below fifteen percent, Captain. Structural failure is imminent." },
    { who: "SCOTT", text: "Another hit like that and we lose her, sir!" },
  ],
  evasive: [
    { who: "SULU", text: "Evasive manoeuvres, aye." },
    { who: "SULU", text: "Taking her out of their firing arc, sir." },
  ],
  cloakDetected: [
    { who: "SPOCK", text: "Fascinating. The vessel has vanished from our screens — some form of invisibility screen." },
    { who: "SPOCK", text: "Sensor contact lost, Captain. The cloaking device is engaged." },
    { who: "SPOCK", text: "She is still out there, Captain. Our sensors simply cannot see her." },
  ],
  decloaked: [
    { who: "SPOCK", text: "Captain — she is decloaking. Bearing off the starboard bow." },
    { who: "CHEKOV", text: "There she is, sir! Contact on the screen!" },
    { who: "SPOCK", text: "The vessel is materialising. She must drop her screen to fire." },
  ],
  hailNoAnswer: [
    { who: "UHURA", text: "No response on any frequency, Captain." },
    { who: "UHURA", text: "They're receiving us, sir. They're simply not answering." },
  ],
  nebulaBlind: [
    { who: "SPOCK", text: "Sensors are useless in here, Captain. We are, in effect, blind." },
    { who: "SPOCK", text: "Static discharge is fouling the scanners. We must fight by eye." },
    { who: "SULU", text: "Visibility down to nothing, sir. I'm flying on instinct." },
  ],
  systemLost: [
    { who: "SCOTT", text: "That did it — we've lost it, Captain. I'll get a crew on it." },
    { who: "SPOCK", text: "That system is offline, Captain." },
  ],
  warpEngaged: [
    { who: "SULU", text: "Warp factor six, sir. Course laid in." },
    { who: "SCOTT", text: "Warp drive engaged, Captain. She's answering beautifully." },
  ],
  powerEngines: [{ who: "SCOTT", text: "Diverting power to the engines, Captain." }],
  powerShields: [{ who: "SCOTT", text: "Rerouting to the deflector screens, sir." }],
  powerWeapons: [{ who: "SCOTT", text: "All available power to the weapons banks." }],
};

export interface CrewService {
  say(line: Partial<CrewLine> & { who: string; text: string }): void;
  bark(bank: string, opts?: { cooldown?: number; priority?: number }): void;
  /** True while somebody has the floor. */
  busy: boolean;
  clear(): void;
}

export function createCrew(ctx: TrekCtx): System {
  const queue: CrewLine[] = [];
  let speakingFor = 0;
  const lastOf = new Map<string, unknown>();
  const cooldowns = new Map<string, number>();

  /** Roughly how long a line takes to read out loud. */
  const durationOf = (text: string) => Math.min(9, 1.1 + text.length * 0.055);

  function emit(line: CrewLine): void {
    speakingFor = line.hold;
    ctx.emit("trek:line", line);
    ctx.services.audio?.cue(line.who === "COMPUTER" ? "computer" : "blip", { rate: 1.4 });
    ctx.services.audio?.speak(line);
  }

  const service: CrewService = {
    busy: false,
    say(line) {
      const full: CrewLine = {
        who: line.who,
        text: line.text,
        hold: line.hold ?? durationOf(line.text),
        priority: line.priority ?? 5,
      };
      // A high-priority line jumps the queue but never cuts off a line that is
      // already being spoken — see the header.
      const at = queue.findIndex((q) => q.priority < full.priority);
      if (at >= 0) queue.splice(at, 0, full);
      else queue.push(full);
      // Drop anything that has been waiting behind a wall of chatter.
      if (queue.length > 4) queue.length = 4;
    },
    bark(bank, opts) {
      const list = BANKS[bank];
      if (!list?.length) return;
      const now = ctx.elapsed;
      const until = cooldowns.get(bank) ?? -1;
      if (now < until) return;
      cooldowns.set(bank, now + (opts?.cooldown ?? 6));
      const chosen = pick(list, lastOf.get(bank) as { who: string; text: string } | null);
      lastOf.set(bank, chosen);
      service.say({ ...chosen, priority: opts?.priority ?? 5 });
    },
    clear() {
      queue.length = 0;
      speakingFor = 0;
    },
  };
  (ctx.services as Record<string, unknown>).crew = service;

  // -- Reactive barks --------------------------------------------------------

  const offs: (() => void)[] = [];
  const isPlayer = (s: Ship) => s === ctx.services.fleet?.player;

  // The shield report is generated rather than banked, because the number in
  // it is the point — and it is the single most Star Trek sentence there is,
  // so it gets a six-and-a-half second floor all to itself.
  let lastShieldReport = -99;
  offs.push(
    ctx.on("trek:shieldHit", (p: never) => {
      const { ship, facing } = p as unknown as { ship: Ship; facing: number };
      if (!isPlayer(ship)) return;
      if (ctx.elapsed - lastShieldReport < 6.5) return;
      const pct = Math.round(ship.shields[facing] * 100);
      if (pct > 85) return;
      lastShieldReport = ctx.elapsed;
      const name = FACING_NAMES[facing as 0 | 1 | 2 | 3];
      if (pct <= 6) {
        service.say({ who: "CHEKOV", text: `${cap(name)} shield is gone, Captain!`, priority: 8 });
      } else if (pct <= 30) {
        service.say({ who: "CHEKOV", text: `${cap(name)} shield down to ${pct} percent, sir!`, priority: 7 });
      } else {
        service.say({ who: "CHEKOV", text: `${cap(name)} shield holding at ${pct} percent.`, priority: 5 });
      }
    }),
  );

  let lastDamageReport = -99;
  offs.push(
    ctx.on("trek:systemDamage", (p: never) => {
      const { ship, system, level } = p as unknown as { ship: Ship; system: string; level: number };
      if (!isPlayer(ship) || level > 0.55) return;
      if (ctx.elapsed - lastDamageReport < 7) return;
      lastDamageReport = ctx.elapsed;
      const label: Record<string, string> = {
        warp: "the warp drive",
        impulse: "the impulse engines",
        phasers: "the phaser banks",
        torpedoes: "the torpedo tubes",
        sensors: "the main sensor array",
        shields: "the deflector generators",
        lifeSupport: "life support",
      };
      const what = label[system] ?? system;
      if (level < 0.2) {
        service.say({ who: "SCOTT", text: `We've lost ${what}, Captain. I'm on it.`, priority: 8 });
      } else {
        service.say({ who: "SPOCK", text: `Damage to ${what}, Captain. Efficiency down to ${Math.round(level * 100)} percent.`, priority: 6 });
      }
    }),
  );

  let lastHullReport = -99;
  offs.push(
    ctx.on("trek:hullHit", (p: never) => {
      const { ship } = p as unknown as { ship: Ship };
      if (!isPlayer(ship)) return;
      if (ctx.elapsed - lastHullReport < 9) return;
      lastHullReport = ctx.elapsed;
      if (ship.hull_ < 0.16) service.bark("critical", { cooldown: 14, priority: 9 });
      else service.bark("hullBreach", { cooldown: 12, priority: 7 });
    }),
  );

  offs.push(
    ctx.on("trek:destroyed", (p: never) => {
      const { ship } = p as unknown as { ship: Ship };
      if (isPlayer(ship)) return;
      if (ship.allegiance === "starfleet" || ship.allegiance === "neutral") {
        service.bark("allyLost", { cooldown: 2, priority: 9 });
      } else {
        service.bark("enemyDestroyed", { cooldown: 2, priority: 9 });
      }
    }),
  );

  offs.push(
    ctx.on("trek:cloak", () => service.bark("cloakDetected", { cooldown: 18, priority: 8 })),
  );
  offs.push(
    ctx.on("trek:decloak", () => service.bark("decloaked", { cooldown: 10, priority: 9 })),
  );
  offs.push(ctx.on("trek:torpedoAway", (p: never) => {
    const { from } = p as unknown as { from: Ship };
    if (isPlayer(from)) service.bark("torpedoAway", { cooldown: 5, priority: 4 });
  }));

  return {
    update(dt) {
      speakingFor = Math.max(0, speakingFor - dt);
      service.busy = speakingFor > 0;
      if (speakingFor <= 0 && queue.length) emit(queue.shift()!);
    },
    dispose() {
      for (const off of offs) off();
      queue.length = 0;
    },
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
