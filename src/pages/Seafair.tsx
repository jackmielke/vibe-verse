/**
 * SEAFAIR 2117 — future Seattle, Seafair weekend, aliens on the Space Needle.
 *
 * The React layer is deliberately thin, matching San Palmas: it owns the menu,
 * the character picker and the pause/death veils, and mounts a container that
 * `GameWorld` renders into. Everything that moves lives in `src/seafair/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bus } from "@/seafair/core/EventBus";
import {
  loadSettings,
  saveSettings,
  isMobile,
  type UserSettings,
  type QualityTier,
} from "@/seafair/core/Settings";
import { CHARACTERS, getCharacter } from "@/seafair/entities/Characters";
import { readEntry } from "@/seafair/net/Vibeverse";
import type { GameWorld } from "@/seafair/GameWorld";
import HUD from "@/seafair/ui/HUD";
import MobileControls from "@/seafair/ui/MobileControls";

type Screen = "menu" | "select" | "loading" | "playing" | "paused" | "dead";

export default function Seafair() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<GameWorld | null>(null);
  const [screen, setScreen] = useState<Screen>("menu");
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [character, setCharacter] = useState("spartan");
  const [loading, setLoading] = useState({ phase: "", progress: 0 });
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entry] = useState(() => readEntry());
  const mobile = isMobile();

  // `?shot=1` exposes the world on window so the capture harness can pose it.
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => {
    const offs = [
      bus.on("loading:progress", setLoading),
      bus.on("game:state", ({ state }) => setScreen(state as Screen)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => worldRef.current?.applySettings(settings), [settings]);
  useEffect(() => () => worldRef.current?.dispose(), []);

  const launch = useCallback(
    (charId: string) => {
      setCharacter(charId);
      setScreen("loading");
      // Let the loading screen paint before the blocking world build.
      // The engine is ~500 kB of Three.js and shaders; it must not sit in the
      // hub's entry chunk. Pull it in only once someone actually deploys.
      void (async () => {
        try {
          const { GameWorld } = await import("@/seafair/GameWorld");
          if (!containerRef.current) return;
          worldRef.current?.dispose();
          const world = new GameWorld(containerRef.current, settings, charId);
          worldRef.current = world;
          world.start();
          setScreen("playing");
          if (!shotMode) setTimeout(() => world.input.requestLock(), 60);
        } catch (err) {
          console.error("[Seafair] boot failed", err);
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [settings, shotMode],
  );

  // Arrivals through a Vibeverse portal skip the menus entirely.
  useEffect(() => {
    if (entry.arrived && screen === "menu") {
      const id = setTimeout(() => launch("spartan"), 900);
      return () => clearTimeout(id);
    }
  }, [entry.arrived, screen, launch]);

  const resume = () => {
    worldRef.current?.setPaused(false);
    worldRef.current?.input.requestLock();
    setScreen("playing");
  };

  const quitToMenu = () => {
    worldRef.current?.dispose();
    worldRef.current = null;
    setScreen("menu");
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#04080f] font-sans">
      <div ref={containerRef} className="absolute inset-0" />

      {screen === "playing" && <HUD showFps={settings.showFps} />}
      {screen === "playing" && mobile && <MobileControls />}

      {/* ---------------- MAIN MENU ---------------- */}
      {screen === "menu" && (
        <div className="absolute inset-0 overflow-y-auto">
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 90% at 65% 20%, #2a7fb8 0%, #12496e 38%, #071a2b 72%, #04080f 100%)",
            }}
          />
          <div
            className="absolute inset-0 opacity-40"
            style={{
              background:
                "linear-gradient(to top, rgba(4,8,15,0.95) 0%, transparent 45%), repeating-linear-gradient(115deg, transparent 0 38px, rgba(108,199,255,0.05) 38px 39px)",
            }}
          />

          <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-16">
            {entry.arrived && (
              <div className="mb-6 rounded-full border border-sky-300/40 bg-black/40 px-5 py-2 text-xs tracking-[0.2em] text-sky-200">
                ▸ INBOUND FROM THE VIBEVERSE — WELCOME, {entry.username.toUpperCase()}
              </div>
            )}

            <p className="text-[11px] uppercase tracking-[0.5em] text-sky-300/70">
              The Vibeverse presents
            </p>
            <div className="mt-2 text-[11px] tracking-[0.6em] text-sky-300/60">SEATTLE · 2117</div>
            <h1
              className="mt-2 text-center text-6xl font-black leading-none tracking-[0.04em] text-sky-50 sm:text-8xl"
              style={{ textShadow: "0 0 44px rgba(18,165,245,0.55), 0 6px 24px rgba(0,0,0,0.7)" }}
            >
              SEAFAIR
              <span className="block bg-gradient-to-b from-amber-200 to-amber-400 bg-clip-text text-transparent">
                2117
              </span>
            </h1>
            <p className="mt-5 max-w-xl text-center text-base leading-relaxed text-sky-100/75">
              The hydros are running. The Blue Angels are inbound. And something
              landed on the Space Needle three hours ago.
            </p>

            <div className="mt-10 flex flex-col items-center gap-3">
              <button
                onClick={() => setScreen("select")}
                className="w-72 skew-x-[-12deg] border-2 border-sky-300/70 bg-sky-500/15 px-8 py-4 text-lg font-semibold tracking-[0.22em] text-sky-50 transition hover:bg-sky-500/40 hover:shadow-[0_0_30px_rgba(18,165,245,0.5)]"
              >
                <span className="block skew-x-[12deg]">DEPLOY</span>
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="w-72 skew-x-[-12deg] border border-sky-300/35 px-8 py-2.5 text-sm tracking-[0.22em] text-sky-100/80 transition hover:border-sky-300/70 hover:text-sky-50"
              >
                <span className="block skew-x-[12deg]">SETTINGS</span>
              </button>
            </div>

            <div className="mt-12 grid max-w-3xl grid-cols-2 gap-x-10 gap-y-2 text-center font-mono text-[11px] tracking-[0.14em] text-sky-300/55 sm:grid-cols-4">
              <div>WASD · MOVE</div>
              <div>MOUSE · LOOK</div>
              <div>SHIFT · SPRINT</div>
              <div>R · RELOAD</div>
            </div>

            <Link
              to="/"
              className="mt-12 text-[11px] uppercase tracking-[0.3em] text-white/30 transition hover:text-white/60"
            >
              ← back to the vibeverse
            </Link>
          </div>
        </div>
      )}

      {/* ---------------- CHARACTER SELECT ---------------- */}
      {screen === "select" && (
        <div className="absolute inset-0 overflow-y-auto bg-[#05101c]">
          <div
            className="absolute inset-0 opacity-70"
            style={{
              background: "radial-gradient(90% 70% at 50% 0%, #14496b 0%, #071a2b 60%, #04080f 100%)",
            }}
          />
          <div className="relative mx-auto max-w-6xl px-6 py-12">
            <button
              onClick={() => setScreen("menu")}
              className="mb-6 text-xs tracking-[0.22em] text-sky-300/70 hover:text-sky-100"
            >
              ← BACK
            </button>
            <h2 className="text-3xl font-bold tracking-[0.2em] text-sky-50">SELECT OPERATIVE</h2>
            <p className="mb-8 mt-1 text-sm text-sky-100/60">
              Three bodies, three feels. Try them all — they play and perform very differently.
            </p>

            <div className="grid gap-5 md:grid-cols-3">
              {CHARACTERS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => launch(c.id)}
                  className="group relative overflow-hidden rounded-sm border border-sky-300/25 bg-black/40 p-6 text-left transition hover:-translate-y-1 hover:border-sky-300/80 hover:shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
                >
                  <div
                    className="absolute inset-x-0 top-0 h-1"
                    style={{
                      background: `linear-gradient(90deg, ${c.colors[0]}, ${c.colors[1]}, ${c.colors[2]})`,
                    }}
                  />
                  <div
                    className="mb-5 flex h-40 items-center justify-center rounded-sm"
                    style={{
                      background: `radial-gradient(70% 70% at 50% 40%, ${c.colors[0]}55, transparent 70%)`,
                    }}
                  >
                    <div
                      className="h-24 w-24 rounded-full border-2"
                      style={{
                        borderColor: c.colors[1],
                        background: `linear-gradient(160deg, ${c.colors[0]}, ${c.colors[2]}44)`,
                        boxShadow: `0 0 40px ${c.colors[2]}66`,
                      }}
                    />
                  </div>
                  <div className="font-mono text-[10px] tracking-[0.3em] text-sky-300/70">
                    {c.callsign}
                  </div>
                  <div className="text-xl font-semibold tracking-[0.08em] text-sky-50">{c.name}</div>
                  <div className="mb-3 text-sm italic text-amber-300/85">{c.tagline}</div>
                  <p className="mb-4 text-[13px] leading-relaxed text-sky-100/60">{c.blurb}</p>

                  <div className="space-y-1.5">
                    {(
                      [
                        ["SPEED", c.stats.speed],
                        ["ARMOR", c.stats.armor],
                        ["AGILITY", c.stats.agility],
                        ["FIREPOWER", c.stats.firepower],
                      ] as const
                    ).map(([label, v]) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className="w-20 font-mono text-[9px] tracking-[0.2em] text-sky-300/60">
                          {label}
                        </span>
                        <span className="h-[3px] flex-1 bg-white/10">
                          <span
                            className="block h-full"
                            style={{ width: `${v}%`, background: c.colors[1] }}
                          />
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-sky-300/55">
                    <span>{c.perfNote}</span>
                    <span>
                      {"●".repeat(c.cost)}
                      {"○".repeat(3 - c.cost)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- LOADING ---------------- */}
      {screen === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#04080f]">
          <div className="text-[11px] tracking-[0.5em] text-sky-300/70">DEPLOYING</div>
          <div className="mt-3 text-2xl font-semibold tracking-[0.12em] text-sky-50">
            {getCharacter(character).name}
          </div>
          <div className="mt-8 h-[3px] w-72 overflow-hidden bg-white/10">
            <div
              className="h-full bg-sky-300 transition-[width] duration-200"
              style={{ width: `${loading.progress * 100}%` }}
            />
          </div>
          <div className="mt-3 font-mono text-[11px] tracking-[0.14em] text-sky-300/60">
            {loading.phase}
          </div>
        </div>
      )}

      {/* ---------------- PAUSE ---------------- */}
      {screen === "paused" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h2 className="text-4xl font-bold tracking-[0.3em] text-sky-50">PAUSED</h2>
          <div className="mt-8 flex flex-col gap-3">
            <button
              onClick={resume}
              className="w-64 skew-x-[-12deg] border-2 border-sky-300/70 bg-sky-500/20 px-8 py-3 tracking-[0.22em] text-sky-50 hover:bg-sky-500/40"
            >
              <span className="block skew-x-[12deg]">RESUME</span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="w-64 skew-x-[-12deg] border border-sky-300/35 px-8 py-2.5 text-sm tracking-[0.22em] text-sky-100/80 hover:border-sky-300/70"
            >
              <span className="block skew-x-[12deg]">SETTINGS</span>
            </button>
            <button
              onClick={quitToMenu}
              className="w-64 skew-x-[-12deg] border border-sky-300/20 px-8 py-2.5 text-sm tracking-[0.22em] text-sky-100/50 hover:border-red-400/60 hover:text-red-300"
            >
              <span className="block skew-x-[12deg]">ABANDON MISSION</span>
            </button>
            <Link
              to="/"
              className="mt-4 text-center text-[11px] uppercase tracking-[0.3em] text-white/30 hover:text-white/60"
            >
              ← back to the vibeverse
            </Link>
          </div>
        </div>
      )}

      {/* ---------------- DEAD ---------------- */}
      {screen === "dead" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-red-950/45 backdrop-blur-[2px]">
          <h2 className="text-5xl font-bold tracking-[0.3em] text-red-200">KIA</h2>
          <button
            onClick={() => {
              const w = worldRef.current;
              if (!w) return;
              w.player.respawn(w.player.position.clone().setY(w.player.position.y + 3));
              w.input.requestLock();
              setScreen("playing");
            }}
            className="mt-10 w-64 skew-x-[-12deg] border-2 border-sky-300/70 bg-sky-500/20 px-8 py-3 tracking-[0.22em] text-sky-50 hover:bg-sky-500/40"
          >
            <span className="block skew-x-[12deg]">RESPAWN</span>
          </button>
        </div>
      )}

      {/* ---------------- SETTINGS ---------------- */}
      {showSettings && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 p-6 backdrop-blur">
          <div className="max-h-full w-[min(560px,92vw)] overflow-y-auto border border-sky-300/30 bg-[#071626] p-7">
            <h3 className="mb-6 text-xl font-semibold tracking-[0.22em] text-sky-50">SETTINGS</h3>

            <div className="mb-5">
              <div className="mb-2 font-mono text-[11px] tracking-[0.2em] text-sky-300/70">QUALITY</div>
              <div className="grid grid-cols-4 gap-2">
                {(["low", "medium", "high", "ultra"] as QualityTier[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSettings((s) => ({ ...s, tier: t }))}
                    className={`border px-2 py-2 text-xs uppercase tracking-[0.12em] ${
                      settings.tier === t
                        ? "border-sky-300 bg-sky-500/30 text-sky-50"
                        : "border-sky-300/25 text-sky-100/60 hover:border-sky-300/60"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-sky-300/50">
                Takes effect on the next deploy. Resolution auto-scales in-game.
              </p>
            </div>

            {(
              [
                ["sensitivity", "LOOK SENSITIVITY", 0.2, 3, 0.05],
                ["fov", "FIELD OF VIEW", 60, 110, 1],
                ["masterVolume", "MASTER VOLUME", 0, 1, 0.05],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <label key={key} className="mb-4 block">
                <div className="mb-1 flex justify-between font-mono text-[11px] tracking-[0.2em] text-sky-300/70">
                  <span>{label}</span>
                  <span>{(settings[key] as number).toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={settings[key] as number}
                  onChange={(e) => setSettings((s) => ({ ...s, [key]: Number(e.target.value) }))}
                  className="w-full accent-sky-300"
                />
              </label>
            ))}

            {(
              [
                ["invertY", "INVERT Y AXIS"],
                ["filmGrain", "FILM GRAIN"],
                ["showFps", "SHOW PERFORMANCE"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="mb-3 flex cursor-pointer items-center justify-between">
                <span className="font-mono text-[11px] tracking-[0.2em] text-sky-300/70">{label}</span>
                <input
                  type="checkbox"
                  checked={settings[key] as boolean}
                  onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.checked }))}
                  className="h-4 w-4 accent-sky-300"
                />
              </label>
            ))}

            <button
              onClick={() => setShowSettings(false)}
              className="mt-6 w-full skew-x-[-12deg] border-2 border-sky-300/70 bg-sky-500/20 px-8 py-3 tracking-[0.22em] text-sky-50 hover:bg-sky-500/40"
            >
              <span className="block skew-x-[12deg]">CLOSE</span>
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Seafair failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-sky-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
