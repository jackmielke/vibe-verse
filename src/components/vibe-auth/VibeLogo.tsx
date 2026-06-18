/**
 * VibeLogo — the official Vibe smiley mark.
 *
 * Two lightning-bolt eyes (small left, big right) over a curved smile
 * whose right tip flicks upward into an arrowhead. Inherits color via
 * `currentColor` so it tints with any text-* class.
 */
export default function VibeLogo({
  size = 20,
  className = "",
  strokeWidth = 7,
}: {
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* Small lightning eye (left) — stroked outline, like the reference */}
      <path
        d="M32 30 L24 50 L33 50 L29 64 L42 44 L33 44 L37 30 Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      {/* Big lightning eye (right) */}
      <path
        d="M66 16 L52 48 L63 48 L57 70 L82 38 L70 38 L76 16 Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      {/* Smile curving up into an arrow tip on the right */}
      <path
        d="M18 66 Q50 96 80 72"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M72 68 L80 72 L76 80"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
