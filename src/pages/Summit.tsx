/**
 * /summit: Vibe Summit, a 5,000 ft mountain with four ways down and a rainbow
 * road above the clouds. The game is in src/summit; this page is the door,
 * the HUD and the phone controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Joystick } from "@/magician/ui/Joystick";
import { useActiveCharacter } from "@/hooks/use-active-character";
import type { Summit as Game, SummitHud } from "@/summit/engine";

type Phase = "splash" | "loading" | "playing" | "failed";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const MODE_LABEL: Record<SummitHud["mode"], string> = {
  walk: "On foot", ski: "Skis", board: "Snowboard", wingsuit: "Wingsuit", chute: "Parachute",
  paraglider: "Paraglider", kart: "Prism Skyway", fall: "Falling!", gondola: "Gondola", beam: "Rainbow lift", tumble: "Wipeout",
};

const CHOICES: { key: "ski" | "board" | "wingsuit" | "paraglider" | "skyway"; emoji: string; name: string; line: string; color: string }[] = [
  { key: "ski", emoji: "⛷️", name: "Skis", line: "Carve the Main Run, hit the kickers", color: "#1d5fa8" },
  { key: "board", emoji: "🏂", name: "Snowboard", line: "Spin off the jumps for points", color: "#6b2fb3" },
  { key: "wingsuit", emoji: "🪂", name: "Wingsuit", line: "Dive through the rings, pull the chute", color: "#d8342c" },
  { key: "paraglider", emoji: "🪁", name: "Paraglider", line: "Slow and high, ride the thermals", color: "#d98a1a" },
  { key: "skyway", emoji: "🌈", name: "Prism Skyway", line: "Race Vibe Kart on the rainbow road", color: "#7a3fd0" },
];

export default function Summit() {
  const navigate = useNavigate();
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const { character } = useActiveCharacter();
  const [phase, setPhase] = useState<Phase>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("go") ? "loading" : "splash",
  );
  const [hud, setHud] = useState<SummitHud | null>(null);
  const [muted, setMuted] = useState(false);
  const [menu, setMenu] = useState(false);
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  const bare = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    if (phase !== "loading") return;
    let game: Game | null = null;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void import("@/summit/engine").then(({ createSummit }) => {
        if (cancelled || !mountRef.current) return;
        try {
          game = createSummit(mountRef.current, {
            charId: character.id,
            onHud: setHud,
            onReady: () => setPhase("playing"),
            // The rainbow beam carries you up into Vibe Kart's Prism Skyway, which
            // races above this very mountain. Scripts keep the old in-world road.
            onSkyway: typeof navigator !== "undefined" && navigator.webdriver ? undefined : () => navigate("/rainbow-road"),
          });
          gameRef.current = game;
        } catch (e) {
          console.error(e);
          setPhase("failed");
        }
      }).catch((e) => { console.error(e); setPhase("failed"); });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      game?.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "loading" || phase === "playing"]);

  const onStick = useCallback((x: number, y: number) => gameRef.current?.setStick(x, y), []);
  const lookId = useRef<number | null>(null);
  const lookAt = useRef({ x: 0, y: 0 });
  const lookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = e.pointerId;
    lookAt.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const lookMove = (e: React.PointerEvent) => {
    if (lookId.current !== e.pointerId) return;
    gameRef.current?.look((e.clientX - lookAt.current.x) * 1.6, (e.clientY - lookAt.current.y) * 1.6);
    lookAt.current = { x: e.clientX, y: e.clientY };
  };
  const lookUp = (e: React.PointerEvent) => { if (lookId.current === e.pointerId) lookId.current = null; };

  const card = "rounded-xl bg-slate-900/55 ring-1 ring-white/15 backdrop-blur-sm";
  const g = gameRef.current;
  const m = hud?.mode;
  const flying = m === "wingsuit" || m === "paraglider" || m === "chute" || m === "fall";
  const actionLabel = m === "wingsuit" ? "CHUTE" : m === "kart" ? "HOP" : m === "walk" ? "JUMP" : m === "ski" || m === "board" ? "JUMP" : null;

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#9fc3ea] text-white" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {phase === "playing" && hud && !bare ? (
        <>
          {/* Top left: the altimeter. */}
          <div className={`pointer-events-none absolute ${card} px-3 py-2`} style={{ left: "max(env(safe-area-inset-left), 12px)", top: "max(env(safe-area-inset-top), 60px)" }}>
            <div className="text-[9px] font-bold tracking-[0.25em] text-white/60">{MODE_LABEL[hud.mode].toUpperCase()}</div>
            <div className="mt-0.5 text-[26px] font-semibold leading-none tracking-tight" style={{ fontFamily: MONO }}>
              {hud.altFt.toLocaleString()}<span className="ml-1 text-[11px] text-white/60">FT</span>
            </div>
            {flying ? <div className="mt-1 text-[10px] text-white/60" style={{ fontFamily: MONO }}>{hud.aglFt.toLocaleString()} ft above the snow</div> : null}
            <div className="mt-1 text-[12px] text-[#9be7ff]" style={{ fontFamily: MONO }}>{hud.speed} km/h</div>
            {hud.timer !== null ? (
              <div className="mt-1 text-[13px] font-semibold text-[#ffe14d]" style={{ fontFamily: MONO }}>
                ⏱ {Math.floor(hud.timer / 60)}:{(hud.timer % 60).toFixed(1).padStart(4, "0")}
              </div>
            ) : null}
            {hud.rings ? <div className="mt-0.5 text-[11px] text-[#ffb36b]">◯ {hud.rings[0]} / {hud.rings[1]} rings</div> : null}
            {hud.lap ? <div className="mt-0.5 text-[11px] text-[#e8c6ff]">Lap {hud.lap[0]} / {hud.lap[1]} · ★ {hud.stars}</div> : null}
            {hud.place ? <div className="mt-0.5 text-[18px] font-black text-white" style={{ fontFamily: MONO }}>P{hud.place[0]}<span className="text-[11px] text-white/60"> / {hud.place[1]}</span></div> : null}
          </div>

          {/* Toast. */}
          <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2 px-3" style={{ top: "max(env(safe-area-inset-top), 14px)" }}>
            {hud.toast ? <div className="max-w-[80vw] rounded-full bg-white px-4 py-1.5 text-center text-[13px] font-semibold text-slate-900 shadow-lg">{hud.toast}</div> : null}
          </div>

          {/* Top right: menu. */}
          <div className="absolute flex flex-col items-end gap-2" style={{ right: "max(env(safe-area-inset-right), 12px)", top: "max(env(safe-area-inset-top), 12px)" }}>
            <div className="flex gap-2">
              <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => { const v = !muted; setMuted(v); g?.setMuted(v); }}>{muted ? "🔇" : "🔊"}</button>
              <button className={`${card} px-3 py-1.5 text-[12px] font-semibold`} onClick={() => setMenu((v) => !v)}>🗺 Go to</button>
            </div>
            {menu ? (
              <div className={`${card} flex flex-col gap-1 p-2 text-[12px]`}>
                <button className="rounded-lg px-3 py-1.5 text-left hover:bg-white/15" onClick={() => { g?.travel("summit"); setMenu(false); }}>🏔 Summit · 5,000 ft</button>
                <button className="rounded-lg px-3 py-1.5 text-left hover:bg-white/15" onClick={() => { g?.travel("village"); setMenu(false); }}>🏡 Village · 300 ft</button>
                <button className="rounded-lg px-3 py-1.5 text-left hover:bg-white/15" onClick={() => { g?.travel("skyway"); setMenu(false); }}>🌈 Prism Skyway</button>
                <Link to="/city?spawn=ski" className="rounded-lg px-3 py-1.5 hover:bg-white/15">🏙 Back to Vibe City</Link>
              </div>
            ) : null}
          </div>

          {/* Summit deck: choose your way down. */}
          {hud.onDeck && !hud.results ? (
            <div className="absolute inset-x-0 flex justify-center px-3" style={{ bottom: phone ? 170 : "max(env(safe-area-inset-bottom), 64px)" }}>
              <div className={`${card} w-full max-w-3xl p-3`}>
                <div className="mb-2 text-center text-[11px] font-bold tracking-[0.3em] text-white/70">CHOOSE YOUR WAY DOWN</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {CHOICES.map((c, i) => (
                    <button
                      key={c.key}
                      onClick={(e) => { g?.choose(c.key); e.currentTarget.blur(); }}
                      className="rounded-lg px-2 py-2 text-left transition-transform active:scale-95"
                      style={{ background: c.color }}
                    >
                      <div className="text-[15px] font-bold">{c.emoji} {c.name}</div>
                      <div className="text-[10px] leading-tight text-white/80">{c.line}</div>
                      {!phone ? <div className="mt-1 text-[9px] text-white/60">key {i + 1}</div> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {hud.inVillage && !hud.results ? (
            <div className="absolute inset-x-0 flex justify-center" style={{ bottom: phone ? 170 : "max(env(safe-area-inset-bottom), 64px)" }}>
              <button className="rounded-full bg-[#d8342c] px-5 py-2.5 text-[13px] font-bold shadow-lg active:scale-95" onClick={(e) => { g?.travel("summit"); e.currentTarget.blur(); }}>
                🚡 Back up to the summit
              </button>
            </div>
          ) : null}

          {hud.mode === "gondola" || hud.mode === "beam" ? (
            <div className="absolute inset-x-0 flex justify-center" style={{ bottom: "max(env(safe-area-inset-bottom), 64px)" }}>
              <button className={`${card} px-5 py-2 text-[13px] font-semibold`} onClick={() => g?.press("skip")}>Skip ⏭</button>
            </div>
          ) : null}

          {/* Results. */}
          {hud.results ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/25 px-6">
              <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center text-slate-900 shadow-2xl">
                <div className="text-[22px] font-black">{hud.results.title}</div>
                <div className="mt-3 space-y-1 text-[14px]">{hud.results.lines.map((l) => <div key={l}>{l}</div>)}</div>
                <div className="mt-5 flex justify-center gap-2">
                  <button className="rounded-full bg-slate-900 px-5 py-2 text-[13px] font-bold text-white" onClick={() => { g?.press("close"); g?.travel(hud.mode === "kart" ? "skyway" : "summit"); }}>
                    {hud.mode === "kart" ? "Race again" : "Back to the top"}
                  </button>
                  <button className="rounded-full bg-slate-200 px-5 py-2 text-[13px] font-semibold" onClick={() => g?.press("close")}>Keep going</button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Bottom: prompt and help. */}
          <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2" style={{ bottom: "max(env(safe-area-inset-bottom), 16px)" }}>
            {hud.prompt && !phone ? <div className={`${card} px-3 py-1.5 text-[13px] font-medium`}>{hud.prompt}</div> : null}
            {!phone && !hud.onDeck ? (
              <div className="text-[11px] text-white/80 drop-shadow">
                {m === "wingsuit" ? "W dive · S flare · A/D turn · Space pulls the chute · R reset"
                  : m === "paraglider" ? "A/D turn · W speed bar · S brake · circle in the sparkles to climb"
                  : m === "kart" ? "W gas · S brake · A/D steer · Space hop · R back on the road"
                  : m === "ski" || m === "board" ? "A/D carve · W tuck · S brake · Space jump, A/D in the air to spin"
                  : m === "chute" ? "A/D steer the canopy"
                  : "WASD walk · Shift run · drag to look · E use · R back to the summit"}
              </div>
            ) : null}
          </div>

          {phone ? (
            <>
              <div className="absolute bottom-0 right-0 top-0 w-1/2" style={{ touchAction: "none" }} onPointerDown={lookDown} onPointerMove={lookMove} onPointerUp={lookUp} onPointerCancel={lookUp} />
              <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 22px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                <Joystick onMove={onStick} size={124} />
              </div>
              <div className="absolute flex flex-col items-end gap-3" style={{ right: "max(env(safe-area-inset-right), 18px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                {hud.prompt ? (
                  <button className="h-12 rounded-full bg-[#ffc83d] px-4 text-[12px] font-bold text-black shadow-lg active:scale-95" onClick={() => g?.press("use")}>
                    {hud.prompt.replace(/^E · /, "")}
                  </button>
                ) : null}
                <div className="flex gap-2">
                  <button className="h-12 w-12 rounded-full bg-white/20 text-[16px] ring-1 ring-white/30 backdrop-blur-sm" onClick={() => g?.press("reset")}>↺</button>
                  {actionLabel ? (
                    <button
                      className="h-16 w-16 rounded-full bg-white/25 text-[11px] font-bold ring-1 ring-white/40 backdrop-blur-sm active:bg-white/45"
                      style={{ touchAction: "none" }}
                      onPointerDown={() => g?.hold("jump", true)}
                      onPointerUp={() => g?.hold("jump", false)}
                      onPointerCancel={() => g?.hold("jump", false)}
                    >
                      {actionLabel}
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {phase === "splash" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center" style={{ background: "linear-gradient(180deg, #2a4c8c 0%, #7fb2e8 48%, #eef5ff 100%)" }}>
          <div className="text-[11px] font-bold tracking-[0.5em] text-white/80">5,000 FT TO 300 FT</div>
          <h1 className="mt-2 text-[58px] font-black leading-none tracking-tight sm:text-[96px]" style={{ textShadow: "0 6px 0 rgba(20,40,90,0.3)" }}>
            VIBE SUMMIT
          </h1>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-white drop-shadow">
            A snowy mountain with a forest at its feet. Ski it, board it, wingsuit it or float down on a paraglider. And above the clouds, a rainbow road.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2 text-[22px]">⛷️ 🏂 🪂 🪁 🌈</div>
          <button
            className="mt-7 rounded-full bg-white px-10 py-3.5 text-[15px] font-bold text-slate-900 shadow-xl transition-transform hover:scale-105 active:scale-95"
            onClick={() => setPhase("loading")}
          >
            Ride up
          </button>
          <Link to="/city?spawn=ski" className="mt-5 text-[12px] text-slate-700 underline-offset-4 hover:underline">Back to Vibe City</Link>
        </div>
      ) : null}

      {phase === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#9fc3ea] text-[13px] tracking-[0.3em] text-white">BUILDING THE MOUNTAIN</div>
      ) : null}

      {phase === "failed" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#2a4c8c] px-6 text-center">
          <p className="max-w-sm text-[14px] text-white/85">Vibe Summit could not start on this device. It needs WebGL, which this browser has switched off or does not have.</p>
          <Link to="/" className="rounded-full bg-white px-6 py-2 text-[13px] font-semibold text-black">Back to the Vibeverse</Link>
        </div>
      ) : null}
    </div>
  );
}
