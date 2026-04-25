import { useState } from "react";
import { motion } from "framer-motion";
import MapView, { VILLAGE_LOCATIONS } from "@/components/MapView";
import EventFeed from "@/components/EventFeed";
import LocationDetails from "@/components/LocationDetails";
import edgeLogo from "@/assets/edge-esmeralda-logo.png";

const Index = () => {
  const [selectedLocation, setSelectedLocation] = useState<typeof VILLAGE_LOCATIONS[0] | null>(null);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Map - left side */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
        className="flex-1 relative"
      >
        <MapView
          onLocationSelect={setSelectedLocation}
          selectedLocation={selectedLocation}
        />
        <LocationDetails
          location={selectedLocation}
          onClose={() => setSelectedLocation(null)}
        />

        {/* Floating Edge Esmeralda brand badge */}
        <motion.div
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="absolute top-5 left-5 z-10 flex items-center gap-3 glass-panel rounded-2xl pl-2 pr-4 py-2 glow-mint-sm pointer-events-none select-none"
        >
          <img
            src={edgeLogo}
            alt="Edge Esmeralda floating village"
            className="h-12 w-12 object-contain drop-shadow-[0_0_12px_hsl(var(--mint-glow)/0.6)]"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Pop-up Village
            </span>
            <span className="font-display text-base font-semibold text-gradient-mint" style={{ fontFamily: "'Sora', sans-serif" }}>
              Edge Esmeralda
            </span>
          </div>
        </motion.div>
      </motion.div>

      {/* Event feed - right side */}
      <motion.div
        initial={{ x: 100, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="w-[380px] border-l border-border flex-shrink-0"
      >
        <EventFeed selectedLocation={selectedLocation} />
      </motion.div>
    </div>
  );
};

export default Index;
