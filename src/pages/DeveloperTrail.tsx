/**
 * DEVELOPER TRAIL — Oregon Trail, but the wagon is a nine-lot cottage project.
 *
 * Drawn in the DOM, in two inks on paper, because the thing it comes from is
 * a thirty-page case study and a game about it should look like it was
 * printed on a risograph. The lots are a canvas; everything else is text.
 * The rules live in `src/devtrail/game.ts` and know nothing about React.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  MONTHS,
  PHASES,
  PHASE_BLURB,
  TOWNS,
  TOWN_BLURB,
  TYPES,
  TYPE_BLURB,
  newGame,
  overallProgress,
  step,
  type DevState,
  type DeveloperType,
  type Pace,
  type Town,
} from "@/devtrail/game";

const PAPER = "#f3ecdc";
const INK = "#1d3557";
const RED = "#d9442f";

/** Nine lots, isometric, in two inks. */
function LotsCanvas({ state }: { state: DevState }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 420;
    const H = 250;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const tile = 44;
    const ox = W / 2;
    const oy = 58;
    const iso = (gx: number, gy: number, z = 0) => ({
      x: ox + (gx - gy) * tile,
      y: oy + (gx + gy) * tile * 0.5 - z,
    });
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";

    // A road along the front.
    ctx.strokeStyle = INK;
    ctx.setLineDash([3, 3]);
    const r0 = iso(-0.4, 3.2);
    const r1 = iso(3.2, 3.2);
    ctx.beginPath();
    ctx.moveTo(r0.x, r0.y);
    ctx.lineTo(r1.x, r1.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const i = gy * 3 + gx;
        const stage = state.lots[i];
        const a = iso(gx, gy);
        const b = iso(gx + 1, gy);
        const c = iso(gx + 1, gy + 1);
        const d = iso(gx, gy + 1);
        // The lot itself.
        ctx.fillStyle = stage === 0 ? "rgba(29,53,87,0.06)" : "rgba(29,53,87,0.12)";
        ctx.strokeStyle = INK;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Number.
        ctx.fillStyle = INK;
        ctx.font = "9px ui-monospace, monospace";
        const centre = iso(gx + 0.5, gy + 0.5);
        if (stage === 0) ctx.fillText(String(i + 1), centre.x - 3, centre.y + 3);

        if (stage >= 1) {
          // Foundation: an inset slab.
          const m = 0.18;
          const p1 = iso(gx + m, gy + m, 3);
          const p2 = iso(gx + 1 - m, gy + m, 3);
          const p3 = iso(gx + 1 - m, gy + 1 - m, 3);
          const p4 = iso(gx + m, gy + 1 - m, 3);
          ctx.fillStyle = stage >= 3 ? RED : "rgba(217,68,47,0.35)";
          ctx.strokeStyle = stage >= 3 ? RED : INK;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.lineTo(p3.x, p3.y);
          ctx.lineTo(p4.x, p4.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        if (stage >= 2) {
          // Walls: a box, drawn as three visible faces.
          const m = 0.18;
          const h = 22;
          const b1 = iso(gx + m, gy + m, 3);
          const b2 = iso(gx + 1 - m, gy + m, 3);
          const b3 = iso(gx + 1 - m, gy + 1 - m, 3);
          const b4 = iso(gx + m, gy + 1 - m, 3);
          const t1 = iso(gx + m, gy + m, 3 + h);
          const t2 = iso(gx + 1 - m, gy + m, 3 + h);
          const t3 = iso(gx + 1 - m, gy + 1 - m, 3 + h);
          const t4 = iso(gx + m, gy + 1 - m, 3 + h);
          const framed = stage === 2;
          ctx.strokeStyle = framed ? RED : INK;
          ctx.fillStyle = framed ? "rgba(255,255,255,0)" : "rgba(243,236,220,1)";
          // right face
          ctx.beginPath();
          ctx.moveTo(b2.x, b2.y);
          ctx.lineTo(b3.x, b3.y);
          ctx.lineTo(t3.x, t3.y);
          ctx.lineTo(t2.x, t2.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          // left face
          ctx.beginPath();
          ctx.moveTo(b4.x, b4.y);
          ctx.lineTo(b3.x, b3.y);
          ctx.lineTo(t3.x, t3.y);
          ctx.lineTo(t4.x, t4.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          if (framed) {
            // Studs.
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(b1.x, b1.y);
            ctx.lineTo(t1.x, t1.y);
            ctx.moveTo(b2.x, b2.y);
            ctx.lineTo(t2.x, t2.y);
            ctx.moveTo(b4.x, b4.y);
            ctx.lineTo(t4.x, t4.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          // Roof: a gable.
          const ridge1 = iso(gx + 0.5, gy + m, 3 + h + 12);
          const ridge2 = iso(gx + 0.5, gy + 1 - m, 3 + h + 12);
          ctx.fillStyle = stage >= 3 ? RED : "rgba(255,255,255,0)";
          ctx.strokeStyle = stage >= 3 ? INK : RED;
          ctx.beginPath();
          ctx.moveTo(t1.x, t1.y);
          ctx.lineTo(ridge1.x, ridge1.y);
          ctx.lineTo(ridge2.x, ridge2.y);
          ctx.lineTo(t4.x, t4.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(t2.x, t2.y);
          ctx.lineTo(ridge1.x, ridge1.y);
          ctx.lineTo(ridge2.x, ridge2.y);
          ctx.lineTo(t3.x, t3.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          if (stage === 4) {
            // Sold: a little flag.
            ctx.fillStyle = INK;
            ctx.beginPath();
            ctx.moveTo(ridge2.x, ridge2.y);
            ctx.lineTo(ridge2.x, ridge2.y - 14);
            ctx.lineTo(ridge2.x + 9, ridge2.y - 11);
            ctx.lineTo(ridge2.x, ridge2.y - 8);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
    }
    // A tree, because there is always one tree they make you keep.
    const t = iso(3.3, 0.4);
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(t.x, t.y - 22);
    ctx.stroke();
    ctx.fillStyle = "rgba(29,53,87,0.25)";
    ctx.beginPath();
    ctx.arc(t.x, t.y - 30, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }, [state]);
  return <canvas ref={ref} style={{ width: 420, height: 250, maxWidth: "100%" }} />;
}

export default function DeveloperTrail() {
  useWorldStamp("/developer-trail", "Developer Trail");

  const [type, setType] = useState<DeveloperType>("Emerging");
  const [town, setTown] = useState<Town>("Healdsburg");
  const [state, setState] = useState<DevState | null>(null);
  const [pace, setPace] = useState<Pace>("steady");
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  const begin = useCallback(() => setState(newGame(type, town)), [type, town]);

  useEffect(() => {
    if (shotMode) {
      let s = newGame("Developing", "Healdsburg", 42);
      for (let i = 0; i < 24; i++) s = step(s, "steady");
      setState(s);
    }
  }, [shotMode]);

  const advance = useCallback(() => {
    setState((s) => (s ? step(s, pace) : s));
  }, [pace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state || state.over) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        advance();
      }
      if (e.code === "Digit1") setPace("careful");
      if (e.code === "Digit2") setPace("steady");
      if (e.code === "Digit3") setPace("push");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, state]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state?.log.length]);

  const recentLog = useMemo(() => (state ? state.log.slice(-6) : []), [state]);

  const meter = (label: string, value: number, colour: string) => (
    <div className="flex items-center gap-2">
      <span className="w-20 text-[10px] uppercase tracking-[0.2em]" style={{ color: INK }}>
        {label}
      </span>
      <div className="h-2 w-32 border" style={{ borderColor: INK }}>
        <div className="h-full" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: colour }} />
      </div>
      <span className="font-mono text-[11px]" style={{ color: INK }}>
        {Math.round(value)}
      </span>
    </div>
  );

  const money = (n: number) =>
    `${n < 0 ? "-" : ""}$${Math.abs(n) >= 1000000 ? `${(Math.abs(n) / 1000000).toFixed(2)}M` : `${(Math.abs(n) / 1000).toFixed(0)}k`}`;

  return (
    <div
      className="fixed inset-0 overflow-auto select-none"
      style={{
        background: PAPER,
        color: INK,
        backgroundImage:
          "radial-gradient(rgba(29,53,87,0.08) 0.6px, transparent 0.6px)",
        backgroundSize: "4px 4px",
        fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      }}
    >
      <div className="mx-auto max-w-3xl px-5 pb-16 pt-16">
        {!state ? (
          <div>
            <p className="text-[11px] uppercase tracking-[0.42em]" style={{ color: RED }}>
              The vibeverse · a game from a case study
            </p>
            <h1 className="mt-2 text-5xl tracking-tight sm:text-6xl" style={{ fontFamily: "inherit" }}>
              Developer Trail
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed">
              Nine lots. Thirty-six months. A plan, some money, and a town that has
              not decided about you. Walk the Path to Capital — foundation, gap
              analysis, package, underwrite, raise — then entitle it, build it and
              sell it before the option on the land runs out. Every month you pick a
              pace, and every month something happens. Hidden caverns, neighbours
              with lawyers, an airship overhead. You know how this genre ends.
            </p>

            <h2 className="mt-8 text-[11px] uppercase tracking-[0.3em]" style={{ color: RED }}>
              Who are you
            </h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className="border px-3 py-2 text-left transition-colors"
                  style={{
                    borderColor: INK,
                    background: type === t ? INK : "transparent",
                    color: type === t ? PAPER : INK,
                  }}
                >
                  <div className="text-sm font-semibold">{t}</div>
                  <div className="text-xs leading-snug opacity-80">{TYPE_BLURB(t)}</div>
                </button>
              ))}
            </div>

            <h2 className="mt-6 text-[11px] uppercase tracking-[0.3em]" style={{ color: RED }}>
              Where
            </h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {TOWNS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTown(t)}
                  className="border px-3 py-2 text-left transition-colors"
                  style={{
                    borderColor: INK,
                    background: town === t ? RED : "transparent",
                    color: town === t ? PAPER : INK,
                  }}
                >
                  <div className="text-sm font-semibold">{t}</div>
                  <div className="text-xs leading-snug opacity-80">{TOWN_BLURB(t)}</div>
                </button>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <button
                onClick={begin}
                className="px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em]"
                style={{ background: RED, color: PAPER }}
              >
                Break ground
              </button>
              <Link to="/" className="text-xs underline-offset-4 hover:underline">
                ← back to the vibeverse
              </Link>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.42em]" style={{ color: RED }}>
                  Developer Trail · {state.type} · {state.town}
                </p>
                <h1 className="mt-1 text-3xl tracking-tight">
                  Month {state.month} <span className="text-base opacity-60">of {MONTHS}</span>
                </h1>
              </div>
              <div className="text-right">
                <div className="font-mono text-2xl" style={{ color: state.cash < 0 ? RED : INK }}>
                  {money(state.cash)}
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">
                  cash · {state.investors} investors
                </div>
              </div>
            </div>

            {/* The road. */}
            <div className="mt-4 flex items-center gap-1">
              {PHASES.map((p, i) => (
                <div key={p} className="flex-1">
                  <div
                    className="h-2 border"
                    style={{
                      borderColor: INK,
                      background:
                        i < state.phase
                          ? INK
                          : i === state.phase
                            ? `linear-gradient(90deg, ${RED} ${Math.round(overallProgress(state) * 7 * 100 - i * 100)}%, transparent 0)`
                            : "transparent",
                    }}
                  />
                  <div
                    className="mt-1 hidden text-[9px] uppercase tracking-wider sm:block"
                    style={{ color: i === state.phase ? RED : INK, opacity: i === state.phase ? 1 : 0.6 }}
                  >
                    {p}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-sm">
              <span className="font-semibold" style={{ color: RED }}>
                {PHASES[state.phase]}.
              </span>{" "}
              {PHASE_BLURB[PHASES[state.phase]]}
            </p>

            <div className="mt-5 grid gap-6 sm:grid-cols-[1fr_auto]">
              <div>
                <div className="border p-3" style={{ borderColor: INK, background: "rgba(255,255,255,0.35)" }}>
                  <LotsCanvas state={state} />
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  {meter("Energy", state.energy, state.energy < 30 ? RED : INK)}
                  {meter("Goodwill", state.goodwill, state.goodwill < 30 ? RED : INK)}
                  {meter("Phase", PHASES[state.phase] === "Build" ? (state.lots.filter((l) => l >= 3).length / 9) * 100 : PHASES[state.phase] === "Sell" ? (state.lots.filter((l) => l === 4).length / 9) * 100 : state.progress, RED)}
                </div>
              </div>

              <div className="w-full sm:w-64">
                {state.card && (
                  <div
                    className="border-2 p-3"
                    style={{ borderColor: RED, background: "rgba(255,255,255,0.5)", transform: "rotate(-1deg)" }}
                  >
                    <div className="text-2xl">{state.card.emoji}</div>
                    <div className="mt-1 text-sm font-semibold" style={{ color: RED }}>
                      {state.card.title}
                    </div>
                    <div className="mt-1 text-xs leading-snug">{state.card.text}</div>
                    <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px]">
                      {state.card.cash ? <span>{state.card.cash > 0 ? "+" : ""}{money(state.card.cash)}</span> : null}
                      {state.card.energy ? <span>energy {state.card.energy > 0 ? "+" : ""}{state.card.energy}</span> : null}
                      {state.card.goodwill ? <span>goodwill {state.card.goodwill > 0 ? "+" : ""}{state.card.goodwill}</span> : null}
                      {state.card.delay ? <span>+{state.card.delay} mo</span> : null}
                      {state.card.progress ? <span>progress {state.card.progress > 0 ? "+" : ""}{state.card.progress}</span> : null}
                    </div>
                  </div>
                )}
                {!state.card && (
                  <div className="border p-3 text-xs italic opacity-70" style={{ borderColor: INK }}>
                    A quiet month. They happen.
                  </div>
                )}

                {!state.over && (
                  <div className="mt-4">
                    <div className="text-[10px] uppercase tracking-[0.3em]" style={{ color: RED }}>
                      This month's pace
                    </div>
                    <div className="mt-1 grid grid-cols-3 gap-1">
                      {(["careful", "steady", "push"] as Pace[]).map((p, i) => (
                        <button
                          key={p}
                          onClick={() => setPace(p)}
                          className="border px-2 py-1.5 text-xs capitalize"
                          style={{
                            borderColor: INK,
                            background: pace === p ? INK : "transparent",
                            color: pace === p ? PAPER : INK,
                          }}
                        >
                          {i + 1} {p}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug opacity-80">
                      {pace === "careful"
                        ? "Slow. Rests you, keeps the neighbours sweet, moves little."
                        : pace === "steady"
                          ? "A month of honest work."
                          : "Everything at once. Fast, expensive in energy, and the town notices."}
                    </p>
                    <button
                      onClick={advance}
                      className="mt-3 w-full px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em]"
                      style={{ background: RED, color: PAPER }}
                    >
                      Next month ⏎
                    </button>
                  </div>
                )}

                {state.over && (
                  <div className="mt-4 border-2 p-3" style={{ borderColor: INK, background: state.over.won ? INK : RED, color: PAPER }}>
                    <div className="text-lg font-semibold">{state.over.title}</div>
                    <div className="mt-1 text-xs leading-snug">{state.over.text}</div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => setState(null)}
                        className="border px-3 py-1.5 text-xs uppercase tracking-wider"
                        style={{ borderColor: PAPER }}
                      >
                        Again
                      </button>
                      <Link to="/" className="border px-3 py-1.5 text-xs uppercase tracking-wider" style={{ borderColor: PAPER }}>
                        Home
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6">
              <button
                onClick={() => setShowLog((v) => !v)}
                className="text-[10px] uppercase tracking-[0.3em] underline-offset-4 hover:underline"
                style={{ color: RED }}
              >
                The ledger {showLog ? "▴" : "▾"}
              </button>
              <div
                ref={logRef}
                className="mt-1 max-h-48 overflow-auto border-t pt-2 text-xs leading-relaxed"
                style={{ borderColor: INK }}
              >
                {(showLog ? state.log : recentLog).map((l, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="w-8 shrink-0 font-mono opacity-60">m{l.month}</span>
                    <span style={{ color: l.kind === "end" ? RED : l.kind === "sell" || l.kind === "money" ? INK : undefined, fontWeight: l.kind === "phase" || l.kind === "end" ? 600 : 400 }}>
                      {l.kind === "card" ? l.text.split("|")[1] : l.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 flex gap-4 text-xs">
              <button onClick={() => setState(null)} className="underline-offset-4 hover:underline">
                ↺ start over
              </button>
              <Link to="/" className="underline-offset-4 hover:underline">
                ← back to the vibeverse
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
