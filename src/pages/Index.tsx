import { useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import MapView, { VILLAGE_LOCATIONS } from "@/components/MapView";
import LocationDetails from "@/components/LocationDetails";
import SplashScreen from "@/components/SplashScreen";
import BottomNav, { type AppTab } from "@/components/BottomNav";
import BrandHeader from "@/components/BrandHeader";
import EventsPanel from "@/components/panels/EventsPanel";
import CommunityPanel from "@/components/panels/CommunityPanel";
import DesktopSidebar from "@/components/DesktopSidebar";
import { useIsMobile } from "@/hooks/use-mobile";

const Index = () => {
  const [selectedLocation, setSelectedLocation] = useState<typeof VILLAGE_LOCATIONS[0] | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [tab, setTab] = useState<AppTab>("map");
  const isMobile = useIsMobile();

  if (!splashDone) {
    return <SplashScreen onEnter={() => setSplashDone(true)} />;
  }

  // ---------- Desktop: map + sidebar with Events/Community tabs ----------
  if (!isMobile) {
    return (
      <div className="flex h-[100dvh] w-screen overflow-hidden bg-background">
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
          <BrandHeader variant="floating" />
          <Link
            to="/island"
            className="absolute top-4 right-4 z-20 rounded-full bg-emerald-600/90 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-md transition hover:bg-emerald-500"
          >
            🏝️ Visit the island
          </Link>
          <LocationDetails
            location={selectedLocation}
            onClose={() => setSelectedLocation(null)}
          />
        </motion.div>

        <motion.div
          initial={{ x: 100, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="h-full"
        >
          <DesktopSidebar selectedLocation={selectedLocation} />
        </motion.div>
      </div>
    );
  }

  // ---------- Mobile: full-screen tab apps + bottom nav ----------
  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-background">
      {/* Map stays mounted so switching back is instant */}
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
