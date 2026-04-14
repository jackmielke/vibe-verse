import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, Zap } from "lucide-react";

// Mock village locations
const VILLAGE_LOCATIONS = [
  { id: 1, name: "Main Stage", lat: 38.6127, lng: -122.8697, type: "venue", people: 42, emoji: "🎤" },
  { id: 2, name: "Hacker House", lat: 38.6135, lng: -122.8680, type: "workspace", people: 18, emoji: "💻" },
  { id: 3, name: "The Grove", lat: 38.6120, lng: -122.8710, type: "social", people: 27, emoji: "🌳" },
  { id: 4, name: "Dining Hall", lat: 38.6140, lng: -122.8700, type: "food", people: 55, emoji: "🍽️" },
  { id: 5, name: "Meditation Garden", lat: 38.6115, lng: -122.8690, type: "wellness", people: 8, emoji: "🧘" },
  { id: 6, name: "Co-working Barn", lat: 38.6130, lng: -122.8715, type: "workspace", people: 31, emoji: "🏠" },
  { id: 7, name: "Pool Deck", lat: 38.6145, lng: -122.8685, type: "social", people: 15, emoji: "🏊" },
  { id: 8, name: "Art Studio", lat: 38.6118, lng: -122.8675, type: "venue", people: 12, emoji: "🎨" },
];

const TYPE_COLORS: Record<string, string> = {
  venue: "hsl(160, 80%, 50%)",
  workspace: "hsl(200, 80%, 50%)",
  social: "hsl(40, 90%, 60%)",
  food: "hsl(20, 90%, 55%)",
  wellness: "hsl(280, 60%, 60%)",
};

interface MapViewProps {
  onLocationSelect: (location: typeof VILLAGE_LOCATIONS[0] | null) => void;
  selectedLocation: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function MapView({ onLocationSelect, selectedLocation }: MapViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  // Simulated map view using a styled canvas with positioned markers
  // In production, this would be Mapbox GL JS with custom tiles
  return (
    <div ref={canvasRef} className="relative h-full w-full overflow-hidden bg-navy-deep">
      {/* Stylized background grid */}
      <div className="absolute inset-0" style={{
        backgroundImage: `
          radial-gradient(circle at 30% 40%, hsl(150, 40%, 18%, 0.4) 0%, transparent 50%),
          radial-gradient(circle at 70% 60%, hsl(160, 80%, 50%, 0.08) 0%, transparent 40%),
          linear-gradient(hsl(160, 20%, 20%, 0.15) 1px, transparent 1px),
          linear-gradient(90deg, hsl(160, 20%, 20%, 0.15) 1px, transparent 1px)
        `,
        backgroundSize: '100% 100%, 100% 100%, 40px 40px, 40px 40px',
      }} />

      {/* Topographic decoration lines */}
      <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M10,50 Q30,20 50,45 T90,40" fill="none" stroke="hsl(160,80%,50%)" strokeWidth="0.3" />
        <path d="M5,60 Q25,35 55,55 T95,50" fill="none" stroke="hsl(160,80%,50%)" strokeWidth="0.2" />
        <path d="M15,70 Q35,45 60,65 T85,60" fill="none" stroke="hsl(160,80%,50%)" strokeWidth="0.2" />
      </svg>

      {/* Village area label */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="absolute top-6 left-6 z-10"
      >
        <div className="glass-panel rounded-xl px-4 py-2">
          <p className="font-heading text-xs font-semibold tracking-widest uppercase text-primary">
            Edge Esmeralda Village
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Healdsburg, CA · Live</p>
        </div>
      </motion.div>

      {/* Live indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="absolute top-6 right-6 z-10"
      >
        <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="text-xs font-body font-medium text-foreground">208 here now</span>
        </div>
      </motion.div>

      {/* Location markers */}
      {VILLAGE_LOCATIONS.map((loc, i) => {
        const x = 15 + ((loc.lng + 122.872) / 0.005) * 70;
        const y = 15 + ((38.615 - loc.lat) / 0.004) * 70;
        const isSelected = selectedLocation?.id === loc.id;
        const isHovered = hoveredId === loc.id;
        const color = TYPE_COLORS[loc.type];

        return (
          <motion.div
            key={loc.id}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3 + i * 0.1, type: "spring", stiffness: 200 }}
            className="absolute z-20 cursor-pointer"
            style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
            onClick={() => onLocationSelect(isSelected ? null : loc)}
            onMouseEnter={() => setHoveredId(loc.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {/* Pulse ring for busy locations */}
            {loc.people > 20 && (
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{ background: `${color}33` }}
                animate={{ scale: [1, 2.5], opacity: [0.6, 0] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            )}

            {/* Marker dot */}
            <motion.div
              animate={{
                scale: isSelected ? 1.3 : isHovered ? 1.15 : 1,
                boxShadow: isSelected
                  ? `0 0 20px ${color}88, 0 0 40px ${color}44`
                  : isHovered
                    ? `0 0 12px ${color}66`
                    : `0 0 6px ${color}33`,
              }}
              className="relative flex items-center justify-center w-10 h-10 rounded-full border-2"
              style={{
                borderColor: color,
                background: `${color}22`,
              }}
            >
              <span className="text-lg">{loc.emoji}</span>
            </motion.div>

            {/* Label tooltip */}
            <AnimatePresence>
              {(isHovered || isSelected) && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 5 }}
                  className="absolute top-full mt-2 left-1/2 -translate-x-1/2 whitespace-nowrap glass-panel rounded-lg px-3 py-1.5"
                >
                  <p className="font-heading text-xs font-semibold text-foreground">{loc.name}</p>
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5 text-primary" />
                    {loc.people} people
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}

      {/* User location indicator */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 1.2, type: "spring" }}
        className="absolute z-30"
        style={{ left: '45%', top: '55%', transform: 'translate(-50%, -50%)' }}
      >
        <div className="relative">
          <motion.div
            className="absolute inset-0 rounded-full bg-primary"
            animate={{ scale: [1, 3], opacity: [0.4, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <div className="relative w-4 h-4 rounded-full bg-primary border-2 border-foreground glow-mint" />
        </div>
      </motion.div>

      {/* Bottom controls */}
      <div className="absolute bottom-6 left-6 z-10 flex gap-2">
        <button className="glass-panel rounded-lg p-2.5 hover:bg-muted transition-colors">
          <Navigation className="w-4 h-4 text-primary" />
        </button>
        <button className="glass-panel rounded-lg p-2.5 hover:bg-muted transition-colors">
          <MapPin className="w-4 h-4 text-primary" />
        </button>
      </div>
    </div>
  );
}

export { VILLAGE_LOCATIONS };
export type { MapViewProps };
