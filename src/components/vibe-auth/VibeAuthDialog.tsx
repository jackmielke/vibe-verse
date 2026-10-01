/**
 * VibeAuthDialog — code-first sign in, no app-switching required. Enter
 * your email, get a 6-digit code, paste it right here. The same email
 * also carries a magic link for people who prefer tapping it. Password
 * mode is hidden behind a toggle, and below the divider are the two doors
 * that skip the email entirely: MetaMask and Google.
 *
 * All four end in the same place — a Supabase session — so nothing
 * downstream (`useVibeIdentity`, Vibecoin, the wardrobe, RLS) has to know
 * or care which one somebody came through.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { OTP_LENGTH, normalizeOtp, shouldAutoSubmit } from "@/lib/otp";
import { signInWithGoogle } from "@/lib/oauth";
import { IOS_APP } from "@/lib/iosApp";
import {
  findWallets,
  isUserRejection,
  metamaskDeepLink,
  pickMetaMask,
  signInWithWallet,
  type DiscoveredWallet,
} from "@/lib/walletAuth";

/**
 * The iridescent arch at the top of this dialog is decoration, and it is a
 * WebGL canvas — so importing it statically put all 1.4 MB of three.js in the
 * chunk every page of the app downloads, because this dialog hangs off the log
 * in button in the global nav. It is lazy, and Radix only mounts the content
 * when the dialog opens, so the import fires on the tap that opens it and
 * nowhere else.
 */
const VibeArc = lazy(() => import("@/components/VibeArc"));

/** Holds the arch's square while it loads, so nothing below it jumps. */
const ARC_SIZE = 140;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Mode = "magic" | "password";

export default function VibeAuthDialog({ open, onOpenChange }: Props) {
  const [mode, setMode] = useState<Mode>("magic");
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  /** Which of the two buttons under the divider is mid-flight, if either. */
  const [social, setSocial] = useState<"wallet" | "google" | null>(null);
  /**
   * The wallets this browser announced. `null` means we have not asked yet,
   * `[]` means we asked and nothing answered — a distinction the button label
   * needs, because "MetaMask" and "no wallet here" should not swap places
   * while somebody is reading them.
   */
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);

  /* Ask on open rather than on mount: this component lives in the global nav
     on every page, and EIP-6963 discovery dispatches a window event that wakes
     every wallet extension installed. Doing that to somebody who never opens
     the dialog is rude, and doing it on every page load is rude repeatedly. */
  useEffect(() => {
    if (!open || IOS_APP) return;
    let live = true;
    void findWallets().then((found) => {
      if (live) setWallets(found);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const reset = () => {
    setMode("magic");
    setIsSignUp(false);
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setSent(false);
    setCode("");
    setSocial(null);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error("Enter your email first");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) throw error;
      setSent(true);
      setCode("");
      toast.success("Code sent — check your email ✨");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setLoading(false);
    }
  };

  // Paste the 6-digit code from the email — no app-switching needed.
  const handleVerifyCode = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const token = normalizeOtp(code);
      if (token.length < OTP_LENGTH) {
        toast.error("Enter the 6-digit code from the email");
        return;
      }
      setLoading(true);
      try {
        const { error } = await supabase.auth.verifyOtp({
          email,
          token,
          type: "email",
        });
        if (error) throw error;
        toast.success("Welcome to the Vibe ✨");
        handleClose(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That code didn't match — try again");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, email],
  );

  /**
   * Submit the moment six digits are in the box.
   *
   * This is the half of "it autofills" that people actually mean. iOS offers
   * the code above the keyboard, one tap drops it in — and without this you
   * then have to find and press a button, which is most of the friction the
   * autofill was supposed to remove. Six digits is an unambiguous signal; there
   * is nothing else the user could be about to type.
   *
   * `tried` guards the loop: a wrong code would otherwise re-submit on every
   * render while the field still holds six characters. It resets as soon as
   * they edit, so a corrected code goes through on its own too.
   */
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldAutoSubmit({ code, lastTried: tried.current, sent, loading })) return;
    tried.current = normalizeOtp(code);
    void handleVerifyCode();
  }, [code, sent, loading, handleVerifyCode]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Email and password are required");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (isSignUp && password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        toast.success("Welcome to the Vibe! Check your email to confirm.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        toast.success("Welcome back ✨");
      }
      handleClose(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Door three — a wallet.
   *
   * Labelled MetaMask because that is the name people are looking for, but it
   * signs in with whatever actually answered: somebody running Rabby has a
   * perfectly good wallet and should not be told to go and install a second
   * one. `pickMetaMask` gets first refusal; anything else gets the job if
   * MetaMask is not here.
   */
  const handleWallet = async () => {
    const found = wallets ?? (await findWallets());
    setWallets(found);
    const wallet = pickMetaMask(found) ?? found[0] ?? null;

    if (!wallet) {
      /* On a phone there is nothing to install — MetaMask is a browser there,
         not an extension — so the useful move is to reopen this page inside
         it. On a desktop it really is an install. */
      const onPhone = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
      toast.info(onPhone ? "Opening MetaMask…" : "No wallet found in this browser", {
        description: onPhone
          ? "Continuing in the MetaMask app's browser."
          : "Install MetaMask (or any wallet) and try again — or use your email above.",
      });
      window.open(
        onPhone ? metamaskDeepLink() : "https://metamask.io/download/",
        onPhone ? "_self" : "_blank",
        "noopener,noreferrer",
      );
      return;
    }

    setSocial("wallet");
    try {
      const { isNewAccount, walletName } = await signInWithWallet(wallet);
      toast.success(isNewAccount ? "Welcome to the Vibe ✨" : "Welcome back ✨", {
        description: `Signed in with ${walletName}.`,
      });
      handleClose(false);
    } catch (err) {
      // Closing the signature prompt is a decision, not a failure.
      if (!isUserRejection(err)) {
        toast.error("Could not sign you in with that wallet", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSocial(null);
    }
  };

  /**
   * Door four — Google.
   *
   * `setSocial` is never cleared on the success path, and that is correct: the
   * browser is navigating to Google, and flipping the button back to idle for
   * the half second before it does reads as "nothing happened, press it again".
   */
  const handleGoogle = async () => {
    setSocial("google");
    try {
      await signInWithGoogle();
    } catch (err) {
      toast.error("Google sign-in isn't available", {
        description: err instanceof Error ? err.message : String(err),
      });
      setSocial(null);
    }
  };

  /* Say the name of the wallet that will actually open. Until discovery has
     answered we say MetaMask, which is what the button has always said and
     what it will say again for most people. */
  const walletLabel = (() => {
    if (!wallets?.length) return "Continue with MetaMask";
    const named = pickMetaMask(wallets) ?? wallets[0];
    return `Continue with ${named.name}`;
  })();

  const busy = loading || social != null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md p-0 overflow-hidden border border-white/10 bg-[#0b1220] text-white rounded-2xl">
        <div className="relative px-6 pt-6 pb-7">
          <button
            onClick={() => handleClose(false)}
            className="absolute left-4 top-4 p-1.5 rounded-full hover:bg-white/10 transition"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <div className="flex justify-center mb-2 -mt-2">
            <Suspense fallback={<div style={{ width: ARC_SIZE, height: ARC_SIZE }} />}>
              <VibeArc size={ARC_SIZE} rotateSeconds={28} />
            </Suspense>
          </div>

          {/* Radix's own Title/Description, not a bare h2 and p. Without them
              the dialog opens silently for a screen reader — no announcement of
              what it is or what it wants — and this is the one dialog everybody
              has to get through. Same styling, correct semantics. */}
          <DialogTitle
            className="text-center text-2xl font-bold tracking-tight"
            style={{ fontFamily: "'Sora', system-ui, sans-serif" }}
          >
            Welcome to the Vibe
          </DialogTitle>
          <DialogDescription className="text-center text-sm text-white/60 mt-1">
            {mode === "magic"
              ? sent
                ? "Enter the 6-digit code we emailed you"
                : "Enter your email — we'll send you a 6-digit code"
              : isSignUp
              ? "Create an account with a password"
              : "Sign in with your password"}
          </DialogDescription>

          {mode === "magic" ? (
            sent ? (
              <form onSubmit={handleVerifyCode} className="mt-7 space-y-4">
                <p className="text-sm text-white/70 text-center">
                  We emailed <span className="text-white">{email}</span>. Paste
                  the code below — or just tap the link in the email, either
                  works.
                </p>
                <Input
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  /* One input, never six boxes: split single-character fields
                     look tidy and defeat one-time-code autofill completely.
                     `type` stays text — `number` breaks it too. */
                  name="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(normalizeOtp(e.target.value))}
                  className="bg-transparent border-white/15 rounded-xl h-14 text-center text-2xl tracking-[0.5em] font-mono placeholder:text-white/20 placeholder:tracking-[0.5em]"
                />
                <Button
                  type="submit"
                  disabled={busy || code.length < OTP_LENGTH}
                  className="w-full h-12 rounded-xl bg-white text-black font-semibold hover:bg-white/90 disabled:opacity-40"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enter the Vibe"}
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setSent(false);
                      setCode("");
                    }}
                    className="text-white/50 hover:text-white transition"
                  >
                    Use a different email
                  </button>
                  <button
                    type="button"
                    onClick={(e) => void handleMagicLink(e as unknown as React.FormEvent)}
                    disabled={loading}
                    className="text-white/50 hover:text-white transition disabled:opacity-40"
                  >
                    Resend code
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleMagicLink} className="space-y-4 mt-7">
                <div className="space-y-1.5">
                  <Label htmlFor="vibe-email" className="text-sm font-medium">
                    Email
                  </Label>
                  <Input
                    id="vibe-email"
                    type="email"
                    autoComplete="email"
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="bg-transparent border-white/15 rounded-xl h-12 placeholder:text-white/30"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={busy}
                  className="w-full h-12 rounded-xl bg-white text-black font-semibold hover:bg-white/90"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Send me a code"
                  )}
                </Button>

                <button
                  type="button"
                  onClick={() => setMode("password")}
                  className="w-full text-xs text-white/50 hover:text-white transition"
                >
                  Use a password instead
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handlePasswordSubmit} className="space-y-4 mt-7">
              <div className="space-y-1.5">
                <Label htmlFor="vibe-email" className="text-sm font-medium">
                  Email
                </Label>
                <Input
                  id="vibe-email"
                  type="email"
                  autoComplete="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="bg-transparent border-white/15 rounded-xl h-12 placeholder:text-white/30"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="vibe-password" className="text-sm font-medium">
                  Password
                </Label>
                <Input
                  id="vibe-password"
                  type="password"
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="bg-transparent border-white/15 rounded-xl h-12 placeholder:text-white/30"
                />
              </div>

              {isSignUp && (
                <div className="space-y-1.5">
                  <Label htmlFor="vibe-confirm" className="text-sm font-medium">
                    Confirm Password
                  </Label>
                  <Input
                    id="vibe-confirm"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={6}
                    className="bg-transparent border-white/15 rounded-xl h-12 placeholder:text-white/30"
                  />
                </div>
              )}

              <Button
                type="submit"
                disabled={busy}
                className="w-full h-12 rounded-xl bg-white text-black font-semibold hover:bg-white/90"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isSignUp ? (
                  "Sign Up"
                ) : (
                  "Sign In"
                )}
              </Button>

              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setIsSignUp(!isSignUp);
                    setConfirmPassword("");
                  }}
                  className="text-white/60 hover:text-white transition"
                >
                  {isSignUp ? "Have an account? Sign in" : "New here? Sign up"}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("magic")}
                  className="text-white/60 hover:text-white transition"
                >
                  ← Back to magic link
                </button>
              </div>
            </form>
          )}

          {/* Email is the only door for now. MetaMask and Google stay on the
              page as "Coming soon" (Jack, 2026-10-01: a live-looking button
              that leads nowhere is worse than an honest one), and the App Store
              edition drops them entirely: no wallet there (3.1.5 / 5.3), and
              Google refuses OAuth inside a WKWebView. The handlers stay wired
              so turning one back on is deleting `soon`. */}
          {!IOS_APP && (<>
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-white/40">
              Or continue with
            </span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleWallet()}
              disabled={busy || SOON}
              title="Coming soon"
              className="w-full h-12 rounded-xl border border-white/15 bg-transparent hover:bg-white/5 transition flex items-center justify-center gap-2.5 text-sm font-medium text-white/80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              {social === "wallet" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span className="text-lg leading-none">🦊</span>
              )}
              {social === "wallet" ? "Check your wallet…" : walletLabel}
              {SOON && <SoonTag />}
            </button>

            <button
              type="button"
              onClick={() => void handleGoogle()}
              disabled={busy || SOON}
              title="Coming soon"
              className="w-full h-12 rounded-xl border border-white/15 bg-transparent hover:bg-white/5 transition flex items-center justify-center gap-2.5 text-sm font-medium text-white/80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              {social === "google" ? "Taking you to Google…" : "Continue with Google"}
              {SOON && <SoonTag />}
            </button>
          </div>
          </>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** MetaMask and Google sign-in are switched off until they are set up properly. */
const SOON = true;

const SoonTag = () => (
  <span className="ml-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
    Coming soon
  </span>
);
