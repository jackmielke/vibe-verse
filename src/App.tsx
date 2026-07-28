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
import SanPalmas from "./pages/SanPalmas.tsx";

const queryClient = new QueryClient();

/** App chrome (nav + radio) — hidden on /live so the broadcast is clean. */
const AppChrome = () => {
  const { pathname } = useLocation();
  if (pathname === "/live") return null;
  // San Palmas is a fullscreen pointer-locked FPS — the nav would sit on top
  // of the crosshair.
  if (pathname === "/san-palmas" || pathname === "/fps") return null;
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
          {/* San Palmas — tropical San Francisco. The vibeverse's open-world FPS. */}
          <Route path="/san-palmas" element={<SanPalmas />} />
          <Route path="/fps" element={<SanPalmas />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </VibeIdentityProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
