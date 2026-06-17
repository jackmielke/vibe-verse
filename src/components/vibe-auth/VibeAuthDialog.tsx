/**
 * VibeAuthDialog — the unified "Log in with Vibe" modal.
 *
 * Three steps, all inside one playful card:
 *   1. Welcome — Sign in or Create your Vibe.
 *   2. Create — Club-Penguin-style: pick name + avatar color, then email + password.
 *   3. Sign in — email + password.
 *
 * Wallet & Google are shown as "Coming soon" buttons so the surface
 * already feels like the final product.
 */
import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import VibeAvatar, {
  VIBE_COLORS,
  DEFAULT_VIBE_COLOR,
} from "@/components/vibe-auth/VibeAvatar";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { cn } from "@/lib/utils";

type View = "welcome" | "create" | "signin";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView?: View;
}

export default function VibeAuthDialog({
  open,
  onOpenChange,
  initialView = "welcome",
}: Props) {
  const id = useVibeIdentity();
  const [view, setView] = useState<View>(initialView);

  // Create-vibe state
  const [name, setName] = useState("");
  const [colorId, setColorId] = useState<string>(id.colorId || DEFAULT_VIBE_COLOR);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);

  // Sign-in state
  const [signinEmail, setSigninEmail] = useState("");
  const [signinPassword, setSigninPassword] = useState("");

  const reset = () => {
    setView(initialView);
    setCreateStep(1);
    setName("");
    setEmail("");
    setPassword("");
    setSigninEmail("");
    setSigninPassword("");
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleCreate = async () => {
    if (!email || !password) {
      toast.error("Email and password are required");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/`,
          data: { name: name.trim() || "Vibe Friend" },
        },
      });
      if (error) throw error;
      // Save chosen color immediately so it follows the user into the app.
      id.setColor(colorId);
      id.setGuestName(name.trim() || "Vibe Friend");
      toast.success("Welcome to the Vibe! Check your email to confirm.");
      handleClose(false);
    } catch (e: any) {
      toast.error(e.message ?? "Couldn't create your Vibe");
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async () => {
    if (!signinEmail || !signinPassword) {
      toast.error("Email and password are required");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: signinEmail,
        password: signinPassword,
      });
      if (error) throw error;
      toast.success("Welcome back ✨");
      handleClose(false);
    } catch (e: any) {
      toast.error(e.message ?? "Couldn't sign you in");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md p-0 overflow-hidden border-2 border-fuchsia-500/30 bg-zinc-950 text-white">
        {/* Header strip */}
        <div className="relative bg-gradient-to-br from-fuchsia-500/30 via-purple-500/20 to-cyan-400/30 px-6 py-5 border-b border-white/10">
          {view !== "welcome" && (
            <button
              onClick={() => {
                if (view === "create" && createStep === 2) setCreateStep(1);
                else setView("welcome");
              }}
              className="absolute left-3 top-3 p-1.5 rounded-full hover:bg-white/10 transition"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex flex-col items-center gap-2">
            <VibeAvatar
              colorId={view === "create" ? colorId : id.colorId}
              size={68}
              animated
            />
            <div
              className="text-lg font-extrabold tracking-tight"
              style={{ fontFamily: "'Sora', system-ui, sans-serif" }}
            >
              {view === "welcome" && "Welcome to the Vibe"}
              {view === "create" && (createStep === 1 ? "Create your Vibe" : "Almost there")}
              {view === "signin" && "Sign back in"}
            </div>
            <div className="text-xs text-white/70 text-center max-w-[16rem]">
              {view === "welcome" &&
                "One identity across every world. Worlds work without an account — sign in to save."}
              {view === "create" && createStep === 1 && "Pick a name and a color. You can change them later."}
              {view === "create" && createStep === 2 && "Add an email so you can sign back in on any device."}
              {view === "signin" && "Email and password."}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {view === "welcome" && <WelcomeView setView={setView} />}

          {view === "create" && createStep === 1 && (
            <CharacterStep
              name={name}
              setName={setName}
              colorId={colorId}
              setColorId={setColorId}
              onNext={() => setCreateStep(2)}
            />
          )}

          {view === "create" && createStep === 2 && (
            <CredentialsStep
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              loading={loading}
              onSubmit={handleCreate}
              cta="Create my Vibe"
            />
          )}

          {view === "signin" && (
            <CredentialsStep
              email={signinEmail}
              setEmail={setSigninEmail}
              password={signinPassword}
              setPassword={setSigninPassword}
              loading={loading}
              onSubmit={handleSignIn}
              cta="Sign in"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Sub-views
// ============================================================================

function WelcomeView({ setView }: { setView: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <Button
        size="lg"
        className="w-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-black font-bold hover:opacity-90"
        onClick={() => setView("create")}
      >
        ✨ Create your Vibe
      </Button>
      <Button
        size="lg"
        variant="outline"
        className="w-full border-white/20 bg-white/5 hover:bg-white/10"
        onClick={() => setView("signin")}
      >
        I already have a Vibe
      </Button>

      <div className="relative my-2">
        <Separator className="bg-white/10" />
        <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 bg-zinc-950 text-[10px] uppercase tracking-widest text-white/40">
          or
        </span>
      </div>

      <ComingSoonButton label="Continue with Google" icon="google" />
      <ComingSoonButton label="Connect a wallet" icon="wallet" />

      <p className="text-[10.5px] text-white/40 text-center pt-1 leading-relaxed">
        Wallets sit on top of a Vibe — they aren't a login method on their own.
      </p>
    </div>
  );
}

function CharacterStep({
  name,
  setName,
  colorId,
  setColorId,
  onNext,
}: {
  name: string;
  setName: (s: string) => void;
  colorId: string;
  setColorId: (s: string) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs uppercase tracking-widest text-white/60 mb-1.5 block">
          Vibe name
        </Label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should we call you?"
          maxLength={24}
          className="bg-white/5 border-white/20 text-base"
        />
        <p className="text-[10.5px] text-white/40 mt-1">
          1–24 characters. Be playful — you can rename per-world later.
        </p>
      </div>

      <div>
        <Label className="text-xs uppercase tracking-widest text-white/60 mb-2 block">
          Pick your color
        </Label>
        <div className="grid grid-cols-5 gap-2">
          {VIBE_COLORS.map((c) => {
            const active = colorId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setColorId(c.id)}
                className={cn(
                  "h-10 rounded-lg border-2 transition-all hover:scale-105",
                  active
                    ? "border-white scale-105 shadow-lg shadow-white/30"
                    : "border-white/10",
                )}
                style={{ background: c.hex }}
                aria-label={c.name}
                title={c.name}
              />
            );
          })}
        </div>
      </div>

      <Button
        size="lg"
        className="w-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-black font-bold hover:opacity-90"
        onClick={onNext}
        disabled={!name.trim()}
      >
        Next <ArrowRight className="ml-1 h-4 w-4" />
      </Button>
    </div>
  );
}

function CredentialsStep({
  email,
  setEmail,
  password,
  setPassword,
  loading,
  onSubmit,
  cta,
}: {
  email: string;
  setEmail: (s: string) => void;
  password: string;
  setPassword: (s: string) => void;
  loading: boolean;
  onSubmit: () => void;
  cta: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3"
    >
      <div>
        <Label htmlFor="vibe-email" className="text-xs uppercase tracking-widest text-white/60 mb-1.5 block">
          Email
        </Label>
        <Input
          id="vibe-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className="bg-white/5 border-white/20"
        />
      </div>
      <div>
        <Label htmlFor="vibe-password" className="text-xs uppercase tracking-widest text-white/60 mb-1.5 block">
          Password
        </Label>
        <Input
          id="vibe-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          minLength={6}
          className="bg-white/5 border-white/20"
        />
      </div>
      <Button
        type="submit"
        size="lg"
        disabled={loading}
        className="w-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-black font-bold hover:opacity-90"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : cta}
      </Button>
    </form>
  );
}

function ComingSoonButton({
  label,
  icon,
}: {
  label: string;
  icon: "google" | "wallet";
}) {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full justify-between opacity-70 border-white/15 bg-white/5 hover:bg-white/10 cursor-not-allowed"
      onClick={() => toast.info(`${label} — coming soon`)}
    >
      <span className="flex items-center gap-2">
        {icon === "google" ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
        ) : (
          <span className="text-base">👛</span>
        )}
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-white/50">Soon</span>
    </Button>
  );
}
