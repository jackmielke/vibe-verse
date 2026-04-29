import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plane,
  ChevronUp,
  ChevronDown,
  Power,
  Gamepad2,
  Home,
  Sparkles,
  Footprints,
  Rocket,
} from "lucide-react";

export interface HelicopterControlState {
  enabled: boolean;
  pilotMode: boolean;
  altitude: number;
  speedKts: number;
  heading: number;
}

export interface VibeyControlState {
  walkMode: boolean;
  heading: number;
}

export interface NimbusControlState {
  enabled: boolean;
  pilotMode: boolean;
  altitude: number;
  speedKts: number;
  heading: number;
}

interface Props {
  // Helicopter
  state: HelicopterControlState;
  onToggleEnabled: () => void;
  onTogglePilot: () => void;
  onResetPosition: () => void;
  // Vibey
  vibey: VibeyControlState;
  onToggleVibeyWalk: () => void;
  onResetVibey: () => void;
  onMessageVibey: () => void;
  // Nimbus VTOL
  nimbus: NimbusControlState;
  onToggleNimbus: () => void;
  onTogglePilotNimbus: () => void;
  onResetNimbus: () => void;
}

type Tab = "vibey" | "heli" | "nimbus";

/**
 * Sky Patrol — unified control panel for both Vibey and the helicopter.
 * Hidden by default; tap the chip to expand. Two tabs let you switch
 * between piloting Vibey on foot and flying the chopper.
 */
export default function HelicopterControl({
  state,
  onToggleEnabled,
  onTogglePilot,
  onResetPosition,
  vibey,
  onToggleVibeyWalk,
  onResetVibey,
  onMessageVibey,
  nimbus,
  onToggleNimbus,
  onTogglePilotNimbus,
  onResetNimbus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("vibey");

  // Auto-open + auto-switch tabs when a mode engages
  useEffect(() => {
    if (state.pilotMode) {
      setOpen(true);
      setTab("heli");
    }
  }, [state.pilotMode]);
  useEffect(() => {
    if (vibey.walkMode) {
      setOpen(true);
      setTab("vibey");
    }
  }, [vibey.walkMode]);
  useEffect(() => {
    if (nimbus.pilotMode) {
      setOpen(true);
      setTab("nimbus");
    }
  }, [nimbus.pilotMode]);

  const headingDeg = ((state.heading * 180) / Math.PI + 360) % 360;
  const vibeyHeadingDeg = ((vibey.heading * 180) / Math.PI + 360) % 360;
  const nimbusHeadingDeg = ((nimbus.heading * 180) / Math.PI + 360) % 360;
  const anyActive = state.enabled || vibey.walkMode || nimbus.enabled;

  return (
    <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-2">
      {/* Tab toggle */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="glass-panel rounded-lg px-2.5 py-2 flex items-center gap-1.5 hover:bg-muted transition-colors"
        title="Sky Patrol"
      >
        <Sparkles
          className={`w-4 h-4 ${anyActive ? "text-primary" : "text-muted-foreground"}`}
        />
        <span className="font-heading text-[10px] font-semibold tracking-widest uppercase text-foreground">
          Sky Patrol
        </span>
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
            className="glass-panel rounded-xl p-3 w-[240px] flex flex-col gap-2.5"
          >
            {/* Tab switcher */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-background/40 border border-border">
              <TabButton
                active={tab === "vibey"}
                onClick={() => setTab("vibey")}
                icon={<Sparkles className="w-3 h-3" />}
                label="Vibey"
                live={vibey.walkMode}
              />
              <TabButton
                active={tab === "heli"}
                onClick={() => setTab("heli")}
                icon={<Plane className="w-3 h-3" />}
                label="Chopper"
                live={state.enabled}
              />
            </div>

            {tab === "vibey" && (
              <div className="flex flex-col gap-2.5">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Vibey is your community agent. Walk around as Vibey or send a message.
                </p>

                <button
                  onClick={onToggleVibeyWalk}
                  className={`w-full flex items-center justify-center gap-1.5 text-xs font-heading font-semibold py-2 rounded-lg transition-colors ${
                    vibey.walkMode
                      ? "bg-accent text-accent-foreground"
                      : "bg-primary text-primary-foreground hover:opacity-90"
                  }`}
                >
                  <Footprints className="w-3.5 h-3.5" />
                  {vibey.walkMode ? "Stop Walking" : "Walk as Vibey"}
                </button>

                <button
                  onClick={onMessageVibey}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-heading font-semibold py-2 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Message Vibey
                </button>

                {vibey.walkMode && (
                  <>
                    <button
                      onClick={onResetVibey}
                      className="w-full flex items-center justify-center gap-1.5 text-[11px] font-body py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Home className="w-3 h-3" />
                      Return to plaza
                    </button>

                    <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-border">
                      <Stat label="HDG" value={`${Math.round(vibeyHeadingDeg)}°`} />
                      <Stat label="MODE" value="WALK" />
                    </div>

                    <div className="pt-1 border-t border-border space-y-0.5 text-[10px] font-mono text-muted-foreground leading-tight">
                      <p>↑/W forward · ↓/S back</p>
                      <p>←/A turn left · →/D turn right</p>
                      <p>ESC stop</p>
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === "heli" && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <p className="font-heading text-[11px] font-semibold tracking-widest uppercase text-primary">
                    Helicopter
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
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  live,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  live: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
        active
          ? "bg-primary/20 text-primary"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
      {live && (
        <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </button>
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
