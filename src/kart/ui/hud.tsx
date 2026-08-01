/**
 * Vibe Kart — the race HUD.
 *
 * Everything a driver has to read at 100 km/h, arranged so that no two things
 * that change at the same time sit next to each other:
 *
 *   top-left      held item, then lap and the clock
 *   top-right     the course map
 *   bottom-left   position, then coins
 *   bottom-right  speed and the mini-turbo charge
 *   centre        only ever one thing at a time — the lights, a banner, a warning
 *
 * The split between React and the DOM is deliberate and load-bearing. Anything
 * that changes every frame (speed, the charge ring, the map dots, the three
 * clocks, every glow) is written through a ref from `useKartFrame`. Anything
 * that changes a few times a lap (place, lap number, coins, the held item) goes
 * through `useSample` at 15 Hz with a change guard, so a re-render is a real
 * event rather than a frame tick. The countdown, the banners and the toasts are
 * driven by the engine's event bus, which is the only thing that can tell the
 * difference between "a boost is active" and "a boost just started".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ItemKind } from "../types";
import { ItemArt, ROULETTE, CoinGlyph, UTurnGlyph } from "./icons";
import { Speedometer, PlaceBadge, MinimapPanel } from "./gauges";
import { useKartEvent, useKartFrame, useRuntime, useSample, shallowEq } from "./runtime";
import { clamp01, formatTime, NO_TIME, TIER_COLOR } from "./util";
import { playerOf, type ItemsView, type PhysicsView, type RaceView } from "./views";

/**
 * Speed streaks: 44 thin wedges radiating from the centre, built once. Lengths
 * and opacities are jittered off a fixed hash so the burst does not read as a
 * clock face, and the whole thing is one static SVG the compositor can spin.
 */
const STREAKS = Array.from({ length: 44 }, (_, i) => {
  const a = (i / 44) * Math.PI * 2;
  const jitter = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const inner = 30 + jitter * 8;
  const outer = 62 + jitter * 26;
  const half = 0.0055 + jitter * 0.006;
  const p = (r: number, t: number) => `${(Math.cos(t) * r).toFixed(2)} ${(Math.sin(t) * r).toFixed(2)}`;
  return {
    key: i,
    d: `M${p(inner, a - half)} L${p(outer, a - half * 2.2)} L${p(outer, a + half * 2.2)} L${p(inner, a + half)} Z`,
    opacity: 0.25 + jitter * 0.55,
  };
});

// ---------------------------------------------------------------------------
// Item slot
// ---------------------------------------------------------------------------

interface ItemInfo {
  kind: ItemKind | null;
  face: ItemKind | null;
  count: number;
  rolling: boolean;
}

function ItemSlot() {
  const rt = useRuntime();
  const info = useSample<ItemInfo>(
    () => {
      const physics = rt.ctx.services.physics as PhysicsView | undefined;
      const items = rt.ctx.services.items as ItemsView | undefined;
      const racer = playerOf(physics);
      if (!racer) return { kind: null, face: null, count: 0, rolling: false };
      const shown = items?.display?.(racer.id);
      const rolling = shown?.rolling ?? racer.rolling;
      const kind = shown?.kind ?? racer.item;
      // The item system publishes the roulette's current face; without it, spin
      // our own at 14 Hz so the slot still reads as "deciding".
      const face = rolling
        ? shown?.face ?? ROULETTE[Math.floor(rt.ctx.elapsed * 14) % ROULETTE.length]
        : kind;
      return { kind, face, count: shown?.count ?? racer.itemCount, rolling };
    },
    shallowEq,
    // Fast enough that the spin blurs, slow enough that it is one small subtree.
    22,
  );

  const empty = !info.face;
  return (
    <div
      className={`vk-item${empty ? " vk-item--empty" : ""}${info.rolling ? " vk-item--rolling" : ""}`}
      aria-label={info.kind ? `Item: ${info.kind}` : "No item"}
    >
      {info.face ? (
        <div
          key={info.rolling ? "roll" : `lock-${info.face}`}
          className={`vk-item-art${info.rolling ? "" : " vk-item--locked"}`}
        >
          <ItemArt kind={info.face} />
        </div>
      ) : (
        <svg viewBox="0 0 64 64" aria-hidden="true" style={{ opacity: 0.35 }}>
          <path
            d="M32 8 L54 20 V44 L32 56 L10 44 V20 Z"
            fill="none"
            stroke="#fff7e6"
            strokeWidth={3.4}
            strokeLinejoin="round"
            strokeDasharray="5 5"
          />
        </svg>
      )}
      {info.count > 1 ? <div className="vk-item-count vk-ink-edge vk-num">×{info.count}</div> : null}
      {!empty && !info.rolling ? <div className="vk-item-glint" /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lap + clocks
// ---------------------------------------------------------------------------

function LapCard() {
  const rt = useRuntime();
  const state = useSample(
    () => {
      const race = rt.ctx.services.race as RaceView | undefined;
      const physics = rt.ctx.services.physics as PhysicsView | undefined;
      const racer = playerOf(physics);
      const total = race?.totalLaps ?? 3;
      const done = racer ? (race?.lapOf?.(racer.id) ?? racer.lap) : 0;
      return {
        lap: Math.min(total, Math.max(1, done + 1)),
        total,
        final: race?.finalLap ?? done + 1 >= total,
      };
    },
    shallowEq,
  );

  return (
    <div className={`vk-lap${state.final ? " vk-lap--final" : ""}`}>
      <span className="vk-lap-word">Lap</span>
      <span key={state.lap} className="vk-lap-now vk-num vk-ink-edge vk-anim-pop">
        {state.lap}
      </span>
      <span className="vk-lap-of vk-num">/ {state.total}</span>
    </div>
  );
}

function TimerCard() {
  const rt = useRuntime();
  const total = useRef<HTMLDivElement | null>(null);
  const lap = useRef<HTMLDivElement | null>(null);
  const best = useRef<HTMLDivElement | null>(null);

  useKartFrame(() => {
    const race = rt.ctx.services.race as RaceView | undefined;
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    const racer = playerOf(physics);
    const t = race?.time ?? 0;
    if (total.current) total.current.textContent = formatTime(t);

    if (racer) {
      const splits = race?.lapsOf?.(racer.id) ?? racer.lapTimes;
      let done = 0;
      for (const s of splits) done += s;
      if (lap.current) lap.current.textContent = formatTime(Math.max(0, t - done));
      const b = race?.bestLapOf?.(racer.id) ?? (splits.length ? Math.min(...splits) : 0);
      if (best.current) best.current.textContent = b > 0 ? formatTime(b) : NO_TIME;
    }
  });

  return (
    <div className="vk-times">
      <div className="vk-times-row">
        <span className="vk-times-key">Time</span>
        <span className="vk-times-total vk-num vk-ink-edge" ref={total}>
          0:00.000
        </span>
      </div>
      <div className="vk-times-row">
        <span className="vk-times-key">Lap</span>
        <span className="vk-times-val vk-num" ref={lap}>
          0:00.000
        </span>
      </div>
      <div className="vk-times-row">
        <span className="vk-times-key">Best</span>
        <span className="vk-times-val vk-times-val--best vk-num" ref={best}>
          {NO_TIME}
        </span>
      </div>
    </div>
  );
}

function CoinPill() {
  const rt = useRuntime();
  const coins = useSample(() => playerOf(rt.ctx.services.physics as PhysicsView | undefined)?.coins ?? 0);
  return (
    <div key={coins} className="vk-coins vk-coins--pop">
      <CoinGlyph />
      <span className="vk-coins-n vk-num vk-ink-edge">{coins}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Centre overlays
// ---------------------------------------------------------------------------

/** The lights. `count` 3·2·1 then 0 = GO, which gets its own bigger motion. */
function Countdown() {
  const [light, setLight] = useState<{ n: number; id: number } | null>(null);
  const seq = useRef(0);
  // The race emits `countdown {count:0}` and `start` back to back; GO! is one
  // flourish, so the second of the pair inside a beat is swallowed.
  const lastGo = useRef(0);

  const light0 = useCallback((n: number) => {
    if (n === 0) {
      const now = performance.now();
      if (now - lastGo.current < 400) return;
      lastGo.current = now;
    }
    seq.current += 1;
    setLight({ n, id: seq.current });
  }, []);

  useKartEvent<{ count: number }>("race:countdown", (p) => light0(typeof p?.count === "number" ? p.count : 0));
  useKartEvent("race:start", () => light0(0));
  useKartEvent("race:restart", () => setLight(null));

  useEffect(() => {
    if (!light) return;
    const ms = light.n === 0 ? 1100 : 1000;
    const timer = window.setTimeout(() => setLight((cur) => (cur && cur.id === light.id ? null : cur)), ms);
    return () => window.clearTimeout(timer);
  }, [light]);

  if (!light) return null;
  const go = light.n === 0;

  return (
    <div className="vk-center">
      <div
        key={light.id}
        className="vk-count"
        style={{ animation: `${go ? "vk-go 1.05s" : "vk-count 0.95s"} cubic-bezier(0.2,1.4,0.3,1) both` }}
      >
        <svg viewBox="0 0 200 120" style={{ width: go ? "56vmin" : "34vmin", height: "auto" }} aria-hidden="true">
          <text
            x={100}
            y={98}
            textAnchor="middle"
            style={{ fontFamily: "inherit", fontWeight: 900, fontSize: go ? 96 : 116, letterSpacing: "-0.02em" }}
            fill={go ? "#8ff05a" : "#fff7e6"}
            stroke="#0a1120"
            strokeWidth={16}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {go ? "GO!" : light.n}
          </text>
          <text
            x={100}
            y={98}
            textAnchor="middle"
            style={{ fontFamily: "inherit", fontWeight: 900, fontSize: go ? 96 : 116, letterSpacing: "-0.02em" }}
            fill={go ? "#a6ff70" : "#ffcc22"}
          >
            {go ? "GO!" : light.n}
          </text>
        </svg>
      </div>
    </div>
  );
}

interface Banner {
  id: number;
  text: string;
  hot?: boolean;
}

/** One centre banner at a time: final lap, a rocket start, the flag. */
function Banners() {
  const rt = useRuntime();
  const [banner, setBanner] = useState<Banner | null>(null);
  const seq = useRef(0);
  const wasFinal = useRef(false);

  const show = useCallback((text: string, hot?: boolean) => {
    seq.current += 1;
    setBanner({ id: seq.current, text, hot });
  }, []);

  // Final lap is a state, not an event, so it is edge-detected off the sampler.
  const finalLap = useSample(() => (rt.ctx.services.race as RaceView | undefined)?.finalLap ?? false);
  useEffect(() => {
    if (finalLap && !wasFinal.current) show("Final Lap!");
    wasFinal.current = finalLap;
  }, [finalLap, show]);

  useKartEvent("race:start", () => {
    // The launch is graded the instant the lights go out; read it a beat later
    // so the GO! motion owns the screen first.
    window.setTimeout(() => {
      const race = rt.ctx.services.race as RaceView | undefined;
      const player = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
      const grade = player ? race?.startGradeOf?.(player.id) : undefined;
      if (grade === "perfect") show("Rocket Start!");
      else if (grade === "good") show("Good Start");
      else if (grade === "flooded") show("Flooded!", true);
    }, 620);
  });

  useKartEvent<{ racer: number }>("race:finish", (p) => {
    const player = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
    if (player && p?.racer === player.id) show("Finish!");
  });

  useKartEvent("race:restart", () => {
    wasFinal.current = false;
    setBanner(null);
  });

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner((cur) => (cur && cur.id === banner.id ? null : cur)), 2200);
    return () => window.clearTimeout(timer);
  }, [banner]);

  if (!banner) return null;
  return (
    <div className={`vk-banner${banner.hot ? " vk-banner--hot" : ""}`}>
      <div key={banner.id} className="vk-banner-in">
        <span>{banner.text}</span>
      </div>
    </div>
  );
}

function WrongWay() {
  const rt = useRuntime();
  const box = useRef<HTMLDivElement | null>(null);
  useKartFrame(() => {
    const race = rt.ctx.services.race as RaceView | undefined;
    const player = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
    const wrong = !!race?.wrongWay?.(player?.id) && race?.phase === "racing";
    if (box.current) box.current.style.display = wrong ? "flex" : "none";
  });
  return (
    <div className="vk-wrong vk-ink-edge" ref={box} style={{ display: "none" }}>
      <UTurnGlyph />
      <span>Wrong way</span>
    </div>
  );
}

/** A one-shot bloom when a boost fires — the flash the streaks then carry. */
function BoostFlare() {
  const rt = useRuntime();
  const [pulse, setPulse] = useState(0);
  const last = useRef(0);

  useKartEvent<{ racer: number; source: string }>("kart:boost", (p) => {
    const player = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
    if (!player || p?.racer !== player.id) return;
    // Chained boosts (a mini-turbo into a pad) would otherwise restart the
    // animation every few frames and read as a flicker.
    const now = performance.now();
    if (now - last.current < 240) return;
    last.current = now;
    setPulse((n) => n + 1);
  });

  if (!pulse) return null;
  return <div key={pulse} className="vk-flare vk-flare--on" />;
}

/**
 * The felt layer: screen-edge glow, speed streaks and the blooper's ink. Four
 * fixed nodes whose opacity is written every frame — no allocation, no
 * re-render, and the priority order (hit → star → boost → drift) means two
 * states can never fight over the same corner of the screen.
 */
function FeedbackLayer() {
  const rt = useRuntime();
  const drift = useRef<HTMLDivElement | null>(null);
  const boost = useRef<HTMLDivElement | null>(null);
  const hit = useRef<HTMLDivElement | null>(null);
  const star = useRef<HTMLDivElement | null>(null);
  const streaks = useRef<HTMLDivElement | null>(null);
  const ink = useRef<HTMLDivElement | null>(null);
  const spin = useRef(0);

  useKartFrame((dt) => {
    const racer = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
    const items = rt.ctx.services.items as ItemsView | undefined;
    if (!racer) return;

    const tier = racer.driftTier ?? 0;
    const driftAmt = racer.drifting ? 0.25 + 0.55 * clamp01(tier >= 3 ? 1 : racer.driftCharge) : 0;
    const boostAmt = clamp01(racer.boost * 1.6);
    const starAmt = clamp01(items?.starOf?.(racer.id) ?? (racer.star > 0 ? 1 : 0));
    const hitAmt = clamp01(racer.stun * 1.2);

    if (drift.current) {
      drift.current.style.opacity = String(driftAmt * (1 - hitAmt));
      drift.current.style.boxShadow = `inset 0 0 14vmin ${TIER_COLOR[Math.min(3, Math.max(1, tier))]}99`;
    }
    if (boost.current) boost.current.style.opacity = String(boostAmt * (1 - hitAmt));
    if (star.current) star.current.style.opacity = String(starAmt * 0.8);
    if (hit.current) hit.current.style.opacity = String(hitAmt);

    // Streaks ramp in over the top third of the speed range, then double on a
    // boost — the same curve the camera's FOV uses, so they arrive together.
    const speed = clamp01((Math.abs(racer.speed) - 18) / 12);
    if (streaks.current) {
      spin.current += dt * (12 + 40 * boostAmt);
      streaks.current.style.opacity = String(clamp01(speed * 0.32 + boostAmt * 0.5));
      streaks.current.style.transform = `rotate(${(spin.current % 360).toFixed(1)}deg) scale(${(1 + boostAmt * 0.12).toFixed(3)})`;
    }
    if (ink.current) ink.current.style.opacity = String(clamp01(items?.inkOf?.(racer.id) ?? 0));
  });

  return (
    <>
      <div className="vk-streaks" ref={streaks}>
        <svg viewBox="-50 -50 100 100" preserveAspectRatio="none" aria-hidden="true">
          <g fill="#ffffff">
            {STREAKS.map((s) => (
              <path key={s.key} d={s.d} opacity={s.opacity} />
            ))}
          </g>
        </svg>
      </div>
      <BoostFlare />
      <div className="vk-edge vk-edge--drift" ref={drift} />
      <div className="vk-edge vk-edge--boost" ref={boost} />
      <div className="vk-edge vk-edge--star" ref={star} />
      <div className="vk-edge vk-edge--hit" ref={hit} />
      <div ref={ink} style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}>
        <svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }} aria-hidden="true">
          <g fill="#12183a" opacity={0.92}>
            <ellipse cx={28} cy={20} rx={26} ry={19} />
            <ellipse cx={70} cy={34} rx={30} ry={22} />
            <ellipse cx={48} cy={12} rx={18} ry={12} />
            <ellipse cx={88} cy={12} rx={14} ry={10} />
            <ellipse cx={12} cy={48} rx={16} ry={11} />
          </g>
        </svg>
      </div>
    </>
  );
}

interface Toast {
  id: number;
  text: string;
  color: string;
}

/** Short-lived callouts. Capped at three so a pile-up cannot cover the road. */
function Toasts() {
  const rt = useRuntime();
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  const push = useCallback((text: string, color: string) => {
    seq.current += 1;
    const id = seq.current;
    setList((cur) => [...cur.slice(-2), { id, text, color }]);
    const t = window.setTimeout(() => setList((cur) => cur.filter((x) => x.id !== id)), 1500);
    timers.current.push(t);
  }, []);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const isPlayer = useCallback(
    (id: number | undefined) => {
      const player = playerOf(rt.ctx.services.physics as PhysicsView | undefined);
      return !!player && id === player.id;
    },
    [rt],
  );

  useKartEvent<{ racer: number; tier: number }>("kart:miniTurbo", (p) => {
    if (!isPlayer(p?.racer)) return;
    const tier = Math.min(3, Math.max(1, p?.tier ?? 1));
    push(["", "Mini-Turbo", "Super Mini-Turbo", "Ultra Mini-Turbo"][tier], TIER_COLOR[tier]);
  });

  useKartEvent<{ racer: number; source: string }>("kart:boost", (p) => {
    if (!isPlayer(p?.racer)) return;
    if (p?.source === "miniTurbo") return; // already announced by the tier toast
    const label: Record<string, string> = {
      pad: "Boost Pad!",
      mushroom: "Mushroom!",
      start: "Rocket Start!",
      trick: "Trick!",
      slipstream: "Slipstream!",
      bullet: "Bullet Bill!",
    };
    push(label[p?.source ?? ""] ?? "Boost!", "#ffcc22");
  });

  useKartEvent<{ racer: number; by: string }>("kart:hit", (p) => {
    if (!isPlayer(p?.racer)) return;
    const by = p?.by ?? "wall";
    const label: Record<string, string> = {
      banana: "Banana!",
      greenShell: "Green Shell!",
      redShell: "Red Shell!",
      blueShell: "Spiny Shell!",
      bobomb: "Bob-omb!",
      lightning: "Zapped!",
      fireflower: "Scorched!",
      star: "Flattened!",
      bullet: "Run Over!",
      wall: "Ouch!",
    };
    push(label[by] ?? "Hit!", "#ff5d6c");
  });

  useKartEvent<{ racer: number; lapTime: number }>("race:lap", (p) => {
    if (!isPlayer(p?.racer) || !p?.lapTime) return;
    const race = rt.ctx.services.race as RaceView | undefined;
    const best = race?.bestLapOf?.(p.racer) ?? 0;
    const isBest = best > 0 && p.lapTime <= best + 1e-3;
    push(`${isBest ? "Best lap " : "Lap "}${formatTime(p.lapTime)}`, isBest ? "#8ff05a" : "#fff7e6");
  });

  useKartEvent("race:restart", () => setList([]));

  if (!list.length) return null;
  return (
    <div className="vk-toasts">
      {list.map((t) => (
        <div key={t.id} className="vk-toast vk-ink-edge" style={{ color: t.color }}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function RaceHud() {
  const rt = useRuntime();
  const root = useRef<HTMLDivElement | null>(null);
  const touching = useRef(false);

  // One attribute compare a frame keeps the layout in step with whichever
  // device the player just picked up; the CSS does the rest.
  useKartFrame(() => {
    const touch = rt.ctx.input.touch;
    if (touch === touching.current || !root.current) return;
    touching.current = touch;
    root.current.setAttribute("data-touch", touch ? "1" : "0");
  });

  return (
    <div className="vk-hud" data-kart-hud="race" data-touch="0" ref={root}>
      <FeedbackLayer />

      <div className="vk-hud-tl">
        <ItemSlot />
        <div className="vk-stack">
          <LapCard />
          <TimerCard />
        </div>
      </div>

      <div className="vk-hud-tr">
        <MinimapPanel />
      </div>

      <div className="vk-hud-bl">
        <PlaceBadge />
        <CoinPill />
      </div>

      <div className="vk-hud-br">
        <Speedometer />
      </div>

      <WrongWay />
      <Banners />
      <Toasts />
      <Countdown />
    </div>
  );
}

export default RaceHud;
