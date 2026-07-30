/**
 * The toast stack.
 *
 * The destruction feed handles the fast, disposable stuff (see hud/Feed).
 * This is the other half: the things the player should actually stop and
 * read — an objective completed, a weapon unlocked, a district discovered.
 * They are bigger, they are slower, and there are never more than four.
 *
 * Expiry is owned by the store (`pruneNotifications`), which the HUD pumps
 * once a second. Nothing here sets its own timers, so a paused game does not
 * silently eat the message you paused to read.
 */
import { useSfStore, type NotificationEntry } from "../state/store";
import { useUiStore } from "./uiStore";
import { COLORS, cvdColor } from "./theme";

const MAX = 4;

function isToastKind(k: NotificationEntry["kind"]): boolean {
  return k === "info" || k === "objective" || k === "unlock";
}

export default function Notifications() {
  const notifications = useSfStore((s) => s.notifications);
  const cvd = useUiStore((s) => s.settings.colorblind);

  const rows = notifications.filter((n) => isToastKind(n.kind)).slice(-MAX);
  if (rows.length === 0) return null;

  return (
    <div
      className="fixed flex flex-col gap-2"
      style={{
        left: "var(--sf-edge)",
        top: "50%",
        transform: "translateY(-50%)",
        width: 320,
        zIndex: 30,
        opacity: "var(--sf-hud-opacity)",
      }}
    >
      {rows.map((n) => {
        const style = toastStyle(n.kind, cvd);
        return (
          <div
            key={n.id}
            className="sf-anim-right"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 13px",
              background: "linear-gradient(90deg, rgba(10,12,17,0.86), rgba(10,12,17,0.42))",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              borderLeft: `2px solid ${style.accent}`,
              boxShadow: "0 12px 34px -16px rgba(0,0,0,0.95)",
            }}
          >
            <div style={{ color: style.accent, flexShrink: 0, marginTop: 1 }}>
              <svg width={16} height={16} viewBox="0 0 16 16">
                <path d={style.icon} fill="currentColor" />
              </svg>
            </div>
            <div className="flex flex-col" style={{ minWidth: 0 }}>
              <span
                className="sf-label"
                style={{ fontSize: 8, letterSpacing: "0.26em", color: style.accent }}
              >
                {style.title}
              </span>
              <span
                className="sf-text"
                style={{ fontSize: 12, color: "rgba(255,255,255,0.94)", lineHeight: 1.35, marginTop: 2 }}
              >
                {n.text}
              </span>
            </div>
            {n.value !== undefined && n.value !== 0 && (
              <>
                <div className="flex-1" />
                <span
                  className="sf-num"
                  style={{ fontSize: 15, fontWeight: 700, color: style.accent, alignSelf: "center" }}
                >
                  {n.value > 0 ? `+${n.value}` : String(n.value)}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function toastStyle(kind: NotificationEntry["kind"], cvd: Parameters<typeof cvdColor>[1]) {
  switch (kind) {
    case "objective":
      return {
        accent: COLORS.signal,
        title: "OBJECTIVE",
        icon: "M8 1 L15 14 L1 14 Z M8 6 L11.5 12.5 L4.5 12.5 Z",
      };
    case "unlock":
      return {
        accent: cvdColor("good", cvd),
        title: "UNLOCKED",
        icon: "M4 7V5a4 4 0 018 0h-2a2 2 0 00-4 0v2h6v8H2V7z",
      };
    default:
      return {
        accent: cvdColor("info", cvd),
        title: "NOTICE",
        icon: "M8 0a8 8 0 100 16A8 8 0 008 0zm1 12H7V7h2zm0-6H7V4h2z",
      };
  }
}
