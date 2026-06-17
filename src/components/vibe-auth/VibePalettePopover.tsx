/**
 * VibePalettePopover — quick "change my color" sheet used from the
 * signed-in dropdown.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import VibeAvatar, { VIBE_COLORS } from "@/components/vibe-auth/VibeAvatar";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { cn } from "@/lib/utils";

export default function VibePalettePopover({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const id = useVibeIdentity();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs bg-zinc-950 border-white/15 text-white">
        <DialogHeader>
          <DialogTitle>Pick your color</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center mb-2">
          <VibeAvatar colorId={id.colorId} size={84} animated />
        </div>
        <div className="grid grid-cols-5 gap-2">
          {VIBE_COLORS.map((c) => {
            const active = id.colorId === c.id;
            return (
              <button
                key={c.id}
                onClick={() => id.setColor(c.id)}
                className={cn(
                  "h-9 rounded-lg border-2 transition hover:scale-105",
                  active ? "border-white scale-105 shadow-lg shadow-white/30" : "border-white/10",
                )}
                style={{ background: c.hex }}
                title={c.name}
                aria-label={c.name}
              />
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
