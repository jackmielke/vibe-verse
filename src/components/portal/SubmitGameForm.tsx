/**
 * The submit form itself, so it can be a page *and* a pop-up.
 *
 * `/submit-game` is a good page and it is the wrong shape for the moment
 * somebody actually wants it: they are standing in the arcade looking at other
 * people's games, and asking them to leave for a different route is asking them
 * to lose their place. A dialog puts the form where the thought happened.
 *
 * Both surfaces get the same fields, the same submit and the same result card,
 * because two copies of a form that files things into a public shelf is two
 * places for the validation to drift apart.
 *
 * The page keeps everything *around* the form — the headline, the explanation
 * of the two doors, the list of what you have already sent. Those are the parts
 * a dialog has no room for and does not need.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { submitPortalGame, type SubmitResult } from "@/portal/api";

interface Props {
  /** Called after any successful filing, so a caller can refresh its list. */
  onSubmitted?: () => void;
  /** Render the result inline. A dialog wants it; a page may show its own. */
  children?: (result: SubmitResult | null) => React.ReactNode;
  /** Tighter spacing and a stacked submit — for the dialog. */
  compact?: boolean;
}

export default function SubmitGameForm({ onSubmitted, children, compact = false }: Props) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void supabase.auth.getUser().then(({ data }) => live && setSignedIn(!!data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (live) setSignedIn(!!session?.user);
    });
    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await submitPortalGame(url.trim(), label.trim() || undefined);
      setResult(r);
      if (r.failed) {
        // Not a toast.error: the submitter did nothing wrong, and the card
        // below says what to do next. A red banner would suggest otherwise.
        toast("We could not use that one — see the note below.");
      } else if (r.alreadyKnown) {
        toast("Already on the desk.");
      } else {
        toast.success("Filed. It is playable right now.");
        setUrl("");
      }
      onSubmitted?.();
    } catch (err) {
      toast.error("Could not read that link", { description: (err as Error).message });
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={onSubmit} className={compact ? "" : "mt-8"}>
        <label
          htmlFor="submit-game-url"
          className="block font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground"
        >
          Link to your game
        </label>
        <div className={`mt-2 flex flex-col gap-2 ${compact ? "" : "sm:flex-row"}`}>
          <input
            id="submit-game-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/you/your-game  ·  https://your-game.lovable.app"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-xl border border-border/60 bg-[#070c16] px-4 py-3 text-[13.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-[#7dffd4]/60"
          />
          <button
            type="submit"
            disabled={busy || !url.trim() || signedIn === false}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#7dffd4] px-5 py-3 font-heading text-[11px] font-bold uppercase tracking-wider text-[#04121c] transition-opacity disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? "Looking…" : "Submit"}
          </button>
        </div>

        <label
          htmlFor="submit-game-label"
          className="mt-4 block font-heading text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground"
        >
          Your name on the card{" "}
          <span className="font-body font-normal normal-case tracking-normal text-muted-foreground/60">
            — optional, defaults to the repo owner
          </span>
        </label>
        <input
          id="submit-game-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Leo"
          maxLength={80}
          className={`mt-2 w-full rounded-xl border border-border/60 bg-[#070c16] px-4 py-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-[#7dffd4]/60 ${
            compact ? "" : "sm:max-w-xs"
          }`}
        />

        {signedIn === false && (
          <p className="mt-4 rounded-xl border border-border/40 bg-white/[0.02] p-4 text-[13px] leading-relaxed text-muted-foreground">
            You need a Vibe account to submit — a game goes on the shelf with
            somebody's name on it.{" "}
            <Link to="/welcome" className="text-[#7dffd4] hover:underline">
              Sign in
            </Link>{" "}
            and come back; the link will still be in your clipboard.
          </p>
        )}
      </form>

      {children?.(result)}
    </>
  );
}
