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

  // Sized to match the chip height in GlobalNav so the pills align.
  const iconBtn =
    "h-7 w-7 rounded-full flex items-center justify-center transition overflow-hidden";

  if (id.loading) {
    return <div className={`${iconBtn} bg-white/5 animate-pulse`} />;
  }

  // Signed OUT — glowing "Log in" pill.
  if (!id.session) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="group relative h-7 px-3 rounded-full border border-primary/40 bg-primary/10 text-primary text-[11px] font-semibold tracking-wide hover:bg-primary/20 hover:border-primary/70 transition-all shadow-[0_0_12px_-2px_hsl(var(--primary)/0.6)] hover:shadow-[0_0_18px_-1px_hsl(var(--primary)/0.85)]"
          title="Log in with Vibe"
          aria-label="Log in"
        >
          <span className="relative z-10">Log in</span>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full opacity-60 blur-[6px] bg-primary/30 group-hover:opacity-90 transition-opacity"
          />
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
            className={`${btn} hover:bg-white/10`}
            title={display}
            aria-label="Vibe Profile"
          >
            <VibeAvatar colorId={id.colorId} size={26} />
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
