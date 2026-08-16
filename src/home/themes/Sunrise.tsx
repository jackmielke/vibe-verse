/**
 * Sunrise — one long warm gradient, and almost nothing on it.
 *
 * The whole page is a single sky from deep violet at the top to peach at the
 * bottom, and the content thins as it descends into the light. It is the only
 * theme with no container edge anywhere: no card borders, no rules, no boxes.
 * Worlds are art with a name under it, floating.
 *
 * That is a real risk and it is the point — a page with no boxes has nothing to
 * hide a weak crop behind, so it is the honest test of whether the card art is
 * actually good. If a world looks bad here, the world's capture needs redoing.
 *
 * The gradient is on the page rather than on a fixed layer, so scrolling
 * genuinely travels through it. A fixed sky would look identical in a
 * screenshot and dead in the hand, which is the failure mode worth avoiding.
 */
import { Link } from "react-router-dom";

import { Grain, useHomeData } from "@/home/kit";

export default function Sunrise() {
  const d = useHomeData();
  const lead = d.featured.slice(0, 3);
  const rest = [...d.featured.slice(3), ...d.rest].slice(0, 15);

  return (
    <div
      /* `overflow-x-clip`, not `overflow-hidden`: the sun is wider than a phone
         and would otherwise push the page sideways, but clipping with `hidden`
         makes this a scroll container and kills `position: sticky` for anything
         inside it later. */
      className="relative min-h-[100dvh] w-full overflow-x-clip"
      style={{
        /* The stops are front-loaded on purpose. Spread evenly across a page
           this tall, the first whole viewport is one flat violet and the theme
           is called Sunrise on the strength of something you have to scroll
           three screens to see. The sky has to be visibly turning above the
           fold. */
        background:
          "linear-gradient(180deg,#211236 0%,#54265a 9%,#8c3a55 22%,#c25546 36%,#e8804f 50%,#f4a86a 64%,#f8c78f 80%,#fbe3c4 100%)",
        color: "#fff5ea",
      }}
    >
      <Grain opacity={0.12} />

      <div className="relative z-10 mx-auto max-w-5xl px-6 pb-28 pt-7 sm:px-10">
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px]">
          <span className="font-heading text-[14px] font-black tracking-tight">vibeverse</span>
          <Link to="/game" className="opacity-70 transition-opacity hover:opacity-100">Worlds</Link>
          <Link to="/arcade" className="opacity-70 transition-opacity hover:opacity-100">Arcade</Link>
          <Link to="/build" className="opacity-70 transition-opacity hover:opacity-100">Create</Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="ml-auto opacity-70 transition-opacity hover:opacity-100"
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* The sun. One circle, sitting on the horizon of the gradient. */}
        <header className="relative py-24 text-center sm:py-32">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[440px] w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-full sm:h-[560px] sm:w-[560px]"
            style={{
              background:
                "radial-gradient(circle, rgba(255,232,196,0.75) 0%, rgba(255,178,116,0.38) 38%, rgba(255,150,100,0.14) 58%, transparent 72%)",
            }}
          />
          <p className="font-heading text-[9.5px] font-bold uppercase tracking-[0.4em] opacity-70">
            Powered by creators · owned by players
          </p>
          <h1
            className="mt-6 font-heading font-black leading-[0.92] tracking-[-0.035em]"
            style={{ fontSize: "clamp(2.8rem, 9vw, 5.6rem)" }}
          >
            Somewhere
            <br />
            new to be
          </h1>
          <p className="mx-auto mt-6 max-w-md text-[15px] leading-relaxed opacity-80">
            {d.counts.worlds} worlds, all of them a browser tab away. No install,
            no launcher, no account — just somewhere to go for twenty minutes.
          </p>
          <Link
            to="/game"
            className="mt-8 inline-block rounded-full bg-[#fff5ea] px-7 py-3 font-heading text-[13px] font-bold text-[#4a2350] transition-transform hover:scale-105"
          >
            Go somewhere
          </Link>
        </header>

        {/* Three leads, big, no frame. */}
        <div className="space-y-16 sm:space-y-24">
          {lead.map((w, i) => (
            <Link key={w.key} to={w.route} className="group block">
              <div
                className={`overflow-hidden rounded-[28px] ${i % 2 ? "sm:ml-16" : "sm:mr-16"}`}
                style={{ boxShadow: "0 30px 80px rgba(40,10,30,0.32)" }}
              >
                <div className="aspect-[16/9]">
                  {d.art(w.key) && (
                    <img
                      src={d.art(w.key)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-[1400ms] group-hover:scale-[1.04]"
                    />
                  )}
                </div>
              </div>
              <div className={`mt-4 ${i % 2 ? "sm:ml-16" : "sm:mr-16"}`}>
                <h2 className="font-heading text-[26px] font-black leading-none tracking-tight sm:text-[34px]">
                  {w.name}
                </h2>
                <p className="mt-2 max-w-lg text-[14px] leading-relaxed opacity-75">{w.blurb}</p>
              </div>
            </Link>
          ))}
        </div>

        {/* And the rest, small, as the sky reaches the light. Text goes dark
            here because the background has: keeping it cream would leave the
            bottom third of the page unreadable, which is exactly what a
            single-colour text token does to a full-page gradient. */}
        <section className="mt-28" style={{ color: "#5a2a2a" }}>
          <h2 className="text-center font-heading text-[10px] font-bold uppercase tracking-[0.34em] opacity-60">
            And {d.counts.worlds - lead.length} more
          </h2>
          <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
            {rest.map((w) => (
              <Link key={w.key} to={w.route} className="group block text-center">
                <div
                  className="overflow-hidden rounded-2xl"
                  style={{ boxShadow: "0 10px 26px rgba(90,42,42,0.22)" }}
                >
                  <div className="aspect-square">
                    {d.art(w.key) && (
                      <img
                        src={d.art(w.key)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                      />
                    )}
                  </div>
                </div>
                <h3 className="mt-2.5 truncate font-heading text-[12.5px] font-bold">{w.name}</h3>
              </Link>
            ))}
          </div>

          <div className="mt-12 text-center">
            <Link
              to="/game"
              className="inline-block rounded-full border-2 px-6 py-3 font-heading text-[12px] font-bold"
              style={{ borderColor: "rgba(90,42,42,0.35)" }}
            >
              All {d.counts.worlds} worlds →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
