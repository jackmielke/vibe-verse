import { useEffect, useRef, useState, type RefObject } from "react";
import { isVideoClip } from "@/worlds/motion";

/**
 * A world's footage over its still: an MP4 loop for the filmed ones, the
 * older GIFs otherwise.
 *
 * The caller decides *when* to mount this (only after a hover, or once a phone
 * has scrolled the card into the middle of the screen), because mounting is
 * what downloads it. Once mounted a video plays only while `visible`, so a grid
 * that has been hovered across is not decoding twenty loops at once.
 */
export function MotionClip({
  src,
  visible,
  className = "",
  pixelated = false,
}: {
  src: string;
  visible: boolean;
  className?: string;
  pixelated?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const video = isVideoClip(src);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (visible) {
      v.play().catch(() => {
        /* autoplay refused (low power mode); the still stays up */
      });
    } else {
      v.pause();
    }
  }, [visible, ready]);

  const style = {
    opacity: ready && visible ? 1 : 0,
    ...(pixelated && !video ? { imageRendering: "pixelated" as const } : {}),
  };
  const cls = `absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${className}`;

  if (video) {
    return (
      <video
        ref={ref}
        src={src}
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
        disablePictureInPicture
        aria-hidden
        onLoadedData={() => setReady(true)}
        className={cls}
        style={style}
      />
    );
  }
  return <img src={src} alt="" onLoad={() => setReady(true)} className={cls} style={style} />;
}

/**
 * On a phone there is no hover, so "show me the clip" means "this card is in
 * the middle of the screen". Returns false everywhere with a mouse, so desktop
 * keeps the hover rule and downloads nothing on scroll.
 */
export function useCentred(ref: RefObject<HTMLElement>): boolean {
  const [centred, setCentred] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // Saver mode on a metered connection: keep the stills.
    const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const io = new IntersectionObserver(
      ([e]) => setCentred(e.isIntersecting),
      /* A band through the middle third of the screen: one or two cards at a
         time, never the whole column. */
      { rootMargin: "-35% 0px -35% 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return centred;
}
