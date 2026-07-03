/**
 * VibeAuthDialog — code-first sign in, no app-switching required. Enter
 * your email, get a 6-digit code, paste it right here. The same email
 * also carries a magic link for people who prefer tapping it. Password
 * mode is hidden behind a toggle; wallet/Google are marked coming soon.
 */
import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import VibeArc from "@/components/VibeArc";

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

  const reset = () => {
    setMode("magic");
    setIsSignUp(false);
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setSent(false);
    setCode("");
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
  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = code.replace(/\D/g, "");
    if (token.length < 6) {
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
  };

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
            <VibeArc size={140} rotateSeconds={28} />
          </div>

          <h2
            className="text-center text-2xl font-bold tracking-tight"
            style={{ fontFamily: "'Sora', system-ui, sans-serif" }}
          >
            Welcome to the Vibe
          </h2>
          <p className="text-center text-sm text-white/60 mt-1">
            {mode === "magic"
              ? sent
                ? "Enter the 6-digit code we emailed you"
                : "Enter your email — we'll send you a 6-digit code"
              : isSignUp
              ? "Create an account with a password"
              : "Sign in with your password"}
          </p>

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
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="bg-transparent border-white/15 rounded-xl h-14 text-center text-2xl tracking-[0.5em] font-mono placeholder:text-white/20 placeholder:tracking-[0.5em]"
                />
                <Button
                  type="submit"
                  disabled={loading || code.length < 6}
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
                  disabled={loading}
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
                disabled={loading}
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
              onClick={() => toast.info("MetaMask sign-in — coming soon")}
              className="w-full h-12 rounded-xl border border-white/15 bg-transparent hover:bg-white/5 transition flex items-center justify-center gap-2.5 text-sm font-medium text-white/60"
            >
              <span className="text-lg leading-none opacity-70">🦊</span>
              Continue with MetaMask
              <span className="ml-1 text-[9px] uppercase tracking-widest rounded-full border border-white/20 px-1.5 py-0.5 text-white/45">
                soon
              </span>
            </button>

            <button
              type="button"
              onClick={() => toast.info("Google sign-in — coming soon")}
              className="w-full h-12 rounded-xl border border-white/15 bg-transparent hover:bg-white/5 transition flex items-center justify-center gap-2.5 text-sm font-medium text-white/60"
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
              Continue with Google
              <span className="ml-1 text-[9px] uppercase tracking-widest rounded-full border border-white/20 px-1.5 py-0.5 text-white/45">
                soon
              </span>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
