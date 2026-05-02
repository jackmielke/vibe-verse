import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Volume2,
  VolumeX,
  Sun,
  Moon,
  Gauge,
  Map as MapIcon,
  Compass,
} from "lucide-react";
import type { HudState } from "@/world/types";
import type { WorldRuntime } from "@/world/engine";
import {
  BLOCK,
  BLOCKS_PER_SIDE,
  GRID_HALF,
} from "@/world/terrain";

interface Props {
  runtime: WorldRuntime | null;
}

function formatTime(t: number) {
  const hh = Math.floor((t * 24 + 6) % 24); // shift so 0.0 ≈ 06:00
  const mm = Math.floor(((t * 24 + 6) % 1) * 60);
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

function Minimap({ runtime }: { runtime: WorldRuntime }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    const SCALE = 0.6; // world meters per pixel inverse — bigger = zoomed in
    let raf = 0;

    const landmarks = runtime.getLandmarks();

    const draw = () => {
      const mode = runtime.getMode();
      const p = mode === "walking" ? runtime.getPlayerPos() : runtime.getVehiclePos();
      const cam = runtime.getCamera();
      const heading = Math.atan2(
        cam.position.x - p.x,
        cam.position.z - p.z,
      );
      // Player faces +Z when heading=0; heading angle = atan2(sin, cos) → invert.
      const facing = -heading + Math.PI;

      ctx.clearRect(0, 0, W, H);
      // disc background
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(13, 27, 42, 0.78)";
      ctx.fill();
      ctx.clip();

      // grass
      ctx.fillStyle = "#2c4a2c";
      ctx.fillRect(0, 0, W, H);

      // city block area
      const cityCover = BLOCKS_PER_SIDE * BLOCK;
      ctx.fillStyle = "#3e3e44";
      const cx = W / 2 - p.x * SCALE;
      const cz = H / 2 - p.z * SCALE;
      ctx.fillRect(cx - (cityCover / 2) * SCALE, cz - (cityCover / 2) * SCALE, cityCover * SCALE, cityCover * SCALE);

      // road grid
      ctx.strokeStyle = "#5a5a60";
      ctx.lineWidth = 2;
      for (let i = 0; i <= BLOCKS_PER_SIDE; i++) {
        const wx = -GRID_HALF + i * BLOCK;
        const px1 = W / 2 + (wx - p.x) * SCALE;
        ctx.beginPath();
        ctx.moveTo(px1, cz - (cityCover / 2) * SCALE);
        ctx.lineTo(px1, cz + (cityCover / 2) * SCALE);
        ctx.stroke();
        const py1 = H / 2 + (wx - p.z) * SCALE;
        ctx.beginPath();
        ctx.moveTo(cx - (cityCover / 2) * SCALE, py1);
        ctx.lineTo(cx + (cityCover / 2) * SCALE, py1);
        ctx.stroke();
      }

      // landmarks
      ctx.fillStyle = "#2dd4a8";
      for (const lm of landmarks) {
        const lx = W / 2 + (lm.x - p.x) * SCALE;
        const ly = H / 2 + (lm.z - p.z) * SCALE;
        if (lx < 0 || lx > W || ly < 0 || ly > H) continue;
        ctx.beginPath();
        ctx.arc(lx, ly, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // vehicle dot when walking
      if (mode === "walking") {
        const vp = runtime.getVehiclePos();
        const vx = W / 2 + (vp.x - p.x) * SCALE;
        const vy = H / 2 + (vp.z - p.z) * SCALE;
        ctx.fillStyle = "#ff5a5a";
        ctx.beginPath();
        ctx.arc(vx, vy, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // player arrow
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(facing);
      ctx.fillStyle = mode === "driving" ? "#fbbf24" : "#73ffb8";
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // disc border
      ctx.restore();
      ctx.strokeStyle = "rgba(45, 212, 168, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [runtime]);

  return (
    <canvas
      ref={canvasRef}
      width={180}
      height={180}
      className="rounded-full"
      style={{ filter: "drop-shadow(0 0 12px rgba(45, 212, 168, 0.25))" }}
    />
  );
}

export default function WorldHUD({ runtime }: Props) {
  const [hud, setHud] = useState<HudState | null>(null);
  const [showHelp, setShowHelp] = useState(true);

  useEffect(() => {
    if (!runtime) return;
    const off = runtime.onHud(setHud);
    const t = setTimeout(() => setShowHelp(false), 8000);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [runtime]);

  if (!runtime || !hud) return null;

  const driving = hud.mode === "driving";
  const speedDisplay = Math.round(hud.speedKph);
  const cardinal = (() => {
    const deg = ((hud.heading * 180) / Math.PI + 360) % 360;
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.floor(((deg + 22.5) % 360) / 45)];
  })();

  return (
    <div className="pointer-events-none absolute inset-0 z-10 font-body text-foreground">
      {/* Master tab nav — top center */}
      <div className="pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 flex gap-1 glass-panel rounded-full px-1.5 py-1.5">
        <Link
          to="/"
          className="px-3 py-1 rounded-full text-xs font-semibold tracking-wider uppercase text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="inline-flex items-center gap-1.5">
            <MapIcon className="w-3.5 h-3.5" /> Village
          </span>
        </Link>
        <span className="px-3 py-1 rounded-full text-xs font-semibold tracking-wider uppercase bg-primary/15 text-primary">
          World
        </span>
      </div>

      {/* Top-left brand */}
      <div className="pointer-events-auto absolute top-3 left-3 glass-panel rounded-xl px-3 py-2">
        <p className="font-heading text-[10px] font-semibold tracking-[0.18em] uppercase text-primary leading-none">
          Edge Esmeralda
        </p>
        <p className="font-heading text-base font-semibold leading-tight">World</p>
      </div>

      {/* Top-right: time + mute + day/night toggle */}
      <div className="pointer-events-auto absolute top-3 right-3 flex items-center gap-2">
        <div className="glass-panel rounded-xl px-3 py-2 flex items-center gap-2">
          {hud.timeOfDay > 0.22 && hud.timeOfDay < 0.78 ? (
            <Sun className="w-4 h-4 text-primary" />
          ) : (
            <Moon className="w-4 h-4 text-primary" />
          )}
          <span className="font-mono text-xs">{formatTime(hud.timeOfDay)}</span>
        </div>
        <button
          onClick={() => runtime.toggleDayNight()}
          className="glass-panel rounded-xl p-2 hover:bg-muted transition-colors"
          title="Pause/resume day/night"
        >
          <Sun className="w-4 h-4 text-primary" />
        </button>
        <button
          onClick={() => runtime.toggleMute()}
          className="glass-panel rounded-xl p-2 hover:bg-muted transition-colors"
          title={hud.muted ? "Unmute" : "Mute"}
        >
          {hud.muted ? (
            <VolumeX className="w-4 h-4 text-muted-foreground" />
          ) : (
            <Volume2 className="w-4 h-4 text-primary" />
          )}
        </button>
      </div>

      {/* Bottom-left hint */}
      {(hud.hint || showHelp) && (
        <div className="absolute bottom-4 left-4 glass-panel rounded-xl px-3 py-2 max-w-[420px]">
          <p className="text-xs text-muted-foreground">
            {driving
              ? "WASD drive • Space handbrake • F exit • M mute • N day/night"
              : "Click canvas to look • WASD move • Shift run • Space jump • F enter car • M mute"}
          </p>
        </div>
      )}

      {/* Bottom-right: speedometer + heading + minimap */}
      <div className="absolute bottom-4 right-4 flex flex-col items-end gap-3">
        <Minimap runtime={runtime} />
        <div className="flex items-stretch gap-2">
          <div className="glass-panel rounded-xl px-3 py-2 flex items-center gap-2">
            <Compass className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm">{cardinal}</span>
          </div>
          <div className="glass-panel rounded-xl px-3 py-2 flex items-center gap-2">
            <Gauge className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm">
              {speedDisplay} <span className="text-[10px] text-muted-foreground">km/h</span>
            </span>
          </div>
        </div>
      </div>

      {/* Subtle crosshair when walking */}
      {!driving && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-primary/50" />
      )}
    </div>
  );
}
