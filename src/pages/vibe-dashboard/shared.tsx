/**
 * vibe-dashboard/shared — tiny presentational pieces used across the
 * dashboard cards: the glass card shell, the "static data" marker, and
 * number/time formatters. Keeping these here keeps every card file
 * focused on its one chart.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { STATIC_AS_OF } from "./data";

/** Glass panel with the standard dashboard header row. */
export function DashCard({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <h2 className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary flex-1">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * The honesty badge. Every number that is NOT coming from a live
 * source wears one of these so a snapshot can never impersonate a feed.
 */
export function StaticMarker({ label = STATIC_AS_OF }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[9px] font-medium text-amber-300/90 whitespace-nowrap"
      title="Static value from Jack's notes — replace with a live source"
    >
      <span aria-hidden className="inline-block w-1 h-1 rounded-full bg-amber-400" />
      {label}
    </span>
  );
}

/** Mint pill for values that really are live right now. */
export function LiveMarker({ label = "live" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-medium text-emerald-300/90 whitespace-nowrap">
      <span
        aria-hidden
        className="inline-block w-1 h-1 rounded-full bg-emerald-400"
        style={{ boxShadow: "0 0 6px hsl(150 80% 60% / 0.8)" }}
      />
      {label}
    </span>
  );
}

export function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

export function fmtVibeAmount(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
