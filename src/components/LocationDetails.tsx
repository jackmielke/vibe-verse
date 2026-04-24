import { motion, AnimatePresence } from "framer-motion";
import { X, Users, MapPin, Clock, Zap, Navigation2 } from "lucide-react";
import { VILLAGE_LOCATIONS } from "./MapView";

const TYPE_LABELS: Record<string, string> = {
  venue: "Venue",
  workspace: "Workspace",
  social: "Social Hub",
  food: "Food & Drink",
  wellness: "Wellness",
};

const TYPE_GLOW: Record<string, string> = {
  venue: "from-primary/30",
  workspace: "from-sky-400/30",
  social: "from-amber-400/30",
  food: "from-orange-500/30",
  wellness: "from-violet-400/30",
};

// Mock activity per location (would come from API)
const MOCK_ACTIVITY: Record<number, { title: string; time: string; host: string; emoji: string }[]> = {
  1: [
    { title: "Open Mic & Jam Session", time: "7:00 PM", host: "Community", emoji: "🎵" },
    { title: "Lightning Talks", time: "9:30 PM", host: "Edge Crew", emoji: "⚡" },
  ],
  2: [
    { title: "DeFi Governance Workshop", time: "10:00 AM", host: "Vitalik B.", emoji: "🔐" },
    { title: "Pair Programming Hour", time: "3:00 PM", host: "Open", emoji: "💻" },
  ],
  3: [
    { title: "Sunset Yoga Flow", time: "5:30 PM", host: "Anya R.", emoji: "🌅" },
    { title: "Hike to the Ridge", time: "Now", host: "Jake M.", emoji: "🥾" },
  ],
  4: [
    { title: "Farm-to-Table Lunch", time: "12:30 PM", host: "Chef Marco", emoji: "🥗" },
    { title: "Wine Tasting", time: "6:00 PM", host: "Healdsburg Cellars", emoji: "🍷" },
  ],
  5: [
    { title: "Morning Breathwork", time: "7:00 AM", host: "Sara K.", emoji: "🧘" },
    { title: "Sound Bath", time: "8:00 PM", host: "Ravi M.", emoji: "🔔" },
  ],
  6: [
    { title: "AI Hack Session", time: "All day", host: "Drop in", emoji: "🤖" },
    { title: "Founder Office Hours", time: "2:00 PM", host: "Various", emoji: "💡" },
  ],
  7: [
    { title: "Pool Party", time: "4:00 PM", host: "Community", emoji: "🏊" },
    { title: "Stargazing", time: "10:00 PM", host: "Leo C.", emoji: "🔭" },
  ],
  8: [
    { title: "Live Painting", time: "Ongoing", host: "Maya L.", emoji: "🎨" },
    { title: "Print Workshop", time: "1:00 PM", host: "Studio Crew", emoji: "🖼️" },
  ],
};

interface Props {
  location: typeof VILLAGE_LOCATIONS[0] | null;
  onClose: () => void;
}

export default function LocationDetails({ location, onClose }: Props) {
  return (
    <AnimatePresence>
      {location && (
        <>
          {/* Backdrop — only on mobile, doesn't block map */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 z-30 bg-background/40 backdrop-blur-[2px] md:hidden"
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ type: "spring", damping: 24, stiffness: 280 }}
            className="absolute z-40 left-4 right-4 bottom-6 md:left-auto md:right-6 md:top-1/2 md:bottom-auto md:-translate-y-1/2 md:w-[340px]"
          >
            <div className="glass-panel rounded-2xl overflow-hidden border border-border/60 shadow-2xl relative">
              {/* Glow */}
              <div className={`absolute -top-20 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full blur-3xl bg-gradient-to-b ${TYPE_GLOW[location.type] || "from-primary/30"} to-transparent pointer-events-none`} />

              {/* Header */}
              <div className="relative p-5 pb-3">
                <button
                  onClick={onClose}
                  className="absolute top-3 right-3 w-7 h-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center transition-colors"
                >
                  <X className="w-3.5 h-3.5 text-muted-foreground" />
                </button>

                <div className="flex items-start gap-3">
                  <div className="text-4xl">{location.emoji}</div>
                  <div className="flex-1 min-w-0 pr-7">
                    <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                      {TYPE_LABELS[location.type] || location.type}
                    </p>
                    <h2 className="font-heading text-lg font-bold text-foreground leading-tight mt-0.5">
                      {location.name}
                    </h2>
                  </div>
                </div>

                {/* Live stats */}
                <div className="flex items-center gap-3 mt-4">
                  <div className="flex items-center gap-1.5 bg-primary/10 text-primary rounded-full px-2.5 py-1">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                    </span>
                    <span className="text-[11px] font-body font-semibold">Live</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Users className="w-3.5 h-3.5" />
                    <span className="text-xs font-body font-medium text-foreground">{location.people} here now</span>
                  </div>
                </div>
              </div>

              {/* Activity */}
              <div className="relative px-5 py-3 border-t border-border/50">
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-2">
                  Today's Activity
                </p>
                <div className="space-y-2">
                  {(MOCK_ACTIVITY[location.id] || []).map((item, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 + i * 0.06 }}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer"
                    >
                      <span className="text-lg flex-shrink-0">{item.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-heading text-xs font-semibold text-foreground truncate">{item.title}</p>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                          <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{item.time}</span>
                          <span>·</span>
                          <span>by {item.host}</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="relative p-4 pt-2 flex gap-2">
                <button className="flex-1 bg-primary text-primary-foreground font-heading text-xs font-semibold py-2.5 rounded-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  I'm Going
                </button>
                <button className="bg-muted text-foreground font-heading text-xs font-semibold px-3 py-2.5 rounded-lg hover:bg-muted/70 transition-colors flex items-center gap-1.5">
                  <Navigation2 className="w-3.5 h-3.5" />
                  Directions
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
