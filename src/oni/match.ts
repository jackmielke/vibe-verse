/**
 * Oni: the match, on top of the room.
 *
 * Holds the current round and its tags, answers newcomers, turns messages
 * into events for the renderer and the HUD, and (on the referee's device
 * only) announces the next round when it is time. Where everybody is lives
 * in the engine; this only knows ids, times and who has horns.
 *
 * A watcher (the projector view) is here too, with `me: null`: it hears
 * everything, can start a round from its button, and is never a player.
 */
import type { OniRoom, OniWire, Peer } from "./net";
import {
  INTERMISSION_MS, LOBBY_MS, addTag, isOni, isRound, laterRound, makeRound, phaseOf, referee, resultOf, roundEndsAt, shouldAnnounce,
  type Phase, type Result, type Round, type Tag,
} from "./rules";

export interface MatchEvents {
  /** A round was announced (ours or somebody else's). */
  onRound?(round: Round): void;
  /** Somebody new has horns. */
  onTag?(tag: Tag): void;
  /** Somebody honked. */
  onEmote?(id: string, emote: string): void;
  /** The round just finished. */
  onOver?(round: Round, result: Result): void;
}

export interface Match {
  round(): Round | null;
  tags(): Map<string, Tag>;
  /** Ids of everybody playing, us included. */
  players(): string[];
  phase(now?: number): Phase;
  isOni(id: string): boolean;
  result(): Result | null;
  /** When the current round ended, epoch ms, or null. */
  endedAt(): number | null;
  /** Epoch ms the next round is due, when the referee will announce it; null if not known. */
  nextAt(): number | null;
  handle(msg: OniWire): void;
  /** Run the referee's clock. Call often. */
  update(now?: number): void;
  /** Somebody (maybe us) caught somebody, as far as this device can tell. */
  claim(victim: string, by: string): void;
  /** Start a round now, whoever we are (the host's button). */
  announce(): void;
  emote(e: string): void;
}

export interface MatchOptions {
  me: string | null;
  room(): OniRoom | null;
  peers(): Peer[];
  now?(): number;
  events?: MatchEvents;
}

export function createMatch(opts: MatchOptions): Match {
  const clock = opts.now ?? (() => Date.now());
  const ev = opts.events ?? {};
  let round: Round | null = null;
  const tags = new Map<string, Tag>();
  let ended: number | null = null;
  let readySince: number | null = null;
  let finished: Result | null = null;
  let lastHi = 0;
  const heardRoundIds = new Set<string>();

  const players = () => {
    const ids = opts.peers().map((p) => p.id);
    if (opts.me) ids.push(opts.me);
    return ids;
  };

  function setRound(r: Round) {
    const next = laterRound(round, r);
    if (next === round) return;
    round = next;
    tags.clear();
    ended = null;
    finished = null;
    ev.onRound?.(next);
  }

  function tagged(t: Tag) {
    if (!round) return;
    if (addTag(tags, t, round)) ev.onTag?.(tags.get(t.victim)!);
  }

  const match: Match = {
    round: () => round,
    tags: () => tags,
    players,
    phase: (now = clock()) => phaseOf(now, round, tags, players()),
    isOni: (id) => isOni(id, round, tags),
    result: () => finished,
    endedAt: () => ended,
    nextAt() {
      if (players().length < 2) return null;
      if (!round) return readySince === null ? null : readySince + LOBBY_MS;
      if (ended === null) return null;
      return ended + INTERMISSION_MS;
    },
    handle(msg) {
      switch (msg.t) {
        case "round":
          if (isRound(msg.round)) { heardRoundIds.add(msg.round.id); setRound(msg.round); }
          break;
        case "tag":
          if (round && msg.r === round.id && typeof msg.v === "string") tagged({ victim: msg.v, by: String(msg.by), at: +msg.at || clock() });
          break;
        case "sync":
          if (msg.round && isRound(msg.round)) {
            setRound(msg.round);
            if (round && round.id === msg.round.id && Array.isArray(msg.tags)) for (const t of msg.tags) if (t && typeof t.victim === "string") tagged(t);
          }
          break;
        case "hi": {
          // One answer per hello: the referee's.
          const me = opts.me;
          if (me && referee(players()) === me) opts.room()?.send({ t: "sync", id: me, round, tags: [...tags.values()] });
          break;
        }
        case "p":
          // A player saying they have horns in this round is a tag we missed.
          if (round && msg.o === 1 && msg.r === round.id && !isOni(msg.id, round, tags)) tagged({ victim: msg.id, by: "?", at: clock() });
          // Somebody is in a round we never heard of: ask again.
          if (msg.r && (!round || (msg.r !== round.id && !heardRoundIds.has(msg.r))) && clock() - lastHi > 2500) {
            lastHi = clock();
            opts.room()?.send({ t: "hi", id: opts.me ?? `w-${Math.random().toString(36).slice(2, 7)}` });
          }
          break;
        case "e":
          ev.onEmote?.(msg.id, String(msg.e).slice(0, 8));
          break;
      }
    },
    update(now = clock()) {
      const ids = players();
      if (ids.length >= 2) { if (readySince === null) readySince = now; } else readySince = null;
      if (round && ended === null && now >= round.start) {
        const endAt = roundEndsAt(round, tags, ids);
        if (now >= endAt) {
          ended = endAt;
          finished = resultOf(round, tags, ids);
          ev.onOver?.(round, finished);
        }
      }
      const me = opts.me;
      if (me && referee(ids) === me && shouldAnnounce(now, round, ended, readySince, ids.length)) match.announce();
    },
    claim(victim, by) {
      if (!round || !opts.me) return;
      const t: Tag = { victim, by, at: clock() };
      if (isOni(victim, round, tags)) return;
      tagged(t);
      opts.room()?.send({ t: "tag", id: opts.me, r: round.id, v: victim, by, at: t.at });
    },
    announce() {
      const ids = players();
      if (ids.length < 2) return;
      const r = makeRound(clock(), ids);
      heardRoundIds.add(r.id);
      setRound(r);
      opts.room()?.send({ t: "round", id: opts.me ?? "watcher", round: r });
    },
    emote(e) {
      if (!opts.me) return;
      opts.room()?.send({ t: "e", id: opts.me, e });
      ev.onEmote?.(opts.me, e);
    },
  };
  return match;
}
