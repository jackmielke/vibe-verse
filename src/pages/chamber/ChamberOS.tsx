import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { BillingView } from "./components/BillingView";
import { ChamberSidebar, type ChamberView } from "./components/ChamberSidebar";
import { DashboardView } from "./components/DashboardView";
import { DirectoryView } from "./components/DirectoryView";
import { EventsView } from "./components/EventsView";
import { OnboardingView } from "./components/OnboardingView";
import { chamberThemeVars } from "./theme";

const VIEWS: Record<ChamberView, () => JSX.Element> = {
  dashboard: DashboardView,
  directory: DirectoryView,
  billing: BillingView,
  events: EventsView,
  agent: OnboardingView,
};

/**
 * Chamber OS — a clickable demo of an AI-native replacement for ChamberMaster,
 * built around the real Healdsburg business-license dataset. All data is mock,
 * in-memory, and scoped to this page; the warm wine-country theme overrides the
 * global VibeVerse dark tokens via CSS variables on the page root.
 */
export const ChamberOS = () => {
  const [view, setView] = useState<ChamberView>("dashboard");
  const ActiveView = VIEWS[view];

  return (
    <div
      className="chamber-root min-h-screen bg-background text-foreground font-body flex flex-col md:flex-row"
      style={chamberThemeVars}
    >
      <style>{`
        .chamber-root .ch-serif {
          font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
          letter-spacing: -0.01em;
        }
        .chamber-root ::selection { background: hsl(152 34% 24% / 0.18); }
      `}</style>

      <ChamberSidebar active={view} onSelect={setView} />

      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 px-5 md:px-10 pt-6 md:pt-20 pb-10 max-w-6xl w-full mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <ActiveView />
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="border-t border-border px-5 md:px-10 py-4">
          <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
            Chamber OS — a demo by OS Builders · built with the Healdsburg business dataset · not affiliated with the
            Healdsburg Chamber of Commerce (yet 😉)
          </p>
        </footer>
      </div>
    </div>
  );
};
