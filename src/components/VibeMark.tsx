/**
 * The wink, as a picture first and as a live object a moment later.
 *
 * Two marks exist and each is right about something. The glass render is the
 * real artwork and it paints in one frame off the image cache. `VibeArc` is the
 * same shape as actual geometry — it turns, it catches the light differently
 * every second, and it can react to things — and it costs three.js, a GLB and
 * a WebGL context to say so.
 *
 * So this shows the picture immediately and upgrades underneath the visitor:
 * the poster paints, three.js and the model arrive in the background, the first
 * lit frame is rendered *before* anything fades, and then the two cross-fade
 * over half a second. Nobody sees a gap, nothing reflows, and on a phone that
 * never finishes the download — or has WebGL off, or asked for reduced motion —
 * the poster simply stays, which is the same mark it always was.
 *
 * Three rules, each of them the reason a naive version of this is worse:
 *
 * 1. **The upgrade is dynamically imported.** `/game` is the landing page and
 *    does not otherwise touch three.js; statically importing `VibeArc` here
 *    would put the whole renderer in the chunk that has to paint first, to
 *    animate a logo. The import does not start until the mark is on screen.
 * 2. **The poster stays mounted underneath.** It is the fallback for every
 *    failure that cannot be detected in advance — a GLB that 404s, a driver
 *    that refuses a context — and keeping it costs one cached image.
 * 3. **`prefers-reduced-motion` opts out entirely.** Not "upgrade but hold
 *    still": a person who asked for less motion should not be paying for a
 *    renderer either.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import VibeWink from "@/components/VibeWink";

const VibeArc = lazy(() => import("@/components/VibeArc"));

interface Props {
  /** Pixel size of the mark. */
  size?: number;
  /** Seconds per turn once it is live. */
  rotateSeconds?: number;
  /** Fetch the poster eagerly — for the one mark a page is built around. */
  priority?: boolean;
  /** Let it celebrate when the vibeverse says something good happened. */
  celebrates?: boolean;
  className?: string;
}

/** Whether upgrading is appropriate at all on this device, right now. */
function wantsLive(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  /* Save-Data is a person telling the browser they are paying for bytes. A
     decorative renderer is exactly what they meant. */
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /(^|-)2g$/.test(conn.effectiveType)) return false;
  return true;
}

export default function VibeMark({
  size = 120,
  rotateSeconds = 26,
  priority = false,
  celebrates = false,
  className = "",
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Start loading the renderer. */
  const [upgrade, setUpgrade] = useState(false);
  /** The live mark has drawn its first frame — safe to fade the poster out. */
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !wantsLive()) return;
    if (typeof IntersectionObserver === "undefined") {
      setUpgrade(true);
      return;
    }
    /* Nothing downloads for a mark that is below the fold and may never be
       scrolled to. The margin is generous so the upgrade has a moment to
       arrive before it is actually looked at. */
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setUpgrade(true);
        io.disconnect();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: "relative", width: size, height: size }}
    >
      {/* The picture. Always mounted; fades out once the live one is drawn. */}
      <div
        data-vv-mark="poster"
        style={{
          position: "absolute",
          inset: 0,
          opacity: live ? 0 : 1,
          transition: "opacity 520ms ease",
          pointerEvents: "none",
        }}
      >
        <VibeWink size={size} priority={priority} />
      </div>

      {upgrade && (
        <Suspense fallback={null}>
          <div
            data-vv-mark="live"
            style={{
              position: "absolute",
              inset: 0,
              opacity: live ? 1 : 0,
              transition: "opacity 520ms ease",
            }}
          >
            <VibeArc
              size={size}
              rotateSeconds={rotateSeconds}
              celebrates={celebrates}
              onReady={() => setLive(true)}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}
