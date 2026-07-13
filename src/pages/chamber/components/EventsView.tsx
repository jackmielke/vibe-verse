import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, MapPin, Ticket, Users } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { chamberEvents, JULY_2026 } from "../data/events";
import type { ChamberEvent } from "../data/types";
import { money } from "../theme";
import { Rise, SectionHeading } from "./shared";

const eventDay = (e: ChamberEvent) => Number(e.date.slice(-2));

const EventCard = ({ ev, open, onToggle }: { ev: ChamberEvent; open: boolean; onToggle: () => void }) => (
  <button
    onClick={onToggle}
    className={cn(
      "w-full text-left rounded-xl border bg-card shadow-sm p-5 transition-all hover:shadow-md",
      open ? "border-primary/40 ring-1 ring-primary/20" : "border-border",
    )}
  >
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
          {JULY_2026.label.split(" ")[0]} {eventDay(ev)} · {ev.time}
        </p>
        <h3 className="ch-serif text-lg font-semibold text-foreground mt-1">{ev.title}</h3>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
          <MapPin className="h-3 w-3" /> {ev.venue}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold text-foreground tabular-nums flex items-center gap-1.5 justify-end">
          <Users className="h-3.5 w-3.5 text-primary" /> {ev.registered}/{ev.capacity}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{ev.ticketPrice ? `${money(ev.ticketPrice)} ticket` : "Free"}</p>
      </div>
    </div>
    <div className="mt-3 h-1.5 rounded-full bg-secondary overflow-hidden">
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${(ev.registered / ev.capacity) * 100}%` }} />
    </div>
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}
          className="overflow-hidden"
        >
          <p className="text-sm text-muted-foreground mt-4 leading-relaxed">{ev.blurb}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {ev.registrants.map((r) => (
              <span key={r} className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground/80">{r}</span>
            ))}
            <span className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground">+{ev.registered - ev.registrants.length} more</span>
          </div>
          {ev.ticketPrice && (
            <p className="mt-3 text-sm flex items-center gap-1.5 text-foreground/90">
              <Ticket className="h-3.5 w-3.5 text-primary" />
              Ticket revenue: <span className="font-semibold tabular-nums">{money(ev.registered * ev.ticketPrice)}</span>
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  </button>
);

export const EventsView = () => {
  const [openId, setOpenId] = useState<string | null>(null);
  const eventDays = new Set(chamberEvents.map(eventDay));
  const sorted = [...chamberEvents].sort((a, b) => a.date.localeCompare(b.date));
  const cells: (number | null)[] = [
    ...Array.from({ length: JULY_2026.firstWeekday }, () => null),
    ...Array.from({ length: JULY_2026.days }, (_, i) => i + 1),
  ];

  return (
    <div>
      <SectionHeading
        title="Events"
        subtitle="Mixers, ribbon cuttings, and board meetings — registration, capacity, and revenue in one place."
      />
      <div className="grid lg:grid-cols-3 gap-4">
        <Rise className="lg:col-span-2 space-y-4">
          {sorted.map((ev) => (
            <EventCard key={ev.id} ev={ev} open={openId === ev.id} onToggle={() => setOpenId(openId === ev.id ? null : ev.id)} />
          ))}
        </Rise>

        {/* Month calendar */}
        <Rise delay={0.1}>
          <div className="rounded-xl border border-border bg-card shadow-sm p-5">
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" /> {JULY_2026.label}
            </h3>
            <div className="grid grid-cols-7 gap-1 mt-4 text-center">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <span key={i} className="text-[10px] font-semibold text-muted-foreground py-1">{d}</span>
              ))}
              {cells.map((day, i) => (
                <span
                  key={i}
                  className={cn(
                    "aspect-square flex items-center justify-center rounded-lg text-xs tabular-nums",
                    day === null && "invisible",
                    day !== null && eventDays.has(day)
                      ? "bg-primary text-primary-foreground font-semibold shadow-sm"
                      : day === JULY_2026.today
                        ? "ring-1 ring-accent text-accent font-semibold"
                        : "text-foreground/70",
                  )}
                >
                  {day ?? ""}
                </span>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-primary" /> Event day</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded ring-1 ring-accent" /> Today</span>
            </div>
          </div>
        </Rise>
      </div>
    </div>
  );
};
