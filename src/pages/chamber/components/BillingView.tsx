import { BellRing, Check, X as XIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { billingComparison, invoices } from "../data/billing";
import { money } from "../theme";
import { Rise, SectionHeading, StatTile, StatusPill } from "./shared";

export const BillingView = () => {
  const [autoRemind, setAutoRemind] = useState(true);

  const collected = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0);
  const outstanding = invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + i.amount, 0);
  const overdueCount = invoices.filter((i) => i.status === "overdue").length;

  return (
    <div>
      <SectionHeading
        title="Billing"
        subtitle="Dues run themselves. Invoices go out on the 1st, reminders send on a gentle schedule, and payments reconcile automatically."
      />

      <Rise className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Collected this month" value={money(collected)} hint="Across all paid invoices" tone="green" />
        <StatTile label="Outstanding" value={money(outstanding)} hint="Sent + overdue" />
        <StatTile label="Overdue invoices" value={String(overdueCount)} hint="Auto-reminders in flight" tone="wine" />
        <div className="rounded-xl bg-card border border-border shadow-sm p-5 flex flex-col justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Auto-remind</p>
          </div>
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-muted-foreground pr-3">
              {autoRemind ? "Gentle nudges at +7 and +14 days" : "Reminders paused"}
            </p>
            <button
              role="switch"
              aria-checked={autoRemind}
              onClick={() => setAutoRemind((v) => !v)}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                autoRemind ? "bg-primary" : "bg-border",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-transform",
                  autoRemind ? "translate-x-[22px]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>
      </Rise>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {/* Invoice table */}
        <Rise delay={0.08} className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-muted-foreground border-b border-border">
                  <th className="px-5 py-3 font-semibold">Invoice</th>
                  <th className="px-4 py-3 font-semibold">Business</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold text-right">Amount</th>
                  <th className="px-4 py-3 font-semibold">Due</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-secondary/50 transition-colors">
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{inv.id}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{inv.business}</td>
                    <td className="px-4 py-3 text-muted-foreground">{inv.kind}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-foreground">{money(inv.amount)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{inv.due}</td>
                    <td className="px-4 py-3"><StatusPill kind={inv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Rise>

        {/* Automated vs manual callout */}
        <Rise delay={0.16}>
          <div className="rounded-xl border border-primary/25 bg-primary/[0.06] shadow-sm p-5 h-full">
            <h3 className="ch-serif text-xl font-semibold text-foreground">What just got automated</h3>
            <ul className="mt-3 space-y-2.5">
              {billingComparison.automated.map((t) => (
                <li key={t} className="flex gap-2.5 text-sm text-foreground/90">
                  <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" /> {t}
                </li>
              ))}
            </ul>
            <div className="mt-5 pt-4 border-t border-primary/20">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent mb-2.5">
                The ChamberMaster way
              </p>
              <ul className="space-y-2.5">
                {billingComparison.chamberMaster.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm text-muted-foreground">
                    <XIcon className="h-4 w-4 text-accent/70 shrink-0 mt-0.5" /> {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Rise>
      </div>
    </div>
  );
};
