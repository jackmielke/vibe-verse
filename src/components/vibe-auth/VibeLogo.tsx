/**
 * VibeLogo — the official Vibe smiley mark: two lightning-bolt eyes
 * and a smile that curls up into an arrow on the right.
 * Inherits color via `currentColor` so it tints with text-* classes.
 */
export default function VibeLogo({
  size = 20,
  className = "",
}: {
  size?: number;
  className?: string;
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
      {/* Small lightning eye */}
      <path
        d="M30 28 L24 46 L31 46 L27 60 L40 40 L33 40 L37 28 Z"
        fill="currentColor"
      />
      {/* Big lightning eye */}
      <path
        d="M62 18 L52 46 L62 46 L56 66 L78 38 L68 38 L74 18 Z"
        fill="currentColor"
      />
      {/* Smile with arrow tip on the right */}
      <path
        d="M22 62 Q50 92 78 70 L74 66 M78 70 L72 74"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
