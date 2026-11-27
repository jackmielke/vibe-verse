/**
 * /cannon-run: a night chase down a desert highway. You ride in the bed of a
 * pickup behind an old ship's cannon, looking back over the tailgate at Mad
 * Mort, who wants it back. The game is in src/cannonrun; this page is the
 * door, the garage, the two-player lobby, the HUD and the phone controls.
 *
 * Two players: "Two on one screen" is one keyboard. "Play with a friend"
 * hosts a room; the friend opens /cannon-run?room=CODE (the QR code) on a
 * phone or another computer. `&net=local` swaps Supabase Realtime for a
 * BroadcastChannel, which is how two tabs of one browser test it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Joystick } from "@/magician/ui/Joystick";
import { QrCode } from "@/oni/ui/QrCode";
import { Comic } from "@/cannonrun/Comic";
import { StoryBook } from "@/cannonrun/ui/StoryBook";
import { LOOKS, LookSwitcher, SplashLook, type Look } from "@/cannonrun/ui/Splash";
import type { CannonRun as Game, ChaseHud, Mode, RiderHud } from "@/cannonrun/engine";
import type { FinaleHud as FinaleHudT } from "@/cannonrun/finale";
import type { ReplayClip } from "@/cannonrun/replay";
import { shareClip } from "@/cannonrun/share";
import { openTransport, readBank, roomCode, writeBank, UPGRADES, UPGRADE_COST, type NetMode, type Transport, type Upgrades, type Wire } from "@/cannonrun/net";

const ZOOMS = [1, 1.35, 1.7];

type Screen = "story" | "comic" | "splash" | "garage" | "host" | "join" | "loading" | "playing" | "failed";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default function CannonRun() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const netMode: NetMode = params.get("net") === "local" ? "local" : "online";
  const joinCode = (params.get("room") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const hostCode = (params.get("host") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);

  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const guestUpRef = useRef<Upgrades | undefined>(undefined);
  const [mode, setMode] = useState<Mode>(() => (params.has("duo") ? "duo" : "solo"));
  const [screen, setScreen] = useState<Screen>(() =>
    joinCode ? "join" : hostCode ? "host" : params.has("comic") ? "comic" : params.has("story") ? "story" : params.has("go") || params.has("duo") || params.has("finale") ? "loading" : "splash",
  );
  const [hud, setHud] = useState<ChaseHud | null>(null);
  // the Gatch News reel, open over the end card
  const [reel, setReel] = useState(false);
  const loadReel = useCallback((): ReplayClip[] => gameRef.current?.replay() ?? [], []);
  const [aurora, setAurora] = useState<boolean>(() => {
    if (new URLSearchParams(window.location.search).has("aurora")) return true;
    try { return localStorage.getItem("cannonrun.sky") === "aurora"; } catch { return false; }
  });
  const auroraRef = useRef(aurora);
  auroraRef.current = aurora;
  // Thanksgiving dress-up: on by itself in Thanksgiving week, unless switched off
  const [thanks, setThanks] = useState<boolean>(() => {
    if (new URLSearchParams(window.location.search).has("thanksgiving")) return true;
    let saved: string | null = null;
    try { saved = localStorage.getItem("cannonrun.thanks"); } catch { /* private window */ }
    if (saved) return saved === "on";
    const d = new Date();
    return d.getMonth() === 10 && d.getDate() >= 20;
  });
  const thanksRef = useRef(thanks);
  // Outer space: Mort boarded a rocket to get his blaster back (?space, or the 🚀 chip)
  const [space, setSpace] = useState<boolean>(() => {
    if (new URLSearchParams(window.location.search).has("space")) return true;
    try { return localStorage.getItem("cannonrun.space") === "on"; } catch { return false; }
  });
  const spaceRef = useRef(space);
  spaceRef.current = space;

  thanksRef.current = thanks;
  const [muted, setMuted] = useState(false);
  // how far back the camera sits, remembered on this device
  const [zoom, setZoomState] = useState<number>(() => { try { const z = Number(localStorage.getItem("cannonrun.zoom")); return ZOOMS.includes(z) ? z : window.matchMedia?.("(pointer: coarse)").matches ? 1.35 : 1; } catch { return 1; } });
  const setZoom = (z: number): void => { setZoomState(z); gameRef.current?.setZoom(z); try { localStorage.setItem("cannonrun.zoom", String(z)); } catch { /* fine */ } };
  useEffect(() => { if (screen === "playing") gameRef.current?.setZoom(zoom); }, [screen, zoom]);
  const [bank, setBank] = useState(() => readBank());
  const [earned, setEarned] = useState<number | null>(null);
  const [room, setRoom] = useState(hostCode || joinCode);
  const [lobbyNote, setLobbyNote] = useState("");
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  const bare = params.has("shot");
  // The highlight reel is the start screen (Jack's pick, 2026-11-26). ?look=news|wanted|comic|classic still previews the others, with a switcher.
  const [look, setLook] = useState<Look | "classic" | null>(() => {
    const l = params.get("look");
    return l === null ? "reel" : (LOOKS as readonly string[]).includes(l) ? (l as Look) : "classic";
  });
  const pickLook = (l: Look | "classic"): void => {
    setLook(l);
    const u = new URL(window.location.href);
    u.searchParams.set("look", l);
    window.history.replaceState(null, "", u.toString());
  };
  const screenRef = useRef(screen);
  screenRef.current = screen;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  /* --------------------------------------------------------- the lobby */
  // Hosting: open the room and wait for a hello.
  useEffect(() => {
    if (screen !== "host") return;
    let live = true;
    const code = room || roomCode();
    if (!room) setRoom(code);
    setLobbyNote("Opening the room…");
    void openTransport(netMode, code).then((t) => {
      if (!live) { t?.close(); return; }
      if (!t) { setLobbyNote("Couldn't open a room. Check your connection and try again."); return; }
      transportRef.current = t;
      setLobbyNote("Waiting for your friend…");
      t.receive((m: Wire) => {
        if (m.t !== "hi" || !live) return;
        guestUpRef.current = m.up;
        t.send({ t: "go" });
        setMode("host");
        setScreen("loading");
      });
    });
    return () => {
      live = false;
      // Hand the transport on to the game if we are starting; close it if we are backing out.
      if (transportRef.current && gameRef.current === null && screenRef.current !== "loading") { transportRef.current.close(); transportRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Joining: say hello until the host says go (or a snapshot turns up, if the go got lost).
  useEffect(() => {
    if (screen !== "join") return;
    let live = true;
    let timer = 0;
    setLobbyNote(`Joining room ${room}…`);
    void openTransport(netMode, room).then((t) => {
      if (!live) { t?.close(); return; }
      if (!t) { setLobbyNote("Couldn't reach the room. Check the code and your connection."); return; }
      transportRef.current = t;
      setLobbyNote("Knocking on the tailgate…");
      const hello = (): void => t.send({ t: "hi", up: readBank().up });
      hello();
      timer = window.setInterval(hello, 700);
      t.receive((m: Wire) => {
        if (!live || (m.t !== "go" && m.t !== "st")) return;
        window.clearInterval(timer);
        setMode("guest");
        setScreen("loading");
      });
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      if (transportRef.current && gameRef.current === null && screenRef.current !== "loading") { transportRef.current.close(); transportRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  /* --------------------------------------------------------- the game */
  useEffect(() => {
    if (screen !== "loading") return;
    let game: Game | null = null;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void import("@/cannonrun/engine").then(({ createCannonRun }) => {
        if (cancelled || !mountRef.current) return;
        try {
          game = createCannonRun(mountRef.current, {
            mode,
            net: transportRef.current,
            upgrades: readBank().up,
            guestUpgrades: guestUpRef.current,
            aurora: auroraRef.current,
            thanksgiving: thanksRef.current,
            space: spaceRef.current,
            onHud: setHud,
            onReady: () => setScreen("playing"),
            onEnd: (cash) => {
              const b = readBank();
              writeBank(b.bank + cash, b.up);
              setBank(readBank());
              setEarned(cash);
            },
          });
          gameRef.current = game;
        } catch (e) {
          console.error(e);
          setScreen("failed");
        }
      }).catch((e) => { console.error(e); setScreen("failed"); });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen === "loading"]);

  // Tear the game down when leaving the page.
  useEffect(() => () => {
    gameRef.current?.dispose();
    gameRef.current = null;
    transportRef.current = null;
  }, []);

  const onStick = useCallback((x: number, y: number) => gameRef.current?.setStick(x, y), []);
  // The comic is not part of the game (Jack wants it all 3D); it lives at ?comic (solo) and ?comic=duo, for the trailer.
  const start = (m: Mode): void => { setMode(m); setEarned(null); setScreen("loading"); };
  const again = (): void => { setEarned(null); setReel(false); gameRef.current?.restart(); };
  const buy = (key: keyof Upgrades): void => {
    const b = readBank();
    const lvl = b.up[key];
    if (lvl >= 3 || b.bank < UPGRADE_COST[lvl]) return;
    writeBank(b.bank - UPGRADE_COST[lvl], { ...b.up, [key]: lvl + 1 });
    setBank(readBank());
  };

  const toggleAurora = (): void => { const v = !aurora; setAurora(v); try { localStorage.setItem("cannonrun.sky", v ? "aurora" : "moon"); } catch { /* private window */ } };
  const toggleSpace = (): void => { const v = !space; setSpace(v); try { localStorage.setItem("cannonrun.space", v ? "on" : "off"); } catch { /* private window */ } };
  const toggleThanks = (): void => { const v = !thanks; setThanks(v); try { localStorage.setItem("cannonrun.thanks", v ? "on" : "off"); } catch { /* private window */ } };

  const card = "rounded-xl bg-black/55 ring-1 ring-white/10 backdrop-blur-sm";
  const over = hud?.phase === "over";
  const takeback = hud?.phase === "takeback";
  // the diner showdown after the train: its own HUD, and the words are drawn in the canvas
  const fz = hud?.finale && !over ? hud.finale : null;
  const guest = hud?.mode === "guest";
  const inviteUrl = typeof window !== "undefined" ? `${window.location.origin}/cannon-chase?room=${room}${netMode === "local" ? "&net=local" : ""}${space ? "&space" : ""}` : "";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#0b0f1c] text-white" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {screen === "playing" && hud && !bare ? (
        <>
          {fz ? <FinaleHud f={fz} phone={phone} mode={hud.mode} card={card} onStick={onStick} game={gameRef} /> : null}

          {/* Top left: the score, then one card per truck. */}
          {!fz ? <div className={`pointer-events-none absolute flex flex-col ${phone ? "gap-1.5" : "gap-2"}`} style={{ left: "max(env(safe-area-inset-left), 12px)", top: "max(env(safe-area-inset-top), 60px)", width: phone ? (hud.riders.length > 1 ? 128 : 150) : 168 }}>
            <div className={`${card} px-3 py-2`}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[22px] font-semibold leading-none tracking-tight text-[#ffd36a]" style={{ fontFamily: MONO }}>{hud.score.toLocaleString()}</div>
                <div className="text-[13px] font-semibold text-[#4de0a8]" style={{ fontFamily: MONO }}>${hud.cash.toLocaleString()}</div>
              </div>
              {phone && hud.riders.length > 1 ? null : (
                <div className="mt-1 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
                  {(hud.meters / 1000).toFixed(1)} km · best {hud.best.toLocaleString()}
                </div>
              )}
            </div>
            {phone && hud.riders.length > 1 ? (
              // two trucks on a phone: one slim card, a line each, so the road stays visible
              <div className={`${card} px-2.5 py-1.5`}>
                {hud.riders.map((r, i) => <SlimRider key={i} r={r} />)}
              </div>
            ) : hud.riders.map((r, i) => <RiderCard key={i} r={r} many={hud.riders.length > 1} card={card} />)}
          </div> : null}

          {/* Top centre: him. */}
          {!fz ? <div
            className={`pointer-events-none absolute flex flex-col gap-2 ${phone ? "right-3 items-end" : "inset-x-0 items-center px-3"}`}
            style={{ top: "max(env(safe-area-inset-top), 14px)" }}
          >
            <div className={`flex gap-2 ${phone ? "flex-col items-end" : ""}`}>
            <div className={`${card} px-3 py-1.5 text-center`}>
              <div className="text-[11px] font-bold tracking-[0.18em] text-[#ff7a5a]">
                MAD MORT{phone ? null : <span className="font-medium tracking-normal text-white/60"> in {hud.ride}</span>}
              </div>
              <div className="mt-1 flex max-w-[180px] flex-wrap justify-center gap-1">
                {Array.from({ length: hud.foeMax }, (_, i) => (
                  <span key={i} className="h-2 w-3.5 rounded-sm" style={{ background: i < hud.foeHp ? "#ff5a3a" : "rgba(255,255,255,0.14)" }} />
                ))}
              </div>
              <div className="mt-1 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
                {takeback || over ? "taking his cannon back" : hud.foeWrecked ? "wrecked, for now" : `${Math.max(0, hud.gap)} m behind`}
              </div>
            </div>
            {hud.linda ? (
              <div className={`${card} px-3 py-1.5 text-center`}>
                <div className="text-[11px] font-bold tracking-[0.18em] text-[#e08aff]">
                  LUNATIC LINDA{phone ? null : <span className="font-medium tracking-normal text-white/60"> in {hud.linda.ride}</span>}
                </div>
                <div className="mt-1 flex max-w-[180px] flex-wrap justify-center gap-1">
                  {Array.from({ length: hud.linda.max }, (_, i) => (
                    <span key={i} className="h-2 w-3.5 rounded-sm" style={{ background: i < hud.linda!.hp ? "#c45aff" : "rgba(255,255,255,0.14)" }} />
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
                  {takeback || over ? "cheering him on" : hud.linda.wrecked ? "wrecked, for now" : "his cousin"}
                </div>
              </div>
            ) : null}
            </div>
            {hud.toast ? <div style={phone ? { position: "fixed", left: 12, right: 12, top: hud.riders.length > 1 ? 206 : 262 } : undefined} className="rounded-full bg-white px-4 py-1.5 text-center text-[13px] font-semibold text-black shadow-lg">{hud.toast}</div> : null}
            {hud.alert && !over ? <div className="animate-pulse rounded-lg bg-[#d8262a] px-4 py-2 text-center text-[13px] font-extrabold tracking-wide shadow-lg ring-2 ring-white/70">{hud.alert}</div> : null}
            {hud.link === "lost" && !over ? <div className="rounded-full bg-[#ff5a4a] px-4 py-1.5 text-[12px] font-semibold">{guest ? "Lost the host. Waiting…" : "Your friend has gone quiet…"}</div> : null}
          </div> : null}

          {!phone && !over && !takeback && !fz ? (
            <div className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${card} px-4 py-2 text-center text-[11px] text-white/70`} style={{ bottom: "max(env(safe-area-inset-bottom), 16px)" }}>
              {hud.mode === "duo" ? (
                <>
                  <span style={{ color: "#5ab4ff" }}>P1</span> A / D swerve · Shift nitro · mouse and click (or Space) to fire
                  <span className="mx-2 text-white/30">|</span>
                  <span style={{ color: "#ff7a4a" }}>P2</span> ← / → swerve · ↑ nitro · Enter to fire
                </>
              ) : (
                "Click the road to fire · A / D to swerve · Shift for nitro · shoot what he throws and his henchmen"
              )}
            </div>
          ) : null}

          <div className="absolute z-10 flex gap-2" style={{ left: phone ? undefined : "max(env(safe-area-inset-left), 12px)", right: phone ? "max(env(safe-area-inset-right), 12px)" : undefined, bottom: phone ? undefined : "max(env(safe-area-inset-bottom), 16px)", top: phone ? (hud.linda ? 162 : 120) : undefined }}>
            <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => { const m = !muted; setMuted(m); gameRef.current?.setMuted(m); }}>
              {muted ? "🔇" : "🔊"}
            </button>
            <button className={`${card} px-2.5 py-1.5 text-[12px] font-semibold`} aria-label="Zoom out" onClick={() => setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length])}>
              🔍 {zoom === 1 ? "Zoom out" : `${zoom}x`}
            </button>
          </div>

          {phone && !over && !takeback && !fz ? (
            <>
              {/* Tap anywhere above the stick to aim there and fire. */}
              <div
                className="absolute inset-0"
                style={{ touchAction: "none" }}
                onPointerDown={(e) => { if (e.pointerType !== "mouse") gameRef.current?.aimAt(e.clientX, e.clientY, true); }}
              />
              <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 22px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                <Joystick onMove={onStick} size={124} />
              </div>
              <button
                className="absolute flex h-20 w-20 items-center justify-center rounded-full bg-[#5ab4ff]/30 text-[13px] font-bold ring-2 ring-[#5ab4ff]/60"
                style={{ right: "max(env(safe-area-inset-right), 22px)", bottom: "max(env(safe-area-inset-bottom), 30px)", touchAction: "none" }}
                onPointerDown={(e) => { e.stopPropagation(); gameRef.current?.hold("boost", true); }}
                onPointerUp={() => gameRef.current?.hold("boost", false)}
                onPointerCancel={() => gameRef.current?.hold("boost", false)}
              >
                NITRO
              </button>
            </>
          ) : null}

          {over ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-6">
              <div className="w-full max-w-sm rounded-2xl bg-[#121728]/95 p-6 text-center ring-1 ring-white/10">
                {hud.won ? (
                  <>
                    <div className="text-[12px] font-bold tracking-[0.22em] text-[#ffd36a]">THE CANNON IS YOURS. FOR GOOD.</div>
                    <div className="mt-1 text-[12px] text-white/55">Mort gave up at Dot's Diner. The end?</div>
                  </>
                ) : (
                  <div className="text-[12px] font-bold tracking-[0.22em] text-[#ff7a5a]">{hud.finale ? "MORT GOT HIS CANNON BACK AT THE DINER" : "HE TOOK HIS CANNON BACK"}</div>
                )}
                <div className="mt-2 text-4xl font-semibold" style={{ fontFamily: MONO }}>{hud.score.toLocaleString()}</div>
                <div className="mt-2 text-[13px] text-white/60">
                  {(hud.meters / 1000).toFixed(2)} km · {hud.hits} hits · {hud.wrecks} {hud.wrecks === 1 ? "ride" : "rides"} wrecked
                </div>
                <div className="mt-3 text-[15px] font-semibold text-[#4de0a8]">+${(earned ?? hud.cash).toLocaleString()} for the garage</div>
                <div className="mt-0.5 text-[11px] text-white/40">bank ${bank.bank.toLocaleString()}</div>
                {hud.score >= hud.best && hud.score > 0 ? <div className="mt-2 text-[13px] font-semibold text-[#ffd36a]">New best!</div> : <div className="mt-2 text-[12px] text-white/40">Best {hud.best.toLocaleString()}</div>}
                <button
                  className="mt-4 w-full rounded-xl bg-[#c8202a] px-4 py-2.5 text-[14px] font-bold tracking-wide shadow-lg ring-1 ring-white/20"
                  onClick={() => setReel(true)}
                >
                  📺 Watch the Gatch News replay
                </button>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {guest ? (
                    <div className="rounded-full bg-white/10 px-5 py-2 text-[13px] text-white/70">Waiting for the host to go again…</div>
                  ) : (
                    <button className="rounded-full bg-[#ffd36a] px-5 py-2 text-[14px] font-semibold text-black" onClick={again}>Again</button>
                  )}
                  <a href="/cannon-run" className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold">Garage</a>
                  <Link to="/" className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold">Hub</Link>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {reel ? <GatchReplay load={loadReel} onClose={() => setReel(false)} /> : null}

      {screen === "story" ? <StoryBook phone={phone} two={params.get("story") === "duo"} onDone={() => setScreen("splash")} onPlay={(two) => start(two ? "duo" : "solo")} /> : null}

      {screen === "comic" ? <Comic phone={phone} two={params.get("comic") === "duo"} onDone={() => setScreen("splash")} /> : null}

      {screen === "splash" && look && look !== "classic" ? (
        <SplashLook
          look={look}
          phone={phone}
          aurora={aurora}
          thanks={thanks}
          space={space}
          onSpace={toggleSpace}
          bank={bank.bank}
          onSolo={() => start("solo")}
          onDuo={() => start("duo")}
          onHost={() => { setRoom(""); setScreen("host"); }}
          onGarage={() => setScreen("garage")}
          onStory={() => setScreen("story")}
          onAurora={toggleAurora}
          onThanks={toggleThanks}
        />
      ) : null}
      {screen === "splash" && params.has("look") ? <LookSwitcher look={look} onPick={pickLook} /> : null}

      {screen === "splash" && (!look || look === "classic") ? (
        <Backdrop>
          <div className="text-6xl">💣🛻</div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">Cannon Chase</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">
            Midnight, a desert highway, and an old ship's cannon bolted into the bed of your pickup. Mad Mort says it's his. His headlights are right behind you.
          </p>
          <p className="mt-3 text-[13px] text-white/45">
            {phone ? "Tap the road to fire. Stick to swerve. Hold nitro to pull away." : "Click the road to fire. A and D to swerve. Shift for nitro."} Wreck his rides for cash.
          </p>
          <div className="mt-6 flex flex-col items-center gap-2">
            <button className="w-64 rounded-full bg-[#ffd36a] px-6 py-2.5 text-[15px] font-semibold text-black" onClick={() => start("solo")}>
              Light the fuse
            </button>
            {!phone ? (
              <button className="w-64 rounded-full bg-white/10 px-6 py-2.5 text-[14px] font-semibold ring-1 ring-white/15" onClick={() => start("duo")}>
                Two trucks, one screen
              </button>
            ) : null}
            <button className="w-64 rounded-full bg-white/10 px-6 py-2.5 text-[14px] font-semibold ring-1 ring-white/15" onClick={() => { setRoom(""); setScreen("host"); }}>
              Play with a friend's phone
            </button>
            <button
              className={`w-64 rounded-full px-6 py-2 text-[13px] font-semibold ring-1 ${aurora ? "bg-[#1f6b55] ring-[#5dffb0]/60 text-[#cfffe8]" : "bg-white/5 ring-white/15 text-white/70"}`}
              onClick={toggleAurora}
            >
              {aurora ? "✦ Aurora sky: on" : "✦ Aurora sky: off"}
            </button>
            <button
              className={`w-64 rounded-full px-6 py-2 text-[13px] font-semibold ring-1 ${space ? "bg-[#2a1a6a] ring-[#9a8aff]/60 text-[#e0d8ff]" : "bg-white/5 ring-white/15 text-white/70"}`}
              onClick={toggleSpace}
            >
              {space ? "🚀 Outer space: on" : "🚀 Outer space: off"}
            </button>
            <button
              className={`w-64 rounded-full px-6 py-2 text-[13px] font-semibold ring-1 ${thanks ? "bg-[#8a3a12] ring-[#ffa64a]/60 text-[#ffe2c0]" : "bg-white/5 ring-white/15 text-white/70"}`}
              onClick={toggleThanks}
            >
              {thanks ? "🦃 Thanksgiving: on" : "🦃 Thanksgiving: off"}
            </button>
            <button className="w-64 rounded-full bg-white/10 px-6 py-2 text-[13px] font-semibold ring-1 ring-white/15" onClick={() => setScreen("story")}>
              📖 Read the story
            </button>
            <div className="mt-1 flex gap-2">
              <button className="rounded-full bg-white/10 px-5 py-2 text-[13px] font-semibold" onClick={() => setScreen("garage")}>
                Garage <span className="text-[#4de0a8]" style={{ fontFamily: MONO }}>${bank.bank.toLocaleString()}</span>
              </button>
              <Link to="/" className="rounded-full bg-white/10 px-5 py-2 text-[13px] font-semibold">Hub</Link>
            </div>
          </div>
        </Backdrop>
      ) : null}

      {screen === "garage" ? (
        <Backdrop>
          <h2 className="text-3xl font-bold tracking-tight">The garage</h2>
          <div className="mt-1 text-[15px] text-[#4de0a8]" style={{ fontFamily: MONO }}>${bank.bank.toLocaleString()} in the coffee can</div>
          <p className="mt-2 text-[12px] text-white/45">Every hit on Mort pays. Wrecking one of his rides pays a lot more.</p>
          <div className="mt-5 flex flex-col gap-2 text-left">
            {UPGRADES.map((u) => {
              const lvl = bank.up[u.key];
              const cost = lvl < 3 ? UPGRADE_COST[lvl] : 0;
              const can = lvl < 3 && bank.bank >= cost;
              return (
                <div key={u.key} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold">{u.name}</div>
                    <div className="text-[11px] text-white/50">{u.what}</div>
                    <div className="mt-1.5 flex gap-1">
                      {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-6 rounded-full" style={{ background: i < lvl ? "#ffd36a" : "rgba(255,255,255,0.14)" }} />)}
                    </div>
                  </div>
                  <button
                    disabled={!can}
                    onClick={() => buy(u.key)}
                    className={`shrink-0 rounded-full px-4 py-1.5 text-[13px] font-semibold ${can ? "bg-[#ffd36a] text-black" : "bg-white/10 text-white/40"}`}
                    style={{ fontFamily: MONO }}
                  >
                    {lvl >= 3 ? "MAX" : `$${cost}`}
                  </button>
                </div>
              );
            })}
          </div>
          <button className="mt-5 rounded-full bg-white/10 px-6 py-2.5 text-[14px] font-semibold" onClick={() => setScreen("splash")}>Back</button>
        </Backdrop>
      ) : null}

      {screen === "host" ? (
        <Backdrop>
          <h2 className="text-2xl font-bold tracking-tight">Play with a friend</h2>
          <p className="mt-2 text-[13px] text-white/60">They scan this on their phone, or open the link on another computer. You each get a truck and a cannon.</p>
          {room ? (
            <div className="mt-5 flex flex-col items-center gap-3">
              <QrCode text={inviteUrl} size={180} />
              <div className="text-[34px] font-bold tracking-[0.3em] text-[#ffd36a]" style={{ fontFamily: MONO }}>{room}</div>
              <button
                className="max-w-full truncate rounded-full bg-white/10 px-4 py-1.5 text-[12px] text-white/70"
                onClick={() => { void navigator.clipboard?.writeText(inviteUrl); setLobbyNote("Link copied."); }}
              >
                {inviteUrl.replace(/^https?:\/\//, "")}
              </button>
            </div>
          ) : null}
          <div className="mt-4 text-[13px] text-white/50">{lobbyNote}</div>
          <button className="mt-5 rounded-full bg-white/10 px-6 py-2.5 text-[14px] font-semibold" onClick={() => setScreen("splash")}>Back</button>
        </Backdrop>
      ) : null}

      {screen === "join" ? (
        <Backdrop>
          <div className="text-5xl">🛻🛻</div>
          <h2 className="mt-3 text-2xl font-bold tracking-tight">Room {room}</h2>
          <div className="mt-3 text-[13px] text-white/60">{lobbyNote}</div>
          <p className="mt-3 text-[12px] text-white/40">{phone ? "Tap the road to fire. Stick to swerve. Hold nitro to pull away." : "Click the road to fire. A and D to swerve. Shift for nitro."}</p>
          <a href="/cannon-run" className="mt-5 inline-block rounded-full bg-white/10 px-6 py-2.5 text-[14px] font-semibold">Play on my own instead</a>
        </Backdrop>
      ) : null}

      {screen === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-[13px] tracking-[0.2em] text-white/50">STARTING THE ENGINE…</div>
      ) : null}

      {screen === "failed" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-[15px] text-white/70">The truck would not start on this device (WebGL failed to load).</div>
          <Link to="/" className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold">Back to the hub</Link>
        </div>
      ) : null}
    </div>
  );
}

/** On foot at Dot's Diner: pies in hand, who is still standing, and how far Mort has the cannon out. */
function FinaleHud({ f, phone, mode, card, onStick, game }: { f: FinaleHudT; phone: boolean; mode: Mode; card: string; onStick: (x: number, y: number) => void; game: React.MutableRefObject<Game | null> }) {
  if (f.stage !== "fight") return null;
  const colors = ["#5ab4ff", "#ff7a4a"];
  return (
    <>
      <div className="pointer-events-none absolute flex flex-col gap-2" style={{ left: "max(env(safe-area-inset-left), 12px)", top: "max(env(safe-area-inset-top), 60px)", width: phone ? 140 : 168 }}>
        {f.pies.map((n, i) => (
          <div key={i} className={`${card} px-3 py-2`} style={f.pies.length > 1 ? { boxShadow: `inset 3px 0 0 ${colors[i]}` } : undefined}>
            <div className="text-[10px] font-bold tracking-[0.18em]" style={{ color: f.pies.length > 1 ? colors[i] : "rgba(255,255,255,0.55)" }}>{f.pies.length > 1 ? `P${i + 1} PIES` : "PIES"}</div>
            <div className="mt-0.5 text-[20px] leading-none">{n > 0 ? "🥧".repeat(n) : <span className="text-[12px] font-semibold text-[#ffd36a]">Get more at Dot's counter!</span>}</div>
          </div>
        ))}
      </div>
      <div className={`pointer-events-none absolute flex flex-col gap-2 ${phone ? "right-3 items-end" : "inset-x-0 items-center px-3"}`} style={{ top: "max(env(safe-area-inset-top), 14px)" }}>
        <div className={`flex gap-2 ${phone ? "flex-col items-end" : ""}`}>
          {f.foes.map((x) => (
            <div key={x.name} className={`${card} px-3 py-1.5 text-center`} style={{ opacity: x.beaten ? 0.5 : 1 }}>
              <div className="text-[11px] font-bold tracking-[0.18em]" style={{ color: x.name.includes("LINDA") ? "#e08aff" : "#ff7a5a" }}>{x.name}</div>
              <div className="mt-1 flex justify-center gap-1">
                {Array.from({ length: x.max }, (_, i) => <span key={i} className="h-2 w-3.5 rounded-sm" style={{ background: i < x.hp ? "#fff2d8" : "rgba(255,255,255,0.14)" }} />)}
              </div>
              <div className="mt-1 text-[10px] text-white/45">{x.beaten ? "covered in pie" : "on foot"}</div>
            </div>
          ))}
        </div>
        <div className={`${card} w-[220px] px-3 py-1.5`}>
          <div className="text-[10px] font-bold tracking-[0.18em]" style={{ color: f.grab > 0.6 ? "#ff5a4a" : "rgba(255,255,255,0.6)" }}>{f.grab > 0.02 ? "MORT IS TAKING THE CANNON!" : "THE CANNON IS SAFE"}</div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${f.grab * 100}%`, background: f.grab > 0.6 ? "#ff5a4a" : "#ffd36a" }} />
          </div>
        </div>
      </div>
      {!phone ? (
        <div className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${card} px-4 py-2 text-center text-[11px] text-white/70`} style={{ bottom: "max(env(safe-area-inset-bottom), 16px)" }}>
          {mode === "duo" ? (
            <>
              <span style={{ color: "#5ab4ff" }}>P1</span> W A S D to run · Space to throw a pie
              <span className="mx-2 text-white/30">|</span>
              <span style={{ color: "#ff7a4a" }}>P2</span> arrows to run · Enter to throw
            </>
          ) : (
            "W A S D or the arrows to run · Space or click to throw a pie · more pies at Dot's counter"
          )}
        </div>
      ) : (
        <>
          <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 22px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
            <Joystick onMove={onStick} size={124} />
          </div>
          <button
            className="absolute flex h-20 w-20 items-center justify-center rounded-full bg-[#ffd36a]/30 text-[13px] font-bold ring-2 ring-[#ffd36a]/70"
            style={{ right: "max(env(safe-area-inset-right), 22px)", bottom: "max(env(safe-area-inset-bottom), 30px)", touchAction: "none" }}
            onPointerDown={(e) => { e.stopPropagation(); game.current?.aimAt(e.clientX, e.clientY, true); }}
          >
            🥧 PIE
          </button>
        </>
      )}
    </>
  );
}

/** The reel: every bulletin of the run, back to back, on a TV with the headline under it. */
function GatchReplay({ load, onClose }: { load: () => ReplayClip[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  // the last clip is still being cut when the run ends, so keep checking the tape
  const [clips, setClips] = useState<ReplayClip[]>(load);
  const [sharing, setSharing] = useState(false);
  const [said, setSaid] = useState<{ text: string; link?: string } | null>(null);
  const doShare = async (clip: ReplayClip): Promise<void> => {
    setSharing(true); setSaid(null);
    try {
      const { link, how } = await shareClip(clip);
      setSaid({ text: how === "copied" ? "Link copied. Paste it anywhere." : how === "shared" ? "Sent!" : "Here's the link:", link });
    } catch (e) {
      setSaid({ text: `Couldn't send it: ${(e as Error).message}` });
    } finally { setSharing(false); }
  };
  useEffect(() => {
    const id = window.setInterval(() => setClips((was) => { const now = load(); return now.length === was.length ? was : now; }), 700);
    return () => window.clearInterval(id);
  }, [load]);
  const c = clips[i];
  const mm = (t: number): string => { t = Math.max(0, t); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 px-3 py-4" onClick={onClose}>
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl bg-[#0d1020] ring-1 ring-white/15" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 bg-[#14182c] px-3 py-2">
          <span className="rounded bg-[#d8202a] px-2 py-0.5 text-[12px] font-black tracking-wide">GATCH NEWS</span>
          <span className="text-[12px] font-bold text-white/70">REPLAY</span>
          <span className="ml-auto text-[11px] text-white/40">{clips.length ? `${i + 1} of ${clips.length}` : ""}</span>
          <button className="ml-2 rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold" onClick={onClose}>Close</button>
        </div>
        {c ? (
          <>
            <div className="relative bg-black">
              <video key={c.url} src={c.url} className="block aspect-video w-full bg-black" autoPlay muted playsInline controls onEnded={() => setI((n) => (n + 1 < clips.length ? n + 1 : n))} />
              <div className="pointer-events-none absolute inset-x-0 bottom-12 flex flex-col items-start px-3">
                <div className="bg-[#d8202a] px-2 py-0.5 text-[11px] font-black tracking-wider">BREAKING</div>
                <div className="bg-[#0a1230]/90 px-2 py-1 text-[15px] font-extrabold">{c.headlines[0]?.headline}</div>
                <div className="bg-[#0a1230]/80 px-2 py-0.5 text-[11px] text-white/75">{c.headlines[0]?.sub}</div>
              </div>
            </div>
            <div className="flex gap-2 px-3 py-2">
              <button className="rounded-full bg-white/10 px-4 py-1.5 text-[13px] font-semibold disabled:opacity-30" disabled={i === 0} onClick={() => setI(i - 1)}>◀ Back</button>
              <button className="rounded-full bg-white/10 px-4 py-1.5 text-[13px] font-semibold disabled:opacity-30" disabled={i + 1 >= clips.length} onClick={() => setI(i + 1)}>Next ▶</button>
              <button className="ml-auto rounded-full bg-[#d8202a] px-4 py-1.5 text-[13px] font-black disabled:opacity-50" disabled={sharing} onClick={() => void doShare(c)}>{sharing ? "Sending..." : "Share"}</button>
              <a className="rounded-full bg-white/10 px-4 py-1.5 text-[13px] font-semibold" href={c.url} download={`gatch-news-${i + 1}.${c.type.includes("mp4") ? "mp4" : "webm"}`}>Save clip</a>
            </div>
            {said ? (
              <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-[12px] text-white/80">
                <span>{said.text}</span>
                {said.link ? <a className="truncate font-semibold text-[#ffd36a] underline" href={said.link} target="_blank" rel="noreferrer">{said.link}</a> : null}
              </div>
            ) : null}
            <div className="max-h-44 overflow-y-auto border-t border-white/10 px-3 py-2">
              <div className="mb-1 text-[10px] font-bold tracking-[0.2em] text-white/40">TONIGHT'S TOP STORIES</div>
              {clips.map((x, k) => (
                <button key={x.url} className={`flex w-full gap-2 rounded px-2 py-1 text-left text-[12px] ${k === i ? "bg-white/10" : "hover:bg-white/5"}`} onClick={() => setI(k)}>
                  <span className="text-white/40" style={{ fontFamily: MONO }}>{mm(x.at)}</span>
                  <span className="font-semibold">{x.headlines.map((h) => h.headline).join(" · ")}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="px-6 py-10 text-center text-[14px] text-white/60">No tape tonight. Gatch News records each bulletin as it airs, so keep the chase going a little longer next time.</div>
        )}
      </div>
    </div>
  );
}

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto px-6 py-8" style={{ background: "radial-gradient(ellipse at 50% 70%, #3a2a1c 0%, #0b0f1c 65%)" }}>
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );
}

/** One truck in one line: name, hull, and three thin bars (truck, nitro, cannon). */
function SlimRider({ r }: { r: RiderHud }) {
  const bar = (v: number, c: string) => (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: c }} />
    </div>
  );
  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between text-[9px] font-bold tracking-[0.14em]" style={{ color: r.color }}>
        <span>{r.label}</span>
        <span className="font-medium tracking-normal text-white/55" style={{ fontFamily: MONO }}>
          {r.gone ? "gone" : r.out ? (r.respawn > 0 ? `out ${r.respawn}s` : "out") : `${Math.max(0, r.hull)}/${r.max}`}
        </span>
      </div>
      <div className="mt-0.5 flex gap-1">
        {bar(r.hull / r.max, r.hull / r.max > 0.35 ? "#4de0a8" : "#ff5a4a")}
        {bar(r.boost, "#5ab4ff")}
        {bar(r.reload, r.reload >= 1 ? "#ffd36a" : "#8a7a5a")}
      </div>
    </div>
  );
}

function RiderCard({ r, many, card }: { r: RiderHud; many: boolean; card: string }) {
  return (
    <div className={`${card} px-3 py-2`} style={many ? { boxShadow: `inset 3px 0 0 ${r.color}` } : undefined}>
      {many ? (
        <div className="flex items-center justify-between text-[10px] font-bold tracking-[0.18em]" style={{ color: r.color }}>
          <span>{r.label}</span>
          <span className="font-medium tracking-normal text-white/50" style={{ fontFamily: MONO }}>{r.gone ? "gone" : `${Math.max(0, r.hull)}/${r.max}`}</span>
        </div>
      ) : null}
      {r.out && !r.gone ? (
        <div className="mt-1 text-[12px] font-semibold text-[#ff7a5a]">{r.respawn > 0 ? `OUT · back in ${r.respawn}s` : "OUT"}</div>
      ) : null}
      <Bar label="TRUCK" value={r.hull / r.max} color={r.hull / r.max > 0.35 ? "#4de0a8" : "#ff5a4a"} />
      <Bar label="NITRO" value={r.boost} color="#5ab4ff" />
      <Bar label="CANNON" value={r.reload} color={r.reload >= 1 ? "#ffd36a" : "#8a7a5a"} />
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="mt-1.5">
      <div className="text-[9px] font-bold tracking-[0.2em] text-white/50">{label}</div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
      </div>
    </div>
  );
}
