/**
 * /auth/callback — where Google drops you off.
 *
 * Almost nothing happens here on purpose. The Supabase client parses the token
 * out of the URL by itself when it boots (`detectSessionInUrl`, on by default),
 * so this page's whole job is to wait for that to land, wipe the credentials
 * out of the address bar, and put the visitor back where they were.
 *
 * The waiting is the part worth being careful about. The session can arrive
 * *before* this component mounts — the client is created at module load and
 * the URL is already there — so checking `getSession` once on mount is not
 * enough, and subscribing to `onAuthStateChange` alone would miss the event
 * that already fired. It does both, and gives up after a few seconds rather
 * than spinning forever on a URL that never had a token in it.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { hasAuthPayload, readCallbackError, takeReturnTo } from "@/lib/oauth";

/** Long enough for a slow token exchange, short enough not to feel hung. */
const GIVE_UP_MS = 8000;

export default function AuthCallback() {
  const navigate = useNavigate();
  const [slow, setSlow] = useState(false);
  /** Guards against the two racing paths both navigating. */
  const done = useRef(false);

  useEffect(() => {
    const finish = (path: string) => {
      if (done.current) return;
      done.current = true;
      /* `replace`, so Back does not walk into a spent callback URL — and the
         tokens leave the history entry with it. */
      navigate(path, { replace: true });
    };

    const oauthError = readCallbackError();
    if (oauthError) {
      toast.error("Google sign-in didn't complete", { description: oauthError });
      finish(takeReturnTo());
      return;
    }

    if (!hasAuthPayload()) {
      // Somebody opened this route directly. Nothing to wait for.
      finish(takeReturnTo());
      return;
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        toast.success("Welcome to the Vibe ✨");
        finish(takeReturnTo());
      }
    });

    // The event may already have fired before this component existed.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        toast.success("Welcome to the Vibe ✨");
        finish(takeReturnTo());
      }
    });

    const slowTimer = window.setTimeout(() => setSlow(true), 2500);
    const giveUp = window.setTimeout(() => {
      if (done.current) return;
      toast.error("That sign-in didn't come back", {
        description: "Give it another go from the log in button.",
      });
      finish(takeReturnTo());
    }, GIVE_UP_MS);

    return () => {
      sub.subscription.unsubscribe();
      window.clearTimeout(slowTimer);
      window.clearTimeout(giveUp);
    };
  }, [navigate]);

  return (
    <div className="fixed inset-0 grid place-items-center bg-[#0b1220] text-white">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-white/80"
          role="status"
          aria-label="Signing you in"
        />
        <p className="text-sm text-white/60">
          {slow ? "Still going — hang on…" : "Signing you in…"}
        </p>
      </div>
    </div>
  );
}
