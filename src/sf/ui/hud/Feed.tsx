/**
 * The destruction feed.
 *
 * Everything violent that the player caused, newest at the top, with the
 * chaos it paid out. It is the fastest-moving text on screen, so it is also
 * the most tightly constrained: fixed row height, monospaced numerals, no
 * wrapping, and a hard cap of six rows. A feed that reflows is a feed nobody
 * can read.
 *
 * `useSfStore.pruneNotifications` retires entries; this component only draws
 * what survives, which keeps expiry in one place rather than duplicated in
 * every consumer.
 */
import { useSfStore, type NotificationEntry } from "../../state/store";
import { useUiStore } from "../uiStore";
import { COLORS, cvdColor } from "../theme";

const MAX_ROWS = 6;

/** Kinds that belong in the violence log rather than the toast stack. */
function isFeedKind(k: NotificationEntry["kind"]): boolean {
  return k === "chaos" || k === "damage";
}

export default function Feed() {
  const notifications = useSfStore((s) => s.notifications);
  const cvd = useUiStore((s) => s.settings.colorblind);

  const rows = notifications.filter((n) => isFeedKind(n.kind)).slice(-MAX_ROWS).reverse();
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1" style={{ width: 300 }}>
      {rows.map((n, i) => {
        const damage = n.kind === "damage";
        const accent = damage ? cvdColor("danger", cvd) : COLORS.chaos;
        return (
          <div
            key={n.id}
            className="sf-anim-left flex items-center gap-2"
            style={{
              // Older rows recede rather than simply fading: it reads as depth
              // and keeps the newest line unambiguous.
              opacity: Math.max(0.28, 1 - i * 0.16),
              transform: `scale(${(1 - i * 0.022).toFixed(3)})`,
              transformOrigin: "right center",
              padding: "3px 8px",
              background: "rgba(0,0,0,0.42)",
              borderRight: `2px solid ${accent}`,
              backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
              height: 22,
              whiteSpace: "nowrap",
            }}
          >
            <span
              className="sf-display sf-text"
              style={{ fontSize: 10, letterSpacing: "0.08em", color: "rgba(255,255,255,0.88)" }}
            >
              {n.text}
            </span>
            {n.value !== undefined && n.value !== 0 && (
              <span
                className="sf-num sf-text"
                style={{ fontSize: 11, fontWeight: 700, color: accent, minWidth: 42, textAlign: "right" }}
              >
                {n.value > 0 ? `+${n.value}` : String(n.value)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
