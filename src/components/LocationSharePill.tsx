/**
 * LocationSharePill — single-player "share my live location" pill.
 *
 * No sign-in required. Clicking it asks the browser for permission,
 * then continuously watches the device's position and broadcasts it
 * to the map via a window CustomEvent (`lovable:my-location`). The
 * map listens, drops/updates a green "you are here" dot, and flies
 * to the position the first time it arrives.
 *
 * State (sharing on/off + last coords) is persisted in localStorage
 * so a refresh resumes tracking without re-prompting.
 *
 * This pill intentionally has no auth gating — it's a personal,
 * client-only feature. Community location sharing (the broadcast-
 * to-others version) lives elsewhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Loader2, X, Crosshair } from "lucide-react";

interface Props {
  className?: string;
}

interface MyCoord {
  lat: number;
  lng: number;
  updatedAt: number;
}

const STORAGE_KEY = "lovable.myLocation.v1";
const ACTIVE_KEY = "lovable.myLocation.active.v1";
export const MY_LOCATION_EVENT = "lovable:my-location";
export const MY_LOCATION_STOP_EVENT = "lovable:my-location-stop";

function broadcast(coord: MyCoord) {
  window.dispatchEvent(new CustomEvent(MY_LOCATION_EVENT, { detail: coord }));
}

export default function LocationSharePill({ className }: Props) {
  const [coord, setCoord] = useState<MyCoord | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as MyCoord) : null;
    } catch { return null; }
  });
  const [sharing, setSharing] = useState<boolean>(() => {
    return localStorage.getItem(ACTIVE_KEY) === "1";
  });
  const [busy, setBusy] = useState<"idle" | "locating">("idle");
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const stopWatch = useCallback(() => {
    if (watchIdRef.current != null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
  }, []);

  const startWatch = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError("This browser doesn't support location.");
      return;
    }
    setError(null);
    setBusy("locating");
    // One-shot first so the map flies to us quickly, then watch.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next: MyCoord = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          updatedAt: Date.now(),
        };
        setCoord(next);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* noop */ }
        broadcast(next);
        setBusy("idle");
      },
      (e) => {
        setError(e.message || "Couldn't read your location.");
        setBusy("idle");
        setSharing(false);
        localStorage.removeItem(ACTIVE_KEY);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
    // Live updates.
    stopWatch();
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next: MyCoord = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          updatedAt: Date.now(),
        };
        setCoord(next);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* noop */ }
        broadcast(next);
      },
      () => { /* keep last known */ },
      { enableHighAccuracy: true, maximumAge: 15_000 },
    );
  }, [stopWatch]);

  const start = useCallback(() => {
    setSharing(true);
    localStorage.setItem(ACTIVE_KEY, "1");
    startWatch();
  }, [startWatch]);

  const stop = useCallback(() => {
    setSharing(false);
    localStorage.removeItem(ACTIVE_KEY);
    stopWatch();
    window.dispatchEvent(new Event(MY_LOCATION_STOP_EVENT));
  }, [stopWatch]);

  // Resume tracking on mount if the user previously opted in.
  useEffect(() => {
    if (sharing) startWatch();
    return () => stopWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const positionClass = className ?? "absolute bottom-24 md:bottom-20 right-4 z-30";

  if (sharing && coord) {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`${positionClass} glass-panel rounded-full pl-2 pr-1 py-1 flex items-center gap-1.5 border border-emerald-400/40 bg-emerald-400/8`}
        >
          <span className="relative flex h-2 w-2 ml-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-emerald-200">
            Live location
          </span>
          <button
            onClick={startWatch}
            className="p-1 rounded-full hover:bg-emerald-400/20 transition-colors"
            title="Re-center on me"
          >
            {busy === "locating"
              ? <Loader2 className="w-3 h-3 text-emerald-200 animate-spin" />
              : <Crosshair className="w-3 h-3 text-emerald-200" />}
          </button>
          <button
            onClick={stop}
            className="p-1 rounded-full hover:bg-rose-400/30 transition-colors mr-0.5"
            title="Stop sharing"
          >
            <X className="w-3 h-3 text-rose-200" />
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <div className={`${positionClass} flex flex-col items-end gap-1`}>
      <button
        onClick={start}
        disabled={busy !== "idle"}
        className="glass-panel rounded-full pl-2 pr-3 py-1.5 flex items-center gap-1.5 hover:bg-primary/15 transition-colors text-[11px] font-heading font-semibold disabled:opacity-50 border border-primary/30"
        title="Show me on the map"
      >
        {busy === "locating" ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> Locating…</>
        ) : (
          <><MapPin className="w-3.5 h-3.5 text-primary" /> Share live location</>
        )}
      </button>
      {error && (
        <span className="text-[10px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1">
          {error}
        </span>
      )}
    </div>
  );
}
