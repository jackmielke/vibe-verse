/**
 * ROCK PAPER SCISSORS — the headline game on the arcade floor.
 *
 * The other cabinets are canvas games where you play against a difficulty
 * curve. This one is the only thing in the vibeverse where you play against
 * *somebody*, for money you name yourself, and that is why it leads the page.
 * It is also the simplest possible game, which is the point: nothing to learn,
 * nothing to be bad at, one tap and you either won or you did not.
 *
 * ## The three-beat shake is the whole feeling
 *
 * A hand resolves server-side in about 200ms. Showing the result that fast
 * makes it feel like a coin flip in a spreadsheet, so the arena spends 1.4
 * seconds on the shake — the thing everybody does with their fist before they
 * throw — and reveals on the fourth beat. That delay is not fake suspense
 * covering a slow request: the request has usually already come back, and the
 * result is held until the animation is ready for it.
 *
 * ## Fairness, visibly
 *
 * The house picks its throw and publishes `sha256(throw:nonce)` BEFORE you
 * move — that hash is on screen during the shake, which is the only moment it
 * means anything. Afterwards the reveal comes back and the browser re-hashes
 * it: a green seal means this exact hand could not have been changed after you
 * chose. See `src/rps/rps.ts`; the check runs here, not on the server, because
 * a server confirming its own honesty is not a confirmation.
 *
 * ## The money
 *
 * Stake what you like between the bounds the table names. A win pays 2×, a tie
 * gives the ante back, a loss keeps it — dead even over decided hands, no rake.
 * The server owns the bounds, the payout curve and the outcome; this file owns
 * how it feels.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { fetchTable, openHand, throwHand, type TableState } from "@/lib/rpsTable";
import {
  THROWS,
  THROW_EMOJI as HAND,
  THROW_LABEL as LABEL,
  verifyCommit,
  type Outcome,
  type Throw,
} from "@/rps/rps";
import { createArcadeSounds, type ArcadeSounds } from "@/arcade/sounds";

/** Beat length. Three shakes then the reveal — 4 × 350ms. */
const BEAT = 350;

interface Settled {
  outcome: Outcome;
  playerThrow: Throw;
  houseThrow: Throw;
  payout: number;
  stake: number;
  /** true = the commitment checked out, false = it did not, null = no crypto. */
  fair: boolean | null;
}

/** Stake presets. Capped to the table's ceiling and your actual balance. */
function presets(min: number, max: number, balance: number | null): number[] {
  const wanted = [10, 25, 50, 100, 250, 500];
  const ceiling = Math.min(max, balance ?? max);
  const out = wanted.filter((n) => n >= min && n <= ceiling);
  // Always offer the smallest legal hand, so a nearly-broke player still has a
  // button rather than an empty row.
  if (!out.length && balance != null && balance >= min) return [min];
  return out;
}

export default function RpsArena() {
  const { balance } = useVibecoin();
  const [table, setTable] = useState<TableState | null>(null);
  const [stake, setStake] = useState(25);
  const [phase, setPhase] = useState<"idle" | "shaking" | "done">("idle");
  const [beat, setBeat] = useState(0);
  const [mine, setMine] = useState<Throw | null>(null);
  const [result, setResult] = useState<Settled | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sounds = useRef<ArcadeSounds | null>(null);
  const timers = useRef<number[]>([]);

  /* One AudioContext for the visit, closed on unmount — browsers cap live
     contexts and a leaked one breaks audio in the next world you open. */
  useEffect(() => {
    sounds.current = createArcadeSounds();
    return () => {
      sounds.current?.close();
      sounds.current = null;
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, []);

  useEffect(() => {
    let live = true;
    void fetchTable()
      .then((t) => {
        if (!live) return;
        setTable(t);
        setStake(t.stake);
      })
      .catch(() => {
        /* The table is unreachable. The card still renders with defaults and
           the first tap will say so properly. */
      });
    return () => {
      live = false;
    };
  }, []);

  const min = table?.minStake ?? 5;
  const max = table?.maxStake ?? 500;
  const chips = presets(min, max, balance);
  const affordable = balance == null || balance >= stake;

  const play = useCallback(
    async (choice: Throw) => {
      if (busy || phase === "shaking") return;
      setBusy(true);
      setMine(choice);
      setResult(null);
      setCommit(null);

      try {
        /* Open FIRST, and only then throw. The house commits to its move
           before it can possibly know yours — that ordering is the fairness
           guarantee, not a formality, so it is not worth "optimising" into a
           single call. */
        const hand = await openHand({ stake });
        /* A hand you paid for and walked away from comes back rather than
           charging you again — which means it comes back at the stake it was
           opened at, not the one now showing in the picker. Say so, instead of
           promising 500 and quietly playing for 25. */
        if (hand.stake !== stake) setStake(hand.stake);
        setCommit(hand.commit);
        setPhase("shaking");
        setBeat(0);
        sounds.current?.blip(3);

        // The shake, while the request is in flight.
        for (let i = 1; i <= 3; i++) {
          timers.current.push(
            window.setTimeout(() => {
              setBeat(i);
              sounds.current?.blip(2 + i);
            }, BEAT * i),
          );
        }

        const [r] = await Promise.all([
          throwHand(hand.handId, choice),
          // Hold the answer back until the arm has finished swinging.
          new Promise((res) => timers.current.push(window.setTimeout(res, BEAT * 4))),
        ]);

        const fair = await verifyCommit(r.reveal.throw as Throw, r.reveal.nonce, r.reveal.commit);
        setResult({
          outcome: r.outcome,
          playerThrow: r.playerThrow,
          houseThrow: r.houseThrow,
          payout: r.payout,
          stake: r.stake,
          fair,
        });
        setPhase("done");
        if (r.outcome === "win") sounds.current?.fanfare();
        else if (r.outcome === "push") sounds.current?.chime();
        else sounds.current?.thud();
      } catch (e) {
        setPhase("idle");
        setMine(null);
        const msg = String((e as Error)?.message ?? e);
        toast.error("The table would not deal", {
          description: /not enough/i.test(msg)
            ? `That hand costs ${stake} ${VIBECOIN_GLYPH} and you are short. Win some on a cabinet below.`
            : msg,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, phase, stake],
  );

  const again = () => {
    setPhase("idle");
    setMine(null);
    setResult(null);
    setCommit(null);
    setBeat(0);
  };

  const accent =
    result?.outcome === "win"
      ? "#7dffd4"
      : result?.outcome === "lose"
        ? "#ff6b8a"
        : result?.outcome === "push"
          ? "#ffd166"
          : "#c084fc";

  return (
    <section
      className="relative overflow-hidden rounded-3xl border bg-black/50 backdrop-blur-sm"
      style={{
        borderColor: `${accent}44`,
        boxShadow: `0 0 70px ${accent}1f, inset 0 0 0 1px ${accent}18`,
        transition: "border-color 500ms ease, box-shadow 500ms ease",
      }}
    >
      {/* Arena lighting — two washes that take the colour of the outcome. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            `radial-gradient(70% 60% at 25% 0%, ${accent}22, transparent 62%),` +
            `radial-gradient(60% 55% at 78% 100%, ${accent}18, transparent 66%)`,
          transition: "background 500ms ease",
        }}
        aria-hidden
      />

      <div className="relative px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="font-heading text-[8.5px] font-bold uppercase tracking-[0.28em] text-[#e2b7ff]">
              House game · provably fair
            </p>
            <h2
              className="mt-1 font-heading text-2xl font-black uppercase leading-none tracking-wider sm:text-3xl"
              style={{ color: "#fff", textShadow: `0 0 18px ${accent}88` }}
            >
              Rock Paper Scissors
            </h2>
          </div>
          <span className="shrink-0 font-heading text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
            Win pays 2×
          </span>
        </div>

        {/* ---- The arena ---- */}
        <div className="relative mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-2xl border border-border/40 bg-black/45 px-3 py-5 sm:py-7">
          <Fist
            who="You"
            hand={phase === "done" ? result?.playerThrow ?? null : null}
            pending={mine}
            beat={beat}
            shaking={phase === "shaking"}
            side={-1}
            accent={accent}
          />

          <div className="flex flex-col items-center gap-1">
            <span
              className="font-heading text-[11px] font-black uppercase tracking-[0.2em]"
              style={{ color: `${accent}cc` }}
            >
              vs
            </span>
            {phase === "shaking" && (
              <span className="font-mono text-[9px] text-muted-foreground/60">
                {beat === 0 ? "3" : beat === 1 ? "2" : beat === 2 ? "1" : "!"}
              </span>
            )}
          </div>

          <Fist
            who="House"
            hand={phase === "done" ? result?.houseThrow ?? null : null}
            pending={null}
            beat={beat}
            shaking={phase === "shaking"}
            side={1}
            accent={accent}
          />
        </div>

        {/* ---- The outcome ---- */}
        <AnimatePresence mode="wait">
          {phase === "done" && result ? (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 22 }}
              className="mt-3 text-center"
            >
              <p
                className="font-heading text-xl font-black uppercase tracking-wider sm:text-2xl"
                style={{ color: accent, textShadow: `0 0 22px ${accent}66` }}
              >
                {result.outcome === "win"
                  ? "You win"
                  : result.outcome === "push"
                    ? "Dead heat"
                    : "House takes it"}
              </p>
              <p className="mt-1 font-heading text-lg font-black tabular-nums text-foreground/85">
                {result.outcome === "win"
                  ? `+${formatVibecoin(result.payout - result.stake)} ${VIBECOIN_GLYPH}`
                  : result.outcome === "push"
                    ? `± 0 ${VIBECOIN_GLYPH} — ante back`
                    : `−${formatVibecoin(result.stake)} ${VIBECOIN_GLYPH}`}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {LABEL[result.playerThrow]} against {LABEL[result.houseThrow]}
              </p>

              {/* The seal. Checked here, in the browser, against the hash that
                  was on screen before the throw. */}
              {result.fair != null && (
                <p
                  className={`mt-2 inline-flex items-center gap-1.5 text-[10px] ${
                    result.fair ? "text-[#7dffd4]/80" : "text-rose-300"
                  }`}
                >
                  {result.fair ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <ShieldAlert className="h-3 w-3" />
                  )}
                  {result.fair
                    ? "Verified — the house's throw was sealed before you moved"
                    : "That seal did not check out. Screenshot this."}
                </p>
              )}

              <button
                onClick={again}
                className="mt-3 w-full rounded-xl px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.14em] text-black transition-transform hover:scale-[1.02]"
                style={{ background: accent, boxShadow: `0 0 26px ${accent}55` }}
              >
                Play again · {stake} {VIBECOIN_GLYPH}
              </button>
            </motion.div>
          ) : (
            <motion.div key="picker" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {/* ---- Stake ---- */}
              <div className="mt-3.5 flex items-center gap-2">
                <span className="font-heading text-[8.5px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Stake
                </span>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {chips.map((n) => (
                    <button
                      key={n}
                      onClick={() => setStake(n)}
                      disabled={phase === "shaking"}
                      className={`rounded-lg border px-2.5 py-1 font-heading text-[10px] font-black tabular-nums transition-colors ${
                        stake === n
                          ? "border-[#c084fc] bg-[#c084fc]/15 text-[#e2b7ff]"
                          : "border-border/50 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  {balance != null && balance >= min && (
                    <button
                      onClick={() => setStake(Math.min(max, Math.floor(balance)))}
                      disabled={phase === "shaking"}
                      className="rounded-lg border border-border/50 px-2.5 py-1 font-heading text-[10px] font-black uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                    >
                      All in
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <VibeCoinMark size={16} />
                <span className="font-heading text-sm font-black tabular-nums text-[#c084fc]">
                  {stake}
                </span>
                <span className="text-[10.5px] text-muted-foreground">
                  to play · {stake * 2} {VIBECOIN_GLYPH} if you win
                </span>
              </div>

              {/* ---- The three buttons ---- */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                {THROWS.map((t) => (
                  <button
                    key={t}
                    onClick={() => void play(t)}
                    disabled={phase === "shaking" || busy || !affordable}
                    className="group flex flex-col items-center gap-1 rounded-2xl border border-border/50 bg-black/40 py-3 transition-all enabled:hover:scale-[1.04] enabled:hover:border-[#c084fc]/60 enabled:hover:bg-[#c084fc]/[0.08] disabled:opacity-40"
                  >
                    <span className="text-3xl leading-none sm:text-4xl" aria-hidden>
                      {HAND[t]}
                    </span>
                    <span className="font-heading text-[9px] font-black uppercase tracking-wider text-muted-foreground group-hover:text-foreground">
                      {LABEL[t]}
                    </span>
                  </button>
                ))}
              </div>

              {!affordable && (
                <p className="mt-2 text-center text-[11px] text-amber-300/85">
                  {balance == null
                    ? "Reading your balance…"
                    : `You have ${formatVibecoin(balance)} ${VIBECOIN_GLYPH}. Pick a smaller hand, or win some on a cabinet below.`}
                </p>
              )}

              {/* The commitment, on screen at the only moment it proves
                  anything: after the house has chosen and before you have. */}
              {phase === "shaking" && commit && (
                <p className="mt-2 truncate text-center font-mono text-[9px] text-muted-foreground/50">
                  sealed {commit.slice(0, 24)}…
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {table && (table.record.win || table.record.lose || table.record.push) ? (
          <p className="mt-3 text-center font-heading text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">
            {table.record.win}W · {table.record.lose}L · {table.record.push}D at this table
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One hand, shaking or thrown.
 *
 * The shake is a rotation about the wrist rather than a bounce, because that
 * is what a real one is, and the two sides shake in opposite directions so the
 * pair reads as two people rather than one animation played twice.
 */
function Fist({
  who,
  hand,
  pending,
  beat,
  shaking,
  side,
  accent,
}: {
  who: string;
  hand: Throw | null;
  pending: Throw | null;
  beat: number;
  shaking: boolean;
  side: 1 | -1;
  accent: string;
}) {
  const shown = hand ?? (shaking ? "rock" : pending);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <motion.div
        // Keyed on the beat so each shake re-triggers rather than easing once.
        key={`${who}-${beat}-${hand ?? "none"}`}
        initial={shaking ? { rotate: side * -26, y: -8 } : { scale: 0.7, opacity: 0 }}
        animate={shaking ? { rotate: side * 10, y: 4 } : { scale: 1, opacity: 1 }}
        transition={
          shaking
            ? { duration: BEAT / 1000, ease: "easeInOut" }
            : { type: "spring", stiffness: 420, damping: 14 }
        }
        className="text-5xl leading-none sm:text-6xl"
        style={{ filter: hand ? `drop-shadow(0 0 18px ${accent}88)` : undefined }}
        aria-hidden
      >
        {/* The mirror lives on an inner span, not in this element's `style`.
            framer-motion writes `transform` on the animated element every
            frame, so a `scaleX(-1)` set there is overwritten on the first tick
            and the two hands face the same way — which reads as one animation
            played twice rather than as two people. */}
        <span style={{ display: "inline-block", transform: side === 1 ? "scaleX(-1)" : undefined }}>
          {shown ? HAND[shown] : "🫱"}
        </span>
      </motion.div>
      <span className="font-heading text-[8.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        {who}
      </span>
    </div>
  );
}
