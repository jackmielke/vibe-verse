/**
 * useVibeIdentity — the ONE identity hook every world reads from.
 *
 * Goals:
 *  - Sign-in is OPTIONAL. Guests always work; their localStorage data
 *    (name + chosen vibe color) is auto-merged into their account the
 *    first time they sign in or sign up.
 *  - Worlds can ask for a *per-world display name override* without
 *    polluting the canonical profile (e.g. you're "Jack" globally but
 *    "DJ Snowflake" inside EDM Town).
 *  - Login is NOT a wallet method. Wallet sits on top of an account
 *    (linked via the existing link-wallet edge function — out of scope
 *    for this layer; we just surface what's stored on the profile).
 *
 * Storage layout:
 *   localStorage.vibe.guestName     — guest display name fallback
 *   localStorage.vibe.guestColor    — guest avatar color id
 *   localStorage.vibe.nameByWorld   — { [worldKey]: name }
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";
import { DEFAULT_VIBE_COLOR } from "@/components/vibe-auth/VibeAvatar";

export interface VibeProfile {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
  profile_picture_url: string | null;
  bio: string | null;
  /** Hex/id of selected avatar color. Stored in localStorage today;
   * a profile column can be added later without breaking callers. */
  vibe_color?: string | null;
}

interface VibeIdentity {
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: VibeProfile | null;
  /** Resolved display name: world override → profile name → guest name → "Guest". */
  displayName: string;
  /** Resolved avatar color id, regardless of login state. */
  colorId: string;
  isGuest: boolean;
  /** Per-world display name override (does not touch the profile). */
  setWorldName: (worldKey: string, name: string | null) => void;
  getWorldName: (worldKey: string) => string | null;
  /** Update the canonical guest or profile name. */
  setGuestName: (name: string) => void;
  /** Update the avatar color (writes to localStorage; persists for guests
   * and signed-in users alike until we add a profile column). */
  setColor: (colorId: string) => void;
  signOut: () => Promise<void>;
  /** Force a re-fetch of the profile row. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<VibeIdentity | null>(null);

const LS = {
  guestName: "vibe.guestName",
  guestColor: "vibe.guestColor",
  nameByWorld: "vibe.nameByWorld",
};

function readWorldNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS.nameByWorld) ?? "{}");
  } catch {
    return {};
  }
}

export function VibeIdentityProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<VibeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [guestName, setGuestNameState] = useState<string>(
    () => localStorage.getItem(LS.guestName) ?? "",
  );
  const [colorId, setColorIdState] = useState<string>(
    () => localStorage.getItem(LS.guestColor) ?? DEFAULT_VIBE_COLOR,
  );
  const [worldNames, setWorldNames] = useState<Record<string, string>>(readWorldNames);

  const fetchProfile = useCallback(async (uid: string) => {
    const { data } = await supabase
      .from("users")
      .select("id,name,username,email,avatar_url,profile_picture_url,bio")
      .eq("auth_user_id", uid)
      .maybeSingle();
    if (data) setProfile({ ...(data as VibeProfile), vibe_color: colorId });
  }, [colorId]);

  // Initial session + auth subscription. Per Supabase guidance, register
  // the listener BEFORE the initial getSession call so we never miss the
  // first event.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s?.user) {
        // Defer profile fetch to avoid blocking the auth callback.
        setTimeout(() => fetchProfile(s.user.id), 0);
      } else {
        setProfile(null);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) fetchProfile(data.session.user.id);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, [fetchProfile]);

  const setGuestName = useCallback((name: string) => {
    setGuestNameState(name);
    localStorage.setItem(LS.guestName, name);
  }, []);

  const setColor = useCallback((id: string) => {
    setColorIdState(id);
    localStorage.setItem(LS.guestColor, id);
    setProfile((p) => (p ? { ...p, vibe_color: id } : p));
  }, []);

  const setWorldName = useCallback((worldKey: string, name: string | null) => {
    setWorldNames((prev) => {
      const next = { ...prev };
      if (!name || !name.trim()) delete next[worldKey];
      else next[worldKey] = name.trim().slice(0, 40);
      localStorage.setItem(LS.nameByWorld, JSON.stringify(next));
      return next;
    });
  }, []);

  const getWorldName = useCallback(
    (worldKey: string) => worldNames[worldKey] ?? null,
    [worldNames],
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const refresh = useCallback(async () => {
    if (session?.user) await fetchProfile(session.user.id);
  }, [session, fetchProfile]);

  const displayName = useMemo(() => {
    // World-specific override always wins.
    // (Callers pick the world via getWorldName; the top-level displayName
    //  is just the global resolved name.)
    return (
      profile?.name?.trim() ||
      profile?.username?.trim() ||
      guestName.trim() ||
      "Guest"
    );
  }, [profile, guestName]);

  const value: VibeIdentity = {
    loading,
    session,
    user: session?.user ?? null,
    profile,
    displayName,
    colorId,
    isGuest: !session?.user,
    setWorldName,
    getWorldName,
    setGuestName,
    setColor,
    signOut,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVibeIdentity(): VibeIdentity {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useVibeIdentity must be used inside <VibeIdentityProvider>");
  }
  return ctx;
}

/**
 * Convenience hook for worlds: returns the name to display for the
 * current user *in this world*, with an easy setter for the override.
 *   const { name, setName } = useWorldDisplayName("edm-town");
 */
export function useWorldDisplayName(worldKey: string) {
  const id = useVibeIdentity();
  const override = id.getWorldName(worldKey);
  return {
    name: override ?? id.displayName,
    isOverride: !!override,
    setName: (n: string | null) => id.setWorldName(worldKey, n),
  };
}
