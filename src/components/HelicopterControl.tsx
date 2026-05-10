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
  MapPin,
  Palette,
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

export interface PlaceControl {
  id: string;
  label: string;
  description: string;
  onFlyTo: () => void;
}

interface Props {
  // Visibility toggles for the lazy-loaded character GLBs. By default
  // none are spawned so the app stays light on first paint.
  vibeyVisible: boolean;
  onToggleVibey: () => void;
  unit7Visible: boolean;
  onToggleUnit7: () => void;
  alienVisible: boolean;
  onToggleAlien: () => void;
  vibePoliceVisible: boolean;
  onToggleVibePolice: () => void;
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
  unit7WalkMode: boolean;
  onToggleUnit7Walk: () => void;
  // Vibe Police
  vibePoliceScale: number;
  vibePoliceScaleMin: number;
  vibePoliceScaleMax: number;
  onVibePoliceScaleChange: (v: number) => void;
  // Nimbus VTOL
  nimbus: NimbusControlState;
  onToggleNimbus: () => void;
  onTogglePilotNimbus: () => void;
  onResetNimbus: () => void;
  // Spawnable heavy GLBs (Edge Island, Death Star, …) — lazy-loaded.
  spawnables: SpawnableControl[];
  // Quick-travel destinations (Edge Esmeralda, San Francisco, …).
  places: PlaceControl[];
  styleConfig: StyleConfig;
  onStyleConfigChange: (next: StyleConfig) => void;
}

type Tab = "characters" | "vehicles" | "spawn" | "places" | "style";

export type StyleConfig = {
  lightPreset: "auto" | "dawn" | "day" | "dusk" | "night";
  theme: "default" | "faded" | "monochrome";
  showPois: boolean;
  showRoads: boolean;
  showPlaces: boolean;
  showTransit: boolean;
  showLandmarks: boolean;
  show3d: boolean;
};

export const DEFAULT_STYLE_CONFIG: StyleConfig = {
  lightPreset: "auto",
  theme: "default",
  showPois: true,
  showRoads: true,
  showPlaces: true,
  showTransit: false,
  showLandmarks: true,
  show3d: true,
};

/**
 * Menu — unified control panel: Characters, Vehicles, and spawnable Worlds.
 * Hidden by default; tap the chip to expand.
 */
export default function HelicopterControl({
  vibeyVisible,
  onToggleVibey,
  unit7Visible,
  onToggleUnit7,
  alienVisible,
  onToggleAlien,
  vibePoliceVisible,
  onToggleVibePolice,
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
  unit7WalkMode,
  onToggleUnit7Walk,
  vibePoliceScale,
  vibePoliceScaleMin,
  vibePoliceScaleMax,
  onVibePoliceScaleChange,
  nimbus,
  onToggleNimbus,
  onTogglePilotNimbus,
  onResetNimbus,
  spawnables,
  places,
  styleConfig,
  onStyleConfigChange,
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
  const anyCharacterActive = vibey.walkMode || unit7WalkMode;
  const anyActive = anyVehicleActive || anyCharacterActive || anySpawnableActive;

  return (
    <div className="absolute top-24 right-4 z-20 flex flex-col items-end gap-2">
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
            className="glass-panel rounded-xl p-3 w-[320px] max-w-[calc(100vw-1.5rem)] flex flex-col gap-2.5"
          >
            {/* Tab switcher — icons stacked over labels so 5 fit
                comfortably without the text getting clipped. */}
            <div className="grid grid-cols-5 gap-1 p-1 rounded-lg bg-background/40 border border-border">
              <TabButton
                active={tab === "characters"}
                onClick={() => setTab("characters")}
                icon={<Users className="w-3 h-3" />}
                label="Cast"
                live={anyCharacterActive}
              />
              <TabButton
                active={tab === "vehicles"}
                onClick={() => setTab("vehicles")}
                icon={<Car className="w-3 h-3" />}
                label="Rides"
                live={anyVehicleActive}
              />
              <TabButton
                active={tab === "spawn"}
                onClick={() => setTab("spawn")}
                icon={<Mountain className="w-3 h-3" />}
                label="Spawn"
                live={anySpawnableActive}
              />
              <TabButton
                active={tab === "places"}
                onClick={() => setTab("places")}
                icon={<MapPin className="w-3 h-3" />}
                label="Places"
                live={false}
              />
              <TabButton
                active={tab === "style"}
                onClick={() => setTab("style")}
                icon={<Palette className="w-3 h-3" />}
                label="Style"
                live={false}
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
                  subtitle="Community agent · loads on demand"
                  live={vibey.walkMode}
                  liveLabel="WALKING"
                >
                  <SpawnToggle
                    spawned={vibeyVisible}
                    onToggle={onToggleVibey}
                    label="Vibey"
                  />
                  {vibeyVisible && (
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
                  )}
                  {vibeyVisible && vibey.walkMode && (
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
                  subtitle="Resident bot · loads on demand"
                  live={unit7WalkMode}
                  liveLabel="WALKING"
                >
                  <SpawnToggle
                    spawned={unit7Visible}
                    onToggle={onToggleUnit7}
                    label="Unit-7"
                  />
                  {unit7Visible && (<>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={onMessageUnit7}
                      className="flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                    >
                      <Bot className="w-3 h-3" /> Talk
                    </button>
                    <button
                      onClick={onToggleUnit7Walk}
                      className={`flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
                        unit7WalkMode
                          ? "bg-accent text-accent-foreground"
                          : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      <Footprints className="w-3 h-3" />
                      {unit7WalkMode ? "Stop" : "Walk"}
                    </button>
                  </div>
                  {unit7WalkMode && (
                    <div className="space-y-0.5 text-[9px] font-mono text-muted-foreground leading-tight">
                      <p>↑/W forward · ↓/S back · ←/A turn · →/D turn · ESC stop</p>
                    </div>
                  )}
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
                  </>)}
                </CharacterRow>

                {/* Vibe Police */}
                <CharacterRow
                  iconBg="bg-blue-500/15 border-blue-400/40"
                  icon={<Bot className="w-3.5 h-3.5 text-blue-400" />}
                  name="Vibe Police"
                  subtitle="Anti-vibe officer · loads on demand"
                  live={false}
                >
                  <SpawnToggle
                    spawned={vibePoliceVisible}
                    onToggle={onToggleVibePolice}
                    label="Vibe Police"
                  />
                  {vibePoliceVisible && (
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground mb-1">
                      <span>SIZE</span>
                      <span className="text-primary">{Math.round(vibePoliceScale)}m</span>
                    </div>
                    <input
                      type="range"
                      min={vibePoliceScaleMin}
                      max={vibePoliceScaleMax}
                      step={1}
                      value={vibePoliceScale}
                      onChange={(e) => onVibePoliceScaleChange(Number(e.target.value))}
                      className="w-full h-1 bg-background/60 rounded-full accent-primary cursor-pointer"
                    />
                  </div>
                  )}
                </CharacterRow>

                {/* Alien (Quaternius animated visitor) */}
                <CharacterRow
                  iconBg="bg-violet-500/15 border-violet-400/40"
                  icon={<Sparkles className="w-3.5 h-3.5 text-violet-300" />}
                  name="Alien"
                  subtitle="Quaternius visitor · animated · loads on demand"
                  live={false}
                >
                  <SpawnToggle
                    spawned={alienVisible}
                    onToggle={onToggleAlien}
                    label="Alien"
                  />
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

            {tab === "places" && (
              <div className="flex flex-col gap-3">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Travel anywhere on the planet. Mapbox 3D buildings render
                  city blocks for you on arrival.
                </p>
                {places.map((p) => (
                  <button
                    key={p.id}
                    onClick={p.onFlyTo}
                    className="rounded-lg border border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10 transition-colors p-2.5 flex flex-col gap-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-primary" />
                      <p className="font-heading text-[12px] font-semibold tracking-wide text-foreground leading-none">
                        {p.label}
                      </p>
                    </div>
                    <p className="text-[10.5px] font-body text-muted-foreground leading-snug">
                      {p.description}
                    </p>
                  </button>
                ))}
              </div>
            )}

            {tab === "style" && (
              <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-0.5">
                <p className="text-[11px] font-body text-muted-foreground leading-snug">
                  Tweak Mapbox's basemap natively — no style swap. Auto
                  light follows Pacific Time.
                </p>

                {/* Light preset */}
                <div>
                  <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-1.5">
                    Light
                  </p>
                  <div className="grid grid-cols-5 gap-1">
                    {(["auto", "dawn", "day", "dusk", "night"] as const).map((p) => {
                      const on = styleConfig.lightPreset === p;
                      return (
                        <button
                          key={p}
                          onClick={() =>
                            onStyleConfigChange({ ...styleConfig, lightPreset: p })
                          }
                          className={`rounded-md border px-1 py-1.5 text-[10px] font-heading font-semibold tracking-wider uppercase transition-colors ${
                            on
                              ? "border-primary/60 bg-primary/20 text-primary"
                              : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                          }`}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Theme */}
                <div>
                  <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-1.5">
                    Theme
                  </p>
                  <div className="grid grid-cols-3 gap-1">
                    {(["default", "faded", "monochrome"] as const).map((t) => {
                      const on = styleConfig.theme === t;
                      return (
                        <button
                          key={t}
                          onClick={() =>
                            onStyleConfigChange({ ...styleConfig, theme: t })
                          }
                          className={`rounded-md border px-1 py-1.5 text-[10px] font-heading font-semibold tracking-wider uppercase transition-colors ${
                            on
                              ? "border-primary/60 bg-primary/20 text-primary"
                              : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                          }`}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Show toggles */}
                <div>
                  <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-1.5">
                    Show
                  </p>
                  <div className="flex flex-col gap-1">
                    {([
                      ["showPois", "POI labels"],
                      ["showRoads", "Road labels"],
                      ["showPlaces", "Place labels"],
                      ["showLandmarks", "Landmark icons"],
                      ["showTransit", "Transit labels"],
                      ["show3d", "3D buildings"],
                    ] as const).map(([key, label]) => {
                      const on = styleConfig[key];
                      return (
                        <button
                          key={key}
                          onClick={() =>
                            onStyleConfigChange({ ...styleConfig, [key]: !on })
                          }
                          className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition-colors ${
                            on
                              ? "bg-primary/15 text-foreground"
                              : "bg-background/30 text-muted-foreground hover:bg-muted/30"
                          }`}
                        >
                          <span>{label}</span>
                          <span
                            className={`relative inline-block w-7 h-3.5 rounded-full transition-colors ${
                              on ? "bg-primary/80" : "bg-muted/50"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-foreground transition-all ${
                                on ? "left-3.5" : "left-0.5"
                              }`}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={() => onStyleConfigChange(DEFAULT_STYLE_CONFIG)}
                  className="text-[10.5px] text-muted-foreground hover:text-foreground transition-colors mt-1"
                >
                  Reset to defaults
                </button>
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
      className={`relative flex flex-col items-center justify-center gap-0.5 text-[10px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
        active
          ? "bg-primary/20 text-primary"
          : "text-muted-foreground hover:text-foreground"
      }`}
      title={label}
    >
      {icon}
      <span className="leading-none">{label}</span>
      {live && (
        <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </button>
  );
}

function SpawnToggle({
  spawned,
  onToggle,
  label,
}: {
  spawned: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center justify-center gap-1.5 text-[11px] font-heading font-semibold py-1.5 rounded-md transition-colors ${
        spawned
          ? "bg-muted text-foreground hover:bg-muted/80"
          : "bg-primary text-primary-foreground hover:opacity-90"
      }`}
    >
      <Power className="w-3 h-3" />
      {spawned ? `Despawn ${label}` : `Spawn ${label}`}
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
