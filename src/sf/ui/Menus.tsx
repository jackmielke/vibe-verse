/**
 * Main menu, pause, settings, controls and credits.
 *
 * One component tree, one route enum, one visual language: a full-bleed dark
 * field, a left rail of destinations, and a right pane that changes. It is
 * the shape every shipped console menu has converged on because it survives
 * both a mouse and a stick, and because it keeps the game visible behind it.
 *
 * Settings write straight through to the systems that own them — quality goes
 * to `useSfStore.setQuality` so the change is a live preview rather than a
 * promise, audio goes to the mixer buses, lens settings go to the post chain.
 * A settings screen that requires a restart is a settings screen nobody
 * trusts.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { QUALITY, type QualityTier } from "../config";
import { SPAWNS, terrainHeight } from "../geo/sfGeo";
import { frame, resetFrame, useSfStore } from "../state/store";
import { postfx } from "../postfx/state";
import {
  ACTIONS,
  DEFAULT_SETTINGS,
  useUiStore,
  type SettingsTab,
  type UiSettings,
} from "./uiStore";
import { keyGlyph } from "./format";
import { COLORS, rgba, type CvdMode } from "./theme";

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function Menus() {
  const route = useUiStore((s) => s.route);
  if (route === "main") return <MainMenu />;
  if (route === "pause" || route === "settings" || route === "controls" || route === "credits") {
    return <PauseShell />;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Main menu
 * ------------------------------------------------------------------ */

function MainMenu() {
  const go = useUiStore((s) => s.go);
  const push = useUiStore((s) => s.push);
  const setPhase = useSfStore((s) => s.setPhase);
  const [spawn, setSpawn] = useState(SPAWNS[0].key);

  const start = () => {
    const sp = SPAWNS.find((s) => s.key === spawn) ?? SPAWNS[0];
    resetFrame(sp.x, terrainHeight(sp.x, sp.z) + sp.yOffset, sp.z, sp.heading);
    frame.paused = false;
    setPhase("playing");
    go("none");
  };

  return (
    <div
      className="fixed inset-0 sf-pe sf-anim-fade"
      style={{
        zIndex: 60,
        background:
          "linear-gradient(100deg, rgba(4,5,8,0.97) 0%, rgba(4,5,8,0.86) 42%, rgba(4,5,8,0.18) 100%)",
      }}
    >
      <div className="absolute" style={{ left: 84, top: 96, width: 460 }}>
        <div className="flex items-center gap-3 mb-4">
          <div style={{ width: 40, height: 2, background: COLORS.signal }} />
          <span className="sf-label" style={{ fontSize: 9, letterSpacing: "0.42em", color: COLORS.signal }}>
            VIBEVERSE
          </span>
        </div>
        <h1
          className="sf-display"
          style={{ fontSize: 64, lineHeight: 0.88, letterSpacing: "-0.045em" }}
        >
          SAN
          <br />
          FRANCISCO
        </h1>
        <span
          className="sf-display block mt-2"
          style={{ fontSize: 23, letterSpacing: "0.22em", color: COLORS.signal }}
        >
          FREE FALL
        </span>

        <div className="mt-10 flex flex-col gap-1.5" style={{ width: 320 }}>
          <button className="sf-btn" data-primary="1" onClick={start}>
            ENTER THE CITY
          </button>
          <button className="sf-btn" onClick={() => push("settings")}>
            SETTINGS
          </button>
          <button className="sf-btn" onClick={() => push("controls")}>
            CONTROLS
          </button>
          <button className="sf-btn" onClick={() => push("credits")}>
            CREDITS
          </button>
          <a className="sf-btn" href="/" style={{ textDecoration: "none" }}>
            LEAVE FOR THE HUB
          </a>
        </div>

        <div className="mt-8" style={{ width: 460 }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.28em" }}>
              DROP POINT
            </span>
            <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.12)" }} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SPAWNS.map((s) => (
              <button
                key={s.key}
                className="sf-chip"
                data-on={s.key === spawn ? "1" : "0"}
                onClick={() => setSpawn(s.key)}
              >
                {s.name}
              </button>
            ))}
          </div>
          <p className="sf-text mt-3" style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", minHeight: 30 }}>
            {SPAWNS.find((s) => s.key === spawn)?.blurb}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pause shell — hosts pause, settings, controls, credits
 * ------------------------------------------------------------------ */

function PauseShell() {
  const route = useUiStore((s) => s.route);
  const go = useUiStore((s) => s.go);
  const push = useUiStore((s) => s.push);
  const back = useUiStore((s) => s.back);
  const setPhase = useSfStore((s) => s.setPhase);
  const phase = useSfStore((s) => s.phase);

  const resume = () => {
    go("none");
    frame.paused = false;
    if (phase === "paused") setPhase("playing");
  };

  return (
    <div
      className="fixed inset-0 sf-pe sf-anim-fade"
      style={{
        zIndex: 60,
        background: "linear-gradient(90deg, rgba(3,4,7,0.96) 0%, rgba(3,4,7,0.82) 46%, rgba(3,4,7,0.42) 100%)",
        backdropFilter: "blur(6px) saturate(0.8)",
        WebkitBackdropFilter: "blur(6px) saturate(0.8)",
      }}
    >
      {/* Rail */}
      <div
        className="absolute"
        style={{ left: 0, top: 0, bottom: 0, width: 300, padding: "72px 40px", borderRight: "1px solid rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-center gap-2 mb-1">
          <div style={{ width: 26, height: 2, background: COLORS.signal }} />
          <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.38em", color: COLORS.signal }}>
            PAUSED
          </span>
        </div>
        <h2 className="sf-display" style={{ fontSize: 27, lineHeight: 1, letterSpacing: "-0.03em" }}>
          SAN FRANCISCO
        </h2>
        <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.3em" }}>
          FREE FALL
        </span>

        <div className="mt-10 flex flex-col gap-1.5">
          <button className="sf-btn" data-primary="1" onClick={resume}>
            RESUME
          </button>
          <button className="sf-btn" data-on={route === "settings" ? "1" : "0"} onClick={() => push("settings")}>
            SETTINGS
          </button>
          <button className="sf-btn" onClick={() => push("controls")}>
            CONTROLS
          </button>
          <button className="sf-btn" onClick={() => useUiStore.getState().go("map")}>
            MAP
          </button>
          <button className="sf-btn" onClick={() => push("credits")}>
            CREDITS
          </button>
          <button
            className="sf-btn"
            data-danger="1"
            onClick={() => {
              go("main");
              setPhase("menu");
            }}
          >
            QUIT TO MENU
          </button>
        </div>

        <div className="absolute" style={{ left: 40, right: 40, bottom: 40 }}>
          <div className="h-px mb-3" style={{ background: "rgba(255,255,255,0.1)" }} />
          <a
            href="/"
            className="sf-label sf-pe"
            style={{ fontSize: 8, letterSpacing: "0.24em", textDecoration: "none" }}
          >
            ← BACK TO THE VIBEVERSE
          </a>
        </div>
      </div>

      {/* Pane */}
      <div className="absolute sf-scroll" style={{ left: 300, right: 0, top: 0, bottom: 0, padding: "64px 56px" }}>
        {route === "settings" && <SettingsScreen />}
        {route === "controls" && <ControlsScreen />}
        {route === "credits" && <CreditsScreen />}
        {route === "pause" && <PauseSummary />}
      </div>

      {route !== "pause" && (
        <button className="sf-chip absolute" style={{ right: 40, top: 36 }} onClick={back}>
          BACK
        </button>
      )}
    </div>
  );
}

function PauseSummary() {
  const chaos = useSfStore((s) => s.chaos);
  const heat = useSfStore((s) => s.heat);
  const discovered = useSfStore((s) => s.discovered);
  const objectives = useSfStore((s) => s.objectives);
  const fps = useSfStore((s) => s.fps);
  const drawCalls = useSfStore((s) => s.drawCalls);
  const tris = useSfStore((s) => s.triangles);

  return (
    <div style={{ maxWidth: 720 }}>
      <SectionHead>SESSION</SectionHead>
      <div className="grid grid-cols-4 gap-6 mb-10">
        <BigStat label="CHAOS" value={chaos.toLocaleString()} tint={COLORS.chaos} />
        <BigStat label="HEAT" value={String(Math.round(heat))} tint={COLORS.heat} />
        <BigStat label="LANDMARKS" value={`${discovered.length}/22`} tint="#fff" />
        <BigStat
          label="OBJECTIVES"
          value={`${objectives.filter((o) => o.complete).length}/${objectives.length}`}
          tint={COLORS.signal}
        />
      </div>

      <SectionHead>PERFORMANCE</SectionHead>
      <div className="grid grid-cols-3 gap-6">
        <BigStat label="FPS" value={String(fps)} tint={fps >= 55 ? COLORS.good : fps >= 35 ? COLORS.warn : COLORS.danger} />
        <BigStat label="DRAW CALLS" value={String(drawCalls)} tint="#fff" />
        <BigStat label="TRIANGLES" value={`${(tris / 1e6).toFixed(2)}M`} tint="#fff" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "graphics", label: "GRAPHICS" },
  { id: "controls", label: "GAMEPLAY" },
  { id: "audio", label: "AUDIO" },
  { id: "interface", label: "INTERFACE" },
  { id: "accessibility", label: "ACCESSIBILITY" },
];

function SettingsScreen() {
  const tab = useUiStore((s) => s.settingsTab);
  const setTab = useUiStore((s) => s.setSettingsTab);
  const settings = useUiStore((s) => s.settings);
  const set = useUiStore((s) => s.setSetting);
  const reset = useUiStore((s) => s.resetSettings);
  const quality = useSfStore((s) => s.quality);
  const setQuality = useSfStore((s) => s.setQuality);

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="flex items-center gap-2 mb-8">
        {TABS.map((t) => (
          <button key={t.id} className="sf-chip" data-on={tab === t.id ? "1" : "0"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button className="sf-chip" onClick={reset}>
          RESTORE DEFAULTS
        </button>
      </div>

      {tab === "graphics" && (
        <>
          <SectionHead>PRESET · LIVE PREVIEW</SectionHead>
          <div className="flex gap-2 mb-4">
            {(Object.keys(QUALITY) as QualityTier[]).map((t) => (
              <button
                key={t}
                className="sf-chip"
                data-on={quality === t ? "1" : "0"}
                onClick={() => {
                  setQuality(t);
                  set("quality", t);
                }}
                style={{ padding: "7px 16px", fontSize: 10 }}
              >
                {QUALITY[t].label}
              </button>
            ))}
          </div>
          <QualityPreview tier={quality} />

          <SectionHead>CAMERA</SectionHead>
          <Slider
            label="Field of view"
            value={settings.fov}
            min={65}
            max={110}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => {
              set("fov", v);
              // Live: the camera reads frame.fov every frame.
              frame.fov = v;
            }}
            hint="Vertical FOV. Higher reads faster in a wingsuit and costs a little clarity at range."
          />

          <SectionHead>LENS &amp; POST</SectionHead>
          <Slider label="Brightness" value={settings.brightness} min={0.6} max={1.6} step={0.01} format={pct} onChange={(v) => set("brightness", v)} />
          <Slider label="Film grain" value={settings.filmGrain} min={0} max={1.5} step={0.01} format={pct} onChange={(v) => set("filmGrain", v)} />
          <Slider label="Chromatic aberration" value={settings.chromaticAberration} min={0} max={1.5} step={0.01} format={pct} onChange={(v) => set("chromaticAberration", v)} />
          <Slider label="Vignette" value={settings.vignette} min={0} max={1.5} step={0.01} format={pct} onChange={(v) => set("vignette", v)} />
          <Slider label="Bloom" value={settings.bloom} min={0} max={2} step={0.01} format={pct} onChange={(v) => set("bloom", v)} />
          <Slider
            label="Motion blur"
            value={settings.motionBlur}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            onChange={(v) => set("motionBlur", v)}
            hint="Set to zero if fast camera motion makes you queasy."
          />
        </>
      )}

      {tab === "controls" && (
        <>
          <SectionHead>AIMING</SectionHead>
          <Slider label="Look sensitivity" value={settings.sensitivity} min={0.2} max={3} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => set("sensitivity", v)} />
          <Slider label="ADS sensitivity" value={settings.adsSensitivity} min={0.2} max={2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => set("adsSensitivity", v)} />
          <Toggle label="Invert vertical look" value={settings.invertY} onChange={(v) => set("invertY", v)} />
          <Slider
            label="Aim assist"
            value={settings.aimAssist}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(v) => set("aimAssist", v)}
            hint="Slows the reticle across a target. Off by default on mouse, useful on a pad or with limited motor control."
          />

          <SectionHead>HOLD OR TOGGLE</SectionHead>
          <Toggle label="Toggle aim down sights" value={settings.toggleAim} onChange={(v) => set("toggleAim", v)} />
          <Toggle label="Toggle crouch" value={settings.toggleCrouch} onChange={(v) => set("toggleCrouch", v)} />
          <Toggle label="Toggle sprint" value={settings.toggleSprint} onChange={(v) => set("toggleSprint", v)} />
        </>
      )}

      {tab === "audio" && (
        <>
          <SectionHead>MIXER</SectionHead>
          <Slider label="Master" value={settings.volMaster} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("volMaster", v)} />
          <Slider label="Effects" value={settings.volSfx} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("volSfx", v)} />
          <Slider label="Music" value={settings.volMusic} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("volMusic", v)} />
          <Slider label="Voice" value={settings.volVoice} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("volVoice", v)} />
          <Slider label="Interface" value={settings.volUi} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("volUi", v)} />
          <Toggle
            label="Night mode"
            value={settings.nightMode}
            onChange={(v) => set("nightMode", v)}
            hint="Compresses the dynamic range so explosions do not wake the building."
          />
        </>
      )}

      {tab === "interface" && (
        <>
          <SectionHead>HUD</SectionHead>
          <Slider label="HUD scale" value={settings.hudScale} min={0.7} max={1.5} step={0.01} format={pct} onChange={(v) => set("hudScale", v)} />
          <Slider label="HUD opacity" value={settings.hudOpacity} min={0.25} max={1} step={0.01} format={pct} onChange={(v) => set("hudOpacity", v)} />
          <Toggle label="Crosshair" value={settings.showCrosshair} onChange={(v) => set("showCrosshair", v)} />
          <Toggle label="Compass strip" value={settings.showCompass} onChange={(v) => set("showCompass", v)} />
          <Toggle label="Minimap" value={settings.showMinimap} onChange={(v) => set("showMinimap", v)} />
          <Toggle label="Minimap rotates with you" value={settings.minimapRotates} onChange={(v) => set("minimapRotates", v)} />
          <Toggle label="Damage numbers" value={settings.showDamageNumbers} onChange={(v) => set("showDamageNumbers", v)} />

          <SectionHead>UNITS</SectionHead>
          <Choice
            label="Speed"
            value={settings.speedUnits}
            options={[
              { id: "mph", label: "MPH" },
              { id: "kmh", label: "KM/H" },
            ]}
            onChange={(v) => set("speedUnits", v as UiSettings["speedUnits"])}
          />
        </>
      )}

      {tab === "accessibility" && (
        <>
          <SectionHead>COLOUR</SectionHead>
          <Choice
            label="Colour-blind palette"
            value={settings.colorblind}
            options={[
              { id: "none", label: "OFF" },
              { id: "protan", label: "PROTANOPIA" },
              { id: "deutan", label: "DEUTERANOPIA" },
              { id: "tritan", label: "TRITANOPIA" },
            ]}
            onChange={(v) => set("colorblind", v as CvdMode)}
            hint="Remaps the state colours only. The orange signal colour survives every common deficiency and stays put."
          />
          <Toggle
            label="High contrast HUD"
            value={settings.highContrastHud}
            onChange={(v) => set("highContrastHud", v)}
          />

          <SectionHead>MOTION &amp; FLASHING</SectionHead>
          <Toggle
            label="Reduce interface motion"
            value={settings.reduceMotion}
            onChange={(v) => set("reduceMotion", v)}
            hint="Collapses every animation to an instant state change."
          />
          <Toggle
            label="Reduce flashing"
            value={settings.reduceFlashing}
            onChange={(v) => set("reduceFlashing", v)}
            hint="Damps the low-health pulse and the ground-proximity strobe."
          />
          <Slider label="Screen shake" value={settings.screenShake} min={0} max={1} step={0.01} format={pct} onChange={(v) => set("screenShake", v)} />

          <SectionHead>SUBTITLES</SectionHead>
          <Toggle label="Subtitles" value={settings.subtitles} onChange={(v) => set("subtitles", v)} />
          <Choice
            label="Subtitle size"
            value={settings.subtitleSize}
            options={[
              { id: "s", label: "SMALL" },
              { id: "m", label: "MEDIUM" },
              { id: "l", label: "LARGE" },
              { id: "xl", label: "EXTRA LARGE" },
            ]}
            onChange={(v) => set("subtitleSize", v as UiSettings["subtitleSize"])}
          />
          <div className="mt-3 mb-6">
            <span className="sf-subtitle sf-text" style={{ display: "inline-block" }}>
              The fog is coming in off the Pacific.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function QualityPreview({ tier }: { tier: QualityTier }) {
  const q = QUALITY[tier];
  const rows: [string, string][] = [
    ["Draw distance", `${(q.drawDistance / 1000).toFixed(1)} km`],
    ["Detail radius", `${q.detailRadius} m`],
    ["Shadow cascades", `${q.shadowCascades} × ${q.shadowMapSize}`],
    ["Texture size", `${q.textureSize} px`],
    ["Ambient occlusion", q.ssao ? `${q.ssaoSamples} samples` : "off"],
    ["Reflections", q.ssr ? "screen space" : "off"],
    ["Volumetrics", q.volumetrics ? `${q.volumetricSteps} steps` : "off"],
    ["Anti-aliasing", q.taa ? "temporal" : "FXAA"],
    ["Depth of field", q.depthOfField ? "on" : "off"],
    ["Particles", `${(q.maxParticles / 1000).toFixed(0)}k`],
    ["Crowd density", `${Math.round(q.crowdDensity * 100)}%`],
    ["Pixel ratio cap", `${q.maxPixelRatio}×`],
  ];
  return (
    <div
      className="grid grid-cols-3 gap-x-8 gap-y-1 mb-8 p-4"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2">
          <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.16em" }}>
            {k}
          </span>
          <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
          <span className="sf-num" style={{ fontSize: 10, color: "rgba(255,255,255,0.82)" }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function ControlsScreen() {
  const bindings = useUiStore((s) => s.bindings);
  const bind = useUiStore((s) => s.bind);
  const resetBindings = useUiStore((s) => s.resetBindings);
  const [capturing, setCapturing] = useState<string | null>(null);
  const capturingRef = useRef<string | null>(null);
  capturingRef.current = capturing;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(null);
        return;
      }
      bind(capturingRef.current!, e.code);
      setCapturing(null);
    };
    const onMouse = (e: MouseEvent) => {
      e.preventDefault();
      bind(capturingRef.current!, `Mouse${e.button}`);
      setCapturing(null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      bind(capturingRef.current!, e.deltaY < 0 ? "WheelUp" : "WheelDown");
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [capturing, bind]);

  const groups = Array.from(new Set(ACTIONS.map((a) => a.group)));

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="flex items-center gap-3 mb-6">
        <span className="sf-label" style={{ fontSize: 9, letterSpacing: "0.3em" }}>
          KEY BINDINGS
        </span>
        <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.12)" }} />
        <button className="sf-chip" onClick={resetBindings}>
          RESET ALL
        </button>
      </div>

      {capturing && (
        <div
          className="mb-4 px-4 py-3"
          style={{ background: rgba(COLORS.signal, 0.12), border: `1px solid ${rgba(COLORS.signal, 0.5)}` }}
        >
          <span className="sf-label" style={{ fontSize: 9, color: COLORS.signal }}>
            PRESS ANY KEY, MOUSE BUTTON OR WHEEL · ESC TO CANCEL
          </span>
        </div>
      )}

      {groups.map((g) => (
        <div key={g} className="mb-7">
          <SectionHead>{g.toUpperCase()}</SectionHead>
          <div className="flex flex-col">
            {ACTIONS.filter((a) => a.group === g).map((a) => {
              const code = bindings[a.id] ?? "";
              const active = capturing === a.id;
              return (
                <div
                  key={a.id}
                  className="flex items-center gap-4 py-2"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
                >
                  <span className="sf-text" style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
                    {a.label}
                  </span>
                  <div className="flex-1" />
                  <button
                    className="sf-chip"
                    data-on={active ? "1" : "0"}
                    style={{ minWidth: 96, textAlign: "center", justifyContent: "center" }}
                    onClick={() => setCapturing(a.id)}
                  >
                    {active ? "…" : code ? keyGlyph(code) : "UNBOUND"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Credits
 * ------------------------------------------------------------------ */

const CREDITS: { head: string; lines: string[] }[] = [
  {
    head: "SAN FRANCISCO: FREE FALL",
    lines: ["An open-world sandbox built for the Vibeverse", "Rendered in WebGL with three.js and React Three Fiber"],
  },
  {
    head: "WORLD",
    lines: [
      "Terrain and coastline traced from real San Francisco geography",
      "24 districts, 22 landmarks, two colliding street grids",
      "Elevation from the city's actual summits — Twin Peaks 282 m, Mount Davidson 283 m",
    ],
  },
  {
    head: "SYSTEMS",
    lines: [
      "Geometry-clipmap terrain · Gerstner bay · procedural facade atlas",
      "Rapier physics · destructible props · vehicle simulation",
      "Deferred-quality post chain: TAA, GTAO, SSR, volumetrics, DoF",
    ],
  },
  {
    head: "INTERFACE",
    lines: [
      "Type: Sora and Manrope",
      "Signal colour #FF6A2B",
      "Every live readout drawn imperatively at frame rate, never through React",
    ],
  },
  {
    head: "WITH THANKS TO",
    lines: [
      "The city of San Francisco, for building a level design document and living in it",
      "Karl the Fog",
    ],
  },
];

function CreditsScreen() {
  return (
    <div style={{ maxWidth: 640 }}>
      {CREDITS.map((c, i) => (
        <div key={c.head} className="mb-9 sf-anim-rise" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="flex items-center gap-3 mb-3">
            <div style={{ width: 20, height: 2, background: COLORS.signal }} />
            <span className="sf-label" style={{ fontSize: 9, letterSpacing: "0.3em", color: COLORS.signal }}>
              {c.head}
            </span>
          </div>
          {c.lines.map((l) => (
            <p key={l} className="sf-text" style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,0.7)" }}>
              {l}
            </p>
          ))}
        </div>
      ))}
      <p className="sf-label" style={{ fontSize: 8, letterSpacing: "0.3em", opacity: 0.4 }}>
        {`SEED ${DEFAULT_SETTINGS.quality.toUpperCase()} · POST GRAIN ${postfx.grain.toFixed(2)}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3 mt-7">
      <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.3em", whiteSpace: "nowrap" }}>
        {children}
      </span>
      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.1)" }} />
    </div>
  );
}

function BigStat({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className="flex flex-col">
      <span className="sf-num" style={{ fontSize: 27, fontWeight: 700, color: tint, lineHeight: 1 }}>
        {value}
      </span>
      <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.24em", marginTop: 4 }}>
        {label}
      </span>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="mb-4">
      <div className="flex items-baseline gap-3">
        <span className="sf-text" style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
          {label}
        </span>
        <div className="flex-1" />
        <span className="sf-num" style={{ fontSize: 11, color: COLORS.signal, minWidth: 52, textAlign: "right" }}>
          {format(value)}
        </span>
      </div>
      <input
        className="sf-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--sf-fill": `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && (
        <p className="sf-text" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: -2, lineHeight: 1.45 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-3">
        <span className="sf-text" style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
          {label}
        </span>
        <div className="flex-1" />
        <button
          className="sf-pe"
          onClick={() => onChange(!value)}
          style={{
            width: 44,
            height: 20,
            padding: 2,
            borderRadius: 2,
            background: value ? rgba(COLORS.signal, 0.28) : "rgba(255,255,255,0.07)",
            border: `1px solid ${value ? rgba(COLORS.signal, 0.7) : "rgba(255,255,255,0.14)"}`,
            cursor: "pointer",
            transition: "all var(--sf-dur-fast) var(--sf-ease)",
          }}
        >
          <div
            style={{
              width: 16,
              height: 14,
              borderRadius: 1,
              background: value ? COLORS.signal : "rgba(255,255,255,0.4)",
              transform: `translateX(${value ? 22 : 0}px)`,
              transition: "transform var(--sf-dur-fast) var(--sf-ease)",
              boxShadow: value ? `0 0 12px ${COLORS.signal}` : "none",
            }}
          />
        </button>
      </div>
      {hint && (
        <p className="sf-text" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.45, marginTop: 2 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3">
        <span className="sf-text" style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
          {label}
        </span>
        <div className="flex-1" />
        <div className="flex gap-1">
          {options.map((o) => (
            <button
              key={o.id}
              className="sf-chip"
              data-on={value === o.id ? "1" : "0"}
              onClick={() => onChange(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {hint && (
        <p className="sf-text" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.45, marginTop: 3 }}>
          {hint}
        </p>
      )}
    </div>
  );
}
