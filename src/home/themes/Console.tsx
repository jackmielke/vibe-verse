/**
 * Console — the ten-foot interface, built for a room rather than a desk.
 *
 * The layout every games console converged on independently, because it is the
 * one that works when the screen is across the room and the input is four
 * arrows: a single enormous hero, then horizontal rails you scroll sideways
 * through, and a focus ring you can see from the sofa.
 *
 * Two things make it real rather than a pastiche:
 *
 * - **It is keyboard-first.** Arrow keys move a cursor through the rails and
 *   Enter opens a world, because a console interface that can only be used with
 *   a mouse is a website with big pictures. The focused tile scrolls itself into
 *   view, which is the part everybody forgets and the part that makes it usable.
 * - **The rails scroll rather than wrap.** Every world in five rails, no
 *   pagination, no "see all" — the shelf just keeps going, which is the honest
 *   way to show a library that grows every week.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { shortStatus, useHomeData } from "@/home/kit";
import type { WorldEntry } from "@/worlds/registry";

const ACCENT = "#4ade80";

export default function Console() {
  const d = useHomeData();
  const nav = useNavigate();

  /* Five shelves cut from the running order, so promoting a world in the
     registry promotes it here too. */
  const rails = useMemo(() => {
    const all = [...d.featured, ...d.rest];
    const played = all.filter((w) => d.visited.has(w.route));
    const shelves: { title: string; items: WorldEntry[] }[] = [
      { title: "Featured", items: d.featured.slice(0, 10) },
      ...(played.length ? [{ title: "Jump back in", items: played.slice(0, 10) }] : []),
      { title: "Playable now", items: all.filter((w) => /playable|open/i.test(w.status ?? "")).slice(0, 12) },
      { title: "Recently updated", items: all.filter((w) => d.freshness(w.key)).slice(0, 12) },
      { title: "Everything else", items: d.rest.slice(0, 16) },
    ];
    return shelves.filter((s) => s.items.length);
  }, [d]);

  const hero = rails[0]?.items[0];
  const [cursor, setCursor] = useState<[number, number]>([0, 0]);
  const tiles = useRef(new Map<string, HTMLAnchorElement>());

  const key = (r: number, c: number) => `${r}:${c}`;

  const move = useCallback(
    (dr: number, dc: number) => {
      setCursor(([r, c]) => {
        const nr = Math.max(0, Math.min(rails.length - 1, r + dr));
        /* Changing row clamps the column rather than keeping it — a rail with
           four items must not leave the cursor on item nine, invisible. */
        const nc = Math.max(0, Math.min(rails[nr].items.length - 1, dr ? Math.min(c, rails[nr].items.length - 1) : c + dc));
        return [nr, nc];
      });
    },
    [rails],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(k)) return;
      if (k === "Enter") {
        const w = rails[cursor[0]]?.items[cursor[1]];
        if (w) nav(w.route);
        return;
      }
      e.preventDefault();
      if (k === "ArrowLeft") move(0, -1);
      if (k === "ArrowRight") move(0, 1);
      if (k === "ArrowUp") move(-1, 0);
      if (k === "ArrowDown") move(1, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, move, nav, rails]);

  /* Keep the cursor on screen. `block: "nearest"` so moving along a rail does
     not also jerk the page vertically. */
  useEffect(() => {
    tiles.current
      .get(key(cursor[0], cursor[1]))
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [cursor]);

  return (
    <div className="min-h-[100dvh] w-full bg-[#0c0f14] text-white">
      <div className="mx-auto max-w-[1500px] px-5 pb-20 pt-5 sm:px-8">
        <nav className="flex flex-wrap items-center gap-x-7 gap-y-2 font-heading text-[13px]">
          <span className="text-[16px] font-black tracking-tight">VIBEVERSE</span>
          <Link to="/game" className="text-white/55 hover:text-white">Worlds</Link>
          <Link to="/arcade" className="text-white/55 hover:text-white">Arcade</Link>
          <Link to="/build" className="text-white/55 hover:text-white">Create</Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="ml-auto rounded-md border border-white/15 px-3 py-1.5 font-mono text-[12px]"
            style={{ color: ACCENT }}
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* The hero. Art bleeds off the right; everything readable is on the
            left third, over a scrim that is horizontal rather than vertical —
            a bottom-up gradient would put the text on the busiest part. */}
        {hero && (
          <div className="relative mt-5 overflow-hidden rounded-2xl bg-black">
            <div className="aspect-[16/10] sm:aspect-[24/9]">
              {d.art(hero.key) && (
                <img src={d.art(hero.key)} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="absolute inset-0 bg-gradient-to-r from-[#0c0f14] via-[#0c0f14]/70 to-transparent" />
            <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center p-6 sm:p-12">
              <p className="font-heading text-[9.5px] font-black uppercase tracking-[0.3em]" style={{ color: ACCENT }}>
                Featured world
              </p>
              <h1 className="mt-2.5 font-heading text-[30px] font-black leading-[0.95] tracking-tight sm:text-[52px]">
                {hero.name}
              </h1>
              <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-white/70 sm:text-[15px]">
                {hero.blurb}
              </p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <Link
                  to={hero.route}
                  className="rounded-md px-6 py-2.5 font-heading text-[13px] font-black text-black"
                  style={{ background: ACCENT }}
                >
                  ▶ Play
                </Link>
                <Link
                  to="/game"
                  className="rounded-md border border-white/25 px-6 py-2.5 font-heading text-[13px] font-bold text-white/85"
                >
                  Library
                </Link>
              </div>
            </div>
          </div>
        )}

        <p className="mt-4 hidden font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/30 sm:block">
          ← → ↑ ↓ to browse · Enter to play
        </p>

        <div className="mt-6 space-y-8">
          {rails.map((rail, r) => (
            <section key={rail.title}>
              <h2 className="font-heading text-[13px] font-black uppercase tracking-[0.14em] text-white/80">
                {rail.title}
                <span className="ml-2 font-mono text-[10.5px] font-normal tracking-normal text-white/30">
                  {rail.items.length}
                </span>
              </h2>

              {/* `-mx` + `px` so the rail's contents can scroll edge to edge
                  while the page gutter is preserved. */}
              <div className="-mx-5 mt-3 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="flex gap-3">
                  {rail.items.map((w, c) => {
                    const on = cursor[0] === r && cursor[1] === c;
                    return (
                      <Link
                        key={w.key}
                        to={w.route}
                        ref={(el) => {
                          if (el) tiles.current.set(key(r, c), el);
                          else tiles.current.delete(key(r, c));
                        }}
                        onMouseEnter={() => setCursor([r, c])}
                        className="group relative w-[190px] shrink-0 overflow-hidden rounded-xl bg-white/[0.04] transition-transform sm:w-[248px]"
                        style={{
                          outline: on ? `3px solid ${ACCENT}` : "3px solid transparent",
                          outlineOffset: "-3px",
                          transform: on ? "scale(1.03)" : undefined,
                        }}
                      >
                        <div className="aspect-[16/10] overflow-hidden bg-black">
                          {d.art(w.key) && (
                            <img
                              src={d.art(w.key)}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover opacity-85 transition-opacity group-hover:opacity-100"
                            />
                          )}
                        </div>
                        <div className="px-3 py-2.5">
                          <h3 className="truncate font-heading text-[13px] font-bold">{w.name}</h3>
                          <p className="mt-0.5 truncate font-mono text-[9.5px] uppercase tracking-[0.1em] text-white/35">
                            {shortStatus(w.status) ?? "World"}
                            {d.visited.has(w.route) ? " · played" : ""}
                          </p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
