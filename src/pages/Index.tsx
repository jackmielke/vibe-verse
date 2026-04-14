import { useState } from "react";
import { motion } from "framer-motion";
import MapView, { VILLAGE_LOCATIONS } from "@/components/MapView";
import EventFeed from "@/components/EventFeed";

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
