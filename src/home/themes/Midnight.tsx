/**
 * Midnight — the one from the mock.
 *
 * A moon low behind cloud, a glass nav that floats rather than sits, a stat bar
 * that reads like a dashboard, and cards with the picture doing all the work.
 * Closest of the fifteen to what was drawn, and the reference the others are
 * arguing with.
 *
 * The hero is deliberately enormous and deliberately empty on the right: the
 * moon needs somewhere to be, and a headline that fills the width would fight
 * it. Everything below is calm so the top can be loud.
 */
import { Link } from "react-router-dom";

import { Clouds, Grain, Moon, shortStatus, useHomeData } from "@/home/kit";
import StarField from "@/components/StarField";

export default function Midnight() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 12);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#05070d] text-white">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <StarField density={220} seed={0x91a} />
        <Moon size={760} x="52%" y="2%" />
        <Clouds tint="rgba(160,180,225,0.34)" />
        <div className="absolute inset-x-0 bottom-0 h-[55vh] bg-gradient-to-t from-[#05070d] via-[#05070d]/85 to-transparent" />
      </div>
      <Grain opacity={0.1} />

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        {/* Nav floats on glass — it is over a photograph, not on a surface. */}
        <nav className="sticky top-4 z-20 mt-4 flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 backdrop-blur-xl">
          <span className="flex items-center gap-2 pl-1 pr-2 font-heading text-[15px] font-black tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-[13px]">⚡</span>
            VibeVerse
          </span>
          <div className="hidden items-center gap-1 sm:flex">
            {[
              ["Worlds", "/game"],
              ["Arcade", "/arcade"],
              ["Create", "/build"],
            ].map(([label, to], i) => (
              <Link
                key={label}
                to={to}
                className={`rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors ${
                  i === 0 ? "bg-white/15 font-semibold" : "text-white/65 hover:text-white"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-[12px] text-white/50 md:block">
              Search worlds…
            </span>
            <Link
              to={d.coin.signedIn ? "/shop" : "/profile"}
              className="rounded-full border border-[#7dffd4]/40 px-3 py-1.5 font-mono text-[12px] text-[#7dffd4] transition-colors hover:bg-[#7dffd4]/10"
            >
              {d.coin.signedIn ? d.coin.display : "Sign in"}
            </Link>
          </div>
        </nav>

        <header className="pt-20 sm:pt-28">
          <p className="font-heading text-[9.5px] font-bold uppercase tracking-[0.34em] text-white/45">
            Powered by creators, owned by players
          </p>
          <h1 className="mt-4 font-heading text-[3.4rem] font-black leading-[0.92] tracking-[-0.03em] sm:text-[5.5rem]">
            VibeVerse
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/70">
            A massive collection of AI-coded games. No install, no account, no
            launcher — pick a card and you are in.
          </p>

          <div className="mt-7 flex flex-wrap gap-2.5">
            <Link
              to="/game"
              className="rounded-full bg-white px-5 py-2.5 font-heading text-[12.5px] font-bold text-black transition-transform hover:scale-[1.03]"
            >
              Explore worlds
            </Link>
            <Link
              to="/manifesto"
              className="rounded-full border border-white/20 px-5 py-2.5 font-heading text-[12.5px] font-bold text-white/85 transition-colors hover:bg-white/10"
            >
              How it works
            </Link>
          </div>

          {/* The dashboard strip. Four numbers, hairlines between them. */}
          <dl className="mt-9 inline-flex flex-wrap items-center divide-x divide-white/10 rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md">
            {[
              [String(d.counts.worlds), "worlds"],
              [d.coin.display, "vibey"],
              [`${d.passport.visited}/${d.passport.total}`, "passport"],
              [String(d.counts.playable), "playable"],
            ].map(([v, k]) => (
              <div key={k} className="px-5 py-3">
                <dd className="font-heading text-lg font-black tabular-nums">{v}</dd>
                <dt className="mt-0.5 font-heading text-[8.5px] uppercase tracking-[0.18em] text-white/45">
                  {k}
                </dt>
              </div>
            ))}
          </dl>
        </header>

        {d.issue && (
          <Link
            to="/times"
            className="mt-12 block rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-md transition-colors hover:bg-white/[0.07]"
          >
            <div className="flex items-baseline gap-2.5">
              <span className="font-heading text-[9px] font-black uppercase tracking-[0.2em] text-[#8fb4ff]">
                The Vibe Times
              </span>
              <span className="text-[10.5px] text-white/40">today</span>
              <span className="ml-auto font-heading text-[9px] uppercase tracking-wider text-white/40">
                Read it →
              </span>
            </div>
            <h2 className="mt-1.5 font-heading text-[15px] font-bold">
              {d.issue.headlines[0]?.headline}
            </h2>
            <p className="mt-1 line-clamp-1 text-[12px] text-white/50">
              {d.issue.headlines[0]?.body}
            </p>
          </Link>
        )}

        <section className="mt-12">
          <div className="flex items-baseline gap-3">
            <h2 className="font-heading text-sm font-black uppercase tracking-wider">Featured</h2>
            <Link to="/game" className="ml-auto text-[11px] text-white/45 hover:text-white">
              all {d.counts.worlds} →
            </Link>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            {cards.map((w) => {
              const art = d.art(w.key);
              return (
                <Link
                  key={w.key}
                  to={w.route}
                  className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:-translate-y-1 hover:border-white/25"
                >
                  <div className="relative aspect-[16/10] overflow-hidden bg-black/60">
                    {art && (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                      />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    {shortStatus(w.status) && (
                      <span className="absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2 py-0.5 font-heading text-[8px] font-bold uppercase tracking-[0.14em] text-white/85 backdrop-blur">
                        {shortStatus(w.status)}
                      </span>
                    )}
                  </div>
                  <div className="p-3.5">
                    <h3 className="font-heading text-[13.5px] font-bold">
                      {w.emoji} {w.name}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-white/50">
                      {w.blurb}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
