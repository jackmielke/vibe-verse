/**
 * The one stylesheet the game UI injects.
 *
 * Tailwind covers layout and spacing perfectly well, but it cannot express
 * keyframes, `backdrop-filter` stacks, layered text shadows or a live
 * colour-blind palette swap without editing `tailwind.config.ts` — which this
 * subsystem does not own. So: a single idempotent <style> injection, scoped
 * under `.sf-ui` so nothing here can leak into the rest of the Vibeverse.
 *
 * Everything is a CSS custom property where a setting needs to move it at
 * runtime (HUD scale, HUD opacity, palette, motion reduction). Changing a
 * variable costs one style recalc; re-rendering React for the same effect
 * costs a tree diff, and this UI sits on top of a 60 fps renderer.
 */
import { COLORS, CVD_PALETTES, LAYOUT, MOTION, type CvdMode } from "./theme";

const STYLE_ID = "sf-ui-styles";

function cvdBlock(mode: CvdMode): string {
  const patch = CVD_PALETTES[mode] as Partial<Record<string, string>>;
  const body = Object.entries(patch)
    .map(([k, v]) => `--sf-${k}: ${v};`)
    .join("");
  return body ? `.sf-ui[data-cvd="${mode}"]{${body}}` : "";
}

const CSS = `
.sf-ui {
  --sf-signal: ${COLORS.signal};
  --sf-signal-bright: ${COLORS.signalBright};
  --sf-signal-deep: ${COLORS.signalDeep};
  --sf-ink: ${COLORS.ink};
  --sf-ink2: ${COLORS.ink2};
  --sf-ink3: ${COLORS.ink3};
  --sf-paper: ${COLORS.paper};
  --sf-muted: ${COLORS.muted};
  --sf-danger: ${COLORS.danger};
  --sf-warn: ${COLORS.warn};
  --sf-good: ${COLORS.good};
  --sf-info: ${COLORS.info};
  --sf-chaos: ${COLORS.chaos};
  --sf-heat: ${COLORS.heat};

  --sf-dur-fast: ${MOTION.fast}ms;
  --sf-dur: ${MOTION.base}ms;
  --sf-dur-slow: ${MOTION.slow}ms;
  --sf-ease: ${MOTION.ease};
  --sf-ease-back: ${MOTION.easeBack};

  --sf-hud-scale: 1;
  --sf-hud-opacity: 1;
  --sf-edge: ${LAYOUT.edge}px;

  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 40;
  font-family: Manrope, ui-sans-serif, system-ui, sans-serif;
  color: var(--sf-paper);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none;
  -webkit-user-select: none;
  contain: layout style;
}
.sf-ui * { box-sizing: border-box; }
.sf-ui button, .sf-ui input, .sf-ui select, .sf-ui textarea { font: inherit; color: inherit; }

/* Anything interactive opts back into pointer events explicitly. The HUD as
   a whole must never eat a mouse look or a trigger pull. */
.sf-pe { pointer-events: auto; }

${cvdBlock("protan")}
${cvdBlock("deutan")}
${cvdBlock("tritan")}

/* --- Typography ------------------------------------------------------- */

.sf-label {
  font-family: Sora, ui-sans-serif, system-ui, sans-serif;
  font-weight: 500;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--sf-muted);
}
.sf-label-lit { color: var(--sf-paper); }
.sf-num {
  font-family: Sora, ui-sans-serif, system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "ss01" 1;
  letter-spacing: -0.01em;
}
.sf-display {
  font-family: Sora, ui-sans-serif, system-ui, sans-serif;
  font-weight: 800;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}

/* Legibility over ANY backdrop: a tight dark halo plus a soft one. This is
   what lets white 10px type survive a blown-out sky at 2pm. */
.sf-text {
  text-shadow:
    0 1px 1px rgba(0,0,0,0.92),
    0 0 2px rgba(0,0,0,0.72),
    0 0 12px rgba(0,0,0,0.42);
}
.sf-text-hard {
  text-shadow:
    0 0 1px rgba(0,0,0,1),
    0 1px 2px rgba(0,0,0,1),
    0 0 18px rgba(0,0,0,0.65);
}

/* A scrim is a *shape*, not a box — a soft elliptical darkening that gives
   the type something to sit on without drawing a panel. */
.sf-scrim::before {
  content: "";
  position: absolute;
  inset: -22px -34px;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.34) 45%, rgba(0,0,0,0) 78%);
  pointer-events: none;
  z-index: -1;
}

/* --- Surfaces --------------------------------------------------------- */

.sf-glass {
  background: linear-gradient(180deg, rgba(12,14,19,0.82) 0%, rgba(5,6,10,0.88) 100%);
  backdrop-filter: blur(16px) saturate(1.15);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  border: 1px solid rgba(255,255,255,0.10);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.07),
    0 18px 60px -20px rgba(0,0,0,0.9);
  border-radius: ${LAYOUT.radius}px;
}
.sf-glass-light {
  background: rgba(10,12,16,0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: ${LAYOUT.radius}px;
}
.sf-rule { background: rgba(255,255,255,0.14); }

/* The signal edge: a 2px orange tab on the leading edge of a live element. */
.sf-tab { position: relative; }
.sf-tab::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--sf-signal);
  box-shadow: 0 0 10px var(--sf-signal);
}

/* --- Controls --------------------------------------------------------- */

.sf-btn {
  pointer-events: auto;
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 16px;
  font-family: Sora, ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(242,244,247,0.72);
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 4px;
  cursor: pointer;
  transition:
    color var(--sf-dur-fast) var(--sf-ease),
    background var(--sf-dur-fast) var(--sf-ease),
    border-color var(--sf-dur-fast) var(--sf-ease),
    transform var(--sf-dur-fast) var(--sf-ease);
}
.sf-btn::after {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: var(--sf-signal);
  transition: width var(--sf-dur-fast) var(--sf-ease);
}
.sf-btn:hover, .sf-btn:focus-visible {
  color: #fff;
  background: rgba(255,106,43,0.10);
  border-color: rgba(255,106,43,0.42);
  transform: translateX(3px);
  outline: none;
}
.sf-btn:hover::after, .sf-btn:focus-visible::after { width: 2px; }
.sf-btn:active { transform: translateX(1px) scale(0.995); }
.sf-btn[data-primary="1"] {
  color: #0b0500;
  background: linear-gradient(180deg, var(--sf-signal-bright), var(--sf-signal));
  border-color: rgba(255,160,110,0.5);
  box-shadow: 0 6px 26px -8px rgba(255,106,43,0.8);
}
.sf-btn[data-primary="1"]:hover { color: #0b0500; background: linear-gradient(180deg, #ffa06b, var(--sf-signal-bright)); }
.sf-btn[data-danger="1"]:hover { background: rgba(255,59,48,0.12); border-color: rgba(255,59,48,0.5); }
.sf-btn:disabled { opacity: 0.32; cursor: default; transform: none; }

.sf-chip {
  pointer-events: auto;
  padding: 5px 11px;
  font-family: Sora, ui-sans-serif, system-ui, sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(242,244,247,0.6);
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 3px;
  cursor: pointer;
  transition: all var(--sf-dur-fast) var(--sf-ease);
}
.sf-chip:hover { color: #fff; border-color: rgba(255,255,255,0.26); background: rgba(255,255,255,0.07); }
.sf-chip[data-on="1"] {
  color: #120600;
  background: var(--sf-signal);
  border-color: var(--sf-signal);
  box-shadow: 0 0 18px -4px var(--sf-signal);
}

/* Range input, restyled so the settings screen does not look like a form. */
.sf-range {
  pointer-events: auto;
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 18px;
  background: transparent;
  cursor: pointer;
}
.sf-range::-webkit-slider-runnable-track {
  height: 2px;
  background: linear-gradient(
    to right,
    var(--sf-signal) 0%,
    var(--sf-signal) var(--sf-fill, 50%),
    rgba(255,255,255,0.16) var(--sf-fill, 50%),
    rgba(255,255,255,0.16) 100%);
}
.sf-range::-moz-range-track { height: 2px; background: rgba(255,255,255,0.16); }
.sf-range::-moz-range-progress { height: 2px; background: var(--sf-signal); }
.sf-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px; height: 12px;
  margin-top: -5px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 0 14px -2px var(--sf-signal);
  transition: transform var(--sf-dur-fast) var(--sf-ease);
}
.sf-range::-moz-range-thumb {
  width: 12px; height: 12px; border: none; border-radius: 2px; background: #fff;
}
.sf-range:hover::-webkit-slider-thumb { transform: scale(1.25); }

/* --- Motion ----------------------------------------------------------- */

@keyframes sf-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes sf-rise {
  from { opacity: 0; transform: translateY(10px) }
  to   { opacity: 1; transform: translateY(0) }
}
@keyframes sf-slide-left {
  from { opacity: 0; transform: translateX(26px) }
  to   { opacity: 1; transform: translateX(0) }
}
@keyframes sf-slide-right {
  from { opacity: 0; transform: translateX(-26px) }
  to   { opacity: 1; transform: translateX(0) }
}
@keyframes sf-pop {
  0%   { opacity: 0; transform: scale(0.86) }
  60%  { opacity: 1; transform: scale(1.04) }
  100% { opacity: 1; transform: scale(1) }
}
@keyframes sf-hit {
  0%   { opacity: 1; transform: scale(0.55) rotate(45deg) }
  100% { opacity: 0; transform: scale(1.5) rotate(45deg) }
}
@keyframes sf-pulse-danger {
  0%, 100% { opacity: 0.25 }
  50%      { opacity: 0.8 }
}
@keyframes sf-sweep {
  from { transform: translateX(-100%) }
  to   { transform: translateX(220%) }
}
@keyframes sf-blink { 0%, 45% { opacity: 1 } 55%, 100% { opacity: 0.12 } }
@keyframes sf-spin { to { transform: rotate(360deg) } }
@keyframes sf-ticker { from { transform: translateY(6px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }

.sf-anim-fade  { animation: sf-fade-in var(--sf-dur) var(--sf-ease) both; }
.sf-anim-rise  { animation: sf-rise var(--sf-dur) var(--sf-ease) both; }
.sf-anim-left  { animation: sf-slide-left var(--sf-dur) var(--sf-ease) both; }
.sf-anim-right { animation: sf-slide-right var(--sf-dur) var(--sf-ease) both; }
.sf-anim-pop   { animation: sf-pop var(--sf-dur) var(--sf-ease-back) both; }

/* The shimmer that runs along the loading bar and objective completions. */
.sf-sweep { position: relative; overflow: hidden; }
.sf-sweep::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
  animation: sf-sweep 1.5s var(--sf-ease) infinite;
}

/* Reduced motion is a real accessibility promise, not a token gesture:
   every animation collapses to an instant state change. */
.sf-ui[data-reduce-motion="1"] *,
.sf-ui[data-reduce-motion="1"] *::before,
.sf-ui[data-reduce-motion="1"] *::after {
  animation-duration: 1ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 1ms !important;
}

/* --- Scrollables ------------------------------------------------------ */

.sf-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
.sf-scroll::-webkit-scrollbar { width: 6px; }
.sf-scroll::-webkit-scrollbar-track { background: transparent; }
.sf-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 3px; }
.sf-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,106,43,0.6); }

/* --- HUD clusters ----------------------------------------------------- */

/* Each corner cluster scales from its own anchor, so HUD scale never drags
   an element away from the screen edge it belongs to. */
.sf-cluster { position: absolute; opacity: var(--sf-hud-opacity); will-change: transform; }
.sf-cluster[data-anchor="bl"] { left: var(--sf-edge); bottom: var(--sf-edge); transform-origin: bottom left; transform: scale(var(--sf-hud-scale)); }
.sf-cluster[data-anchor="br"] { right: var(--sf-edge); bottom: var(--sf-edge); transform-origin: bottom right; transform: scale(var(--sf-hud-scale)); }
/* Cleared past the vibeverse's home button, which sits in this corner in
   every world. It hides itself under pointer lock, but the minimap is on
   screen in menus too, and on a phone there is no pointer lock at all. */
.sf-cluster[data-anchor="tl"] { left: calc(var(--sf-edge) + var(--vv-home-clear, 0px)); top: calc(var(--sf-edge) + var(--sf-top-clear, 0px)); transform-origin: top left; transform: scale(var(--sf-hud-scale)); }
.sf-cluster[data-anchor="tr"] { right: var(--sf-edge); top: calc(var(--sf-edge) + var(--sf-top-clear, 0px)); transform-origin: top right; transform: scale(var(--sf-hud-scale)); }
.sf-cluster[data-anchor="tc"] { left: 50%; top: calc(var(--sf-edge) + var(--sf-top-clear, 0px)); transform-origin: top center; transform: translateX(-50%) scale(var(--sf-hud-scale)); }
.sf-cluster[data-anchor="bc"] { left: 50%; bottom: var(--sf-edge); transform-origin: bottom center; transform: translateX(-50%) scale(var(--sf-hud-scale)); }
.sf-cluster[data-anchor="c"]  { left: 50%; top: 50%; transform-origin: center; transform: translate(-50%,-50%) scale(var(--sf-hud-scale)); }

/* A phone, either way up: tighter edges, a compass that fits the width, and
   the bottom corners a notch smaller so the thumb controls own them. */
@media (max-width: 640px), (max-height: 520px) {
  .sf-ui { --sf-edge: 12px; --sf-compass-w: 260px; }
  .sf-cluster[data-anchor="bl"] { transform: scale(calc(var(--sf-hud-scale) * 0.8)); }
  .sf-cluster[data-anchor="br"] { transform: scale(calc(var(--sf-hud-scale) * 0.8)); }
}
/* On its side there are 430 px, and the minimap column (disc, street, zoom
   chips, weather) ran into the vitals at the bottom. Smaller, same place. */
@media (max-height: 520px) {
  .sf-cluster[data-anchor="tl"] { transform: scale(calc(var(--sf-hud-scale) * 0.7)); }
}
/* Upright, the compass takes the whole top edge and the map goes under it —
   side by side they overlapped in 393 px. */
@media (max-width: 640px) and (orientation: portrait) {
  .sf-ui { --sf-compass-w: calc(100vw - 24px); }
  .sf-cluster[data-anchor="tl"], .sf-cluster[data-anchor="tr"] { top: calc(var(--sf-edge) + var(--sf-top-clear, 0px) + 76px); }
}
/* The thumb buttons are built into the bottom-right corner by input.ts;
   the ammo block moves up out of them. */
@media (pointer: coarse) and (max-width: 640px) {
  .sf-cluster[data-anchor="br"] { bottom: calc(var(--sf-edge) + 250px); }
}
@media (pointer: coarse) and (max-height: 520px) {
  .sf-cluster[data-anchor="br"] { bottom: calc(var(--sf-edge) + 250px); }
}

/* --- Subtitles -------------------------------------------------------- */

.sf-subtitle {
  font-size: calc(15px * var(--sf-subtitle-scale, 1));
  line-height: 1.35;
  padding: 6px 14px;
  background: rgba(0,0,0,0.62);
  border-radius: 3px;
}
`;

let installed = false;
let styleEl: HTMLStyleElement | null = null;

/**
 * Inject the UI stylesheet exactly once per document. Safe to call from
 * every component that needs it; subsequent calls are free.
 */
export function installUiStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
}

/** Test/HMR escape hatch. Production never calls this. */
export function removeUiStyles(): void {
  styleEl?.remove();
  styleEl = null;
  installed = false;
}
