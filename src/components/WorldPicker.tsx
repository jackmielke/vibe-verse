/**
 * WorldPicker — the "choose your world" gateway.
 *
 * Shows automatically once per session after the splash, and any time
 * from the 🌐 Worlds chip in GlobalNav. Lists EVERY world as a preview
 * card (real in-game screenshots from src/assets/worlds/), ordered
 * favorites-first. Clicking a card routes straight there — including
 * the Cardboard Island card, which spawns you on the island lawn.
 *
 * Re-capture a card's art when its world changes enough to feel stale.
 */
import { createPortal } from "react-dom";
import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, useNavigate } from "react-router-dom";
import villageArt from "@/assets/edge-app-icon-bg.png";
import cityArt from "@/assets/worlds/city.jpg";
import islandArt from "@/assets/worlds/island.jpg";
import skiArt from "@/assets/worlds/ski.jpg";
import spaceArt from "@/assets/worlds/space.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import gardenArt from "@/assets/worlds/garden.jpg";
import museumArt from "@/assets/worlds/museum.jpg";
import evolveArt from "@/assets/worlds/evolve.jpg";
import ninjaArt from "@/assets/worlds/ninja.jpg";
import vibeArt from "@/assets/worlds/vibe.jpg";
import aboutArt from "@/assets/worlds/about.jpg";

interface WorldCard {
  to: string;
  emoji: string;
  name: string;
  art: string;
  blurb: string;
}

import edmTownArt from "@/assets/worlds/edm-town.jpg";

const WORLDS: WorldCard[] = [
  {
    to: "/edm-town",
    emoji: "🪩",
    name: "EDM Town",
    art: edmTownArt,
    blurb: "Low-poly neon festival town — lasers, a dancing crowd, photo mode, and a guestbook.",
  },
  {
    to: "/space",
    emoji: "🌌",
    name: "Space",
    art: spaceArt,
    blurb: "Vibey 2.0's late-night show on a floating asteroid, with the alien next door.",
  },
  {
    to: "/evolve",
    emoji: "🧬",
    name: "Evolve",
    art: evolveArt,
    blurb: "The Genesis Bloom sim — play a creature, eat, mutate, survive the apex.",
  },
  {
    to: "/garden",
    emoji: "🌱",
    name: "Garden",
    art: gardenArt,
    blurb: "Vibey's memory garden — walk among planted memories and the art fair.",
  },
  {
    to: "/city",
    emoji: "🏙️",
    name: "Vibe City",
    art: cityArt,
    blurb: "Jetpack a neon district — multiplayer, NPCs, star runs, talk to Vibey.",
  },
  {
    to: "/city?spawn=island",
    emoji: "🏝️",
    name: "Vibe Island",
    art: islandArt,
    blurb: "A magically weird world in the sky — Jerry, the SnackFe cafe, the zipline, the rideable zeppelin. Lands you right on it.",
  },
  {
    to: "/city?spawn=ski",
    emoji: "⛷️",
    name: "Powder Peak",
    art: skiArt,
    blurb: "The ski world — carve real slopes, ride the gondola, warm up at the Vibe Lodge.",
  },
  {
    to: "/city?spawn=moon",
    emoji: "🌙",
    name: "The Moon",
    art: islandArt,
    blurb: "A tiny landable moon near Vibe Island — touch down on the glowing pad and plant your flag.",
  },
  {
    to: "/",
    emoji: "🗺️",
    name: "Village",
    art: villageArt,
    blurb: "The real Healdsburg map — Vibey, Unit-7, choppers, and spawnable worlds.",
  },
  {
    to: "/lobby",
    emoji: "🏎️",
    name: "Lobby",
    art: lobbyArt,
    blurb: "Pick your character and vehicle, Mario-Kart style. ~60 to choose from.",
  },
  {
    to: "/museum",
    emoji: "🖼️",
    name: "Museum",
    art: museumArt,
    blurb: "A walkable, Seuss-flavored gallery of famous fractals.",
  },
  {
    to: "/ninja",
    emoji: "🍉",
    name: "Fruit Ninja",
    art: ninjaArt,
    blurb: "Slice fruit in VR (or with the mouse) and chase the high score.",
  },
  {
    to: "/coin",
    emoji: "🪙",
    name: "VIBE",
    art: vibeArt,
    blurb: "$VIBE — the community currency hub, holders, and market.",
  },
  {
    to: "/about",
    emoji: "✨",
    name: "About",
    art: aboutArt,
    blurb: "What this is and how it's stitched together, told on a floating asteroid.",
  },
];

export default function WorldPicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const here = (w: WorldCard) => w.to.split("?")[0] === location.pathname && !w.to.includes("?");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return WORLDS;
    return WORLDS.filter(
      (w) => w.name.toLowerCase().includes(q) || w.blurb.toLowerCase().includes(q)
    );
  }, [query]);

  return createPortal(
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

            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="w-full max-w-md"
            >
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search worlds…"
                className="w-full glass-panel rounded-full border border-border/60 px-4 py-2 text-sm bg-background/40 focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground/70"
              />
            </motion.div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 max-w-4xl w-full">
              {filtered.map((w, i) => (
                <motion.button
                  key={w.to}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 * i, duration: 0.35 }}
                  onClick={() => {
                    navigate(w.to);
                    onClose();
                  }}
                  className="group glass-panel rounded-2xl overflow-hidden text-left border border-border/40 hover:border-primary/60 transition-colors"
                >
                  <div className="relative aspect-video overflow-hidden bg-black/40">
                    <img
                      src={w.art}
                      alt={w.name}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                    {here(w) && (
                      <span className="absolute top-2 right-2 rounded-full bg-primary/80 text-primary-foreground text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5">
                        you're here
                      </span>
                    )}
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
              onClick={onClose}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ close
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
