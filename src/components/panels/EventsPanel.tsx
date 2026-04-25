import { motion, AnimatePresence } from "framer-motion";
import { Clock, MapPin, Users } from "lucide-react";
import { useState } from "react";
import { VILLAGE_LOCATIONS } from "../MapView";

const MOCK_EVENTS = [
  {
    id: 1,
    title: "Morning Breathwork",
    location: "Meditation Garden",
    time: "7:00 AM",
    duration: "45 min",
    attendees: 12,
    maxAttendees: 20,
    host: "Sara K.",
    emoji: "🧘",
    tag: "Wellness",
    isHappeningNow: true,
  },
  {
    id: 2,
    title: "DeFi Governance Workshop",
    location: "Hacker House",
    time: "10:00 AM",
    duration: "2 hrs",
    attendees: 34,
    maxAttendees: 50,
    host: "Vitalik B.",
    emoji: "⚡",
    tag: "Tech",
    isHappeningNow: false,
  },
  {
    id: 3,
    title: "Farm-to-Table Lunch",
    location: "Dining Hall",
    time: "12:30 PM",
    duration: "1.5 hrs",
    attendees: 80,
    maxAttendees: 100,
    host: "Chef Marco",
    emoji: "🥗",
    tag: "Food",
    isHappeningNow: false,
  },
  {
    id: 4,
    title: "Open Mic & Jam Session",
    location: "Main Stage",
    time: "7:00 PM",
    duration: "3 hrs",
    attendees: 45,
    maxAttendees: 200,
    host: "Community",
    emoji: "🎵",
    tag: "Social",
    isHappeningNow: false,
  },
  {
    id: 5,
    title: "Sunset Yoga Flow",
    location: "The Grove",
    time: "5:30 PM",
    duration: "1 hr",
    attendees: 22,
    maxAttendees: 30,
    host: "Anya R.",
    emoji: "🌅",
    tag: "Wellness",
    isHappeningNow: false,
  },
];

const TAG_COLORS: Record<string, string> = {
  Wellness: "bg-purple-500/20 text-purple-300",
  Tech: "bg-blue-500/20 text-blue-300",
  Food: "bg-orange-500/20 text-orange-300",
  Social: "bg-primary/20 text-primary",
};

interface EventsPanelProps {
  selectedLocation?: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function EventsPanel({ selectedLocation }: EventsPanelProps) {
  const [rsvpd, setRsvpd] = useState<Set<number>>(new Set());

  const toggleRsvp = (eventId: number) => {
    setRsvpd(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const filteredEvents = selectedLocation
    ? MOCK_EVENTS.filter(e => e.location === selectedLocation.name)
    : MOCK_EVENTS;

  return (
    <div className="flex flex-col h-full">
      {/* Selected location filter */}
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
        {filteredEvents.some(e => e.isHappeningNow) && (
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
                  <span className="text-base">{event.emoji}</span>
                  <h3 className="font-heading text-sm font-semibold text-foreground truncate">
                    {event.title}
                  </h3>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {event.time} · {event.duration}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> {event.location}
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
                animate={{ width: `${(event.attendees / event.maxAttendees) * 100}%` }}
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
      </div>
    </div>
  );
}
