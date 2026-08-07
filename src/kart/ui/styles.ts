/**
 * Vibe Kart — the UI stylesheet.
 *
 * One string, injected once by `KartUI`, namespaced `vk-`. It is written by
 * hand rather than assembled out of Tailwind classes for three reasons: the
 * HUD's motion is keyframe work that utility classes cannot express, the
 * numbers that move are written straight to `style` from a frame callback and
 * want a stable class to sit on, and the whole layer has to survive a Tailwind
 * purge it is not in the content glob for.
 *
 * The visual language, so that anything added later matches:
 *
 *   · **Chunky, not thin.** Every panel is a rounded slab with a dark 2px
 *     outline, a light inner rim at the top and a hard shadow underneath. That
 *     top rim plus bottom shade is what makes a rectangle read as a moulded
 *     plastic button rather than a div.
 *   · **Warm gold (#ffcc22) is the one accent.** Cyan is progress, hot pink is
 *     danger, violet is the top drift tier. Nothing else gets a colour.
 *   · **Text never sits naked on the world.** Everything is either on a slab or
 *     wearing a dark rim (`.vk-ink-edge`), because a HUD is read at 60 mph over
 *     a sunset sky and a grey shadow is not enough.
 *   · **Sizes are in vmin**, so the HUD is the same fraction of the screen on a
 *     laptop, a phone and the 1600×900 screenshot harness.
 *
 * Fonts: system only — the game ships no network assets. The stack asks for the
 * repo's display face first, then the rounded system faces (which is what gives
 * the arcade feel on macOS and Android), then a heavy grotesque. Weight 800/900
 * everywhere; nothing is allowed to render at a default 400.
 */

export const UI_CSS = String.raw`
.vk-root, .vk-root * { box-sizing: border-box; }

.vk-root {
  --vk-ink: #080e18;
  --vk-ink-2: #111d31;
  --vk-ink-3: #1d3050;
  --vk-cream: #fff7e6;
  --vk-gold: #ffcc22;
  --vk-gold-2: #ffa919;
  --vk-gold-3: #b96206;
  --vk-hot: #ff4d7d;
  --vk-cyan: #3ad9ff;
  --vk-lime: #8ff05a;
  --vk-violet: #b57bff;
  --vk-red: #ff4436;

  --vk-drop: 0 0.9vmin 2.2vmin rgba(3, 8, 18, 0.55), 0 0.25vmin 0 rgba(0, 0, 0, 0.45);
  --vk-rim: inset 0 0.22vmin 0 rgba(255, 255, 255, 0.28), inset 0 -0.36vmin 0 rgba(0, 0, 0, 0.38);
  --vk-glass: linear-gradient(180deg, rgba(23, 40, 66, 0.88), rgba(8, 15, 26, 0.92));

  --vk-font: "Sora", "Nunito", ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display",
    system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;

  position: absolute;
  inset: 0;
  z-index: 30;
  overflow: hidden;
  pointer-events: none;
  font-family: var(--vk-font);
  font-weight: 800;
  color: var(--vk-cream);
  letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.vk-root b, .vk-root strong { font-weight: 900; }
.vk-num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }

/* A dark rim in every direction plus a drop below: legible over sky or tarmac. */
.vk-ink-edge {
  text-shadow:
    0 0.16vmin 0 #05090f, 0.16vmin 0 0 #05090f, -0.16vmin 0 0 #05090f, 0 -0.16vmin 0 #05090f,
    0.12vmin 0.12vmin 0 #05090f, -0.12vmin 0.12vmin 0 #05090f,
    0 0.5vmin 1.1vmin rgba(0, 0, 0, 0.55);
}

.vk-panel {
  background: var(--vk-glass);
  border: 0.24vmin solid rgba(255, 255, 255, 0.16);
  border-radius: 2vmin;
  box-shadow: var(--vk-drop), var(--vk-rim);
}

.vk-layer { position: absolute; inset: 0; pointer-events: auto; }
.vk-hud { position: absolute; inset: 0; pointer-events: none; }

/* --------------------------------------------------------------------------
   Buttons
   -------------------------------------------------------------------------- */

.vk-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.9vmin;
  padding: 1.4vmin 2.8vmin;
  min-height: 5.6vmin;
  border: 0.28vmin solid rgba(6, 12, 22, 0.85);
  border-radius: 1.6vmin;
  background: linear-gradient(180deg, #2b456e 0%, #16233a 100%);
  color: var(--vk-cream);
  font: inherit;
  font-weight: 900;
  font-size: 1.9vmin;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  cursor: pointer;
  box-shadow: var(--vk-drop), var(--vk-rim);
  transition: transform 0.12s cubic-bezier(0.2, 1.6, 0.4, 1), filter 0.12s ease, box-shadow 0.12s ease;
  -webkit-appearance: none;
  appearance: none;
}
.vk-btn:hover { transform: translateY(-0.3vmin) scale(1.03); filter: brightness(1.12); }
.vk-btn:active { transform: translateY(0.2vmin) scale(0.98); filter: brightness(0.92); }
.vk-btn:focus-visible { outline: 0.35vmin solid var(--vk-gold); outline-offset: 0.3vmin; }

.vk-btn--gold {
  background: linear-gradient(180deg, #ffdd5c 0%, var(--vk-gold) 45%, var(--vk-gold-2) 100%);
  color: #3a2000;
  border-color: rgba(90, 45, 0, 0.75);
  text-shadow: 0 0.15vmin 0 rgba(255, 255, 255, 0.55);
}
.vk-btn--ghost { background: rgba(10, 18, 32, 0.55); border-color: rgba(255, 255, 255, 0.2); }
.vk-btn--sm { padding: 0.9vmin 1.7vmin; min-height: 4vmin; font-size: 1.5vmin; border-radius: 1.2vmin; }
.vk-btn--wide { min-width: 30vmin; }

/* Segmented control — quality, difficulty, camera. */
.vk-seg { display: inline-flex; padding: 0.4vmin; gap: 0.35vmin; border-radius: 1.5vmin;
  background: rgba(6, 12, 22, 0.6); border: 0.22vmin solid rgba(255, 255, 255, 0.12); }
.vk-seg button {
  border: 0; border-radius: 1.15vmin; padding: 0.8vmin 1.6vmin; min-height: 3.6vmin;
  font: inherit; font-weight: 900; font-size: 1.45vmin; letter-spacing: 0.08em; text-transform: uppercase;
  color: rgba(255, 247, 230, 0.62); background: transparent; cursor: pointer;
  transition: color 0.14s ease, background 0.14s ease, transform 0.14s ease;
}
.vk-seg button:hover { color: var(--vk-cream); }
.vk-seg button[data-on="1"] {
  color: #3a2000; transform: translateY(-0.1vmin);
  background: linear-gradient(180deg, #ffdd5c, var(--vk-gold-2));
  box-shadow: 0 0.35vmin 0.9vmin rgba(0, 0, 0, 0.4), inset 0 0.18vmin 0 rgba(255, 255, 255, 0.6);
}

.vk-row { display: flex; align-items: center; gap: 1.6vmin; }
.vk-label {
  font-size: 1.3vmin; letter-spacing: 0.24em; text-transform: uppercase;
  color: rgba(255, 247, 230, 0.55); font-weight: 800;
}

/* --------------------------------------------------------------------------
   Motion
   -------------------------------------------------------------------------- */

@keyframes vk-pop {
  0% { transform: scale(0.55) rotate(-7deg); opacity: 0; }
  55% { transform: scale(1.16) rotate(2deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes vk-pop-soft {
  0% { transform: scale(0.86); opacity: 0; }
  60% { transform: scale(1.06); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes vk-rise {
  0% { transform: translateY(2.4vmin); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
@keyframes vk-slide-l {
  0% { transform: translateX(-6vmin); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}
@keyframes vk-float { 0%, 100% { transform: translateY(-0.5vmin); } 50% { transform: translateY(0.5vmin); } }
@keyframes vk-breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes vk-spin { to { transform: rotate(360deg); } }
@keyframes vk-shine { 0% { transform: translateX(-120%) skewX(-18deg); } 100% { transform: translateX(320%) skewX(-18deg); } }
@keyframes vk-flash { 0% { opacity: 0.9; } 100% { opacity: 0; } }
@keyframes vk-count {
  0% { transform: scale(2.4); opacity: 0; }
  22% { transform: scale(1); opacity: 1; }
  74% { transform: scale(1); opacity: 1; }
  100% { transform: scale(0.82); opacity: 0; }
}
@keyframes vk-go {
  0% { transform: scale(0.4) rotate(-10deg); opacity: 0; }
  30% { transform: scale(1.3) rotate(3deg); opacity: 1; }
  55% { transform: scale(1.05) rotate(0deg); opacity: 1; }
  100% { transform: scale(1.9) rotate(0deg); opacity: 0; }
}
@keyframes vk-banner {
  0% { transform: translateX(-115%) skewX(-12deg); opacity: 0; }
  16% { transform: translateX(0) skewX(-12deg); opacity: 1; }
  78% { transform: translateX(0) skewX(-12deg); opacity: 1; }
  100% { transform: translateX(115%) skewX(-12deg); opacity: 0; }
}
@keyframes vk-warn { 0%, 100% { opacity: 0.25; transform: scale(0.98); } 50% { opacity: 1; transform: scale(1.02); } }
@keyframes vk-fall {
  0% { transform: translate3d(0, -12vh, 0) rotate(0deg); opacity: 1; }
  100% { transform: translate3d(var(--vk-drift, 4vw), 108vh, 0) rotate(var(--vk-tumble, 900deg)); opacity: 0.9; }
}
@keyframes vk-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes vk-scan { 0% { background-position: 0 0; } 100% { background-position: 0 -4vmin; } }

.vk-anim-pop { animation: vk-pop 0.42s cubic-bezier(0.24, 1.5, 0.36, 1) both; }
.vk-anim-rise { animation: vk-rise 0.4s cubic-bezier(0.2, 1.2, 0.3, 1) both; }
.vk-anim-fade { animation: vk-fade-in 0.35s ease both; }

/* --------------------------------------------------------------------------
   Race HUD
   -------------------------------------------------------------------------- */

/* Left inset clears the vibeverse home button — see HomeButton.tsx. */
.vk-hud-tl { position: absolute; top: 2.4vmin; left: calc(2.6vmin + var(--vv-home-clear, 0px)); display: flex; gap: 1.4vmin; align-items: flex-start; }
.vk-hud-tr { position: absolute; top: 2.4vmin; right: 2.6vmin; display: flex; flex-direction: column; align-items: flex-end; gap: 1.1vmin; }
.vk-hud-bl { position: absolute; bottom: 2.6vmin; left: 2.6vmin; display: flex; flex-direction: column; gap: 1.1vmin; align-items: flex-start; }
.vk-hud-br { position: absolute; bottom: 2.6vmin; right: 2.6vmin; }

/* Item slot ---------------------------------------------------------------- */
.vk-item {
  position: relative; width: 13vmin; height: 13vmin; border-radius: 2.4vmin;
  background: radial-gradient(circle at 50% 34%, rgba(70, 108, 165, 0.85), rgba(9, 16, 28, 0.92) 72%);
  border: 0.34vmin solid rgba(255, 255, 255, 0.24);
  box-shadow: var(--vk-drop), inset 0 0.3vmin 0 rgba(255, 255, 255, 0.3), inset 0 -0.5vmin 0 rgba(0, 0, 0, 0.4);
  display: grid; place-items: center; overflow: hidden;
}
.vk-item::before {
  content: ""; position: absolute; inset: 0.6vmin; border-radius: 1.8vmin;
  border: 0.22vmin dashed rgba(255, 255, 255, 0.14); pointer-events: none;
}
.vk-item--empty { filter: saturate(0.45) brightness(0.8); }
.vk-item--rolling { animation: vk-item-shake 0.28s ease-in-out infinite; }
@keyframes vk-item-shake {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25% { transform: translate(-0.25vmin, 0.15vmin) rotate(-1.2deg); }
  75% { transform: translate(0.25vmin, -0.15vmin) rotate(1.2deg); }
}
.vk-item--locked { animation: vk-pop 0.36s cubic-bezier(0.24, 1.6, 0.36, 1) both; }
/* The art sits in a sized box of its own: a percentage width on an SVG whose
   parent is auto-sized collapses to nothing. */
.vk-item-art { width: 76%; height: 76%; display: grid; place-items: center; }
.vk-item svg { width: 100%; height: 100%; filter: drop-shadow(0 0.4vmin 0.5vmin rgba(0, 0, 0, 0.5)); }
.vk-item > svg { width: 62%; height: 62%; }
.vk-item-glint {
  position: absolute; top: 0; bottom: 0; width: 32%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent);
  animation: vk-shine 2.6s ease-in-out infinite; pointer-events: none;
}
.vk-item-count {
  position: absolute; right: 0.7vmin; bottom: 0.5vmin;
  font-size: 2.1vmin; font-weight: 900; color: var(--vk-gold);
}

/* Lap + timer -------------------------------------------------------------- */
.vk-stack { display: flex; flex-direction: column; gap: 0.9vmin; }
.vk-lap {
  display: flex; align-items: baseline; gap: 0.8vmin; padding: 0.9vmin 1.8vmin 1vmin;
  border-radius: 1.6vmin; background: var(--vk-glass);
  border: 0.24vmin solid rgba(255, 255, 255, 0.16); box-shadow: var(--vk-drop), var(--vk-rim);
}
.vk-lap-word { font-size: 1.5vmin; letter-spacing: 0.22em; color: rgba(255, 247, 230, 0.6); }
.vk-lap-now { font-size: 3.6vmin; font-weight: 900; line-height: 0.9; color: var(--vk-cream); }
.vk-lap-of { font-size: 2vmin; font-weight: 900; color: rgba(255, 247, 230, 0.45); }
.vk-lap--final { border-color: rgba(255, 204, 34, 0.75); box-shadow: var(--vk-drop), var(--vk-rim), 0 0 2.6vmin rgba(255, 179, 34, 0.55); }
.vk-lap--final .vk-lap-now, .vk-lap--final .vk-lap-of { color: var(--vk-gold); }

.vk-times {
  display: flex; flex-direction: column; gap: 0.35vmin; padding: 0.9vmin 1.6vmin;
  border-radius: 1.4vmin; background: rgba(8, 14, 24, 0.62);
  border: 0.22vmin solid rgba(255, 255, 255, 0.12); box-shadow: var(--vk-drop);
}
.vk-times-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1.4vmin; min-width: 17vmin; }
.vk-times-key { font-size: 1.15vmin; letter-spacing: 0.2em; color: rgba(255, 247, 230, 0.5); }
.vk-times-val { font-size: 1.85vmin; font-weight: 900; }
.vk-times-val--best { color: var(--vk-gold); }
.vk-times-total { font-size: 2.5vmin; font-weight: 900; letter-spacing: 0.02em; }

/* Position ---------------------------------------------------------------- */
.vk-place { position: relative; width: 22vmin; height: 15vmin; }
.vk-place svg { width: 100%; height: 100%; overflow: visible; }
.vk-place--pop { animation: vk-pop 0.5s cubic-bezier(0.22, 1.7, 0.34, 1) both; }

.vk-coins {
  display: inline-flex; align-items: center; gap: 0.9vmin; padding: 0.7vmin 1.5vmin 0.7vmin 0.8vmin;
  border-radius: 3vmin; background: var(--vk-glass);
  border: 0.24vmin solid rgba(255, 204, 34, 0.35); box-shadow: var(--vk-drop), var(--vk-rim);
}
.vk-coins svg { width: 3vmin; height: 3vmin; }
.vk-coins-n { font-size: 2.4vmin; font-weight: 900; color: var(--vk-gold); }
.vk-coins--pop { animation: vk-pop-soft 0.34s cubic-bezier(0.24, 1.6, 0.36, 1); }

/* Speedometer ------------------------------------------------------------- */
.vk-speedo { position: relative; width: 26vmin; height: 17vmin; }
.vk-speedo svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.vk-speedo-read {
  position: absolute; left: 0; right: 0; bottom: 1.6vmin; text-align: center; pointer-events: none;
}
.vk-speedo-n { font-size: 5.4vmin; font-weight: 900; line-height: 0.86; letter-spacing: -0.02em; }
.vk-speedo-u { font-size: 1.35vmin; letter-spacing: 0.3em; color: rgba(255, 247, 230, 0.55); }

/* Minimap ----------------------------------------------------------------- */
.vk-map {
  position: relative; width: 22vmin; height: 22vmin; padding: 1.2vmin;
  border-radius: 2.2vmin; background: var(--vk-glass);
  border: 0.24vmin solid rgba(255, 255, 255, 0.16); box-shadow: var(--vk-drop), var(--vk-rim);
}
.vk-map svg { width: 100%; height: 100%; display: block; }
.vk-map-name {
  position: absolute; left: 50%; bottom: -0.2vmin; transform: translate(-50%, 50%);
  padding: 0.35vmin 1.3vmin; border-radius: 2vmin; white-space: nowrap;
  background: linear-gradient(180deg, #ffdd5c, var(--vk-gold-2)); color: #3a2000;
  font-size: 1.15vmin; font-weight: 900; letter-spacing: 0.16em; text-transform: uppercase;
  box-shadow: 0 0.4vmin 1vmin rgba(0, 0, 0, 0.45);
}

/* Overlays ---------------------------------------------------------------- */
.vk-center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }

.vk-count { font-size: 22vmin; font-weight: 900; line-height: 1; }
.vk-count svg { overflow: visible; }

.vk-banner {
  position: absolute; left: 0; right: 0; top: 26%; display: flex; justify-content: center; pointer-events: none;
}
.vk-banner-in {
  padding: 1.2vmin 5vmin; transform: skewX(-12deg);
  background: linear-gradient(180deg, #ffdd5c, var(--vk-gold-2) 62%, var(--vk-gold-3));
  box-shadow: 0 1.2vmin 2.6vmin rgba(0, 0, 0, 0.5), inset 0 0.3vmin 0 rgba(255, 255, 255, 0.65);
  animation: vk-banner 2.2s cubic-bezier(0.2, 0.9, 0.2, 1) both;
}
.vk-banner-in > span {
  display: block; transform: skewX(12deg); color: #3a1d00;
  font-size: 4.6vmin; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase;
  text-shadow: 0 0.22vmin 0 rgba(255, 255, 255, 0.55);
}
.vk-banner--hot .vk-banner-in { background: linear-gradient(180deg, #ff8fae, var(--vk-hot) 62%, #b81c46); }
.vk-banner--hot .vk-banner-in > span { color: #fff3f6; text-shadow: 0 0.22vmin 0 rgba(0, 0, 0, 0.35); }

.vk-wrong {
  position: absolute; left: 50%; top: 17%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 1.4vmin; padding: 1vmin 2.6vmin;
  border-radius: 1.4vmin; background: linear-gradient(180deg, rgba(255, 70, 70, 0.92), rgba(150, 12, 24, 0.92));
  border: 0.28vmin solid rgba(255, 220, 220, 0.6); box-shadow: 0 1vmin 2.4vmin rgba(0, 0, 0, 0.5);
  font-size: 2.4vmin; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase;
  animation: vk-warn 0.7s ease-in-out infinite;
}
.vk-wrong svg { width: 3.4vmin; height: 3.4vmin; }

/* The screen-edge glow that carries drift charge, boost and damage. */
.vk-edge {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity 0.12s linear; will-change: opacity;
}
.vk-edge--drift { box-shadow: inset 0 0 14vmin rgba(58, 217, 255, 0.55); }
.vk-edge--boost { box-shadow: inset 0 0 18vmin rgba(255, 190, 60, 0.6); }
.vk-edge--hit { box-shadow: inset 0 0 16vmin rgba(255, 68, 54, 0.7); }
.vk-edge--star {
  box-shadow: inset 0 0 20vmin rgba(255, 255, 255, 0.5);
  background: linear-gradient(120deg, rgba(255, 90, 140, 0.12), rgba(120, 220, 255, 0.12), rgba(255, 230, 90, 0.12));
}

/* Speed streaks that grow with the boost.
   Drawn as a fixed SVG starburst rather than a rotating conic gradient with a
   mask: a conic gradient is re-rasterised on every transform, and on a software
   rasteriser that is the single most expensive thing this HUD could do. Flat
   polygons plus will-change keep the spin on the compositor. */
.vk-streaks {
  position: absolute; inset: -14%; opacity: 0; pointer-events: none;
  will-change: transform, opacity;
}
.vk-streaks svg { width: 100%; height: 100%; display: block; }

/* The boost flare: a one-shot bloom up from under the kart. */
.vk-flare {
  position: absolute; left: 50%; bottom: -26vmin; width: 130vmin; height: 68vmin;
  transform: translateX(-50%); pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at 50% 100%,
    rgba(255, 226, 150, 0.9), rgba(255, 158, 40, 0.42) 38%, rgba(255, 120, 20, 0) 70%);
}
@keyframes vk-flare {
  0% { opacity: 0; transform: translateX(-50%) scaleY(0.55); }
  16% { opacity: 1; transform: translateX(-50%) scaleY(1.06); }
  100% { opacity: 0; transform: translateX(-50%) scaleY(1.3); }
}
.vk-flare--on { animation: vk-flare 0.8s cubic-bezier(0.2, 0.9, 0.3, 1) both; }

/* Touch: the right thumb owns the bottom-right corner, so the instruments move
   out from under it rather than fighting the accelerate button for the pixels. */
.vk-hud[data-touch="1"] .vk-hud-br {
  bottom: auto; top: 27vmin; right: 2.6vmin; transform: scale(0.78); transform-origin: top right;
}
.vk-hud[data-touch="1"] .vk-hud-bl { transform: scale(0.82); transform-origin: bottom left; }
.vk-hud[data-touch="1"] .vk-hud-tl { transform: scale(0.86); transform-origin: top left; }

/* Mini-turbo charge, wrapped around the speedometer. */
.vk-mt-word {
  position: absolute; left: 50%; top: -0.4vmin; transform: translateX(-50%);
  font-size: 1.3vmin; letter-spacing: 0.24em; text-transform: uppercase; opacity: 0;
  transition: opacity 0.15s ease;
}

/* Floating toast for boosts, hits and lap splits. */
.vk-toasts {
  position: absolute; left: 50%; top: 58%; transform: translateX(-50%);
  display: flex; flex-direction: column-reverse; align-items: center; gap: 0.7vmin; pointer-events: none;
}
.vk-toast {
  padding: 0.65vmin 1.8vmin; border-radius: 1.2vmin; font-size: 2vmin; font-weight: 900;
  letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap;
  background: rgba(8, 14, 24, 0.72); border: 0.22vmin solid rgba(255, 255, 255, 0.2);
  box-shadow: var(--vk-drop);
  animation: vk-toast 1.5s cubic-bezier(0.2, 1.3, 0.3, 1) both;
}
@keyframes vk-toast {
  0% { transform: translateY(2.4vmin) scale(0.7); opacity: 0; }
  18% { transform: translateY(0) scale(1.08); opacity: 1; }
  30% { transform: translateY(0) scale(1); opacity: 1; }
  76% { transform: translateY(-1.4vmin) scale(1); opacity: 1; }
  100% { transform: translateY(-4.5vmin) scale(0.94); opacity: 0; }
}

/* --------------------------------------------------------------------------
   Full-screen surfaces: title, select, pause, results
   -------------------------------------------------------------------------- */

.vk-scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(10, 22, 44, 0.35), rgba(4, 8, 16, 0.86) 78%),
    linear-gradient(180deg, rgba(4, 8, 16, 0.55), rgba(4, 8, 16, 0.8));
  animation: vk-fade-in 0.3s ease both;
}
.vk-scrim--light {
  background: linear-gradient(180deg, rgba(4, 10, 22, 0.12) 0%, rgba(4, 10, 22, 0.5) 62%, rgba(4, 10, 22, 0.82) 100%);
}

.vk-sheet {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 2.4vmin; padding: 4vmin;
}

.vk-title-head { font-size: 4.4vmin; font-weight: 900; letter-spacing: 0.16em; text-transform: uppercase; }
.vk-sub { font-size: 1.6vmin; letter-spacing: 0.34em; text-transform: uppercase; color: rgba(255, 247, 230, 0.62); }

/* A repeating chequered strip, drawn with two gradients — no image. */
.vk-check {
  height: 1.8vmin; width: 100%;
  background-image:
    linear-gradient(45deg, rgba(255, 255, 255, 0.9) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.9) 75%),
    linear-gradient(45deg, rgba(255, 255, 255, 0.9) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.9) 75%);
  background-size: 1.8vmin 1.8vmin;
  background-position: 0 0, 0.9vmin 0.9vmin;
  background-color: rgba(8, 14, 24, 0.9);
  opacity: 0.8;
}

.vk-press {
  font-size: 2.4vmin; font-weight: 900; letter-spacing: 0.3em; text-transform: uppercase;
  animation: vk-breathe 1.5s ease-in-out infinite;
}

.vk-settings {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1.2vmin 2.6vmin;
  padding: 1.4vmin 2.4vmin; border-radius: 2vmin;
  background: rgba(6, 12, 22, 0.55); border: 0.22vmin solid rgba(255, 255, 255, 0.12);
  box-shadow: var(--vk-drop);
}
.vk-set-item { display: flex; align-items: center; gap: 1vmin; }

.vk-foot {
  position: absolute; bottom: 2.4vmin; left: 0; right: 0;
  display: flex; align-items: center; justify-content: space-between; padding: 0 3vmin;
  font-size: 1.25vmin; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255, 247, 230, 0.45);
}
.vk-foot a { color: rgba(255, 247, 230, 0.6); text-decoration: none; pointer-events: auto; }
.vk-foot a:hover { color: var(--vk-gold); }

/* Multiplayer — join panel and lobby ---------------------------------------
   The lobby is a list of *people*, so it is laid out like a roster and not
   like the character grid: fixed-width rows that do not reflow when somebody
   picks a kart, because a row that jumps as a name lands is a row you lose. */
.vk-input {
  width: 100%; margin-top: 0.7vmin; padding: 1.1vmin 1.6vmin;
  border-radius: 1.2vmin; border: 0.24vmin solid rgba(255, 255, 255, 0.18);
  background: rgba(6, 12, 22, 0.66); color: var(--vk-cream);
  font: inherit; font-size: 2vmin; font-weight: 800; letter-spacing: 0.04em;
  outline: none;
}
.vk-input:focus { border-color: var(--vk-gold); box-shadow: 0 0 1.6vmin rgba(255, 190, 40, 0.35); }
.vk-input--code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 2.8vmin; letter-spacing: 0.42em; text-align: center; }

.vk-mp-join { width: min(52vmin, 88vw); padding: 2.6vmin; }
.vk-mp-code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 5.4vmin; font-weight: 900; letter-spacing: 0.34em; color: var(--vk-gold);
  margin: 0.2vmin 0 0.9vmin; }

.vk-mp-roster { width: min(62vmin, 92vw); padding: 1.6vmin; display: flex; flex-direction: column; gap: 0.9vmin; }
.vk-mp-row {
  display: flex; align-items: center; gap: 1.4vmin; padding: 0.9vmin 1.2vmin;
  border-radius: 1.3vmin; background: rgba(6, 12, 22, 0.5);
  border: 0.24vmin solid rgba(255, 255, 255, 0.1);
  transition: border-color 0.18s ease, background 0.18s ease;
}
.vk-mp-row[data-ready="1"] { border-color: rgba(94, 234, 152, 0.75); background: rgba(14, 44, 30, 0.55); }
.vk-mp-face { width: 5vmin; height: 5vmin; flex: 0 0 auto; border-radius: 1vmin; overflow: hidden;
  background: rgba(255, 255, 255, 0.07); display: grid; place-items: center; }
.vk-mp-face svg { width: 100%; height: 100%; display: block; }
.vk-mp-face-q { font-size: 2.4vmin; font-weight: 900; color: rgba(255, 247, 230, 0.35); }
.vk-mp-who { display: flex; flex-direction: column; gap: 0.25vmin; min-width: 0; }
.vk-mp-name { font-size: 2vmin; font-weight: 900; letter-spacing: 0.03em; }
.vk-mp-kart { font-size: 1.35vmin; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255, 247, 230, 0.55); }
.vk-mp-state { margin-left: auto; font-size: 1.35vmin; font-weight: 900; letter-spacing: 0.18em;
  text-transform: uppercase; color: rgba(255, 247, 230, 0.5); white-space: nowrap; }
.vk-mp-row[data-ready="1"] .vk-mp-state { color: #7ef0a8; }

.vk-mp-go { display: flex; flex-direction: column; align-items: center; gap: 0.4vmin; }
.vk-mp-go .vk-num { font-size: 13vmin; font-weight: 900; line-height: 1; color: var(--vk-gold);
  text-shadow: 0 0.8vmin 2.4vmin rgba(0, 0, 0, 0.6); }

/* Character select --------------------------------------------------------- */
.vk-roster { display: flex; gap: 1.4vmin; align-items: stretch; justify-content: center; flex-wrap: wrap; max-width: 96vw; }
.vk-card {
  position: relative; width: 15vmin; padding: 1.2vmin 1vmin 1.4vmin; border-radius: 1.8vmin;
  background: var(--vk-glass); border: 0.28vmin solid rgba(255, 255, 255, 0.14);
  box-shadow: var(--vk-drop); cursor: pointer; overflow: hidden;
  transition: transform 0.18s cubic-bezier(0.2, 1.5, 0.35, 1), border-color 0.18s ease, box-shadow 0.18s ease;
}
.vk-card:hover { transform: translateY(-0.7vmin); }
.vk-card[data-on="1"] {
  transform: translateY(-1.3vmin) scale(1.06);
  border-color: var(--vk-gold);
  box-shadow: 0 1.6vmin 3.4vmin rgba(0, 0, 0, 0.55), 0 0 3vmin rgba(255, 190, 40, 0.5), var(--vk-rim);
}
.vk-card-art { width: 100%; aspect-ratio: 1 / 1; border-radius: 1.3vmin; overflow: hidden; }
.vk-card-art svg { width: 100%; height: 100%; display: block; }
.vk-card-name {
  margin-top: 0.8vmin; text-align: center; font-size: 1.75vmin; font-weight: 900;
  letter-spacing: 0.06em; text-transform: uppercase;
}
.vk-card-class {
  margin: 0.35vmin auto 0; display: block; width: fit-content; padding: 0.15vmin 0.9vmin;
  border-radius: 1vmin; font-size: 1.05vmin; letter-spacing: 0.18em; text-transform: uppercase;
  background: rgba(255, 255, 255, 0.12); color: rgba(255, 247, 230, 0.8);
}

.vk-detail {
  display: flex; gap: 2.6vmin; align-items: center; padding: 1.8vmin 2.6vmin; border-radius: 2vmin;
  background: rgba(6, 12, 22, 0.6); border: 0.22vmin solid rgba(255, 255, 255, 0.12);
  box-shadow: var(--vk-drop); max-width: 86vmin;
}
.vk-blurb { font-size: 1.7vmin; font-weight: 700; line-height: 1.45; color: rgba(255, 247, 230, 0.86); max-width: 40vmin; }

.vk-stats { display: grid; grid-template-columns: auto 1fr; gap: 0.55vmin 1.2vmin; align-items: center; }
.vk-stat-key { font-size: 1.15vmin; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255, 247, 230, 0.55); }
.vk-pips { display: flex; gap: 0.28vmin; }
.vk-pip { width: 1.5vmin; height: 0.85vmin; border-radius: 0.28vmin; background: rgba(255, 255, 255, 0.13); }
.vk-pip[data-on="1"] { background: linear-gradient(180deg, #ffdd5c, var(--vk-gold-2)); box-shadow: 0 0 0.6vmin rgba(255, 190, 40, 0.5); }

/* Results ------------------------------------------------------------------ */
.vk-results { width: min(96vw, 118vmin); display: flex; flex-direction: column; gap: 1.4vmin; }
.vk-res-row {
  display: grid; grid-template-columns: 6vmin 1.4vmin 1fr auto auto 7vmin; align-items: center; gap: 1.6vmin;
  padding: 0.9vmin 1.6vmin; border-radius: 1.4vmin;
  background: rgba(9, 17, 30, 0.72); border: 0.22vmin solid rgba(255, 255, 255, 0.1);
  animation: vk-slide-l 0.4s cubic-bezier(0.2, 1.2, 0.3, 1) both;
}
.vk-res-row[data-me="1"] {
  background: linear-gradient(90deg, rgba(255, 204, 34, 0.22), rgba(9, 17, 30, 0.72) 60%);
  border-color: rgba(255, 204, 34, 0.6);
  box-shadow: 0 0 2.4vmin rgba(255, 190, 40, 0.28);
}
.vk-res-place { font-size: 3vmin; font-weight: 900; text-align: center; }
.vk-res-chip { width: 1.4vmin; height: 3.4vmin; border-radius: 0.7vmin; }
.vk-res-name { font-size: 2.1vmin; font-weight: 900; letter-spacing: 0.04em; }
.vk-res-time { font-size: 1.9vmin; font-weight: 900; }
.vk-res-best { font-size: 1.35vmin; color: rgba(255, 247, 230, 0.55); letter-spacing: 0.1em; }
.vk-res-pts { font-size: 2.3vmin; font-weight: 900; color: var(--vk-gold); text-align: right; }

.vk-confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.vk-confetti i {
  position: absolute; top: 0; display: block; border-radius: 0.2vmin;
  animation: vk-fall linear both;
}

/* Loading ------------------------------------------------------------------ */
.vk-load { position: absolute; inset: 0; display: grid; place-items: center; background: #060c16; }
.vk-load-bar {
  width: 44vmin; height: 1.5vmin; border-radius: 1vmin; overflow: hidden;
  background: rgba(255, 255, 255, 0.1); border: 0.22vmin solid rgba(255, 255, 255, 0.16);
}
.vk-load-fill {
  height: 100%; border-radius: 1vmin; transition: width 0.3s cubic-bezier(0.3, 1, 0.4, 1);
  background: linear-gradient(90deg, var(--vk-gold-2), var(--vk-gold) 60%, #fff2b8);
  box-shadow: 0 0 1.6vmin rgba(255, 190, 40, 0.7);
}
.vk-load-stage { margin-top: 1.6vmin; font-size: 1.4vmin; letter-spacing: 0.3em; text-transform: uppercase; color: rgba(255, 247, 230, 0.6); }

@media (prefers-reduced-motion: reduce) {
  .vk-root * { animation-duration: 0.001s !important; animation-iteration-count: 1 !important; }
}
`;
