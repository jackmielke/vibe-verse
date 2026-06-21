/**
 * LobbyCelebration — fires a celebration when a new agent appears in the
 * /world lobby. Two distinct effects so the entrance always feels right:
 *
 *  • Human   (agent_key starts with "human-") → Neon Mint Fireworks
 *    + warm "✨ Name joined" banner.
 *  • Agent   (anything else)                 → Digital Particle Swarm
 *    + holographic "▣ Name connected" banner.
 *
 * On the very first poll we silently seed the "seen" set so existing
 * occupants don't all fire celebrations when you open the page.
 *
 * Respects `prefers-reduced-motion` — falls back to just the banner.
 */
import { useEffect, useRef, useState } from "react";

type Arrival = {
  id: number;
  key: string;
  name: string;
  color: string;
  kind: "human" | "agent";
  startedAt: number;
};

interface Agent {
  agent_key: string;
  name: string;
  color: string;
  status: string;
}

interface Props {
  agents: Agent[];
  selfKey: string;
}

const FIREWORK_MS = 2200;
const SWARM_MS = 2400;
const BANNER_MS = 3200;

export default function LobbyCelebration({ agents, selfKey }: Props) {
  const seededRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arrivalsRef = useRef<Arrival[]>([]);
  const rafRef = useRef<number | null>(null);
  const idRef = useRef(0);
  const [banners, setBanners] = useState<Arrival[]>([]);

  // Detect new arrivals.
  useEffect(() => {
    const live = agents.filter((a) => a.status !== "away");
    if (!seededRef.current) {
      live.forEach((a) => seenRef.current.add(a.agent_key));
      seededRef.current = true;
      return;
    }
    const fresh = live.filter((a) => !seenRef.current.has(a.agent_key));
    if (!fresh.length) {
      // Forget those who left, so re-joins celebrate again.
      const liveKeys = new Set(live.map((a) => a.agent_key));
      seenRef.current.forEach((k) => {
        if (!liveKeys.has(k)) seenRef.current.delete(k);
      });
      return;
    }
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const now = performance.now();
    const newOnes: Arrival[] = fresh.map((a) => {
      seenRef.current.add(a.agent_key);
      const kind: Arrival["kind"] = a.agent_key.startsWith("human-")
        ? "human"
        : "agent";
      return {
        id: ++idRef.current,
        key: a.agent_key,
        name: a.agent_key === selfKey ? "You" : a.name || "Someone",
        color: a.color || (kind === "human" ? "#fde047" : "#38bdf8"),
        kind,
        startedAt: now,
      };
    });
    if (!reduced) arrivalsRef.current.push(...newOnes);
    setBanners((b) => [...b, ...newOnes]);
    // Banner auto-dismiss.
    newOnes.forEach((n) => {
      setTimeout(() => {
        setBanners((b) => b.filter((x) => x.id !== n.id));
      }, BANNER_MS);
    });
  }, [agents, selfKey]);

  // Canvas particle loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    type Particle = {
      x: number; y: number; vx: number; vy: number;
      life: number; max: number; color: string; size: number;
      grav: number; trail?: boolean;
    };
    const particles: Particle[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const spawnHumanFireworks = (a: Arrival) => {
      // Two bursts at slightly offset positions, mint + accent color.
      const W = window.innerWidth, H = window.innerHeight;
      const palette = ["#73ffb8", "#a5f3d0", "#fde047", a.color, "#ffffff"];
      const bursts = [
        { x: W * 0.35, y: H * 0.35 },
        { x: W * 0.65, y: H * 0.4 },
      ];
      bursts.forEach((b, i) => {
        setTimeout(() => {
          const n = 70;
          for (let j = 0; j < n; j++) {
            const angle = (Math.PI * 2 * j) / n + Math.random() * 0.2;
            const speed = 180 + Math.random() * 160;
            particles.push({
              x: b.x, y: b.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 0, max: 1.6 + Math.random() * 0.5,
              color: palette[Math.floor(Math.random() * palette.length)],
              size: 2 + Math.random() * 2.5,
              grav: 220, trail: true,
            });
          }
        }, i * 220);
      });
    };

    const spawnAgentSwarm = (a: Arrival) => {
      // Particles converge inward from edges toward a center point,
      // then dissipate. Feels like a digital materialization.
      const W = window.innerWidth, H = window.innerHeight;
      const cx = W * 0.5, cy = H * 0.45;
      const palette = ["#38bdf8", "#73ffb8", a.color, "#a5f3fc"];
      for (let j = 0; j < 140; j++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 280 + Math.random() * 320;
        const sx = cx + Math.cos(angle) * radius;
        const sy = cy + Math.sin(angle) * radius;
        // Velocity pointing toward center.
        const dx = cx - sx, dy = cy - sy;
        const len = Math.hypot(dx, dy) || 1;
        const speed = 200 + Math.random() * 180;
        particles.push({
          x: sx, y: sy,
          vx: (dx / len) * speed,
          vy: (dy / len) * speed,
          life: 0, max: 1.4 + Math.random() * 0.4,
          color: palette[Math.floor(Math.random() * palette.length)],
          size: 1.4 + Math.random() * 1.4,
          grav: 0, trail: false,
        });
      }
    };

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      // Spawn pending arrivals.
      while (arrivalsRef.current.length) {
        const a = arrivalsRef.current.shift()!;
        if (a.kind === "human") spawnHumanFireworks(a);
        else spawnAgentSwarm(a);
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "lighter";

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.max) { particles.splice(i, 1); continue; }
        p.vy += p.grav * dt;
        // Slight air drag.
        p.vx *= 1 - dt * 0.6;
        p.vy *= 1 - dt * 0.6;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const t = p.life / p.max;
        const alpha = 1 - t;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.trail ? 12 : 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 z-[60]"
        aria-hidden
      />
      <div className="pointer-events-none fixed top-24 left-1/2 -translate-x-1/2 z-[61] flex flex-col items-center gap-2">
        {banners.map((b) => (
          <div
            key={b.id}
            className={
              "animate-fade-in rounded-full px-4 py-2 text-sm font-medium backdrop-blur-md border shadow-lg " +
              (b.kind === "human"
                ? "bg-emerald-400/15 border-emerald-300/40 text-emerald-100"
                : "bg-cyan-400/10 border-cyan-300/40 text-cyan-100 font-mono tracking-wide")
            }
            style={{
              boxShadow: `0 0 24px ${b.color}55`,
            }}
          >
            {b.kind === "human" ? (
              <>✨ <span className="font-semibold">{b.name}</span> joined the lobby</>
            ) : (
              <>▣ <span className="font-semibold">{b.name}</span> connected</>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
