/**
 * Vibe Kart — the results screen.
 *
 * The payoff, and the only screen allowed to be slow: rows slide in one after
 * another, the points land on the beat, and if the player made the podium the
 * confetti falls. A race that ends with a table appearing instantly is a race
 * that ends with nothing.
 *
 * The order comes from `race.results()` when the race system has published a
 * final classification, and falls back to the live standings — which is what
 * you want if the screen is opened early, or if the extras are missing.
 */
import { useEffect, useMemo } from "react";
import type { CharacterPreset, Standing } from "../types";
import { TrophyGlyph } from "./icons";
import { useRuntime } from "./runtime";
import { formatTime, hex, pointsFor } from "./util";
import { Confetti } from "./widgets";
import type { AudioView, CameraView, ModelsView, PhysicsView, RaceView, TrackView } from "./views";

interface ResultsProps {
  onAgain(): void;
  onSelect(): void;
  onTitle(): void;
}

interface Row extends Standing {
  color: string;
  isPlayer: boolean;
  points: number;
}

export function ResultsScreen({ onAgain, onSelect, onTitle }: ResultsProps) {
  const rt = useRuntime();

  const rows = useMemo<Row[]>(() => {
    const race = rt.ctx.services.race as RaceView | undefined;
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    const models = rt.ctx.services.models as ModelsView | undefined;
    const standings = race?.results?.() ?? race?.standings?.() ?? [];
    const playerId = physics?.player?.id;

    return standings
      .slice()
      .sort((a, b) => a.place - b.place)
      .map((s) => {
        const racer = physics?.racers?.find((r) => r.id === s.id);
        const preset: CharacterPreset | undefined = racer
          ? models?.preset?.(racer.characterId) ?? models?.roster?.find((p) => p.id === racer.characterId)
          : undefined;
        return {
          ...s,
          color: preset ? hex(preset.colors.body) : "#8fa6c4",
          isPlayer: s.id === playerId,
          points: pointsFor(s.place),
        };
      });
  }, [rt]);

  const player = rows.find((r) => r.isPlayer);
  const podium = !!player && player.place <= 3;
  const fastest = rows.reduce((best, r) => (r.bestLap > 0 && (best === 0 || r.bestLap < best) ? r.bestLap : best), 0);
  const track = rt.ctx.services.track as TrackView | undefined;

  useEffect(() => {
    (rt.ctx.services.camera as CameraView | undefined)?.setMode?.("results");
    (rt.ctx.services.audio as AudioView | undefined)?.music?.("results");
  }, [rt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onAgain();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAgain]);

  return (
    <div className="vk-layer" data-kart-hud="results">
      <div className="vk-scrim" />
      {podium ? <Confetti count={80} seed={player?.place ?? 1} /> : null}

      <div className="vk-sheet" style={{ gap: "1.8vmin" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1.6vmin" }} className="vk-anim-pop">
          <span style={{ width: "6vmin", height: "6vmin", display: "block" }}>
            <TrophyGlyph />
          </span>
          <div>
            <div className="vk-title-head vk-ink-edge">Results</div>
            <div className="vk-sub">{track?.name ?? "Sunset Bluff Speedway"}</div>
          </div>
        </div>

        <div className="vk-results">
          {rows.map((r, i) => (
            <div
              key={r.id}
              className="vk-res-row"
              data-me={r.isPlayer ? "1" : "0"}
              style={{ animationDelay: `${0.08 + i * 0.07}s` }}
            >
              <span className="vk-res-place vk-num vk-ink-edge" style={{ color: r.place <= 3 ? "#ffd34d" : undefined }}>
                {r.place}
              </span>
              <span className="vk-res-chip" style={{ background: r.color }} />
              <span className="vk-res-name vk-ink-edge">{r.name}</span>
              <span style={{ textAlign: "right" }}>
                <span className="vk-res-time vk-num">{r.finished ? formatTime(r.time) : "DNF"}</span>
                <span className="vk-res-best vk-num" style={{ display: "block" }}>
                  {r.bestLap > 0 ? `best ${formatTime(r.bestLap)}` : "—"}
                </span>
              </span>
              <span
                className="vk-card-class"
                style={{
                  visibility: r.bestLap > 0 && r.bestLap === fastest ? "visible" : "hidden",
                  background: "linear-gradient(180deg,#ffdd5c,#ffa919)",
                  color: "#3a2000",
                }}
              >
                Fastest lap
              </span>
              <span className="vk-res-pts vk-num">+{r.points}</span>
            </div>
          ))}
        </div>

        <div className="vk-row" style={{ marginTop: "1vmin" }}>
          <button type="button" className="vk-btn vk-btn--gold vk-btn--wide" onClick={onAgain}>
            Race again
          </button>
          <button type="button" className="vk-btn" onClick={onSelect}>
            Change racer
          </button>
          <button type="button" className="vk-btn vk-btn--ghost" onClick={onTitle}>
            Title
          </button>
        </div>
      </div>
    </div>
  );
}

export default ResultsScreen;
