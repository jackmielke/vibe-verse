import { Map as MapIcon, Calendar, MessageSquare } from "lucide-react";
import { motion } from "framer-motion";

export type AppTab = "map" | "events" | "community";

interface BottomNavProps {
  active: AppTab;
  onChange: (tab: AppTab) => void;
}

const TABS: { id: AppTab; label: string; Icon: typeof MapIcon }[] = [
  { id: "map", label: "Map", Icon: MapIcon },
  { id: "events", label: "Events", Icon: Calendar },
  { id: "community", label: "Community", Icon: MessageSquare },
];

export default function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-card/95 backdrop-blur-xl border-t border-border/60 pb-[env(safe-area-inset-bottom)]">
      <div className="grid grid-cols-3 max-w-lg mx-auto">
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              className="relative flex flex-col items-center justify-center gap-1 py-2.5"
              aria-label={label}
            >
              <span className="relative flex flex-col items-center gap-0.5">
                {isActive && (
                  <motion.span
                    layoutId="bottom-nav-pill"
                    className="absolute -inset-x-3 -inset-y-1 rounded-full bg-primary/12"
                    transition={{ type: "spring", stiffness: 500, damping: 36 }}
                  />
                )}
                <Icon
                  className={`relative w-[22px] h-[22px] transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground"
                  }`}
                  strokeWidth={isActive ? 2.4 : 2}
                />
              </span>
              <span
                className={`text-[10px] font-heading font-semibold uppercase tracking-[0.12em] transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
