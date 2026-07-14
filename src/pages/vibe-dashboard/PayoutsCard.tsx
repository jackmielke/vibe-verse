/**
 * PayoutsCard — the buildathon winner payout checklist.
 *
 * Data lives in ./data.ts (BUILDATHON_PAYOUTS) so Jack can flip a
 * winner from "pending" to "paid" by editing one line. Each row shows
 * the deal on the table: $500-equivalent in $VIBE with a HODL-through-
 * 2026 ask, or the $40 USD alternative.
 */
import { CheckCircle2, Circle, Trophy } from "lucide-react";
import { BUILDATHON_PAYOUTS, PAYOUT_TERMS } from "./data";
import { DashCard, StaticMarker } from "./shared";

export function PayoutsCard() {
  const paid = BUILDATHON_PAYOUTS.filter((p) => p.status === "paid");
  const done = paid.length;
  const total = BUILDATHON_PAYOUTS.length;

  return (
    <DashCard
      icon={Trophy}
      title="Buildathon payouts"
      aside={<StaticMarker label="tracked by hand" />}
    >
      {/* Progress — thin mark, direct label, no axis needed. */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <p className="font-heading text-sm font-semibold text-foreground">
            {done} of {total} paid
          </p>
          <p className="text-[10px] text-muted-foreground">
            $500-equiv $VIBE (HODL thru 2026) or $40 USD
          </p>
        </div>
        <div
          className="h-2 rounded-full bg-background/60 border border-border/40 overflow-hidden"
          role="img"
          aria-label={`${done} of ${total} winners paid`}
        >
          <div
            className="h-full rounded-r-[4px]"
            style={{
              width: `${(done / total) * 100}%`,
              background: "hsl(var(--mint))",
            }}
          />
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {BUILDATHON_PAYOUTS.map((p) => {
          const isPaid = p.status === "paid";
          return (
            <li
              key={p.name}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 border ${
                isPaid
                  ? "border-emerald-400/25 bg-emerald-400/5"
                  : "border-border/40 bg-background/30"
              }`}
            >
              {isPaid ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />
              )}
              <span
                className={`flex-1 text-xs font-heading font-semibold truncate ${
                  isPaid ? "text-foreground" : "text-foreground/85"
                }`}
              >
                {p.name}
              </span>
              {p.note && (
                <span className="text-[9px] text-muted-foreground truncate">{p.note}</span>
              )}
              <span
                className={`text-[9px] rounded-full px-2 py-0.5 border whitespace-nowrap ${
                  p.option === "vibe-hodl"
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : p.option === "usd-alt"
                      ? "border-sky-400/40 bg-sky-400/10 text-sky-300"
                      : "border-border/60 bg-background/40 text-muted-foreground"
                }`}
              >
                {PAYOUT_TERMS[p.option]}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-[9px] text-muted-foreground/70">
        Edit <span className="font-mono">src/pages/vibe-dashboard/data.ts</span> to
        mark a payout done or record which option a winner picked.
      </p>
    </DashCard>
  );
}
