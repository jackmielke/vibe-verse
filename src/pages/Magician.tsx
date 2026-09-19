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
import { createVoiceSession, voiceBudget, type Engine, type LimitInfo, type VoiceBudget, type VoiceSession, type VoiceStatus } from "@/magician/voice/session";
import { DEFAULT_STATE, type WorldState } from "@/magician/state";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { COMPANIONS, findCompanion, readCompanion } from "@/magician/companions";
import { MODE_INFO, type GameHud, type GameModeId } from "@/magician/game/types";
import { Joystick } from "@/magician/ui/Joystick";
import { readRoom } from "@/magician/net";
import { createRecorder, type Recorder } from "@/magician/record";
import { DONATE_URL, loadSupporters, openDonate, recentlyDonated, signBoard, type Supporter } from "@/magician/support";
import { deviceId } from "@/magician/voice/session";
import { Button } from "@/components/ui/button";
import spiritGate from "@/assets/magician-spirit-gate.jpg";
import magicianQr from "@/assets/magician-qr.jpg.asset.json";

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
  const [budget, setBudget] = useState<VoiceBudget | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [limit, setLimit] = useState<LimitInfo | null>(null);
  const [ask, setAsk] = useState<null | { insistent: boolean }>(null);
  const [supporters, setSupporters] = useState<Supporter[]>([]);
  const [signName, setSignName] = useState("");
  const [signMsg, setSignMsg] = useState("");
  const [signed, setSigned] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const refreshSupporters = useCallback(async () => {
    const list = await loadSupporters();
    setSupporters(list);
    worldRef.current?.setSupporters(list.map((s) => (s.message ? `${s.name} · ${s.message}` : s.name)));
  }, []);
  const refreshSupportersRef = useRef(refreshSupporters);
  refreshSupportersRef.current = refreshSupporters;
  const [text, setText] = useState("");
  const [hudHidden, setHudHidden] = useState(false);
  const [companion, setCompanion] = useState<string>(() => readCompanion());
  const [game, setGame] = useState<GameHud | null>(null);
  const [showModes, setShowModes] = useState(false);
  const lastGameRef = useRef<string>("");
  const [peers, setPeers] = useState<{ names: string[]; connected: boolean }>({ names: [], connected: false });
  const statusRef = useRef<VoiceStatus>("idle");
  const startVoiceRef = useRef<() => void>(() => undefined);
  const recorderRef = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  // A phone: narrow, touch-first. The HUD folds into one menu and a stick.
  const [phone, setPhone] = useState<boolean>(() => (typeof window !== "undefined" ? window.matchMedia("(max-width: 640px), (pointer: coarse) and (max-width: 900px)").matches : false));
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px), (pointer: coarse) and (max-width: 900px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const invite = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", readRoom());
    const text = url.toString();
    const nav = navigator as Navigator & { share?: (d: { title: string; url: string }) => Promise<void> };
    if (nav.share) { void nav.share({ title: "Come to Hoshimura", url: text }).catch(() => undefined); return; }
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, []);
  const idRef = useRef(1);
  const lastFizzleRef = useRef(0);

  useWorldStamp("/magician", "The Magician");

  useEffect(() => {
    void voiceBudget().then((b) => {
      setAvailable(b ? b.configured : null);
      setBudget(b);
      if (b && b.secondsLeft !== null) setSecondsLeft(b.secondsLeft);
      if (b && b.secondsLeft !== null && b.secondsLeft <= 0 && b.configured) setLimit({ secondsUsed: b.secondsFree, secondsFree: b.secondsFree, payUrl: b.payUrl });
    });
  }, []);
  // The countdown ticks locally between the function's own reports.
  const counting = status === "live" && secondsLeft !== null;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setSecondsLeft((s) => (s === null ? s : Math.max(0, s - 1))), 1000);
    return () => clearInterval(t);
  }, [counting]);

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
      onPeers: (list, connected) => setPeers({ names: list.map((p) => p.name), connected }),
      onSelect: () => { if (statusRef.current === "idle" || statusRef.current === "closed" || statusRef.current === "error") startVoiceRef.current(); },
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
    }, {
      name: (() => { try { return localStorage.getItem("magician.name") ?? localStorage.getItem("lobby.name") ?? `visitor-${Math.floor(Math.random() * 900 + 100)}`; } catch { return "visitor"; } })(),
      talking: () => statusRef.current === "live",
      voiceLine: () => {
        const s = statusRef.current;
        if (s === "live") return "Listening. Just talk. Hold the trigger or pinch to leave VR.";
        if (s === "connecting") return "Connecting to Vibey…";
        if (s === "error") return "Voice failed. Take the headset off to see why.";
        return "Pinch or pull the trigger to talk to Vibey. Hold it to leave VR.";
      },
    });
    recorderRef.current = createRecorder(world.canvas(), () => [world.audioStream(), ...(sessionRef.current?.streams() ?? [])].filter((s): s is MediaStream => Boolean(s)));
    worldRef.current = world;
    world.wake();
    void refreshSupportersRef.current();
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
        onStatus: (s, d) => { setStatus(s); statusRef.current = s; setDetail(d ?? ""); if (s === "live") world.vibey.emote("Wave"); },
        onUserText: (t, final) => pushLine("you", t, final),
        onAssistantText: (t, final) => { pushLine("vibey", t, final); world.vibey.setCaption(t); },
        onToolCall: (name, args) => world.run(name, args).output,
        onSpeaking: (level) => world.vibey.setSpeaking(level),
        onListening: (on) => world.vibey.setListening(on),
        onBudget: (left) => setSecondsLeft(left),
        onLimit: (info) => { setLimit(info); setSecondsLeft(0); world.vibey.setCaption(info.day ? "The whole valley has talked itself hoarse for today. Type to me, or come back tomorrow." : "That is all my voice for now. Type to me."); },
        onOverFree: (insistent) => { if (!recentlyDonated()) setAsk({ insistent }); },
      },
    });
    sessionRef.current = session;
    try {
      await session.connect();
    } catch {
      /* status handler already reported it */
    }
  }, [engine, pushLine, status]);
  useEffect(() => { startVoiceRef.current = () => { void startVoice(); }; }, [startVoice]);

  const toggleRecording = useCallback(async () => {
    const r = recorderRef.current;
    if (!r) return;
    if (!r.recording()) { r.start(); setRecording(true); return; }
    const { blob, name } = await r.stop();
    setRecording(false);
    if (!blob.size) return;
    const file = new File([blob], name, { type: blob.type });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[]; title: string }) => Promise<void> };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try { await nav.share({ files: [file], title: "The Magician" }); return; } catch { /* fall through to download */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSeconds(Math.floor(recorderRef.current?.seconds() ?? 0)), 500);
    return () => clearInterval(t);
  }, [recording]);

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
    status === "connecting" ? "Connecting…" : status === "live" ? (micMuted ? "Mic muted" : secondsLeft !== null && secondsLeft > 0 && secondsLeft < 120 ? `Listening · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` : "Listening") : limit?.day ? "Voice resting today" : "Talk to Vibey";

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#1a1030] text-white">
      <div ref={hostRef} className="absolute inset-0" />

      {/* Out of minutes */}
      {entered && limit && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm" data-ui="1">
          <div className="max-w-md rounded-2xl border border-white/15 bg-[#1b1633]/95 p-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.4em] text-[#b98cff]">the magician</p>
            <h2 className="mt-3 font-serif text-3xl text-[#f3ecff]">{limit.day ? "The valley is resting its voice" : "Vibey's voice is resting"}</h2>
            <p className="mt-4 text-sm leading-relaxed text-[#cbbde6]">
              {limit.day
                ? "Everyone together has talked to Vibey for hours today, and every minute costs real money, so the voice sleeps until tomorrow. Everything else still works: type your wishes below, walk, play the games, share the link."
                : "The voice is unavailable for the moment. Type your wishes below; the valley still listens."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button onClick={() => { openDonate(); }} className="rounded-full bg-[#b98cff] px-5 py-2.5 text-[11px] font-medium uppercase tracking-[0.25em] text-[#1a1030]">Support the valley</button>
              <button onClick={() => setLimit(null)} className="rounded-full border border-white/25 px-5 py-2.5 text-[11px] uppercase tracking-[0.25em] text-white/80">Keep exploring</button>
            </div>
          </div>
        </div>
      )}

      {/* The gentle ask: free minutes are up, keep going, consider chipping in. */}
      {entered && ask && !limit && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 px-6 backdrop-blur-sm" data-ui="1">
          <div className="max-w-md rounded-2xl border border-white/15 bg-[#1b1633]/95 p-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.4em] text-[#b98cff]">the magician</p>
            <h2 className="mt-3 font-serif text-3xl text-[#f3ecff]">{ask.insistent ? "You have talked for an hour" : "Ten minutes, on the house"}</h2>
            <p className="mt-4 text-sm leading-relaxed text-[#cbbde6]">
              Every minute with Vibey costs real money on the other end. You are welcome to keep going, truly. If it made you smile, chip in whatever you like and your name goes on the board on the square, where everyone arrives.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button onClick={() => { openDonate(); setAsk(null); setShowSupport(true); }} className="rounded-full bg-[#b98cff] px-5 py-2.5 text-[11px] font-medium uppercase tracking-[0.25em] text-[#1a1030]">Chip in</button>
              <button onClick={() => setAsk(null)} className="rounded-full border border-white/25 px-5 py-2.5 text-[11px] uppercase tracking-[0.25em] text-white/80">Keep talking</button>
            </div>
          </div>
        </div>
      )}

      {/* The supporters' board, and the pen to sign it. */}
      {entered && showSupport && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm" data-ui="1" onClick={() => setShowSupport(false)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#1b1633]/95 p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[11px] uppercase tracking-[0.4em] text-[#b98cff]">supporters of hoshimura</p>
            <p className="mt-2 text-sm leading-relaxed text-[#cbbde6]">The voice runs on donations. Chip in any amount, then sign the board; the names stand on the square for everyone who arrives.</p>
            <div className="mt-3 flex gap-2">
              <a href={DONATE_URL} target="_blank" rel="noreferrer" onClick={() => openDonate()} className="rounded-full bg-[#b98cff] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.2em] text-[#1a1030]">Donate</a>
              <button onClick={() => setShowSupport(false)} className="rounded-full border border-white/25 px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-white/80">Close</button>
            </div>
            {!signed ? (
              <form
                className="mt-4 flex flex-col gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await signBoard(signName, signMsg, null, deviceId());
                  if (ok) { setSigned(true); void refreshSupporters(); worldRef.current?.vibey.setCaption(`${signName.trim()}, your name is on the board. Thank you.`); }
                }}
              >
                <input value={signName} onChange={(e) => setSignName(e.target.value)} maxLength={40} placeholder="Your name for the board" className="h-10 rounded-md border border-white/15 bg-black/30 px-3 text-sm text-white placeholder:text-white/40 outline-none" />
                <input value={signMsg} onChange={(e) => setSignMsg(e.target.value)} maxLength={140} placeholder="A line, if you like" className="h-10 rounded-md border border-white/15 bg-black/30 px-3 text-sm text-white placeholder:text-white/40 outline-none" />
                <button type="submit" disabled={!signName.trim()} className="h-10 rounded-md border border-[#73ffb8]/40 bg-[#73ffb8]/15 text-[11px] uppercase tracking-[0.2em] text-[#d8ffe9] disabled:opacity-40">Sign the board</button>
                <p className="text-[10px] text-white/40">Signing is on your honour; the board says "as told to us".</p>
              </form>
            ) : (
              <p className="mt-4 text-sm text-[#d8ffe9]">Signed. Thank you.</p>
            )}
            <ul className="mt-4 max-h-56 space-y-1.5 overflow-y-auto text-sm">
              {supporters.length === 0 && <li className="text-white/40">Nobody yet. Your name could be first.</li>}
              {supporters.map((s) => (
                <li key={s.id} className="text-[#e9ddff]"><span className="font-medium">{s.name}</span>{s.message ? <span className="text-white/60"> · {s.message}</span> : null}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Hit flash */}
      <div className="pointer-events-none absolute inset-0 z-30 bg-[#ff3b1f] transition-opacity duration-300" style={{ opacity: hitFlash * 0.45 }} />

      {!entered && (
        <div className="magician-splash absolute inset-0 z-20 flex items-center justify-center overflow-hidden px-5 py-16 sm:px-8">
          <img
            src={spiritGate}
            alt="A moonlit spirit gate in the mountains of Japan"
            width={1920}
            height={1080}
            className="magician-splash__scene absolute inset-0 h-full w-full object-cover"
          />
          <div className="magician-splash__veil absolute inset-0" />
          <div className="magician-splash__mist magician-splash__mist--one absolute inset-x-0 bottom-0 h-2/3" />
          <div className="magician-splash__mist magician-splash__mist--two absolute inset-x-0 bottom-0 h-1/2" />

          <div className="magician-splash__content relative z-10 flex w-full max-w-3xl flex-col items-center text-center">
            <p className="magician-splash__eyebrow text-[10px] font-medium tracking-[0.32em] sm:text-[11px]">星村 · Hoshimura</p>
            <h1 className="magician-splash__title mt-4 text-5xl font-medium sm:text-7xl lg:text-8xl">The Magician</h1>
            <div className="magician-splash__divider mt-5 h-px w-28" />
            <p className="magician-splash__premise mt-5 max-w-xl text-sm leading-relaxed sm:text-base">
              A quiet valley that listens. Speak softly, and the weather, lanterns, and forest will answer.
            </p>

            <div className="mt-7 w-full max-w-md">
              <p className="magician-splash__label mb-3 text-[9px] font-medium uppercase tracking-[0.3em]">Choose a voice</p>
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <Button
                  type="button"
                  variant="outline"
                onClick={() => setEngine("realtime")}
                  className={`magician-splash__engine h-auto min-h-14 flex-col rounded-sm px-3 py-3 ${engine === "realtime" ? "is-active" : ""}`}
              >
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Realtime 2.1</span>
                  <span className="mt-1 text-[9px] font-normal uppercase tracking-[0.16em] opacity-60">Immediate magic</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                onClick={() => setEngine("live")}
                  className={`magician-splash__engine h-auto min-h-14 flex-col rounded-sm px-3 py-3 ${engine === "live" ? "is-active" : ""}`}
              >
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Live 1</span>
                  <span className="mt-1 text-[9px] font-normal uppercase tracking-[0.16em] opacity-60">Experimental</span>
                </Button>
              </div>
            </div>

            <Button
              type="button"
              onClick={() => setEntered(true)}
              className="magician-splash__enter mt-6 h-14 rounded-sm px-10 text-[11px] font-semibold uppercase tracking-[0.32em] sm:px-14"
            >
              Enter Hoshimura
            </Button>
            <p className="magician-splash__help mt-5 max-w-lg text-[10px] leading-relaxed tracking-[0.08em] sm:text-[11px]">
              W A S D to walk · drag to look · space to jump · press Talk to cast
              {available === false && <span className="magician-splash__warning mt-2 block">Vibey's voice is sleeping here; the written spellbook still works.</span>}
              {budget && budget.configured && !budget.unlimited && budget.secondsLeft !== null && (
                <span className="mt-2 block">{budget.secondsLeft > 0 ? `${Math.ceil(budget.secondsLeft / 60)} free minutes of voice on this device, then it runs on donations` : "Your free minutes are used; keep going, and consider chipping in"}</span>
              )}
              {budget?.unlimited && <span className="magician-splash__unlimited mt-2 block">Signed in as an admin: no voice limit</span>}
            </p>
          </div>

          <div className="magician-splash__corner magician-splash__corner--top absolute left-5 top-5 h-10 w-10 sm:left-8 sm:top-8" aria-hidden="true" />
          <div className="magician-splash__corner magician-splash__corner--bottom absolute bottom-5 right-5 h-10 w-10 sm:bottom-8 sm:right-8" aria-hidden="true" />
          <a
            href="https://myvibeverse.com/magician"
            className="magician-splash__qr absolute bottom-5 left-5 z-20 hidden items-center gap-3 sm:flex sm:bottom-8 sm:left-8"
            aria-label="Open The Magician on another device"
          >
            <img src={magicianQr.url} alt="QR code for The Magician" className="h-16 w-16" />
            <span className="text-left text-[9px] uppercase leading-relaxed tracking-[0.18em]">Take the valley<br />with you</span>
          </a>
        </div>
      )}

      {entered && !hudHidden && (
        <>
          {/* Top-left: the place and its state. Sits under the app's home chip. */}
          <div className="pointer-events-none absolute left-4 top-16 z-10 select-none sm:left-5">
            <div className="font-serif text-xl text-white/90 drop-shadow sm:text-2xl">{state.title}</div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.2em] text-white/60">
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{clock}</span>
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{state.weather}</span>
              <span className="rounded-sm bg-black/30 px-2 py-0.5">{state.season}</span>
              {state.fireballs.on && <span className="rounded-sm bg-[#ff6a2a]/40 px-2 py-0.5">fireballs · {state.hits} hits</span>}
              {peers.connected && <span className="rounded-sm bg-[#73ffb8]/25 px-2 py-0.5" title={peers.names.join(", ")}>{peers.names.length + 1} in the valley</span>}
            </div>
          </div>

          {/* Top-right: VR, sound, out */}
          <div className="absolute right-3 top-3 z-10 flex flex-wrap items-center justify-end gap-1.5 sm:right-5 sm:top-4 sm:gap-2" data-ui="1">
            <div ref={vrSlot} className="[&>button]:!rounded-sm [&>button]:!border [&>button]:!border-white/30 [&>button]:!bg-black/30 [&>button]:!px-3 [&>button]:!py-1.5 [&>button]:!text-[10px] [&>button]:!uppercase [&>button]:!tracking-[0.2em] [&>button]:!text-white/80 [&>button]:!font-sans [&>button]:!opacity-100" />
            {phone && (
              <button onClick={() => setMenuOpen((m) => !m)} className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70">
                {menuOpen ? "close" : "menu"}
              </button>
            )}
            <button
              onClick={() => (game ? worldRef.current?.stopGame() : setShowModes(true))}
              className={`rounded-sm border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] ${game ? "border-[#ff8a9a]/60 bg-[#ff8a9a]/20 text-[#ffd0d6]" : "border-[#b98cff]/60 bg-[#b98cff]/20 text-[#f3ecff] hover:bg-[#b98cff]/40"}`}
            >
              {game ? "end game" : "play"}
            </button>
            {!phone && (<>
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
            <button onClick={invite} className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
              {copied ? "link copied" : "invite"}
            </button>
            <button onClick={() => void toggleRecording()} className={`rounded-sm border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] ${recording ? "border-[#ff5a5a] bg-[#ff5a5a]/25 text-[#ffd0d0]" : "border-white/20 bg-black/30 text-white/70 hover:text-white"}`}>
              {recording ? `● ${recSeconds}s stop` : "record"}
            </button>
            <button onClick={() => setShowSupport(true)} className="rounded-sm border border-[#73ffb8]/40 bg-[#73ffb8]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-[#d8ffe9] hover:bg-[#73ffb8]/30">
              support
            </button>
            <Link to="/" className="rounded-sm border border-white/20 bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-white">
              out
            </Link>
            </>)}
          </div>

          {/* Phone menu: everything that is not walking, talking or playing. */}
          {phone && menuOpen && (
            <div className="absolute right-3 top-14 z-20 w-64 rounded-xl border border-white/15 bg-[#1b1633]/95 p-3 text-sm text-[#e9ddff] backdrop-blur-md" data-ui="1">
              <label className="block text-[10px] uppercase tracking-[0.2em] text-white/50">Companion</label>
              <select
                value={companion}
                onChange={(e) => { setCompanion(e.target.value); worldRef.current?.store.become(e.target.value); }}
                className="mt-1 h-9 w-full rounded-md border border-white/20 bg-black/30 px-2 text-sm text-white outline-none"
              >
                {COMPANIONS.map((c) => (
                  <option key={c.id} value={c.id} className="bg-[#1a1030] text-white">{c.emoji} {c.label}</option>
                ))}
              </select>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] uppercase tracking-[0.15em]">
                <button onClick={() => setMuted((m) => !m)} className="rounded-md border border-white/20 bg-black/30 px-2 py-2 text-white/80">{muted ? "sound off" : "sound on"}</button>
                <button onClick={invite} className="rounded-md border border-[#73ffb8]/40 bg-[#73ffb8]/15 px-2 py-2 text-[#d8ffe9]">{copied ? "copied" : "invite"}</button>
                <button onClick={() => void toggleRecording()} className={`col-span-2 rounded-md border px-2 py-2 ${recording ? "border-[#ff5a5a] bg-[#ff5a5a]/25 text-[#ffd0d0]" : "border-white/20 bg-black/30 text-white/80"}`}>{recording ? `● recording ${recSeconds}s · stop and share` : "record a clip"}</button>
                <button onClick={() => { setShowSupport(true); setMenuOpen(false); }} className="col-span-2 rounded-md border border-[#73ffb8]/40 bg-[#73ffb8]/15 px-2 py-2 text-[#d8ffe9]">support the valley · the board</button>
                <button onClick={() => { setHudHidden(true); setMenuOpen(false); }} className="rounded-md border border-white/20 bg-black/30 px-2 py-2 text-white/80">hide hud</button>
                <Link to="/" className="rounded-md border border-white/20 bg-black/30 px-2 py-2 text-center text-white/80">leave</Link>
              </div>
              <div className="mt-3 text-[11px] leading-relaxed text-white/50">
                {peers.connected ? `${peers.names.length + 1} in the valley${peers.names.length ? `: you, ${peers.names.join(", ")}` : ""}` : "playing alone"} · {engine === "live" ? "gpt-live-1" : "gpt-realtime-2.1"} · {findCompanion(companion).label}
              </div>
              <div className="mt-2 text-[11px] text-white/40">Left stick walks · drag the right side to look · pinch to zoom</div>
            </div>
          )}

          {phone && recording && !menuOpen && (
            <button onClick={() => void toggleRecording()} data-ui="1" className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-[#ff5a5a] bg-[#ff5a5a]/30 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#ffd0d0]">
              ● {recSeconds}s · stop
            </button>
          )}

          {/* Phone: stick and buttons */}
          {phone && (
            <>
              <div className="absolute bottom-[12.5rem] left-4 z-10" data-ui="1">
                <Joystick onMove={(x, y) => worldRef.current?.setStick(x, y)} />
              </div>
              <div className="absolute bottom-[12.5rem] right-4 z-10 flex flex-col items-end gap-2" data-ui="1">
                {game && !game.over && (
                  <button
                    onPointerDown={(e) => { e.preventDefault(); worldRef.current?.fire(); }}
                    className="h-16 w-16 rounded-full border border-[#b98cff]/60 bg-[#b98cff]/30 text-[10px] uppercase tracking-[0.15em] text-white backdrop-blur-sm"
                  >
                    shoot
                  </button>
                )}
                <button
                  onPointerDown={(e) => { e.preventDefault(); worldRef.current?.jump(); }}
                  className="h-14 w-14 rounded-full border border-white/25 bg-black/30 text-[10px] uppercase tracking-[0.15em] text-white/80 backdrop-blur-sm"
                >
                  jump
                </button>
              </div>
            </>
          )}

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
              {lines.slice(phone ? -2 : -4).map((l) => (
                <div key={l.id} className={`max-w-[85%] rounded-lg px-3 py-1.5 backdrop-blur-sm ${l.who === "you" ? "self-end bg-white/15 text-white/90" : "self-start bg-[#1b1633]/70 text-[#e9ddff]"}`}>
                  <span className="mr-1.5 text-[10px] uppercase tracking-[0.2em] opacity-60">{l.who === "you" ? "you" : "vibey"}</span>
                  {l.text}
                </div>
              ))}
            </div>
            {status === "error" && detail && <div className="max-w-xl rounded-md bg-[#5a1a1a]/80 px-3 py-1.5 text-xs text-[#ffd0c8]">{detail}</div>}
            <div className="flex w-full max-w-xl items-center gap-2">
              <button
                onClick={() => (limit?.day ? setLimit({ ...limit }) : void startVoice())}
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
            <div className={`max-w-xl gap-1.5 ${phone ? "flex w-full overflow-x-auto whitespace-nowrap pb-1 [scrollbar-width:none]" : "flex flex-wrap justify-center"}`}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    const world = worldRef.current;
                    if (!world) return;
                    if (sessionRef.current && status === "live") sessionRef.current.sendText(s);
                    else { pushLine("you", s, true); const r = world.cast(s); const msg = r.map((x) => x.output).join(" "); world.vibey.setCaption(msg); pushLine("vibey", msg, true); }
                  }}
                  className="shrink-0 rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-white/60 hover:border-white/30 hover:text-white"
                >
                  {s}
                </button>
              ))}
            </div>
            {!phone && (
              <div className="text-[10px] tracking-wide text-white/35">
                {status === "live" && detail ? detail : engine === "live" ? "gpt-live-1" : "gpt-realtime-2.1"} · {findCompanion(companion).label} beside you · say "become a wizard" · click the world to look around
              </div>
            )}
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
