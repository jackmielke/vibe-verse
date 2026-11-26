/**
 * The way into Build mode: a small pill at the top of a world that build mode
 * covers, shown only to admins. The panel itself is lazy, so everybody else
 * pays for one RPC (and only when signed in) and not one byte of UI.
 *
 * The admin check here is a courtesy. The lock is in `vibe-build`, which asks
 * `has_role` again before it does anything.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { supabase } from "@/integrations/supabase/client";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";

import { scopeForPath } from "./api";

const BuildModePanel = lazy(() => import("./BuildModePanel"));

export default function BuildModeLauncher() {
  const { pathname } = useLocation();
  const { user } = useVibeIdentity();
  const scope = scopeForPath(pathname);
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user || !scope) return;
    let cancelled = false;
    supabase
      .rpc("has_role", { _user_id: user.id, _role: "admin" })
      .then(({ data }) => {
        if (!cancelled) setAdmin(!!data);
      });
    return () => {
      cancelled = true;
    };
  }, [user, scope]);

  // B with a modifier toggles it, so it can be opened mid-flight.
  useEffect(() => {
    if ((!admin && !(import.meta.env.DEV && window.location.search.includes("buildmode"))) || !scope) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (document.pointerLockElement) document.exitPointerLock();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [admin, scope]);

  // Dev only: `?buildmode` shows the panel without an admin session, so a
  // headless browser can look at its layout. Stripped from production builds.
  const devForce = import.meta.env.DEV && new URLSearchParams(window.location.search).has("buildmode");
  if (!scope || ((!user || !admin) && !devForce)) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            if (document.pointerLockElement) document.exitPointerLock();
            setOpen(true);
          }}
          title="Build mode (Ctrl/Cmd+Shift+B)"
          className="fixed left-1/2 top-2 z-[9998] -translate-x-1/2 rounded-full border border-white/20 bg-black/55 px-3 py-1 text-xs font-medium text-white/85 backdrop-blur hover:bg-black/75"
        >
          ✦ Build
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <BuildModePanel scope={scope} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
