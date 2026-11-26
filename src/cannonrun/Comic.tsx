/**
 * The comic before a run: how Mort lost his grandpa's cannon. Four panels drawn
 * in SVG, filling in one at a time. A click, a tap, Space or Enter turns the
 * page; Skip (or Escape) goes straight to the road.
 */
import { useCallback, useEffect, useState } from "react";

const INK = "#0b0b10";
const SKIN = "#e07a5a";
const CAP = "#2b5a2a";
const DENIM = "#35507a";

/** Mort's head, centred on (0, 0), about 100 units across. */
function MortHead({ mood }: { mood: "asleep" | "waking" | "furious" | "yell" }) {
  const shut = mood === "asleep";
  const brow = mood === "asleep" ? 0 : mood === "waking" ? 8 : 22;
  return (
    <g stroke={INK} strokeWidth={4} strokeLinejoin="round">
      <ellipse cx={-50} cy={6} rx={10} ry={14} fill={SKIN} />
      <ellipse cx={50} cy={6} rx={10} ry={14} fill={SKIN} />
      <circle r={50} fill={SKIN} />
      {/* stubble */}
      <path d="M-42 18 Q0 64 42 18 Q36 50 0 52 Q-36 50 -42 18Z" fill="#7a4a36" stroke="none" opacity={0.55} />
      {/* cap */}
      <path d="M-50 -10 Q-48 -58 0 -60 Q48 -58 50 -10Z" fill={CAP} />
      <path d="M-20 -14 L72 -14 Q78 -6 70 -2 L-20 -4Z" fill={CAP} />
      {/* eyes */}
      {shut ? (
        <>
          <path d="M-30 4 Q-20 10 -10 4" fill="none" />
          <path d="M10 4 Q20 10 30 4" fill="none" />
        </>
      ) : (
        <>
          <circle cx={-20} cy={4} r={mood === "waking" ? 9 : 11} fill="#fff" />
          <circle cx={20} cy={4} r={mood === "waking" ? 9 : 11} fill="#fff" />
          <circle cx={-18} cy={6} r={4.5} fill={INK} stroke="none" />
          <circle cx={22} cy={6} r={4.5} fill={INK} stroke="none" />
        </>
      )}
      {/* brows down at the middle */}
      <path d={`M-36 ${-16 - brow * 0.3} L-6 ${-12 + brow * 0.4}`} strokeWidth={7} strokeLinecap="round" />
      <path d={`M36 ${-16 - brow * 0.3} L6 ${-12 + brow * 0.4}`} strokeWidth={7} strokeLinecap="round" />
      <circle cx={0} cy={18} r={10} fill="#d0664a" />
      {mood === "yell" || mood === "furious" ? (
        <path d="M-20 32 Q0 22 20 32 L16 44 Q0 52 -16 44Z" fill="#5a0e0e" />
      ) : mood === "waking" ? (
        <circle cx={0} cy={36} r={5} fill="#5a0e0e" />
      ) : (
        <path d="M-12 34 Q0 40 12 34" fill="none" />
      )}
      {mood === "yell" || mood === "furious" ? <path d="M-14 33 L14 33" stroke="#fff" strokeWidth={4} /> : null}
    </g>
  );
}

function Caption({ x, y, w, text }: { x: number; y: number; w: number; text: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={34} fill="#ffe27a" stroke={INK} strokeWidth={4} />
      <text x={x + 12} y={y + 23} fontSize={17} fontWeight={900} fill={INK} style={{ letterSpacing: 1 }}>{text}</text>
    </g>
  );
}

function Bubble({ x, y, w, h, tx, ty, lines, size = 22 }: { x: number; y: number; w: number; h: number; tx: number; ty: number; lines: string[]; size?: number }) {
  const cx = x + w / 2;
  return (
    <g>
      <path d={`M${cx - 18} ${y + h - 4} L${tx} ${ty} L${cx + 14} ${y + h - 4}Z`} fill="#fff" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <ellipse cx={cx} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="#fff" stroke={INK} strokeWidth={4} />
      <path d={`M${cx - 16} ${y + h - 6} L${cx + 12} ${y + h - 6}`} stroke="#fff" strokeWidth={6} />
      {lines.map((l, i) => (
        <text key={i} x={cx} y={y + h / 2 + (i - (lines.length - 1) / 2) * (size + 3) + size * 0.36} fontSize={size} fontWeight={900} fill={INK} textAnchor="middle">{l}</text>
      ))}
    </g>
  );
}

function Burst({ x, y, r, text, fill = "#ff4a2a", size = 34, rot = -8 }: { x: number; y: number; r: number; text: string; fill?: string; size?: number; rot?: number }) {
  const pts: string[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rr = i % 2 ? r * 0.68 : r;
    pts.push(`${x + Math.cos(a) * rr * 1.35},${y + Math.sin(a) * rr}`);
  }
  return (
    <g transform={`rotate(${rot} ${x} ${y})`}>
      <polygon points={pts.join(" ")} fill="#ffe27a" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <text x={x} y={y + size * 0.36} fontSize={size} fontWeight={900} fill={fill} stroke={INK} strokeWidth={1.5} textAnchor="middle">{text}</text>
    </g>
  );
}

/** A halftone dot screen, the cheap comic look. */
function Dots({ id, color }: { id: string; color: string }) {
  return (
    <pattern id={id} width={10} height={10} patternUnits="userSpaceOnUse">
      <circle cx={5} cy={5} r={2.2} fill={color} />
    </pattern>
  );
}

/* ---------------------------------------------------------------- panels */

function PanelGarage() {
  return (
    <svg viewBox="0 0 400 300">
      <defs><Dots id="d1" color="#26315a" /></defs>
      <rect width={400} height={300} fill="#141a33" />
      <rect width={400} height={300} fill="url(#d1)" />
      {/* the bulb and its light */}
      <path d="M200 20 L80 300 L330 300Z" fill="#ffe9a8" opacity={0.18} />
      <line x1={200} y1={0} x2={200} y2={24} stroke={INK} strokeWidth={4} />
      <circle cx={200} cy={30} r={9} fill="#fff6c8" stroke={INK} strokeWidth={3} />
      {/* the cannon under its tarp */}
      <path d="M210 250 Q220 186 300 182 Q370 180 384 236 L388 262 L206 262Z" fill="#6b7a3a" stroke={INK} strokeWidth={4} />
      <path d="M232 214 Q262 200 300 204 M330 196 Q352 214 360 240" stroke={INK} strokeWidth={3} fill="none" />
      <rect x={232} y={232} width={112} height={22} fill="#fff" stroke={INK} strokeWidth={3} transform="rotate(-4 288 243)" />
      <text x={288} y={248} fontSize={10.5} fontWeight={900} textAnchor="middle" fill={INK} transform="rotate(-4 288 243)">GRANDPA'S. DON'T TOUCH.</text>
      {/* Mort, asleep in his chair */}
      <rect x={40} y={170} width={130} height={92} rx={14} fill="#7a3424" stroke={INK} strokeWidth={4} />
      <rect x={60} y={160} width={90} height={70} rx={10} fill={DENIM} stroke={INK} strokeWidth={4} />
      <g transform="translate(105 128) scale(0.62) rotate(-12)"><MortHead mood="asleep" /></g>
      <rect y={262} width={400} height={38} fill="#2a2228" stroke={INK} strokeWidth={4} />
      <text x={150} y={92} fontSize={30} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={1.5}>Z</text>
      <text x={172} y={70} fontSize={22} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={1.2}>z</text>
      <text x={188} y={54} fontSize={16} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={1}>z</text>
      <Caption x={10} y={10} w={250} text="MIDNIGHT. MORT'S GARAGE." />
    </svg>
  );
}

function PanelTheft() {
  return (
    <svg viewBox="0 0 400 300">
      <defs><Dots id="d2" color="#1c2448" /></defs>
      <rect width={400} height={300} fill="#0c1024" />
      <rect width={400} height={300} fill="url(#d2)" />
      {/* the open garage door, the desert night outside */}
      <rect x={60} y={40} width={280} height={220} fill="#22305e" stroke={INK} strokeWidth={5} />
      <circle cx={290} cy={86} r={22} fill="#f4f1e4" />
      {[[90, 70], [140, 100], [200, 60], [250, 120], [320, 140]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={2} fill="#fff" />)}
      <path d="M60 210 L120 186 L180 200 L250 178 L340 196 L340 260 L60 260Z" fill="#1a1420" />
      {/* a pickup driving off with the cannon in the bed */}
      <g transform="translate(150 186)">
        <rect x={0} y={20} width={120} height={36} rx={6} fill="#8fbce0" stroke={INK} strokeWidth={4} />
        <rect x={70} y={0} width={46} height={26} rx={5} fill="#8fbce0" stroke={INK} strokeWidth={4} />
        <rect x={6} y={26} width={14} height={9} fill="#ff2a1a" stroke={INK} strokeWidth={2} />
        <rect x={100} y={26} width={14} height={9} fill="#ff2a1a" stroke={INK} strokeWidth={2} />
        <path d="M30 22 L-34 2" stroke={INK} strokeWidth={16} strokeLinecap="round" />
        <path d="M30 22 L-34 2" stroke="#3a3a42" strokeWidth={10} strokeLinecap="round" />
        <circle cx={-36} cy={1} r={9} fill="#c8963a" stroke={INK} strokeWidth={3} />
        <circle cx={22} cy={58} r={13} fill="#222" stroke={INK} strokeWidth={4} />
        <circle cx={98} cy={58} r={13} fill="#222" stroke={INK} strokeWidth={4} />
      </g>
      {[0, 1, 2].map((i) => <path key={i} d={`M${280 + i * 12} ${222 + i * 8} L${330 + i * 14} ${222 + i * 8}`} stroke="#fff" strokeWidth={3} opacity={0.7} />)}
      <Burst x={110} y={110} r={52} text="CLUNK!" size={30} rot={-12} />
      <Burst x={300} y={262} r={40} text="VROOOM!" fill="#ffb02a" size={22} rot={6} />
      <Caption x={10} y={10} w={190} text="THEN, A NOISE." />
    </svg>
  );
}

function PanelGone() {
  return (
    <svg viewBox="0 0 400 300">
      <defs>
        <radialGradient id="g3" cx="50%" cy="55%" r="60%"><stop offset="0%" stopColor="#ff6a3a" /><stop offset="100%" stopColor="#7a0e10" /></radialGradient>
        <Dots id="d3" color="#a01a12" />
      </defs>
      <rect width={400} height={300} fill="url(#g3)" />
      <rect width={400} height={300} fill="url(#d3)" opacity={0.6} />
      {/* speed lines out from his head */}
      {Array.from({ length: 22 }, (_, i) => {
        const a = (i / 22) * Math.PI * 2;
        return <line key={i} x1={200 + Math.cos(a) * 110} y1={170 + Math.sin(a) * 110} x2={200 + Math.cos(a) * 320} y2={170 + Math.sin(a) * 320} stroke="#ffd0a0" strokeWidth={5} opacity={0.5} />;
      })}
      {/* the empty tarp on the floor */}
      <path d="M40 300 Q60 262 130 268 Q190 274 200 300Z" fill="#6b7a3a" stroke={INK} strokeWidth={4} />
      <g transform="translate(212 178) scale(1.35)"><MortHead mood="furious" /></g>
      {/* his fists either side */}
      <circle cx={90} cy={210} r={26} fill={SKIN} stroke={INK} strokeWidth={4} />
      <circle cx={334} cy={210} r={26} fill={SKIN} stroke={INK} strokeWidth={4} />
      <Bubble x={14} y={14} w={250} h={86} tx={150} ty={120} lines={["GRANDPA'S CANNON...", "GONE?!"]} size={24} />
    </svg>
  );
}

function PanelRevenge() {
  return (
    <svg viewBox="0 0 400 300">
      <defs><Dots id="d4" color="#2a1a10" /></defs>
      <rect width={400} height={300} fill="#120c14" />
      <rect width={400} height={300} fill="url(#d4)" opacity={0.6} />
      {/* headlights blazing straight at you */}
      <path d="M150 200 L-40 300 L60 300Z" fill="#fff4c8" opacity={0.25} />
      <path d="M250 200 L440 300 L340 300Z" fill="#fff4c8" opacity={0.25} />
      {/* his station wagon, nose on */}
      <path d="M86 150 L120 96 L280 96 L314 150Z" fill="#8a5a2b" stroke={INK} strokeWidth={5} strokeLinejoin="round" />
      <path d="M128 104 L272 104 L296 146 L104 146Z" fill="#1a2630" stroke={INK} strokeWidth={3} />
      <rect x={70} y={146} width={260} height={70} rx={10} fill="#8a5a2b" stroke={INK} strokeWidth={5} />
      <rect x={150} y={176} width={100} height={26} fill="#c9ccd2" stroke={INK} strokeWidth={3} />
      {[160, 176, 192, 208, 224, 240].map((x) => <line key={x} x1={x} y1={178} x2={x} y2={200} stroke={INK} strokeWidth={2} />)}
      <circle cx={110} cy={180} r={22} fill="#fff8d8" stroke={INK} strokeWidth={4} />
      <circle cx={290} cy={180} r={22} fill="#fff8d8" stroke={INK} strokeWidth={4} />
      <circle cx={110} cy={180} r={36} fill="#fff8d8" opacity={0.35} />
      <circle cx={290} cy={180} r={36} fill="#fff8d8" opacity={0.35} />
      <rect x={60} y={214} width={280} height={14} rx={4} fill="#c9ccd2" stroke={INK} strokeWidth={3} />
      {/* Mort behind the wheel, fist out of the window */}
      <g transform="translate(230 128) scale(0.42)"><MortHead mood="yell" /></g>
      <path d="M296 120 L344 70" stroke={SKIN} strokeWidth={16} strokeLinecap="round" />
      <circle cx={348} cy={64} r={14} fill={SKIN} stroke={INK} strokeWidth={4} />
      <Bubble x={8} y={8} w={270} h={74} tx={210} ty={110} lines={["NOBODY STEALS", "FROM MORT!"]} size={23} />
      <Caption x={190} y={258} w={200} text="AND SO IT BEGINS..." />
    </svg>
  );
}

const PANELS = [PanelGarage, PanelTheft, PanelGone, PanelRevenge];
const BEAT = 3200;

export function Comic({ onDone, phone }: { onDone: () => void; phone: boolean }) {
  const [shown, setShown] = useState(1);
  const all = shown >= PANELS.length;
  const next = useCallback(() => setShown((n) => (n >= PANELS.length ? n : n + 1)), []);

  useEffect(() => {
    if (all) return;
    const t = window.setTimeout(next, BEAT);
    return () => window.clearTimeout(t);
  }, [shown, all, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDone();
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (all) onDone(); else next(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, next, onDone]);

  // On a phone, one panel at a time; on a big screen, the page fills in.
  const at = phone ? shown - 1 : 0;
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden bg-[#0a0a12] px-4 py-6"
      onClick={() => (all ? onDone() : next())}
      data-comic={shown}
    >
      <button
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 px-4 py-1.5 text-[13px] font-semibold text-white ring-1 ring-white/20"
        style={{ top: "max(env(safe-area-inset-top), 16px)" }}
        onClick={(e) => { e.stopPropagation(); onDone(); }}
      >
        Skip ⏭
      </button>
      <div className={`grid w-full gap-3 ${phone ? "max-w-[440px] grid-cols-1" : "max-w-[960px] grid-cols-2"}`}>
        {PANELS.map((P, i) => {
          const on = phone ? i === at : i < shown;
          if (phone && !on) return null;
          return (
            <div
              key={i}
              className="overflow-hidden rounded-[4px] bg-white p-[5px] shadow-[6px_6px_0_rgba(0,0,0,0.6)]"
              style={{
                opacity: on ? 1 : 0.06,
                transform: on ? `rotate(${[-1.2, 0.9, 0.6, -0.8][i]}deg)` : "scale(0.96)",
                transition: "opacity .35s, transform .35s",
              }}
            >
              <div className="ring-[3px] ring-black" style={{ fontFamily: "'Bangers', Impact, 'Arial Black', system-ui, sans-serif" }}>
                <P />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-5 h-10">
        {all ? (
          <button
            className="rounded-full bg-[#ffd36a] px-7 py-2.5 text-[15px] font-bold text-black shadow-lg"
            onClick={(e) => { e.stopPropagation(); onDone(); }}
          >
            Light the fuse 💣
          </button>
        ) : (
          <div className="text-[12px] text-white/40">Tap to turn the page</div>
        )}
      </div>
    </div>
  );
}
