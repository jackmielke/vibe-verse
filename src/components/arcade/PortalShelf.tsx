/**
 * The portal shelf — the row of the arcade that grows on its own.
 *
 * Every cabinet above this one is a file in this repository. That is a hard
 * ceiling on how many there can ever be, and it is set by how much of Jack's
 * week is free. The games on this shelf are hosted somewhere else by somebody
 * else, and adding one is a row in a table.
 *
 * So the shelf is also an invitation: it renders the "put yours here" card
 * even when there are games, because the point is not that there are three
 * games — it is that there could be thirty, and none of them have to be his.
 *
 * `remainingToday` is on every card. A game whose allowance is spent should
 * say so before you open it rather than after you have played it, and a number
 * ticking down across the day is a better read on what people are playing than
 * anything else on the page.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import SubmitGameDialog from "@/components/portal/SubmitGameDialog";
import { listPortalGames, type PortalGameListing } from "@/portal/api";

export default function PortalShelf() {
  const [games, setGames] = useState<PortalGameListing[] | null>(null);
  /* Both invitations open the form here rather than routing to it. Somebody
     reading this shelf is already convinced; sending them to a different page
     to act on it makes them lose their place in the argument. `/build` still
     exists and still explains the deal at length, for anybody who wants it. */
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    void listPortalGames()
      .then((r) => live && setGames(r.games))
      // A shelf that cannot reach the server renders as an empty shelf plus
      // the invitation, which is a fine thing for it to be.
      .catch(() => live && setGames([]));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-sm font-black uppercase tracking-wider text-[#8fb4ff]">
            The portal
          </h2>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Games nobody here wrote, paying real coins. They run on their own
            sites, in a sandbox, on an allowance.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSubmitting(true)}
          className="shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Add yours →
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(games ?? []).map((g, i) => (
          <motion.div
            key={g.slug}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.35 }}
          >
            <Link
              to={`/play/${g.slug}`}
              className="group flex h-full flex-col rounded-2xl border border-border/50 bg-black/45 p-4 backdrop-blur-sm transition-colors hover:border-[#8fb4ff]/50 hover:bg-black/60"
              style={{ boxShadow: "inset 0 0 0 1px hsl(220 90% 72% / 0.12)" }}
            >
              <h3 className="font-heading text-sm font-black uppercase tracking-wider text-[#cfe0ff]">
                {g.title}
              </h3>
              <p className="mt-1 flex-1 text-[11px] leading-snug text-muted-foreground">
                {g.tagline}
              </p>
              <div className="mt-3 flex items-end justify-between gap-2 border-t border-border/40 pt-2.5">
                <span className="truncate text-[10px] text-muted-foreground/70">
                  {g.author ? `by ${g.author}` : " "}
                </span>
                <span className="flex shrink-0 items-center gap-1 font-heading text-[11px] font-bold tabular-nums text-[#7dffd4]">
                  <VibeCoinMark size={12} />
                  {g.remainingToday}
                  <span className="font-normal text-muted-foreground/60">left</span>
                </span>
              </div>
            </Link>
          </motion.div>
        ))}

        <button
          type="button"
          onClick={() => setSubmitting(true)}
          className="group flex min-h-[7.5rem] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/50 p-4 text-center transition-colors hover:border-[#8fb4ff]/60 hover:bg-white/[0.03]"
        >
          <Plus className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-[#8fb4ff]" />
          <span className="font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
            Put your game here
          </span>
          <span className="text-[10px] leading-snug text-muted-foreground/60">
            Four lines of JavaScript. No key, no account.
          </span>
        </button>
      </div>

      <SubmitGameDialog open={submitting} onOpenChange={setSubmitting} />
    </section>
  );
}
