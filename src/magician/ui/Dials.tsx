/**
 * The dials: every knob of the valley, by hand.
 *
 * Each control writes the same patch a spoken wish does (see state.ts), so
 * a knob turned here moves the world for everyone in the room, and a spell
 * Vibey casts turns the knob. The dials show the state; they keep none of
 * their own beyond the drag in progress.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react";
import type { Patch, Season, Weather, WorldState } from "@/magician/state";

interface DialProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** How the value reads under the knob. */
  format?: (v: number) => string;
  /** Wraps around (time of day, a compass bearing) instead of stopping at the ends. */
  wrap?: boolean;
  onChange(v: number): void;
  hue?: string;
}

/** A knob: drag up or down (or use the arrow keys) to turn it. */
function Dial({ label, value, min, max, step = 0.01, format, wrap, onChange, hue = "#ffd6a0" }: DialProps) {
  const drag = useRef<{ y: number; x: number; v: number } | null>(null);
  const k = (value - min) / (max - min);
  const a0 = -135, a1 = 135;
  const ang = a0 + (a1 - a0) * Math.max(0, Math.min(1, k));
  const clampV = (v: number) => {
    const span = max - min;
    if (wrap) return ((((v - min) % span) + span) % span) + min;
    return Math.max(min, Math.min(max, v));
  };
  const round = (v: number) => Math.round(v / step) * step;
  const arc = (from: number, to: number, r: number) => {
    const p = (deg: number) => [32 + r * Math.sin((deg * Math.PI) / 180), 32 - r * Math.cos((deg * Math.PI) / 180)];
    const [x0, y0] = p(from), [x1, y1] = p(to);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, x: e.clientX, v: value };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const d = (drag.current.y - e.clientY) + (e.clientX - drag.current.x) * 0.5;
    onChange(round(clampV(drag.current.v + (d / 160) * (max - min))));
  };
  const onUp = () => { drag.current = null; };
  const onKey = (e: RKeyboardEvent) => {
    const big = (max - min) / 20;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); onChange(round(clampV(value + big))); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); onChange(round(clampV(value - big))); }
  };
  return (
    <div className="flex flex-col items-center gap-0.5 select-none">
      <svg
        width="58" height="58" viewBox="0 0 64 64"
        role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}
        className="cursor-ns-resize touch-none outline-none focus-visible:drop-shadow-[0_0_6px_rgba(255,214,160,0.8)]"
      >
        <circle cx="32" cy="32" r="25" fill="rgba(20,12,30,0.8)" stroke="rgba(255,255,255,0.12)" />
        <path d={arc(a0, a1, 28)} stroke="rgba(255,255,255,0.12)" strokeWidth="3" fill="none" strokeLinecap="round" />
        {k > 0.004 && <path d={arc(a0, ang, 28)} stroke={hue} strokeWidth="3" fill="none" strokeLinecap="round" />}
        <g transform={`rotate(${ang} 32 32)`}>
          <line x1="32" y1="32" x2="32" y2="12" stroke={hue} strokeWidth="3" strokeLinecap="round" />
        </g>
        <circle cx="32" cy="32" r="5" fill={hue} opacity="0.9" />
      </svg>
      <div className="text-[9px] uppercase tracking-[0.18em] text-white/50">{label}</div>
      <div className="font-mono text-[10px] text-white/80">{format ? format(value) : value.toFixed(2)}</div>
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ v: T; t: string }>; onChange(v: T): void }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-white/45">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${value === o.v ? "border-[#ffd6a0]/70 bg-[#ffd6a0]/20 text-[#fff1dc]" : "border-white/15 bg-black/25 text-white/60 hover:text-white"}`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const clock = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;

export function Dials({ state, patch, music, onMusic, onClose }: {
  state: WorldState;
  patch(p: Patch): void;
  music: boolean;
  onMusic(on: boolean): void;
  onClose(): void;
}) {
  // A drag produces dozens of values a second; the room needs a few.
  const pending = useRef<Patch>({});
  const timer = useRef<number | null>(null);
  const [local, setLocal] = useState<Partial<WorldState>>({});
  const send = useCallback((p: Patch) => {
    setLocal((l) => ({ ...l, ...p }));
    pending.current = { ...pending.current, ...p };
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const out = pending.current;
      pending.current = {};
      patch(out);
    }, 90);
  }, [patch]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  // What the world says wins once a drag has been sent.
  useEffect(() => { if (timer.current === null) setLocal({}); }, [state]);
  const s = { ...state, ...local } as WorldState;
  const petals = s.petals === "auto" ? (s.season === "spring" ? 0.6 : s.season === "autumn" ? 0.35 : 0) : s.petals;
  const tri = (v: boolean | "auto") => (v === "auto" ? "auto" : v ? "on" : "off");
  const fromTri = (v: string): boolean | "auto" => (v === "auto" ? "auto" : v === "on");

  return (
    <div className="max-h-[calc(100dvh-9rem)] w-[min(92vw,19rem)] overflow-y-auto rounded-xl border border-white/12 bg-[#171126]/92 p-3 text-[#efe6ff] shadow-2xl backdrop-blur-md" data-ui="1">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-serif text-base text-[#fff1dc]">The valley&apos;s dials</div>
        <button onClick={onClose} className="rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-white/50 hover:text-white">close</button>
      </div>
      <div className="grid grid-cols-4 gap-x-1 gap-y-2">
        <Dial label="time" value={s.timeOfDay} min={0} max={24} step={0.05} wrap format={clock} onChange={(v) => send({ timeOfDay: v })} hue="#ffcf7a" />
        <Dial label="wind" value={s.wind} min={0} max={1} format={pct} onChange={(v) => send({ wind: v })} hue="#bfe8ff" />
        <Dial label="bearing" value={((s.windDirection % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)} min={0} max={Math.PI * 2} wrap format={(v) => `${Math.round((v * 180) / Math.PI)}°`} onChange={(v) => send({ windDirection: v })} hue="#bfe8ff" />
        <Dial label="fog" value={s.fog} min={0} max={1} format={pct} onChange={(v) => send({ fog: v })} hue="#d9dde6" />
        <Dial label="aurora" value={s.aurora} min={0} max={1} format={pct} onChange={(v) => send({ aurora: v })} hue="#7dffc4" />
        <Dial label="meteors" value={s.meteors} min={0} max={1} format={pct} onChange={(v) => send({ meteors: v })} hue="#c9b8ff" />
        <Dial label="petals" value={petals} min={0} max={1} format={pct} onChange={(v) => send({ petals: v })} hue="#ffb6d0" />
        <Dial label="flood" value={s.flood} min={0} max={1} format={pct} onChange={(v) => send({ flood: v })} hue="#7fc4ff" />
        <Dial label="speed" value={s.speed} min={0.3} max={4} format={(v) => `×${v.toFixed(1)}`} onChange={(v) => send({ speed: v })} hue="#ffd6a0" />
        <Dial label="scale" value={s.giant} min={0.4} max={2.5} format={(v) => `×${v.toFixed(2)}`} onChange={(v) => send({ giant: v })} hue="#ffd6a0" />
      </div>
      <div className="mt-3 space-y-2">
        <Choice<Weather> label="weather" value={s.weather} onChange={(v) => send({ weather: v })} options={[{ v: "clear", t: "clear" }, { v: "cloudy", t: "cloud" }, { v: "rain", t: "rain" }, { v: "storm", t: "storm" }, { v: "snow", t: "snow" }, { v: "fog", t: "fog" }]} />
        <Choice<Season> label="season" value={s.season} onChange={(v) => send({ season: v })} options={[{ v: "spring", t: "spring" }, { v: "summer", t: "summer" }, { v: "autumn", t: "autumn" }, { v: "winter", t: "winter" }]} />
        <div className="grid grid-cols-2 gap-2">
          <Choice label="lanterns" value={tri(s.lanternsLit)} onChange={(v) => send({ lanternsLit: fromTri(v) })} options={[{ v: "auto", t: "auto" }, { v: "on", t: "on" }, { v: "off", t: "off" }]} />
          <Choice label="fireflies" value={tri(s.fireflies)} onChange={(v) => send({ fireflies: fromTri(v) })} options={[{ v: "auto", t: "auto" }, { v: "on", t: "on" }, { v: "off", t: "off" }]} />
        </div>
        <Choice label="gravity" value={s.gravity} onChange={(v) => send({ gravity: v })} options={[{ v: "normal", t: "earth" }, { v: "moon", t: "moon" }, { v: "heavy", t: "heavy" }]} />
        <div className="flex flex-wrap gap-1 pt-1">
          <button onClick={() => send({ clockRunning: !s.clockRunning })} className={`rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${s.clockRunning ? "border-[#ffcf7a]/70 bg-[#ffcf7a]/20 text-[#fff1dc]" : "border-white/15 bg-black/25 text-white/60"}`}>
            {s.clockRunning ? "day is passing" : "time stands still"}
          </button>
          <button onClick={() => send({ palette: null })} className="rounded-sm border border-white/15 bg-black/25 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-white/60 hover:text-white">natural colours</button>
          <button onClick={() => onMusic(!music)} className={`rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${music ? "border-[#ffd6a0]/70 bg-[#ffd6a0]/20 text-[#fff1dc]" : "border-white/15 bg-black/25 text-white/60"}`}>
            koto {music ? "on" : "off"}
          </button>
        </div>
        <div className="pt-1 text-[10px] leading-relaxed text-white/40">Drag a dial up or down. Everyone in the valley sees it turn, and Vibey can turn them too.</div>
      </div>
    </div>
  );
}
