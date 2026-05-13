/**
 * LocationSharePill — opt-in Snap-Map-style location share.
 *
 * Renders on the village page (/) when the user is signed in. Three
 * states:
 *
 *   not signed in  → small "sign in to drop a pin" link to /vibe
 *   signed in idle → "Share your location" button
 *   sharing        → "📍 Sharing for 6h" pill with a Stop action
 *
 * Click → browser geolocation prompt → upsert a row in
 * `user_locations` for this user. Server-side RLS ensures only the
 * signed-in owner can write their own row. The row auto-expires
 * after 6 hours via expires_at so we never show a stale pin.
 *
 * "Stop sharing" deletes the row. "Refresh" re-geo-locates + extends
 * the expiry by another 6 hours.
 *
 * Privacy notes:
 *   - Sharing is fully opt-in. No row exists until the user clicks.
 *   - The pill is always visible when sharing is active, so users
 *     can't forget they're broadcasting.
 *   - Coordinates are stored as-is (full precision) but only
 *     readable while expires_at > now().
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Loader2, X, Crosshair } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  /** Optional positioning class override. Defaults to bottom-right
      with z-index above the map but below modals. */
  className?: string;
}

interface MyShare {
  lat: number;
  lng: number;
  shared_at: string;
  expires_at: string;
}

export default function LocationSharePill({ className }: Props) {
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [userRowId, setUserRowId] = useState<string | null>(null);
  const [share, setShare] = useState<MyShare | null>(null);
  const [busy, setBusy] = useState<"idle" | "locating" | "saving" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);

  // Track auth + load the user's profile row id (we share by that,
  // not by auth_user_id, so the row joins to community profiles).
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const { data: u } = await supabase.auth.getUser();
      if (cancelled) return;
      const uid = u?.user?.id ?? null;
      setAuthUserId(uid);
      if (!uid) { setUserRowId(null); return; }
      const { data: row } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", uid)
        .maybeSingle();
      if (cancelled) return;
      setUserRowId(row?.id ?? null);
    };
    hydrate();
    const { data: sub } = supabase.auth.onAuthStateChange(() => hydrate());
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  // Load whatever share row this user already has, so the pill
  // reflects "sharing" state across reloads.
  useEffect(() => {
    if (!userRowId) { setShare(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_locations")
        .select("lat, lng, shared_at, expires_at")
        .eq("user_id", userRowId)
        .maybeSingle();
      if (cancelled) return;
      // Filter expired client-side too (RLS does it too — defense in depth).
      if (data && new Date(data.expires_at).getTime() > Date.now()) {
        setShare(data as MyShare);
      } else {
        setShare(null);
      }
    })();
    return () => { cancelled = true; };
  }, [userRowId]);

  const startOrRefresh = useCallback(() => {
    setError(null);
    if (!userRowId) return;
    if (!("geolocation" in navigator)) {
      setError("This browser doesn't support location.");
      return;
    }
    setBusy("locating");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setBusy("saving");
        const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
        const { error: upErr } = await supabase
          .from("user_locations")
          .upsert(
            {
              user_id: userRowId,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy_m: Math.round(pos.coords.accuracy ?? 0),
              shared_at: new Date().toISOString(),
              expires_at: expires,
            },
            { onConflict: "user_id" },
          );
        if (upErr) {
          setError(upErr.message);
          setBusy("idle");
          return;
        }
        setShare({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          shared_at: new Date().toISOString(),
          expires_at: expires,
        });
        setBusy("idle");
      },
      (geoErr) => {
        setError(geoErr.message || "Couldn't read your location.");
        setBusy("idle");
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  }, [userRowId]);

  const stopSharing = useCallback(async () => {
    if (!userRowId) return;
    setBusy("stopping");
    setError(null);
    const { error: delErr } = await supabase
      .from("user_locations")
      .delete()
      .eq("user_id", userRowId);
    if (delErr) {
      setError(delErr.message);
      setBusy("idle");
      return;
    }
    setShare(null);
    setBusy("idle");
  }, [userRowId]);

  const positionClass = className ?? "absolute bottom-24 md:bottom-20 right-4 z-30";

  // Not signed in — small "sign in to drop a pin" prompt.
  if (!authUserId) {
    return (
      <a
        href="/vibe"
        className={`${positionClass} glass-panel rounded-full pl-2 pr-3 py-1.5 flex items-center gap-1.5 hover:bg-muted/40 transition-colors text-[11px] font-heading font-semibold text-foreground/85`}
        title="Sign in to share your location with the village"
      >
        <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
        <span>Sign in to drop a pin</span>
      </a>
    );
  }

  // Sharing — show the active state.
  if (share) {
    const minsLeft = Math.max(
      0,
      Math.round((new Date(share.expires_at).getTime() - Date.now()) / 60000),
    );
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
            On the map
          </span>
          <span className="text-[10px] text-emerald-200/70">
            {minsLeft > 60 ? `${Math.round(minsLeft / 60)}h left` : `${minsLeft}m left`}
          </span>
          <button
            onClick={startOrRefresh}
            disabled={busy !== "idle"}
            className="p-1 rounded-full hover:bg-emerald-400/20 transition-colors"
            title="Refresh my location + extend by 6h"
          >
            {busy === "locating" || busy === "saving" ? (
              <Loader2 className="w-3 h-3 text-emerald-200 animate-spin" />
            ) : (
              <Crosshair className="w-3 h-3 text-emerald-200" />
            )}
          </button>
          <button
            onClick={stopSharing}
            disabled={busy !== "idle"}
            className="p-1 rounded-full hover:bg-rose-400/30 transition-colors mr-0.5"
            title="Stop sharing"
          >
            {busy === "stopping" ? (
              <Loader2 className="w-3 h-3 text-rose-200 animate-spin" />
            ) : (
              <X className="w-3 h-3 text-rose-200" />
            )}
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  // Signed in but not yet sharing.
  return (
    <div className={`${positionClass} flex flex-col items-end gap-1`}>
      <button
        onClick={startOrRefresh}
        disabled={busy !== "idle"}
        className="glass-panel rounded-full pl-2 pr-3 py-1.5 flex items-center gap-1.5 hover:bg-primary/15 transition-colors text-[11px] font-heading font-semibold disabled:opacity-50 border border-primary/30"
        title="Share your location with the village (6 hours, opt-in)"
      >
        {busy === "locating" ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> Locating…</>
        ) : busy === "saving" ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> Saving…</>
        ) : (
          <><MapPin className="w-3.5 h-3.5 text-primary" /> Drop a pin</>
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
