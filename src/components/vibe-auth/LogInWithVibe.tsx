/**
 * LogInWithVibe — the single button that goes in the global nav.
 *
 * Signed out: pill button "Log in" → VibeAuthDialog.
 * Signed in:  the user's tiny avatar → dropdown with name + a single
 *             "Choose your character" link to the full /profile page
 *             (replaces the old inline color popover) + sign out.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useActiveCharacter } from "@/hooks/use-active-character";
import VibeAvatar from "@/components/vibe-auth/VibeAvatar";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Trash2, User2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { characterFace } from "@/lib/characterFaces";

/**
 * The character you are playing as, at avatar size — their actual face.
 *
 * Falls back to the emoji, which is what this always was and is still right
 * for the GLB roster: those have a model rather than a rig, so there is no
 * head for `character-shots --face` to point a camera at.
 *
 * `eager`, unusually for an image this small: it is the avatar in the corner of
 * every page, so it is above the fold everywhere, and lazily loading a 28px
 * picture only buys a visible pop-in on the thing that says who you are.
 */
function CharacterFace({ id, emoji }: { id: string; emoji: string }) {
  const src = characterFace(id);
  if (!src) return <span aria-hidden>{emoji}</span>;
  return (
    <img
      src={src}
      alt=""
      width={192}
      height={192}
      decoding="async"
      className="h-full w-full scale-[1.18] object-contain"
      aria-hidden
    />
  );
}

export default function LogInWithVibe({
  compact = false,
}: {
  /**
   * Icon only, at every width — for a row too dense to spare the word.
   *
   * The default is *not* icon-only. A round chip with a "?" in it was the
   * entire log-in affordance for a while, and it reads as a help button: the
   * one thing a signed-out visitor is looking for was the one thing the nav
   * did not say. So the word is there from `sm:` up, and only a caller that
   * genuinely has no room opts out of it.
   */
  compact?: boolean;
}) {
  const id = useVibeIdentity();
  const { character } = useActiveCharacter();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Sized to match the chip height in GlobalNav so the pills align.
  const iconBtn =
    "h-7 w-7 rounded-full flex items-center justify-center transition overflow-hidden";

  if (id.loading) {
    return <div className={`${iconBtn} bg-white/5 animate-pulse`} />;
  }

  // Signed OUT — the face of the character you're playing as (everyone has
  // one, account or not) or a "?" if you've never picked, and the word "Log
  // in" beside it wherever there is room for it.
  if (!id.session) {
    const hasPick =
      typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character")) !== null;
    const ring = hasPick ? `${character.accent}90` : "hsl(var(--primary) / 0.55)";
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className={`group relative flex h-7 items-center gap-1.5 rounded-full bg-primary/10 pl-0.5 transition hover:bg-primary/20 shadow-[0_0_12px_-2px_hsl(var(--primary)/0.6)] hover:shadow-[0_0_18px_-1px_hsl(var(--primary)/0.85)] ${
            compact ? "w-7 justify-center pl-0" : "pr-2.5"
          }`}
          style={{ boxShadow: `0 0 0 1.5px ${ring}` }}
          title={hasPick ? `Playing as ${character.label} — log in to save your vibe` : "Log in with Vibe"}
          aria-label="Log in"
        >
          <span
            className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[15px] leading-none"
            aria-hidden
          >
            {hasPick ? <CharacterFace id={character.id} emoji={character.emoji} /> : (
              <span className="text-primary text-[13px] font-bold">?</span>
            )}
          </span>
          {/* Shown at every width, unlike the Worlds pill's label, which hides
              on a phone. The asymmetry is deliberate: somebody who cannot find
              the worlds has a whole page of them under this bar, and somebody
              who cannot find the log in has nothing. It is about forty pixels
              and it buys the one word this corner has to say. */}
          {!compact && (
            <span className="font-heading text-[10.5px] font-semibold uppercase leading-none tracking-wider text-primary">
              Log in
            </span>
          )}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full opacity-50 blur-[6px] bg-primary/25 group-hover:opacity-80 transition-opacity"
          />
        </button>
        <VibeAuthDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  // Signed IN — character-emoji button (tinted by chosen vibe color)
  //   → dropdown.
  const display = id.profile?.name || id.profile?.username || id.user?.email || "You";
  // Top-right shows the EMOJI of the active character, ringed by the
  // user's vibe color — no penguin.
  const ringStyle = { boxShadow: `0 0 0 1.5px ${character.accent}80` };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`${iconBtn} bg-white/5 hover:bg-white/10 text-[15px] leading-none`}
          style={ringStyle}
          title={`${display} · ${character.label}`}
          aria-label="Vibe Profile"
        >
          <CharacterFace id={character.id} emoji={character.emoji} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 bg-zinc-950 border-white/15 text-white">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span
            className="h-8 w-8 overflow-hidden rounded-full flex items-center justify-center text-lg leading-none bg-white/5"
            style={ringStyle}
            aria-hidden
          >
            <CharacterFace id={character.id} emoji={character.emoji} />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-white/40">Vibe Profile</div>
            <div className="text-xs font-semibold truncate">{display}</div>
            <div className="text-[10px] text-white/50 truncate">
              Playing as {character.label}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem onClick={() => navigate("/profile")} className="cursor-pointer">
          <User2 className="mr-2 h-4 w-4" /> Choose your character
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem onClick={() => void deleteAccount(() => id.signOut())} className="cursor-pointer text-white/50 focus:text-rose-200">
          <Trash2 className="mr-2 h-4 w-4" /> Delete account
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => id.signOut()}
          className="cursor-pointer text-rose-300 focus:text-rose-200"
        >
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Delete your own account (App Store 5.1.1(v) asks for it in the app).
 * `delete-account` reads who you are from your session, so it can only ever
 * delete the caller. If the database refuses, Jack finishes it by hand within
 * 24 hours and the function says so with `pending`.
 */
async function deleteAccount(signOut: () => unknown) {
  if (!window.confirm("Delete your Vibe Verse account? Your profile and sign-in are removed for good. This can't be undone.")) return;
  const { data, error } = await supabase.functions.invoke("delete-account", { method: "POST" });
  if (error) {
    toast.error("Couldn't delete your account. Email jackcmielke@gmail.com and it will be done within 24 hours.");
    return;
  }
  toast.success(data?.pending ? "Deletion requested. It will be finished within 24 hours." : "Your account is deleted.");
  await signOut();
}
