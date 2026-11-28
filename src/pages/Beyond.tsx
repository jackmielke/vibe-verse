/**
 * /beyond: the secret world behind the Monolith.
 *
 * Deliberately not in the world registry: there is no card, no nav chip and
 * no passport stamp. The only door is the Monolith itself, which stands in a
 * different world every day (`src/monolith/schedule.ts`). The world is in
 * `src/monolith/beyond.ts`; this page is the HUD and the way home.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Joystick } from "@/magician/ui/Joystick";
import { useActiveCharacter } from "@/hooks/use-active-character";
import type { Beyond as World, BeyondHud } from "@/monolith/beyond";
import { readStarborn, setStarlight } from "@/monolith/starSkin";
import { HOSTS, secondsUntilItMoves, today } from "@/monolith/schedule";
import { arrivedByWarp, coverNow, warpIn, warpOut } from "@/monolith/warp";

/** Only ever a path on this site. */
function safeReturn(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return today().host.route;
  return raw;
}

function hoursLeft(): string {
  const s = secondsUntilItMoves();
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export default function Beyond() {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const { character } = useActiveCharacter();
  const [hud, setHud] = useState<BeyondHud | null>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState(true);
  const [star, setStar] = useState(() => readStarborn());
  const [justReborn, setJustReborn] = useState(false);
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  const [from] = useState(() => safeReturn(new URLSearchParams(window.location.search).get("from")));
  const leaving = useRef(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const warped = arrivedByWarp();
    if (warped) coverNow();
    const t = window.setTimeout(() => setTitle(false), 6500);
    let world: World | null = null;
    let cancelled = false;
    void import("@/monolith/beyond").then(({ createBeyond }) => {
      if (cancelled || !mountRef.current) return;
      try {
        world = createBeyond(mountRef.current, {
          charId: character.id,
          onHud: setHud,
          onReborn: () => { setStar(readStarborn()); setJustReborn(true); },
        });
        worldRef.current = world;
        if (warped) void warpOut(2.4);
      } catch (e) {
        console.error(e);
        setFailed(true);
      }
    }).catch((e) => { console.error(e); setFailed(true); });
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      document.body.style.overflow = prev;
      world?.dispose();
      worldRef.current = null;
      document.getElementById("monolith-warp")?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goHome = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    await warpIn(2.2);
    // Skip the splash on the way back in: you have already chosen to be there.
    const url = new URL(from, window.location.origin);
    if (!url.searchParams.has("go")) url.searchParams.set("go", "1");
    window.location.assign(url.pathname + url.search);
  }, [from]);

  const onStick = useCallback((x: number, y: number) => worldRef.current?.setStick(x, y), []);
  const fromName = HOSTS.find((h) => from.startsWith(h.route.split("?")[0]))?.name ?? "the Vibe Verse";
  const card = "rounded-2xl bg-[#07051a]/70 ring-1 ring-[#bfaeff]/25 backdrop-blur-md";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#020107] text-white" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="text-lg">The way is closed for now.</div>
          <button className={`${card} px-5 py-2.5`} onClick={() => window.location.assign(from)}>Go back</button>
        </div>
      ) : null}

      {/* The title card, once, on arrival. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-[22%] flex flex-col items-center gap-2 px-6 text-center transition-opacity duration-[2000ms]"
        style={{ opacity: title ? 1 : 0 }}
      >
        <div className="text-[11px] font-semibold tracking-[0.5em] text-[#c9b8ff]/80">YOU HAVE BEEN TAKEN</div>
        <div className="text-4xl font-light tracking-[0.35em] sm:text-5xl">THE BEYOND</div>
        <div className="mt-2 max-w-md text-[14px] text-white/70">Walk into the light.</div>
      </div>

      {hud ? (
        <>
          {/* Top: what to do, and how far. */}
          <div className="pointer-events-none absolute inset-x-0 flex justify-center px-3" style={{ top: "max(env(safe-area-inset-top), 14px)" }}>
            <div className={`${card} px-4 py-2 text-center text-[13px]`}>
              {hud.phase === "rising" ? (
                <span className="text-[#ffe9b8]">Something is changing…</span>
              ) : justReborn ? (
                <span><b className="text-[#ffe9b8]">You are starborn.</b> You carry the night sky now.</span>
              ) : (
                <span className="text-white/85">
                  Walk into the light · <span style={{ fontFamily: "ui-monospace, monospace" }}>{Math.round(hud.distance)} m</span>
                </span>
              )}
            </div>
          </div>

          {/* After the rebirth: what it means. */}
          {justReborn && hud.phase === "reborn" ? (
            <div className="absolute inset-x-0 flex justify-center px-4" style={{ bottom: phone ? 190 : 110 }}>
              <div className={`${card} max-w-md px-5 py-4 text-center text-[14px] leading-snug`}>
                Your character keeps this skin in Vibe Island, Vibe Summit and the Magician's valley.
                <div className="mt-1 text-[12px] text-white/55">
                  The Monolith moves on in {hoursLeft()}. Tomorrow it stands somewhere else.
                </div>
                <div className="mt-3 flex justify-center gap-2">
                  <button className="rounded-full bg-[#ffe9b8] px-4 py-2 text-[13px] font-bold text-[#140d2e]" onClick={goHome}>
                    Return to {fromName}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Bottom right: home, and the starlight switch once earned. */}
          <div className="absolute flex flex-col items-end gap-2" style={{ right: "max(env(safe-area-inset-right), 12px)", bottom: "max(env(safe-area-inset-bottom), 16px)" }}>
            {star.earned ? (
              <button
                className={`${card} px-3 py-2 text-[12px]`}
                onClick={() => setStar(setStarlight(!star.on))}
              >
                {star.on ? "✦ Starlight on" : "✧ Starlight off"}
              </button>
            ) : null}
            <button className={`${card} px-4 py-2 text-[13px] font-semibold`} onClick={goHome}>↩ Return to {fromName}</button>
          </div>

          {phone ? (
            <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 18px)", bottom: "max(env(safe-area-inset-bottom), 24px)" }}>
              <Joystick onMove={onStick} />
            </div>
          ) : (
            <div className="pointer-events-none absolute text-[11px] text-white/45" style={{ left: 14, bottom: 14 }}>
              WASD or click the ground to walk · drag to look
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
