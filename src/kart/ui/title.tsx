/**
 * Vibe Kart — the title screen.
 *
 * The front of the game, over the live world: the camera goes scenic and drifts
 * between the course's beauty marks while the logo sits on top of it. Nothing
 * here is a static backdrop — what is behind the wordmark is the track you are
 * about to race, lit by the same sun.
 *
 * It also takes the grid off auto-start. The race system will run its own
 * lights 1.5 s after boot if nobody claims it; the title screen claims it, and
 * hands it back when the player confirms a character.
 */
import { useEffect, useRef } from "react";
import { KartLogo } from "./logo";
import { useKartFrame, useRuntime } from "./runtime";
import { formatTime } from "./util";
import { GRAPHICS_LABEL, type KartSettings } from "./settings";
import { MuteButton, Seg } from "./widgets";
import type { AudioView, CameraView, RaceView, TrackView } from "./views";

/** Seconds on each beauty mark before the camera cuts to the next. */
const SCENIC_HOLD = 8.5;

interface TitleProps {
  settings: KartSettings;
  patch(next: Partial<KartSettings>): void;
  onSingle(): void;
  onMultiplayer(): void;
}

export function TitleScreen({ settings, patch, onSingle, onMultiplayer }: TitleProps) {
  const rt = useRuntime();
  const hold = useRef(0);
  const mark = useRef(0);

  useEffect(() => {
    const race = rt.ctx.services.race as RaceView | undefined;
    const camera = rt.ctx.services.camera as CameraView | undefined;
    const audio = rt.ctx.services.audio as AudioView | undefined;

    // Claim the grid: no lights until the player has picked a racer.
    if (race) {
      race.autoStart = false;
      if (race.phase !== "grid") race.restart();
    }
    camera?.setMode?.("scenic", { snap: true });
    audio?.music?.("menu");

    return () => {
      hold.current = 0;
    };
  }, [rt]);

  // Cut between beauty marks on a timer rather than a CSS animation: the camera
  // system owns the move, and it eases between marks by itself.
  useKartFrame((dt) => {
    const camera = rt.ctx.services.camera as CameraView | undefined;
    const track = rt.ctx.services.track as TrackView | undefined;
    if (!camera?.scenicTo) return;
    hold.current += dt;
    if (hold.current < SCENIC_HOLD) return;
    hold.current = 0;
    const count = (track as { scenicCount?: number } | undefined)?.scenicCount ?? 6;
    mark.current = (mark.current + 1) % Math.max(1, count);
    camera.scenicTo(mark.current);
  });

  /**
   * The title used to start on *any* key, which was right when there was one
   * way in. There are two now, and "press any key" would silently pick one of
   * them — so Enter and Space take the single-player door, M takes the other,
   * and every other key does nothing rather than the wrong thing.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSingle();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        onMultiplayer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSingle, onMultiplayer]);

  const track = rt.ctx.services.track as TrackView | undefined;
  const race = rt.ctx.services.race as RaceView | undefined;
  const record = race?.record ?? null;

  return (
    <div className="vk-layer" data-kart-hud="title">
      <div className="vk-scrim vk-scrim--light" />

      <div className="vk-sheet">
        <div className="vk-anim-pop" style={{ animationDuration: "0.7s" }}>
          <KartLogo />
        </div>

        <div
          className="vk-anim-rise"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.6vmin",
            marginTop: "-1vmin",
            animationDelay: "0.15s",
          }}
        >
          <span style={{ width: "8vmin" }} className="vk-check" />
          <span className="vk-sub">{track?.name ?? "Sunset Bluff Speedway"}</span>
          <span style={{ width: "8vmin" }} className="vk-check" />
        </div>

        <div
          className="vk-row vk-anim-rise"
          style={{ marginTop: "1.4vmin", flexWrap: "wrap", justifyContent: "center", animationDelay: "0.3s" }}
        >
          <button
            type="button"
            className="vk-btn vk-btn--gold vk-btn--wide"
            style={{ fontSize: "2.4vmin", padding: "1.8vmin 4vmin" }}
            onClick={onSingle}
          >
            <span style={{ letterSpacing: "0.22em" }}>Single Player</span>
          </button>
          <button
            type="button"
            className="vk-btn vk-btn--wide"
            style={{ fontSize: "2.4vmin", padding: "1.8vmin 4vmin" }}
            onClick={onMultiplayer}
          >
            <span style={{ letterSpacing: "0.22em" }}>Multiplayer</span>
          </button>
        </div>

        <div className="vk-label vk-anim-fade" style={{ marginTop: "-0.6vmin" }}>
          Race up to five friends on a room code
        </div>

        <div className="vk-settings vk-anim-rise" style={{ animationDelay: "0.42s" }}>
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
          <MuteButton muted={settings.muted} onToggle={() => patch({ muted: !settings.muted })} />
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
        </div>

        {record && record.lap > 0 ? (
          <div className="vk-label vk-anim-fade" style={{ letterSpacing: "0.2em" }}>
            Course record — lap {formatTime(record.lap)}
          </div>
        ) : null}
      </div>

      <div className="vk-foot">
        <span>Vibe Kart — an arcade racer for the vibeverse</span>
        <a href="/">← back to the vibeverse</a>
      </div>
    </div>
  );
}

export default TitleScreen;
