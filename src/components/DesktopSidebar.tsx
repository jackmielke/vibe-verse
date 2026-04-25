import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Calendar, MessageSquare, Plus } from "lucide-react";
import EventsPanel from "@/components/panels/EventsPanel";
import CommunityPanel from "@/components/panels/CommunityPanel";
import BrandHeader from "@/components/BrandHeader";
import type { VILLAGE_LOCATIONS } from "@/components/MapView";

type SidebarTab = "events" | "community";

interface DesktopSidebarProps {
  selectedLocation: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function DesktopSidebar({ selectedLocation }: DesktopSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>("events");

  return (
    <aside className="w-[380px] flex-shrink-0 border-l border-border bg-card flex flex-col h-full">
      <BrandHeader />

      {/* Tabs */}
      <div className="px-4 pt-3">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {(
            [
              { id: "events", label: "Events", Icon: Calendar },
              { id: "community", label: "Community", Icon: MessageSquare },
            ] as { id: SidebarTab; label: string; Icon: typeof Calendar }[]
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 text-xs font-heading font-semibold py-2 rounded-md transition-all ${
                tab === id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
                <Icon className="w-3.5 h-3.5" />
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Post button */}
      <div className="px-4 pt-3">
        <button className="w-full flex items-center justify-center gap-1.5 bg-primary text-primary-foreground font-heading text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 transition-opacity">
          <Plus className="w-3.5 h-3.5" />
          New Post
        </button>
      </div>

      <div className="flex-1 min-h-0 mt-1">
        <AnimatePresence mode="wait">
          {tab === "events" ? (
            <motion.div
              key="events"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <EventsPanel selectedLocation={selectedLocation} />
            </motion.div>
          ) : (
            <motion.div
              key="community"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <CommunityPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}
