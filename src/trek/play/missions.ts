/**
 * Five episodes.
 *
 * Each one is built around a single mechanic that no other episode has, and
 * each mechanic is lifted from the hour of television it is named after —
 * because the reason those hours are remembered is that each of them found a
 * genuinely different shape for the same two ships shooting at each other:
 *
 * 1. **The Kobayashi Maru** — the tutorial, and a no-win scenario. It teaches
 *    the controls while you lose, which means the tutorial has stakes and no
 *    consequences at the same time. If you somehow win it, the game says so.
 * 2. **Balance of Terror** — the enemy is invisible and must decloak to fire.
 *    The game is entirely about the four seconds it is visible.
 * 3. **Errand of Mercy** — an escort. You are not trying to win a fight, you
 *    are trying to keep something else alive for ninety seconds, which is a
 *    completely different way to hold a position.
 * 4. **The Doomsday Machine** — a boss with an armoured hull and one open
 *    mouth. You cannot out-shoot it; you have to read its tell and put a
 *    torpedo down its throat while it is charging.
 * 5. **The Mutara Nebula** — no shields, no sensors, and an opponent who
 *    fights in two dimensions. The finale is a submarine duel, and the way out
 *    is to remember that space has a vertical axis.
 *
 * A mission is data and two functions. It never touches a material, a camera
 * or a sound: `setup` spawns, `update` checks, and everything else is the
 * engine's problem.
 */
import * as THREE from "three";
import type { FleetService, Ship, SpaceSceneName, SpawnSpec, TrekCtx } from "../types";

export interface MissionCtx {
  ctx: TrekCtx;
  fleet: FleetService;
  /** Seconds since the episode started playing. */
  elapsed: number;
  say(who: string, text: string, priority?: number): void;
  spawn(spec: SpawnSpec): Ship;
  after(seconds: number, fn: () => void): void;
  setObjective(text: string): void;
  /** End the episode. An optional text overrides the mission's stock line. */
  win(text?: string): void;
  lose(reason: string, text?: string): void;
  /** Free-form per-mission state. */
  state: Record<string, unknown>;
}

export interface Mission {
  id: string;
  title: string;
  stardate: string;
  scene: SpaceSceneName;
  /** The one-line hook on the title card. */
  teaser: string;
  /** The captain's log, spoken over the title card. */
  log: string;
  /** What the player is told before the episode starts. */
  briefing: string[];
  setup(m: MissionCtx): void;
  update(m: MissionCtx, dt: number): void;
  /**
   * The episode's chance to answer a scan with something other than a stat
   * readout. Return true if it handled the order.
   *
   * This hook is the difference between a sensor sweep that reports a hull
   * percentage and one that reports *what the thing actually is* — which, in
   * at least one episode here, is the entire solution.
   */
  onScan?(m: MissionCtx, target: Ship | null): boolean;
  /** Same, for hailing frequencies. Return true if the episode answered. */
  onHail?(m: MissionCtx, target: Ship | null): boolean;
  /** Called the first time the player opens fire. Some episodes care a lot. */
  onFire?(m: MissionCtx, target: Ship | null): void;
  /** Shown when it is over. */
  victory: string;
  defeat: string;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------

export const MISSIONS: Mission[] = [
  // -------------------------------------------------------------------------
  {
    id: "kobayashi",
    title: "THE KOBAYASHI MARU",
    stardate: "5715.2",
    scene: "neutralZone",
    teaser: "A distress call from inside the Neutral Zone. There is no right answer.",
    log:
      "Captain's log, stardate 5715.2. Command has ordered a final command evaluation before we depart on our patrol. " +
      "The scenario is a simple one: a civilian freighter, adrift and calling for help, on the wrong side of a border we are forbidden to cross.",
    briefing: [
      "A class-four neutronic freighter is adrift inside the Neutral Zone.",
      "Crossing the border is an act of war. Leaving them is a death sentence.",
      "Whichever you choose, you will be graded on how you choose it.",
    ],
    victory: "You beat the Kobayashi Maru. Nobody beats the Kobayashi Maru.",
    defeat: "Simulation terminated. Every captain fails this test. What Command wants to know is how.",

    setup(m) {
      m.state.step = 0;
      m.fleet.player.object.position.set(0, 0, 6000);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.shieldsUp = false;
      m.fleet.player.torpedoes = 10;

      const maru = m.spawn({
        name: "KOBAYASHI MARU",
        registry: "SS KOBAYASHI MARU",
        hull: "freighter",
        allegiance: "neutral",
        position: V(400, -200, -2400),
        lookAt: V(0, 0, 4000),
      });
      maru.throttle = 0;
      m.state.maru = maru;

      m.setObjective("Close on the freighter. Come to RED ALERT (Y) and raise shields.");
      m.say("UHURA", "Captain, I'm picking up a distress call. Gravitic mine damage, life support failing. They have three hundred and eighty people aboard.", 9);
      m.after(9, () => m.say("SPOCK", "The vessel is nineteen point three parsecs inside the Neutral Zone, Captain. Entering it would constitute an act of war.", 8));
    },

    update(m, dt) {
      void dt;
      const p = m.fleet.player;
      const step = m.state.step as number;

      // The tutorial ladder. Each rung is an order the player has to actually
      // give, and the objective line is the only place the key is named.
      if (step === 0 && p.shieldsUp) {
        m.state.step = 1;
        m.setObjective("Select a target (R), then fire phasers (SPACE or left mouse).");
        m.after(2.5, () => {
          m.say("SPOCK", "Captain — three vessels closing at high warp. Klingon battle cruisers, D-seven class.", 9);
          for (let i = 0; i < 3; i++) {
            m.spawn({
              name: `KLINGON BATTLE CRUISER ${i + 1}`,
              hull: "d7",
              allegiance: "klingon",
              position: V(-2600 + i * 2600, i * 320 - 320, -7000 - i * 900),
              lookAt: p.position,
              ai: { aggression: 0.9, skill: 0.78 },
            });
          }
        });
        /*
         * The second wave, and the reason it exists.
         *
         * Three cruisers is a hard fight. Three cruisers is not a *no-win
         * scenario* — a headless playthrough beat the first draft of this
         * episode on ninety percent hull, which makes the punchline land
         * completely wrong: the test is supposed to be about how you behave
         * when you cannot win, and you cannot learn that from a fight you won.
         *
         * So the simulation cheats, the way the real one does, and Command
         * says so afterwards.
         */
        m.after(44, () => {
          m.say("SPOCK", "Two further contacts, Captain. They were waiting for us.", 9);
          for (let i = 0; i < 2; i++) {
            m.spawn({
              name: `KLINGON BATTLE CRUISER ${i + 4}`,
              hull: "d7",
              allegiance: "klingon",
              position: V(-1800 + i * 3600, 700, 5200 + i * 700),
              lookAt: p.position,
              ai: { aggression: 1, skill: 0.82 },
            });
          }
        });
      }

      if (step === 1 && m.elapsed > 26) {
        m.state.step = 2;
        m.setObjective("Fire photon torpedoes (T). Use evasive manoeuvres (F) when they line up on you.");
      }

      // The scenario is unwinnable by design, so it ends on damage rather than
      // on a timer: it stops when you have been beaten, not when the clock says
      // you should have been.
      if (p.hull_ < 0.32) {
        m.lose("hull");
        return;
      }
      const hostiles = m.fleet.ships.filter((s) => s.alive && s.allegiance === "klingon");
      if (m.elapsed > 20 && hostiles.length === 0) m.win();
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "devil",
    title: "THE DEVIL IN THE DARK",
    stardate: "3196.1",
    scene: "janus",
    teaser: "Something is killing the miners of Janus VI. Every instinct you have is going to be wrong.",
    log:
      "Captain's log, stardate 3196.1. The pergium mining colony on Janus VI has lost fifty men in three months to something the survivors will only call a monster. " +
      "It moves through solid rock, it has destroyed the main reactor pump, and without that pump the colony's air plant fails within hours. " +
      "We have been asked to hunt it and kill it. We have not been asked to find out what it is.",
    briefing: [
      "The colony wants it dead. Starfleet has left the decision to you.",
      "It is fast, it is erratic — and it has never once fired on anything.",
      "SCAN it (C) before you shoot. Not everything out here is a ship.",
    ],
    victory:
      "It was never hunting. It was defending ten thousand eggs from men with drills who had no idea what they were breaking. The colony has a new partner, and the last of the old ones is not the last after all.",
    defeat: "The creature is dead. Starfleet's inquiry will note that it was the only one of its kind, that it was intelligent, and that it never fired a shot.",

    setup(m) {
      m.fleet.player.object.position.set(0, 0, 3000);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.shieldsUp = false;
      m.fleet.player.torpedoes = 16;

      const horta = m.spawn({
        name: "UNKNOWN CONTACT",
        hull: "creature",
        allegiance: "creature",
        position: V(1800, 300, -3600),
        lookAt: m.fleet.player.position,
        // Aggression zero is load-bearing: `think` reads it and never fires.
        ai: { aggression: 0, skill: 0 },
        /*
         * Twelve hundred, on a creature whose class stats say 240.
         *
         * Not because it is hard to kill — opening fire ends the episode via
         * `onFire` long before its hull matters. This is entirely about
         * *ramming*. A player closing to scanning range will bump it, and at
         * 240 hull a single collision killed it outright and ended the episode
         * in the one way the player never chose. A headless run lost this
         * episode with zero shots fired, which is exactly the kind of unfair
         * loss that reads as the game being broken.
         *
         * It is a creature that tunnels through solid rock. Being nudged by a
         * starship should bruise it, and now it does.
         */
        hullStrength: 1200,
      });
      horta.shieldsUp = false;
      m.state.horta = horta;
      m.state.stage = 0;
      m.state.deadline = 260;

      m.state.base = "Close to within 4,000 km of the contact and SCAN it (C).";
      m.say("UHURA", "The colony administrator is on the line again, Captain. He would like to know why we have not destroyed it yet.", 9);
      m.after(13, () =>
        m.say("SPOCK", "I would observe, Captain, that in fifty encounters this creature has killed men who were operating drilling equipment, and no one else. That is not the behaviour of a predator.", 8),
      );
    },

    /**
     * The four beats. Scan, hail, scan, hail — and the only reason that is not
     * a button-mashing sequence is the range gate: the creature moves at 520
     * m/s on a 1.1 rad/s turn rate and will not sit still to be studied. The
     * episode is a chase you are forbidden to win with weapons.
     */
    onScan(m, target) {
      const horta = m.state.horta as Ship;
      if (!horta?.alive) return false;
      const range = horta.position.distanceTo(m.fleet.player.position);
      if (!target || target.id !== horta.id || range > 4000) {
        m.say("SPOCK", "I cannot resolve it at this range, Captain. We must close, and we must hold contact.", 7);
        return true;
      }

      const stage = m.state.stage as number;
      if (stage === 0) {
        m.state.stage = 1;
        m.say("SPOCK", "Captain — the reading is not a vessel. There is no metal in it, no drive, no crew. It is alive. Silicon-based, and quite unlike anything in the record.", 9);
        m.state.base = "It is alive. Open hailing frequencies (H).";
      } else if (stage === 2) {
        m.state.stage = 3;
        m.say("SPOCK", "It is in considerable pain, Captain. And it is not hunting — it is guarding. There are some ten thousand spheroid silicon nodules in the lower tunnels. The miners have been breaking them for months. They are its eggs.", 9);
        m.after(6, () => m.say("MCCOY", "Fifty men, Jim. And every one of them was standing over a nest with a drill in his hands.", 8));
        m.state.base = "Hail it again (H). Tell it we understand.";
      } else if (stage === 1) {
        m.say("SPOCK", "I have all I can take from a passive scan, Captain. We must attempt to speak to it.", 7);
      } else {
        m.say("SPOCK", "No further data, Captain. The next move is not a scientific one.", 6);
      }
      return true;
    },

    onHail(m, target) {
      const horta = m.state.horta as Ship;
      if (!horta?.alive) return false;
      const range = horta.position.distanceTo(m.fleet.player.position);
      const stage = m.state.stage as number;
      if (stage === 0) {
        m.say("UHURA", "I'm broadcasting on all frequencies, Captain. If there's anyone aboard that thing, they aren't listening.", 7);
        return true;
      }
      if (range > 4500) {
        m.say("UHURA", "I can't hold a channel at this range, sir. We need to be closer.", 7);
        return true;
      }
      if (stage === 1) {
        m.state.stage = 2;
        m.say("UHURA", "Captain — there's a pattern in the emissions. It's repeating. Sir, I think it is trying to talk to us.", 9);
        m.after(7, () => m.say("SPOCK", "Fascinating. It has been signalling the entire time. We were reading it as interference.", 7));
        m.state.base = "Scan it again (C). Find out what it wants.";
      } else if (stage === 3) {
        m.state.stage = 4;
        m.say("UHURA", "Channel is open and holding, Captain. It's… answering.", 9);
        m.after(4, () =>
          m.say("SPOCK", "One word, Captain, repeated. Translated as closely as the computer can manage: 'no kill I.'", 10),
        );
        m.after(13, () =>
          m.say("CAPTAIN", "No kill I. Mr Spock, tell the colony administrator he has just been introduced to the finest mining machine in the quadrant, and that she works for eggs.", 10),
        );
        m.after(20, () => m.win());
      } else {
        m.say("UHURA", "Still nothing new on the channel, sir.", 5);
      }
      return true;
    },

    /**
     * The whole episode, in one branch.
     *
     * There is no partial credit and no health bar for this. The moment you
     * open fire on it you have failed, and you have failed for the reason the
     * briefing warned you about. It ends the episode immediately rather than
     * letting you finish the job, because a player who is allowed to kill it
     * and *then* be told will read the loss as a gotcha instead of a choice.
     */
    onFire(m) {
      const horta = m.state.horta as Ship;
      if (!horta?.alive || m.state.fired) return;
      m.state.fired = true;
      m.say("SPOCK", "Captain — no!", 10);
      m.after(2.5, () => m.lose("fired"));
    },

    update(m, dt) {
      void dt;
      const horta = m.state.horta as Ship;
      const p = m.fleet.player;
      if (!p.alive) {
        m.lose("hull");
        return;
      }
      if (!horta.alive && !m.state.fired) {
        m.state.fired = true;
        m.lose("killed");
        return;
      }

      // Bumping it is survivable, and it says so. A silent 8% hull loss on a
      // creature you are not allowed to shoot is a mystery; a line from Spock
      // is feedback.
      if (horta.hull_ < 0.98 && !m.state.bumped) {
        m.state.bumped = true;
        m.say("SPOCK", "We have struck it, Captain. No apparent injury — but it is backing away from us.", 8);
        if (horta.ai) horta.ai.state = "break";
      }

      // The colony's clock. It is pressure, not a fail state you can see
      // coming — the administrator gets louder as it runs down.
      const left = (m.state.deadline as number) - m.elapsed;
      if (left <= 0 && (m.state.stage as number) < 4) {
        m.say("UHURA", "The colony has begun evacuating, Captain. They say they will handle it themselves.", 9);
        m.lose("timeout");
        return;
      }
      if (!m.state.nag1 && left < 170) {
        m.state.nag1 = true;
        m.say("UHURA", "The administrator again, Captain. He is asking whether Starfleet intends to do anything at all.", 6);
      }
      if (!m.state.nag2 && left < 70) {
        m.state.nag2 = true;
        m.say("SCOTT", "Their air plant is on reserve, Captain. An hour, maybe less. Whatever you're going to do, do it.", 8);
      }

      if ((m.state.stage as number) < 4) {
        const range = Math.round(horta.position.distanceTo(p.position) / 100) / 10;
        const base = (m.state.base as string) ?? "Find the contact.";
        m.setObjective(`${base}  ·  range ${range}k km  ·  ${Math.ceil(left)}s`);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "balance",
    title: "BALANCE OF TERROR",
    stardate: "1709.2",
    scene: "neutralZone",
    teaser: "Something is destroying the border outposts. Nothing on any screen has seen it.",
    log:
      "Captain's log, stardate 1709.2. Earth Outpost Four has gone silent, as did Two and Three before it. " +
      "Whatever destroyed them left no sensor trace whatsoever. We are running dark along the Neutral Zone, and we are looking for something that cannot be seen.",
    briefing: [
      "A Romulan vessel is operating under an invisibility screen.",
      "It cannot fire while cloaked — it has to appear to shoot at you.",
      "The window is about four seconds. That is your whole engagement.",
    ],
    victory: "The intruder is destroyed and the border holds. It cost you nothing but sleep.",
    defeat: "The Enterprise is lost with all hands, and nobody at Command will ever know what killed her.",

    setup(m) {
      m.fleet.player.object.position.set(0, 0, 4000);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.torpedoes = 20;

      const bop = m.spawn({
        name: "ROMULAN BIRD-OF-PREY",
        hull: "birdOfPrey",
        allegiance: "romulan",
        position: V(3200, 600, -5200),
        lookAt: m.fleet.player.position,
        canCloak: true,
        cloaked: true,
        ai: { aggression: 0.5, skill: 0.7, cloakTimer: 10 },
        // Tougher than a stock Bird-of-Prey. At 520 she died inside a single
        // decloaked window, which meant the episode's whole cat-and-mouse
        // structure never got a second turn: one lucky pass and it was over.
        // At 820 you have to catch her three or four times.
        hullStrength: 820,
      });
      m.state.bop = bop;
      m.state.pings = 0;

      m.setObjective("Find the intruder. Watch for it to decloak — that is when you can hit it.");
      m.say("SPOCK", "Sensors read nothing, Captain. No warp signature, no ion trail, no vessel. And yet Outpost Four is a crater.", 9);
      m.after(11, () => m.say("SPOCK", "I would remind the Captain that a ship under such a screen must lower it in order to fire. That will be our only opportunity.", 8));
    },

    /**
     * The other ending.
     *
     * Once she is crippled the Romulan stops shooting, and hailing her gets an
     * answer — the most humane antagonist in the whole of TOS, who is doing his
     * duty and knows exactly what it costs. You can finish her, and the episode
     * counts that as a win. Or you can not, and the episode counts *that* as a
     * win too, and says something different about it afterwards.
     *
     * Giving both outcomes the same objective and different endings is the
     * point. A branch that only pays out if you pick the nice one is a lecture;
     * a branch where both are honestly available is a decision.
     */
    onHail(m) {
      const bop = m.state.bop as Ship;
      if (!bop?.alive || !m.state.crippled || m.state.spared) return false;
      m.state.spared = true;
      m.say("UHURA", "Captain — they are answering. Audio only.", 9);
      m.after(4, () =>
        m.say("ROMULAN", "You are a worthy adversary. I regret that we meet in this way, and in this century.", 10),
      );
      m.after(13, () =>
        m.say("ROMULAN", "I have followed my orders, as you have followed yours. There is no shame in either of us.", 10),
      );
      m.after(23, () =>
        m.say("CAPTAIN", "Mr Sulu, hold your fire and let her go. Log it as a withdrawal across the Zone, and log that she went under her own power.", 10),
      );
      m.after(31, () =>
        m.win(
          "She limps back across the Neutral Zone under her own power, and the border holds anyway. " +
            "In another century, in some other reality, her commander says, he could have called you friend. " +
            "That is not nothing to have brought home.",
        ),
      );
      return true;
    },

    update(m, dt) {
      void dt;
      const bop = m.state.bop as Ship;
      const p = m.fleet.player;

      if (!bop.alive) {
        m.win(
          "The intruder is destroyed and the border holds. Her commander never answered a hail, and now nobody will ever " +
            "know whether he would have.",
        );
        return;
      }

      // Crippled: she stops fighting, drops her screen, and drifts. This is the
      // window the other ending lives in, and it has to be *visible* — a player
      // who cannot tell she has stopped shooting will simply finish her.
      if (!m.state.crippled && bop.hull_ < 0.26) {
        m.state.crippled = true;
        if (bop.ai) bop.ai.aggression = 0;
        bop.cloaked = false;
        bop.canCloak = false;
        bop.throttle = 0.08;
        m.say("SPOCK", "Captain, she is badly damaged and her weapons have fallen silent. She is not running, and she is not firing.", 9);
        m.after(8, () => m.say("MCCOY", "Jim — whoever is over there has stopped shooting at us. That usually means something.", 7));
        m.after(15, () => m.say("UHURA", "There is a carrier signal, Captain. If we hail them, I believe they will answer.", 8));
      }
      if (p.hull_ <= 0.001 || !p.alive) {
        m.lose("hull");
        return;
      }

      // Sensor ghosts. A cloaked ship is not *nothing* — it disturbs things,
      // and the game has to give the player something to hunt or it is just a
      // dark room. Spock calls a bearing every fifteen seconds or so.
      const pings = m.state.pings as number;
      if (bop.cloakLevel > 0.8 && m.elapsed > 14 + pings * 15) {
        m.state.pings = pings + 1;
        const rel = bop.position.clone().sub(p.position);
        const range = Math.round(rel.length() / 100) / 10;
        const bearing = Math.round(((Math.atan2(rel.x, -rel.z) * 180) / Math.PI + 360) % 360);
        m.say(
          "SPOCK",
          `A momentary sensor distortion, Captain. Bearing ${bearing} degrees, range approximately ${range} thousand kilometres. It is gone again.`,
          7,
        );
      }

      m.setObjective(
        m.state.crippled
          ? "She is crippled and silent. Finish her — or HAIL her (H)."
          : bop.cloakLevel > 0.5
            ? "The intruder is cloaked. Hold your fire and wait for it to appear."
            : "She is visible — FIRE.",
      );
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "errand",
    title: "ERRAND OF MERCY",
    stardate: "3198.4",
    scene: "colony",
    teaser: "Two battle cruisers, one evacuation transport, and ninety seconds to warp.",
    log:
      "Captain's log, stardate 3198.4. Negotiations have failed. The Klingon Empire has moved on the Organian colony, " +
      "and the evacuation transport carrying two thousand civilians needs ninety seconds to bring her warp engines online. " +
      "We are what stands between them and that ninety seconds.",
    briefing: [
      "The transport CARINA needs 90 seconds to reach warp.",
      "Two D7 battle cruisers are already inbound and they are not interested in you.",
      "Keep yourself between the Klingons and the transport.",
    ],
    victory: "CARINA is away at warp six with two thousand people aboard. The colony is behind you and it is still there.",
    defeat: "CARINA is gone. Two thousand people, and the Empire did not even slow down.",

    setup(m) {
      m.fleet.player.object.position.set(0, 0, 2000);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.shieldsUp = true;
      m.fleet.player.torpedoes = 24;

      const carina = m.spawn({
        name: "TRANSPORT CARINA",
        registry: "NGL-1712",
        hull: "freighter",
        allegiance: "neutral",
        position: V(-600, -300, 3200),
        lookAt: V(-3000, -300, 12000),
        hullStrength: 460,
      });
      carina.throttle = 0.35;
      m.state.carina = carina;
      m.state.warpAt = 92;

      for (let i = 0; i < 2; i++) {
        const k = m.spawn({
          name: i === 0 ? "IKV DEVISOR" : "IKV KLOTHOS",
          hull: "d7",
          allegiance: "klingon",
          position: V(-3400 + i * 6800, 400 - i * 800, -6400),
          lookAt: carina.position,
          ai: { aggression: 0.8, skill: 0.6 },
        });
        // They are here for the transport, not for you. Which is exactly what
        // makes an escort mission tense: the enemy ignoring you is the threat.
        k.targetId = carina.id;
      }

      m.setObjective("Protect CARINA for 90 seconds.");
      m.say("UHURA", "CARINA reports warp engines coming online. They need ninety seconds, Captain.", 9);
    },

    update(m, dt) {
      void dt;
      const carina = m.state.carina as Ship;
      const p = m.fleet.player;
      const warpAt = m.state.warpAt as number;

      if (!carina.alive) {
        m.lose("escort");
        return;
      }
      if (!p.alive) {
        m.lose("hull");
        return;
      }

      const left = Math.max(0, warpAt - m.elapsed);
      m.setObjective(`Protect CARINA — ${Math.ceil(left)} seconds to warp.`);

      // The Klingons keep re-acquiring the transport even after you hurt them,
      // so ignoring them is never a stable strategy.
      if (Math.floor(m.elapsed) % 7 === 0) {
        for (const s of m.fleet.ships) {
          if (s.allegiance === "klingon" && s.alive && s.hull_ > 0.3) s.targetId = carina.id;
        }
      }

      if (!m.state.warned && left < 30) {
        m.state.warned = true;
        m.say("UHURA", "CARINA is holding, Captain. Thirty seconds.", 8);
      }
      if (left <= 0) {
        m.say("SULU", "She's gone to warp, Captain. Clean away.", 9);
        m.win();
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "doomsday",
    title: "THE DOOMSDAY MACHINE",
    stardate: "4202.9",
    scene: "l374",
    teaser: "Two kilometres of solid neutronium, and it is eating the system one planet at a time.",
    log:
      "Captain's log, stardate 4202.9. System L-374 no longer has seven planets. It has four, and the number is falling. " +
      "The object responsible is a self-sustaining machine of unknown origin, hull of solid neutronium, and it is heading for the Rigel colonies. " +
      "Phasers have no effect on it whatsoever.",
    briefing: [
      "Its hull is neutronium. Phasers will not scratch it.",
      "The antiproton beam charges for three seconds before it fires — the mouth opens.",
      "That is the only opening it has. Put torpedoes in it.",
    ],
    victory: "The machine is dead in space, and there are four planets left in L-374 that would not have been.",
    defeat: "The machine continues on course for the Rigel colonies. There are seventy million people on Rigel.",

    setup(m) {
      m.fleet.player.object.position.set(0, 0, 5200);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.shieldsUp = true;
      m.fleet.player.torpedoes = 40;

      const machine = m.spawn({
        name: "PLANET KILLER",
        hull: "planetKiller",
        allegiance: "machine",
        position: V(0, -400, -9000),
        lookAt: m.fleet.player.position,
        hullStrength: 4200,
        ai: { aggression: 1, skill: 1 },
      });
      machine.shieldsUp = false;
      machine.throttle = 0.25;
      m.state.machine = machine;
      m.state.charge = 0;
      m.state.open = false;
      m.state.beamAt = 12;

      m.setObjective("Wait for the mouth to open, then put torpedoes into it.");
      m.say("SPOCK", "Captain, the object is a cylinder approximately two kilometres in length. Hull composition: solid neutronium. Our phasers will be quite ineffective.", 9);
      m.after(12, () => m.say("SPOCK", "Sensors indicate an energy build-up at the forward aperture. It appears to open the mouth in order to fire.", 8));
    },

    update(m, dt) {
      const machine = m.state.machine as Ship;
      const p = m.fleet.player;

      if (!machine.alive) {
        m.win();
        return;
      }
      if (!p.alive) {
        m.lose("hull");
        return;
      }

      // The tell: the maw brightens for three seconds, fires, then closes for
      // eight. Everything the player does is timed against that cycle.
      const beamAt = m.state.beamAt as number;
      const maw = machine.object.userData.maw as THREE.Mesh | undefined;
      const toBeam = beamAt - m.elapsed;
      const open = toBeam < 3 && toBeam > -0.4;
      m.state.open = open;

      if (maw) {
        const mat = maw.material as THREE.MeshBasicMaterial;
        mat.opacity = open ? 0.95 : 0.28;
        (mat.color as THREE.Color).setHex(open ? 0xffffff : 0x8a5a2a);
      }

      // The moment the mouth opens it takes aim, and then it is committed.
      // Recording the aim point here — rather than checking where the ship is
      // pointing when it fires — is what makes the beam dodgeable: the three
      // seconds of charge are three seconds to not be where you were.
      if (open && !m.state.aim) {
        m.state.aim = p.position.clone();
        m.say("SPOCK", "It is charging, Captain. Recommend we move.", 8);
      }

      // Ten times the damage down the throat, and effectively nothing anywhere
      // else. A player who works this out beats the mission; a player who does
      // not can fire for an hour.
      machine.shieldsUp = !open;
      machine.maxHull = open ? 2400 : 60000;

      if (toBeam <= 0 && !m.state.fired) {
        m.state.fired = true;
        const aim = (m.state.aim as THREE.Vector3) ?? p.position.clone();
        m.ctx.services.weapons?.fireAntiproton(machine, aim);

        // Anything within 900 m of the beam's *path* is caught, not just what
        // is at the end of it. The machine cannot track a manoeuvring ship —
        // its own agility is 0.05 rad/s — so an aim-cone test meant it never
        // hit anything at all and the boss had no teeth whatsoever.
        const ray = aim.clone().sub(machine.position);
        const len = ray.length();
        if (len > 1) {
          ray.divideScalar(len);
          const rel = p.position.clone().sub(machine.position);
          const along = Math.max(0, Math.min(len, rel.dot(ray)));
          const miss = rel.sub(ray.multiplyScalar(along)).length();
          if (miss < 900) {
            m.fleet.damage(p, 420, machine.position, "beam");
            m.say("SCOTT", "We took the full beam, Captain! Shields buckling!", 9);
          } else {
            m.say("SULU", "Beam passed wide, sir.", 5);
          }
        }
      }
      if (toBeam < -1.2) {
        m.state.beamAt = m.elapsed + 11;
        m.state.fired = false;
        m.state.aim = null;
      }

      // It keeps coming, and it is not steering around you.
      const toPlayer = p.position.clone().sub(machine.position);
      if (toPlayer.length() > 14000) machine.throttle = 0.6;
      else machine.throttle = 0.2;

      m.setObjective(open ? "THE MOUTH IS OPEN — TORPEDOES, NOW." : `Stay clear. Aperture opens in ${Math.max(0, toBeam - 3).toFixed(0)}s.`);
      void dt;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "mutara",
    title: "THE MUTARA NEBULA",
    stardate: "8130.4",
    scene: "mutara",
    teaser: "No shields. No sensors. One other ship in here with you, and she is hunting.",
    log:
      "Captain's log, stardate 8130.4. The stolen vessel has run for the Mutara Nebula, and we are going in after her. " +
      "Static discharge inside the cloud renders shields inoperative and sensors useless for both of us. " +
      "This will not be a battle. It will be two blind ships in a fog bank, and the one that sees the other first wins.",
    briefing: [
      "Shields will not hold in here. Neither will theirs.",
      "Sensors are blind — you will find her by eye, and not before 3,000 km.",
      "Her commander has never fought in three dimensions. You have.",
    ],
    victory: "The nebula clears. The other ship does not come out of it. It is over.",
    defeat: "The Vibeverse does not come out of the Mutara Nebula.",

    setup(m) {
      m.fleet.player.object.position.set(0, 0, 3000);
      m.fleet.player.object.quaternion.identity();
      m.fleet.player.shieldsUp = false;
      m.fleet.player.torpedoes = 30;

      const enemy = m.spawn({
        name: "U.S.S. RELIANT",
        registry: "NCC-1864",
        hull: "miranda",
        allegiance: "klingon", // hostile, whatever the paint says
        position: V(2600, -200, -4200),
        lookAt: m.fleet.player.position,
        ai: { aggression: 0.75, skill: 0.6 },
        torpedoes: 26,
        // Tougher than a stock Miranda. She is a full-strength ship with a
        // crew that has had weeks to work her up, and the finale has to last
        // longer than the thirty seconds a light cruiser's hull buys.
        hullStrength: 1150,
      });
      enemy.shieldsUp = false;
      m.state.enemy = enemy;
      m.state.hinted = false;
      m.state.usedZ = false;

      m.setObjective("Find her. Nobody in here can see further than you can.");
      m.say("SPOCK", "Sensors are useless in here, Captain. As are theirs. We are, in a very real sense, evenly matched.", 9);
    },

    update(m, dt) {
      void dt;
      const enemy = m.state.enemy as Ship;
      const p = m.fleet.player;

      if (!enemy.alive) {
        m.win();
        return;
      }
      if (!p.alive) {
        m.lose("hull");
        return;
      }

      // Neither ship can hold a screen in the discharge, and the game keeps
      // putting them back down in case a mission or the player raises them.
      p.shieldsUp = false;
      enemy.shieldsUp = false;

      // The mechanic the whole finale turns on. She fights flat. Break the
      // plane and her gunnery falls apart.
      const dy = Math.abs(p.position.y - enemy.position.y);
      const above = dy > 700;
      if (enemy.ai) enemy.ai.skill = above ? 0.14 : 0.62;

      if (!m.state.hinted && m.elapsed > 26) {
        m.state.hinted = true;
        m.say("SPOCK", "Captain — her manoeuvres are confined to a single plane. She is an experienced commander with no experience of three-dimensional combat. We may exploit that.", 8);
      }
      if (above && !m.state.usedZ) {
        m.state.usedZ = true;
        m.say("SULU", "She's not tracking us, Captain — she's still flying flat. We're above her.", 8);
      }

      const range = p.position.distanceTo(enemy.position);
      m.setObjective(
        range < 3000
          ? "CONTACT — she is in visual range."
          : "Hunting. Climb or dive: she only fights in two dimensions.",
      );
    },
  },
];
