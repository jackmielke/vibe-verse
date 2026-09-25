/**
 * /oni: infection tag at a summer festival.
 *
 * Three ways in, one room:
 *  - a player on a laptop, a phone or a headset: name, character, join
 *  - `?show`: the projector. A camera circling the square from above, a big
 *    QR code that opens this page on a phone, the players, the clock, and a
 *    button to start the next round now.
 *  - `?bots=6`: practice against local players, no network at all.
 *
 * The engine is `src/oni/world/Oni.ts`; the rules are `src/oni/rules.ts`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { Joystick } from "@/magician/ui/Joystick";
import { qrPath } from "@/lib/qr";
import { findCharacter } from "@/lib/characters";
import { createOni, type FeedLine, type Hud, type OniEngine } from "@/oni/world/Oni";
import { readRoom } from "@/oni/net";
import { randomCharacter, readCharacter, readName, writeCharacter } from "@/oni/profile";
import { CharacterPortrait, JoinCard } from "@/oni/ui/JoinCard";
import { PhaseBanner } from "@/oni/ui/PhaseBanner";

function isPhone(): boolean {
  try {
    return window.matchMedia("(max-width: 640px)").matches || (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 900);
  } catch { return false; }
}

function params() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

function joinUrl(room: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://myvibeverse.com";
  return room === "matsuri" ? `${origin}/zombies` : `${origin}/zombies?room=${room}`;
}

function QrCode({ text, size }: { text: string; size: number }) {
  const { path, size: n } = useMemo(() => qrPath(text, 2), [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <path d={path} fill="#16121f" />
    </svg>
  );
}


export default function Oni() {
  useWorldStamp("/zombies", "Zombie Tag");
  const q = params();
  const watch = q.has("show");
  const bots = Math.max(0, Math.min(9, parseInt(q.get("bots") ?? "0", 10) || 0));
  const room = readRoom();
  const [phone] = useState(isPhone);
  const [joined, setJoined] = useState<{ name: string; char: string } | null>(() => {
    if (watch) return { name: "watcher", char: "toadstool" };
    // `?name=` is for scripts that open several players in one browser.
    const n = q.get("name") ?? readName();
    return q.has("go") && n ? { name: n.slice(0, 16), char: readCharacter() } : null;
  });
  const [char, setChar] = useState(() => joined?.char ?? readCharacter());
  const [hud, setHud] = useState<Hud | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [vr, setVr] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OniEngine | null>(null);
  const wasOni = useRef(false);

  useEffect(() => {
    if (!joined || !containerRef.current) return;
    const engine = createOni({
      container: containerRef.current,
      name: joined.name,
      char: joined.char,
      watch,
      bots,
      phone,
      onHud: setHud,
      onFeed: (l) => setFeed((f) => [...f.slice(-5), l]),
    });
    engineRef.current = engine;
    void engine.vrSupported().then(setVr);
    return () => { engine.dispose(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  // "You got caught" flash.
  useEffect(() => {
    const oni = !!hud?.me?.oni;
    if (oni && !wasOni.current && hud?.phase === "play") {
      setFlash("You got bitten! Now you're a zombie 🧟");
      const t = window.setTimeout(() => setFlash(null), 2200);
      wasOni.current = oni;
      return () => clearTimeout(t);
    }
    wasOni.current = oni;
  }, [hud?.me?.oni, hud?.phase]);

  // Old feed lines fade out.
  useEffect(() => {
    const t = window.setInterval(() => setFeed((f) => f.filter((l) => Date.now() - l.at < 9000)), 1000);
    return () => clearInterval(t);
  }, []);

  const shuffle = () => {
    const id = randomCharacter(char);
    setChar(id);
    writeCharacter(id);
    engineRef.current?.setChar(id);
  };

  // ---- the join screen -------------------------------------------------------------
  if (!joined) {
    return (
      <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center overflow-hidden px-4 py-10 text-white" style={{ background: "radial-gradient(120% 90% at 50% 0%, #6b3a5a 0%, #2a1a38 45%, #120c1c 100%)" }}>
        <div className="mb-1 text-sm tracking-[0.5em] text-[#b6ff9a]">🧟 · 🏃 · 🏃</div>
        <h1 className="font-heading text-5xl font-bold tracking-wide sm:text-6xl">ZOMBIE TAG</h1>
        <p className="mt-2 max-w-sm text-center text-sm text-white/65">Tag at a summer festival, with a twist: one zombie, and anyone it touches turns too. Last human standing wins.</p>
        <div className="mt-6 w-full max-w-sm rounded-3xl border border-white/10 bg-black/30 p-5 backdrop-blur">
          <JoinCard onJoin={(name, c) => { setChar(c); setJoined({ name, char: c }); }} size={phone ? 120 : 140} autoFocus={!phone} />
        </div>
        <div className="mt-4 text-xs text-white/40">Room: {room} · works on phones, laptops and VR headsets</div>
        <a href={`/zombies?bots=6${room !== "matsuri" ? `&room=${room}` : ""}`} className="mt-2 text-xs text-white/45 underline decoration-dotted underline-offset-4 hover:text-white/80">or practice against bots</a>
      </div>
    );
  }

  const phase = hud?.phase ?? "lobby";
  const meOni = !!hud?.me?.oni;
  const playing = phase === "play" || phase === "countdown";
  const others = (hud?.players.length ?? 1) - 1;
  const url = joinUrl(room);

  // ---- the projector ------------------------------------------------------------------
  if (watch) {
    return (
      <div className="fixed inset-0 overflow-hidden bg-[#120c1c] text-white">
        <div ref={containerRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-transparent to-black/45" />
        <div className="absolute left-6 top-20 flex flex-col items-start gap-4">
          <div>
            <div className="text-lg tracking-[0.5em] text-[#b6ff9a]">🧟 · 🏃 · 🏃</div>
            <div className="font-heading text-6xl font-bold leading-none">ZOMBIE TAG</div>
            <div className="mt-1 text-sm text-white/70">One zombie. Don't get bitten.</div>
          </div>
          <div className="rounded-2xl bg-white p-3 shadow-2xl">
            <QrCode text={url} size={260} />
          </div>
          <div className="text-xl font-semibold">Scan to play</div>
          <div className="font-mono text-base text-white/75">{url.replace(/^https?:\/\//, "")}</div>
        </div>

        <div className="absolute left-1/2 top-6 -translate-x-1/2 text-center">
          <PhaseBanner hud={hud} big />
        </div>

        <div className="absolute bottom-6 right-6 top-6 flex w-72 flex-col gap-3">
          <div className="rounded-2xl bg-black/45 p-4 backdrop-blur">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.25em] text-white/55">
              <span>{hud?.players.length ?? 0} playing</span>
              <span className={hud?.connected ? "text-[#8fe3a4]" : "text-[#ff9a8a]"}>{hud?.connected ? "live" : "offline"}</span>
            </div>
            <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
              {(hud?.players ?? []).map((p) => (
                <div key={p.id} className={`flex items-center gap-2 rounded-lg px-2 py-1 ${p.oni ? "bg-[#2f7a22]/70" : "bg-white/5"}`}>
                  <span className="text-lg">{p.oni ? "🧟" : findCharacter(p.char).emoji}</span>
                  <span className="truncate text-sm">{p.name}</span>
                </div>
              ))}
              {!hud?.players.length && <div className="text-sm text-white/50">Nobody yet. Scan the code!</div>}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {feed.slice(-5).map((l) => (
              <div key={l.at + l.text} className="rounded-lg bg-black/45 px-3 py-1.5 text-sm backdrop-blur">{l.text}</div>
            ))}
          </div>
          <div className="mt-auto flex gap-2">
            <button onClick={() => engineRef.current?.start()} disabled={(hud?.players.length ?? 0) < 2 || playing} className="flex-1 rounded-full bg-[#e8402c] px-4 py-3 text-sm font-semibold disabled:opacity-40">
              {playing ? "Round in progress" : "Start round now"}
            </button>
            <button onClick={() => { engineRef.current?.resumeAudio(); const m = !muted; setMuted(m); engineRef.current?.setMuted(m); }} className="rounded-full border border-white/25 px-4 text-sm">
              {muted ? "🔇" : "🔊"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- a player -----------------------------------------------------------------------
  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#120c1c] text-white" onPointerDown={() => engineRef.current?.resumeAudio()}>
      <div ref={containerRef} className="absolute inset-0" />
      {/* Red at the edges while you're oni. */}
      <div className="pointer-events-none absolute inset-0 transition-opacity duration-500" style={{ opacity: meOni ? 1 : 0, boxShadow: "inset 0 0 120px 30px rgba(60,190,40,0.55)" }} />

      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3" data-ui="1">
        <PhaseBanner hud={hud} big={false} />
      </div>

      {flash && (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 flex justify-center px-4">
          <div className="animate-in zoom-in-50 rounded-2xl bg-[#c8261e]/90 px-6 py-4 text-center text-xl font-bold shadow-2xl">{flash}</div>
        </div>
      )}

      {/* Top left, beside the global home button: who is here. */}
      <div className={`pointer-events-none absolute flex flex-col items-start gap-2 ${phone ? "left-3 top-24" : "left-16 top-4"}`}>
        <div className="rounded-full bg-black/40 px-3 py-1 text-[11px] text-white/70 backdrop-blur">
          {bots ? `practice · ${others} bots` : hud?.connected ? `${others + 1} here · ${room}` : "connecting…"}
        </div>
      </div>

      {/* Feed */}
      <div className={`pointer-events-none absolute right-3 flex max-w-[60vw] flex-col items-end gap-1 ${phone ? "top-24" : "top-3"}`}>
        {feed.slice(phone ? -3 : -5).map((l) => (
          <div key={l.at + l.text} className="rounded-lg bg-black/45 px-2.5 py-1 text-xs backdrop-blur sm:text-sm">{l.text}</div>
        ))}
      </div>

      {/* Bottom bar */}
      <div className="pointer-events-none absolute inset-x-0 flex items-end justify-between px-3 [&>*]:pointer-events-auto" style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }} data-ui="1">
        {phone ? (
          <Joystick onMove={(x, y) => engineRef.current?.setStick(x, y)} size={124} />
        ) : (
          <div className="rounded-xl bg-black/35 px-3 py-2 text-[11px] leading-relaxed text-white/60 backdrop-blur">
            Click the ground to run there, or WASD · drag to look · Space to jump · H to honk
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <button onClick={shuffle} title="Shuffle character" className="flex items-center gap-1.5 rounded-full border border-white/20 bg-black/40 py-1 pl-1 pr-3 text-xs backdrop-blur">
                <CharacterPortrait id={char} size={28} /> 🎲
              </button>
              <button onClick={() => setInvite((v) => !v)} className="rounded-full border border-white/20 bg-black/40 px-3 py-1 text-xs backdrop-blur">invite</button>
              <button onClick={() => { const m = !muted; setMuted(m); engineRef.current?.setMuted(m); }} className="rounded-full border border-white/20 bg-black/40 px-3 py-1 text-xs backdrop-blur">{muted ? "🔇" : "🔊"}</button>
              {vr && <button onClick={() => void engineRef.current?.enterVR()} className="rounded-full border border-[#8fb4ff]/50 bg-[#8fb4ff]/20 px-3 py-1 text-xs backdrop-blur">VR</button>}
            </div>
            {!playing && (hud?.players.length ?? 0) >= 2 && (
              <button onClick={() => engineRef.current?.start()} className="rounded-full bg-[#e8402c] px-4 py-2 text-xs font-semibold shadow-lg">Start round now</button>
            )}
          </div>
          {phone && (
            <div className="flex flex-col gap-2">
              <button onPointerDown={(e) => { e.preventDefault(); engineRef.current?.honk(); }} className="h-12 w-12 rounded-full border border-white/25 bg-black/35 text-xl backdrop-blur">📣</button>
              <button onPointerDown={(e) => { e.preventDefault(); engineRef.current?.jump(); }} className="h-16 w-16 rounded-full border border-white/30 bg-white/15 text-[11px] font-semibold uppercase tracking-[0.15em] backdrop-blur">jump</button>
            </div>
          )}
        </div>
      </div>

      {invite && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4" onClick={() => setInvite(false)} data-ui="1">
          <div className="flex flex-col items-center gap-3 rounded-3xl bg-[#1d1428] p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-semibold">Scan to join this square</div>
            <QrCode text={url} size={220} />
            <div className="font-mono text-xs text-white/60">{url.replace(/^https?:\/\//, "")}</div>
            <div className="flex gap-2">
              <button
                onClick={() => { if (navigator.share) void navigator.share({ title: "Play Zombie Tag with me", url }).catch(() => {}); else void navigator.clipboard?.writeText(url); }}
                className="rounded-full bg-[#e8402c] px-4 py-2 text-sm font-semibold"
              >
                Share link
              </button>
              <a href={`/zombies?show${room !== "matsuri" ? `&room=${room}` : ""}`} target="_blank" rel="noreferrer" className="rounded-full border border-white/25 px-4 py-2 text-sm">Projector view</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
