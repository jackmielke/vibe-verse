/**
 * /whats-new: every update to the Vibe Verse, with dates. The data is
 * `src/whatsnew/entries.ts` plus whatever build mode has filed in
 * `src/whatsnew/auto/`.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import WhatsNewList from "@/whatsnew/WhatsNewList";
import { WHATS_NEW, markAllSeen, dayLabel } from "@/whatsnew";

export default function WhatsNew() {
  useEffect(() => {
    document.title = "What's New · Vibe Verse";
    // After the list has read which entries are fresh.
    const t = window.setTimeout(() => markAllSeen(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const latest = WHATS_NEW[0]?.date;

  return (
    <main className="min-h-[100dvh] w-full bg-[#0b0f1f] text-white">
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-20 sm:px-6">
        <Link to="/" className="text-[13px] text-white/55 hover:text-white">
          ← Back to the Vibe Verse
        </Link>
        <header className="mt-4 mb-8">
          <h1 className="font-heading text-[34px] font-bold leading-tight sm:text-[42px]">✨ What's New</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-white/70">
            Every update to the Vibe Verse, newest first.
            {latest && <> Last update: {dayLabel(latest)}.</>}
          </p>
        </header>
        <WhatsNewList />
      </div>
    </main>
  );
}
