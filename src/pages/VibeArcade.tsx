/**
 * /arcade — the first place in the vibeverse where the money is the mechanic.
 *
 * Everything else that touches Vibecoin pays *out*: the sky-island games mint
 * a reward, the starter grant lands in your wallet, the agents in Vibe City
 * take tips. Nothing has ever charged for anything, which means the currency
 * has never been a decision. A number that only ever goes up is a score, not a
 * currency.
 *
 * So the arcade is coin-operated, in the literal sense. Pressing INSERT COIN
 * debits your real ledger balance before a single frame runs; the run ends,
 * the server settles it, and the number in the top-right corner moves while
 * you are still looking at the results card. That round trip — pay, play, get
 * paid — is the whole point of the page, and every other thing on it is in
 * service of making that loop legible.
 *
 * Three properties it holds on to:
 *
 * 1. **You are told the price and the top prize before you pay.** The paytable
 *    is drawn from the same `payout()` the server will use.
 * 2. **You cannot get stranded.** Broke players can draw a daily allowance.
 *    An arcade you can be permanently locked out of is a room people visit
 *    once.
 * 3. **A failed settlement is stated, not swallowed.** If the ledger is
 *    unreachable when a run ends, the card says the payout is pending rather
 *    than quietly showing a zero.
 *
 * See `src/arcade/cabinets.ts` for the machines and `docs/VIBECOIN.md` for
 * where this is going (hosted community cabinets, published over MCP).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  VIBECOIN_GLYPH,
  applyLocalDelta,
  arcadeAllowance,
  arcadeInsert,
  arcadeSettle,
  formatVibecoin,
  type ArcadeSettlement,
} from "@/lib/vibecoin";
import { CABINETS, topPrize, type Cabinet, type CabinetRun } from "@/arcade/cabinets";
import RpsArena from "@/components/arcade/RpsArena";
import { SHOP_CHARACTERS } from "@/lib/characterShop";
import { findCharacter } from "@/lib/characters";
import { createArcadeSounds, type ArcadeSounds } from "@/arcade/sounds";

/** Personal bests, per cabinet. localStorage, because a high score is not
    worth a table — and the leaderboard that *is* worth one should be built on
    the ledger, where the wins already are. */
const BEST_KEY = "vibe.arcade.best.v1";

function readBests(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeBest(key: string, score: number): boolean {
  const all = readBests();
  if ((all[key] ?? -1) >= score) return false;
  all[key] = score;
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* Storage off. The run still counted; only the memory of it is lost. */
  }
  return true;
}

interface ActivePlay {
  cabinet: Cabinet;
  playId: string;
}

interface Result {
  cabinet: Cabinet;
  score: number;
  detail: string;
  newBest: boolean;
  /** null = the settlement request failed; the run is unpaid for now. */
  settlement: ArcadeSettlement | null;
  settling: boolean;
}

export default function VibeArcade() {
  useWorldStamp("/arcade", "Vibe Arcade");

  const { balance, refresh } = useVibecoin();
  const [play, setPlay] = useState<ActivePlay | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [inserting, setInserting] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [bests, setBests] = useState<Record<string, number>>(readBests);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runRef = useRef<CabinetRun | null>(null);
  const soundsRef = useRef<ArcadeSounds | null>(null);

  /* One AudioContext for the whole visit, closed on unmount. Browsers cap live
     contexts, and a leaked one breaks audio in the next world the visitor
     opens — which is a miserable thing to debug from the other world. */
  useEffect(() => {
    soundsRef.current = createArcadeSounds();
    return () => {
      soundsRef.current?.close();
      soundsRef.current = null;
    };
  }, []);

  const cheapest = Math.min(...CABINETS.map((c) => c.cost));
  const broke = balance != null && balance < cheapest;

  // -------------------------------------------------------------------------
  // Pay, then play
  // -------------------------------------------------------------------------

  const insert = useCallback(async (cabinet: Cabinet) => {
    setInserting(cabinet.key);
    try {
      const p = await arcadeInsert(cabinet.key);
      soundsRef.current?.coin();
      setResult(null);
      setPlay({ cabinet, playId: p.playId });
    } catch (e) {
      // The one failure the player has to be told about in words: the machine
      // did not take the coin, so nothing is about to happen.
      const msg = String((e as Error)?.message ?? e);
      toast.error("The machine would not take it", {
        description: /not enough/i.test(msg)
          ? `${cabinet.name} costs ${cabinet.cost} ${VIBECOIN_GLYPH} and you are short. Draw your daily allowance below.`
          : msg,
      });
    } finally {
      setInserting(null);
    }
  }, []);

  const claim = useCallback(async () => {
    setClaiming(true);
    const r = await arcadeAllowance();
    setClaiming(false);
    if (!r) {
      toast.error("Could not reach the ledger", {
        description: "Try again in a moment — nothing was charged.",
      });
      return;
    }
    if (r.granted > 0) {
      soundsRef.current?.coin();
      toast.success(`+${r.granted} ${VIBECOIN_GLYPH} allowance`, {
        description: "Enough for a few more runs. Back tomorrow for the next one.",
      });
    } else {
      toast.info("Already drawn today", {
        description: "The allowance is once a day. Go earn some in a world.",
      });
    }
  }, []);

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  const finish = useCallback(
    async (cabinet: Cabinet, playId: string, score: number, detail: string) => {
      const newBest = writeBest(cabinet.key, score);
      setBests(readBests());
      setPlay(null);
      setResult({ cabinet, score, detail, newBest, settlement: null, settling: true });

      // Show the payout the paytable promised straight away, then reconcile.
      // The server is the authority, but making the player wait on a network
      // round trip to find out whether they won is a bad half-second.
      const expected = cabinet.payout(Math.min(score, cabinet.maxScore));
      if (expected > 0) applyLocalDelta(expected);

      const s = await arcadeSettle(playId, cabinet.key, score);
      setResult((r) => (r ? { ...r, settlement: s, settling: false } : r));
      if (s && s.amount > 0) soundsRef.current?.fanfare();
      else if (!s) void refresh();
    },
    [refresh],
  );

  /* The frame loop. Owns the canvas outright: sizes it to the device pixel
     ratio, drives the cabinet, and hands control back the moment `done` is
     set. Restarting a run means unmounting this effect, which is why `play`
     carries the play id — a new coin is a new effect. */
  useEffect(() => {
    if (!play) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const run = play.cabinet.create(w, h);
    run.cue = (c) => {
      const s = soundsRef.current;
      if (!s) return;
      if (c === "good") s.chime();
      else if (c === "bad") s.thud();
      else if (c === "tick") s.blip(4);
      else if (c === "over") s.thud();
    };
    runRef.current = run;

    let raf = 0;
    let last = performance.now();
    let ended = false;

    const loop = (now: number) => {
      // Clamped: a backgrounded tab returns with a two-second dt, and a
      // stacker row that teleports across the board is not a fair run.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      run.frame(ctx, dt);
      if (run.done && !ended) {
        ended = true;
        const { score, detail } = run.done;
        void finish(play.cabinet, play.playId, score, detail);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      runRef.current = null;
    };
  }, [play, finish]);

  /* Keyboard. Space is "the button" on the one-button cabinets and 1–4 are the
     pads on Pattern, so every machine is playable without a touchscreen. */
  useEffect(() => {
    if (!play) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault(); // Space scrolls the page otherwise, mid-run.
        runRef.current?.press({ slot: 0 });
      } else if (/^Digit[1-4]$/.test(e.code)) {
        runRef.current?.press({ slot: Number(e.code.slice(5)) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play]);

  const onCanvasPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    runRef.current?.press({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  // -------------------------------------------------------------------------

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#05070d] text-foreground">
      {/* Arcade lighting: two coloured washes and a scanline veil. Static, so
          it costs nothing and still makes a flat page feel like a dark room. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 45% at 18% 0%, hsl(160 90% 50% / 0.16), transparent 65%)," +
            "radial-gradient(55% 45% at 84% 8%, hsl(280 90% 62% / 0.16), transparent 68%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.055]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 3px)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-4 pb-20 pt-20 sm:px-6 sm:pt-24">
        {/* ---- The sign ---- */}
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="text-center"
        >
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-[#7dffd4]/70 sm:text-[10px]">
            Coin-operated · the money is real
          </p>
          <h1
            className="mt-2 font-heading text-4xl font-black tracking-tight sm:text-6xl"
            style={{
              color: "#fff",
              textShadow:
                "0 0 12px hsl(160 90% 60% / 0.9), 0 0 38px hsl(160 90% 55% / 0.55), 0 0 80px hsl(280 90% 62% / 0.4)",
            }}
          >
            VIBE ARCADE
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
            Every cabinet costs {VIBECOIN_GLYPH} to play and pays {VIBECOIN_GLYPH} if
            you are good at it. The coin comes out of the same balance you earn in
            the worlds — watch the number in the corner while you play.
          </p>
        </motion.header>

        {/* ---- The bank ---- */}
        <div className="mx-auto mt-6 flex max-w-md items-center gap-3 rounded-2xl border border-border/50 bg-black/40 px-4 py-3 backdrop-blur-sm">
          <VibeCoinMark size={38} />
          <div className="min-w-0 flex-1">
            <div className="font-heading text-2xl font-black leading-none tabular-nums text-[#7dffd4]">
              {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
            </div>
            <div className="mt-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
              Your Vibecoin
            </div>
          </div>
          {broke && (
            <button
              onClick={claim}
              disabled={claiming}
              className="shrink-0 rounded-full bg-primary px-3 py-2 font-heading text-[9.5px] font-bold uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.03] disabled:opacity-50"
            >
              {claiming ? "…" : "Daily allowance"}
            </button>
          )}
        </div>
        {broke && (
          <p className="mx-auto mt-2 max-w-md text-center text-[11px] text-amber-300/80">
            You are short for every machine on the floor. Draw the daily allowance,
            or go earn some — the sky islands over{" "}
            <Link to="/city" className="underline hover:text-amber-200">
              Vibe City
            </Link>{" "}
            pay out.
          </p>
        )}

        {/* ---- The headline game ----
            Rock paper scissors leads the floor because it is the only thing
            here you play against somebody rather than against a difficulty
            curve, the only one where you name the wager, and the only one that
            needs no explaining at all. The cabinets are the deep end; this is
            the door. */}
        <div className="mt-8">
          <RpsArena />
        </div>

        {/* ---- The character shop ----
            Above the cabinets on purpose. The machines are what you do here;
            the character is what you leave with, and it is the only thing on
            this page that follows you into another world. */}
        <Link
          to="/arcade/characters"
          className="group mt-4 flex items-center gap-3.5 overflow-hidden rounded-2xl border border-border/50 bg-black/45 px-4 py-3.5 backdrop-blur-sm transition-colors hover:bg-black/60"
          style={{ boxShadow: "inset 0 0 0 1px hsl(280 90% 62% / 0.18), 0 0 40px hsl(280 90% 62% / 0.08)" }}
        >
          <span className="text-2xl leading-none" aria-hidden>
            {SHOP_CHARACTERS.map((c) => findCharacter(c.id).emoji).join("")}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-heading text-sm font-black uppercase tracking-wider text-[#e2b7ff]">
              The shop
            </h2>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Six originals you can only get here, plus every hat and jetpack.
              Spend what you win, wear it in Vibe Island.
            </p>
          </div>
          <span className="shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
            Open →
          </span>
        </Link>

        {/* ---- The floor ---- */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CABINETS.map((c, i) => {
            const affordable = balance == null || balance >= c.cost;
            const best = bests[c.key];
            return (
              <motion.div
                key={c.key}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.07, duration: 0.4 }}
                className="flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-black/45 backdrop-blur-sm"
                style={{ boxShadow: `inset 0 0 0 1px ${c.accent}22, 0 0 40px ${c.accent}12` }}
              >
                {/* Marquee */}
                <div
                  className="flex items-center gap-2.5 px-4 py-3"
                  style={{ background: `linear-gradient(135deg, ${c.accent}22, transparent 70%)` }}
                >
                  <span className="text-xl leading-none">{c.emoji}</span>
                  <div className="min-w-0">
                    <h2
                      className="font-heading text-base font-black uppercase leading-none tracking-wider"
                      style={{ color: c.accent, textShadow: `0 0 14px ${c.accent}66` }}
                    >
                      {c.name}
                    </h2>
                    <p className="mt-1 text-[10.5px] leading-tight text-muted-foreground">
                      {c.tagline}
                    </p>
                  </div>
                </div>

                <div className="flex flex-1 flex-col px-4 pb-4">
                  <p className="text-[11.5px] leading-relaxed text-foreground/70">{c.howTo}</p>

                  {/* Paytable — the same numbers the server pays. */}
                  <dl className="mt-3 grid grid-cols-3 gap-1.5 rounded-xl border border-border/40 bg-black/40 p-2 text-center">
                    <div>
                      <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
                        Play
                      </dt>
                      <dd className="mt-0.5 font-heading text-sm font-black tabular-nums text-rose-300/90">
                        −{c.cost}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
                        Top prize
                      </dt>
                      <dd className="mt-0.5 font-heading text-sm font-black tabular-nums text-[#7dffd4]">
                        +{topPrize(c)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
                        Your best
                      </dt>
                      <dd className="mt-0.5 font-heading text-sm font-black tabular-nums text-foreground/70">
                        {best == null ? "—" : best}
                      </dd>
                    </div>
                  </dl>

                  <p className="mt-2 text-center font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/50">
                    {c.control}
                  </p>

                  <button
                    onClick={() => void insert(c)}
                    disabled={inserting != null || !affordable}
                    className="mt-3 w-full rounded-xl px-3 py-2.5 font-heading text-[11px] font-black uppercase tracking-[0.14em] text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ background: c.accent, boxShadow: `0 0 22px ${c.accent}55` }}
                  >
                    {inserting === c.key
                      ? "Taking your coin…"
                      : affordable
                        ? `Insert ${c.cost} ${VIBECOIN_GLYPH}`
                        : `Need ${c.cost} ${VIBECOIN_GLYPH}`}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>

        <footer className="mt-14 border-t border-border/40 pt-6 text-[11px] leading-relaxed text-muted-foreground">
          Every insert and every payout is a row in the shared ledger — tap the coin
          in the top-right corner to read yours. Payout curves are enforced
          server-side, so the worst a modified client can do is claim a perfect run.
          Where this is going next:{" "}
          <Link to="/coin" className="text-primary hover:underline">
            the coin page
          </Link>{" "}
          has the $VIBE side of it.
        </footer>
      </div>

      {/* ---- The cabinet, when a coin is in it ---- */}
      <AnimatePresence>
        {play && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-[22rem]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="font-heading text-sm font-black uppercase tracking-wider"
                  style={{ color: play.cabinet.accent }}
                >
                  {play.cabinet.emoji} {play.cabinet.name}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-rose-300/80">
                  −{play.cabinet.cost} {VIBECOIN_GLYPH} paid
                </span>
              </div>
              <canvas
                ref={canvasRef}
                onPointerDown={onCanvasPointer}
                className="block aspect-[3/4] w-full touch-none select-none rounded-2xl border-2"
                style={{
                  borderColor: `${play.cabinet.accent}66`,
                  boxShadow: `0 0 60px ${play.cabinet.accent}33`,
                }}
              />
              <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {play.cabinet.control}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- The results card ---- */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.9, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
              className="w-full max-w-sm overflow-hidden rounded-2xl border border-border/60 bg-[#070d16] text-center"
              style={{ boxShadow: `0 0 70px ${result.cabinet.accent}33` }}
            >
              <div
                className="px-6 py-5"
                style={{
                  background: `linear-gradient(160deg, ${result.cabinet.accent}22, transparent 75%)`,
                }}
              >
                <p className="font-heading text-[9px] font-bold uppercase tracking-[0.3em] text-muted-foreground">
                  {result.cabinet.name} · run over
                </p>
                <div className="mt-2 font-heading text-5xl font-black tabular-nums leading-none text-white">
                  {result.score}
                </div>
                <p className="mt-1.5 font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  {result.cabinet.unit}
                  {result.score === 1 ? "" : "s"}
                </p>
                <p className="mt-3 text-[12px] leading-snug text-foreground/70">{result.detail}</p>
                {result.newBest && (
                  <p className="mt-2 font-heading text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">
                    ★ personal best
                  </p>
                )}
              </div>

              {/* The payout — the moment the whole page exists for. */}
              <div className="border-y border-border/40 px-6 py-5">
                {result.settling ? (
                  <p className="text-sm text-muted-foreground">Settling with the ledger…</p>
                ) : result.settlement == null ? (
                  <p className="text-[12.5px] leading-snug text-amber-300/90">
                    Payout pending — the ledger could not be reached. Nothing is lost;
                    reload and it will reconcile.
                  </p>
                ) : result.settlement.amount > 0 ? (
                  <>
                    <div className="flex items-center justify-center gap-2">
                      <VibeCoinMark size={30} />
                      <span className="font-heading text-4xl font-black tabular-nums leading-none text-[#7dffd4]">
                        +{formatVibecoin(result.settlement.amount, { compact: false })}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {result.settlement.amount > result.cabinet.cost
                        ? `Up ${formatVibecoin(result.settlement.amount - result.cabinet.cost)} on the coin you put in.`
                        : `You put in ${result.cabinet.cost} — this one cost you ${formatVibecoin(result.cabinet.cost - result.settlement.amount)}.`}
                    </p>
                    {result.settlement.capped && (
                      <p className="mt-1.5 text-[11px] text-amber-300/80">
                        Daily payout ceiling reached — the rest of today's runs are for
                        the leaderboard.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No payout this run. The coin is gone; the cabinet is right there.
                  </p>
                )}
              </div>

              <div className="flex gap-2 p-4">
                <button
                  onClick={() => void insert(result.cabinet)}
                  disabled={
                    inserting != null || (balance != null && balance < result.cabinet.cost)
                  }
                  className="flex-1 rounded-xl px-3 py-2.5 font-heading text-[10.5px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
                  style={{ background: result.cabinet.accent }}
                >
                  Again · {result.cabinet.cost} {VIBECOIN_GLYPH}
                </button>
                <button
                  onClick={() => setResult(null)}
                  className="flex-1 rounded-xl border border-border/60 px-3 py-2.5 font-heading text-[10.5px] font-black uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
                >
                  Back to the floor
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
