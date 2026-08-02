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
  /**
   * In-game capture. Optional: a world whose capture only ever produces a
   * broken frame gets a drawn panel instead, because misleading card art is
   * worse than none.
   */
  art?: string;
  blurb: string;
  /** Featured worlds sort to the top and get the wide treatment. */
  featured?: boolean;
  /** Short, honest statement of what the world is right now. */
  status?: string;
  /** Signal colour for a featured world's chrome. */
  accent?: string;
}

import edmTownArt from "@/assets/worlds/edm-town.jpg";
import sanFranciscoArt from "@/assets/worlds/san-francisco.jpg";
import sanPalmasArt from "@/assets/worlds/san-palmas.jpg";
import vibeIsland2Art from "@/assets/worlds/vibe-island-2.jpg";
import terminalArt from "@/assets/worlds/terminal.jpg";
import golfArt from "@/assets/worlds/golf.jpg";
import vibeverseArt from "@/assets/worlds/vibeverse-explorer.jpg";
import fnafArt from "@/assets/worlds/fnaf.jpg";
import kartArt from "@/assets/worlds/kart.jpg";
import blueAngelsArt from "@/assets/worlds/blue-angels.jpg";
import iSpyArt from "@/assets/worlds/i-spy.jpg";
import airplaneArt from "@/assets/worlds/airplane.jpg";
import trekArt from "@/assets/worlds/final-frontier.jpg";
import homeAloneArt from "@/assets/worlds/home-alone.jpg";

const WORLDS: WorldCard[] = [
  {
    to: "/trek",
    emoji: "🖖",
    name: "The Final Frontier",
    // A real frame: the bridge at red alert with a Klingon battle cruiser
    // magnified on the main viewer. Which is the whole world in one picture.
    art: trekArt,
    blurb:
      "You are the captain, and the main viewscreen is a live render of the space your ship is actually in. Five episodes, one Constitution-class starship, and a crew who tell you what they see.",
    featured: true,
    status: "Playable — five episodes, desktop and phone",
    accent: "#ffb648",
  },
  {
    to: "/i-spy",
    emoji: "👁",
    name: "I Spy",
    // A real frame from block 541: the player, one orb, four real spikes, and
    // about sixty things that look exactly like them. That is the game.
    art: iSpyArt,
    blurb:
      "The Geometry Dash level, in two dimensions. One button, sixty seconds, and a screen so full of spikes that most of them have to be lying — because they are.",
    featured: true,
    status: "Playable — desktop, phone, one button",
    accent: "#ff2fbf",
  },
  {
    to: "/airplane",
    emoji: "🛩️",
    name: "Airplane!",
    art: airplaneArt,
    blurb:
      "Trans American 209, Los Angeles to Chicago. The crew had the fish, there are 187 people behind you, and O'Hare is under a thunderstorm. You are in the left seat of a 707.",
    featured: true,
    status: "Playable — desktop, phone, gamepad",
    accent: "#f0a020",
  },
  {
    to: "/blue-angels",
    emoji: "🔵",
    name: "Blue Angels",
    art: blueAngelsArt,
    blurb:
      "Seafair over Lake Washington. You fly number 1 and the other five fly your wing — over a real Seattle, from Alki to Rainier.",
    featured: true,
    status: "Playable — desktop, phone, gamepad",
    accent: "#ffc61e",
  },
  {
    to: "/terminal",
    emoji: "🛫",
    name: "The Terminal",
    art: terminalArt,
    blurb: "The front door. Stand on a platform in the sky with every world floating around you, and pick one.",
    featured: true,
    status: "Playable — the lobby",
    accent: "#38bdf8",
  },
  {
    to: "/island-2",
    emoji: "🏝️",
    name: "Vibe Island II",
    art: vibeIsland2Art,
    blurb: "The floating archipelago, rebuilt — a carved lagoon that spills into the clouds, and islands you can fly underneath.",
    featured: true,
    status: "In progress — fly it now",
    accent: "#ffb347",
  },
  {
    to: "/vibeverse",
    emoji: "🛰️",
    name: "The Vibeverse",
    // A real frame out of the running build, not key art.
    art: vibeverseArt,
    blurb:
      "The whole place, seen from orbit. Fly the survey vessel Vibey between the stars — three of them are real worlds you can land on, and landing is how you walk in.",
    featured: true,
    status: "Playable — desktop only, wants a real GPU",
    accent: "#8fe4ff",
  },
  {
    to: "/home-alone",
    emoji: "🎄",
    name: "Home Alone",
    // A real frame: 671 Lincoln Avenue from the street, every window burning,
    // snow coming down. If a picture has to do one job, it is that one.
    art: homeAloneArt,
    blurb:
      "671 Lincoln Avenue at Christmas. Three floors, sixteen rooms and a basement with a furnace in it — walk the empty house, light it up, arm eight traps, then survive the two men who came for it.",
    featured: true,
    status: "Playable — five levels, plus free roam",
    accent: "#e0b64a",
  },
  {
    to: "/fnaf",
    emoji: "🐻",
    name: "Five Nights at Vibey's",
    // A real frame: Bonnie in the west doorway with the hall light burning
    // battery to show him to you. That is the game in one picture.
    art: fnafArt,
    blurb:
      "Midnight to six in a pizzeria that does not want you there. Two doors, two lights, eleven cameras, one battery — and four animatronics walking the building on their own.",
    featured: true,
    status: "Playable — five nights, and a sixth if you earn it",
    accent: "#dc2626",
  },
  {
    to: "/seafair",
    emoji: "🛩️",
    name: "Seafair 2117",
    // No capture yet — the world is still being art-directed, and their own
    // rule applies: misleading card art is worse than none.
    blurb:
      "Future Seattle on Seafair weekend. Hydros on Lake Washington, Blue Angels overhead, and something alien holding the Space Needle.",
    featured: true,
    status: "In progress — playable, being art-directed",
    accent: "#12a5f5",
  },
  {
    to: "/san-palmas",
    emoji: "🌴",
    name: "San Palmas",
    art: sanPalmasArt,
    blurb: "Tropical San Francisco — the vibeverse's FPS. Guns, sun, and a very long draw distance.",
    featured: true,
    status: "Playable — move, look, shoot",
    accent: "#ffb020",
  },
  {
    to: "/sf",
    emoji: "🌉",
    name: "San Francisco",
    art: sanFranciscoArt,
    blurb: "FREE FALL — the real city, hill for hill, bridge for bridge. Fly it now; grapple and wingsuit soon.",
    featured: true,
    status: "Sandbox — fly the city",
    accent: "#ff6a2b",
  },
  {
    to: "/edm-town",
    emoji: "🪩",
    name: "EDM Town",
    art: edmTownArt,
    blurb: "Low-poly neon festival town — lasers, a dancing crowd, photo mode, and a guestbook.",
  },
  {
    to: "/kart",
    art: kartArt,
    emoji: "🏁",
    name: "Vibe Kart",
    // A real frame off the attract camera: the grid under the start gantry.
    blurb: "Arcade kart racing — drift for mini-turbos, sling shells, and take the hairpin shortcut.",
    status: "New — one circuit, eight racers",
    accent: "#ffcc22",
  },
  {
    to: "/golf",
    emoji: "⛳",
    name: "Vibe Golf",
    art: golfArt,
    blurb: "Physics golf across 63 holes — portals, jetpacks, and a bag of very silly balls.",
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
  {
    to: "/companions",
    emoji: "🧪",
    name: "Agent Lab",
    art: evolveArt,
    blurb: "Experimental — hatch your own companion: name it, give it a personality, pick a look.",
  },
];

export default function WorldPicker({
  open,
  onClose,
  asPage = false,
  homeLabel,
}: {
  open: boolean;
  onClose: () => void;
  /** Overrides the footer action's label when rendered as a page. */
  homeLabel?: string;
  /**
   * Render inline as a full page (for the /worlds route) instead of as a
   * portalled overlay. Same component, same list — there is exactly one
   * definition of "the worlds" in this codebase and this is it.
   */
  asPage?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const here = (w: WorldCard) => w.to.split("?")[0] === location.pathname && !w.to.includes("?");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? WORLDS.filter(
          (w) => w.name.toLowerCase().includes(q) || w.blurb.toLowerCase().includes(q),
        )
      : WORLDS;
    // Featured worlds lead. Stable within each group so the rest keeps its
    // hand-tuned order.
    return [...list].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
  }, [query]);

  const body = (
    <AnimatePresence>
      {open && (
        <motion.div
          className={
            asPage
              ? "min-h-[100dvh] w-full bg-background overflow-y-auto"
              : "fixed inset-0 z-50 bg-background/85 backdrop-blur-md overflow-y-auto"
          }
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
                  className={`group glass-panel rounded-2xl overflow-hidden text-left border transition-colors ${
                    w.featured
                      ? "col-span-2 lg:col-span-3 border-transparent"
                      : "border-border/40 hover:border-primary/60"
                  }`}
                  style={w.featured ? { boxShadow: `inset 0 0 0 1.5px ${w.accent}66` } : undefined}
                >
                  <div
                    className={`relative overflow-hidden bg-black/40 ${
                      w.featured ? "aspect-[16/7]" : "aspect-video"
                    }`}
                  >
                    {w.art ? (
                      <img
                        src={w.art}
                        alt={w.name}
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div
                        className="w-full h-full"
                        style={{
                          background:
                            `radial-gradient(120% 90% at 18% 0%, ${w.accent ?? "#888"}44, transparent 62%),` +
                            "linear-gradient(178deg, #11151d 0%, #080a0f 70%)",
                        }}
                      >
                        <svg
                          viewBox="0 0 160 60"
                          preserveAspectRatio="none"
                          className="absolute inset-x-0 bottom-0 h-1/2 w-full opacity-30"
                          aria-hidden
                        >
                          <path
                            d="M0 60V44h9V33h7v11h6V26h8v18h5V36h9v8h7V20h8v24h6V31h10v13h7V38h8v6h6V28h9v16h7v-9h8v9h6V33h9v11h7V41h8v19z"
                            fill={w.accent ?? "#888"}
                          />
                        </svg>
                      </div>
                    )}
                    {w.status && (
                      <span
                        className="absolute bottom-2 left-2 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-black"
                        style={{ background: w.accent ?? "#fff" }}
                      >
                        {w.status}
                      </span>
                    )}
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
                    {/* Featured worlds always explain themselves. Hiding the
                        blurb on small screens meant a card could say only "The
                        Terminal" on a phone — a name is not an explanation, and
                        the whole job of this screen is telling you what is
                        behind each door. */}
                    <div
                      className={`text-[11px] text-muted-foreground leading-snug mt-0.5 ${
                        w.featured ? "block" : "hidden sm:block"
                      }`}
                    >
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
              {asPage ? homeLabel ?? "← back to the hub" : "✕ close"}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // As a page it is ordinary document flow; as the gateway it is portalled to
  // <body> so it floats above whatever world is already running.
  return asPage ? body : createPortal(body, document.body);
}
