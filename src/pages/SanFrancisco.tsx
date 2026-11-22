/**
 * /sf — SAN FRANCISCO: FREE FALL
 *
 * The Vibeverse's open-world San Francisco. Walk it as your own character, or
 * take the free camera and cover the whole nine kilometres in a few seconds.
 *
 * The page owns the chrome and nothing else: a way out, a way to swap bodies,
 * a way to jump across town, and a controls hint that gets out of the way. The
 * world itself is `@/sf`, lazily.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { SPAWN_DEFS } from "@/sf/geo/spawnList";

const SanFranciscoGame = lazy(() => import("@/sf/SanFranciscoGame"));

function Loader() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#05070c] text-white">
      <div className="text-[11px] uppercase tracking-[0.42em] text-white/40">Vibeverse</div>
      <h1 className="mt-3 text-center font-black uppercase leading-[0.92] tracking-tight text-4xl sm:text-6xl">
        San Francisco
        <span className="block text-[#ff6a2b]">Free Fall</span>
      </h1>
      <div className="mt-8 h-[2px] w-56 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[sfsweep_1.4s_ease-in-out_infinite] rounded-full bg-[#ff6a2b]" />
      </div>
      <p className="mt-5 text-xs tracking-wide text-white/35">Streaming the city…</p>
      <style>{`@keyframes sfsweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}`}</style>
    </div>
  );
}

const CHIP =
  "pointer-events-auto inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-black/45 px-3.5 " +
  "text-[11px] font-semibold uppercase tracking-[0.18em] text-white/80 backdrop-blur-sm " +
  "ring-1 ring-white/15 transition active:scale-95 hover:text-white";

/** The character grid. Emoji and accent, not portraits — every character has
 *  those, and only some have a render. */
function CharacterSheet({ onClose }: { onClose: () => void }) {
  const { charId, setCharId, all } = useActiveCharacter();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  }, [all, query]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex flex-col bg-black/80 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)]">
        <h2 className="text-sm font-black uppercase tracking-[0.22em] text-white">
          Who are you today
        </h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="ml-auto w-32 rounded-lg bg-white/10 px-3 py-2 text-xs text-white
                     placeholder:text-white/35 outline-none ring-1 ring-white/15 focus:ring-white/35"
        />
        <button onClick={onClose} className={CHIP} style={{ WebkitTapHighlightColor: "transparent" }}>
          Done
        </button>
      </div>
      <div className="grid flex-1 grid-cols-3 gap-2 overflow-y-auto p-4 sm:grid-cols-5 md:grid-cols-8">
        {shown.map((c) => (
          <button
            key={c.id}
            onClick={() => setCharId(c.id)}
            className={`flex min-h-[84px] flex-col items-center justify-center gap-1 rounded-xl p-2
                        text-center transition active:scale-95 ${
                          c.id === charId
                            ? "bg-white/15 ring-2"
                            : "bg-white/5 ring-1 ring-white/10 hover:bg-white/10"
                        }`}
            style={{ ...(c.id === charId ? { boxShadow: `0 0 0 2px ${c.accent}` } : null) }}
          >
            <span className="text-2xl leading-none">{c.emoji}</span>
            <span className="text-[10px] leading-tight text-white/70">{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Jump across town. The same spawn list the world already knows about. */
function SpawnSheet({
  onPick,
  onClose,
}: {
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex flex-col bg-black/80 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)]">
        <h2 className="text-sm font-black uppercase tracking-[0.22em] text-white">Go somewhere</h2>
        <button onClick={onClose} className={`${CHIP} ml-auto`}>
          Close
        </button>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-2 overflow-y-auto p-4 sm:grid-cols-2 md:grid-cols-3">
        {SPAWN_DEFS.map((s) => (
          <button
            key={s.key}
            onClick={() => onPick(s.key)}
            className="rounded-xl bg-white/5 p-3 text-left ring-1 ring-white/10 transition
                       active:scale-95 hover:bg-white/10"
          >
            <div className="text-sm font-bold text-white">{s.name}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-white/50">{s.blurb}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The thin chrome over the canvas. Hidden entirely in capture mode so it never
 * lands in a shot.
 */
function Overlay({
  mode,
  vibe,
  onMode,
  onVibe,
  onSpawn,
  charLabel,
}: {
  mode: "walk" | "fly";
  vibe: "stroll" | "mayhem";
  onMode: (m: "walk" | "fly") => void;
  onVibe: (v: "stroll" | "mayhem") => void;
  onSpawn: (key: string) => void;
  charLabel: string;
}) {
  const [hint, setHint] = useState(true);
  const [touch, setTouch] = useState(false);
  const [sheet, setSheet] = useState<"char" | "spawn" | null>(null);
  /* The world's own screens — the map, the pause menu — own the whole
     viewport while they are up, and this strip used to float over them.
     `SfUi` announces its route; the strip steps aside for anything but
     play. */
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    setTouch(window.matchMedia("(hover: none), (pointer: coarse)").matches);
    const t = window.setTimeout(() => setHint(false), 9000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onRoute = (e: Event) => setCovered((e as CustomEvent<string>).detail !== "none");
    window.addEventListener("sf:route", onRoute);
    return () => window.removeEventListener("sf:route", onRoute);
  }, []);

  /* This strip is 44 px of chrome across the top of the HUD's corners. The
     HUD reads `--sf-top-clear` and starts below it — on a phone the minimap
     used to sit exactly under these buttons. */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--sf-top-clear", "56px");
    return () => {
      root.style.removeProperty("--sf-top-clear");
    };
  }, []);

  // The hint is about the controls, so it comes back when the controls change.
  useEffect(() => {
    setHint(true);
    const t = window.setTimeout(() => setHint(false), 7000);
    return () => window.clearTimeout(t);
  }, [mode]);

  return (
    <>
      <div
        className="pointer-events-none fixed inset-0 z-10 select-none"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingLeft: "max(env(safe-area-inset-left), 12px)",
          paddingRight: "max(env(safe-area-inset-right), 12px)",
          paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
        }}
      >
        {/* One row, scrolling sideways when the phone is too narrow for
            all of it, starting after the home button's corner. The way
            back to the hub is that button — a second "Worlds" chip sat
            underneath it on every screen. */}
        <div
          className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 transition-opacity duration-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            paddingLeft: "var(--vv-home-clear, 56px)",
            WebkitOverflowScrolling: "touch",
            opacity: covered ? 0 : 1,
            pointerEvents: covered ? "none" : undefined,
          }}
        >
          <button
            onClick={() => onMode(mode === "walk" ? "fly" : "walk")}
            className={CHIP}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            {mode === "walk" ? "🚶 Walking" : "🕊 Flying"}
          </button>
          {mode === "walk" ? (
            <button
              onClick={() => setSheet("char")}
              className={CHIP}
              style={{ WebkitTapHighlightColor: "transparent" }}
            >
              {charLabel}
            </button>
          ) : null}
          <button
            onClick={() => setSheet("spawn")}
            className={CHIP}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            📍 Go
          </button>
          {mode === "walk" ? (
            <button
              onClick={() => onVibe(vibe === "stroll" ? "mayhem" : "stroll")}
              className={CHIP}
              style={{ WebkitTapHighlightColor: "transparent" }}
              title={
                vibe === "stroll"
                  ? "Just the city: people, traffic, cars you can drive"
                  : "Weapons, police and a wanted level"
              }
            >
              {vibe === "stroll" ? "🌤 Stroll" : "🚨 Mayhem"}
            </button>
          ) : null}
        </div>

        <div
          className={`absolute inset-x-0 bottom-0 flex justify-center transition-opacity duration-700
                      ${hint ? "opacity-100" : "opacity-0"}`}
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 18px)" }}
        >
          <p
            className="mx-4 rounded-full bg-black/50 px-4 py-2 text-center text-[11px]
                       leading-relaxed text-white/70 backdrop-blur-sm ring-1 ring-white/10"
          >
            {mode === "walk"
              ? touch
                ? "Left thumb to walk · right thumb to look · GET IN for a car · WAVE to say hello"
                : // F is the whole open world: it is how you get into a car, and
                  // nothing on screen says so otherwise. Z is the only thing you
                  // can say to another person, so it belongs here too.
                  "Click to capture the mouse · WASD to walk · Shift to run · Space to jump · F to get in a car · Z to wave · T to change camera · M for the map"
              : touch
                ? "Left thumb to move · right thumb to look"
                : "Click to capture the mouse · WASD to fly · Shift to boost · Space / C for altitude"}
          </p>
        </div>
      </div>

      {sheet === "char" ? <CharacterSheet onClose={() => setSheet(null)} /> : null}
      {sheet === "spawn" ? (
        <SpawnSheet
          onPick={(k) => {
            setSheet(null);
            onSpawn(k);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

export default function SanFrancisco() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/sf", "San Francisco");

  const [params, setParams] = useSearchParams();
  const spawn = params.get("spawn") ?? "market";
  const mode = params.get("mode") === "fly" ? "fly" : "walk";
  // Stroll unless somebody asked for the other thing, and they have to ask by
  // name — no remembered preference, no "last time you played". Opening a link
  // to San Francisco should never drop you into a firefight.
  /* The one exception is the door with the game's own name on it. `/free-fall`
     is not "a link to San Francisco": somebody who opens it asked for the game,
     so it starts as the game, and the chip still switches back to the city. */
  const { pathname } = useLocation();
  const vibeParam = params.get("vibe");
  const vibe =
    vibeParam === "mayhem" || (vibeParam === null && pathname.replace(/\/+$/, "") === "/free-fall")
      ? "mayhem"
      : "stroll";
  const forced = params.get("quality");
  const quality =
    forced === "low" || forced === "medium" || forced === "high" || forced === "ultra"
      ? forced
      : undefined;
  const capturing = params.has("shot");
  const { charId, character } = useActiveCharacter();
  // One door for who you are, however you signed in — see docs/social-sign-in.md.
  const { displayName } = useVibeIdentity();
  /* Multiplayer is on by default, because a city with nobody in it is the
     thing we were trying to stop it being. `local` shares with other tabs of
     this browser and needs no network at all; `off` opens no socket. */
  const netParam = params.get("net");
  const net = netParam === "off" || netParam === "local" ? netParam : "online";
  const room = params.get("room") ?? "sf";

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <Suspense fallback={<Loader />}>
      {/* Keyed on mode and character so switching either one rebuilds the
          controller and the rig from a clean slate rather than trying to hand
          a half-simulated player between two of them. */}
      {/* Keyed on the vibe too: switching it tears down the weapon stack, the
          opposition and the director rather than leaving half of each behind. */}
      <SanFranciscoGame
        key={`${mode}:${charId}:${vibe}`}
        spawn={spawn}
        mode={mode}
        vibe={vibe}
        quality={quality}
        net={net}
        room={room}
        playerName={displayName}
        charId={charId}
      />
      {capturing ? null : (
        <Overlay
          mode={mode}
          vibe={vibe}
          onMode={(m) => setParam("mode", m)}
          onVibe={(v) => setParam("vibe", v)}
          onSpawn={(k) => setParam("spawn", k)}
          charLabel={`${character.emoji} ${character.label}`}
        />
      )}
    </Suspense>
  );
}
