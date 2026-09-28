/**
 * `/magician?remote`: a phone as a wand.
 *
 * Scanned off the projector. A name, then a grid of big buttons; each one
 * runs the spell against the state this phone has heard from the room and
 * sends the patch, then signs it so the valley can say who did it. No
 * three.js, no voice, nothing to load but this page, which is the point: a
 * room of thirty phones on conference wifi.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { joinRoom, readNetMode, readRoom, type CastNote, type Room } from "../net";
import { castRemote, headlessStore, nowLine, REMOTE_COOLDOWN_S, REMOTE_SPELLS, REMOTE_START, type RemoteSpell } from "../remote";
import { applyPatch, type WorldState } from "../state";
import { readMemory } from "../memory";

interface FeedLine { id: number; text: string; mine: boolean }

function savedName(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("name");
    if (q) return q.slice(0, 16);
    return (localStorage.getItem("magician.name") ?? localStorage.getItem("oni.name") ?? readMemory().name ?? "").slice(0, 16);
  } catch { return ""; }
}

export function MagicianRemote() {
  const [name, setName] = useState(savedName);
  const [joined, setJoined] = useState(() => !!savedName() && new URLSearchParams(window.location.search).has("go"));
  const [connected, setConnected] = useState<boolean | null>(null);
  const [world, setWorld] = useState<WorldState>(REMOTE_START);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [cooldown, setCooldown] = useState(0);
  const [text, setText] = useState("");
  const stateRef = useRef<WorldState>(REMOTE_START);
  const roomRef = useRef<Room | null>(null);
  const idRef = useRef(1);

  const addFeed = useCallback((t: string, mine: boolean) => {
    const id = idRef.current++;
    setFeed((f) => [{ id, text: t, mine }, ...f].slice(0, 5));
  }, []);

  useEffect(() => {
    if (!joined) return;
    let alive = true;
    const set = (s: WorldState) => { stateRef.current = s; setWorld(s); };
    void joinRoom({
      mode: readNetMode(),
      room: readRoom(),
      name,
      onPatch: (p) => set(applyPatch(stateRef.current, p)),
      onFull: (s) => set(s),
      onPeers: () => {},
      // A phone only knows what it heard, so it never answers a newcomer.
      currentState: () => null,
      onCast: (note: CastNote) => addFeed(`${note.emoji} ${note.n} ${note.did}`, false),
    }).then((r) => {
      if (!alive) { r.close(); return; }
      roomRef.current = r;
      setConnected(r.connected);
    });
    return () => { alive = false; roomRef.current?.close(); roomRef.current = null; };
  }, [joined, name, addFeed]);

  // The cooldown ring.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, +(c - 0.1).toFixed(1))), 100);
    return () => clearTimeout(t);
  }, [cooldown]);

  const cast = useCallback((spell: RemoteSpell | string) => {
    if (cooldown > 0) return;
    const room = roomRef.current;
    const store = headlessStore(
      () => stateRef.current,
      (s) => { stateRef.current = s; setWorld(s); },
      (p) => room?.patch(p),
    );
    const who = name.trim() || "somebody";
    const r = castRemote(spell, store, who);
    if (!r.landed) { addFeed("🤔 the valley didn't understand that one", true); return; }
    room?.cast({ n: who, did: r.did, emoji: r.emoji });
    addFeed(`${r.emoji} you ${r.did}`, true);
    setCooldown(REMOTE_COOLDOWN_S);
    try { navigator.vibrate?.(30); } catch { /* no buzz */ }
  }, [cooldown, name, addFeed]);

  if (!joined) {
    return (
      <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-[radial-gradient(ellipse_at_top,#3a2440,#120c1c_70%)] px-6 text-[#ffe9c8]">
        <form
          className="flex w-full max-w-sm flex-col items-center gap-4 text-center"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim().slice(0, 16);
            if (!n) return;
            try { localStorage.setItem("magician.name", n); localStorage.setItem("oni.name", n); } catch { /* private mode */ }
            setName(n);
            setJoined(true);
          }}
        >
          <div className="text-5xl">🪄</div>
          <p className="text-[10px] uppercase tracking-[0.32em] text-[#ffe9c8]/60">星村 · Hoshimura</p>
          <h1 className="font-serif text-4xl">Cast on the big screen</h1>
          <p className="text-sm text-[#ffe9c8]/70">Your phone is a wand. Every spell lands in the valley on the projector, with your name on it.</p>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 16))}
            placeholder="Your name"
            maxLength={16}
            enterKeyHint="go"
            className="h-14 w-full rounded-lg border border-white/25 bg-black/35 px-4 text-center text-lg text-white outline-none placeholder:text-white/40 focus:border-[#ffd6a0]"
          />
          <button type="submit" disabled={!name.trim()} className="h-14 w-full rounded-lg bg-[#ffcf8a] text-sm font-semibold uppercase tracking-[0.25em] text-[#2a1a10] disabled:opacity-40">
            Start casting
          </button>
          <a href="/magician" className="text-xs text-[#ffe9c8]/50 underline">or walk into the valley yourself</a>
        </form>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#3a2440,#120c1c_70%)] text-[#ffe9c8]" data-remote="1">
      <header className="flex items-center justify-between gap-2 pb-2 pl-16 pr-4 pt-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-[#ffe9c8]/55">🪄 {name} · Hoshimura</div>
          <div className="mt-0.5 text-sm" data-now="1">{nowLine(world)}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${connected ? "bg-[#73ffb8]/15 text-[#bfffe0]" : connected === false ? "bg-[#ff9a8a]/15 text-[#ffc6bd]" : "bg-white/10 text-white/50"}`}>
          {connected ? "live" : connected === false ? "offline" : "joining"}
        </span>
      </header>

      <div className="relative mx-4 h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-[#ffcf8a] transition-[width] duration-100" style={{ width: `${(1 - cooldown / REMOTE_COOLDOWN_S) * 100}%` }} />
      </div>

      <div className="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto px-4 py-3">
        {REMOTE_SPELLS.map((s) => (
          <button
            key={s.id}
            data-spell={s.id}
            onClick={() => cast(s)}
            disabled={cooldown > 0}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border border-[#ffd9a0]/25 bg-[#2a1a10]/55 text-[#ffe9c8] shadow-[0_0_18px_rgba(255,180,90,0.12)] transition active:scale-95 disabled:opacity-45"
          >
            <span className="text-4xl leading-none">{s.emoji}</span>
            <span className="text-[11px] uppercase tracking-[0.12em]">{s.label}</span>
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(""); cast(t); }}
        className="flex gap-2 px-4 pb-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 80))}
          placeholder="or wish for something…"
          enterKeyHint="send"
          className="h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-black/35 px-3 text-[16px] text-white outline-none placeholder:text-white/40 focus:border-[#ffd6a0]"
        />
        <button type="submit" disabled={cooldown > 0 || !text.trim()} className="rounded-lg bg-[#ffcf8a] px-4 text-sm font-semibold text-[#2a1a10] disabled:opacity-40">cast</button>
      </form>

      <div className="flex min-h-[5.5rem] flex-col gap-1 px-4 pb-4 text-sm" data-feed="1">
        {feed.map((l) => (
          <div key={l.id} className={`truncate rounded-md px-2 py-1 ${l.mine ? "bg-[#ffcf8a]/15 text-[#fff1dc]" : "bg-white/5 text-white/75"}`}>{l.text}</div>
        ))}
        {!feed.length && <div className="text-xs text-white/40">Tap a spell. Watch the big screen.</div>}
      </div>
    </div>
  );
}
