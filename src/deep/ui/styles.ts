/**
 * The Midnight Zone — HUD styling.
 *
 * One rule governs everything here: **the HUD must never be brighter than the
 * ocean.** Every panel is a low-alpha dark glass with a thin cyan edge, and no
 * text is pure white. A conventional bright-white game HUD over this world
 * would blow out the eye's adaptation and make the actual scene — which is
 * built entirely out of near-blacks — look like mud.
 *
 * Sizing is in `vmin` so the same layout works on a phone in either
 * orientation without a media query per element.
 */
export const DEEP_CSS = `
.dp-root {
  position: absolute; inset: 0; pointer-events: none;
  color: #cfeaf7;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none; -webkit-user-select: none;
  --dp-cyan: #7ff0ff;
  --dp-dim: rgba(160, 214, 235, 0.55);
  --dp-glass: rgba(6, 20, 34, 0.62);
  --dp-edge: rgba(127, 240, 255, 0.22);
}
.dp-root * { box-sizing: border-box; }

.dp-panel {
  background: var(--dp-glass);
  border: 0.18vmin solid var(--dp-edge);
  border-radius: 1.4vmin;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.dp-mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dp-label { font-size: 1.15vmin; letter-spacing: 0.3em; text-transform: uppercase; color: var(--dp-dim); font-weight: 700; }

.dp-btn {
  pointer-events: auto; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 0.8vmin;
  padding: 1.3vmin 2.8vmin; border-radius: 1.2vmin;
  border: 0.2vmin solid var(--dp-edge);
  background: rgba(10, 32, 52, 0.7);
  color: #d6f2ff; font: inherit; font-weight: 800;
  font-size: 1.7vmin; letter-spacing: 0.16em; text-transform: uppercase;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.14s ease;
}
.dp-btn:hover { border-color: var(--dp-cyan); background: rgba(16, 52, 80, 0.8); transform: translateY(-0.25vmin); }
.dp-btn:active { transform: translateY(0.1vmin); }
.dp-btn--go {
  background: linear-gradient(180deg, rgba(46, 190, 220, 0.95), rgba(20, 120, 165, 0.95));
  border-color: rgba(190, 245, 255, 0.5); color: #04202e;
  box-shadow: 0 0 3vmin rgba(90, 220, 255, 0.32);
}
.dp-btn--go:hover { background: linear-gradient(180deg, rgba(74, 214, 240, 1), rgba(28, 140, 185, 1)); }

/* -- the depth column ----------------------------------------------------- */
/* A vertical gauge on the left, because depth is a vertical quantity and a
   horizontal bar for it has always been a small lie. */
.dp-gauge { position: absolute; left: 3vmin; top: 50%; transform: translateY(-50%); height: 58vmin; width: 12vmin; }
.dp-gauge-track {
  position: absolute; left: 4.2vmin; top: 0; bottom: 0; width: 0.5vmin;
  border-radius: 0.3vmin; background: rgba(140, 210, 240, 0.14);
  overflow: hidden;
}
.dp-gauge-fill { position: absolute; left: 0; right: 0; top: 0; background: linear-gradient(180deg, #6fe0ff, #0d3f66); }
.dp-gauge-sub {
  position: absolute; left: 2.6vmin; width: 3.6vmin; height: 3.6vmin; margin-top: -1.8vmin;
  border-radius: 50%; border: 0.25vmin solid var(--dp-cyan);
  background: rgba(6, 24, 40, 0.9); box-shadow: 0 0 2vmin rgba(110, 230, 255, 0.55);
  display: grid; place-items: center; font-size: 1.6vmin;
  transition: top 0.12s linear;
}
.dp-zone-tick { position: absolute; left: 5.6vmin; transform: translateY(-50%); white-space: nowrap; }
.dp-zone-tick i { display: inline-block; width: 1.6vmin; height: 0.15vmin; background: var(--dp-edge); vertical-align: middle; margin-right: 0.7vmin; }
.dp-zone-tick span { font-size: 1.05vmin; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(160, 214, 235, 0.42); }
.dp-zone-tick[data-here="1"] span { color: var(--dp-cyan); }

.dp-depth { position: absolute; left: 0; top: -6.5vmin; }
.dp-depth-n { font-size: 4.6vmin; font-weight: 900; line-height: 1; letter-spacing: -0.02em; text-shadow: 0 0 2.4vmin rgba(90, 210, 255, 0.4); }
.dp-depth-u { font-size: 1.5vmin; color: var(--dp-dim); margin-left: 0.5vmin; font-weight: 700; }

/* -- top-right readouts ---------------------------------------------------- */
.dp-stack { position: absolute; right: 3vmin; top: 3vmin; display: flex; flex-direction: column; gap: 1vmin; align-items: flex-end; }
.dp-chip { display: flex; align-items: center; gap: 1vmin; padding: 0.9vmin 1.6vmin; }
.dp-bar { width: 12vmin; height: 0.7vmin; border-radius: 0.4vmin; background: rgba(140, 210, 240, 0.16); overflow: hidden; }
.dp-bar > i { display: block; height: 100%; border-radius: 0.4vmin; transition: width 0.25s ease, background 0.3s ease; }

/* -- the scan reticle ------------------------------------------------------ */
.dp-reticle { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 26vmin; height: 26vmin; }
.dp-reticle svg { width: 100%; height: 100%; overflow: visible; }
.dp-scan-name {
  position: absolute; left: 50%; top: calc(50% + 15vmin); transform: translateX(-50%);
  text-align: center; white-space: nowrap;
}
.dp-scan-name b { display: block; font-size: 2.2vmin; font-weight: 900; letter-spacing: 0.06em; }
.dp-scan-name i { display: block; font-size: 1.3vmin; color: var(--dp-dim); font-style: italic; letter-spacing: 0.08em; }

/* -- the find card --------------------------------------------------------- */
.dp-find {
  position: absolute; left: 50%; bottom: 12vmin; transform: translateX(-50%);
  width: min(74vmin, 92vw); padding: 2.2vmin 2.6vmin;
  animation: dp-rise 0.5s cubic-bezier(0.2, 1, 0.3, 1) both;
}
.dp-find-tag { font-size: 1.1vmin; letter-spacing: 0.34em; text-transform: uppercase; color: var(--dp-cyan); font-weight: 800; }
.dp-find-name { font-size: 3vmin; font-weight: 900; margin-top: 0.5vmin; letter-spacing: 0.02em; }
.dp-find-latin { font-size: 1.5vmin; font-style: italic; color: var(--dp-dim); margin-bottom: 1vmin; }
.dp-find-note { font-size: 1.7vmin; line-height: 1.5; color: rgba(214, 240, 252, 0.9); }

/* -- zone announcement ----------------------------------------------------- */
.dp-zone-card {
  position: absolute; left: 50%; top: 22%; transform: translateX(-50%);
  text-align: center; width: min(80vmin, 94vw);
  animation: dp-zone 6.5s ease both;
}
.dp-zone-card b { display: block; font-size: 4.4vmin; font-weight: 900; letter-spacing: 0.24em; text-transform: uppercase;
  text-shadow: 0 0 4vmin rgba(90, 210, 255, 0.5); }
.dp-zone-card span { display: block; margin-top: 1.2vmin; font-size: 1.8vmin; color: rgba(200, 232, 248, 0.85); font-style: italic; letter-spacing: 0.04em; }

/* -- menus ----------------------------------------------------------------- */
.dp-layer { position: absolute; inset: 0; pointer-events: auto; display: grid; place-items: center; }
.dp-scrim { position: absolute; inset: 0; background:
  radial-gradient(ellipse at 50% 40%, rgba(4, 26, 44, 0.5), rgba(1, 6, 14, 0.9) 75%); }
.dp-sheet { position: relative; width: min(96vmin, 94vw); max-height: 92vh; overflow-y: auto; padding: 4vmin; text-align: center; }
.dp-title { font-size: 7vmin; font-weight: 900; letter-spacing: 0.3em; text-transform: uppercase; line-height: 1;
  background: linear-gradient(180deg, #eafcff 0%, #6fd8ff 55%, #1f6f9e 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 3vmin rgba(80, 200, 255, 0.35)); }
.dp-sub { font-size: 1.6vmin; letter-spacing: 0.36em; text-transform: uppercase; color: var(--dp-dim); margin-top: 1.4vmin; }
.dp-blurb { font-size: 1.75vmin; line-height: 1.6; color: rgba(206, 234, 247, 0.86); max-width: 62vmin; margin: 2.4vmin auto 0; }
.dp-keys { display: flex; flex-wrap: wrap; gap: 1vmin 2.4vmin; justify-content: center; margin-top: 2.6vmin; }
.dp-key { display: flex; align-items: center; gap: 0.8vmin; font-size: 1.35vmin; color: var(--dp-dim); letter-spacing: 0.1em; }
.dp-key kbd {
  display: inline-grid; place-items: center; min-width: 2.6vmin; padding: 0.4vmin 0.7vmin;
  border-radius: 0.6vmin; border: 0.16vmin solid var(--dp-edge); background: rgba(10, 32, 52, 0.8);
  font: 700 1.25vmin/1 ui-monospace, monospace; color: #cfeaf7;
}
.dp-row { display: flex; gap: 1.4vmin; justify-content: center; flex-wrap: wrap; margin-top: 3vmin; }

/* -- the log --------------------------------------------------------------- */
.dp-log { display: grid; grid-template-columns: repeat(auto-fill, minmax(24vmin, 1fr)); gap: 1.2vmin; margin-top: 2.4vmin; text-align: left; }
.dp-log-card { padding: 1.4vmin 1.6vmin; border-radius: 1.2vmin; border: 0.18vmin solid var(--dp-edge);
  background: rgba(6, 20, 34, 0.55); }
.dp-log-card[data-found="0"] { opacity: 0.34; }
.dp-log-card b { display: block; font-size: 1.65vmin; font-weight: 900; }
.dp-log-card i { display: block; font-size: 1.15vmin; font-style: italic; color: var(--dp-dim); margin-top: 0.2vmin; }
.dp-log-card p { font-size: 1.3vmin; line-height: 1.45; margin: 0.9vmin 0 0; color: rgba(206, 234, 247, 0.8); }
.dp-log-depth { font-size: 1.05vmin; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(160, 214, 235, 0.4); margin-top: 0.8vmin; }
.dp-dot { display: inline-block; width: 0.9vmin; height: 0.9vmin; border-radius: 50%; margin-right: 0.7vmin; vertical-align: baseline; }

/* -- loading --------------------------------------------------------------- */
.dp-load { position: absolute; inset: 0; display: grid; place-items: center; background: #020913; }
.dp-load-bar { width: 42vmin; height: 0.5vmin; border-radius: 0.4vmin; background: rgba(140, 210, 240, 0.14); overflow: hidden; margin-top: 3vmin; }
.dp-load-fill { height: 100%; background: linear-gradient(90deg, #1f6f9e, #7ff0ff); transition: width 0.3s ease; box-shadow: 0 0 2vmin rgba(110, 230, 255, 0.6); }
.dp-load-stage { margin-top: 1.6vmin; font-size: 1.3vmin; letter-spacing: 0.3em; text-transform: uppercase; color: var(--dp-dim); }

.dp-foot { position: absolute; bottom: 2.4vmin; left: 0; right: 0; display: flex; justify-content: space-between;
  padding: 0 3vmin; font-size: 1.15vmin; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(160, 214, 235, 0.4); }
.dp-foot a { color: rgba(160, 214, 235, 0.62); text-decoration: none; pointer-events: auto; }
.dp-foot a:hover { color: var(--dp-cyan); }

@keyframes dp-rise { from { opacity: 0; transform: translate(-50%, 2.4vmin); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dp-zone {
  0% { opacity: 0; transform: translate(-50%, 2vmin); }
  12% { opacity: 1; transform: translate(-50%, 0); }
  80% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes dp-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.dp-pulse { animation: dp-pulse 2s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .dp-root *, .dp-layer * { animation-duration: 0.001s !important; animation-iteration-count: 1 !important; }
}
`;
