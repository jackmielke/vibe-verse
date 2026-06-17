/**
 * LogInWithVibe — the single button that goes in the global nav.
 *
 * Signed out: pill button "Log in with Vibe" that opens VibeAuthDialog.
 * Signed in:  the user's tiny avatar; click → dropdown with name,
 *             "Edit profile" placeholder, and Sign out.
 */
import { useState } from "react";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import VibeAvatar from "@/components/vibe-auth/VibeAvatar";
import VibeLogo from "@/components/vibe-auth/VibeLogo";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, User2, Palette } from "lucide-react";
import VibePalettePopover from "@/components/vibe-auth/VibePalettePopover";

export default function LogInWithVibe({
  compact = false,
}: {
  /** When true, only render the icon — useful on dense nav rows. */
  compact?: boolean;
}) {
  const id = useVibeIdentity();
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  if (id.loading) {
    return <div className="h-8 w-8 rounded-full bg-white/5 animate-pulse" />;
  }

  // Signed OUT — minimal icon-only profile button.
  if (!id.session) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="h-9 w-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/15 flex items-center justify-center transition"
          title="Vibe Profile — sign in"
          aria-label="Vibe Profile"
        >
          <User2 className="h-4 w-4 text-white/70" />
        </button>
        <VibeAuthDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  // Signed IN — avatar-only button → dropdown.
  const display = id.profile?.name || id.profile?.username || id.user?.email || "You";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="h-9 w-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/15 flex items-center justify-center overflow-hidden transition"
            title={display}
            aria-label="Vibe Profile"
          >
            <VibeAvatar colorId={id.colorId} size={30} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 bg-zinc-950 border-white/15 text-white">
          <DropdownMenuLabel className="flex items-center gap-2">
            <VibeAvatar colorId={id.colorId} size={32} />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-white/40">Vibe Profile</div>
              <div className="text-xs font-semibold truncate">{display}</div>
              <div className="text-[10px] text-white/50 truncate">{id.user?.email}</div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem onClick={() => setPaletteOpen(true)} className="cursor-pointer">
            <Palette className="mr-2 h-4 w-4" /> Change vibe color
          </DropdownMenuItem>
          <DropdownMenuItem disabled className="opacity-50 cursor-not-allowed">
            <User2 className="mr-2 h-4 w-4" /> Edit Vibe Profile · soon
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
      <VibePalettePopover open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}
