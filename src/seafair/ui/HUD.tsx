import { useEffect, useRef, useState } from "react";
import { bus } from "../core/EventBus";

/**
 * Diegetic-feeling HUD: shield/health bars, ammo counter, motion-tracker-style
 * radar, objective banner, hitmarkers, damage direction indicators, kill feed.
 * Everything is event-driven — the HUD never reaches into the scene.
 */

interface Vitals {
  health: number;
  shield: number;
  maxHealth: number;
  maxShield: number;
}

interface Hitmarker {
  id: number;
  headshot: boolean;
  killed: boolean;
}

interface DamageArrow {
  id: number;
  angle: number;
}

interface FeedItem {
  id: number;
  text: string;
  kind: "info" | "warn" | "good";
}

let uid = 0;

export default function HUD({ showFps }: { showFps: boolean }) {
  const [vitals, setVitals] = useState<Vitals>({
    health: 100,
    shield: 120,
    maxHealth: 100,
    maxShield: 120,
  });
  const [weapon, setWeapon] = useState({ name: "MA7C ASSAULT RIFLE", ammo: 36, reserve: 288, icon: "▮▮▮" });
  const [objective, setObjective] = useState<{ text: string; sub?: string } | null>(null);
  const [hits, setHits] = useState<Hitmarker[]>([]);
  const [arrows, setArrows] = useState<DamageArrow[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState({ fps: 0, ms: 0, drawCalls: 0, triangles: 0, tier: "" });
  const [reloading, setReloading] = useState(0);
  const [subtitle, setSubtitle] = useState<{ speaker: string; text: string } | null>(null);
  const [score, setScore] = useState({ score: 0, combo: 0 });
  const [spectacle, setSpectacle] = useState<string | null>(null);
  const reloadRef = useRef<number>(0);

  useEffect(() => {
    const offs = [
      bus.on("player:health", setVitals),
      bus.on("weapon:changed", (w) => setWeapon(w)),
      bus.on("weapon:ammo", (a) => setWeapon((w) => ({ ...w, ...a }))),
      bus.on("objective:changed", (o) => setObjective(o)),
      bus.on("perf:stats", setStats),
      bus.on("score:changed", setScore),
      bus.on("combat:hit", ({ headshot, killed }) => {
        const id = ++uid;
        setHits((h) => [...h, { id, headshot, killed }]);
        setTimeout(() => setHits((h) => h.filter((x) => x.id !== id)), 260);
      }),
      bus.on("player:damaged", ({ fromDirection }) => {
        const id = ++uid;
        const angle = Math.atan2(fromDirection[0], fromDirection[2]);
        setArrows((a) => [...a, { id, angle }]);
        setTimeout(() => setArrows((a) => a.filter((x) => x.id !== id)), 1100);
      }),
      bus.on("notify", ({ text, kind }) => {
        const id = ++uid;
        setFeed((f) => [...f.slice(-4), { id, text, kind }]);
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 4200);
      }),
      bus.on("combat:kill", ({ targetName, headshot }) => {
        const id = ++uid;
        setFeed((f) => [
          ...f.slice(-4),
          { id, text: `${headshot ? "HEADSHOT — " : ""}${targetName} eliminated`, kind: "good" as const },
        ]);
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 4200);
      }),
      bus.on("weapon:reload", ({ duration }) => {
        reloadRef.current = duration;
        setReloading(duration);
        const start = performance.now();
        const tick = () => {
          const t = (performance.now() - start) / 1000;
          const left = Math.max(0, duration - t);
          setReloading(left);
          if (left > 0) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
      bus.on("subtitle", ({ speaker, text, duration }) => {
        setSubtitle({ speaker, text });
        setTimeout(() => setSubtitle(null), duration * 1000);
      }),
      bus.on("spectacle", ({ text }) => {
        setSpectacle(text);
        setTimeout(() => setSpectacle(null), 3600);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const shieldPct = vitals.maxShield > 0 ? (vitals.shield / vitals.maxShield) * 100 : 0;
  const healthPct = (vitals.health / vitals.maxHealth) * 100;
  const critical = vitals.shield <= 0 && healthPct < 35;

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-display">
      {/* low-health vignette */}
      {critical && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 38%, rgba(180,10,14,0.42) 100%)",
          }}
        />
      )}

      {/* ---- crosshair ---- */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative h-10 w-10">
          <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-needle-300 shadow-[0_0_5px_rgba(108,199,255,0.9)]" />
          {[0, 90, 180, 270].map((deg) => (
            <span
              key={deg}
              className="absolute left-1/2 top-1/2 h-[7px] w-[2px] origin-center bg-needle-300/85 shadow-[0_0_4px_rgba(108,199,255,0.8)]"
              style={{ transform: `rotate(${deg}deg) translate(-50%, -13px)` }}
            />
          ))}
          {hits.map((h) => (
            <span key={h.id} className="absolute inset-0">
              {[45, 135, 225, 315].map((deg) => (
                <span
                  key={deg}
                  className={`absolute left-1/2 top-1/2 h-[9px] w-[2px] origin-center ${
                    h.killed ? "bg-red-400" : h.headshot ? "bg-amber-300" : "bg-white"
                  }`}
                  style={{ transform: `rotate(${deg}deg) translate(-50%, -11px)` }}
                />
              ))}
            </span>
          ))}
        </div>
      </div>

      {/* ---- damage direction ---- */}
      {arrows.map((a) => (
        <div
          key={a.id}
          className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2"
          style={{ transform: `translate(-50%,-50%) rotate(${(a.angle * 180) / Math.PI}deg)` }}
        >
          <div
            className="absolute left-1/2 top-0 h-6 w-24 -translate-x-1/2"
            style={{
              background: "linear-gradient(to bottom, rgba(255,60,50,0.85), transparent)",
              clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
            }}
          />
        </div>
      ))}

      {/* ---- shield + health, top-left in Halo fashion ---- */}
      <div className="absolute left-5 top-5 safe-t w-64">
        <div className="mb-1 flex items-baseline justify-between text-[10px] tracking-[0.25em] text-needle-300/80">
          <span>SHIELD</span>
          <span className="font-mono">{Math.ceil(vitals.shield)}</span>
        </div>
        <div className="h-[10px] w-full skew-x-[-18deg] overflow-hidden border border-needle-300/45 bg-black/45">
          <div
            className="h-full bg-gradient-to-r from-needle-500 to-needle-300 transition-[width] duration-150"
            style={{
              width: `${shieldPct}%`,
              boxShadow: "0 0 12px rgba(18,165,245,0.85) inset",
            }}
          />
        </div>
        <div className="mb-1 mt-2 flex items-baseline justify-between text-[10px] tracking-[0.25em] text-emerald-300/80">
          <span>VITALS</span>
          <span className="font-mono">{Math.ceil(vitals.health)}</span>
        </div>
        <div className="h-[6px] w-full skew-x-[-18deg] overflow-hidden border border-emerald-300/40 bg-black/45">
          <div
            className={`h-full transition-[width] duration-150 ${
              healthPct < 35 ? "bg-red-500" : "bg-emerald-400"
            }`}
            style={{ width: `${healthPct}%` }}
          />
        </div>
      </div>

      {/* ---- objective ---- */}
      {objective && (
        <div className="absolute left-1/2 top-6 safe-t -translate-x-1/2 text-center">
          <div className="text-[11px] tracking-[0.42em] text-needle-300/70">OBJECTIVE</div>
          <div className="text-shadow-hud text-lg font-semibold tracking-[0.14em] text-needle-100">
            {objective.text}
          </div>
          {objective.sub && (
            <div className="text-[11px] tracking-[0.18em] text-needle-300/60">{objective.sub}</div>
          )}
        </div>
      )}

      {/* ---- spectacle callout (Blue Angels pass, hydro heat, etc) ---- */}
      {spectacle && (
        <div className="absolute left-1/2 top-1/4 -translate-x-1/2 text-center">
          <div className="text-shadow-hud animate-hud-flicker text-2xl font-bold tracking-[0.2em] text-hydro-gold">
            {spectacle}
          </div>
        </div>
      )}

      {/* ---- ammo, bottom-right ---- */}
      <div className="absolute bottom-6 right-6 safe-b text-right">
        <div className="text-[10px] tracking-[0.3em] text-needle-300/65">{weapon.name}</div>
        <div className="text-shadow-hud font-mono text-5xl font-semibold leading-none text-needle-100">
          {weapon.ammo}
          <span className="ml-2 align-baseline text-xl text-needle-300/60">/ {weapon.reserve}</span>
        </div>
        {reloading > 0.01 && (
          <div className="mt-2 h-[4px] w-40 overflow-hidden border border-needle-300/40 bg-black/50">
            <div
              className="h-full bg-needle-300"
              style={{ width: `${100 - (reloading / (reloadRef.current || 1)) * 100}%` }}
            />
          </div>
        )}
      </div>

      {/* ---- score / combo ---- */}
      {score.score > 0 && (
        <div className="absolute right-6 top-6 safe-t text-right">
          <div className="text-[10px] tracking-[0.3em] text-needle-300/65">SCORE</div>
          <div className="font-mono text-2xl text-needle-100">{score.score.toLocaleString()}</div>
          {score.combo > 1 && (
            <div className="text-sm font-semibold text-hydro-gold">×{score.combo}</div>
          )}
        </div>
      )}

      {/* ---- kill feed / notifications ---- */}
      <div className="absolute bottom-28 left-6 safe-b space-y-1">
        {feed.map((f) => (
          <div
            key={f.id}
            className={`text-sm tracking-[0.1em] ${
              f.kind === "good"
                ? "text-emerald-300"
                : f.kind === "warn"
                  ? "text-amber-300"
                  : "text-needle-100/85"
            }`}
          >
            {f.text}
          </div>
        ))}
      </div>

      {/* ---- subtitles ---- */}
      {subtitle && (
        <div className="absolute bottom-24 left-1/2 w-[min(760px,88vw)] -translate-x-1/2 text-center">
          <span className="text-needle-300">{subtitle.speaker}: </span>
          <span className="text-needle-50">{subtitle.text}</span>
        </div>
      )}

      {/* ---- perf ---- */}
      {showFps && (
        <div className="absolute bottom-2 left-2 font-mono text-[10px] leading-tight text-needle-300/70">
          <div>
            {stats.fps} fps · {stats.ms} ms
          </div>
          <div>
            {stats.drawCalls} draws · {(stats.triangles / 1000).toFixed(0)}k tris
          </div>
          <div>{stats.tier}</div>
        </div>
      )}
    </div>
  );
}
