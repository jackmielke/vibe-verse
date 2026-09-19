/**
 * The Magician — `/magician`.
 *
 * A thin page. It owns the way in, the voice session, and a HUD that stays
 * out of the way; the valley itself lives in `src/magician/`.
 *
 * The one rule of the HUD: everything Vibey says also appears as a caption
 * *in the world*, above Vibey's head, because the HUD does not exist in VR
 * and the headset is where this is meant to be played.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createMagician, type MagicianWorld } from "@/magician/world/Magician";
import { createVoiceSession, voiceAvailable, type Engine, type VoiceSession, type VoiceStatus } from "@/magician/voice/session";
import { DEFAULT_STATE, type WorldState } from "@/magician/state";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { COMPANIONS, findCompanion, readCompanion } from "@/magician/companions";
import { MODE_INFO, type GameHud, type GameModeId } from "@/magician/game/types";

interface Line { who: "you" | "vibey"; text: string; final: boolean; id: number }

const SUGGESTIONS = [
  "make it rain",
  "sunset, please",
  "a cherry forest around me",
  "snow",
  "northern lights",
  "attack me with fireballs",
  "purple sky",
  "take me to the shrine",
  "let's play oni siege",
  "become a wizard",
];

export default function Magician() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<MagicianWorld | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const vrSlot = useRef<HTMLDivElement>(null);
  const [params] = useSearchParams();
  const [entered, setEntered] = useState(false);
  const [engine, setEngine] = useState<Engine>(() => (params.get("engine") === "live" ? "live" : "realtime"));
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState<string>("");
  const [lines, setLines] = useState<Line[]>([]);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const [state, setState] = useState<WorldState>(DEFAULT_STATE);
  const [hitFlash, setHitFlash] = useState(0);
  const [muted, setMuted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null); // null: unknown, not no
  const [text, setText] = useState("");
  const [hudHidden, setHudHidden] = useState(false);
  const [companion, setCompanion] = useState<string>(() => readCompanion());
  const [game, setGame] = useState<GameHud | null>(null);
  const [showModes, setShowModes] = useState(false);
  const lastGameRef = useRef<string>("");
  const idRef = useRef(1);
  const lastFizzleRef = useRef(0);

  useWorldStamp("/magician", "The Magician");

  useEffect(() => {
    void voiceAvailable().then(setAvailable);
  }, []);

  const pushLine = useCallback((who: Line["who"], text: string, final: boolean) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.who === who && !last.final) {
        const next = prev.slice(0, -1);
        next.push({ ...last, text, final });
        return next.slice(-8);
      }
      if (!text.trim()) return prev;
      return [...prev, { who, text, final, id: idRef.current++ }].slice(-8);
    });
  }, []);

  // ---- world ------------------------------------------------------------
  useEffect(() => {
    if (!entered) return;
    const host = hostRef.current;
    if (!host) return;
    const world = createMagician(host, {
      onToast: (t) => {
        const id = idRef.current++;
        setToasts((prev) => [...prev, { id, text: t }].slice(-4));
        setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 2600);
      },
      onHit: (hits) => {
        setHitFlash(1);
        setTimeout(() => setHitFlash(0), 260);
        if (hits === 1 || hits % 4 === 0) sessionRef.current?.notify(`A fireball just hit the visitor (${hits} hits so far). React in one short line; offer to stop them or to make it rain.`);
      },
      onFizzle: () => {
        const now = Date.now();
        if (now - lastFizzleRef.current > 20000) {
          lastFizzleRef.current = now;
          sessionRef.current?.notify("The wet weather just put a fireball out mid-air with a hiss of steam. Mention it in one short, pleased line.");
        }
      },
      onState: (s) => setState(s),
      onCompanion: (id) => setCompanion(id),
      onNotify: (text) => sessionRef.current?.notify(text),
      onGame: (h) => {
        // The HUD object is rebuilt every frame; only re-render React when the
        // visible numbers change.
        const key = h ? `${h.mode}|${h.objective}|${h.score}|${h.hearts}|${h.timer == null ? "" : Math.ceil(h.timer)}|${h.detail ?? ""}|${h.over}|${Math.ceil(h.shield)}|${Math.ceil(h.blast)}` : "";
        if (key !== lastGameRef.current) { lastGameRef.current = key; setGame(h ? { ...h } : null); }
      },
    });
    worldRef.current = world;
    world.wake();
    setState(world.getState());
    // Only offer VR where a headset can actually answer; three's button
    // otherwise sits there saying "VR NOT SUPPORTED" in a HUD that is
    // already tight on a phone.
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
    void xr?.isSessionSupported("immersive-vr").then((ok) => {
      if (!ok || !vrSlot.current || worldRef.current !== world) return;
      vrSlot.current.innerHTML = "";
      const b = world.vrButton();
      b.setAttribute("data-ui", "1");
      vrSlot.current.appendChild(b);
    }).catch(() => undefined);
    return () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      world.dispose();
      worldRef.current = null;
    };
  }, [entered]);

  useEffect(() => { worldRef.current?.setMuted(muted); }, [muted]);
  useEffect(() => { sessionRef.current?.setMuted(micMuted); }, [micMuted]);

  // ---- voice -----------------------------------------------------------------
  const startVoice = useCallback(async () => {
    const world = worldRef.current;
    if (!world) return;
    if (sessionRef.current && (status === "live" || status === "connecting")) {
      sessionRef.current.disconnect();
      sessionRef.current = null;
      return;
    }
    const session = createVoiceSession({
      engine,
      handlers: {
        onStatus: (s, d) => { setStatus(s); setDetail(d ?? ""); if (s === "live") world.vibey.emote("Wave"); },
        onUserText: (t, final) => pushLine("you", t, final),
        onAssistantText: (t, final) => { pushLine("vibey", t, final); world.vibey.setCaption(t); },
        onToolCall: (name, args) => world.run(name, args).output,
        onSpeaking: (level) => world.vibey.setSpeaking(level),
        onListening: (on) => world.vibey.setListening(on),
      },
    });
    sessionRef.current = session;
    try {
      await session.connect();
    } catch {
      /* status handler already reported it */
    }
  }, [engine, pushLine, status]);

  const submitText = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const world = worldRef.current;
      const t = text.trim();
      if (!world || !t) return;
      setText("");
      if (sessionRef.current && status === "live") {
        sessionRef.current.sendText(t);
        return;
      }
      pushLine("you", t, true);
      const results = world.cast(t);
      if (results.length === 0) {
        const msg = available === false
          ? "Without my voice I only know simple spells. Try: make it rain, sunset, snow, a forest around me."
          : "I only know simple spells by text. Press Talk and ask me anything.";
        world.vibey.setCaption(msg);
        pushLine("vibey", msg, true);
      } else {
        const msg = results.map((r) => r.output).join(" ");
        world.vibey.setCaption(msg);
        pushLine("vibey", msg, true);
        world.vibey.emote(results.length > 1 ? "Dance" : "Yes");
      }
    },
    [text, status, available, pushLine],
  );

  const clock = useMemo(() => {
    const h = Math.floor(state.timeOfDay);
    const m = Math.floor((state.timeOfDay - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }, [state.timeOfDay]);

  const talkLabel =
    status === "connecting" ? "Connecting…" : status === "live" ? (micMuted ? "Mic muted" : "Listening") : "Talk to Vibey";

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#1a1030] text-white">
      <div ref={hostRef} className="absolute inset-0" />

      {/* Hit flash */}
      <div className="pointer-events-none absolute inset-0 z-30 bg-[#ff3b1f] transition-opacity duration-300" style={{ opacity: hitFlash * 0.45 }} />

      {!entered && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-b from-[#1a1030] via-[#231645] to-[#0d0a1c] px-6">
          <div className="max-w-md text-center">
            <p className="text-[11px] uppercase tracking-[0.45em] text-[#b98cff]">the vibeverse</p>
            <h1 className="mt-4 font-serif text-5xl font-light tracking-tight text-[#f3ecff] sm:text-6xl">The Magician</h1>
            <p className="mt-6 text-sm leading-relaxed text-[#cbbde6]">
              A valley village in the mountains of Japan, and Vibey floating beside you in a wizard's hat. Say what you want
              the world to be and it becomes it, while you watch: rain, midnight, a cherry forest, fireballs from the mountain.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-[#8f7fb0]">
              Real voice, real-time, over OpenAI's newest voice models. Works flat, on a phone, and in a headset.
            </p>
            <div className="mt-8 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.2em]">
              <button
                onClick={() => setEngine("realtime")}
                className={`rounded-sm border px-3 py-1.5 transition ${engine === "realtime" ? "border-[#b98cff] bg-[#b98cff]/20 text-[#f3ecff]" : "border-[#4a3a6a] text-[#8f7fb0] hover:text-[#cbbde6]"}`}
              >
                Realtime 2.1
              </button>
              <button
                onClick={() => setEngine("live")}
                className={`rounded-sm border px-3 py-1.5 transition ${engine === "live" ? "border-[#b98cff] bg-[#b98cff]/20 text-[#f3ecff]" : "border-[#4a3a6a] text-[#8f7fb0] hover:text-[#cbbde6]"}`}
              >
                Live 1 · new
              </button>
            </div>
            <button
              onClick={() => setEntered(true)}
              className="mt-8 rounded-sm border border-[#b98cff] px-9 py-3 text-xs font-medium uppercase tracking-[0.3em] text-[#f3ecff] transition hover:bg-[#b98cff] hover:text-[#1a1030]"
            >
              Enter the valley
            </button>
            <p className="mt-7 text-[11px] tracking-wide text-[#6f5f90]">
              W A S D to walk · drag to look · space to jump · then press Talk
              {available === false && <span className="block mt-2 text-[#ff9a7a]">Vibey's voice is not connected on this deploy (no OpenAI key); the spellbook still works by text.</span>}
            </p>
          </div>
        </div>
      )}

      {entered && !hudHidden && (
        <>
          {/* Top-left: the place and its state. Sits under the app's home chip. */}
          <div className="pointer-events-none absolute left-4 top-16 z-10 select-none sm:left-5">
            <div className="font-serif text-2xl text-white/90 drop-shadow">{state.title}</div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.2em] text-white/60">
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{clock}</span>
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{state.weather}</span>
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{state.season}</span>
              {state.fireballs.on && <span className="rounded-sm bg-[#ff6a2a]/40 px-2 py-0.5">fireballs · {state.hits} hits</span>}
            </div>
          </div>

          {/* Top-right: VR, sound, out */}
          <div className="absolute right-3 top-3 z-10 flex flex-wrap items-center justify-end gap-1.5 sm:right-5 sm:top-4 sm:gap-2" data-ui="1">
            <div ref={vrSlot} className="[&>button]:!rounded-sm [&>button]:!border [&>button]:!border-white/30 [&>button]:!bg-black/30 [&>button]:!px-3 [&>button]:!py-1.5 [&>button]:!text-[10px] [&>button]:!uppercase [&>button]:!tracking-[0.2em] [&>button]:!text-white/80 [&>button]:!font-sans [&>button]:!opacity-100" />
            <button
              onClick={() => (game ? worldRef.current?.stopGame() : setShowModes(true))}
              className={`rounded-sm border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] ${game ? "border-[#ff8a9a]/60 bg-[#ff8a9a]/20 text-[#ffd0d6]" : "border-[#b98cff]/60 bg-[#b98cff]/20 text-[#f3ecff] hover:bg-[#b98cff]/40"}`}
            >
              {game ? "end game" : "play"}
            </button>
            <select
              value={companion}
              onChange={(e) => { setCompanion(e.target.value); worldRef.current?.store.become(e.target.value); }}
              title="Who floats beside you"
              className="h-7 max-w-[9rem] rounded-sm border border-white/20 bg-black/30 px-2 text-[10px] uppercase tracking-[0.15em] text-white/80 outline-none"
            >
              {COMPANIONS.map((c) => (
                <option key={c.id} value={c.id} className="bg-[#1a1030] text-white">{c.emoji} {c.label}</option>
              ))}
            </select>
            <button onClick={() => setMuted((m) => !m)} className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
              {muted ? "sound off" : "sound on"}
            </button>
            <button onClick={() => setHudHidden(true)} className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
              hide
            </button>
            <Link to="/" className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
              out
            </Link>
          </div>

          {/* Game HUD */}
          {game && (
            <div className="pointer-events-none absolute left-1/2 top-16 z-10 w-[min(92vw,34rem)] -translate-x-1/2 sm:top-4">
              <div className="rounded-lg bg-black/40 px-4 py-2 text-center backdrop-blur-sm">
                <div className="flex items-center justify-center gap-3 text-[10px] uppercase tracking-[0.25em] text-white/60">
                  <span>{MODE_INFO[game.mode ?? "siege"].emoji} {game.title}</span>
                  <span className="text-[#ff8a9a]">{"♥".repeat(game.hearts)}<span className="text-white/25">{"♥".repeat(Math.max(0, game.maxHearts - game.hearts))}</span></span>
                  <span className="tabular-nums text-[#ffe08a]">{game.score} pts</span>
                  {game.timer != null && <span className="tabular-nums">{Math.ceil(game.timer)}s</span>}
                </div>
                <div className="mt-1 text-sm text-[#f3ecff]">{game.objective}</div>
                {game.detail && <div className="text-[11px] text-white/55">{game.detail}</div>}
                <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/45">
                  🛡 {game.shield > 0 ? `${Math.ceil(game.shield)}s` : game.shield < 0 ? `${Math.ceil(-game.shield)}s` : "ready"} · 💥 {game.blast < 0 ? `${Math.ceil(-game.blast)}s` : "ready"} · say "shield me" or "blast them"
                </div>
              </div>
              {game.over && (
                <div className="pointer-events-auto mt-2 flex justify-center gap-2" data-ui="1">
                  <button onClick={() => worldRef.current?.startGame(game.mode ?? "siege")} className="rounded-full bg-[#b98cff] px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] text-[#1a1030]">play again</button>
                  <button onClick={() => worldRef.current?.stopGame()} className="rounded-full border border-white/25 bg-black/30 px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white/80">free play</button>
                </div>
              )}
            </div>
          )}

          {/* Mode picker */}
          {showModes && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 px-4" data-ui="1" onClick={() => setShowModes(false)}>
              <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3" onClick={(e) => e.stopPropagation()}>
                {(Object.keys(MODE_INFO) as GameModeId[]).map((id) => (
                  <button
                    key={id}
                    onClick={() => { worldRef.current?.startGame(id); setShowModes(false); }}
                    className="rounded-xl border border-white/15 bg-[#1b1633]/85 p-4 text-left backdrop-blur-sm transition hover:border-[#b98cff]"
                  >
                    <div className="text-2xl">{MODE_INFO[id].emoji}</div>
                    <div className="mt-1 font-serif text-xl text-[#f3ecff]">{MODE_INFO[id].title}</div>
                    <div className="mt-2 text-xs leading-relaxed text-[#cbbde6]">{MODE_INFO[id].blurb}</div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-[#8f7fb0]">{MODE_INFO[id].tip}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Spell toasts */}
          <div className="pointer-events-none absolute left-1/2 top-16 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
            {toasts.map((t) => (
              <div key={t.id} className="rounded-full bg-[#b98cff]/25 px-3 py-1 text-[11px] tracking-wide text-[#f3ecff] backdrop-blur-sm">✨ {t.text}</div>
            ))}
          </div>

          {/* Bottom: transcript, talk, type */}
          <div className="absolute bottom-0 left-0 right-0 z-10 flex flex-col items-center gap-2 px-4 pb-5" data-ui="1">
            <div className="pointer-events-none flex w-full max-w-xl flex-col gap-1 text-sm">
              {lines.slice(-4).map((l) => (
                <div key={l.id} className={`max-w-[85%] rounded-lg px-3 py-1.5 backdrop-blur-sm ${l.who === "you" ? "self-end bg-white/15 text-white/90" : "self-start bg-[#1b1633]/70 text-[#e9ddff]"}`}>
                  <span className="mr-1.5 text-[10px] uppercase tracking-[0.2em] opacity-60">{l.who === "you" ? "you" : "vibey"}</span>
                  {l.text}
                </div>
              ))}
            </div>
            {status === "error" && detail && <div className="max-w-xl rounded-md bg-[#5a1a1a]/80 px-3 py-1.5 text-xs text-[#ffd0c8]">{detail}</div>}
            <div className="flex w-full max-w-xl items-center gap-2">
              <button
                onClick={() => void startVoice()}
                disabled={available === false}
                className={`relative flex h-12 shrink-0 items-center gap-2 rounded-full px-5 text-xs font-medium uppercase tracking-[0.2em] transition disabled:opacity-40 ${
                  status === "live" ? "bg-[#73ffb8] text-[#0c2a1b]" : status === "connecting" ? "bg-[#b98cff]/60 text-white" : "bg-[#b98cff] text-[#1a1030] hover:bg-[#cdaaff]"
                }`}
              >
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${status === "live" ? "bg-[#0c2a1b] animate-pulse" : status === "connecting" ? "bg-white animate-ping" : "bg-[#1a1030]"}`} />
                {talkLabel}
              </button>
              {status === "live" && (
                <button onClick={() => setMicMuted((m) => !m)} className="h-12 rounded-full border border-white/20 bg-black/30 px-4 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
                  {micMuted ? "unmute" : "mute"}
                </button>
              )}
              <form onSubmit={submitText} className="flex flex-1 items-center">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={status === "live" ? "or type a wish…" : "type a wish: make it rain"}
                  className="h-12 w-full rounded-full border border-white/15 bg-black/35 px-5 text-sm text-white placeholder:text-white/40 outline-none backdrop-blur-sm focus:border-[#b98cff]"
                />
              </form>
            </div>
            <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    const world = worldRef.current;
                    if (!world) return;
                    if (sessionRef.current && status === "live") sessionRef.current.sendText(s);
                    else { pushLine("you", s, true); const r = world.cast(s); const msg = r.map((x) => x.output).join(" "); world.vibey.setCaption(msg); pushLine("vibey", msg, true); }
                  }}
                  className="rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-white/60 hover:border-white/30 hover:text-white"
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="text-[10px] tracking-wide text-white/35">
              {engine === "live" ? "gpt-live-1" : "gpt-realtime-2.1"}{detail && status === "live" ? ` · ${detail}` : ""} · {findCompanion(companion).label} beside you · say "become a wizard" · click the world to look around
            </div>
          </div>
        </>
      )}
      {entered && hudHidden && (
        <button onClick={() => setHudHidden(false)} data-ui="1" className="absolute right-5 top-4 z-10 rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
          show
        </button>
      )}
    </div>
  );
}
