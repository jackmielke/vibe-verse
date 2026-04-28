import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plane, ChevronUp, ChevronDown, Power, Gamepad2, Home } from "lucide-react";

export interface HelicopterControlState {
  enabled: boolean;
  pilotMode: boolean;
  altitude: number;
  speedKts: number; // for HUD display
  heading: number; // radians
}

interface Props {
  state: HelicopterControlState;
  onToggleEnabled: () => void;
  onTogglePilot: () => void;
  onResetPosition: () => void;
}

/**
 * Hidden-by-default helicopter control panel. Pinned to the right edge of the
 * map (above bottom controls). Click the tab to expand.
 */
export default function HelicopterControl({
  state,
  onToggleEnabled,
  onTogglePilot,
  onResetPosition,
}: Props) {
  const [open, setOpen] = useState(false);

  // Auto-open when pilot mode engages so HUD is visible
  useEffect(() => {
    if (state.pilotMode) setOpen(true);
  }, [state.pilotMode]);

  const headingDeg = ((state.heading * 180) / Math.PI + 360) % 360;

  return (
    <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-2">
      {/* Tab toggle */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="glass-panel rounded-lg px-2.5 py-2 flex items-center gap-1.5 hover:bg-muted transition-colors"
        title="Helicopter controls"
      >
        <Plane
          className={`w-4 h-4 ${state.enabled ? "text-primary" : "text-muted-foreground"}`}
        />
        {open ? (
          <ChevronUp className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.18 }}
            className="glass-panel rounded-xl p-3 w-[220px] flex flex-col gap-2.5"
          >
            <div className="flex items-center justify-between">
              <p className="font-heading text-[11px] font-semibold tracking-widest uppercase text-primary">
                Sky Patrol
              </p>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  state.enabled
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {state.enabled ? "ONLINE" : "OFFLINE"}
              </span>
            </div>

            <button
              onClick={onToggleEnabled}
              className={`w-full flex items-center justify-center gap-1.5 text-xs font-heading font-semibold py-2 rounded-lg transition-colors ${
                state.enabled
                  ? "bg-muted text-foreground hover:bg-muted/80"
                  : "bg-primary text-primary-foreground hover:opacity-90"
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              {state.enabled ? "Power Off" : "Spin Up"}
            </button>

            <button
              onClick={onTogglePilot}
              disabled={!state.enabled}
              className={`w-full flex items-center justify-center gap-1.5 text-xs font-heading font-semibold py-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                state.pilotMode
                  ? "bg-accent text-accent-foreground"
                  : "bg-primary/15 text-primary hover:bg-primary/25"
              }`}
            >
              <Gamepad2 className="w-3.5 h-3.5" />
              {state.pilotMode ? "Release Controls" : "Take Controls"}
            </button>

            {state.enabled && (
              <button
                onClick={onResetPosition}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] font-body py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
              >
                <Home className="w-3 h-3" />
                Return to base
              </button>
            )}

            {/* HUD */}
            {state.enabled && (
              <div className="grid grid-cols-3 gap-1.5 pt-1 border-t border-border">
                <Stat label="ALT" value={`${Math.round(state.altitude)}m`} />
                <Stat label="HDG" value={`${Math.round(headingDeg)}°`} />
                <Stat label="SPD" value={`${Math.round(state.speedKts)}kt`} />
              </div>
            )}

            {state.pilotMode && (
              <div className="pt-1 border-t border-border space-y-0.5 text-[10px] font-mono text-muted-foreground leading-tight">
                <p>↑/↓ throttle · ←/→ turn</p>
                <p>W/S climb · A/D strafe</p>
                <p>ESC release</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center bg-background/50 rounded-md py-1">
      <p className="text-[9px] font-mono text-muted-foreground tracking-wider">{label}</p>
      <p className="text-[11px] font-mono font-semibold text-primary">{value}</p>
    </div>
  );
}
