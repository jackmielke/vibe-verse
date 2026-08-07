/**
 * Vibe Kart — character select.
 *
 * Eight cards, one detail panel, one confirm. The cards are the roster the
 * model system publishes, so a character added to `models/roster.ts` turns up
 * here with its own colours and stats and nothing in the UI has to know.
 *
 * Confirming does three things in order: re-spawn the player's kart on the same
 * racer id with the chosen `characterId` (which is the physics system's own
 * documented restart path, so every captured reference stays valid), drop the
 * old rig so the model system rebuilds it in the new livery, and hand the grid
 * back to the race system. If any of those services is missing the screen still
 * confirms — you just race whoever physics already put on the grid.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CharacterPreset } from "../types";
import { CharacterPortrait } from "./portrait";
import { useRuntime } from "./runtime";
import { hex, weightLabel } from "./util";
import type { AudioView, ModelsView, PhysicsView } from "./views";

const STAT_ROWS: Array<{ key: keyof CharacterPreset["stats"]; label: string }> = [
  { key: "speed", label: "Speed" },
  { key: "accel", label: "Accel" },
  { key: "handling", label: "Handling" },
  { key: "traction", label: "Grip" },
  { key: "weight", label: "Weight" },
];

function Pips({ value }: { value: number }) {
  const n = Math.max(0, Math.min(10, Math.round(value)));
  return (
    <div className="vk-pips">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className="vk-pip" data-on={i < n ? "1" : "0"} />
      ))}
    </div>
  );
}

interface SelectProps {
  onConfirm(characterId: string): void;
  onBack(): void;
  /** "Start race" solo; in a room, confirming takes you back to the roster. */
  confirmLabel?: string;
}

/**
 * A phone has no arrow keys and no Enter. Reading the pointer rather than the
 * user-agent means a laptop with a touchscreen gets whichever one it last
 * actually used — but for the case that matters, a thumb on a phone, this is
 * the difference between an instruction and a dead end.
 */
const COARSE_POINTER =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

export function SelectScreen({ onConfirm, onBack, confirmLabel = "Start race" }: SelectProps) {
  const rt = useRuntime();
  const models = rt.ctx.services.models as ModelsView | undefined;
  const roster: CharacterPreset[] = models?.roster ?? [];
  const physics = rt.ctx.services.physics as PhysicsView | undefined;

  // Start on whoever the player is already driving, so backing out and coming
  // back does not silently move them.
  const [index, setIndex] = useState(() => {
    const id = physics?.player?.characterId;
    const at = roster.findIndex((p) => p.id === id);
    return at >= 0 ? at : 0;
  });
  const confirmed = useRef(false);

  const pick = useCallback(
    (id: string) => {
      if (confirmed.current) return;
      confirmed.current = true;
      (rt.ctx.services.audio as AudioView | undefined)?.play?.("select", undefined, { volume: 0.85 });
      onConfirm(id);
    },
    [onConfirm, rt],
  );

  const move = useCallback(
    (delta: number) => {
      if (!roster.length) return;
      setIndex((i) => (i + delta + roster.length) % roster.length);
      (rt.ctx.services.audio as AudioView | undefined)?.play?.("move", undefined, { volume: 0.55 });
    },
    [roster.length, rt],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      switch (e.key) {
        case "ArrowLeft":
        case "a":
        case "A":
          e.preventDefault();
          move(-1);
          break;
        case "ArrowRight":
        case "d":
        case "D":
          e.preventDefault();
          move(1);
          break;
        case "ArrowUp":
        case "w":
        case "W":
          e.preventDefault();
          move(-4);
          break;
        case "ArrowDown":
        case "s":
        case "S":
          e.preventDefault();
          move(4);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (roster[index]) pick(roster[index].id);
          else pick("");
          break;
        case "Escape":
        case "Backspace":
          e.preventDefault();
          onBack();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, move, onBack, pick, roster]);

  const chosen = roster[index];

  return (
    <div className="vk-layer" data-kart-hud="select">
      <div className="vk-scrim" />

      <div className="vk-sheet" style={{ gap: "2vmin" }}>
        <div style={{ textAlign: "center" }}>
          <div className="vk-title-head vk-ink-edge">Choose your racer</div>
          <div className="vk-sub" style={{ marginTop: "0.6vmin" }}>
            {COARSE_POINTER ? "Tap a racer · tap again to confirm" : "← → to browse · Enter to confirm"}
          </div>
        </div>

        {roster.length ? (
          <div className="vk-roster">
            {roster.map((preset, i) => (
              <button
                key={preset.id}
                type="button"
                className="vk-card vk-anim-rise"
                data-on={i === index ? "1" : "0"}
                style={{ animationDelay: `${Math.min(i * 0.04, 0.32)}s`, font: "inherit", color: "inherit" }}
                onClick={() => (i === index ? pick(preset.id) : setIndex(i))}
                onDoubleClick={() => pick(preset.id)}
                aria-pressed={i === index}
              >
                <div className="vk-card-art">
                  <CharacterPortrait preset={preset} />
                </div>
                <div className="vk-card-name vk-ink-edge">{preset.name}</div>
                <span className="vk-card-class">{weightLabel(preset.weight)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="vk-detail">
            <div className="vk-blurb">
              The roster did not load, so the grid is whatever the physics system put out there. Race anyway?
            </div>
          </div>
        )}

        {chosen ? (
          <div className="vk-detail vk-anim-rise" key={chosen.id}>
            <div style={{ width: "18vmin", flex: "0 0 auto", borderRadius: "1.4vmin", overflow: "hidden" }}>
              <CharacterPortrait preset={chosen} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1vmin" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "1.4vmin" }}>
                <span style={{ fontSize: "3.4vmin", fontWeight: 900, letterSpacing: "0.04em" }}>{chosen.name}</span>
                <span className="vk-card-class">{weightLabel(chosen.weight)} class</span>
              </div>
              <p className="vk-blurb" style={{ margin: 0 }}>
                {chosen.blurb}
              </p>
              <div style={{ display: "flex", gap: "0.7vmin", marginTop: "0.3vmin" }}>
                {[chosen.colors.body, chosen.colors.accent, chosen.colors.trim].map((c, i) => (
                  <span
                    key={i}
                    style={{
                      width: "2.4vmin",
                      height: "2.4vmin",
                      borderRadius: "0.7vmin",
                      background: hex(c),
                      border: "0.22vmin solid rgba(255,255,255,0.35)",
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="vk-stats">
              {STAT_ROWS.map((row) => (
                <div key={row.key} style={{ display: "contents" }}>
                  <span className="vk-stat-key">{row.label}</span>
                  <Pips value={chosen.stats[row.key]} />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="vk-row" style={{ marginTop: "0.6vmin" }}>
          <button type="button" className="vk-btn vk-btn--ghost" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="vk-btn vk-btn--gold vk-btn--wide"
            style={{ fontSize: "2.2vmin" }}
            onClick={() => pick(chosen?.id ?? "")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SelectScreen;
