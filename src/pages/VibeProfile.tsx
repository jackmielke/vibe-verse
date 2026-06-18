/**
 * VibeProfile — `/profile`. Mobile-first "choose your character + edit
 * your vibe" screen. Replaces the tiny color popover that used to live
 * in the global-nav dropdown.
 *
 * Sections (single column, scrollable):
 *   1. Big animated VibeAvatar preview (Club-Penguin style penguin)
 *   2. Display name editor (saves to localStorage guest name OR the
 *      signed-in profile row)
 *   3. Character color grid — every available vibe color, big tap
 *      targets sized for mobile
 *   4. Account info + sign out (only when signed in)
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, LogOut, Loader2 } from "lucide-react";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import VibeAvatar, { VIBE_COLORS } from "@/components/vibe-auth/VibeAvatar";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function VibeProfile() {
  const id = useVibeIdentity();
  const navigate = useNavigate();
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    setNameDraft(id.displayName === "Guest" ? "" : id.displayName);
  }, [id.displayName]);

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) return;
    setSavingName(true);
    try {
      id.setGuestName(next);
      if (id.user) {
        const { error } = await supabase
          .from("users")
          .update({ name: next })
          .eq("auth_user_id", id.user.id);
        if (error) throw error;
        await id.refresh();
      }
      toast.success("Saved");
    } catch (e: any) {
      toast.error(e.message ?? "Couldn't save your name");
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 max-w-md mx-auto px-4 pt-24 pb-12 flex flex-col gap-6">
        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="self-start inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white transition"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        {/* Avatar preview */}
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-3xl bg-white/5 border border-white/10 p-6">
            <VibeAvatar colorId={id.colorId} size={140} animated />
          </div>
          <h1
            className="font-heading text-2xl font-bold tracking-tight mt-2"
            style={{ fontFamily: "'Sora', system-ui, sans-serif" }}
          >
            Your Vibe
          </h1>
          <p className="text-xs text-white/55 text-center max-w-xs">
            Pick a character color — it's how everyone sees you in every
            world. You can change it any time.
          </p>
        </div>

        {/* Name */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-2">
          <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
            Display name
          </label>
          <div className="flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="What should we call you?"
              className="flex-1 bg-transparent border border-white/15 rounded-xl h-11 px-3 text-sm placeholder:text-white/30 focus:outline-none focus:border-primary/60"
              maxLength={40}
            />
            <button
              onClick={saveName}
              disabled={savingName || !nameDraft.trim() || nameDraft.trim() === id.displayName}
              className="h-11 px-4 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </button>
          </div>
        </section>

        {/* Color grid */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Character color
            </label>
            <span className="text-[10px] text-white/40">
              {VIBE_COLORS.length} options
            </span>
          </div>
          <div className="grid grid-cols-5 sm:grid-cols-6 gap-2.5">
            {VIBE_COLORS.map((c) => {
              const active = id.colorId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => id.setColor(c.id)}
                  className={`relative aspect-square rounded-xl border-2 transition-transform hover:scale-105 active:scale-95 ${
                    active
                      ? "border-white shadow-[0_0_0_3px_rgba(255,255,255,0.15)]"
                      : "border-white/10"
                  }`}
                  style={{ background: c.hex }}
                  title={c.name}
                  aria-label={c.name}
                  aria-pressed={active}
                >
                  {active && (
                    <Check className="absolute inset-0 m-auto h-5 w-5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Account */}
        {id.user ? (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3">
            <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Account
            </label>
            <div className="text-xs text-white/70 truncate">{id.user.email}</div>
            <button
              onClick={() => id.signOut()}
              className="self-start inline-flex items-center gap-1.5 text-xs text-rose-300 hover:text-rose-200 transition"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </section>
        ) : (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/60 leading-relaxed">
            You're browsing as a guest. Your color and name are saved on
            this device — sign in from the top nav to keep them across
            devices.
          </section>
        )}
      </div>
    </div>
  );
}
