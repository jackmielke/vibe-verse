import { CalendarDays, LayoutDashboard, MessageCircle, Receipt, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { VineMotif } from "./shared";

export type ChamberView = "dashboard" | "directory" | "billing" | "events" | "agent";

export const NAV_ITEMS: { id: ChamberView; label: string; Icon: typeof Users }[] = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "directory", label: "Member Directory", Icon: Users },
  { id: "billing", label: "Billing", Icon: Receipt },
  { id: "events", label: "Events", Icon: CalendarDays },
  { id: "agent", label: "Onboarding Agent", Icon: MessageCircle },
];

interface Props {
  active: ChamberView;
  onSelect: (v: ChamberView) => void;
}

/** Desktop sidebar — brand, vine motif, nav. Collapses to a top icon bar on mobile. */
export const ChamberSidebar = ({ active, onSelect }: Props) => (
  <>
    {/* Desktop sidebar */}
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-card/70">
      <div className="px-6 pt-20 pb-5">
        <p className="ch-serif text-[26px] font-semibold text-primary leading-none">Chamber OS</p>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground mt-2">
          Healdsburg, California
        </p>
        <VineMotif className="w-full h-8 text-primary mt-4" />
      </div>
      <nav className="px-3 space-y-1 flex-1">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className={cn(
              "w-full flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-all",
              active === id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-foreground/70 hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>
      <div className="px-6 py-5 text-[11px] leading-relaxed text-muted-foreground border-t border-border">
        Replaces ChamberMaster.
        <br />
        <span className="text-accent font-semibold">Saves $4,000+/yr.</span>
      </div>
    </aside>

    {/* Mobile top tab bar */}
    <div className="md:hidden sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border pt-14">
      <div className="px-4 pb-2 flex items-baseline gap-2">
        <p className="ch-serif text-xl font-semibold text-primary">Chamber OS</p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Healdsburg</p>
      </div>
      <div className="flex px-2 pb-1 overflow-x-auto">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            aria-label={label}
            className={cn(
              "flex-1 flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-[10px] font-semibold transition-colors min-w-[64px]",
              active === id ? "text-primary bg-primary/10" : "text-muted-foreground",
            )}
          >
            <Icon className="h-4.5 w-4.5" style={{ height: 18, width: 18 }} />
            {label.split(" ")[0]}
          </button>
        ))}
      </div>
    </div>
  </>
);
