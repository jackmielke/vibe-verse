/**
 * VibeAccountCard — the safe v1 of community login.
 *
 * Three steps in order, none of them touch your wallet:
 *
 *   1. Sign in with email (Supabase magic-link). One link in your
 *      inbox, click, you're in.
 *   2. We look up your `users` row by auth_user_id. If you don't
 *      have one yet (first time signing in), we create a minimal
 *      row using your email.
 *   3. Optionally paste your Base wallet address into a plain text
 *      field. Stored on your `users.wallet_address`. No browser
 *      wallet popups, no transactions, no signatures, no risk.
 *
 * Explicit safety promise: we NEVER move funds. The text input is
 * cosmetic — it advertises your public address to the community so
 * people can find you, and so the leaderboard can show your $VIBE
 * balance by reading the blockchain directly. That's it.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mail,
  Lock,
  LogOut,
  Loader2,
  ExternalLink,
  ShieldCheck,
  Pencil,
  Save,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getVibeBalance,
  formatVibe,
  shortAddress,
  isAddress,
} from "@/lib/vibe-wallet";

interface UserRow {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  name: string | null;
  username: string | null;
  bio: string | null;
  headline: string | null;
  avatar_url: string | null;
  profile_picture_url: string | null;
  telegram_username: string | null;
  telegram_photo_url: string | null;
  wallet_address: string | null;
  wallet_connected_at: string | null;
}

interface Props {
  /** "card" is the bigger /vibe + Lobby look. "pill" is for nav corners. */
  variant?: "card" | "pill";
}

export default function VibeAccountCard({ variant = "card" }: Props) {
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup" | "magic">("signin");
  const [emailDraft, setEmailDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authStatus, setAuthStatus] = useState<"idle" | "working" | "magic-sent" | "error" | "needs-confirmation">("idle");
  const [authError, setAuthError] = useState<string | null>(null);
  const [editingWallet, setEditingWallet] = useState(false);
  const [walletDraft, setWalletDraft] = useState("");
  const [walletSaving, setWalletSaving] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);

  // Subscribe to auth state — so login + logout updates the UI live.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAuthUserId(data.user?.id ?? null);
      setAuthEmail(data.user?.email ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUserId(session?.user?.id ?? null);
      setAuthEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load (or create) the users row for the signed-in account.
  useEffect(() => {
    if (!authUserId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    (async () => {
      // Lookup by auth_user_id. If none, create a minimal row.
      const { data, error } = await supabase
        .from("users")
        .select(
          "id, auth_user_id, email, name, username, bio, headline, avatar_url, profile_picture_url, telegram_username, telegram_photo_url, wallet_address, wallet_connected_at",
        )
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // RLS might block reads — surface friendly state.
        console.warn("[VibeAccountCard] profile load:", error.message);
      }
      if (data) {
        setProfile(data as UserRow);
        setWalletDraft(data.wallet_address ?? "");
      } else {
        // No row yet — create one. universal_id is required + unique;
        // re-use the auth_user_id so it stays stable.
        const { data: created, error: createErr } = await supabase
          .from("users")
          .insert({
            auth_user_id: authUserId,
            universal_id: authUserId,
            email: authEmail,
            is_claimed: true,
          })
          .select(
            "id, auth_user_id, email, name, username, bio, headline, avatar_url, profile_picture_url, telegram_username, telegram_photo_url, wallet_address, wallet_connected_at",
          )
          .single();
        if (cancelled) return;
        if (createErr) {
          console.warn("[VibeAccountCard] profile create:", createErr.message);
        }
        if (created) {
          setProfile(created as UserRow);
          setWalletDraft("");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [authUserId, authEmail]);

  // When a wallet is set, fetch its on-chain $VIBE balance for display.
  useEffect(() => {
    const wallet = profile?.wallet_address;
    if (!wallet || !isAddress(wallet)) {
      setBalanceWei(null);
      return;
    }
    let cancelled = false;
    getVibeBalance(wallet as `0x${string}`)
      .then((b) => { if (!cancelled) setBalanceWei(b.raw); })
      .catch(() => { if (!cancelled) setBalanceWei(0n); });
    return () => { cancelled = true; };
  }, [profile?.wallet_address]);

  // ---- Actions ---------------------------------------------------------
  const handleAuth = async () => {
    setAuthError(null);
    setAuthStatus("working");
    const email = emailDraft.trim();
    const password = passwordDraft;
    if (authMode === "magic") {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href },
      });
      if (error) {
        setAuthError(error.message);
        setAuthStatus("error");
        return;
      }
      setAuthStatus("magic-sent");
      return;
    }
    if (authMode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setAuthError(error.message);
        setAuthStatus("error");
        return;
      }
      setAuthStatus("idle");
      setPasswordDraft("");
      return;
    }
    // signup
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.href },
    });
    if (error) {
      setAuthError(error.message);
      setAuthStatus("error");
      return;
    }
    // If email confirmation is required, Supabase returns a user
    // with no session. Tell the user to check their inbox.
    if (data.user && !data.session) {
      setAuthStatus("needs-confirmation");
      return;
    }
    setAuthStatus("idle");
    setPasswordDraft("");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const saveWallet = async () => {
    if (!profile) return;
    const trimmed = walletDraft.trim();
    setWalletError(null);
    if (trimmed && !isAddress(trimmed)) {
      setWalletError("That doesn't look like a valid 0x… address.");
      return;
    }
    setWalletSaving(true);
    const patch = {
      wallet_address: trimmed ? trimmed.toLowerCase() : null,
      wallet_connected_at: trimmed ? new Date().toISOString() : null,
      wallet_provider: trimmed ? "manual" : null,
    };
    const { data, error } = await supabase
      .from("users")
      .update(patch)
      .eq("id", profile.id)
      .select(
        "id, auth_user_id, email, name, username, bio, headline, avatar_url, profile_picture_url, telegram_username, telegram_photo_url, wallet_address, wallet_connected_at",
      )
      .single();
    setWalletSaving(false);
    if (error) {
      setWalletError(error.message);
      return;
    }
    if (data) setProfile(data as UserRow);
    setEditingWallet(false);
  };

  // ---- Render ----------------------------------------------------------
  if (variant === "pill") {
    return <PillView profile={profile} loading={loading} authUserId={authUserId} onSignOut={signOut} />;
  }

  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
            Your VIBE Account
          </p>
        </div>
        {authUserId && (
          <button
            onClick={signOut}
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            title="Sign out"
          >
            <LogOut className="w-3 h-3" />
            sign out
          </button>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <p className="text-xs text-muted-foreground italic">Checking your session…</p>
      )}

      {/* Step 1: Not signed in → email + password (default) or magic link */}
      {!loading && !authUserId && (
        <>
          {/* Sign-in / Sign-up tab toggle */}
          <div className="flex gap-1 p-0.5 rounded-lg bg-background/40 border border-border/40 text-[10px]">
            <button
              onClick={() => { setAuthMode("signin"); setAuthError(null); setAuthStatus("idle"); }}
              className={`flex-1 px-2 py-1 rounded-md transition-colors ${
                authMode === "signin"
                  ? "bg-primary/25 text-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              Sign in
            </button>
            <button
              onClick={() => { setAuthMode("signup"); setAuthError(null); setAuthStatus("idle"); }}
              className={`flex-1 px-2 py-1 rounded-md transition-colors ${
                authMode === "signup"
                  ? "bg-primary/25 text-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              Create account
            </button>
            <button
              onClick={() => { setAuthMode("magic"); setAuthError(null); setAuthStatus("idle"); }}
              className={`flex-1 px-2 py-1 rounded-md transition-colors ${
                authMode === "magic"
                  ? "bg-primary/25 text-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              Magic link
            </button>
          </div>

          <p className="text-xs text-muted-foreground leading-snug">
            {authMode === "signin" && "Welcome back. Sign in with your email and password."}
            {authMode === "signup" && "Pick an email and a password to claim your Edge profile."}
            {authMode === "magic" && "Get a one-click sign-in link delivered to your inbox — no password needed."}
          </p>

          {/* Email */}
          <div className="flex items-center gap-1.5 rounded-lg bg-background/60 border border-border/60 focus-within:border-primary/60 px-2 py-1.5">
            <Mail className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="email"
              autoComplete="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="you@example.com"
              disabled={authStatus === "working" || authStatus === "magic-sent"}
              className="bg-transparent outline-none flex-1 text-sm disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === "Enter" && emailDraft && (authMode === "magic" || passwordDraft)) {
                  handleAuth();
                }
              }}
            />
          </div>

          {/* Password (hidden on magic-link mode) */}
          {authMode !== "magic" && (
            <div className="flex items-center gap-1.5 rounded-lg bg-background/60 border border-border/60 focus-within:border-primary/60 px-2 py-1.5">
              <Lock className="w-3.5 h-3.5 text-muted-foreground" />
              <input
                type={showPassword ? "text" : "password"}
                autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                value={passwordDraft}
                onChange={(e) => setPasswordDraft(e.target.value)}
                placeholder={authMode === "signin" ? "your password" : "pick a password (8+ chars)"}
                disabled={authStatus === "working"}
                className="bg-transparent outline-none flex-1 text-sm disabled:opacity-60"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && emailDraft && passwordDraft) handleAuth();
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="p-1 rounded-md hover:bg-muted/40 transition-colors"
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                ) : (
                  <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                )}
              </button>
            </div>
          )}

          <button
            onClick={handleAuth}
            disabled={
              !emailDraft ||
              (authMode !== "magic" && !passwordDraft) ||
              authStatus === "working" ||
              authStatus === "magic-sent"
            }
            className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-heading font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {authStatus === "working" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Working…</>
            ) : authStatus === "magic-sent" ? (
              "Magic link sent ✓"
            ) : authMode === "signin" ? (
              "Sign in"
            ) : authMode === "signup" ? (
              "Create account"
            ) : (
              "Send link"
            )}
          </button>

          {authStatus === "magic-sent" && (
            <p className="text-[11px] text-emerald-300 bg-emerald-400/10 border border-emerald-400/30 rounded px-2 py-1.5">
              Check your inbox. Click the link to finish signing in.
            </p>
          )}
          {authStatus === "needs-confirmation" && (
            <p className="text-[11px] text-emerald-300 bg-emerald-400/10 border border-emerald-400/30 rounded px-2 py-1.5">
              Account created — check your inbox to confirm your email before signing in.
            </p>
          )}
          {authError && (
            <p className="text-[11px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
              {authError}
            </p>
          )}
        </>
      )}

      {/* Step 2 + 3: Signed in → profile + wallet address */}
      {!loading && authUserId && profile && (
        <>
          {/* Profile row */}
          <div className="flex items-center gap-3">
            <Avatar profile={profile} />
            <div className="flex-1 min-w-0">
              <p className="font-heading text-base font-semibold text-foreground truncate">
                {profile.name ?? profile.username ?? profile.email ?? "You"}
              </p>
              {profile.headline && (
                <p className="text-[11px] text-muted-foreground truncate">
                  {profile.headline}
                </p>
              )}
              {profile.telegram_username && (
                <p className="text-[10px] text-muted-foreground truncate">
                  @{profile.telegram_username}
                </p>
              )}
            </div>
          </div>

          {profile.bio && (
            <p className="text-xs text-foreground/80 leading-relaxed line-clamp-3">
              {profile.bio}
            </p>
          )}

          {/* Wallet address — text input, no connection */}
          <div className="rounded-lg bg-background/30 border border-border/60 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Base Wallet Address
              </p>
              {!editingWallet && (
                <button
                  onClick={() => {
                    setWalletDraft(profile.wallet_address ?? "");
                    setEditingWallet(true);
                    setWalletError(null);
                  }}
                  className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Pencil className="w-3 h-3" />
                  {profile.wallet_address ? "Edit" : "Add"}
                </button>
              )}
            </div>

            {!editingWallet && (
              profile.wallet_address ? (
                <div className="flex items-center gap-2">
                  <a
                    href={`https://basescan.org/address/${profile.wallet_address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-mono text-foreground/90 hover:text-primary inline-flex items-center gap-1 truncate"
                  >
                    {shortAddress(profile.wallet_address)}
                    <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                  </a>
                  {balanceWei != null && (
                    <span className="ml-auto text-xs font-heading font-semibold text-primary tabular-nums">
                      {formatVibe(balanceWei, { compact: true })} VIBE
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">
                  No wallet address yet. Add one so the community can find you and see your $VIBE balance.
                </p>
              )
            )}

            {editingWallet && (
              <>
                <input
                  type="text"
                  value={walletDraft}
                  onChange={(e) => setWalletDraft(e.target.value)}
                  placeholder="0x…"
                  disabled={walletSaving}
                  className="w-full rounded-md bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-2 py-1.5 text-sm font-mono disabled:opacity-60"
                  spellCheck={false}
                />
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Your public Base address — the same one you'd put on a name tag.
                  We never ask you to connect a wallet here and we cannot move funds.
                  Leave blank to remove.
                </p>
                {walletError && (
                  <p className="text-[10px] text-rose-300">{walletError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={saveWallet}
                    disabled={walletSaving}
                    className="flex-1 bg-primary text-primary-foreground rounded-md px-2 py-1.5 text-xs font-heading font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                  >
                    {walletSaving ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Saving</>
                    ) : (
                      <><Save className="w-3 h-3" /> Save</>
                    )}
                  </button>
                  <button
                    onClick={() => { setEditingWallet(false); setWalletError(null); }}
                    disabled={walletSaving}
                    className="rounded-md border border-border/60 bg-background/40 hover:bg-muted/40 px-2 py-1.5 text-xs font-heading font-semibold text-muted-foreground inline-flex items-center gap-1.5"
                  >
                    <X className="w-3 h-3" />
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Safety promise — small print but unmissable */}
          <p className="text-[10px] text-muted-foreground/80 leading-relaxed flex items-start gap-1.5">
            <ShieldCheck className="w-3 h-3 mt-0.5 flex-shrink-0 text-emerald-400" />
            <span>
              We never touch your funds. This app only stores your address as text — like a username.
              No signatures, no transactions, no browser-wallet popups.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Pill variant for nav bars
// ----------------------------------------------------------------------

function PillView({
  profile,
  loading,
  authUserId,
  onSignOut,
}: {
  profile: UserRow | null;
  loading: boolean;
  authUserId: string | null;
  onSignOut: () => void;
}) {
  if (loading) return null;
  if (!authUserId) {
    return (
      <a
        href="/vibe"
        className="glass-panel rounded-full px-3 py-1.5 text-[11px] font-heading font-semibold hover:bg-primary/15 transition-colors"
      >
        Sign in
      </a>
    );
  }
  return (
    <div className="glass-panel rounded-full pl-1 pr-2 py-1 flex items-center gap-2 border border-primary/30">
      <Avatar profile={profile} size="sm" />
      <span className="text-[11px] font-heading font-semibold text-foreground/90 max-w-[140px] truncate">
        {profile?.name ?? profile?.username ?? profile?.email ?? "Account"}
      </span>
      <button
        onClick={onSignOut}
        className="p-1 rounded-md hover:bg-muted/40 transition-colors"
        title="Sign out"
      >
        <LogOut className="w-3 h-3 text-muted-foreground" />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------
// Avatar — picks the best photo source available on the users row.
// ----------------------------------------------------------------------

function Avatar({ profile, size = "lg" }: { profile: UserRow | null; size?: "sm" | "lg" }) {
  const px = size === "sm" ? 24 : 48;
  const src =
    profile?.profile_picture_url ??
    profile?.avatar_url ??
    profile?.telegram_photo_url ??
    null;
  const initial =
    (profile?.name ?? profile?.username ?? profile?.email ?? "?").trim().charAt(0).toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={px}
        height={px}
        className="rounded-full object-cover border border-border/60"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div
      style={{ width: px, height: px, fontSize: px / 2.4 }}
      className="rounded-full bg-primary/25 text-primary flex items-center justify-center font-heading font-bold"
    >
      {initial}
    </div>
  );
}
