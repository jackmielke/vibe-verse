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
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 glass-panel border-t border-border/50 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-stretch justify-around max-w-lg mx-auto">
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              className="relative flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition-colors"
            >
              {isActive && (
                <motion.span
                  layoutId="bottom-nav-indicator"
                  className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-10 bg-primary rounded-full glow-mint-sm"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <Icon
                className={`w-5 h-5 transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground"
                }`}
              />
              <span
                className={`text-[10px] font-heading font-semibold uppercase tracking-wider transition-colors ${
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
