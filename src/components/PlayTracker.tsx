/**
 * Counts time spent in whichever world is on screen, for every world at once.
 *
 * Mounted once in `App`, beside `ExplorerStamp`, so no world has to know it
 * exists: it reads the route, looks the world up in the registry, and counts.
 * Nothing it holds outlives the tab. See `src/lib/worldStats.ts` for why the
 * totals cannot be traced back to anybody.
 *
 * - **Active time only.** A second counts when the tab is visible and somebody
 *   touched a key, the mouse, the screen or a gamepad in the last 90 seconds,
 *   so a world left open overnight is not a world played overnight.
 * - **A visit counts after ten active seconds**, so bouncing off a card is not
 *   a session and not a player.
 * - **Frame rate** is the browser's own `requestAnimationFrame` cadence while
 *   visible. Every world here renders on the main thread, so that cadence is
 *   the world's frame rate.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import {
  PENDING_KEY,
  RATE_AFTER_SECONDS,
  claimNewPlayer,
  hasRated,
  ratingSnoozed,
  sendPlay,
  trackingEnabled,
  worldForLocation,
} from "@/lib/worldStats";

const IDLE_MS = 90_000;
const FIRST_FLUSH_S = 10;
const FLUSH_EVERY_S = 60;

interface Visit {
  world: string;
  /** Active seconds in this visit so far. */
  total: number;
  /** Active seconds not yet sent. */
  unsent: number;
  counted: boolean;
  frames: number;
  frameMs: number;
}

export default function PlayTracker() {
  const { pathname, search } = useLocation();
  const visit = useRef<Visit | null>(null);
  const lastInput = useRef(Date.now());

  const flush = (keepalive = false) => {
    const v = visit.current;
    if (!v || !v.counted || v.unsent <= 0) return;
    const fps = v.frameMs > 2000 ? (v.frames * 1000) / v.frameMs : null;
    sendPlay({ world: v.world, seconds: v.unsent, fps }, keepalive);
    v.unsent = 0;
    v.frames = 0;
    v.frameMs = 0;
  };

  // Input, visibility, frame counter: once.
  useEffect(() => {
    if (!trackingEnabled()) return;
    const poke = () => (lastInput.current = Date.now());
    const evs = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, poke, { passive: true, capture: true }));

    const onHide = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);

    let raf = 0;
    let last = performance.now();
    const frame = (t: number) => {
      const dt = t - last;
      last = t;
      const v = visit.current;
      // A gap over half a second is a hidden tab or a stall at load, not a frame.
      if (v && dt < 500 && document.visibilityState === "visible") {
        v.frames += 1;
        v.frameMs += dt;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    let gamepadSeen = 0;
    const tick = window.setInterval(() => {
      const v = visit.current;
      if (!v) return;
      // Gamepads fire no events; a pressed button or a tilted stick counts.
      if (navigator.getGamepads && ++gamepadSeen % 2 === 0) {
        for (const g of navigator.getGamepads() ?? []) {
          if (g && (g.buttons.some((b) => b.pressed) || g.axes.some((a) => Math.abs(a) > 0.3))) poke();
        }
      }
      const active = document.visibilityState === "visible" && Date.now() - lastInput.current < IDLE_MS;
      if (!active) return;
      v.total += 1;
      v.unsent += 1;
      if (!v.counted && v.total >= FIRST_FLUSH_S) {
        v.counted = true;
        const fps = v.frameMs > 2000 ? (v.frames * 1000) / v.frameMs : null;
        sendPlay({ world: v.world, seconds: v.unsent, newSession: true, newPlayer: claimNewPlayer(v.world), fps });
        v.unsent = 0;
        v.frames = 0;
        v.frameMs = 0;
      } else if (v.counted && v.unsent >= FLUSH_EVERY_S) {
        flush();
      }
      if (v.total === RATE_AFTER_SECONDS && !hasRated(v.world) && !ratingSnoozed(v.world)) {
        try {
          localStorage.setItem(PENDING_KEY, v.world);
        } catch {
          /* no prompt then */
        }
      }
    }, 1000);

    return () => {
      evs.forEach((e) => window.removeEventListener(e, poke, { capture: true }));
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      cancelAnimationFrame(raf);
      clearInterval(tick);
      flush(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route changes: close the old visit, open the new one.
  useEffect(() => {
    if (!trackingEnabled()) return;
    const key = worldForLocation(pathname, search)?.key ?? null;
    if (visit.current?.world === key) return;
    flush();
    visit.current = key ? { world: key, total: 0, unsent: 0, counted: false, frames: 0, frameMs: 0 } : null;
    lastInput.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  return null;
}
