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

  // Signed OUT — show "Log in with Vibe" + a small avatar preview that
  // reflects the guest's chosen color, so the UI already feels personal.
  if (!id.session) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="group flex items-center gap-2 rounded-full pl-1 pr-3 py-1 bg-gradient-to-r from-fuchsia-500/80 to-cyan-400/80 hover:from-fuchsia-500 hover:to-cyan-400 text-black font-bold text-xs shadow-lg shadow-fuchsia-500/30 transition"
          title="Log in with Vibe"
        >
          <span className="w-7 h-7 rounded-full bg-white/30 flex items-center justify-center overflow-hidden">
            <VibeAvatar colorId={id.colorId} size={26} />
          </span>
          {!compact && <span>Log in with Vibe</span>}
        </button>
        <VibeAuthDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  // Signed IN — avatar dropdown.
  const display = id.profile?.name || id.profile?.username || id.user?.email || "You";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-2 rounded-full pl-1 pr-2.5 py-0.5 bg-white/5 hover:bg-white/10 border border-white/15 transition"
            title={display}
          >
            <span className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center overflow-hidden">
              <VibeAvatar colorId={id.colorId} size={26} />
            </span>
            {!compact && (
              <span className="text-[11px] font-semibold max-w-[7rem] truncate">{display}</span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 bg-zinc-950 border-white/15 text-white">
          <DropdownMenuLabel className="flex items-center gap-2">
            <VibeAvatar colorId={id.colorId} size={28} />
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate">{display}</div>
              <div className="text-[10px] text-white/50 truncate">{id.user?.email}</div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem onClick={() => setPaletteOpen(true)} className="cursor-pointer">
            <Palette className="mr-2 h-4 w-4" /> Change vibe color
          </DropdownMenuItem>
          <DropdownMenuItem disabled className="opacity-50 cursor-not-allowed">
            <User2 className="mr-2 h-4 w-4" /> Edit profile · soon
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
