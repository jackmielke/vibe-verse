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
import VibeArcade from "./pages/VibeArcade.tsx";
import VibeShop from "./pages/VibeShop.tsx";
import VibeWallet from "./pages/VibeWallet.tsx";
import Orbit from "./pages/Orbit.tsx";
import Join from "./pages/Join.tsx";
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
import HomeButton from "./components/HomeButton.tsx";
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
import VibeIsland2 from "./pages/VibeIsland2.tsx";
import Terminal from "./pages/Terminal.tsx";
import Game from "./pages/Game.tsx";
import { CHROMELESS_ROUTES } from "./worlds/registry.ts";


const Seafair = lazy(() => import("./pages/Seafair.tsx"));
/* THE VIBEVERSE brings its own build of Three and ~2 MB of shaders. It is lazy
   for the same reason Seafair is: nobody who never flies there should pay for
   it in the hub's entry chunk. */
const VibeverseExplorer = lazy(() => import("./pages/VibeverseExplorer.tsx"));
/* DROP ZERO is the biggest world in the building — its own terrain, build
   system, weapons and bots, ~65k lines. Lazy for the same reason as the rest:
   nobody who never drops in should carry an island in the hub's entry chunk. */
const DropZero = lazy(() => import("./pages/DropZero.tsx"));
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
/* AIRPLANE! builds a 707 flight deck, a thunderstorm and the whole of Chicago
   at boot. Lazy for the same reason as the rest: nobody who never flies 209
   should carry a light field of three million street lamps around in the hub's
   entry chunk. */
const Airplane = lazy(() => import("./pages/Airplane.tsx"));
/* THE FINAL FRONTIER carries a whole starship bridge, five hulls and a
   procedural planet. Lazy for the same reason as the rest: nobody who never
   takes the centre seat should carry the Enterprise in the hub's entry chunk. */
const StarTrek = lazy(() => import("./pages/StarTrek.tsx"));
/* STRANGE NEW WORLDS carries twelve authored planets, a warp drive and a
   walkable surface for each of them, plus everyone who lives on them. Lazy for
   the same reason as the rest. */
const StrangeNewWorlds = lazy(() => import("./pages/StrangeNewWorlds.tsx"));
/* HOME ALONE builds 671 Lincoln Avenue — three storeys, sixteen rooms and the
   block it stands on — out of procedural textures at boot. Lazy for the same
   reason as the rest: nobody who never rings that doorbell should carry the
   house around in the hub's entry chunk. */
const HomeAlone = lazy(() => import("./pages/HomeAlone.tsx"));
/* RUN, VIBEY, RUN carries six chapters' worth of world builders — an Alabama
   road, a stadium, a jungle, a gym, the gulf and the whole of America. Lazy
   for the same reason as the rest. */
const RunVibeyRun = lazy(() => import("./pages/RunVibeyRun.tsx"));

const queryClient = new QueryClient();

/** App chrome (nav + radio) — hidden anywhere that owns the whole viewport and
    the pointer, where the nav would sit on top of a crosshair, a pitch ladder,
    a door button or an attitude indicator. Derived from the registry
    (`chromeless: true`, aliases included) so a world cannot ship fullscreen on
    one URL and chromed on another, plus /live, the one surface that is not a
    world: a clean broadcast with no UI at all. */
const CHROMELESS = new Set([...CHROMELESS_ROUTES, "/live"]);

const AppChrome = () => {
  const { pathname, search } = useLocation();

  /* ?embed=1 — another site is framing us as a broadcast. Pure picture, no
     chrome of any kind, not even the way home. */
  const embedded = new URLSearchParams(search).get("embed") === "1";
  if (embedded) return null;

  /* Inside a fullscreen world the nav would sit on a crosshair, so it is
     hidden — and for a long time that meant those worlds had no exit at all.
     They get the one button instead, in the same corner every time. /live is
     the exception: it is a broadcast, not somewhere a person is standing. */
  if (CHROMELESS.has(pathname)) {
    return pathname === "/live" ? null : <HomeButton />;
  }

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
          {/* Global nav + VIBE FM where there is room for them, and the one
              way home everywhere else. */}
          <AppChrome />
          <Routes>
          {/* The grid of every world is the landing page. It is the clearest
              way to see what exists in one glance, and one tap gets you in.
              The 3D lobbies (/terminal, /lobby-3d) are the second way in.
              "/", "/game" and "/worlds" are all the same page — one grid, three
              names, because there is no version of this where two different
              grids of the same worlds stay in agreement. */}
          <Route path="/" element={<Game />} />
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
          {/* VIBE ARCADE — the first place Vibecoin is spent rather than
              earned. Three coin-operated cabinets; the insert debits the real
              ledger and the payout is settled server-side. */}
          <Route path="/arcade" element={<VibeArcade />} />
          {/* THE VIBE SHOP — the other half of the arcade. Coins won there buy
              something here that is recorded against your wallet rather than
              your browser, so it survives a cleared history and a new device. */}
          <Route path="/shop" element={<VibeShop />} />
          <Route path="/wallet" element={<VibeWallet />} />
          {/* ORBIT — the staked game. One button, one shared seed per round,
              one pot. See src/orbit/orbit.ts for why it is built the way it is. */}
          <Route path="/orbit" element={<Orbit />} />
          {/* The front door of an event: /join/<code> hands somebody Vibecoin
              before it asks them for anything. */}
          <Route path="/join/:code" element={<Join />} />
          {/* VIBE GO — Pokémon-GO-style real-world catching, PWA-first. */}
          <Route path="/go" element={<VibeGo />} />
          {/* First-time onboarding: name → character → email-or-guest. */}
          <Route path="/start" element={<StartFlow />} />
          {/* Fruit Ninja. */}
          <Route path="/ninja" element={<FruitNinja />} />
          {/* EDM Town — low-poly party world with photo mode + guestbook. */}
          <Route path="/edm-town" element={<EdmTown />} />
          {/* The 3D carousel lobby, still reachable — it just is not the
              front door any more. */}
          <Route path="/hub" element={<HubV2 />} />
          <Route path="/lobby-3d" element={<HubV2 />} />
          {/* Old constellation experiment, kept for comparison. */}
          <Route path="/hub-old" element={<Hub />} />
          {/* The landing grid, on URLs that say what it is. */}
          <Route path="/game" element={<Game />} />
          <Route path="/games" element={<Navigate to="/game" replace />} />
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
          <Route path="/worlds" element={<Game />} />
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
          {/* DROP ZERO — battle royale. Bus, island, storm, and the build loop.
              /royale and /br are aliases; the world calls itself Drop Zero. */}
          {["/drop-zero", "/royale", "/br"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#05060f]" />}>
                  <DropZero />
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
          {/* Vibe Kart — arcade kart racing: drift, mini-turbos, shells.
              Single player and multiplayer are the same route: the title screen
              picks, and `?room=CODE` is an invite straight into a lobby.
              `/kart-mp` was the old multiplayer world and still answers. */}
          {["/kart", "/kart-mp"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#07101c]" />}>
                  <VibeKart />
                </Suspense>
              }
            />
          ))}
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
          {/* HOME ALONE — 671 Lincoln Avenue at Christmas. Walk an empty
              house, light it up, arm eight traps, then survive the two men who
              came for it. First of the films-as-worlds. */}
          {["/home-alone", "/kevin"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#0d1524]" />}>
                  <HomeAlone />
                </Suspense>
              }
            />
          ))}
          {/* AIRPLANE! — Trans American 209, LAX to Chicago. The crew had the
              fish. You are in the left seat of a 707 in a thunderstorm, and
              there are 187 people behind you. */}
          {["/airplane", "/flight-209", "/209"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <Airplane />
                </Suspense>
              }
            />
          ))}
          {/* THE FINAL FRONTIER — you are the captain of a Constitution-class
              starship, and the main viewscreen is a live render of the space
              your ship is actually flying through. Five episodes. */}
          {["/trek", "/star-trek", "/final-frontier"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <StarTrek />
                </Suspense>
              }
            />
          ))}
          {/* STRANGE NEW WORLDS — the other half of Star Trek. Twelve real
              systems on a real chart, a fold from one to the next, orbit, a
              sensor sweep, and then the transporter puts you down in front of
              somebody who will talk back. */}
          {["/strange-new-worlds", "/snw", "/starfleet"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
                  <StrangeNewWorlds />
                </Suspense>
              }
            />
          ))}
          {/* RUN, VIBEY, RUN — a whole life, at a run. Six chapters: the road
              out of Greenbow, a kickoff return, the treeline, a ping-pong
              match, the shrimp boat, and then across America. */}
          {["/run", "/gump", "/forrest"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#0b0d10]" />}>
                  <RunVibeyRun />
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
