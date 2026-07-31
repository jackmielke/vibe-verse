/**
 * Vibe Kart — the shared menu furniture.
 *
 * A segmented control, a mute button and a confetti burst. Small enough that
 * pulling in a component library would cost more than it saved, and this way
 * every control is the same moulded slab as the HUD.
 */
import { useMemo } from "react";
import { SoundGlyph } from "./icons";

interface SegProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
}

export function Seg<T extends string>({ label, value, options, onChange }: SegProps<T>) {
  return (
    <div className="vk-set-item">
      <span className="vk-label">{label}</span>
      <div className="vk-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            data-on={o.value === value ? "1" : "0"}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MuteButton({ muted, onToggle }: { muted: boolean; onToggle(): void }) {
  return (
    <div className="vk-set-item">
      <span className="vk-label">Sound</span>
      <button
        type="button"
        className="vk-btn vk-btn--sm vk-btn--ghost"
        onClick={onToggle}
        aria-pressed={muted}
        style={{ minWidth: "9vmin", gap: "0.8vmin" }}
      >
        <span style={{ display: "block", width: "2.2vmin", height: "2.2vmin" }}>
          <SoundGlyph on={!muted} />
        </span>
        {muted ? "Off" : "On"}
      </button>
    </div>
  );
}

const CONFETTI_COLORS = ["#ffcc22", "#ff4d7d", "#3ad9ff", "#8ff05a", "#b57bff", "#fff7e6"];

/**
 * The payoff. Sixty CSS-animated chips, seeded once so a re-render does not
 * reshuffle them mid-fall — cheaper than a canvas, and it disappears with the
 * screen instead of leaving a stray canvas on the page.
 */
export function Confetti({ count = 60, seed = 1 }: { count?: number; seed?: number }) {
  const chips = useMemo(() => {
    let s = (seed * 2654435761) >>> 0;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 0x100000000;
    };
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      left: `${(rnd() * 100).toFixed(2)}%`,
      w: 0.7 + rnd() * 1.1,
      h: 1.1 + rnd() * 1.6,
      color: CONFETTI_COLORS[Math.floor(rnd() * CONFETTI_COLORS.length)],
      delay: rnd() * 2.4,
      dur: 2.6 + rnd() * 2.6,
      drift: `${(rnd() * 16 - 8).toFixed(1)}vw`,
      tumble: `${Math.round(540 + rnd() * 1080)}deg`,
    }));
  }, [count, seed]);

  return (
    <div className="vk-confetti" aria-hidden="true">
      {chips.map((c) => (
        <i
          key={c.key}
          style={{
            left: c.left,
            width: `${c.w}vmin`,
            height: `${c.h}vmin`,
            background: c.color,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.dur}s`,
            ["--vk-drift" as string]: c.drift,
            ["--vk-tumble" as string]: c.tumble,
          }}
        />
      ))}
    </div>
  );
}
