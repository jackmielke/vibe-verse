import { motion, AnimatePresence } from "framer-motion";
import { Clock, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { VILLAGE_LOCATIONS } from "../MapView";
import { supabase } from "@/integrations/supabase/client";

// Real Edge Esmeralda community in Supabase. The previous id was a
// placeholder that returned 0 rows.
const EDGE_ESMERELDA_COMMUNITY_ID = "4202857f-13fd-4407-8906-3f8ffe63e510";

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  event_start_time: string;
  event_end_time: string;
  event_location: string | null;
  hosted_by: string | null;
  current_attendees: number | null;
  max_attendees: number | null;
  tags: string[] | null;
  event_image_url: string | null;
}

interface DisplayEvent {
  id: string;
  title: string;
  location: string;
  time: string;
  duration: string;
  attendees: number;
  maxAttendees: number;
  host: string;
  tag: string;
  isHappeningNow: boolean;
}

const MOCK_EVENTS: DisplayEvent[] = [
  { id: "m1", title: "Morning Breathwork", location: "Meditation Garden", time: "7:00 AM", duration: "45 min", attendees: 12, maxAttendees: 20, host: "Sara K.", tag: "Wellness", isHappeningNow: true },
  { id: "m2", title: "DeFi Governance Workshop", location: "Hacker House", time: "10:00 AM", duration: "2 hrs", attendees: 34, maxAttendees: 50, host: "Vitalik B.", tag: "Tech", isHappeningNow: false },
  { id: "m3", title: "Farm-to-Table Lunch", location: "Dining Hall", time: "12:30 PM", duration: "1.5 hrs", attendees: 80, maxAttendees: 100, host: "Chef Marco", tag: "Food", isHappeningNow: false },
  { id: "m4", title: "Open Mic & Jam Session", location: "Main Stage", time: "7:00 PM", duration: "3 hrs", attendees: 45, maxAttendees: 200, host: "Community", tag: "Social", isHappeningNow: false },
  { id: "m5", title: "Sunset Yoga Flow", location: "The Grove", time: "5:30 PM", duration: "1 hr", attendees: 22, maxAttendees: 30, host: "Anya R.", tag: "Wellness", isHappeningNow: false },
];

const TAG_COLORS: Record<string, string> = {
  Wellness: "bg-purple-500/20 text-purple-300",
  Tech: "bg-blue-500/20 text-blue-300",
  Food: "bg-orange-500/20 text-orange-300",
  Social: "bg-primary/20 text-primary",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const mins = Math.max(0, Math.round((end - start) / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = mins / 60;
  return hrs % 1 === 0 ? `${hrs} hr${hrs > 1 ? "s" : ""}` : `${hrs.toFixed(1)} hrs`;
}

function pickTag(tags: string[] | null): string {
  if (!tags || tags.length === 0) return "Social";
  const t = tags[0].toLowerCase();
  if (t.includes("yoga") || t.includes("wellness") || t.includes("medit")) return "Wellness";
  if (t.includes("tech") || t.includes("code") || t.includes("hack") || t.includes("build")) return "Tech";
  if (t.includes("food") || t.includes("dinner") || t.includes("lunch")) return "Food";
  return "Social";
}

function transform(rows: EventRow[]): DisplayEvent[] {
  const now = Date.now();
  return rows.map((r) => {
    const start = new Date(r.event_start_time).getTime();
    const end = new Date(r.event_end_time).getTime();
    return {
      id: r.id,
      title: r.title,
      location: r.event_location || "TBD",
      time: formatTime(r.event_start_time),
      duration: formatDuration(r.event_start_time, r.event_end_time),
      attendees: r.current_attendees ?? 0,
      maxAttendees: r.max_attendees ?? 100,
      host: r.hosted_by || "Community",
      tag: pickTag(r.tags),
      isHappeningNow: now >= start && now <= end,
    };
  });
}

interface EventsPanelProps {
  selectedLocation?: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function EventsPanel({ selectedLocation }: EventsPanelProps) {
  const [rsvpd, setRsvpd] = useState<Set<string>>(new Set());
  // Mock events stay at the top — they're the curated demo set.
  // Real Supabase events are loaded into a separate state and
  // appended below with their own header.
  const [liveEvents, setLiveEvents] = useState<DisplayEvent[]>([]);
  const [, setLoading] = useState(true);
  const events = MOCK_EVENTS;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("events")
        .select("id, title, description, event_start_time, event_end_time, event_location, hosted_by, current_attendees, max_attendees, tags, event_image_url")
        .eq("community_id", EDGE_ESMERELDA_COMMUNITY_ID)
        .order("event_start_time", { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (!error && data) {
        setLiveEvents(transform(data as EventRow[]));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleRsvp = (eventId: string) => {
    setRsvpd((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const filteredEvents = selectedLocation
    ? events.filter((e) => e.location === selectedLocation.name)
    : events;

  return (
    <div className="flex flex-col h-full">
      <AnimatePresence>
        {selectedLocation && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden px-4"
          >
            <div className="mt-3 flex items-center gap-2 text-xs text-primary bg-primary/10 rounded-lg px-3 py-2">
              <MapPin className="w-3.5 h-3.5" />
              <span className="font-medium">Showing: {selectedLocation.name}</span>
              <span className="text-muted-foreground">· {selectedLocation.people} here</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filteredEvents.some((e) => e.isHappeningNow) && (
          <div className="mb-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              <span className="font-heading text-xs font-semibold text-primary uppercase tracking-wider">
                Happening Now
              </span>
            </div>
          </div>
        )}

        {filteredEvents.map((event, i) => (
          <motion.div
            key={event.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`rounded-xl border p-3.5 transition-all hover:border-primary/30 cursor-pointer ${
              event.isHappeningNow ? "border-primary/40 glow-mint-sm" : "border-border"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-heading text-sm font-semibold text-foreground truncate">
                    {event.title}
                  </h3>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {event.time} · {event.duration}
                  </span>
                  <span className="flex items-center gap-1 truncate">
                    <MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{event.location}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      TAG_COLORS[event.tag] || "bg-muted text-muted-foreground"
                    }`}
                  >
                    {event.tag}
                  </span>
                  <span className="text-[11px] text-muted-foreground">by {event.host}</span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Users className="w-3 h-3" />
                  <span>
                    {event.attendees}/{event.maxAttendees}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRsvp(event.id);
                  }}
                  className={`text-[11px] font-heading font-semibold px-3 py-1.5 rounded-lg transition-all ${
                    rsvpd.has(event.id)
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground hover:bg-primary/20 hover:text-primary"
                  }`}
                >
                  {rsvpd.has(event.id) ? "Going ✓" : "RSVP"}
                </button>
              </div>
            </div>

            <div className="mt-2.5 h-1 bg-muted rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(event.attendees / Math.max(1, event.maxAttendees)) * 100}%` }}
                transition={{ delay: 0.3 + i * 0.1, duration: 0.6 }}
                className="h-full bg-primary rounded-full"
              />
            </div>
          </motion.div>
        ))}

        {filteredEvents.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No events at this location yet
          </div>
        )}

        {!selectedLocation && liveEvents.length > 0 && (
          <div className="pt-4 mt-2 border-t border-border/40 space-y-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              <span className="font-heading text-[11px] font-semibold text-primary uppercase tracking-widest">
                Live · From Edge Esmeralda
              </span>
              <span className="text-[10px] text-muted-foreground">
                · pulled from Supabase
              </span>
            </div>
            {liveEvents.map((event, i) => (
              <motion.div
                key={`live-${event.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className={`rounded-xl border p-3.5 transition-all hover:border-primary/30 cursor-pointer ${
                  event.isHappeningNow ? "border-primary/40 glow-mint-sm" : "border-border/60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-heading text-sm font-semibold text-foreground line-clamp-2">
                      {event.title}
                    </h3>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1 mb-1.5">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {event.time}
                      </span>
                      {event.location && event.location !== "TBD" && (
                        <span className="flex items-center gap-1 truncate">
                          <MapPin className="w-3 h-3 shrink-0" />
                          <span className="truncate">{event.location}</span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          TAG_COLORS[event.tag] || "bg-muted text-muted-foreground"
                        }`}
                      >
                        {event.tag}
                      </span>
                      <span className="text-[11px] text-muted-foreground truncate">
                        by {event.host}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
