/**
 * The heads-up display.
 *
 * Composition only: every widget owns its own imperative update loop, and
 * this component's job is to place them, to pump the one-shot event queue
 * into the widgets that care, and to keep the store's notification list from
 * growing forever.
 *
 * Layout, deliberately conventional because conventions are what make a HUD
 * readable in the first three seconds:
 *
 *     ┌ minimap ─────── compass ──────── chaos / heat ┐
 *     │ objectives                       kill feed    │
 *     │              ·  reticle  ·                    │
 *     │ notifications                                 │
 *     └ vitals / rig ── vehicle ─────────── ammo ─────┘
 */
import { useEffect, useRef } from "react";
import { frame, useSfStore } from "../state/store";
import { useUiFrame } from "./raf";
import { useUiStore } from "./uiStore";
import { deriveTelemetry, drainHudEvents } from "./telemetry";
import Crosshair, { type CrosshairHandle } from "./hud/Crosshair";
import Vitals, { LowHealthOverlay } from "./hud/Vitals";
import Ammo from "./hud/Ammo";
import ChaosHeat from "./hud/ChaosHeat";
import Presence from "./hud/Presence";
import Compass from "./hud/Compass";
import Objectives from "./hud/Objectives";
import Feed from "./hud/Feed";
import Traversal from "./hud/Traversal";
import VehicleHud from "./hud/VehicleHud";
import WorldMarkers from "./hud/WorldMarkers";
import DamageIndicators, { type DamageHandle } from "./hud/DamageIndicators";
import WeaponWheel from "./hud/WeaponWheel";
import Prompt from "./hud/Prompt";
import Minimap from "./Minimap";
import WeatherChip from "./hud/WeatherChip";
import Notifications from "./Notifications";
import { postFx } from "../postfx/state";

export interface HudProps {
  /** Set false to suppress the gameplay HUD without unmounting the layer
   *  (photo mode, screenshot harness). */
  visible?: boolean;
  /** Hide everything that only means something when something is shooting. */
  peaceful?: boolean;
}

export default function Hud({ visible = true, peaceful = false }: HudProps) {
  const showHud = useSfStore((s) => s.showHud);
  const phase = useSfStore((s) => s.phase);
  const prune = useSfStore((s) => s.pruneNotifications);
  const on = visible && showHud && (phase === "playing" || phase === "paused");

  const crosshair = useRef<CrosshairHandle | null>(null);
  const damage = useRef<DamageHandle | null>(null);
  const pruneAcc = useRef(0);

  // One place drains the event queue and fans it out. If individual widgets
  // drained it they would starve each other — the second reader would find it
  // empty.
  useUiFrame((_, dt) => {
    deriveTelemetry();
    drainHudEvents((e) => {
      switch (e.kind) {
        case "hit":
          crosshair.current?.hit(false);
          break;
        case "headshot":
          crosshair.current?.hit(true);
          break;
        case "kill":
          crosshair.current?.kill();
          break;
        case "damage":
          crosshair.current?.damage(e.direction, e.amount);
          damage.current?.damage(e.direction, e.amount);
          // The post chain owns the red vignette; the HUD owns the arcs. Both
          // want the same event, and this is the only place that has it.
          postFx.triggerDamageFlash(Math.min(1, e.amount / 40), e.direction);
          break;
        default:
          break;
      }
    });

    // Retire old feed entries. Once a second is ample and keeps the store
    // write out of the per-frame path.
    pruneAcc.current += dt;
    if (pruneAcc.current > 1) {
      pruneAcc.current = 0;
      prune(frame.time);
    }
  }, on);

  // Push the interface settings into CSS custom properties once, rather than
  // threading them through every widget as props.
  const settings = useUiStore((s) => s.settings);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".sf-ui");
    if (!root) return;
    root.style.setProperty("--sf-hud-scale", String(settings.hudScale));
    root.style.setProperty("--sf-hud-opacity", String(settings.hudOpacity));
    root.style.setProperty(
      "--sf-subtitle-scale",
      settings.subtitleSize === "s" ? "0.85" : settings.subtitleSize === "l" ? "1.3" : settings.subtitleSize === "xl" ? "1.7" : "1",
    );
    root.dataset.cvd = settings.colorblind;
    root.dataset.reduceMotion = settings.reduceMotion ? "1" : "0";
  }, [settings]);

  if (!on) {
    // The wheel and the low-health treatment are gameplay-critical enough to
    // survive a HUD toggle only when the HUD is on; when it is off the screen
    // is genuinely clean, which is the point of the toggle.
    return null;
  }

  return (
    <>
      <WorldMarkers />
      {peaceful ? null : <DamageIndicators handleRef={damage} />}
      {peaceful ? null : <LowHealthOverlay />}

      <div className="sf-cluster" data-anchor="tl">
        <Minimap />
        {/* Under the map, because "where am I" and "what is it like here" are
            the same question asked twice. */}
        <WeatherChip />
        {peaceful ? null : (
          <div style={{ marginTop: 14 }}>
            <Objectives />
          </div>
        )}
      </div>

      <div className="sf-cluster" data-anchor="tc">
        <Compass />
      </div>

      <div className="sf-cluster" data-anchor="tr">
        {peaceful ? null : <ChaosHeat />}
        {/* Above the feed: who is here is a standing fact, not an event. */}
        <div style={{ marginTop: peaceful ? 0 : 12, display: "flex", justifyContent: "flex-end" }}>
          <Presence />
        </div>
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <Feed />
        </div>
      </div>

      <div className="sf-cluster" data-anchor="bl">
        <Vitals />
        <Traversal />
      </div>

      <div className="sf-cluster" data-anchor="bc">
        <VehicleHud />
      </div>

      {peaceful ? null : (
        <div className="sf-cluster" data-anchor="br">
          <Ammo />
        </div>
      )}

      {/* A crosshair with no weapon behind it is an invitation to look for the
          trigger. `Prompt` stays: it is what says "press F" next to a car. */}
      {peaceful ? null : <Crosshair handleRef={crosshair} />}
      <Prompt />
      <Notifications />
      {peaceful ? null : <WeaponWheel />}
      <Subtitles />
    </>
  );
}

/** Subtitle line. Tiny, but the accessibility settings promise it exists. */
function Subtitles() {
  const line = useUiStore((s) => s.subtitle);
  const enabled = useUiStore((s) => s.settings.subtitles);
  if (!enabled || !line) return null;
  return (
    <div
      className="sf-cluster sf-anim-fade"
      data-anchor="bc"
      style={{ bottom: "calc(var(--sf-edge) + 148px)", maxWidth: "60vw", textAlign: "center" }}
    >
      <span className="sf-subtitle sf-text">{line}</span>
    </div>
  );
}
