import { Suspense, lazy } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import Unit7Playground from "./pages/Unit7Playground.tsx";
import Lobby from "./pages/Lobby.tsx";
import About from "./pages/About.tsx";
import SpotifyCallback from "./pages/SpotifyCallback.tsx";
import MemoryGarden from "./pages/MemoryGarden.tsx";
import City from "./pages/City.tsx";
import Evolve from "./pages/Evolve.tsx";
import Bestiary from "./pages/Bestiary.tsx";
import Museum from "./pages/Museum.tsx";
import VibeHub from "./pages/VibeHub.tsx";
import VibeGo from "./pages/VibeGo.tsx";
import StartFlow from "./pages/StartFlow.tsx";
import FruitNinja from "./pages/FruitNinja.tsx";
import Hub from "./pages/Hub.tsx";
import HubV2 from "./pages/HubV2.tsx";
import SubmitWorld from "./pages/SubmitWorld.tsx";
import WorldBuilder from "./pages/WorldBuilder.tsx";
import EdmTown from "./pages/EdmTown.tsx";
import AdminWorlds from "./pages/AdminWorlds.tsx";
import AgentLobby from "./pages/AgentLobby.tsx";
import VibeProfile from "./pages/VibeProfile.tsx";
import GlobalNav from "./components/GlobalNav.tsx";
import VibeRadio from "./components/VibeRadio.tsx";
import { VibeIdentityProvider } from "./hooks/use-vibe-identity.tsx";
import IslandExplorer from "./pages/IslandExplorer.tsx";
import Globetrotter from "./pages/Globetrotter.tsx";
import CharacterSelect from "./pages/CharacterSelect.tsx";
import Companions from "./pages/Companions.tsx";
import VibeTimes from "./pages/VibeTimes.tsx";
import SanFrancisco from "./pages/SanFrancisco.tsx";
import SanPalmas from "./pages/SanPalmas.tsx";
import VibeGolf from "./pages/VibeGolf.tsx";
import Worlds from "./pages/Worlds.tsx";
import VibeIsland2 from "./pages/VibeIsland2.tsx";
import Terminal from "./pages/Terminal.tsx";


const Seafair = lazy(() => import("./pages/Seafair.tsx"));
/* THE VIBEVERSE brings its own build of Three and ~2 MB of shaders. It is lazy
   for the same reason Seafair is: nobody who never flies there should pay for
   it in the hub's entry chunk. */
const VibeverseExplorer = lazy(() => import("./pages/VibeverseExplorer.tsx"));
/* Vibe Kart is a 660 kB chunk of racetrack, and the same argument applies. */
const VibeKart = lazy(() => import("./pages/VibeKart.tsx"));
/* FIVE NIGHTS AT VIBEY'S builds a whole restaurant out of procedural textures
   at boot. Lazy for the same reason: nobody who never works a night shift
   should carry the pizzeria around in the hub's entry chunk. */
const FiveNights = lazy(() => import("./pages/FiveNights.tsx"));
/* BLUE ANGELS builds all of Seattle at boot — a 44 km height field, eleven
   thousand buildings and Mount Rainier. Lazy for the same reason as the rest:
   nobody who never flies it should carry the city in the hub's entry chunk. */
const BlueAngels = lazy(() => import("./pages/BlueAngels.tsx"));
/* I SPY is a 2D canvas game with no Three in it at all, but it carries a
   1,400-object level and a solver, and nobody who never plays it should
   carry those around in the hub's entry chunk either. */
const ISpy = lazy(() => import("./pages/ISpy.tsx"));

const queryClient = new QueryClient();

/** App chrome (nav + radio) — hidden anywhere that owns the whole viewport and
    the pointer: the clean /live broadcast, and both fullscreen shooters, where
    the nav would sit on top of the crosshair. */
const CHROMELESS = new Set([
  "/live",
  "/sf",
  "/san-francisco",
  "/free-fall",
  "/san-palmas",
  "/fps",
  "/worlds",
  "/island-2",
  "/vibe-island-2",
  "/terminal",
  "/seafair",
  "/vibeverse",
  "/explorer",
  "/long-silence",
  // Five Nights owns the pointer — the nav would sit on the west door button.
  "/fnaf",
  "/five-nights",
  // Vibe Golf is a fullscreen touch game — the nav would eat the drag gesture.
  "/golf",
  // Vibe Kart owns the whole viewport, and the nav would sit on the HUD.
  "/kart",
  // Blue Angels is a fullscreen HUD — the nav would sit on the pitch ladder.
  "/blue-angels",
  "/angels",
  "/seafair-show",
  // I Spy fills the frame with things that look like spikes. The nav would
  // become one more of them.
  "/i-spy",
  "/ispy",
  "/geometry-dash",
]);

const AppChrome = () => {
  const { pathname } = useLocation();
  if (CHROMELESS.has(pathname)) return null;
  return (
    <>
      <GlobalNav />
      <VibeRadio />
    </>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <VibeIdentityProvider>
          {/* Global top-center destination nav + VIBE FM — on every route
              except the clean /live broadcast. */}
          <AppChrome />
          <Routes>
          {/* Hub is now the landing page — the VibeVerse lobby. */}
          <Route path="/" element={<HubV2 />} />
          {/* Old Edge Esmeralda splash, kept reachable for those who want it. */}
          <Route path="/welcome" element={<Index />} />
          {/* Mario-Kart-style character + vehicle picker. */}
          <Route path="/lobby" element={<Lobby />} />
          {/* 3D About — narrative + carousel of characters. */}
          <Route path="/about" element={<About />} />
          {/* Spotify OAuth (PKCE) callback. */}
          <Route path="/auth/spotify" element={<SpotifyCallback />} />
          {/* /space is the canonical path; /unit7 stays as a back-compat alias. */}
          <Route path="/space" element={<Unit7Playground />} />
          <Route path="/unit7" element={<Unit7Playground />} />
          {/* Vibe City — procedural neon district you explore with a jetpack. */}
          <Route path="/city" element={<City />} />
          {/* /live — the world streams itself: AI camera director + ticker. */}
          <Route path="/live" element={<City />} />
          {/* Evolve — the Genesis Bloom evolution sim. */}
          <Route path="/evolve" element={<Evolve />} />
          <Route path="/bestiary" element={<Bestiary />} />
          {/* Vibey's memory garden. */}
          <Route path="/garden" element={<MemoryGarden />} />
          <Route path="/gallery" element={<Navigate to="/garden" replace />} />
          {/* Fractal Museum. */}
          <Route path="/museum" element={<Museum />} />
          {/* COIN Hub — wallet login, community holders, market. */}
          <Route path="/coin" element={<VibeHub />} />
          <Route path="/vibe" element={<Navigate to="/coin" replace />} />
          {/* VIBE GO — Pokémon-GO-style real-world catching, PWA-first. */}
          <Route path="/go" element={<VibeGo />} />
          {/* First-time onboarding: name → character → email-or-guest. */}
          <Route path="/start" element={<StartFlow />} />
          {/* Fruit Ninja. */}
          <Route path="/ninja" element={<FruitNinja />} />
          {/* EDM Town — low-poly party world with photo mode + guestbook. */}
          <Route path="/edm-town" element={<EdmTown />} />
          {/* /hub still works as an alias for the lobby. */}
          <Route path="/hub" element={<HubV2 />} />
          {/* Old constellation experiment, kept for comparison. */}
          <Route path="/hub-old" element={<Hub />} />
          {/* Community-submitted worlds. */}
          <Route path="/submit-world" element={<SubmitWorld />} />
          {/* Guided form that generates a paste-ready prompt for any AI editor. */}
          <Route path="/world-builder" element={<WorldBuilder />} />
          <Route path="/admin/worlds" element={<AdminWorlds />} />
          {/* Agent Lobby — an always-on room agents join over HTTP and live in. */}
          <Route path="/world" element={<AgentLobby />} />
          <Route path="/agent-lobby" element={<AgentLobby />} />
          {/* Profile / character picker — replaces the tiny color popover. */}
          <Route path="/profile" element={<VibeProfile />} />
          {/* Standalone first-run character selection surface. */}
          <Route path="/character-select" element={<CharacterSelect />} />
          <Route path="/characters" element={<CharacterSelect />} />
          {/* Island Explorer — multi-world R3F sandbox: pick a character + world,
              walk/run/jump with WASD. Imported from the standalone project. */}
          <Route path="/island-explorer" element={<IslandExplorer />} />
          <Route path="/island" element={<IslandExplorer />} />

          {/* The world, inside the world — real-earth geoguessing */}
          <Route path="/globetrotter" element={<Globetrotter />} />
          <Route path="/geo" element={<Globetrotter />} />
          {/* Agent Lab — hatch-your-own companion (experimental, client-only v1). */}
          <Route path="/companions" element={<Companions />} />
          {/* The Vibe Times — the world's own newspaper, written nightly by the loop. */}
          <Route path="/times" element={<VibeTimes />} />
          {/* WORLDS — the shooter picker. Choose a city, then drop in. */}
          <Route path="/worlds" element={<Worlds />} />
          {/* San Francisco: Free Fall — open-world shooter, real SF geometry. */}
          <Route path="/sf" element={<SanFrancisco />} />
          <Route path="/san-francisco" element={<SanFrancisco />} />
          <Route path="/free-fall" element={<SanFrancisco />} />
          {/* THE TERMINAL — the front door. Stand in the sky, pick a world. */}
          <Route path="/terminal" element={<Terminal />} />
          {/* Vibe Island II — the floating archipelago, rebuilt. */}
          <Route path="/island-2" element={<VibeIsland2 />} />
          <Route path="/vibe-island-2" element={<VibeIsland2 />} />
          {/* San Palmas — tropical San Francisco. The vibeverse's open-world FPS. */}
          <Route path="/san-palmas" element={<SanPalmas />} />
          <Route path="/fps" element={<SanPalmas />} />
          {/* SEAFAIR 2117 — future Seattle during Seafair. Hydros, Blue Angels,
              and aliens holding the Space Needle. */}
          <Route
            path="/seafair"
            element={
              <Suspense fallback={<div className="fixed inset-0 bg-[#04080f]" />}>
                <Seafair />
              </Suspense>
            }
          />
          {/* THE VIBEVERSE — the hub seen from orbit. Fly the survey vessel VIBEY
              through a procedural galaxy where three of the stars are real
              destinations, and land on one to walk into it. /long-silence stays
              wired up: it was the route before the remix and links exist.
              Desktop and a real GPU. */}
          {["/vibeverse", "/explorer", "/long-silence"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <VibeverseExplorer />
                </Suspense>
              }
            />
          ))}
          {/* FIVE NIGHTS AT VIBEY'S — midnight to 6 AM, two doors, one battery.
              Four animatronics walk a real twelve-room building; the security
              cameras are cameras standing in it. */}
          {["/fnaf", "/five-nights"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <FiveNights />
                </Suspense>
              }
            />
          ))}
          {/* Vibe Golf — physics golf with portals, jetpacks and silly balls. */}
          <Route path="/golf" element={<VibeGolf />} />
          {/* Vibe Kart — arcade kart racing: drift, mini-turbos, shells. */}
          <Route
            path="/kart"
            element={
              <Suspense fallback={<div className="fixed inset-0 bg-[#07101c]" />}>
                <VibeKart />
              </Suspense>
            }
          />
          {/* BLUE ANGELS — Seafair over Lake Washington. You fly number 1 and
              the other five fly your wing, over a real Seattle. */}
          {["/blue-angels", "/angels", "/seafair-show"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#040a18]" />}>
                  <BlueAngels />
                </Suspense>
              }
            />
          ))}
          {/* I SPY — the Geometry Dash level, in 2D, in the vibeverse. One
              button, sixty seconds, and a screen full of spikes that are not
              there. */}
          {["/i-spy", "/ispy", "/geometry-dash"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <ISpy />
                </Suspense>
              }
            />
          ))}
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </VibeIdentityProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
