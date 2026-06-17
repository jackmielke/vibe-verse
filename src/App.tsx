import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
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
import FruitNinja from "./pages/FruitNinja.tsx";
import Hub from "./pages/Hub.tsx";
import HubV2 from "./pages/HubV2.tsx";
import SubmitWorld from "./pages/SubmitWorld.tsx";
import WorldBuilder from "./pages/WorldBuilder.tsx";
import EdmTown from "./pages/EdmTown.tsx";
import AdminWorlds from "./pages/AdminWorlds.tsx";
import GlobalNav from "./components/GlobalNav.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        {/* Global top-center destination nav — visible on every route
            so the user always has one-click access to all the worlds. */}
        <GlobalNav />
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
          {/* Evolve — the Genesis Bloom evolution sim. */}
          <Route path="/evolve" element={<Evolve />} />
          <Route path="/bestiary" element={<Bestiary />} />
          {/* Vibey's memory garden. */}
          <Route path="/garden" element={<MemoryGarden />} />
          <Route path="/gallery" element={<Navigate to="/garden" replace />} />
          {/* Fractal Museum. */}
          <Route path="/museum" element={<Museum />} />
          {/* VIBE Hub — wallet login, community holders, market. */}
          <Route path="/vibe" element={<VibeHub />} />
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
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
