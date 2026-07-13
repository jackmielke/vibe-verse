import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { janeColor, status } from "../theme";

/** Gentle fade/rise-in wrapper used across views. */
export const Rise = ({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) => (
  <motion.div
    initial={{ opacity: 0, y: 14 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
    className={className}
  >
    {children}
  </motion.div>
);

export const SectionHeading = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div className="mb-6">
    <h1 className="ch-serif text-3xl md:text-4xl font-semibold text-foreground tracking-tight">{title}</h1>
    {subtitle && <p className="mt-1.5 text-sm text-muted-foreground max-w-2xl">{subtitle}</p>}
  </div>
);

export const StatTile = ({
  label, value, hint, tone = "default",
}: { label: string; value: string; hint?: string; tone?: "default" | "green" | "wine" }) => (
  <div className="rounded-xl bg-card border border-border shadow-sm p-5 transition-shadow hover:shadow-md">
    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    <p
      className={cn(
        "ch-serif mt-2 text-3xl md:text-[34px] leading-none font-semibold tabular-nums",
        tone === "green" && "text-primary",
        tone === "wine" && "text-accent",
        tone === "default" && "text-foreground",
      )}
    >
      {value}
    </p>
    {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
  </div>
);

export const StatusPill = ({ kind }: { kind: "current" | "overdue" | "lapsed" | "paid" | "sent" }) => {
  const map = {
    current: status.good, paid: { ...status.good, label: "Paid" },
    overdue: status.warn, sent: { dot: "#3B7DC4", bg: "#E2ECF6", text: "#2A5B8F", label: "Sent" },
    lapsed: status.bad,
  } as const;
  const s = map[kind];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ backgroundColor: s.bg, color: s.text }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {s.label}
    </span>
  );
};

/** Jane Score — small colored meter + number, named after Jane Jacobs. */
export const JaneMeter = ({ score, className }: { score: number; className?: string }) => (
  <div className={cn("flex items-center gap-2", className)}>
    <div className="h-1.5 w-16 rounded-full bg-secondary overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${score}%`, backgroundColor: janeColor(score) }}
      />
    </div>
    <span className="text-xs font-semibold tabular-nums text-foreground">{score}</span>
  </div>
);

/** Rolling-hills-and-vine motif for the header — quiet wine-country soul. */
export const VineMotif = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 120 32" fill="none" aria-hidden className={className}>
    <path d="M0 28 Q 22 10 44 24 T 88 22 T 120 26 V32 H0 Z" fill="currentColor" opacity="0.16" />
    <path d="M0 30 Q 30 18 60 27 T 120 28 V32 H0 Z" fill="currentColor" opacity="0.28" />
    <circle cx="97" cy="9" r="2.4" fill="currentColor" opacity="0.75" />
    <circle cx="102" cy="12" r="2.4" fill="currentColor" opacity="0.6" />
    <circle cx="99.5" cy="14.5" r="2.4" fill="currentColor" opacity="0.45" />
    <path d="M97 7 Q 99 2 104 3" stroke="currentColor" strokeWidth="1.1" opacity="0.6" />
  </svg>
);
