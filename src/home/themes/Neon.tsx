/**
 * Neon — an arcade cabinet, in attract mode.
 *
 * The one theme where the cards move on their own. A real cabinet does not sit
 * on a menu waiting to be read; it plays itself at nobody, loudly, until
 * somebody puts a coin in. So the lead tile cycles through the worlds that have
 * a recording, and hovering any card swaps its still for the gameplay GIF.
 *
 * The still is always what loads. `motion.ts` is deliberately kept off the
 * initial paint — fifty cards of GIF is six megabytes on a page whose argument
 * is that it opens instantly — so hovering is the trigger everywhere except the
 * marquee, which is one file and is the point of the design.
 *
 * Everything else is bezel: a chrome marquee, scanlines, and colour used the way
 * a cabinet uses it, which is on the edges rather than in the middle.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Scanlines, shortStatus, useHomeData } from "@/home/kit";

const CYAN = "#22e6ff";
const MAGENTA = "#ff2fb0";
const AMBER = "#ffc247";

export default function Neon() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 12);
  const reels = cards.filter((w) => d.motion(w.key));
  const [reel, setReel] = useState(0);
  /** Cards that have been hovered at least once, and so may load their GIF. */
  const [woke, setWoke] = useState<Set<string>>(() => new Set());

  /* Attract mode: the marquee changes world every few seconds. Only ever
     between worlds that have a recording, so it never blinks to a still. */
  useEffect(() => {
    if (reels.length < 2) return;
    const t = setInterval(() => setReel((r) => (r + 1) % reels.length), 5200);
    return () => clearInterval(t);
  }, [reels.length]);

  const hero = reels[reel] ?? cards[0];

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#07060c] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 45% at 50% 0%, rgba(34,230,255,0.16), transparent 65%)," +
            "radial-gradient(60% 40% at 50% 100%, rgba(255,47,176,0.14), transparent 65%)",
        }}
      />
      <Scanlines opacity={0.16} />

      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-8">
        {/* Marquee. The glowing strip along the top of the cabinet. */}
        <div
          className="relative overflow-hidden rounded-lg border-y-4 px-4 py-4 text-center sm:px-8"
          style={{
            borderColor: CYAN,
            background: "linear-gradient(180deg,#131024,#08060f)",
            boxShadow: `0 0 40px ${CYAN}33, inset 0 0 30px ${CYAN}22`,
          }}
        >
          <h1
            className="font-heading font-black uppercase leading-none tracking-[0.02em]"
            style={{
              fontSize: "clamp(2rem, 8vw, 4.5rem)",
              color: "#fff",
              textShadow: `0 0 6px #fff, 0 0 22px ${CYAN}, 0 0 48px ${MAGENTA}`,
            }}
          >
            Vibeverse
          </h1>
          <p
            className="mt-2 font-heading text-[9.5px] font-bold uppercase tracking-[0.32em]"
            style={{ color: AMBER }}
          >
            Powered by creators · owned by players
          </p>
        </div>

        <nav className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-heading text-[11px] font-bold uppercase tracking-[0.18em]">
          {[
            ["Worlds", "/game"],
            ["Arcade", "/arcade"],
            ["Create", "/build"],
            ["Shop", "/shop"],
          ].map(([label, to]) => (
            <Link key={label} to={to} className="text-white/55 transition-colors hover:text-white">
              {label}
            </Link>
          ))}
          <Link to={d.coin.signedIn ? "/shop" : "/profile"} className="font-mono tracking-normal" style={{ color: AMBER }}>
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* The screen. Bezel, glass, and something already happening on it. */}
        {hero && (
          <Link
            to={hero.route}
            className="group relative mt-7 block overflow-hidden rounded-2xl border-4 bg-black"
            style={{ borderColor: "#1b1830", boxShadow: `0 0 0 2px ${MAGENTA}55, 0 30px 90px #000` }}
          >
            <div className="relative aspect-[16/9] sm:aspect-[21/9]">
              {/* The recordings are 320px wide, so on a 21:9 hero they are
                  upscaled three times over. Smoothed that reads as a blurry
                  JPEG; left hard it reads as a low-resolution arcade screen,
                  which is the thing being imitated. */}
              <img
                key={hero.key}
                src={d.motion(hero.key) ?? d.art(hero.key)}
                alt=""
                className="h-full w-full object-cover opacity-90"
                style={d.motion(hero.key) ? { imageRendering: "pixelated" } : undefined}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/25 to-transparent" />
              {/* Curved-glass sheen — one highlight, top-left, is enough. */}
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    "radial-gradient(80% 55% at 22% 0%, rgba(255,255,255,0.13), transparent 60%)",
                }}
              />
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end gap-x-4 gap-y-2 p-5 sm:p-7">
              <div className="min-w-0">
                <p
                  className="font-heading text-[9px] font-black uppercase tracking-[0.28em]"
                  style={{ color: CYAN }}
                >
                  Now playing
                </p>
                <h2 className="mt-1 font-heading text-[26px] font-black uppercase leading-none tracking-tight sm:text-[40px]">
                  {hero.name}
                </h2>
                <p className="mt-1.5 line-clamp-1 max-w-lg text-[12.5px] text-white/60">
                  {hero.blurb}
                </p>
              </div>
              <span
                className="ml-auto shrink-0 rounded px-4 py-2 font-heading text-[11px] font-black uppercase tracking-[0.18em] text-black transition-transform group-hover:scale-105"
                style={{ background: AMBER }}
              >
                Insert coin ▸
              </span>
            </div>
          </Link>
        )}

        <div className="mt-8 flex items-baseline gap-3 border-b border-white/10 pb-2">
          <h2
            className="font-heading text-[11px] font-black uppercase tracking-[0.24em]"
            style={{ color: MAGENTA }}
          >
            Select your game
          </h2>
          <span className="ml-auto font-mono text-[10.5px] text-white/35">
            {d.counts.worlds} cabinets · {d.passport.visited} played
          </span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {cards.map((w) => {
            const still = d.art(w.key);
            const been = d.visited.has(w.route);
            return (
              <Link
                key={w.key}
                to={w.route}
                className="group relative overflow-hidden rounded-lg border-2 border-white/10 bg-black transition-all hover:-translate-y-1"
                style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}
                onMouseEnter={() => woke.has(w.key) || setWoke(new Set(woke).add(w.key))}
              >
                <div className="relative aspect-[4/3] overflow-hidden">
                  {still && (
                    <img
                      src={still}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover opacity-80 transition-opacity duration-300 group-hover:opacity-0"
                    />
                  )}
                  {/* Mounted only once the card has been hovered, so a page
                      nobody touches downloads none of them. */}
                  {woke.has(w.key) && d.motion(w.key) && (
                    <img
                      src={d.motion(w.key)}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                      style={{ imageRendering: "pixelated" }}
                    />
                  )}
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100"
                    style={{ boxShadow: `inset 0 0 0 2px ${CYAN}` }}
                  />
                  {been && (
                    <span
                      className="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 font-heading text-[8px] font-black uppercase tracking-[0.12em] text-black"
                      style={{ background: AMBER }}
                    >
                      Played
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-2 px-2.5 py-2">
                  <h3 className="truncate font-heading text-[12px] font-black uppercase tracking-tight">
                    {w.name}
                  </h3>
                  {shortStatus(w.status) && (
                    <span className="ml-auto shrink-0 font-mono text-[8.5px] uppercase text-white/30">
                      {shortStatus(w.status)}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="mt-7 text-center">
          <Link
            to="/game"
            className="inline-block rounded px-6 py-3 font-heading text-[11.5px] font-black uppercase tracking-[0.2em] text-black"
            style={{ background: CYAN }}
          >
            All {d.counts.worlds} cabinets
          </Link>
        </div>
      </div>
    </div>
  );
}
