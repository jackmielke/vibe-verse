import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import MapView, { VILLAGE_LOCATIONS } from "@/components/MapView";
import LocationDetails from "@/components/LocationDetails";
import SplashScreen from "@/components/SplashScreen";
import BottomNav, { type AppTab } from "@/components/BottomNav";
import BrandHeader from "@/components/BrandHeader";
import EventsPanel from "@/components/panels/EventsPanel";
import CommunityPanel from "@/components/panels/CommunityPanel";

const Index = () => {
  const [selectedLocation, setSelectedLocation] = useState<typeof VILLAGE_LOCATIONS[0] | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [tab, setTab] = useState<AppTab>("map");

  if (!splashDone) {
    return <SplashScreen onEnter={() => setSplashDone(true)} />;
  }

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-background">
      {/* Map is always mounted so it stays warm; visibility toggled per tab */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          tab === "map" ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <MapView
          onLocationSelect={setSelectedLocation}
          selectedLocation={selectedLocation}
        />
        <BrandHeader variant="floating" />
        <LocationDetails
          location={selectedLocation}
          onClose={() => setSelectedLocation(null)}
        />
      </div>

      {/* Events */}
      <AnimatePresence mode="wait">
        {tab === "events" && (
          <motion.section
            key="events"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 flex flex-col bg-card pb-[72px]"
          >
            <BrandHeader subtitle="Edge Esmeralda" title="Events" showPostButton />
            <EventsPanel selectedLocation={selectedLocation} />
          </motion.section>
        )}

        {tab === "community" && (
          <motion.section
            key="community"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 flex flex-col bg-card pb-[72px]"
          >
            <BrandHeader subtitle="Edge Esmeralda" title="Community" showPostButton />
            <CommunityPanel />
          </motion.section>
        )}
      </AnimatePresence>

      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
};

export default Index;
