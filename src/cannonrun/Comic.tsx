/**
 * The comic before a run: how Mort lost his grandpa's cannon and called his
 * cousin Linda. Five panels rendered in 3D from the game's own models
 * (comicScenes.ts), lettered in SVG, filling in one at a time. A click, a tap, Space or Enter turns the
 * page; Skip (or Escape) goes straight to the road.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const INK = "#0b0b10";




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
  // the tail leaves from whichever edge faces the speaker
  const ay = ty < y ? y + 4 : y + h - 4;
  const iy = ty < y ? y + 6 : y + h - 6;
  return (
    <g>
      <path d={`M${cx - 18} ${ay} L${tx} ${ty} L${cx + 14} ${ay}Z`} fill="#fff" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <ellipse cx={cx} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="#fff" stroke={INK} strokeWidth={4} />
      <path d={`M${cx - 16} ${iy} L${cx + 12} ${iy}`} stroke="#fff" strokeWidth={6} />
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

/* ---------------------------------------------------------------- lettering over the 3D panels (800 x 600) */

const LETTERING: (() => JSX.Element)[] = [
  () => (
    <>
      <Caption x={16} y={16} w={430} text="MIDNIGHT. MORT'S GARAGE." />
      <text x={250} y={250} fontSize={56} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={3}>Z</text>
      <text x={292} y={208} fontSize={40} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={2.5}>z</text>
      <text x={322} y={176} fontSize={28} fontWeight={900} fill="#fff" stroke={INK} strokeWidth={2}>z</text>
      <Caption x={420} y={540} w={364} text="GRANDPA'S CANNON. SAFE." />
    </>
  ),
  () => (
    <>
      <Caption x={16} y={16} w={300} text="THEN, A NOISE." />
      <Burst x={590} y={470} r={74} text="VROOOM!" fill="#ffb02a" size={46} rot={6} />
      <Bubble x={16} y={70} w={420} h={140} tx={170} ty={300} lines={["HEY!!", "THAT'S MY CANNON!"]} size={34} />
    </>
  ),
  () => (
    <>
      <Bubble x={16} y={14} w={560} h={160} tx={330} ty={260} lines={["GRANDPA'S CANNON...", "GONE?!"]} size={40} />
    </>
  ),
  () => (
    <>
      <Burst x={400} y={70} r={52} text="RING!" size={38} rot={-6} />
      <Bubble x={8} y={440} w={380} h={140} tx={190} ty={330} lines={["LINDA! THEY TOOK", "GRANDPA'S CANNON!"]} size={28} />
      <Bubble x={414} y={440} w={380} h={140} tx={600} ty={330} lines={["I'M ON MY WAY,", "COUSIN!!"]} size={32} />
      <line x1={400} y1={0} x2={400} y2={600} stroke={INK} strokeWidth={10} />
    </>
  ),
  () => (
    <>
      <Burst x={630} y={110} r={70} text="SKREEECH!" size={34} rot={8} />
      <Bubble x={16} y={16} w={440} h={130} tx={260} ty={250} lines={["NOBODY STEALS", "FROM US!"]} size={36} />
      <Caption x={420} y={540} w={364} text="AND SO THE CHASE BEGINS..." />
    </>
  ),
  () => (
    <>
      <Bubble x={16} y={16} w={460} h={130} tx={330} ty={260} lines={["NOBODY STEALS", "FROM MORT!"]} size={38} />
      <Caption x={420} y={540} w={364} text="AND SO THE CHASE BEGINS..." />
    </>
  ),
];
const STORY_PANELS = { solo: [0, 1, 2, 5], duo: [0, 1, 2, 3, 4] };

const BEAT = 3400;

export function Comic({ onDone, phone, two = false }: { onDone: () => void; phone: boolean; two?: boolean }) {
  const order = two ? STORY_PANELS.duo : STORY_PANELS.solo;
  const [shots, setShots] = useState<string[] | null>(null);
  const [shown, setShown] = useState(1);
  const count = order.length;
  const all = shown >= count;
  const next = useCallback(() => setShown((n) => (n >= count ? n : n + 1)), [count]);

  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    let live = true;
    import("./comicScenes")
      .then(({ renderComic, STORY }) => renderComic(two ? STORY.duo : STORY.solo))
      .then((urls) => { if (live) setShots(urls); })
      .catch(() => { if (live) doneRef.current(); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!shots || all) return;
    const t = window.setTimeout(next, BEAT);
    return () => window.clearTimeout(t);
  }, [shots, shown, all, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDone();
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (all) onDone(); else next(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, next, onDone]);

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden bg-[#0a0a12] px-4 py-6"
      onClick={() => (!shots ? undefined : all ? onDone() : next())}
      data-comic={shots ? shown : 0}
    >
      <button
        className="absolute right-4 z-10 rounded-full bg-white/10 px-4 py-1.5 text-[13px] font-semibold text-white ring-1 ring-white/20"
        style={{ top: "max(env(safe-area-inset-top), 16px)" }}
        onClick={(e) => { e.stopPropagation(); onDone(); }}
      >
        Skip ⏭
      </button>
      {!shots ? (
        <div className="text-[14px] text-white/60">Printing the comic…</div>
      ) : (
        <div className={`flex w-full flex-wrap justify-center gap-3 ${phone ? "max-w-[440px]" : "max-w-[1180px]"}`}>
          {order.map((li, i) => {
            const Letters = LETTERING[li];
            const on = phone ? i === shown - 1 : i < shown;
            if (phone && !on) return null;
            return (
              <div
                key={i}
                className="overflow-hidden rounded-[4px] bg-white p-[5px] shadow-[6px_6px_0_rgba(0,0,0,0.6)]"
                style={{
                  width: phone ? "100%" : "calc(33.333% - 8px)",
                  opacity: on ? 1 : 0.06,
                  transform: on ? `rotate(${[-1.2, 0.9, 0.6, -0.8, 1.0][i]}deg)` : "scale(0.96)",
                  transition: "opacity .35s, transform .35s",
                }}
              >
                <div className="relative ring-[3px] ring-black" style={{ aspectRatio: "4 / 3", fontFamily: "'Bangers', Impact, 'Arial Black', system-ui, sans-serif" }}>
                  <img src={shots[i]} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                  <svg viewBox="0 0 800 600" className="absolute inset-0 h-full w-full">
                    <Letters />
                  </svg>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-5 h-10">
        {all && shots ? (
          <button
            className="rounded-full bg-[#ffd36a] px-7 py-2.5 text-[15px] font-bold text-black shadow-lg"
            onClick={(e) => { e.stopPropagation(); onDone(); }}
          >
            Light the fuse 💣
          </button>
        ) : shots ? (
          <div className="text-[12px] text-white/40">Tap to turn the page</div>
        ) : null}
      </div>
    </div>
  );
}
