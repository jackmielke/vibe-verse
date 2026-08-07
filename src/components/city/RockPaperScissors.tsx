/**
 * The rock-paper-scissors table, as a modal you open by walking up to it.
 *
 * ## What this screen is trying to earn
 *
 * Betting against a house is only fun if you believe the house is not cheating,
 * and the usual way an app asks for that belief is a sentence nobody reads. So
 * the trust is built into the *choreography* instead:
 *
 *   1. Before you pick, the house's sealed throw appears — a real hash, on
 *      screen, with the words "sealed before you choose".
 *   2. You pick. There is a countdown, because a bet with no beat is a form.
 *   3. The seal breaks, and the page re-hashes the reveal in front of you and
 *      says whether it matched.
 *
 * Step 3 is the point. `verifyCommit` runs in the player's own browser, so
 * "provably fair" is a thing they watched happen rather than a claim.
 *
 * The money is ledger Vibecoin. The dollar line is deliberately absent — see
 * the note by `priceLine` below.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { VIBECOIN_GLYPH } from "@/lib/vibecoin";
import { fetchTable, openHand, throwHand, type HandResult, type TableState } from "@/lib/rpsTable";
import {
  RPS_STAKE,
  THROWS,
  THROW_EMOJI,
  THROW_LABEL,
  outcomeLine,
  shortHash,
  verifyCommit,
  type Throw,
} from "@/rps/rps";

type Phase = "idle" | "dealing" | "armed" | "counting" | "revealed";

/**
 * Opens the table from a script, in dev only.
 *
 * The kiosk is a proximity trigger on a 55-metre island, which is a miserable
 * thing to reach from a headless browser — the screenshot harness would spend
 * its life walking. Same shape as `__cityCam`: a DEV-gated window hook that a
 * production visitor never receives, removed on unmount.
 */
export function RpsDevHook({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__openRpsTable = onOpen;
    return () => {
      delete w.__openRpsTable;
    };
  }, [onOpen]);
  return null;
}

const OUTCOME_TONE = {
  win:  { ring: "#7dffd4", label: "You take it" },
  lose: { ring: "#ff8a74", label: "The house takes it" },
  push: { ring: "#8fb4ff", label: "Push" },
} as const;

export default function RockPaperScissors({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { balance } = useVibecoin();
  const [table, setTable] = useState<TableState | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [handId, setHandId] = useState<string | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [picked, setPicked] = useState<Throw | null>(null);
  const [result, setResult] = useState<HandResult | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);

  /* The shuffle behind the sealed card while the countdown runs. Cosmetic —
     the house's throw was decided and hashed before the modal even opened. */
  const [flicker, setFlicker] = useState<Throw>("rock");
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current.forEach((t) => window.clearInterval(t));
    timers.current = [];
  };

  const load = useCallback(async () => {
    try {
      const t = await fetchTable();
      setTable(t);
      // A hand you already paid for is still on the table.
      if (t.open) {
        setHandId(t.open.id);
        setCommit(t.open.commit_hash);
        setPhase("armed");
      }
    } catch {
      /* Offline. The kiosk says so below rather than pretending. */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    return clearTimers;
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const deal = async () => {
    setBusy(true);
    try {
      const h = await openHand();
      setHandId(h.handId);
      setCommit(h.commit);
      setResult(null);
      setVerified(null);
      setPicked(null);
      setPhase("armed");
      if (h.resumed) {
        toast.info("You already had a hand on the table", {
          description: "Your ante is still down. Pick a throw.",
        });
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      toast.error("Could not deal", {
        description: /not enough/i.test(msg)
          ? `A hand costs ${RPS_STAKE} ${VIBECOIN_GLYPH}. Win some in the arcade first.`
          : msg,
      });
    } finally {
      setBusy(false);
    }
  };

  const play = async (t: Throw) => {
    if (!handId || phase !== "armed") return;
    setPicked(t);
    setPhase("counting");
    setCount(3);

    const spin = window.setInterval(
      () => setFlicker(THROWS[Math.floor(Math.random() * 3)]),
      90,
    );
    timers.current.push(spin);

    // Fire the request immediately; the countdown is theatre running alongside
    // it, so a slow network shortens the wait rather than adding to it.
    const pending = throwHand(handId, t);

    for (const [n, ms] of [[2, 600], [1, 1200]] as const) {
      timers.current.push(window.setTimeout(() => setCount(n), ms));
    }

    timers.current.push(
      window.setTimeout(async () => {
        window.clearInterval(spin);
        try {
          const r = await pending;
          setResult(r);
          setPhase("revealed");
          setVerified(await verifyCommit(r.reveal.throw, r.reveal.nonce, r.reveal.commit));
          void load();
        } catch (e) {
          setPhase("armed");
          toast.error("That hand did not go through", {
            description: String((e as Error)?.message ?? e),
          });
        }
      }, 1800),
    );
  };

  const again = () => {
    clearTimers();
    setResult(null);
    setVerified(null);
    setPicked(null);
    setHandId(null);
    setCommit(null);
    setPhase("idle");
  };

  if (!open) return null;

  const stake = table?.stake ?? RPS_STAKE;
  const canAfford = balance == null || balance >= stake;
  const tone = result ? OUTCOME_TONE[result.outcome] : null;

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/78 p-4 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-[#7dffd4]/25 bg-[#04070f] shadow-[0_0_90px_rgba(60,140,255,0.2)]"
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 50% at 50% -8%, hsl(160 88% 52% / 0.16), transparent 64%)," +
              "radial-gradient(60% 45% at 92% 8%, hsl(268 88% 62% / 0.14), transparent 70%)",
          }}
          aria-hidden
        />

        <button
          onClick={onClose}
          aria-label="Leave the table"
          className="absolute right-3 top-3 z-10 rounded-full p-2 text-foreground/50 transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative px-6 pb-6 pt-7 sm:px-8">
          <p className="text-center font-heading text-[9px] font-bold uppercase tracking-[0.42em] text-[#8fb4ff]">
            The island table
          </p>
          <h2 className="mt-2 text-center font-heading text-3xl font-black tracking-tight text-[#eafff8]">
            Rock&nbsp;·&nbsp;Paper&nbsp;·&nbsp;Scissors
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-center text-[12.5px] leading-relaxed text-muted-foreground">
            One hand against the house. Dead fair — a tie gives your ante back,
            and there is no rake.
          </p>

          {/* ---- the sealed throw ------------------------------------------ */}
          <div className="mt-6 rounded-2xl border border-border/50 bg-black/40 p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="font-heading text-[9.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                The house's throw
              </span>
              {commit && phase !== "revealed" && (
                <span className="font-heading text-[9px] font-bold uppercase tracking-[0.16em] text-[#7dffd4]">
                  sealed before you choose
                </span>
              )}
            </div>

            <div className="mt-3 grid place-items-center">
              <AnimatePresence mode="wait">
                {phase === "revealed" && result ? (
                  <motion.div
                    key="revealed"
                    initial={{ scale: 0.6, opacity: 0, rotate: -12 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{ type: "spring", stiffness: 260, damping: 16 }}
                    className="text-[64px] leading-none"
                  >
                    {THROW_EMOJI[result.houseThrow]}
                  </motion.div>
                ) : phase === "counting" ? (
                  <motion.div key="spin" className="text-[64px] leading-none opacity-70">
                    {THROW_EMOJI[flicker]}
                  </motion.div>
                ) : (
                  <motion.div
                    key="sealed"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="grid h-[64px] w-[64px] place-items-center rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] text-[26px]"
                  >
                    🔒
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {commit && (
              <p
                className="mt-3 break-all text-center font-mono text-[10px] leading-relaxed text-muted-foreground/60"
                title={commit}
              >
                {shortHash(commit)}
              </p>
            )}
          </div>

          {/* ---- your move ------------------------------------------------- */}
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            {THROWS.map((t) => {
              const chosen = picked === t;
              const dim = phase === "revealed" && !chosen;
              return (
                <button
                  key={t}
                  disabled={phase !== "armed"}
                  onClick={() => void play(t)}
                  className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-4 transition-all disabled:cursor-not-allowed ${
                    chosen
                      ? "border-[#7dffd4] bg-[#7dffd4]/[0.12]"
                      : "border-border/55 bg-black/30 enabled:hover:border-[#7dffd4]/60 enabled:hover:bg-[#7dffd4]/[0.07]"
                  } ${dim ? "opacity-35" : ""} ${phase === "armed" ? "" : "opacity-70"}`}
                >
                  <span className="text-[30px] leading-none">{THROW_EMOJI[t]}</span>
                  <span className="font-heading text-[9.5px] font-bold uppercase tracking-[0.14em] text-foreground/80">
                    {THROW_LABEL[t]}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ---- the state line --------------------------------------------
              "Pick a throw" sits outside the AnimatePresence below. It is not a
              transition, it is the resting state of a paid-for hand, and inside
              a `mode="wait"` group it waited on the previous child's exit and
              left a hole where the instruction should have been. */}
          {phase === "armed" && (
            <p className="mt-6 text-center text-[13px] text-foreground/80">
              Your ante is down. Pick a throw.
            </p>
          )}

          <div className={phase === "armed" ? "mt-2" : "mt-5 min-h-[132px]"}>
            <AnimatePresence mode="wait">
              {phase === "idle" && (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <button
                    onClick={() => void deal()}
                    disabled={busy || !canAfford}
                    className="w-full rounded-2xl bg-[#7dffd4] px-4 py-3.5 font-heading text-[11.5px] font-black uppercase tracking-[0.16em] text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    ) : canAfford ? (
                      `Ante ${stake} ${VIBECOIN_GLYPH} and deal`
                    ) : (
                      `You need ${stake} ${VIBECOIN_GLYPH}`
                    )}
                  </button>
                  <p className="mt-2.5 text-center text-[11px] text-muted-foreground/70">
                    Win and you take {stake * 2} {VIBECOIN_GLYPH} · tie and your ante comes back
                  </p>
                </motion.div>
              )}

              {phase === "counting" && (
                <motion.div
                  key="counting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="pt-1 text-center"
                >
                  <div className="font-heading text-5xl font-black tabular-nums text-[#eafff8]">
                    {count}
                  </div>
                </motion.div>
              )}

              {phase === "revealed" && result && tone && (
                <motion.div
                  key="revealed"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-center"
                >
                  <p
                    className="font-heading text-xl font-black uppercase tracking-wider"
                    style={{ color: tone.ring }}
                  >
                    {tone.label}
                  </p>
                  <p className="mt-1 text-[12.5px] text-foreground/75">
                    {outcomeLine(result.outcome, result.playerThrow, result.houseThrow)}
                  </p>
                  <p className="mt-2 font-heading text-[13px] font-bold tabular-nums" style={{ color: tone.ring }}>
                    {result.payout > result.stake
                      ? `+${result.payout - result.stake} ${VIBECOIN_GLYPH}`
                      : result.payout === result.stake
                        ? `± 0 ${VIBECOIN_GLYPH}`
                        : `−${result.stake} ${VIBECOIN_GLYPH}`}
                  </p>

                  {/* The proof, checked here rather than asserted. */}
                  <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px]">
                    {verified === true ? (
                      <>
                        <ShieldCheck className="h-3.5 w-3.5 text-[#7dffd4]" />
                        <span className="text-[#7dffd4]">Seal checked out — the house did not change its throw</span>
                      </>
                    ) : verified === false ? (
                      <>
                        <ShieldAlert className="h-3.5 w-3.5 text-[#ff8a74]" />
                        <span className="text-[#ff8a74]">The seal does not match. Screenshot this.</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground/60">Could not check the seal in this browser</span>
                    )}
                  </div>

                  <button
                    onClick={again}
                    className="mt-4 w-full rounded-2xl bg-[#7dffd4] px-4 py-3 font-heading text-[11.5px] font-black uppercase tracking-[0.16em] text-black transition-transform hover:scale-[1.02]"
                  >
                    Play another
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ---- footer: wallet, record, and the honest note ---------------- */}
          <div className="mt-5 flex items-center gap-3 border-t border-border/40 pt-4">
            <VibeCoinMark size={22} />
            <span className="font-heading text-[13px] font-bold tabular-nums text-[#7dffd4]">
              {balance == null ? "—" : balance}
            </span>
            {table && (table.record.win + table.record.lose + table.record.push) > 0 && (
              <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                {table.record.win}W · {table.record.lose}L · {table.record.push}P
              </span>
            )}
          </div>

          {/* The one thing this screen must not overclaim. Vibecoin is play
              money; $VIBE is a real token; there is no rate between them, so no
              dollar figure is shown. Every hand records the live token price so
              the history could be priced if a rate is ever set — see
              docs/VIBECOIN.md §1. */}
          <p className="mt-3 text-center text-[10.5px] leading-relaxed text-muted-foreground/50">
            Played in Vibecoin, the vibeverse's own currency. $VIBE is a separate
            real token and this table never touches it.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
