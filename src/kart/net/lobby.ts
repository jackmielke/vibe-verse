/**
 * Vibe Kart — the multiplayer lobby.
 *
 * The thing this exists to fix: the first multiplayer build had a room code, a
 * roster, and a "Start race" button that anybody could hit. That works only if
 * everybody is already looking at the screen — in practice two friends had to
 * count down over voice chat and click together, which is not a lobby, it is a
 * handshake.
 *
 * So the lobby has phases now, and the phase is a consequence of what everyone
 * has *said*, not of who clicked last:
 *
 *   lobby     — people arrive, pick a racer, and toggle ready.
 *   countdown — every seated racer is ready. Five seconds, and nobody has to
 *               do anything. The host is the only one who announces it, but
 *               the host is derived (earliest arrival), not elected, so it
 *               survives the host leaving.
 *   racing    — the flag drops on every client within a round trip of each
 *               other, and the race's own 3-2-1 lights absorb the rest.
 *
 * Transport is a Supabase Realtime channel: presence is the roster (name,
 * chosen character, ready, whether you are already out on track), and one
 * broadcast — `go` — announces the countdown. Nothing here is authoritative,
 * because nothing needs to be: the worst a malicious peer can do is start a
 * kart race.
 *
 * Poses are *not* sent here. Once the race is up, `net/netplay.ts` opens its
 * own channel for the 15 Hz pose traffic, so lobby chatter and race traffic
 * never share a topic.
 */
import { coursePrefix } from "../course";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isBlocked, setSafetyPeers, subscribeSafety } from "@/safety/safety";

export type LobbyPhase = "lobby" | "countdown" | "racing";

export interface LobbyMember {
  peerId: string;
  name: string;
  /** Null until they have been through character select. */
  characterId: string | null;
  ready: boolean;
  /** Already out on the circuit — a late arrival, or the previous race. */
  racing: boolean;
  /** Presence timestamp, and therefore the seating order. */
  joinedAt: number;
}

/** You plus five friends. The field is eight karts; the rest stay CPU. */
export const LOBBY_MAX = 6;

/** Seconds between "everyone is ready" and the flag. */
export const LOBBY_COUNTDOWN = 5;

export interface KartLobbyOptions {
  /** Room code, or null to stay out of any room (single player). */
  code: string | null;
  /** Stable per-tab id — see `makePeerId`. */
  peerId: string;
  /** Owned by the caller, because the join panel edits it. */
  name: string;
  /** Owned by the caller, because character select is a shared screen. */
  characterId: string | null;
}

export interface KartLobby {
  /** Room code, or null when nobody has joined a room yet. */
  code: string | null;
  peerId: string;
  connected: boolean;
  members: LobbyMember[];
  me: LobbyMember | undefined;
  /** Earliest arrival. Announces the countdown; otherwise no privileges. */
  isHost: boolean;
  /** In one of the six seats. False means the room was full when you arrived. */
  seated: boolean;
  phase: LobbyPhase;
  /** Whole seconds left on the countdown, 0 outside it. */
  countdown: number;
  /** Somebody is mid-race, so joining means dropping in rather than starting. */
  raceInProgress: boolean;
  setReady(ready: boolean): void;
  /** Host override — start now, whoever is ready. */
  startNow(): void;
  /** Late arrival: skip the ready cycle and drop into the race already running. */
  jumpIn(): void;
  /** Come back from the results screen without leaving the room. */
  returnToLobby(): void;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Four letters, no I/O — they are the two people confuse over voice chat. */
export function randomRoomCode(): string {
  return Array.from(
    { length: 4 },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
  ).join("");
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

const RACER_NAMES = [
  "Turbo Tofu", "Neon Newt", "Drift Otter", "Sparky", "Mango Bolt",
  "Cardboard Kid", "Zoom Zoom", "Gremlin", "Comet", "Wasabi",
];

export function randomRacerName(): string {
  return RACER_NAMES[Math.floor(Math.random() * RACER_NAMES.length)];
}

/** Stable for the life of the tab. Two tabs are two racers, which is useful. */
export function makePeerId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

interface Presence {
  peerId: string;
  name: string;
  characterId: string | null;
  ready: boolean;
  racing: boolean;
  joinedAt: number;
}

/**
 * Seating order, and with it the host.
 *
 * `joinedAt` is each client's own clock, so two peers whose machines disagree
 * could tie or invert — the peerId tiebreak makes the order *consistent*
 * everywhere even when it is not strictly chronological, and consistency is
 * the property that matters. Every client must name the same host.
 */
export function seatOrder(a: LobbyMember, b: LobbyMember): number {
  return a.joinedAt - b.joinedAt || a.peerId.localeCompare(b.peerId);
}

/**
 * The roster, from presence plus the one entry presence cannot supply.
 *
 * You are always on your own grid. Presence round-trips through the server,
 * so for the first second of a room — and for the whole of a room the browser
 * cannot reach at all — the server's answer does not include you. Rendering
 * that literally gives you an empty lobby with a Ready button that does
 * nothing, which is the worst of the three possible outcomes: worse than an
 * error, and much worse than quietly racing the CPU field. So the local self
 * is merged in whenever the wire has not (yet) echoed it back.
 */
export function rosterWithSelf(remote: LobbyMember[], self: LobbyMember): LobbyMember[] {
  const list = remote.some((m) => m.peerId === self.peerId) ? [...remote] : [...remote, self];
  return list.sort(seatOrder);
}

/**
 * Who announces the countdown.
 *
 * The first seat *still in the lobby* — not simply the first seat. If the
 * earliest arrival is out on track from a previous race they are not watching
 * the roster, and a host who never comes back is a room where nobody left in
 * it can ever start. The job moves down the list the moment they go racing.
 */
export function hostOf(seats: LobbyMember[]): string | null {
  return seats.find((m) => !m.racing)?.peerId ?? null;
}

/** Everyone waiting on the grid has said go. An empty lobby has not. */
export function allReady(seats: LobbyMember[]): boolean {
  const waiting = seats.filter((m) => !m.racing);
  return waiting.length > 0 && waiting.every((m) => m.ready);
}

export function useKartLobby({ code, peerId, name, characterId }: KartLobbyOptions): KartLobby {
  const [ready, setReadyState] = useState(false);
  const [phase, setPhase] = useState<LobbyPhase>("lobby");
  const [countdown, setCountdown] = useState(0);
  /** Exactly what presence said. The self entry is merged in below. */
  const [remote, setRemote] = useState<LobbyMember[]>([]);
  const [connected, setConnected] = useState(false);
  const [joinedAt, setJoinedAt] = useState(0);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Report/block (App Store 1.2): bumps when the block list changes, so the
  // roster relabels without touching seat order or host election.
  const [safetyTick, setSafetyTick] = useState(0);
  useEffect(() => subscribeSafety(() => setSafetyTick((n) => n + 1)), []);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // The countdown must fire once per announcement. Presence churn re-runs the
  // host effect constantly, and without this a busy roster re-announces.
  const announced = useRef(false);

  // -- the room -------------------------------------------------------------
  useEffect(() => {
    if (!code) {
      setRemote([]);
      setConnected(false);
      setJoinedAt(0);
      setPhase("lobby");
      setCountdown(0);
      return;
    }

    const stamp = Date.now();
    setJoinedAt(stamp);
    setRemote([]);
    announced.current = false;
    const channel = supabase.channel(`kart-lobby-${coursePrefix()}${code}`, {
      config: { presence: { key: peerId }, broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<Presence>();
      const list: LobbyMember[] = [];
      for (const entries of Object.values(state)) {
        // A key can carry more than one entry mid-reconnect; the newest wins.
        const e = entries[entries.length - 1];
        if (!e?.peerId) continue;
        list.push({
          peerId: e.peerId,
          name: e.name || "Racer",
          characterId: e.characterId ?? null,
          ready: !!e.ready,
          racing: !!e.racing,
          joinedAt: Number(e.joinedAt) || 0,
        });
      }
      list.sort(seatOrder);
      setRemote(list);
      setSafetyPeers(
        "kart",
        list.filter((m) => m.peerId !== peerId).map((m) => ({ name: m.name, id: m.peerId })),
      );
    });

    channel.on("broadcast", { event: "go" }, ({ payload }) => {
      const seconds = Number((payload as { seconds?: number } | null)?.seconds);
      setPhase((cur) => (cur === "racing" ? cur : "countdown"));
      setCountdown(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : LOBBY_COUNTDOWN);
    });

    channel.subscribe((status) => {
      setConnected(status === "SUBSCRIBED");
      if (status !== "SUBSCRIBED") return;
      void channel.track({
        peerId,
        name,
        characterId,
        ready,
        racing: false,
        joinedAt: stamp,
      } satisfies Presence);
    });

    return () => {
      channelRef.current = null;
      setConnected(false);
      void supabase.removeChannel(channel);
    };
    // `name`/`characterId`/`ready` are read once at subscribe time and then
    // republished by the effect below; re-subscribing on every keystroke would
    // tear the room down and back up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, peerId]);

  // -- republish whatever changed about me ----------------------------------
  const self = useMemo<LobbyMember>(
    () => ({ peerId, name, characterId, ready, racing: phase === "racing", joinedAt }),
    [peerId, name, characterId, ready, phase, joinedAt],
  );

  useEffect(() => {
    if (!connected) return;
    void channelRef.current?.track(self satisfies Presence);
  }, [connected, self]);

  // -- derived roster -------------------------------------------------------
  const members = useMemo(
    () =>
      code
        ? rosterWithSelf(remote, self).map((m) =>
            m.peerId !== peerId && isBlocked(m.name, m.peerId) ? { ...m, name: "Player" } : m,
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, remote, self, safetyTick],
  );
  const me = useMemo(() => members.find((m) => m.peerId === peerId), [members, peerId]);

  /** The six who get a kart, in arrival order. Anyone else is on the fence. */
  const seats = useMemo(() => members.slice(0, LOBBY_MAX), [members]);
  const seated = useMemo(() => seats.some((m) => m.peerId === peerId), [seats, peerId]);

  const isHost = hostOf(seats) === peerId;
  const raceInProgress = useMemo(() => members.some((m) => m.racing), [members]);

  // -- the countdown, once announced ----------------------------------------
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      setPhase("racing");
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const announce = useCallback((seconds: number) => {
    if (announced.current) return;
    announced.current = true;
    void channelRef.current?.send({ type: "broadcast", event: "go", payload: { seconds } });
    setPhase("countdown");
    setCountdown(seconds);
  }, []);

  /**
   * The whole point of the rewrite: nobody drops the flag, the roster does.
   * When every seated racer who is not already out on track says ready, the
   * host announces the countdown and everyone rides it down together.
   */
  useEffect(() => {
    // Deliberately not gated on `connected`: a room the browser cannot reach
    // still has a roster of one, and readying up there should put you on the
    // grid against the CPU field rather than into a lobby that never moves.
    if (!isHost || phase !== "lobby" || !allReady(seats)) return;
    announce(LOBBY_COUNTDOWN);
  }, [isHost, phase, seats, announce]);

  // A fresh ready cycle can announce again.
  useEffect(() => {
    if (phase === "lobby") announced.current = false;
  }, [phase]);

  const setReady = useCallback((next: boolean) => {
    // Backing out of a countdown would strand everyone else mid-tick; the
    // button is disabled there, and this is the belt to that pair of braces.
    if (phaseRef.current !== "lobby") return;
    setReadyState(next);
  }, []);

  const startNow = useCallback(() => {
    if (phase !== "lobby") return;
    announce(LOBBY_COUNTDOWN);
  }, [announce, phase]);

  const jumpIn = useCallback(() => {
    setReadyState(true);
    setPhase("racing");
    setCountdown(0);
  }, []);

  const returnToLobby = useCallback(() => {
    setReadyState(false);
    setCountdown(0);
    setPhase("lobby");
  }, []);

  return {
    code,
    peerId,
    connected,
    members: seats,
    me,
    isHost,
    seated,
    phase,
    countdown,
    raceInProgress,
    setReady,
    startNow,
    jumpIn,
    returnToLobby,
  };
}
