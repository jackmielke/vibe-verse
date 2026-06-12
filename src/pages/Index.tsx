import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, ChevronLeft } from "lucide-react";
import MapView, { VILLAGE_LOCATIONS } from "@/components/MapView";
import LocationDetails from "@/components/LocationDetails";
import SplashScreen from "@/components/SplashScreen";
import WorldPicker from "@/components/WorldPicker";
import BottomNav, { type AppTab } from "@/components/BottomNav";
import BrandHeader from "@/components/BrandHeader";
import EventsPanel from "@/components/panels/EventsPanel";
import CommunityPanel from "@/components/panels/CommunityPanel";
import DesktopSidebar from "@/components/DesktopSidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import LocationSharePill from "@/components/LocationSharePill";

const Index = () => {
  const [selectedLocation, setSelectedLocation] = useState<typeof VILLAGE_LOCATIONS[0] | null>(null);
  // Splash + world picker each run once per browser session — coming
  // back to the village later in the session is a single click.
  const [splashDone, setSplashDone] = useState(
    () => sessionStorage.getItem("ee.splashSeen") === "1",
  );
  const [worldChosen, setWorldChosen] = useState(
    () => sessionStorage.getItem("ee.worldChosen") === "1",
  );
  const closePicker = () => {
    sessionStorage.setItem("ee.worldChosen", "1");
    setWorldChosen(true);
  };
  const [tab, setTab] = useState<AppTab>("map");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useIsMobile();

  // When the desktop sidebar toggles, the map container resizes. Mapbox
  // doesn't observe container resize on its own, but it does listen for
  // the global window resize event, so we kick that off after the layout
  // has settled.
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 320);
    return () => clearTimeout(t);
  }, [sidebarOpen]);

  if (!splashDone) {
    return (
      <SplashScreen
        onEnter={() => {
          sessionStorage.setItem("ee.splashSeen", "1");
          setSplashDone(true);
        }}
      />
    );
  }

  // ---------- Desktop: map + sidebar with Events/Community tabs ----------
  if (!isMobile) {
    return (
      <div className="flex h-[100dvh] w-screen overflow-hidden bg-background">
        <WorldPicker open={!worldChosen} onClose={closePicker} />
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
          {/* Snap-Map-style location share — opt-in pill for signed-in
              members. Sits above the chat-toggle / bottom controls. */}
          <LocationSharePill />
          <LocationDetails
            location={selectedLocation}
            onClose={() => setSelectedLocation(null)}
          />

          {/* Collapsed-sidebar tab — slides in from the right when the
              sidebar is hidden so the user has a way to bring it back. */}
          <AnimatePresence>
            {!sidebarOpen && (
              <motion.button
                key="sidebar-tab"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.18 }}
                onClick={() => setSidebarOpen(true)}
                className="absolute top-1/2 right-0 -translate-y-1/2 z-30 glass-panel h-16 w-7 rounded-l-lg rounded-r-none flex items-center justify-center hover:bg-muted transition-colors"
                title="Show panel"
              >
                <ChevronLeft className="w-4 h-4 text-muted-foreground" />
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>

        {sidebarOpen && (
          <motion.div
            key="sidebar"
            initial={{ x: 100, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ duration: 0.25 }}
            className="h-full flex relative"
          >
            <button
              onClick={() => setSidebarOpen(false)}
              className="self-stretch px-1 hover:bg-muted/40 transition-colors flex items-center justify-center border-l border-border/40"
              title="Hide panel"
            >
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </button>
            <DesktopSidebar selectedLocation={selectedLocation} />
          </motion.div>
        )}
      </div>
    );
  }

  // ---------- Mobile: full-screen tab apps + bottom nav ----------
  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-background">
      <WorldPicker open={!worldChosen} onClose={closePicker} />
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
        {/* Same Snap-Map pill on the mobile path. */}
        <LocationSharePill />
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
