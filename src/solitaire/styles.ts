/** The table's stylesheet. Theme colours arrive as CSS variables on `.sol-root`. */
export const SOLITAIRE_CSS = `
.sol-root {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  background: var(--table); color: var(--ink); font-family: var(--font);
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  overscroll-behavior: none; touch-action: none; overflow: hidden;
  transition: background 600ms ease;
}
.sol-root * { box-sizing: border-box; }
.sol-bar {
  position: relative; z-index: 20; display: flex; align-items: center; gap: 8px;
  padding: calc(env(safe-area-inset-top) + 8px) 12px 6px calc(var(--vv-home-clear, 56px) + 8px); min-height: 56px;
}
@media (min-width: 720px) { .sol-bar { padding-left: 132px; }
}
.sol-bottom {
  position: relative; z-index: 20; display: flex; justify-content: space-around; gap: 4px;
  padding: 6px 8px calc(env(safe-area-inset-bottom) + 8px);
}
.sol-btn {
  appearance: none; border: 0; background: rgba(255,255,255,0.12); color: var(--ink);
  border-radius: 999px; padding: 8px 14px; font: inherit; font-weight: 800; font-size: 14px;
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  transition: transform 120ms ease, background 160ms ease, opacity 160ms ease;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
}
.sol-light .sol-btn { background: rgba(0,0,0,0.07); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.1); }
.sol-btn:hover { background: rgba(255,255,255,0.2); }
.sol-light .sol-btn:hover { background: rgba(0,0,0,0.12); }
.sol-btn:active { transform: scale(0.94); }
.sol-btn:disabled { opacity: 0.35; cursor: default; }
.sol-btn.is-armed { background: var(--accent); color: #111; }
.sol-btn.is-on { background: var(--ink); color: var(--inkInvert); }
.sol-tool { flex-direction: column; gap: 2px; padding: 6px 10px; font-size: 11px; min-width: 58px; background: transparent; box-shadow: none; backdrop-filter: none; }
.sol-tool svg { width: 22px; height: 22px; }
.sol-light .sol-tool { background: transparent; box-shadow: none; }
.sol-stats { display: flex; gap: 14px; font-variant-numeric: tabular-nums; font-weight: 800; font-size: 14px; }
.sol-stats small { display: block; font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--inkSoft); font-weight: 800; }
.sol-seg { display: inline-flex; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.22); gap: 2px; }
.sol-light .sol-seg { background: rgba(0,0,0,0.08); }
.sol-seg button { appearance: none; border: 0; background: transparent; color: var(--inkSoft); font: inherit; font-weight: 800; font-size: 13px; padding: 6px 12px; border-radius: 999px; cursor: pointer; transition: all 180ms ease; }
@media (max-width: 420px) { .sol-seg button { padding: 6px 9px; font-size: 12px; } .sol-stats { gap: 9px; font-size: 13px; } }
.sol-seg button.is-on { background: var(--ink); color: var(--inkInvert); }
.sol-table { position: relative; flex: 1; min-height: 0; }
.sol-slot {
  position: absolute; left: 0; top: 0; width: var(--cw); height: var(--ch);
  border-radius: calc(var(--cw) * 0.09); border: 1.5px solid var(--slot);
  background: rgba(255,255,255,0.05); display: grid; place-items: center;
  color: var(--slot); font-weight: 900; font-size: calc(var(--cw) * 0.36);
  transition: box-shadow 200ms ease, transform 200ms ease;
}
.sol-slot.is-stock { cursor: pointer; }
.sol-slot.is-pulse { animation: sol-pulse 520ms ease-out; }
@keyframes sol-pulse {
  0% { box-shadow: 0 0 0 0 var(--accent); }
  100% { box-shadow: 0 0 0 calc(var(--cw) * 0.35) transparent; }
}
.sol-target {
  position: absolute; left: 0; top: 0; pointer-events: none; z-index: 2500;
  border-radius: calc(var(--cw) * 0.1); box-shadow: 0 0 0 2px var(--accent);
  opacity: 0.45; transition: opacity 120ms ease, box-shadow 120ms ease;
}
.sol-target.is-hot { opacity: 1; box-shadow: 0 0 0 3px var(--accent), 0 0 26px var(--accent); }
.sol-pop {
  position: absolute; left: 0; top: 0; width: var(--cw); height: var(--ch); pointer-events: none; z-index: 4000;
  border-radius: calc(var(--cw) * 0.09);
  animation: sol-pop 620ms cubic-bezier(.2,.8,.3,1) forwards;
}
.sol-pop i {
  position: absolute; left: 50%; top: 50%; width: 7px; height: 7px; margin: -3.5px; border-radius: 50%;
  background: var(--accent); animation: sol-spark 620ms cubic-bezier(.15,.8,.3,1) forwards;
}
@keyframes sol-pop { 0% { box-shadow: 0 0 0 0 var(--accent); } 100% { box-shadow: 0 0 0 18px transparent; } }
@keyframes sol-spark {
  0% { transform: translate(0,0) scale(1); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.2); opacity: 0; }
}

.sol-card {
  position: absolute; left: 0; top: 0; width: var(--cw); height: var(--ch);
  transition: transform 300ms cubic-bezier(.2,.85,.25,1.04);
  will-change: transform; touch-action: none; cursor: grab; perspective: 900px;
}
.sol-card.is-instant, .sol-card.is-drag { transition: none; }
.sol-card.is-buried { visibility: hidden; }
.sol-card.is-drag { cursor: grabbing; }
.sol-flip {
  position: absolute; inset: 0; transform-style: preserve-3d;
  transform: rotateY(180deg);
  transition: transform 420ms cubic-bezier(.3,.7,.3,1.2);
}
.sol-flip.is-up { transform: rotateY(0deg); }
.sol-card.is-drag .sol-flip.is-up { transform: scale(1.06) rotate(var(--tilt, 0deg)); transition: transform 140ms ease-out; }
.sol-face {
  position: absolute; inset: 0; border-radius: calc(var(--cw) * 0.09);
  backface-visibility: hidden; -webkit-backface-visibility: hidden; overflow: hidden;
  box-shadow: 0 1px 1.5px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.12), var(--glow, 0 0 0 transparent);
  transition: box-shadow 260ms ease;
}
.sol-card.is-drag .sol-face, .sol-card.is-lift .sol-face {
  box-shadow: 0 14px 28px rgba(0,0,0,0.32), 0 4px 10px rgba(0,0,0,0.2), var(--glow, 0 0 0 transparent);
}
.sol-front { background: var(--face); border: 1px solid var(--faceEdge); color: var(--black); }
.sol-front.is-red { color: var(--red); }
.sol-corner {
  position: absolute; left: 7%; right: 7%; top: 3%; display: flex; justify-content: space-between;
  align-items: baseline; line-height: 1; font-weight: 900;
}
.sol-rank { font-size: calc(var(--cw) * 0.36); letter-spacing: -0.05em; }
.sol-suit { font-size: calc(var(--cw) * 0.3); }
.sol-corner-b { top: auto; bottom: 3%; transform: rotate(180deg); }
.sol-small .sol-corner-b { display: none; }
.sol-pip { position: absolute; left: 0; right: 0; bottom: 9%; text-align: center; font-size: calc(var(--cw) * 0.6); line-height: 1; }
.sol-ace { font-size: calc(var(--cw) * 0.78); bottom: 7%; }
.sol-small .sol-pip { bottom: 5%; font-size: calc(var(--cw) * 0.66); }
.sol-small .sol-ace { font-size: calc(var(--cw) * 0.74); }
.sol-court {
  position: absolute; left: 50%; bottom: 10%; width: 64%; aspect-ratio: 1; transform: translateX(-50%);
  border-radius: 50%; border: calc(var(--cw) * 0.035) solid var(--court);
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 0.9;
  background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.18), transparent 70%);
}
.sol-small .sol-court { bottom: 6%; width: 70%; }
.sol-court-letter { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: calc(var(--cw) * 0.34); }
.sol-court-suit { font-size: calc(var(--cw) * 0.17); }
.sol-back {
  transform: rotateY(180deg); background: var(--back); border: calc(var(--cw) * 0.045) solid var(--backEdge);
}
.sol-back-inner {
  position: absolute; inset: 5%; border-radius: calc(var(--cw) * 0.06);
  border: 1px solid rgba(255,255,255,0.28); display: grid; place-items: center;
}
.sol-emblem {
  width: 44%; aspect-ratio: 1; border-radius: 50%; background: var(--emblem); color: var(--emblemInk);
  font-weight: 900; font-size: calc(var(--cw) * 0.24); display: grid; place-items: center; font-family: var(--font);
  box-shadow: inset 0 -2px 0 rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.3);
}
.sol-no-emblem .sol-emblem { display: none; }
.sol-card.is-hint .sol-face { animation: sol-hint 1.2s ease-in-out infinite; }
@keyframes sol-hint {
  0%, 100% { box-shadow: 0 0 0 2px var(--accent), 0 0 10px var(--accent); }
  50% { box-shadow: 0 0 0 4px var(--accent), 0 0 26px var(--accent); }
}
.sol-card.is-shake .sol-flip { animation: sol-shake 340ms ease; }
@keyframes sol-shake {
  0%, 100% { translate: 0; } 20% { translate: -6px; } 40% { translate: 5px; } 60% { translate: -3px; } 80% { translate: 2px; }
}
.sol-toast {
  position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 6000;
  background: rgba(10,10,20,0.82); color: #fff; padding: 9px 16px; border-radius: 999px;
  font-weight: 800; font-size: 14px; pointer-events: none; white-space: nowrap;
  animation: sol-toast 2.2s ease forwards;
}
@keyframes sol-toast { 0% { opacity: 0; translate: 0 -8px; } 10%, 80% { opacity: 1; translate: 0 0; } 100% { opacity: 0; } }
.sol-chip {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 5000;
  padding: 8px 14px; border-radius: 999px; background: var(--accent); color: #111; font-weight: 900; font-size: 13px;
}
.sol-cascade { position: absolute; inset: 0; z-index: 7000; width: 100%; height: 100%; }
.sol-modal {
  position: absolute; inset: 0; z-index: 8000; display: grid; place-items: center;
  padding: calc(env(safe-area-inset-top) + 64px) 14px calc(env(safe-area-inset-bottom) + 14px);
  background: rgba(0,0,0,0.38); animation: sol-fade 260ms ease;
}
@keyframes sol-fade { from { opacity: 0; } to { opacity: 1; } }
.sol-sheet {
  width: min(440px, 100%); max-height: calc(100% - 16px); overflow: auto; touch-action: pan-y;
  background: rgba(18,16,30,0.94); color: #fff; border-radius: 22px; padding: 20px;
  box-shadow: 0 30px 80px rgba(0,0,0,0.5); animation: sol-rise 320ms cubic-bezier(.2,.9,.3,1.15);
  font-family: var(--font); position: relative;
}
@keyframes sol-rise { from { transform: translateY(24px) scale(0.96); opacity: 0; } to { transform: none; opacity: 1; } }
.sol-sheet h2 { margin: 0 0 4px; font-size: 26px; font-weight: 900; letter-spacing: -0.02em; }
.sol-sheet h3 { margin: 18px 0 8px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.6; }
.sol-sheet .sol-btn { background: rgba(255,255,255,0.12); color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14); }
.sol-sheet .sol-btn.is-on { background: #fff; color: #111; }
.sol-sheet .sol-btn.is-primary { background: var(--accent); color: #111; box-shadow: none; }
.sol-themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.sol-x { position: absolute; right: 14px; top: 14px; width: 34px; height: 34px; padding: 0; justify-content: center; }
.sol-theme {
  appearance: none; border: 0; padding: 0; cursor: pointer; border-radius: 14px; overflow: hidden; position: relative;
  height: 74px; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.1); transition: transform 140ms ease, box-shadow 140ms ease;
  font: inherit; color: #fff; text-align: left;
}
.sol-theme:active { transform: scale(0.96); }
.sol-theme.is-on { box-shadow: 0 0 0 3px #fff; }
.sol-theme .mini { position: absolute; top: 10px; width: 30px; height: 42px; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
.sol-theme .mini-face { display: grid; place-items: center; font-weight: 900; font-size: 15px; }
.sol-theme span.label { position: absolute; left: 8px; bottom: 6px; font-weight: 900; font-size: 12.5px; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
.sol-big { font-size: 34px; font-weight: 900; font-variant-numeric: tabular-nums; }
.sol-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sol-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; text-align: center; }
.sol-grid3 small { display: block; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.6; font-weight: 800; }
`;
