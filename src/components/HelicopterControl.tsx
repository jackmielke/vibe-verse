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
  Mountain,
  Bot,
  Users,
  Car,
  Menu,
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

export interface SpawnableControl {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  loading: boolean;
  // null when length isn't known yet (server didn't send Content-Length).
  progress: number | null;
  onToggle: () => void;
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
  // Unit-7 (resident bot)
  onMessageUnit7: () => void;
  unit7Scale: number;
  unit7ScaleMin: number;
  unit7ScaleMax: number;
  onUnit7ScaleChange: (v: number) => void;
  // Nimbus VTOL
  nimbus: NimbusControlState;
  onToggleNimbus: () => void;
  onTogglePilotNimbus: () => void;
  onResetNimbus: () => void;
  // Spawnable heavy GLBs (Edge Island, Death Star, …) — lazy-loaded.
  spawnables: SpawnableControl[];
}

type Tab = "characters" | "vehicles" | "spawn";

/**
 * Menu — unified control panel: Characters, Vehicles, and spawnable Worlds.
 * Hidden by default; tap the chip to expand.
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
  onMessageUnit7,
  unit7Scale,
  unit7ScaleMin,
  unit7ScaleMax,
  onUnit7ScaleChange,
  nimbus,
  onToggleNimbus,
  onTogglePilotNimbus,
  onResetNimbus,
  spawnables,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("characters");

  // Auto-open + auto-switch tabs when a mode engages
  useEffect(() => {
    if (state.pilotMode) {
      setOpen(true);
      setTab("vehicles");
    }
  }, [state.pilotMode]);
  useEffect(() => {
    if (vibey.walkMode) {
      setOpen(true);
      setTab("characters");
    }
  }, [vibey.walkMode]);
  useEffect(() => {
    if (nimbus.pilotMode) {
      setOpen(true);
      setTab("vehicles");
    }
  }, [nimbus.pilotMode]);

  const headingDeg = ((state.heading * 180) / Math.PI + 360) % 360;
  const vibeyHeadingDeg = ((vibey.heading * 180) / Math.PI + 360) % 360;
  const nimbusHeadingDeg = ((nimbus.heading * 180) / Math.PI + 360) % 360;
  const anySpawnableActive = spawnables.some((s) => s.enabled || s.loading);
  const anyVehicleActive = state.enabled || nimbus.enabled;
  const anyCharacterActive = vibey.walkMode;
  const anyActive = anyVehicleActive || anyCharacterActive || anySpawnableActive;

  return (
    <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-2">
      {/* Tab toggle */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="glass-panel rounded-lg px-2.5 py-2 flex items-center gap-1.5 hover:bg-muted transition-colors"
        title="Menu"
      >
        <Menu
          className={`w-4 h-4 ${anyActive ? "text-primary" : "text-muted-foreground"}`}
        />
        <span className="font-heading text-[10px] font-semibold tracking-widest uppercase text-foreground">
          Menu
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
            className="glass-panel rounded-xl p-3 w-[280px] flex flex-col gap-2.5"
          >
            {/* Tab switcher */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-background/40 border border-border">
              <TabButton
                active={tab === "characters"}
                onClick={() => setTab("characters")}
                icon={<Users className="w-3 h-3" />}
                label="Characters"
                live={anyCharacterActive}
              />
              <TabButton
                active={tab === "vehicles"}
                onClick={() => setTab("vehicles")}
                icon={<Car className="w-3 h-3" />}
                label="Vehicles"
                live={anyVehicleActive}
              />
              <TabButton
                active={tab === "spawn"}
                onClick={() => setTab("spawn")}
                icon={<Mountain className="w-3 h-3" />}
                label="Spawn"
                live={anySpawnableActive}
              />
            </div>

            {tab === "characters" && (
              <div className="flex flex-col gap-3">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Residents of Edge Esmeralda. Tap to chat or take controls.
                </p>

                {/* Vibey */}
                <CharacterRow
                  iconBg="bg-primary/15 border-primary/40"
                  icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}
                  name="Vibey"
                  subtitle="Community agent · floating above plaza"
                  live={vibey.walkMode}
                  liveLabel="WALKING"
                >
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={onMessageVibey}
                      className="flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                    >
                      <Sparkles className="w-3 h-3" /> Message
                    </button>
                    <button
                      onClick={onToggleVibeyWalk}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
                        vibey.walkMode
                          ? "bg-accent text-accent-foreground"
                          : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      <Footprints className="w-3 h-3" />
                      {vibey.walkMode ? "Stop" : "Walk"}
                    </button>
                  </div>
                  {vibey.walkMode && (
                    <>
                      <button
                        onClick={onResetVibey}
                        className="w-full flex items-center justify-center gap-1.5 text-[10px] font-body py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Home className="w-3 h-3" />
                        Return to plaza
                      </button>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="HDG" value={`${Math.round(vibeyHeadingDeg)}°`} />
                        <Stat label="MODE" value="WALK" />
                      </div>
                      <div className="space-y-0.5 text-[9px] font-mono text-muted-foreground leading-tight">
                        <p>↑/W forward · ↓/S back · ←/A turn · →/D turn · ESC stop</p>
                      </div>
                    </>
                  )}
                </CharacterRow>

                {/* Unit-7 */}
                <CharacterRow
                  iconBg="bg-primary/15 border-primary/40"
                  icon={<Bot className="w-3.5 h-3.5 text-primary" />}
                  name="Unit-7"
                  subtitle="Resident bot · wandering the streets"
                  live={false}
                >
                  <button
                    onClick={onMessageUnit7}
                    className="w-full flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                  >
                    <Bot className="w-3 h-3" /> Talk to Unit-7
                  </button>
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground mb-1">
                      <span>SIZE</span>
                      <span className="text-primary">{Math.round(unit7Scale)}m</span>
                    </div>
                    <input
                      type="range"
                      min={unit7ScaleMin}
                      max={unit7ScaleMax}
                      step={1}
                      value={unit7Scale}
                      onChange={(e) => onUnit7ScaleChange(Number(e.target.value))}
                      className="w-full h-1 bg-background/60 rounded-full accent-primary cursor-pointer"
                    />
                  </div>
                </CharacterRow>
              </div>
            )}

            {tab === "vehicles" && (
              <div className="flex flex-col gap-3">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Personal aircraft. Power on, then take controls to fly.
                </p>

                {/* Helicopter */}
                <VehicleRow
                  icon={<Plane className="w-3.5 h-3.5 text-primary" />}
                  name="Helicopter"
                  status={state.enabled ? "ONLINE" : "OFFLINE"}
                  live={state.enabled}
                >
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={onToggleEnabled}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
                        state.enabled
                          ? "bg-muted text-foreground hover:bg-muted/80"
                          : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      {state.enabled ? "Power Off" : "Spin Up"}
                    </button>
                    <button
                      onClick={onTogglePilot}
                      disabled={!state.enabled}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        state.pilotMode
                          ? "bg-accent text-accent-foreground"
                          : "bg-primary/15 text-primary hover:bg-primary/25"
                      }`}
                    >
                      <Gamepad2 className="w-3 h-3" />
                      {state.pilotMode ? "Release" : "Take"}
                    </button>
                  </div>
                  {state.enabled && (
                    <>
                      <button
                        onClick={onResetPosition}
                        className="w-full flex items-center justify-center gap-1.5 text-[10px] font-body py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Home className="w-3 h-3" />
                        Return to base
                      </button>
                      <div className="grid grid-cols-3 gap-1.5">
                        <Stat label="ALT" value={`${Math.round(state.altitude)}m`} />
                        <Stat label="HDG" value={`${Math.round(headingDeg)}°`} />
                        <Stat label="SPD" value={`${Math.round(state.speedKts)}kt`} />
                      </div>
                    </>
                  )}
                  {state.pilotMode && (
                    <div className="space-y-0.5 text-[9px] font-mono text-muted-foreground leading-tight">
                      <p>↑/↓ throttle · ←/→ turn · W/S climb · A/D strafe · ESC release</p>
                    </div>
                  )}
                </VehicleRow>

                {/* Nimbus VTOL */}
                <VehicleRow
                  icon={<Rocket className="w-3.5 h-3.5 text-primary" />}
                  name="Nimbus VTOL"
                  status={nimbus.enabled ? "ARMED" : "STOWED"}
                  live={nimbus.enabled}
                >
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={onToggleNimbus}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
                        nimbus.enabled
                          ? "bg-muted text-foreground hover:bg-muted/80"
                          : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      {nimbus.enabled ? "Power Off" : "Launch"}
                    </button>
                    <button
                      onClick={onTogglePilotNimbus}
                      disabled={!nimbus.enabled}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        nimbus.pilotMode
                          ? "bg-accent text-accent-foreground"
                          : "bg-primary/15 text-primary hover:bg-primary/25"
                      }`}
                    >
                      <Gamepad2 className="w-3 h-3" />
                      {nimbus.pilotMode ? "Release" : "Take"}
                    </button>
                  </div>
                  {nimbus.enabled && (
                    <>
                      <button
                        onClick={onResetNimbus}
                        className="w-full flex items-center justify-center gap-1.5 text-[10px] font-body py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Home className="w-3 h-3" />
                        Return to base
                      </button>
                      <div className="grid grid-cols-3 gap-1.5">
                        <Stat label="ALT" value={`${Math.round(nimbus.altitude)}m`} />
                        <Stat label="HDG" value={`${Math.round(nimbusHeadingDeg)}°`} />
                        <Stat label="SPD" value={`${Math.round(nimbus.speedKts)}kt`} />
                      </div>
                    </>
                  )}
                  {nimbus.pilotMode && (
                    <div className="space-y-0.5 text-[9px] font-mono text-muted-foreground leading-tight">
                      <p>↑/↓ throttle · ←/→ turn · W/S climb · A/D strafe · ESC release</p>
                    </div>
                  )}
                </VehicleRow>
              </div>
            )}

            {tab === "spawn" && (
              <div className="flex flex-col gap-3">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Spawn 3D worlds and objects above the village. Each loads on demand.
                </p>
                {spawnables.map((s) => (
                  <SpawnableRow key={s.id} item={s} />
                ))}
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

function CharacterRow({
  icon,
  iconBg,
  name,
  subtitle,
  live,
  liveLabel = "LIVE",
  children,
}: {
  icon: React.ReactNode;
  iconBg: string;
  name: string;
  subtitle: string;
  live: boolean;
  liveLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded-md border ${iconBg} flex items-center justify-center`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-heading text-[12px] font-semibold tracking-wide text-foreground leading-none">
            {name}
          </p>
          <p className="text-[10px] font-body text-muted-foreground leading-snug mt-0.5 truncate">
            {subtitle}
          </p>
        </div>
        {live && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-primary/20 text-primary">
            {liveLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function VehicleRow({
  icon,
  name,
  status,
  live,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  status: string;
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md border border-primary/40 bg-primary/15 flex items-center justify-center">
          {icon}
        </div>
        <p className="flex-1 font-heading text-[12px] font-semibold tracking-wide text-foreground leading-none">
          {name}
        </p>
        <span
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            live ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {status}
        </span>
      </div>
      {children}
    </div>
  );
}

function SpawnableRow({ item }: { item: SpawnableControl }) {
  const status = item.loading
    ? "LOADING"
    : item.enabled
      ? "AIRBORNE"
      : "GROUNDED";
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 p-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-heading text-[11px] font-semibold tracking-wider uppercase text-foreground">
          {item.label}
        </p>
        <span
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            item.enabled
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {status}
        </span>
      </div>
      <p className="text-[10.5px] font-body text-muted-foreground leading-snug">
        {item.description}
      </p>
      <button
        onClick={item.onToggle}
        disabled={item.loading}
        className={`w-full flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors disabled:opacity-60 ${
          item.enabled
            ? "bg-muted text-foreground hover:bg-muted/80"
            : "bg-primary text-primary-foreground hover:opacity-90"
        }`}
      >
        <Mountain className="w-3 h-3" />
        {item.loading
          ? "Streaming…"
          : item.enabled
            ? `Despawn ${item.label}`
            : `Spawn ${item.label}`}
      </button>
      {item.loading && (
        <div className="space-y-1">
          <div className="h-1 rounded-full bg-background/60 overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{
                width: item.progress != null ? `${Math.round(item.progress * 100)}%` : "30%",
              }}
            />
          </div>
          <p className="text-[9px] font-mono text-muted-foreground text-center">
            {item.progress != null
              ? `${Math.round(item.progress * 100)}%`
              : "downloading…"}
          </p>
        </div>
      )}
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
