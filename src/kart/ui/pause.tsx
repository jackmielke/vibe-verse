/**
 * Vibe Kart — the pause menu.
 *
 * Drawn over a live frame: the render loop keeps running while the simulation
 * is frozen, so the world behind the panel is the corner you were in, blurred
 * and dimmed rather than replaced by a flat screen. That is the difference
 * between "the game is waiting" and "the game has stopped".
 *
 * Escape resumes — the same key that opened it — and the button order puts
 * Resume where the thumb already is.
 */
import { useEffect } from "react";
import { useRuntime } from "./runtime";
import { GRAPHICS_LABEL, type KartSettings } from "./settings";
import { MuteButton, Seg } from "./widgets";
import type { AudioView, TrackView } from "./views";

interface PauseProps {
  settings: KartSettings;
  patch(next: Partial<KartSettings>): void;
  onResume(): void;
  onRestart(): void;
  onSelect(): void;
  /** In a room, the two exits are different: a solo restart would desync the
   *  field, and "change racer" means going back to the lobby to do it. */
  multiplayer?: boolean;
}

export function PauseScreen({ settings, patch, onResume, onRestart, onSelect, multiplayer }: PauseProps) {
  const rt = useRuntime();
  const track = rt.ctx.services.track as TrackView | undefined;

  useEffect(() => {
    (rt.ctx.services.audio as AudioView | undefined)?.play?.("pause", undefined, { volume: 0.7 });
  }, [rt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "p" || e.key === "P") {
        e.preventDefault();
        onResume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResume]);

  return (
    <div className="vk-layer" data-kart-hud="pause">
      <div className="vk-scrim" />
      <div className="vk-sheet" style={{ gap: "2.2vmin" }}>
        <div className="vk-panel vk-anim-pop" style={{ padding: "3.4vmin 4.6vmin", minWidth: "52vmin" }}>
          <div style={{ textAlign: "center", marginBottom: "2.4vmin" }}>
            <div className="vk-title-head vk-ink-edge">Paused</div>
            <div className="vk-sub" style={{ marginTop: "0.5vmin" }}>{track?.name ?? "Sunset Bluff Speedway"}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "1vmin" }}>
            <button type="button" className="vk-btn vk-btn--gold" onClick={onResume}>
              Resume
            </button>
            {multiplayer ? null : (
              <button type="button" className="vk-btn" onClick={onRestart}>
                Restart race
              </button>
            )}
            <button type="button" className="vk-btn vk-btn--ghost" onClick={onSelect}>
              {multiplayer ? "Back to lobby" : "Change racer"}
            </button>
            <a className="vk-btn vk-btn--ghost" href="/" style={{ textDecoration: "none" }}>
              Quit to vibeverse
            </a>
          </div>

          <div style={{ height: "0.22vmin", background: "rgba(255,255,255,0.12)", margin: "2.2vmin 0 1.8vmin" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: "1.2vmin", alignItems: "flex-start" }}>
            <Seg
              label="Graphics"
              value={settings.graphics}
              onChange={(graphics) => patch({ graphics })}
              options={[
                { value: "performance", label: GRAPHICS_LABEL.performance },
                { value: "balanced", label: GRAPHICS_LABEL.balanced },
                { value: "beautiful", label: GRAPHICS_LABEL.beautiful },
              ]}
            />
            <Seg
              label="Camera"
              value={settings.camera}
              onChange={(camera) => patch({ camera })}
              options={[
                { value: "chase", label: "Chase" },
                { value: "chaseFar", label: "Far" },
                { value: "hood", label: "Hood" },
              ]}
            />
            <Seg
              label="Class"
              value={settings.difficulty}
              onChange={(difficulty) => patch({ difficulty })}
              options={[
                { value: "50cc", label: "50" },
                { value: "100cc", label: "100" },
                { value: "150cc", label: "150" },
                { value: "200cc", label: "200" },
              ]}
            />
            <MuteButton muted={settings.muted} onToggle={() => patch({ muted: !settings.muted })} />
          </div>
        </div>

        <div className="vk-label">Esc to resume</div>
      </div>
    </div>
  );
}

export default PauseScreen;
