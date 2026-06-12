/**
 * WorldPicker — the "choose your world" gateway.
 *
 * Shows once after the splash on the village page: a grid of preview
 * cards, one per world, each a real in-game screenshot. Picking the
 * Village simply dismisses the overlay (the map is already loading
 * underneath); any other card routes straight to that world.
 *
 * Preview images live in src/assets/worlds/ — re-capture them when a
 * world changes enough that its card feels stale.
 */
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import villageArt from "@/assets/edge-app-icon-bg.png";
import cityArt from "@/assets/worlds/city.jpg";
import spaceArt from "@/assets/worlds/space.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import gardenArt from "@/assets/worlds/garden.jpg";
import museumArt from "@/assets/worlds/museum.jpg";

interface WorldCard {
  to: string | null; // null = stay here (the village)
  emoji: string;
  name: string;
  art: string;
  blurb: string;
}

const WORLDS: WorldCard[] = [
  {
    to: null,
    emoji: "🗺️",
    name: "Village",
    art: villageArt,
    blurb: "The real Healdsburg map — Vibey, Unit-7, choppers, and spawnable worlds.",
  },
  {
    to: "/city",
    emoji: "🏙️",
    name: "Vibe City",
    art: cityArt,
    blurb: "Jetpack a neon district, ride the zipline around Cardboard Island. Multiplayer.",
  },
  {
    to: "/space",
    emoji: "🌌",
    name: "Space",
    art: spaceArt,
    blurb: "Vibey 2.0's late-night show on a floating asteroid, with the alien next door.",
  },
  {
    to: "/lobby",
    emoji: "🏎️",
    name: "Lobby",
    art: lobbyArt,
    blurb: "Pick your character and vehicle, Mario-Kart style. ~60 to choose from.",
  },
  {
    to: "/garden",
    emoji: "🌱",
    name: "Garden",
    art: gardenArt,
    blurb: "Vibey's memory garden — walk among planted memories and the art fair.",
  },
  {
    to: "/museum",
    emoji: "🖼️",
    name: "Museum",
    art: museumArt,
    blurb: "A walkable, Seuss-flavored gallery of famous fractals.",
  },
];

export default function WorldPicker({
  open,
  onStay,
}: {
  open: boolean;
  onStay: () => void;
}) {
  const navigate = useNavigate();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 bg-background/85 backdrop-blur-md overflow-y-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.4 } }}
        >
          <div className="min-h-full flex flex-col items-center justify-center px-4 py-10 gap-6">
            <motion.div
              className="text-center space-y-1"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-wide text-gradient-mint">
                Choose your world
              </h1>
              <p className="text-xs text-muted-foreground tracking-[0.18em] uppercase">
                Edge Esmeralda · a floating world, in session
              </p>
            </motion.div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 max-w-4xl w-full">
              {WORLDS.map((w, i) => (
                <motion.button
                  key={w.name}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.06 * i, duration: 0.35 }}
                  onClick={() => (w.to ? navigate(w.to) : onStay())}
                  className="group glass-panel rounded-2xl overflow-hidden text-left border border-border/40 hover:border-primary/60 transition-colors"
                >
                  <div className="aspect-video overflow-hidden bg-black/40">
                    <img
                      src={w.art}
                      alt={w.name}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                  </div>
                  <div className="p-3">
                    <div className="font-heading font-semibold text-sm">
                      {w.emoji} {w.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 hidden sm:block">
                      {w.blurb}
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>

            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              onClick={onStay}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              skip — drop me into the village ✕
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
