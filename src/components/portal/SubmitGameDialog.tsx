/**
 * Submit a game without leaving the shelf you are standing on.
 *
 * `/submit-game` is a whole page and it is the wrong shape for the moment
 * somebody wants it: they are in the arcade, looking at what other people have
 * put there, and thinking "I could put mine here". Sending them to a different
 * route to act on that costs them their place, and the arcade is the argument
 * for submitting — a form on its own page has to make that argument again.
 *
 * So it is a dialog, and the page stays exactly as it was for anybody who
 * arrives at it directly or wants the long explanation. They share one form, so
 * the thing that files games onto a public shelf cannot drift into two
 * behaviours.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SubmitGameForm from "@/components/portal/SubmitGameForm";
import SubmitResultCard from "@/components/portal/SubmitResultCard";

export default function SubmitGameDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Scrolls internally: a filled-in result card can be taller than a phone,
          and a dialog that grows past the viewport puts its own close button
          off screen. */}
      <DialogContent className="max-h-[88dvh] max-w-lg overflow-y-auto border-border/60 bg-[#080d17]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-[#7dffd4]">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="font-heading text-[9.5px] font-bold uppercase tracking-[0.3em]">
              Submit a game
            </span>
          </div>
          <DialogTitle className="font-heading text-2xl font-black leading-tight tracking-tight">
            Paste a link. That is the form.
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            A deployed game, or an open-source repository. We work out the rest —
            the name, the description, who made it, and whether a browser can
            actually run it.
          </DialogDescription>
        </DialogHeader>

        <SubmitGameForm compact>
          {(result) => (result ? <SubmitResultCard result={result} /> : null)}
        </SubmitGameForm>

        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground/70">
          Your game runs sandboxed on its own origin and is never told who the
          player is.{" "}
          <Link
            to="/build"
            onClick={() => onOpenChange(false)}
            className="text-[#7dffd4] hover:underline"
          >
            The whole deal
          </Link>
          , including the four lines that let it pay people.
        </p>
      </DialogContent>
    </Dialog>
  );
}
