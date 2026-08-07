/**
 * /orbit — the game the vibeverse bets on.
 *
 * One button. Hold to climb out of the gravity well, let go to fall back in,
 * thread the gates coming round the curve. It exists because the currency
 * needed a reason to be exciting rather than merely spendable: an arcade you
 * play alone is a score, and ten friends staking into one pot is an event.
 *
 * The page has two modes and the difference is the whole design:
 *
 * - **Free flight** is always there, always free, and uses a seed that changes
 *   every run. Nobody should have to spend a coin to find out whether they like
 *   it, and nobody should be able to grind the round's exact layout here.
 * - **The round** is one shared seed, one stake, one pot. You get the seed only
 *   after you have entered — enforced server-side, because practising the run
 *   you are about to bet on is the one cheat that would spoil it.
 *
 * Honest about what it is: scores are reported by the browser. The server
 * clamps them against how long the run actually took, which turns "post any
 * number" into "post any number and wait for it", and that is the right amount
 * of rigour for a game between friends with play money. It says so on the page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import {
  countdown,
  enterRound,
  fetchRound,
  submitScore,
  type RoundView,
} from "@/lib/rounds";
import { createOrbit, type OrbitRun } from "@/orbit/orbit";

type Mode = "idle" | "flying" | "over";

/** Tiny WebAudio kit. Built on first press, closed on unmount. */
function createSounds() {
  let ctx: AudioContext | null = null;
  const ac = () => {
    if (typeof window === "undefined") return null;
    if (!ctx) {
      const C =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };
  const tone = (f: number, d: number, type: OscillatorType, g = 0.06, delay = 0) => {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + delay;
    const o = a.createOscillator();
    const gn = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(g, t0 + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(gn).connect(a.destination);
    o.start(t0);
    o.stop(t0 + d + 0.03);
  };
  return {
    gate: () => tone(720, 0.09, "triangle", 0.05),
    near: () => {
      tone(880, 0.1, "triangle", 0.06);
      tone(1320, 0.12, "sine", 0.035, 0.03);
    },
    milestone: () => [0, 4, 7].forEach((s, i) => tone(660 * Math.pow(2, s / 12), 0.2, "triangle", 0.05, i * 0.06)),
    crash: () => tone(110, 0.32, "sawtooth", 0.08),
    close: () => {
      if (ctx) void ctx.close().catch(() => { /* already closed */ });
      ctx = null;
    },
  };
}

export default function Orbit() {
  useWorldStamp("/orbit", "Orbit");

  const { balance } = useVibecoin();
  const { displayName } = useVibeIdentity();
  const [view, setView] = useState<RoundView | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [staked, setStaked] = useState(false);
  const [entering, setEntering] = useState(false);
  const [result, setResult] = useState<{ score: number; detail: string; best?: number } | null>(null);
  const [tick, setTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runRef = useRef<OrbitRun | null>(null);
  const soundsRef = useRef<ReturnType<typeof createSounds> | null>(null);
  const seedRef = useRef<string>("");

  useEffect(() => {
    soundsRef.current = createSounds();
    return () => {
      soundsRef.current?.close();
      soundsRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setView(await fetchRound());
    } catch {
      /* Offline. The game still flies; only the pot is unavailable. */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* One second heartbeat: the countdown has to move, and the board should
     refresh often enough that a friend's run appears while you are looking. */
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (mode !== "flying") void refresh();
    }, 4000);
    const s = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(s);
    };
  }, [mode, refresh]);

  const round = view?.round ?? null;
  const inRound = staked || !!view?.you;
  const roundOpen = !!round && round.status === "open" && new Date(round.closesAt).getTime() > Date.now();

  // -------------------------------------------------------------------------

  const finish = useCallback(
    async (score: number, durationMs: number, detail: string) => {
      setMode("over");
      if (staked && round) {
        const r = await submitScore(round.id, score, durationMs);
        setResult({ score, detail, best: r?.best });
        if (r?.clamped) {
          toast.info("Score adjusted", {
            description: "The server floors a run at what was reachable in the time it took.",
          });
        }
        void refresh();
      } else {
        setResult({ score, detail });
      }
    },
    [staked, round, refresh],
  );

  /** Start a run. `seed` decides whether this is practice or the real thing. */
  const launch = useCallback(
    (seed: string, isStaked: boolean) => {
      seedRef.current = seed;
      setStaked(isStaked);
      setResult(null);
      setMode("flying");
    },
    [],
  );

  useEffect(() => {
    if (mode !== "flying") return;
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

    const run = createOrbit(w, h, seedRef.current);
    run.cue = (c) => {
      const s = soundsRef.current;
      if (!s) return;
      if (c === "gate") s.gate();
      else if (c === "near") s.near();
      else if (c === "milestone") s.milestone();
      else s.crash();
    };
    runRef.current = run;

    let raf = 0;
    let last = performance.now();
    let ended = false;
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      run.frame(ctx, dt);
      if (run.done && !ended) {
        ended = true;
        void finish(run.done.score, run.elapsedMs, run.done.detail);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      runRef.current = null;
    };
  }, [mode, finish]);

  /* Input. Space and pointer both map to the one button, and space must not
     scroll the page while somebody is holding it to climb. */
  useEffect(() => {
    if (mode !== "flying") return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.code !== "ArrowUp") return;
      e.preventDefault();
      if (!e.repeat) runRef.current?.setThrust(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.code !== "ArrowUp") return;
      e.preventDefault();
      runRef.current?.setThrust(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [mode]);

  const onEnter = async () => {
    setEntering(true);
    try {
      const r = await enterRound(displayName);
      if (!r.round.seed) throw new Error("the round did not hand back a seed");
      toast.success(r.alreadyIn ? "You are already in" : "You are in the round", {
        description: r.alreadyIn
          ? "Fly as many times as you like — your best run stands."
          : `−${round?.stake} ${VIBECOIN_GLYPH} staked. Best run wins the pot.`,
      });
      await refresh();
      launch(r.round.seed, true);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      toast.error("Could not enter", {
        description: /not enough/i.test(msg)
          ? `The buy-in is ${round?.stake} ${VIBECOIN_GLYPH}. Win some in the arcade first.`
          : msg,
      });
    } finally {
      setEntering(false);
    }
  };

  const flyAgain = () => {
    if (staked && round?.seed) launch(round.seed, true);
    else launch(`free-${Date.now()}`, false);
  };

  const canAfford = balance == null || !round || balance >= round.stake;
  const myBest = view?.you?.bestScore ?? 0;
  void tick; // the interval above is what re-renders the countdown

  // -------------------------------------------------------------------------

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#03050c] text-foreground">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 55% at 50% -10%, hsl(200 90% 55% / 0.16), transparent 62%)," +
            "radial-gradient(55% 45% at 88% 12%, hsl(268 88% 62% / 0.16), transparent 68%)," +
            "radial-gradient(50% 40% at 8% 88%, hsl(160 85% 50% / 0.10), transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-20 sm:px-6 sm:pt-24">
        <motion.header
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.42em] text-[#8fb4ff] sm:text-[10px]">
            One button · one planet · one pot
          </p>
          <h1
            className="mt-2.5 font-heading text-5xl font-black tracking-tight sm:text-7xl"
            style={{
              color: "#eafff8",
              textShadow:
                "0 0 16px hsl(170 90% 60% / 0.55), 0 0 52px hsl(200 90% 60% / 0.4), 0 0 110px hsl(268 88% 62% / 0.35)",
            }}
          >
            ORBIT
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
            Hold to climb out of the well. Let go to fall back in. Thread the gates
            coming round the curve — everyone in a round flies the same sky, so the
            only variable is you.
          </p>
        </motion.header>

        <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          {/* ---- the screen ---- */}
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, delay: 0.08 }}
            className="relative"
          >
            <div
              className="relative overflow-hidden rounded-3xl border"
              style={{
                borderColor: "rgba(125, 255, 212, 0.22)",
                boxShadow: "0 0 90px rgba(60, 140, 255, 0.16), inset 0 0 60px rgba(10, 30, 60, 0.5)",
              }}
            >
              <canvas
                ref={canvasRef}
                onPointerDown={(e) => {
                  e.preventDefault();
                  runRef.current?.setThrust(true);
                }}
                onPointerUp={() => runRef.current?.setThrust(false)}
                onPointerLeave={() => runRef.current?.setThrust(false)}
                className="block aspect-[4/3] w-full touch-none select-none bg-[#03050c] sm:aspect-[16/10]"
              />

              {/* Idle / results overlay */}
              <AnimatePresence>
                {mode !== "flying" && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 grid place-items-center bg-[#03050c]/82 px-6 backdrop-blur-[2px]"
                  >
                    <div className="w-full max-w-sm text-center">
                      {mode === "over" && result ? (
                        <>
                          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.3em] text-muted-foreground">
                            {staked ? "Round run" : "Free flight"}
                          </p>
                          <div className="mt-2 font-heading text-6xl font-black leading-none tabular-nums text-[#eafff8]">
                            {result.score}
                          </div>
                          <p className="mt-1 font-heading text-[10px] font-bold uppercase tracking-[0.24em] text-[#8fb4ff]">
                            gates
                          </p>
                          <p className="mt-3 text-[12.5px] leading-snug text-foreground/75">
                            {result.detail}
                          </p>
                          {staked && result.best != null && (
                            <p className="mt-2 text-[12px] text-[#7dffd4]">
                              {result.score >= result.best
                                ? "That is your best of the round."
                                : `Your best this round is still ${result.best}.`}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="font-heading text-lg font-black uppercase tracking-wider text-[#eafff8]">
                            Ready
                          </p>
                          <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
                            Hold the screen or the space bar to burn outward. Release and
                            gravity takes you back down.
                          </p>
                        </>
                      )}

                      <div className="mt-5 flex flex-col gap-2">
                        {inRound && round?.seed && roundOpen ? (
                          <button
                            onClick={() => launch(round.seed!, true)}
                            className="rounded-xl bg-[#7dffd4] px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.16em] text-black transition-transform hover:scale-[1.02]"
                          >
                            {mode === "over" ? "Fly the round again" : "Fly the round"}
                          </button>
                        ) : roundOpen && round ? (
                          <button
                            onClick={() => void onEnter()}
                            disabled={entering || !canAfford}
                            className="rounded-xl bg-[#7dffd4] px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.16em] text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {entering
                              ? "Staking…"
                              : canAfford
                                ? `Stake ${round.stake} ${VIBECOIN_GLYPH} and fly`
                                : `Need ${round.stake} ${VIBECOIN_GLYPH}`}
                          </button>
                        ) : null}

                        <button
                          onClick={() => launch(`free-${Date.now()}`, false)}
                          className="rounded-xl border border-border/60 px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.16em] text-foreground/85 transition-colors hover:border-foreground/40 hover:text-foreground"
                        >
                          {mode === "over" && !staked ? "Fly again — free" : "Free flight"}
                        </button>
                        {mode === "over" && staked && (
                          <button
                            onClick={flyAgain}
                            className="text-[11px] text-muted-foreground underline-offset-4 hover:underline"
                          >
                            or take a free practice run
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
              Hold anywhere · or the space bar
            </p>
          </motion.div>

          {/* ---- the pot ---- */}
          <motion.aside
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.14 }}
            className="flex flex-col gap-4"
          >
            <div className="rounded-2xl border border-border/50 bg-black/40 p-4 backdrop-blur-sm">
              <div className="flex items-center gap-2.5">
                <VibeCoinMark size={30} />
                <div className="min-w-0">
                  <div className="font-heading text-xl font-black leading-none tabular-nums text-[#7dffd4]">
                    {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
                  </div>
                  <div className="mt-0.5 font-heading text-[8px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                    Yours
                  </div>
                </div>
                <Link
                  to="/arcade"
                  className="ml-auto rounded-full border border-border/60 px-2.5 py-1.5 font-heading text-[8.5px] font-bold uppercase tracking-wider text-foreground/75 transition-colors hover:text-foreground"
                >
                  Win more
                </Link>
              </div>
            </div>

            {round ? (
              <div
                className="rounded-2xl border p-4"
                style={{
                  borderColor: roundOpen ? "rgba(125,255,212,0.35)" : "hsl(var(--border) / 0.5)",
                  background: roundOpen ? "rgba(125,255,212,0.05)" : "rgba(0,0,0,0.28)",
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="font-heading text-[11px] font-black uppercase tracking-[0.18em] text-[#7dffd4]">
                    {round.title}
                  </h2>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {roundOpen ? countdown(round.closesAt) : "closed"}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="font-heading text-lg font-black tabular-nums text-[#eafff8]">
                      {round.pot}
                    </div>
                    <div className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                      Pot {VIBECOIN_GLYPH}
                    </div>
                  </div>
                  <div>
                    <div className="font-heading text-lg font-black tabular-nums text-[#eafff8]">
                      {round.entries}
                    </div>
                    <div className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                      Flying
                    </div>
                  </div>
                  <div>
                    <div className="font-heading text-lg font-black tabular-nums text-[#eafff8]">
                      {round.stake}
                    </div>
                    <div className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                      Buy-in
                    </div>
                  </div>
                </div>

                {inRound ? (
                  <p className="mt-3 rounded-lg bg-[#7dffd4]/10 px-2.5 py-2 text-center text-[11px] text-[#7dffd4]">
                    You are in. Best of {view?.you?.plays ?? 0} run
                    {(view?.you?.plays ?? 0) === 1 ? "" : "s"}: <b>{myBest}</b>
                  </p>
                ) : roundOpen ? (
                  <p className="mt-3 text-center text-[11px] leading-snug text-muted-foreground">
                    Stake {round.stake} {VIBECOIN_GLYPH} to join. Fly as many times as you
                    like — your best run is the one that counts.
                  </p>
                ) : (
                  <p className="mt-3 text-center text-[11px] text-muted-foreground">
                    This one is over. {round.winnerRef ? "The pot has been paid." : ""}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-border/50 bg-black/28 p-4 text-center">
                <p className="text-[12px] text-muted-foreground">
                  No round is open right now. Free flight is always here.
                </p>
              </div>
            )}

            {/* ---- leaderboard ---- */}
            <div className="overflow-hidden rounded-2xl border border-border/50 bg-black/28">
              <h3 className="border-b border-border/40 px-4 py-2.5 font-heading text-[9px] font-black uppercase tracking-[0.22em] text-muted-foreground">
                The board
              </h3>
              {view?.leaderboard?.length ? (
                <ol className="max-h-[19rem] overflow-y-auto">
                  {view.leaderboard.map((row, i) => (
                    <li
                      key={row.owner_ref}
                      className="flex items-center gap-2.5 px-4 py-2 text-[12px] odd:bg-white/[0.02]"
                    >
                      <span
                        className="w-5 shrink-0 font-heading text-[10px] font-black tabular-nums"
                        style={{ color: i === 0 ? "#ffd166" : i < 3 ? "#8fb4ff" : "hsl(var(--muted-foreground))" }}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground/85">
                        {row.display_name || "Anonymous"}
                      </span>
                      <span className="shrink-0 font-heading font-black tabular-nums text-[#7dffd4]">
                        {row.best_score}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-4 py-5 text-center text-[11.5px] text-muted-foreground/70">
                  Nobody has flown it yet. First name on the board is yours.
                </p>
              )}
            </div>

            <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground/65">
              Everyone in a round flies the identical gate layout — the seed is only
              handed out after you stake, so nobody can practise the exact run first.
              Scores come from your browser and the server floors them at what was
              reachable in the time the run took.
            </p>
          </motion.aside>
        </div>
      </div>
    </div>
  );
}
