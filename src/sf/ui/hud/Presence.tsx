/**
 * Who else is in this San Francisco.
 *
 * Small on purpose. The interesting version of "there are other people here"
 * is the people themselves — walking past you on Market with their names over
 * their heads — and a list in the corner is only the bit that tells you they
 * exist when none of them happen to be on your street.
 *
 * Renders nothing at all when you are alone, rather than saying "0 others".
 * An empty city should not announce that it is empty every frame you are in
 * it; the difference is the whole feeling of the thing.
 */
import { useSfStore } from "../../state/store";
import { COLORS, rgba } from "../theme";

/** Beyond this we stop naming names and start counting heads. */
const NAME_LIMIT = 4;

export default function Presence() {
  const peers = useSfStore((s) => s.peers);
  if (peers.length === 0) return null;

  const shown = peers.slice(0, NAME_LIMIT);
  const extra = peers.length - shown.length;

  return (
    <div
      style={{
        padding: "6px 10px",
        background: "rgba(0,0,0,0.34)",
        borderLeft: `2px solid ${COLORS.good}`,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        maxWidth: 240,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: COLORS.good,
            boxShadow: `0 0 8px ${rgba(COLORS.good, 0.8)}`,
          }}
        />
        <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.3em" }}>
          {peers.length === 1 ? "1 OTHER HERE" : `${peers.length} OTHERS HERE`}
        </span>
      </div>
      <div
        className="sf-text"
        style={{
          marginTop: 3,
          fontSize: 11,
          lineHeight: 1.35,
          color: COLORS.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {shown.join(", ")}
        {extra > 0 ? ` +${extra}` : ""}
      </div>
    </div>
  );
}
