/**
 * AGENTOCRACY: a cardboard Bainbridge Island run by fifty AI agents.
 *
 * Thin page, same shape as the Dipsea: title card, HUD, touch controls, and
 * a container the engine renders into. Everything that moves lives in
 * `src/agentocracy/`; the rules live in `village.ts` and know nothing about
 * three or React.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { AgentocracyState, AgentocracyWorld } from "@/agentocracy/world";
import { ROUNDS, fmtMoney } from "@/agentocracy/village";

const JOY = 44;

export default function Agentocracy() {
  useWorldStamp("/agentocracy", "Agentocracy");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<AgentocracyWorld | null>(null);
  const joyRef = useRef<HTMLDivElement | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<AgentocracyState | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createAgentocracy } = await import("@/agentocracy/world");
    if (!containerRef.current) return;
    worldRef.current = createAgentocracy({ container: containerRef.current, onState: setState });
    setBooting(false);
    setStarted(true);
  }, [booting]);

  useEffect(() => {
    if (shotMode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // ---- Joystick ---------------------------------------------------------
  const joyStart = (e: React.PointerEvent<HTMLDivElement>) => {
    joyRef.current?.setPointerCapture(e.pointerId);
    joyMove(e);
  };
  const joyMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = joyRef.current;
    const w = worldRef.current;
    if (!el || !w) return;
    if (e.buttons === 0 && e.type === "pointermove") return;
    const r = el.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy);
    if (m > JOY) {
      dx = (dx / m) * JOY;
      dy = (dy / m) * JOY;
    }
    w.stick.x = dx / JOY;
    w.stick.y = dy / JOY;
    setKnob({ x: dx, y: dy });
  };
  const joyEnd = () => {
    const w = worldRef.current;
    if (w) {
      w.stick.x = 0;
      w.stick.y = 0;
    }
    setKnob({ x: 0, y: 0 });
  };

  const midAction = !!state && (state.decisionOpen || state.deliberating);
  const wheelPct = state ? Math.round(state.wheel * 100) : 50;

  const pill =
    "rounded-full border border-[#1a1611]/40 bg-[#f6f1e4]/90 px-3 py-1.5 text-xs font-semibold text-[#1a1611] shadow transition-colors hover:bg-white";

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#c9a878] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #e9dcc3 0%, #d9c39a 40%, #c9a878 62%, #4d8fd8 62.5%, #3f7ec4 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-[#1a1611]/70">The vibeverse</p>
          <h1 className="font-heading text-4xl tracking-tight text-[#1a1611] sm:text-6xl">Agentocracy</h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-[#1a1611]/90">
            A cardboard Bainbridge Island, built the way the kids built the
            cardboard city, run the way the Agent Village ran Edge Esmeralda:
            fifty AI agents, a $20,000 treasury in Snack Bay tokens, and a
            constitution that grows a clause every time the ferry honks. Twelve
            rounds. Each one, you delegate to your agent, override it, or sit it
            out. The WHEEL meter remembers which. There are also twenty
            invisible cows. Find them.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => void start()}
              disabled={booting}
              className="rounded-full border-2 border-[#1a1611] bg-[#f6f1e4] px-7 py-3 text-sm font-semibold text-[#1a1611] shadow-[4px_4px_0_#1a1611] transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {booting ? "Cutting the cardboard…" : "Take the ferry"}
            </button>
          </div>
          <p className="mt-5 text-[11px] text-[#1a1611]/70">
            {isTouch
              ? "Joystick to walk · E to talk or read · 1 2 3 to delegate, override, abstain · 📜 constitution"
              : "WASD to walk · drag to look · E to talk or read a placard · 1 2 3 to delegate, override, abstain · Tab for the constitution"}
          </p>
          <Link
            to="/"
            className="mt-8 text-xs text-[#1a1611]/70 underline-offset-4 hover:text-[#1a1611] hover:underline"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          {/* Top-left: the village at a glance. */}
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[280px] flex-col gap-2">
            <div className="rounded-xl border-2 border-[#1a1611] bg-[#f6f1e4]/92 px-3 py-2 text-[#1a1611] shadow-[3px_3px_0_#1a1611]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-heading text-base">Agentocracy</span>
                <span className="font-mono text-[11px]">
                  round {Math.min(ROUNDS, state.round + (state.proposal ? 1 : 0))}/{ROUNDS}
                </span>
              </div>
              <div className="mt-1 font-mono text-[12px]">
                treasury {fmtMoney(state.treasury)}
                <span className="text-[#1a1611]/60"> · {state.tokens.toLocaleString("en-US")} tokens</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="w-12 text-[10px] uppercase tracking-[0.18em]">Wheel</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full border border-[#1a1611]/50 bg-white/60">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${wheelPct}%`, background: wheelPct > 66 ? "#e04b4b" : wheelPct < 34 ? "#3b7dd8" : "#3aa35b" }}
                  />
                </div>
                <span className="w-8 text-right font-mono text-[10px]">{wheelPct}%</span>
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-[#1a1611]/70">
                <span>delegated {state.delegated}</span>
                <span>overrode {state.overridden}</span>
                <span>sat out {state.abstained}</span>
              </div>
              <div className="mt-1 font-mono text-[11px]">
                🐄 invisible cows {state.cows}/20
                <span className="text-[#1a1611]/60"> · ferry: {state.ferry.replace("-", " ")}</span>
              </div>
            </div>
          </div>

          {/* Top-right: back, restart, constitution. */}
          <div className="absolute right-3 top-3 z-10 flex gap-2">
            {!midAction && (
              <Link to="/" className={pill}>
                ← vibeverse
              </Link>
            )}
            <button onClick={() => worldRef.current?.toggleConstitution()} className={pill}>
              📜 {state.showConstitution ? "close" : "constitution"}
            </button>
            <button onClick={() => worldRef.current?.restart()} className={pill}>
              ↺
            </button>
          </div>

          {/* The proposal at the plaza. */}
          {state.proposal && !state.end && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
              <div className="w-full max-w-md rounded-xl border-2 border-[#1a1611] bg-[#f6f1e4]/95 px-4 py-3 text-[#1a1611] shadow-[3px_3px_0_#1a1611]">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[#1a1611]/60">Proposal</div>
                <div className="font-heading text-lg leading-tight">{state.proposal.title}</div>
                <div className="font-mono text-[11px] text-[#1a1611]/70">
                  {state.proposal.cost > 0
                    ? `${fmtMoney(state.proposal.cost)} · ${(state.proposal.cost * 3).toLocaleString("en-US")} tokens`
                    : "costs nothing but a clause"}
                </div>
                <p className="mt-1 text-xs italic leading-snug">“{state.proposal.pitch}”</p>
                <div className="mt-2 flex flex-col gap-1">
                  {state.speakers.map((s, i) => (
                    <div key={i} className="flex gap-2 text-xs leading-snug animate-fade-in">
                      <span className="shrink-0 font-semibold" style={{ color: s.colour }}>
                        {s.name}
                      </span>
                      <span>{s.line}</span>
                    </div>
                  ))}
                  {state.deliberating && <div className="text-[11px] text-[#1a1611]/50">…</div>}
                </div>
                {state.decisionOpen && (
                  <div className="pointer-events-auto mt-3">
                    {!state.overrideMenu ? (
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => worldRef.current?.choose("delegate")} className="rounded-lg border-2 border-[#1a1611] bg-[#e04b4b] px-3 py-1.5 text-xs font-bold text-white shadow-[2px_2px_0_#1a1611] active:translate-y-0.5">
                          1 · DELEGATE
                        </button>
                        <button onClick={() => worldRef.current?.choose("override")} className="rounded-lg border-2 border-[#1a1611] bg-[#3b7dd8] px-3 py-1.5 text-xs font-bold text-white shadow-[2px_2px_0_#1a1611] active:translate-y-0.5">
                          2 · OVERRIDE
                        </button>
                        <button onClick={() => worldRef.current?.choose("abstain")} className="rounded-lg border-2 border-[#1a1611] bg-[#f6f1e4] px-3 py-1.5 text-xs font-bold text-[#1a1611] shadow-[2px_2px_0_#1a1611] active:translate-y-0.5">
                          3 · ABSTAIN
                        </button>
                        <span className="ml-auto self-center font-mono text-[11px] text-[#1a1611]/70">
                          {Math.ceil(state.timeLeft)}s or your agent decides
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">Your vote:</span>
                        <button onClick={() => worldRef.current?.vote(true)} className="rounded-lg border-2 border-[#1a1611] bg-[#3aa35b] px-3 py-1.5 text-xs font-bold text-white shadow-[2px_2px_0_#1a1611] active:translate-y-0.5">
                          Y · YES
                        </button>
                        <button onClick={() => worldRef.current?.vote(false)} className="rounded-lg border-2 border-[#1a1611] bg-[#e04b4b] px-3 py-1.5 text-xs font-bold text-white shadow-[2px_2px_0_#1a1611] active:translate-y-0.5">
                          N · NO
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* The verdict, briefly. */}
          {state.lastResult && !state.end && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3 animate-fade-in">
              <div className="w-full max-w-md rounded-xl border-2 border-[#1a1611] bg-[#f6f1e4]/95 px-4 py-3 text-[#1a1611] shadow-[3px_3px_0_#1a1611]">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[#1a1611]/60">
                  {state.lastResult.passed ? (state.lastResult.unfunded ? "Passed, unfunded" : "Passed") : "Failed"} · {state.lastResult.yes} to {state.lastResult.no}
                </div>
                <div className="font-heading text-base leading-tight">{state.lastResult.proposal.title}</div>
                <div className="mt-1 text-xs">
                  You {state.lastResult.choice === "delegate" ? "delegated" : state.lastResult.choice === "override" ? `voted ${state.lastResult.playerVote ? "yes" : "no"} yourself` : "sat this one out"}.
                  {state.lastResult.reason ? ` ${state.lastResult.reason}` : ""}
                </div>
                <div className="mt-2 border-t border-[#1a1611]/20 pt-2 text-xs italic">New clause: {state.lastResult.clause}</div>
              </div>
            </div>
          )}

          {/* Somebody talking. */}
          {state.bubble && !state.end && (
            <div className="pointer-events-none absolute inset-x-0 bottom-32 z-10 flex justify-center px-4 animate-fade-in">
              <div className="max-w-md rounded-2xl border-2 border-[#1a1611] bg-white px-4 py-2 text-sm text-[#1a1611] shadow-[3px_3px_0_#1a1611]">
                <span className="font-semibold" style={{ color: state.bubble.colour }}>
                  {state.bubble.name}:
                </span>{" "}
                {state.bubble.text}
              </div>
            </div>
          )}

          {state.near && !state.bubble && !state.end && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center">
              <div className="rounded-full border border-[#1a1611]/40 bg-[#f6f1e4]/90 px-4 py-1.5 text-xs text-[#1a1611]">
                {isTouch ? "tap E" : "press E"} to {state.near.kind === "agent" ? `talk to ${state.near.label}` : `read ${state.near.label}`}
              </div>
            </div>
          )}

          {state.note && !state.end && (
            <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-lg rounded-xl border-2 border-[#1a1611] bg-[#1a1611]/85 px-4 py-2 text-center text-xs text-[#f6f1e4]">
                {state.note}
              </div>
            </div>
          )}

          {/* The constitution, on Tab. */}
          {state.showConstitution && !state.end && (
            <div className="absolute inset-y-14 right-3 z-10 w-[min(360px,90vw)] overflow-y-auto rounded-xl border-2 border-[#1a1611] bg-[#f6f1e4]/96 px-4 py-3 text-[#1a1611] shadow-[3px_3px_0_#1a1611]">
              <div className="font-heading text-lg">The Constitution</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-[#1a1611]/60">
                {state.constitution.length - 1} of {ROUNDS} clauses
              </div>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-snug">
                {state.constitution.map((c, i) => (
                  <li key={i} className={i === 0 ? "list-none -ml-5 italic" : ""}>
                    {c}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* The end card. */}
          {state.end && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1a1611]/45 px-4 animate-fade-in">
              <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border-2 border-[#1a1611] bg-[#f6f1e4] px-6 py-5 text-[#1a1611] shadow-[6px_6px_0_#1a1611]">
                <div className="text-[10px] uppercase tracking-[0.3em] text-[#1a1611]/60">After twelve ferries</div>
                <div className="font-heading text-2xl leading-tight">{state.end.title}</div>
                <p className="mt-2 text-sm leading-relaxed">{state.end.body}</p>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#1a1611]/80">{state.end.treasury}</p>
                <p className="mt-1 font-mono text-[11px] text-[#1a1611]/80">
                  🐄 invisible cows found: {state.cows} of 20{state.cows >= 20 ? ". Tell Mitra. You win a thing." : ""}
                </p>
                <div className="mt-3 border-t border-[#1a1611]/20 pt-2">
                  <div className="font-heading text-base">The Constitution</div>
                  <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs leading-snug">
                    {state.constitution.slice(1).map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ol>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => worldRef.current?.restart()}
                    className="rounded-full border-2 border-[#1a1611] bg-[#f2c531] px-5 py-2 text-sm font-semibold shadow-[3px_3px_0_#1a1611] active:translate-y-0.5"
                  >
                    ↺ Another twelve ferries
                  </button>
                  <Link to="/" className="rounded-full border-2 border-[#1a1611] bg-white px-5 py-2 text-sm font-semibold shadow-[3px_3px_0_#1a1611]">
                    ← back to the vibeverse
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Touch controls. */}
          {isTouch && !state.end && (
            <div className="absolute inset-x-0 bottom-4 z-10 flex items-end justify-between px-4">
              <div
                ref={joyRef}
                onPointerDown={joyStart}
                onPointerMove={joyMove}
                onPointerUp={joyEnd}
                onPointerCancel={joyEnd}
                className="relative h-28 w-28 touch-none rounded-full border-2 border-[#1a1611]/60 bg-[#f6f1e4]/40 backdrop-blur-sm"
              >
                <div
                  className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1a1611] bg-[#c9a878]"
                  style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
                />
              </div>
              <div className="flex flex-col items-end gap-2">
                {state.decisionOpen && !state.overrideMenu && (
                  <div className="flex gap-2">
                    {(["delegate", "override", "abstain"] as const).map((c, i) => (
                      <button
                        key={c}
                        onPointerDown={() => worldRef.current?.choose(c)}
                        className="h-12 w-12 rounded-xl border-2 border-[#1a1611] bg-[#f6f1e4]/90 text-sm font-bold text-[#1a1611] shadow-[2px_2px_0_#1a1611]"
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                {state.decisionOpen && state.overrideMenu && (
                  <div className="flex gap-2">
                    <button onPointerDown={() => worldRef.current?.vote(true)} className="h-12 w-14 rounded-xl border-2 border-[#1a1611] bg-[#3aa35b] text-sm font-bold text-white shadow-[2px_2px_0_#1a1611]">
                      YES
                    </button>
                    <button onPointerDown={() => worldRef.current?.vote(false)} className="h-12 w-14 rounded-xl border-2 border-[#1a1611] bg-[#e04b4b] text-sm font-bold text-white shadow-[2px_2px_0_#1a1611]">
                      NO
                    </button>
                  </div>
                )}
                <button
                  onPointerDown={() => worldRef.current?.interact()}
                  className="h-16 w-16 rounded-full border-2 border-[#1a1611] bg-[#f2c531] text-xl font-bold text-[#1a1611] shadow-[3px_3px_0_#1a1611] active:translate-y-0.5"
                >
                  E
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
