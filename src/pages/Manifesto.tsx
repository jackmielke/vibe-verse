/**
 * `/manifesto` — why any of this exists.
 *
 * Forty-seven worlds, a currency, an arcade and a portal, and nowhere that
 * says what the point is. Every other page in here answers "what can I do";
 * this is the only one that answers "why is it built this way", and it is the
 * page to send somebody before they open anything else.
 *
 * The words are Jack's, kept as written. The only job of the code around them
 * is to get out of the way: one column at reading width, a serif for the body
 * because this is prose rather than interface, and the display face the rest
 * of the vibeverse uses so it still belongs to the same place.
 *
 * The one piece of motion is the reveal on scroll, and it is there because a
 * manifesto that arrives all at once is a wall of text. Anything more would be
 * decoration competing with the argument.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";

import { useWorldStamp } from "@/hooks/use-world-stamp";

/**
 * The text, as data.
 *
 * Kept out of JSX so the writing can be read and edited as writing — a
 * paragraph buried in six attributes of Tailwind is a paragraph nobody
 * proofreads. `em` marks the one or two words in a line that carry the weight.
 */
interface Para {
  text: string;
  /** Rendered italic and brighter — the line's own emphasis, not a heading. */
  em?: string;
  lead?: boolean;
}

interface Section {
  heading: string;
  paras: Para[];
}

const SECTIONS: Section[] = [
  {
    heading: "Why vibe code?",
    paras: [
      { text: "Because the world is built from systems, encoded by our ideas.", lead: true },
      {
        text:
          "For decades, only programmers could shape those systems. They spoke the language of machines, and everyone else just lived inside their worlds.",
      },
      { text: "But now, we can speak to our computers — and they can understand us." },
      {
        text:
          "With AI as our translator, and the acceleration of powerful new tools, we can finally build at the speed of intuition — designing apps, games, and experiences by simply expressing ideas.",
      },
      { text: "Everyone is a builder.", em: "Everyone is a builder." },
      {
        text:
          "We're not just building new tools. We're defining the physics of our digital universe — together.",
      },
    ],
  },
  {
    heading: "And with Web3 — we can own what we create.",
    paras: [
      {
        text:
          "The old internet was a playground built on borrowed land. Our data, our art, our identities — all hosted somewhere else, subject to deletion, control, or profit by others.",
        lead: true,
      },
      {
        text:
          "Web3 changes that. It gives us permanence. It gives us provenance. It gives our creations a home.",
      },
      { text: "Now, when you build, it's yours." },
      { text: "When we build together, it's ours.", em: "When we build together, it's ours." },
      {
        text:
          "With this arcade of the future, blockchains can serve as proof of authorship, collaboration, and community. Each new creation expands a shared universe that belongs to everyone who contributes to it.",
      },
      { text: "This is what happens when AI meets ownership." },
      { text: "When creativity meets protocol." },
      { text: "With the power of play." },
    ],
  },
];

const CLOSER =
  "Welcome to the new paradigm — where vibe coding meets Web3, and creation itself becomes a network.";

/** Where the argument stops being an argument and becomes something you can open. */
const DOORS: { to: string; label: string; note: string }[] = [
  { to: "/game", label: "The worlds", note: "Forty-seven of them, all in a browser" },
  { to: "/arcade", label: "The arcade", note: "Where the coins come from" },
  { to: "/build", label: "Build one", note: "Four lines, and yours pays out too" },
];

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  /* Somebody who has asked their system for less motion gets the text, plainly
     and immediately. This is prose — the fade is the least important thing on
     the page, and it is the only thing standing between them and reading it. */
  const still = useReducedMotion();
  if (still) return <div>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, delay }}
    >
      {children}
    </motion.div>
  );
}

export default function Manifesto() {
  useWorldStamp("/manifesto", "The Arcade of the Future");

  /* A slow parallax on the nebula. Two per cent of the scroll distance, which
     is enough for the background to feel like it is behind the text rather
     than printed on it, and little enough that nobody notices it happening. */
  const [offset, setOffset] = useState(0);
  const raf = useRef(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    const onScroll = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setOffset(window.scrollY * 0.02));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf.current);
    };
  }, [still]);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#080610] text-foreground">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          transform: `translateY(${-offset}px)`,
          background:
            "radial-gradient(80% 50% at 78% 6%, hsl(292 70% 46% / 0.34), transparent 64%)," +
            "radial-gradient(70% 45% at 10% 26%, hsl(222 78% 46% / 0.28), transparent 66%)," +
            "radial-gradient(90% 60% at 50% 108%, hsl(264 65% 40% / 0.30), transparent 62%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(1.2px 1.2px at 18% 22%, #fff, transparent)," +
            "radial-gradient(1px 1px at 68% 12%, #dbeafe, transparent)," +
            "radial-gradient(1.3px 1.3px at 42% 58%, #fff, transparent)," +
            "radial-gradient(1px 1px at 84% 74%, #f5d0fe, transparent)",
          backgroundSize: "460px 380px",
        }}
        aria-hidden
      />

      <article className="relative mx-auto max-w-2xl px-5 pb-24 pt-20 sm:px-6 sm:pt-28">
        <Reveal>
          <header className="text-center">
            <h1 className="font-heading text-[2.1rem] font-black leading-[1.06] tracking-tight sm:text-[3.25rem]">
              The Arcade of the Future
            </h1>
            <p className="mt-3 font-serif text-[15px] italic text-white/55 sm:text-lg">
              Build worlds. Share ownership. Play forever.
            </p>
          </header>
        </Reveal>

        <div className="mt-12 space-y-14">
          {SECTIONS.map((section) => (
            <section key={section.heading}>
              <Reveal>
                <h2 className="border-t border-white/12 pt-8 font-heading text-[1.35rem] font-black leading-tight tracking-tight text-white sm:text-[1.85rem]">
                  {section.heading}
                </h2>
              </Reveal>
              <div className="mt-5 space-y-5">
                {section.paras.map((p, i) => (
                  <Reveal key={p.text} delay={Math.min(i, 4) * 0.04}>
                    {p.em ? (
                      /* A line that is its own paragraph and its own point.
                         Set larger and italic rather than bold — this is prose,
                         and bold in the middle of prose reads as a UI label. */
                      <p className="font-serif text-lg italic leading-relaxed text-white sm:text-xl">
                        {p.em}
                      </p>
                    ) : (
                      <p
                        className={`font-serif leading-[1.75] text-white/75 ${
                          p.lead ? "text-[17px] text-white/85 sm:text-[19px]" : "text-[16px] sm:text-[17px]"
                        }`}
                      >
                        {p.text}
                      </p>
                    )}
                  </Reveal>
                ))}
              </div>
            </section>
          ))}
        </div>

        <Reveal>
          <p className="mt-14 border-t border-white/12 pt-10 font-serif text-[17px] italic leading-relaxed text-white/90 sm:text-xl">
            {CLOSER}
          </p>
        </Reveal>

        {/* The doors. A manifesto that ends on a full stop is an essay; the
            argument here is that everyone can build, so the last thing on the
            page should be the way in. */}
        <Reveal delay={0.1}>
          <div className="mt-12 grid gap-2.5 sm:grid-cols-3">
            {DOORS.map((d) => (
              <Link
                key={d.to}
                to={d.to}
                className="group rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 backdrop-blur-sm transition-colors hover:border-white/30 hover:bg-white/[0.08]"
              >
                <div className="font-heading text-[11px] font-bold uppercase tracking-[0.16em] text-white/90">
                  {d.label} <span className="opacity-50 transition-opacity group-hover:opacity-100">→</span>
                </div>
                <div className="mt-1 text-[11px] leading-snug text-white/45">{d.note}</div>
              </Link>
            ))}
          </div>
        </Reveal>
      </article>
    </div>
  );
}
