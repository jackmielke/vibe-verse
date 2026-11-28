import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { artFor } from "@/worlds/art";
import { motionFor } from "@/worlds/motion";
import { MotionClip } from "@/worlds/MotionClip";
import { PIXEL, ROUND } from "./shared";

/**
 * The featured world on the Arcade front door: Vibe City, playing.
 *
 * It sits below the title screen, so it never competes with first paint. The
 * clip is only mounted (which is what downloads it) once the page has loaded
 * and the banner is actually on screen, and it pauses when scrolled away. With
 * reduced motion or Save-Data it stays a still, like every other card.
 */
const NAVY = "#06204a";
const SUN = "#ffd23f";

export default function Featured({
  worldKey = "city",
  route = "/city",
  name = "Vibe City",
  blurb = "Jetpack over the plaza at sunset, race karts, fish off the pier, talk to the locals and run from the police chopper. Everybody you see is really there.",
}: {
  worldKey?: string;
  route?: string;
  name?: string;
  blurb?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [armed, setArmed] = useState(false);
  const still = artFor(worldKey);
  const clip = motionFor(worldKey);

  useEffect(() => {
    if (!clip) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const arm = () => setArmed(true);
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    return () => window.removeEventListener("load", arm);
  }, [clip]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const [ever, setEver] = useState(false);
  useEffect(() => {
    if (armed && inView) setEver(true);
  }, [armed, inView]);

  return (
    <section className="mx-auto max-w-6xl 2xl:max-w-7xl px-4 pt-10 sm:px-6" aria-label={`Featured: ${name}`}>
      <Link
        to={route}
        data-testid="featured-world"
        className="group grid overflow-hidden rounded-[10px] bg-white transition-transform hover:-translate-x-px hover:-translate-y-px lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]"
        style={{ border: `3px solid ${NAVY}`, boxShadow: `8px 8px 0 ${NAVY}` }}
      >
        <div ref={box} className="relative aspect-video w-full overflow-hidden bg-black">
          {still && <img src={still} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
          {clip && ever && <MotionClip src={clip} visible={inView} />}
          <span
            className="absolute left-3 top-3 rounded-[4px] px-2 py-1 text-[11px] tracking-[0.12em]"
            style={{ fontFamily: PIXEL, background: SUN, color: NAVY, border: `2px solid ${NAVY}` }}
          >
            ★ FEATURED
          </span>
        </div>
        <div className="flex flex-col justify-center gap-3 p-5 sm:p-6" style={{ color: NAVY }}>
          <p className="text-[12px] tracking-[0.14em] text-[#1585f5]" style={{ fontFamily: PIXEL }}>
            NOW PLAYING
          </p>
          <h2 className="text-[30px] font-bold leading-[1.02] sm:text-[40px]" style={{ fontFamily: ROUND }}>
            {name}
          </h2>
          <p className="text-[14.5px] leading-relaxed text-[#06204a]/75">{blurb}</p>
          <span
            className="mt-1 flex h-11 items-center justify-center rounded-[6px] text-[15px] sm:text-[17px]"
            style={{ fontFamily: PIXEL, fontWeight: 700, background: SUN, color: NAVY, border: `3px solid ${NAVY}` }}
          >
            ▶ PLAY {name.toUpperCase()}
          </span>
        </div>
      </Link>
    </section>
  );
}
