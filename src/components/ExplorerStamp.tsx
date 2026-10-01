/**
 * The moment a world becomes yours.
 *
 * A rubber stamp presses into the middle of the screen, the coins land, and it
 * lifts away. That is the entire component. It exists because the payout it
 * announces was, until now, the least visible good thing in the vibeverse: a
 * number in a corner going up by 25 while somebody was busy looking at a
 * canvas, which is indistinguishable from nothing happening at all.
 *
 * ## Why it is mounted once, globally
 *
 * Thirty worlds call `useWorldStamp`. None of them should have to know this
 * exists, and none of them can be relied on to leave room for it — most own the
 * whole viewport and several draw their own HUD in every corner. So it listens
 * on `onExplorePayout` from the app shell, sits above everything, and takes no
 * pointer events: it can never swallow a click meant for the world underneath,
 * and it plays over a crosshair without becoming part of the game.
 *
 * ## Why it looks like a stamp rather than a toast
 *
 * The vibeverse already has toasts, and a toast is what an app says. The
 * passport is the fiction this payout belongs to — a book of places, stamped at
 * the border — so the reward for arriving somewhere reads as the border guard's
 * gesture rather than as a notification. It is also the one visual that can
 * carry a rank promotion without needing a second design: Cartographer arrives
 * as a bigger, redder stamp on the same paper.
 *
 * Reduced motion is honoured properly rather than nominally: the press, the
 * overshoot and the rotation all collapse to a plain fade, because the entire
 * charm of this thing is a violent little movement and that is exactly what
 * somebody who asked for less motion is asking not to have.
 */
import { useEffect, useRef, useState } from "react";
import { IOS_APP } from "@/lib/iosApp";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { onExplorePayout, type ExploreResult } from "@/lib/explore";
import { PASSPORT_ROUTES } from "@/worlds/registry";

/** How long the stamp stays on the paper. Long enough to read, short enough
 *  that nobody waits for it to leave before carrying on playing. */
const DWELL_MS = 3200;

const BY_KEY = new Map(PASSPORT_ROUTES.map((w) => [w.key, w]));

interface Shown {
  id: number;
  amount: number;
  /** The single world, when it was a single world — the usual case. */
  world: { name: string; emoji: string; accent: string } | null;
  count: number;
  milestone: { title: string; at: number; bonus: number } | null;
}

function describe(r: ExploreResult, id: number): Shown {
  const first = r.newly[0] ? BY_KEY.get(r.newly[0]) : undefined;
  return {
    id,
    amount: r.amount,
    world:
      r.newly.length === 1 && first
        ? { name: first.name, emoji: first.emoji, accent: first.accent }
        : null,
    count: r.newly.length,
    // Only the highest rank crossed. Two at once is possible on a first sync of
    // a long-standing passport, and two stamps landing on top of each other is
    // a mess where one bigger one is a moment.
    milestone: r.milestones.length ? r.milestones[r.milestones.length - 1] : null,
  };
}

export default function ExplorerStamp() {
  const [shown, setShown] = useState<Shown | null>(null);
  const reduce = useReducedMotion();
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const off = onExplorePayout((r) => {
      if (r.amount <= 0) return;
      seq.current += 1;
      setShown(describe(r, seq.current));
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown(null), DWELL_MS);
    });
    return () => {
      off();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const accent = shown?.milestone ? "#ff8a5c" : shown?.world?.accent ?? "#7dffd4";
  const title = shown?.milestone
    ? shown.milestone.title
    : shown?.world?.name ?? `${shown?.count ?? 0} new worlds`;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center"
      aria-live="polite"
    >
      <AnimatePresence>
        {shown && (
          <motion.div
            key={shown.id}
            initial={
              reduce
                ? { opacity: 0 }
                : { opacity: 0, scale: 2.4, rotate: -18, filter: "blur(4px)" }
            }
            animate={
              reduce
                ? { opacity: 1 }
                : {
                    opacity: 1,
                    scale: 1,
                    rotate: -7,
                    filter: "blur(0px)",
                    // A hard, fast landing with a little rebound — a stamp is
                    // pressed, not eased.
                    transition: { type: "spring", stiffness: 520, damping: 17, mass: 0.7 },
                  }
            }
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.12, transition: { duration: 0.45 } }}
            className="select-none"
          >
            <div
              className="rounded-[18px] px-7 py-5 text-center sm:px-10 sm:py-6"
              style={{
                border: `3px solid ${accent}`,
                /*
                 * OPAQUE, not a wash.
                 *
                 * This started as a translucent panel tinted with the world's
                 * colour, which looked right on a dark hub page and turned out
                 * to be unreadable in situ: worlds put their own menus dead
                 * centre, so Vibe Golf's headline and its TEE OFF button read
                 * straight through the card and tangled with the words on it.
                 * A stamp is ink on paper — it covers what it lands on. The
                 * accent survives as the border, the top-edge tint and the
                 * glow, which is where it was doing the work anyway.
                 */
                background: `linear-gradient(180deg, ${accent}26 0%, #080b14 55%, #05070f 100%)`,
                boxShadow: `0 0 0 1px rgba(255,255,255,0.07) inset, 0 22px 70px -18px ${accent}aa`,
              }}
            >
              <p
                className="font-heading text-[9px] font-bold uppercase tracking-[0.4em]"
                style={{ color: accent }}
              >
                {shown.milestone ? "Rank earned" : "Passport stamped"}
              </p>

              <p className="mt-2 flex items-center justify-center gap-2.5 font-heading text-2xl font-black tracking-tight text-white sm:text-3xl">
                {/* The world's emoji belongs to the world. On a rank stamp the
                    title is "Cartographer", and pinning a golf flag to it reads
                    as a mislabelled badge rather than a promotion. */}
                {shown.world && !shown.milestone && <span aria-hidden>{shown.world.emoji}</span>}
                {title}
              </p>

              {shown.milestone && (
                <p className="mt-1 font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">
                  {shown.milestone.at} worlds explored
                </p>
              )}

              {/* The stamp stays in the App Store edition; the payout does not. */}
              {!IOS_APP && (
              <p
                className="mt-3 font-heading text-xl font-black tabular-nums sm:text-2xl"
                style={{ color: accent }}
              >
                +{shown.amount.toLocaleString()} ✦
              </p>
              )}

              {/* Only when it was a batch, because "1 world" is a silly thing to
                  print under a stamp that already names the world. */}
              {!shown.world && shown.count > 1 && (
                <p className="mt-1 text-[11px] text-white/50">
                  {shown.count} first visits settled
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
