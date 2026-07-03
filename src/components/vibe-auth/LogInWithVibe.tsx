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
import { LogOut, User2 } from "lucide-react";

export default function LogInWithVibe({
  compact = false,
}: {
  /** When true, only render the icon — useful on dense nav rows. */
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

  // Signed OUT — a round chip instead of a wordy pill: the face of the
  // character you're playing as (everyone has one, account or not), or
  // a "?" if you've never picked. Tapping it opens the login dialog.
  if (!id.session) {
    const hasPick =
      typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character")) !== null;
    const ring = hasPick ? `${character.accent}90` : "hsl(var(--primary) / 0.55)";
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className={`group relative ${iconBtn} bg-primary/10 hover:bg-primary/20 text-[15px] leading-none shadow-[0_0_12px_-2px_hsl(var(--primary)/0.6)] hover:shadow-[0_0_18px_-1px_hsl(var(--primary)/0.85)]`}
          style={{ boxShadow: `0 0 0 1.5px ${ring}` }}
          title={hasPick ? `Playing as ${character.label} — log in to save your vibe` : "Log in with Vibe"}
          aria-label="Log in"
        >
          <span className="relative z-10" aria-hidden>
            {hasPick ? character.emoji : (
              <span className="text-primary text-[13px] font-bold">?</span>
            )}
          </span>
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
          <span aria-hidden>{character.emoji}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 bg-zinc-950 border-white/15 text-white">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span
            className="h-8 w-8 rounded-full flex items-center justify-center text-lg leading-none bg-white/5"
            style={ringStyle}
            aria-hidden
          >
            {character.emoji}
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
