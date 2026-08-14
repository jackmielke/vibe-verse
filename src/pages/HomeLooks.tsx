/**
 * `/looks` — pick the front door's typography.
 *
 * Six treatments of the same lockup, stacked, each on the real starfield the
 * homepage sits on, so what you are comparing is what you would get. A row of
 * swatches would be quicker to build and would tell you nothing: the whole
 * question is how a headline sits against a busy background at real size.
 *
 * Choosing writes to `localStorage` and the homepage reads it. That is
 * deliberately not a shipped preference — it is a preview, so Jack can decide
 * in the browser rather than from a description. Once he has, `DEFAULT_LOOK`
 * moves to whichever won and the other five get deleted; this page and the
 * switcher go with them.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";

import StarField from "@/components/StarField";
import HomeHero, {
  LOOKS,
  readLook,
  writeLook,
  type HeroCopy,
  type LookId,
} from "@/components/home/HomeHero";
import { WORLDS } from "@/worlds/registry";

/** The real copy, so nobody picks a look against lorem. */
const COPY: HeroCopy = {
  eyebrow: "Powered by creators, owned by players",
  title: "VIBEVERSE",
  tagline: "A massive collection of AI-coded games ;)",
  pitch: `${WORLDS.length} worlds and games, all in one browser tab. No install, no account, no launcher — pick a card and you are in it in a few seconds.`,
};

export default function HomeLooks() {
  const [picked, setPicked] = useState<LookId>(readLook);
  const [justSaved, setJustSaved] = useState<LookId | null>(null);

  useEffect(() => {
    if (!justSaved) return;
    const t = window.setTimeout(() => setJustSaved(null), 1800);
    return () => window.clearTimeout(t);
  }, [justSaved]);

  const choose = (id: LookId) => {
    writeLook(id);
    setPicked(id);
    setJustSaved(id);
  };

  return (
    <div className="relative min-h-[100dvh] w-full bg-background">
      {/* The same fixed sky the homepage has. A hero judged on a flat panel
          and then dropped onto a starfield is a hero judged twice. */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <StarField />
        <div
          className="absolute inset-x-0 top-0 h-[80vh]"
          style={{
            background:
              "radial-gradient(70% 55% at 22% 0%, hsl(160 80% 50% / 0.14), transparent 68%)," +
              "radial-gradient(60% 50% at 82% 6%, hsl(266 85% 62% / 0.16), transparent 70%)",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-4xl px-4 pb-24 pt-20 sm:px-6 sm:pt-24">
        <header>
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-white/45 sm:text-[10px]">
            Front door · pick one
          </p>
          <h1 className="mt-2 font-heading text-3xl font-black tracking-tight text-white sm:text-4xl">
            Six ways the homepage could look
          </h1>
          <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Same words, same mark, same sky — only the type changes. Pick one
            and the homepage uses it straight away. Say which and I will make it
            the real default and delete the rest.
          </p>
        </header>

        <div className="mt-10 space-y-8">
          {LOOKS.map((look) => {
            const active = picked === look.id;
            return (
              <section key={look.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
                  <div>
                    <h2 className="font-heading text-sm font-black uppercase tracking-wider text-white">
                      {look.name}
                    </h2>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                      {look.note}
                    </p>
                  </div>
                  <button
                    onClick={() => choose(look.id)}
                    aria-pressed={active}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors ${
                      active
                        ? "border-[#7dffd4]/60 bg-[#7dffd4]/10 text-[#7dffd4]"
                        : "border-white/20 text-white/70 hover:border-white/50 hover:text-white"
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {justSaved === look.id ? "Saved" : active ? "In use" : "Use this"}
                  </button>
                </div>

                {/* The stage. Padded like the homepage's own column so the
                    headline meets the left edge at the same distance it will
                    in situ — a hero centred in a box is a different design. */}
                <div
                  className={`mt-3 overflow-hidden rounded-2xl border p-5 sm:p-8 ${
                    active ? "border-[#7dffd4]/35" : "border-white/10"
                  }`}
                  style={{ background: "rgba(5, 7, 15, 0.55)" }}
                >
                  <HomeHero look={look.id} copy={COPY} />
                </div>
              </section>
            );
          })}
        </div>

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-white/10 pt-6">
          <Link
            to="/"
            className="rounded-full bg-white px-5 py-2.5 font-heading text-[10px] font-black uppercase tracking-wider text-black transition-transform hover:scale-[1.02]"
          >
            See it on the front door →
          </Link>
          <p className="text-[11px] text-muted-foreground">
            The pick is saved in this browser only — nobody else sees it until
            it becomes the default.
          </p>
        </footer>
      </div>
    </div>
  );
}
