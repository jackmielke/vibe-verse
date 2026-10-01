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
  Github,
  Wallet,
  Plus,
  Check,
  Unlink,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { IOS_APP } from "@/lib/iosApp";
import {
  linkProviderIdentity,
  signInWithProvider,
  type OAuthProvider,
} from "@/lib/oauth";
import {
  getVibeBalance,
  formatVibe,
  shortAddress,
  isAddress,
  connectWallet,
  signLinkMessage,
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
  // signin | signup — toggled by a single small inline link, not a
  // three-tab strip. Default to signin since most repeat visitors are.
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
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
  // Linked auth identities (Google, GitHub, email, etc) — pulled from
  // Supabase whenever the session changes.
  const [identities, setIdentities] = useState<Array<{ id: string; provider: string }>>([]);
  // Track the in-flight "linking with provider X" state so the button
  // can show a spinner without locking the whole card.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // Wallet-link state when using the real MetaMask flow (separate
  // from the paste-in text input below).
  const [walletConnectStep, setWalletConnectStep] = useState<
    "idle" | "connecting" | "signing" | "saving" | "done" | "error"
  >("idle");
  const [walletConnectError, setWalletConnectError] = useState<string | null>(null);

  // Subscribe to auth state — so login + logout updates the UI live.
  useEffect(() => {
    const hydrateIdentities = async () => {
      try {
        const { data } = await supabase.auth.getUserIdentities();
        const list = (data?.identities ?? []).map((i) => ({
          id: i.identity_id ?? i.id,
          provider: i.provider,
        }));
        setIdentities(list);
      } catch {
        setIdentities([]);
      }
    };
    supabase.auth.getUser().then(({ data }) => {
      setAuthUserId(data.user?.id ?? null);
      setAuthEmail(data.user?.email ?? null);
      setLoading(false);
      if (data.user) hydrateIdentities();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUserId(session?.user?.id ?? null);
      setAuthEmail(session?.user?.email ?? null);
      if (session?.user) hydrateIdentities();
      else setIdentities([]);
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
  // Send a magic link to whatever's in the email field. Used as a
  // tertiary "no password" option from a small inline link, NOT a
  // tab — keeps the primary surface a clean two-field form.
  const sendMagicLink = async () => {
    setAuthError(null);
    setAuthStatus("working");
    const email = emailDraft.trim();
    if (!email) {
      setAuthError("Enter your email first.");
      setAuthStatus("error");
      return;
    }
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
  };

  const handleAuth = async () => {
    setAuthError(null);
    setAuthStatus("working");
    const email = emailDraft.trim();
    const password = passwordDraft;
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

  /**
   * Provider buttons (Google / GitHub) do two different things based
   * on whether someone is signed in:
   *  - Signed in → `linkIdentity` adds the OAuth identity to the
   *    existing account so the user has multiple ways back in.
   *  - Signed out → `signInWithOAuth` redirects them through the
   *    provider's login and creates / finds the matching account.
   *
   * Both go through `lib/oauth.ts` rather than calling Supabase here, and the
   * reason is the redirect. This used to pass `window.location.href`, which
   * means every page carrying this card — and every query string on it — has
   * to be in the project's redirect allow list. An unlisted redirect does not
   * error; it silently falls back to the Site URL, so somebody linking Google
   * from a preview deploy lands on production, signed out, with nothing to
   * read. One shared `/auth/callback` and a stashed return path fixes that
   * everywhere at once.
   *
   * Both still rely on the provider being enabled in the Supabase project
   * (Auth → Providers); `describeOAuthError` says so in as many words rather
   * than surfacing "Unsupported provider".
   */
  const linkOrSignInWithProvider = async (provider: OAuthProvider) => {
    setOauthError(null);
    setPendingProvider(provider);
    try {
      if (authUserId) await linkProviderIdentity(provider);
      else await signInWithProvider(provider);
    } catch (e) {
      setOauthError(
        (e as Error).message ?? `Couldn't ${authUserId ? "link" : "sign in with"} ${provider}`,
      );
    } finally {
      setPendingProvider(null);
    }
  };

  const unlinkProvider = async (identityId: string, provider: string) => {
    setOauthError(null);
    setPendingProvider(provider);
    try {
      const { data } = await supabase.auth.getUserIdentities();
      const target = (data?.identities ?? []).find(
        (i) => (i.identity_id ?? i.id) === identityId,
      );
      if (!target) throw new Error("identity not found");
      const { error } = await supabase.auth.unlinkIdentity(target);
      if (error) throw error;
      // Refresh the list.
      const fresh = await supabase.auth.getUserIdentities();
      setIdentities(
        (fresh.data?.identities ?? []).map((i) => ({
          id: i.identity_id ?? i.id,
          provider: i.provider,
        })),
      );
    } catch (e) {
      setOauthError((e as Error).message ?? `Couldn't unlink ${provider}`);
    } finally {
      setPendingProvider(null);
    }
  };

  /**
   * MetaMask path: open the wallet, ask the user to sign a
   * proof-of-ownership message (NO transaction, NO funds move), then
   * write the address onto the user's row. We do the DB update
   * client-side and rely on RLS to gate it — the user can only update
   * their own row, and we explicitly scope by auth_user_id.
   */
  const connectAndLinkWallet = async () => {
    if (!profile) return;
    setWalletConnectError(null);
    setWalletConnectStep("connecting");
    try {
      const address = await connectWallet();
      setWalletConnectStep("signing");
      const session = await signLinkMessage(address, "Edge Esmeralda");
      setWalletConnectStep("saving");
      const { data, error } = await supabase
        .from("users")
        .update({
          wallet_address: session.address.toLowerCase(),
          wallet_connected_at: new Date().toISOString(),
          wallet_provider: "eip1193",
        })
        .eq("id", profile.id)
        .select(
          "id, auth_user_id, email, name, username, bio, headline, avatar_url, profile_picture_url, telegram_username, telegram_photo_url, wallet_address, wallet_connected_at",
        )
        .single();
      if (error) throw error;
      if (data) setProfile(data as UserRow);
      setWalletConnectStep("done");
      window.setTimeout(() => setWalletConnectStep("idle"), 1500);
    } catch (e) {
      setWalletConnectError((e as Error).message ?? "Wallet link failed");
      setWalletConnectStep("error");
    }
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

      {/* Step 1: Not signed in → single clean email + password form.
          Mode (signin / signup) is toggled by an inline link below
          the button, not a three-tab strip. Magic link is a tertiary
          option, also inline. */}
      {!loading && !authUserId && (
        <>
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
                if (e.key === "Enter" && emailDraft && passwordDraft) handleAuth();
              }}
            />
          </div>

          {/* Password */}
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

          <button
            onClick={handleAuth}
            disabled={
              !emailDraft ||
              !passwordDraft ||
              authStatus === "working"
            }
            className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-heading font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {authStatus === "working" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Working…</>
            ) : authMode === "signin" ? (
              "Sign in"
            ) : (
              "Send link"
            )}
          </button>

          {/* Mode toggle + magic-link option, both inline + small so
              the form feels like one decision, not three. */}
          <div className="flex items-center justify-between text-[11px] gap-3 flex-wrap">
            {authMode === "signin" ? (
              <button
                onClick={() => { setAuthMode("signup"); setAuthError(null); setAuthStatus("idle"); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                New here? <span className="text-primary underline-offset-2 hover:underline">Create an account</span>
              </button>
            ) : (
              <button
                onClick={() => { setAuthMode("signin"); setAuthError(null); setAuthStatus("idle"); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Have an account? <span className="text-primary underline-offset-2 hover:underline">Sign in</span>
              </button>
            )}
            <button
              onClick={sendMagicLink}
              disabled={!emailDraft || authStatus === "working" || authStatus === "magic-sent"}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 underline-offset-2 hover:underline"
              title="We'll email you a one-click sign-in link"
            >
              email me a magic link
            </button>
          </div>

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

          {/* OAuth alternatives — no password to remember. Falls
              through to the same Supabase session as email/password. */}
          <div className="relative my-1">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-border/40" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-2 text-[10px] uppercase tracking-widest bg-background text-muted-foreground">
                or sign in with
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <OAuthButton
              provider="google"
              label="Google"
              busy={pendingProvider === "google"}
              onClick={() => linkOrSignInWithProvider("google")}
            />
            <OAuthButton
              provider="github"
              label="GitHub"
              busy={pendingProvider === "github"}
              onClick={() => linkOrSignInWithProvider("github")}
            />
          </div>
          {oauthError && (
            <p className="text-[11px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
              {oauthError}
            </p>
          )}
        </>
      )}

      {/* Step 2 + 3: Signed in → profile + connected accounts */}
      {!loading && authUserId && profile && (
        <>
          {/* Profile hero */}
          <div className="flex items-center gap-3 pb-3 border-b border-border/40">
            <Avatar profile={profile} />
            <div className="flex-1 min-w-0">
              <p className="font-heading text-base font-semibold text-foreground truncate">
                {profile.name ?? profile.username ?? profile.email ?? "You"}
              </p>
              {profile.email && (
                <p className="text-[11px] text-muted-foreground truncate">
                  {profile.email}
                </p>
              )}
              {profile.headline && (
                <p className="text-[11px] text-muted-foreground/80 truncate mt-0.5">
                  {profile.headline}
                </p>
              )}
            </div>
          </div>

          {profile.bio && (
            <p className="text-xs text-foreground/80 leading-relaxed line-clamp-3">
              {profile.bio}
            </p>
          )}

          {/* Connected accounts — every way Vibey knows you. */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-heading font-semibold">
              Connected accounts
            </p>

            {/* Email row (always present when signed in) */}
            <ProviderRow
              icon={<Mail className="w-3.5 h-3.5" />}
              label="Email"
              value={authEmail ?? profile.email ?? ""}
              linked
            />

            {/* OAuth providers — Google + GitHub */}
            {(["google", "github"] as const).map((p) => {
              const linked = identities.find((i) => i.provider === p);
              const isBusy = pendingProvider === p;
              return (
                <ProviderRow
                  key={p}
                  icon={
                    p === "google" ? (
                      <GoogleIcon className="w-3.5 h-3.5" />
                    ) : (
                      <Github className="w-3.5 h-3.5" />
                    )
                  }
                  label={p === "google" ? "Google" : "GitHub"}
                  value={linked ? "linked" : "not linked"}
                  linked={!!linked}
                  action={
                    linked ? (
                      <button
                        onClick={() => unlinkProvider(linked.id, p)}
                        disabled={isBusy}
                        className="text-[10px] text-muted-foreground hover:text-rose-300 inline-flex items-center gap-1 disabled:opacity-50"
                        title="Unlink this identity"
                      >
                        {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3" />}
                        unlink
                      </button>
                    ) : (
                      <button
                        onClick={() => linkOrSignInWithProvider(p)}
                        disabled={isBusy}
                        className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        link
                      </button>
                    )
                  }
                />
              );
            })}

            {/* Telegram — read-only badge for now (set by the Vibey
                bot when someone first DMs it). Visible if the row
                has a telegram_username; otherwise hidden so the
                section doesn't feel empty. */}
            {profile.telegram_username && (
              <ProviderRow
                icon={<TelegramIcon className="w-3.5 h-3.5" />}
                label="Telegram"
                value={`@${profile.telegram_username}`}
                linked
              />
            )}

            {/* No wallet in the App Store edition (3.1.5 / 5.3). */}
            {!IOS_APP && (
            /* Wallet — paste-in is the primary flow. MetaMask
                Connect is tucked into a disclosure for users who
                want the cryptographic proof, but defaults are the
                safer / simpler text input. */
            <div className="rounded-md border border-border/60 bg-background/30 p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-foreground/85"><Wallet className="w-3.5 h-3.5" /></span>
                <span className="text-xs font-heading font-semibold flex-1">Base Wallet</span>
                {profile.wallet_address ? (
                  <span className="text-[10px] inline-flex items-center gap-1 text-emerald-300">
                    <Check className="w-3 h-3" /> linked
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">not linked</span>
                )}
              </div>

              {/* Linked state — show address + balance + edit link. */}
              {profile.wallet_address && !editingWallet && (
                <div className="flex items-center gap-2 flex-wrap">
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
                    <span className="text-xs font-heading font-semibold text-primary tabular-nums">
                      {formatVibe(balanceWei, { compact: true })} VIBE
                    </span>
                  )}
                  <button
                    onClick={() => {
                      setWalletDraft(profile.wallet_address ?? "");
                      setEditingWallet(true);
                      setWalletError(null);
                    }}
                    className="ml-auto text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <Pencil className="w-3 h-3" /> edit
                  </button>
                </div>
              )}

              {/* Unlinked OR editing — paste-in field is primary. */}
              {(!profile.wallet_address || editingWallet) && (
                <div className="flex flex-col gap-1.5">
                  <input
                    type="text"
                    value={walletDraft}
                    onChange={(e) => setWalletDraft(e.target.value)}
                    placeholder="paste your public 0x… address"
                    disabled={walletSaving}
                    autoFocus={editingWallet}
                    className="w-full rounded-md bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-2 py-1.5 text-sm font-mono disabled:opacity-60"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && walletDraft.trim()) saveWallet();
                    }}
                  />
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    Just paste your <strong>public</strong> Base address — like a name
                    tag. We read your $VIBE balance from the blockchain. No
                    transactions, no popups, no funds moved.
                  </p>
                  {walletError && (
                    <p className="text-[10px] text-rose-300">{walletError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={saveWallet}
                      disabled={walletSaving || !walletDraft.trim()}
                      className="flex-1 bg-primary text-primary-foreground rounded-md px-2 py-1.5 text-xs font-heading font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                    >
                      {walletSaving ? (
                        <><Loader2 className="w-3 h-3 animate-spin" /> Saving</>
                      ) : (
                        <><Save className="w-3 h-3" /> Save address</>
                      )}
                    </button>
                    {editingWallet && (
                      <button
                        onClick={() => { setEditingWallet(false); setWalletError(null); }}
                        disabled={walletSaving}
                        className="rounded-md border border-border/60 bg-background/40 hover:bg-muted/40 px-2 py-1.5 text-xs font-heading font-semibold text-muted-foreground inline-flex items-center gap-1.5"
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                    )}
                  </div>

                  {/* Power-user: connect via MetaMask for a real signed
                      proof. Hidden until expanded so the default UX is
                      safer / simpler. */}
                  <details className="text-[10px] text-muted-foreground mt-1">
                    <summary className="cursor-pointer hover:text-foreground inline-flex items-center gap-1">
                      <MetaMaskIcon className="w-3 h-3" />
                      have MetaMask? connect to prove ownership instead
                    </summary>
                    <div className="mt-2 flex flex-col gap-1.5 pl-3 border-l-2 border-border/40">
                      <p className="leading-snug">
                        Opens MetaMask, asks you to sign a message proving
                        you own this address. Still no transactions or
                        funds — just a cryptographic proof that's saved
                        with your profile.
                      </p>
                      <button
                        onClick={connectAndLinkWallet}
                        disabled={walletConnectStep !== "idle" && walletConnectStep !== "error" && walletConnectStep !== "done"}
                        className="self-start inline-flex items-center justify-center gap-1.5 rounded-md bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-50 px-2.5 py-1 text-[11px] font-heading font-semibold"
                      >
                        {walletConnectStep === "connecting" && <><Loader2 className="w-3 h-3 animate-spin" /> Opening wallet…</>}
                        {walletConnectStep === "signing" && <><Loader2 className="w-3 h-3 animate-spin" /> Sign to confirm…</>}
                        {walletConnectStep === "saving" && <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>}
                        {walletConnectStep === "done" && <><Check className="w-3 h-3" /> linked</>}
                        {(walletConnectStep === "idle" || walletConnectStep === "error") && (
                          <>
                            <MetaMaskIcon className="w-3 h-3" /> Connect MetaMask
                          </>
                        )}
                      </button>
                      {walletConnectError && (
                        <p className="text-rose-300">{walletConnectError}</p>
                      )}
                    </div>
                  </details>
                </div>
              )}
            </div>
            )}
          </div>

          {oauthError && (
            <p className="text-[11px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
              {oauthError}
            </p>
          )}

          {/* Safety promise — small print but unmissable */}
          {!IOS_APP && <p className="text-[10px] text-muted-foreground/80 leading-relaxed flex items-start gap-1.5 mt-1">
            <ShieldCheck className="w-3 h-3 mt-0.5 flex-shrink-0 text-emerald-400" />
            <span>
              Linking your wallet only asks you to sign a message proving you own it.
              No transactions. No funds move. You can unlink anytime.
            </span>
          </p>}
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
        href="/coin"
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
// OAuthButton — used in the signed-out form. Branded outline button
// with the provider logo. Same chrome as the email/password submit
// so the alternatives feel first-class.
// ----------------------------------------------------------------------

function OAuthButton({
  provider,
  label,
  busy,
  onClick,
}: {
  provider: "google" | "github";
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded-lg border border-border/60 bg-background/30 hover:bg-muted/40 transition-colors px-3 py-2 text-sm font-heading font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : provider === "google" ? (
        <GoogleIcon className="w-4 h-4" />
      ) : (
        <Github className="w-4 h-4" />
      )}
      <span>{label}</span>
    </button>
  );
}

// ----------------------------------------------------------------------
// ProviderRow — one line per connected (or unconnected) identity.
// Used inside the "Connected accounts" stack so every method reads
// in the same shape.
// ----------------------------------------------------------------------

function ProviderRow({
  icon,
  label,
  value,
  linked,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  linked: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/20 px-2.5 py-1.5 flex items-center gap-2">
      <span className={linked ? "text-foreground/85" : "text-muted-foreground"}>{icon}</span>
      <span className="text-xs font-heading font-semibold w-16 flex-shrink-0">{label}</span>
      <span className="text-xs text-muted-foreground flex-1 truncate">{value}</span>
      {linked ? (
        <span className="text-[10px] inline-flex items-center gap-1 text-emerald-300">
          <Check className="w-3 h-3" />
        </span>
      ) : null}
      {action}
    </div>
  );
}

// ----------------------------------------------------------------------
// Brand icons — small inline SVGs so we don't pull in another lib.
// ----------------------------------------------------------------------

function GoogleIcon({ className = "" }: { className?: string }) {
  // Standard four-color "G" mark. Adapted from Google's brand guide;
  // each path is one color of the wordmark glyph.
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11A6.6 6.6 0 0 1 5.48 12c0-.73.13-1.44.36-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function MetaMaskIcon({ className = "" }: { className?: string }) {
  // Simplified fox-head silhouette in MetaMask orange. Not exact-brand
  // but recognizable; we don't ship pixel-art brand assets for now.
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#F6851B"
        d="M3 6l4-2 5 4 5-4 4 2-1 5 1 3-2 4-3-1-1 2H8l-1-2-3 1-2-4 1-3z"
      />
      <path fill="#fff" d="M9.5 13a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm3 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0z" />
    </svg>
  );
}

function TelegramIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#229ED9"
        d="M22 4 2 11l6 2 2 7 4-5 5 4 3-15z"
      />
    </svg>
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
