/**
 * SOAKED — the lobby.
 *
 * The entry veil for the water fight, and the thing that makes it a *party*
 * rather than a single-player demo: you create a room, you get a code like
 * SPLASH-4B2, you text it to a friend, and thirty seconds later you are both
 * on the same island throwing balloons.
 *
 * Three rules this screen is built around:
 *
 *  - **The network never blocks entry.** If `ctx.services.net` is missing (no
 *    net system booted) or `net.online` is false (Supabase unreachable, or
 *    simply never joined), the lobby says so in plain words and the DROP IN
 *    button still works. A dead socket must cost you your friends, not your
 *    game. Every read of the transport is optional-chained for that reason.
 *  - **The code is the product.** It is rendered huge, in a mono face with an
 *    unambiguous alphabet (see `generateRoomCode`), with one tap to copy the
 *    code and one to copy the full `?room=` link. Everything else on this
 *    screen is subordinate to getting that string into a text message.
 *  - **Team colour is not chosen here, it is derived.** `net/ghosts.ts` tints
 *    a peer from a hash of its team id so every client agrees without any
 *    negotiation. The swatches below run the *same* hash, so the dot next to
 *    a name in the lobby is the colour of that player in the world. Picking a
 *    palette here instead would silently disagree with the game.
 *
 * State lives in React and is polled, not pushed: `net.peers` is a live Map
 * the transport mutates in place, so a 500 ms poll (cheap; this component is
 * unmounted the moment the pointer locks) is both simpler and more robust
 * than trying to mirror every join/leave event. The poll is wall-clock — it
 * drives DOM, not simulation, so the usual "measure in `ctx.elapsed`" rule
 * does not apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Engine } from "../engine/core";
import type { PeerState } from "../net/types";
import { generateRoomCode, normalizeRoomCode } from "../net/net";
import { WATER } from "../mode/water";

// ---------------------------------------------------------------- squads

export interface SquadDef {
  /** Wire value. Same string = same squad = you cannot soak each other. */
  id: string;
  name: string;
  emoji: string;
}

/**
 * The four squads on the picker.
 *
 * The names are deliberately *not* colour words. Colour is a hash of the id
 * (see `squadColor`), so a squad called "Blue" would have shown up bright red
 * — which is precisely the kind of small lie that erodes trust in a UI. These
 * four ids were checked to land 80°+ apart on the hue wheel.
 */
export const SQUADS: readonly SquadDef[] = [
  { id: "riptide", name: "Riptide", emoji: "🌊" },
  { id: "dolphin", name: "Dolphins", emoji: "🐬" },
  { id: "cannonball", name: "Cannonballs", emoji: "💣" },
  { id: "flamingo", name: "Flamingos", emoji: "🦩" },
];

/** FNV-1a. Must stay byte-identical to the one in `net/ghosts.ts`. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The CSS colour a squad shows as — the same continuous hue, saturation and
 * lightness `ghosts.ts` gives that team's players in the world.
 */
export function squadColor(key: string): string {
  const hue = (((hashString(key) >>> 8) & 0xffff) / 0x10000) * 360;
  return `hsl(${hue.toFixed(1)} 74% 58.5%)`;
}

function squadLabel(id: string | null): string {
  if (!id) return "no squad";
  return SQUADS.find((s) => s.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- controls

/** Bindings, straight off `engine/input.ts`, worded for a water fight. */
const CONTROLS: readonly [string, string][] = [
  ["WASD", "move"],
  ["Shift", "sprint"],
  ["Space", "jump"],
  ["Mouse", "look / spray"],
  ["RMB", "aim"],
  ["Ctrl", "crouch"],
  ["Z X C V", "noodle plank ramp cone"],
  ["Q", "rotate build"],
  ["G", "drop item"],
  ["E", "pick up / refill"],
  ["R", "refill tank"],
  ["1–6", "loadout"],
  ["Esc", "pause"],
];

// ---------------------------------------------------------------- storage

const LS_NAME = "soaked.name";
const LS_TEAM = "soaked.team";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — a remembered name is not worth an exception. */
  }
}

/** The `?room=` a shared link arrived with, normalised. */
function roomFromUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeRoomCode(params.get("room") ?? params.get("soaked") ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- props

export interface LobbyProps {
  /** Null until boot resolves. The lobby reads `ctx.services.net` off it. */
  engine: Engine | null;
  /** False while systems are still coming up; DROP IN waits for it. */
  ready: boolean;
  progress: { stage: string; fraction: number };
  /** Requests pointer lock and resumes audio. Called from the click itself. */
  onDropIn: () => void;
  /** Seed for the name field — the vibe identity's display name. */
  defaultName?: string;
}

type NetStatus = "idle" | "connecting" | "online" | "solo";

// ---------------------------------------------------------------- component

export default function Lobby({ engine, ready, progress, onDropIn, defaultName }: LobbyProps) {
  const net = engine?.ctx.services.net ?? null;

  const [name, setName] = useState(
    () => readStored(LS_NAME) || defaultName || "player",
  );
  const [team, setTeam] = useState(() => {
    const stored = readStored(LS_TEAM);
    return stored && SQUADS.some((s) => s.id === stored) ? stored : SQUADS[0].id;
  });
  const [codeInput, setCodeInput] = useState(roomFromUrl);
  const [joining, setJoining] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [online, setOnline] = useState(false);
  /**
   * The room this player is in *as far as they are concerned*.
   *
   * Deliberately local state rather than a mirror of `net.roomCode`: creating
   * a room is a local act, and the code has to be on screen — big, copyable,
   * pasted into the invite command — even when the transport is missing or
   * offline. Reading it off the transport meant that a player with no
   * Supabase got a lobby that silently refused to produce a code at all,
   * which reads as a broken button rather than as "you are playing solo".
   */
  const [room, setRoom] = useState<string | null>(() => roomFromUrl() || null);
  const [roster, setRoster] = useState<PeerState[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const copyTimer = useRef<number | null>(null);
  /** The URL auto-join must fire once, and only once the engine exists. */
  const autoJoined = useRef(false);

  // The identity hook resolves asynchronously (it waits on a Supabase
  // session). Adopt a late-arriving display name, but never over a name the
  // player has already typed or one we restored from a previous match.
  const touchedName = useRef(Boolean(readStored(LS_NAME)));
  useEffect(() => {
    if (touchedName.current) return;
    if (defaultName && defaultName !== "Guest") setName(defaultName);
  }, [defaultName]);

  // ---- live view of the transport --------------------------------------
  //
  // One interval, one comparison. `peers` is mutated in place by the net
  // system, so a fresh array is built each tick and thrown away unless the
  // roster actually changed — otherwise this would re-render twice a second
  // for the whole time the lobby is open.
  useEffect(() => {
    let sig = "";
    const poll = () => {
      const list = net ? [...net.peers.values()] : [];
      list.sort((a, b) => a.name.localeCompare(b.name));
      const nextSig = `${net?.online ? 1 : 0}|${net?.roomCode ?? ""}|${list
        .map((p) => `${p.id}:${p.name}:${p.team ?? ""}:${p.agent ? 1 : 0}`)
        .join(",")}`;
      if (nextSig === sig) return;
      sig = nextSig;
      setOnline(Boolean(net?.online));
      // Only ever *adopt* a code from the transport — never clear one. The
      // net system's own `?room=` auto-join can land a code here before the
      // player touches anything, and a transient disconnect must not wipe
      // the code they are in the middle of texting to someone.
      if (net?.roomCode) setRoom(net.roomCode);
      setRoster(list);
    };
    poll();
    const id = window.setInterval(poll, 500);
    return () => window.clearInterval(id);
  }, [net]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // ---- joining ----------------------------------------------------------

  const doJoin = useCallback(
    async (raw: string) => {
      const code = normalizeRoomCode(raw);
      if (!code) {
        setHint("Type a room code first — or tap CREATE for a fresh one.");
        return;
      }
      setCodeInput(code);
      setRoom(code);
      setHint(null);
      setAttempted(true);
      // Put the code in the address bar first, so the link sitting in the URL
      // bar is the link worth sharing whether or not the socket comes up.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("room", code);
        window.history.replaceState(null, "", url.toString());
      } catch {
        /* no history API — the copy buttons still hand over a good link. */
      }
      // No net system in this build at all: honest, and not fatal. The code
      // stands, the status line says solo, and DROP IN still works.
      if (!net) return;
      setJoining(true);
      try {
        await net.join(code, { name: name.trim() || "player", team });
      } catch {
        /* join() already swallows its own failures; this is belt and braces. */
      } finally {
        setJoining(false);
      }
    },
    [name, net, team],
  );

  // A pasted `?room=` link joins on its own. The net system has its own
  // auto-join for this, but it joins as "player" with no squad — this one
  // carries the name and team the player actually picked.
  useEffect(() => {
    if (autoJoined.current || !engine) return;
    const fromUrl = roomFromUrl();
    if (!fromUrl) return;
    autoJoined.current = true;
    void doJoin(fromUrl);
  }, [engine, doJoin]);

  const create = useCallback(() => {
    void doJoin(generateRoomCode());
  }, [doJoin]);

  // ---- clipboard --------------------------------------------------------

  const copy = useCallback((text: string, tag: string) => {
    const fallback = () => {
      // Older/locked-down browsers refuse `navigator.clipboard` outside a
      // secure context. A throwaway textarea still works there.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* nothing else to try; the text is on screen and selectable. */
      }
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) void p.catch(fallback);
      else fallback();
    } catch {
      fallback();
    }
    setCopied(tag);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1400);
  }, []);

  // ---- derived ----------------------------------------------------------

  const status: NetStatus = joining
    ? "connecting"
    : online
      ? "online"
      : attempted
        ? "solo"
        : "idle";

  const shareLink = useMemo(() => {
    if (!room) return "";
    try {
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("room", room);
      return url.toString();
    } catch {
      return `/soaked?room=${room}`;
    }
  }, [room]);

  const claudeCmd = `node scripts/dz-teammate.mjs --room ${room ?? "<CODE>"} --name Claude --team ${team}`;

  const enter = useCallback(() => {
    // Pointer lock must be requested from inside the gesture, so it goes
    // first; refreshing the presence meta afterwards is fire-and-forget.
    onDropIn();
    // Re-announce as the name/squad actually on screen. Doubles as a retry:
    // if the socket was down when they made the room, this is one more go.
    if (net && room) void net.join(room, { name: name.trim() || "player", team });
    writeStored(LS_NAME, name.trim() || "player");
    writeStored(LS_TEAM, team);
  }, [name, net, onDropIn, room, team]);

  const selfColor = squadColor(team);

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto overscroll-contain">
      {/* Midday pool light: sky at the top, sun haze at the horizon. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg,#3fb8ee 0%,#7fd8f5 32%,#c8efff 62%,#ffeeb8 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(64rem 30rem at 78% -8%, rgba(255,246,200,0.95), rgba(255,246,200,0) 70%)",
        }}
      />

      <div className="relative flex min-h-full flex-col items-center px-4 py-8 sm:px-6">
        {/* ---------------------------------------------------- title ---- */}
        <p className="text-[10px] font-semibold uppercase tracking-[0.5em] text-[#0b6a94]/80">
          The Vibeverse presents
        </p>
        <h1
          className="mt-2 text-6xl font-black italic tracking-tight text-[#04456b] drop-shadow-[0_3px_0_rgba(255,255,255,0.9)] sm:text-8xl"
          style={{ letterSpacing: "-0.02em" }}
        >
          {WATER.strings.modeName}
        </h1>
        <p className="mt-1 text-base font-bold uppercase tracking-[0.28em] text-[#0b6a94] sm:text-lg">
          {WATER.strings.modeTagline}
        </p>
        <p className="mt-3 max-w-xl text-center text-sm text-[#0a5677]/85">
          Ten soakers, a pocket full of water balloons and a glue gun that sticks two
          people together at the ankles. Nobody gets hurt — they get drenched.
        </p>

        <div className="mt-7 grid w-full max-w-4xl gap-4 md:grid-cols-2">
          {/* ------------------------------------------------ the room --- */}
          <section className="rounded-3xl bg-white/60 p-5 shadow-[0_18px_50px_-24px_rgba(3,90,140,0.75)] ring-1 ring-white/80 backdrop-blur-md">
            <h2 className="text-[11px] font-black uppercase tracking-[0.3em] text-[#0b6a94]">
              The room
            </h2>

            {room ? (
              <>
                <div className="mt-3 select-all break-all text-center font-mono text-3xl font-black tracking-[0.12em] text-[#04456b] sm:text-4xl">
                  {room}
                </div>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <button
                    onClick={() => copy(room, "code")}
                    className="rounded-full bg-gradient-to-r from-sky-500 to-cyan-400 px-5 py-2 text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-lg shadow-sky-500/30 transition hover:brightness-110"
                  >
                    {copied === "code" ? "copied!" : "copy code"}
                  </button>
                  <button
                    onClick={() => copy(shareLink, "link")}
                    className="rounded-full bg-white/80 px-5 py-2 text-[11px] font-black uppercase tracking-[0.2em] text-[#0b6a94] ring-1 ring-sky-300/70 transition hover:bg-white"
                  >
                    {copied === "link" ? "copied!" : "copy invite link"}
                  </button>
                </div>
                <p className="mt-2 text-center text-[11px] text-[#0a5677]/70">
                  Send that link. It drops them straight into this room.
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-[#0a5677]/80">
                Create a room and send the code to a friend, or type the code they
                sent you.
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doJoin(codeInput);
                }}
                placeholder="SPLASH-4B2"
                aria-label="Room code"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-xl bg-white/85 px-3 py-2 font-mono text-sm font-bold uppercase tracking-widest text-[#04456b] placeholder:text-[#0b6a94]/35 ring-1 ring-sky-300/70 outline-none focus:ring-2 focus:ring-sky-500"
              />
              <button
                onClick={() => void doJoin(codeInput)}
                disabled={joining}
                className="rounded-xl bg-[#04456b] px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-[#065f88] disabled:opacity-50"
              >
                join
              </button>
              <button
                onClick={create}
                disabled={joining}
                className="rounded-xl bg-white/80 px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] text-[#0b6a94] ring-1 ring-sky-300/70 transition hover:bg-white disabled:opacity-50"
              >
                create
              </button>
            </div>

            {hint && <p className="mt-2 text-[11px] font-semibold text-orange-700">{hint}</p>}

            {/* Connection state, always stated plainly. */}
            <p className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-[#0a5677]">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  status === "online"
                    ? "bg-emerald-500"
                    : status === "connecting"
                      ? "animate-pulse bg-amber-400"
                      : "bg-[#0b6a94]/40"
                }`}
              />
              {status === "online" && `connected — ${roster.length + 1} in the room`}
              {status === "connecting" && "reaching the lobby server…"}
              {status === "solo" && "playing solo — couldn't reach the lobby server"}
              {status === "idle" && "not in a room yet — you can still play solo"}
            </p>

            {/* ---------------------------------------- invite Claude --- */}
            <div className="mt-4 border-t border-sky-300/50 pt-3">
              <button
                onClick={() => setShowInvite((v) => !v)}
                className="w-full rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-400 px-4 py-2 text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110"
              >
                🤖 invite Claude to the squad
              </button>
              {showInvite && (
                <div className="mt-2">
                  <p className="text-[11px] text-[#0a5677]/80">
                    Claude joins as a real player. Run this in the repo:
                  </p>
                  <code className="mt-1 block select-all overflow-x-auto whitespace-pre rounded-lg bg-[#04314b] px-3 py-2 font-mono text-[10.5px] text-cyan-100">
                    {claudeCmd}
                  </code>
                  <button
                    onClick={() => copy(claudeCmd, "cmd")}
                    className="mt-2 rounded-full bg-white/80 px-4 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-[#0b6a94] ring-1 ring-sky-300/70 transition hover:bg-white"
                  >
                    {copied === "cmd" ? "copied!" : "copy command"}
                  </button>
                  {!room && (
                    <p className="mt-1 text-[10.5px] font-semibold text-orange-700">
                      Create or join a room first — the command needs the code.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* ------------------------------------------------- you + squad */}
          <section className="rounded-3xl bg-white/60 p-5 shadow-[0_18px_50px_-24px_rgba(3,90,140,0.75)] ring-1 ring-white/80 backdrop-blur-md">
            <h2 className="text-[11px] font-black uppercase tracking-[0.3em] text-[#0b6a94]">
              You
            </h2>
            <input
              value={name}
              onChange={(e) => {
                touchedName.current = true;
                setName(e.target.value.slice(0, 20));
              }}
              placeholder="your name"
              aria-label="Display name"
              maxLength={20}
              className="mt-2 w-full rounded-xl bg-white/85 px-3 py-2 text-sm font-bold text-[#04456b] placeholder:text-[#0b6a94]/35 ring-1 ring-sky-300/70 outline-none focus:ring-2 focus:ring-sky-500"
            />

            <h3 className="mt-4 text-[11px] font-black uppercase tracking-[0.3em] text-[#0b6a94]">
              Squad
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {SQUADS.map((s) => {
                const active = s.id === team;
                return (
                  <button
                    key={s.id}
                    onClick={() => setTeam(s.id)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-[11px] font-black uppercase tracking-[0.12em] transition ${
                      active
                        ? "bg-white text-[#04456b] shadow-md ring-2 ring-[#04456b]"
                        : "bg-white/45 text-[#0b6a94]/80 ring-1 ring-sky-300/50 hover:bg-white/75"
                    }`}
                  >
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full ring-2 ring-white"
                      style={{ background: squadColor(s.id) }}
                    />
                    <span className="truncate">
                      {s.emoji} {s.name}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10.5px] text-[#0a5677]/70">
              Same squad = you can't soak each other. {WATER.strings.squadMates.join(", ")}{" "}
              ride together.
            </p>

            {/* ------------------------------------------------- roster --- */}
            <h3 className="mt-4 text-[11px] font-black uppercase tracking-[0.3em] text-[#0b6a94]">
              In the room
            </h3>
            <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
              <li className="flex items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5">
                <span
                  className="h-3 w-3 shrink-0 rounded-full ring-2 ring-white"
                  style={{ background: selfColor }}
                />
                <span className="truncate text-[12.5px] font-bold text-[#04456b]">
                  {name.trim() || "player"}
                </span>
                <span className="ml-auto shrink-0 text-[9.5px] font-black uppercase tracking-[0.2em] text-[#0b6a94]/70">
                  you · {squadLabel(team)}
                </span>
              </li>
              {roster.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg bg-white/45 px-2.5 py-1.5"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full ring-2 ring-white"
                    style={{ background: squadColor(p.team ?? p.id) }}
                  />
                  <span className="truncate text-[12.5px] font-bold text-[#04456b]">
                    {p.name}
                  </span>
                  {p.agent && (
                    <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.15em] text-violet-700">
                      AI
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[9.5px] font-black uppercase tracking-[0.2em] text-[#0b6a94]/70">
                    {squadLabel(p.team)}
                  </span>
                </li>
              ))}
              {roster.length === 0 && (
                <li className="px-2.5 py-1.5 text-[11.5px] italic text-[#0a5677]/60">
                  {status === "online"
                    ? "nobody else yet — send them the code"
                    : "just you and the bots"}
                </li>
              )}
            </ul>
          </section>
        </div>

        {/* ------------------------------------------------- drop in ----- */}
        <div className="mt-7 flex w-full max-w-4xl flex-col items-center">
          {!ready ? (
            <div className="w-72">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/60">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-300 to-orange-400 transition-[width] duration-300"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-widest text-[#0a5677]/70">
                {progress.stage}…
              </p>
            </div>
          ) : (
            <button
              onClick={enter}
              className="rounded-full bg-gradient-to-r from-amber-300 via-orange-400 to-rose-400 px-12 py-3.5 text-sm font-black uppercase tracking-[0.28em] text-[#04314b] shadow-[0_12px_36px_-6px_rgba(251,146,60,0.7)] transition hover:brightness-110 active:scale-[0.98]"
            >
              Drop in
            </button>
          )}
          <p className="mt-2 text-[10.5px] uppercase tracking-[0.2em] text-[#0a5677]/60">
            click to lock the pointer — that's what turns the controls on
          </p>

          <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[11px] text-[#0a5677]/75 sm:grid-cols-3">
            {CONTROLS.map(([key, action]) => (
              <span key={key}>
                <b className="text-[#04456b]">{key}</b> {action}
              </span>
            ))}
          </div>
        </div>

        <Link
          to="/"
          className="mt-8 text-[11px] uppercase tracking-[0.3em] text-[#0a5677]/55 transition hover:text-[#04456b]"
        >
          ← back to the vibeverse
        </Link>
      </div>
    </div>
  );
}
