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
          <Route path="/" element={<Index />} />
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
          {/* Evolve — the Genesis Bloom evolution sim (from genesis-bloom-evolve). */}
          <Route path="/evolve" element={<Evolve />} />
          <Route path="/bestiary" element={<Bestiary />} />
          {/* Vibey's memory garden — walk Vibey, read plants, browse the outdoor gallery. */}
          <Route path="/garden" element={<MemoryGarden />} />
          {/* The old standalone gallery now collapses into the garden art fair. */}
          <Route path="/gallery" element={<Navigate to="/garden" replace />} />
          {/* Fractal Museum — Seuss-inspired walkable gallery room. */}
          <Route path="/museum" element={<Museum />} />
          {/* VIBE Hub — wallet login, community holders, market. */}
          <Route path="/vibe" element={<VibeHub />} />
          {/* Fruit Ninja — VR controller swing test / mini-game. */}
          <Route path="/ninja" element={<FruitNinja />} />
          {/* Hub — VibeVerse orbital lobby (the new default hub). */}
          <Route path="/hub" element={<HubV2 />} />
          {/* Hub Old — the original constellation experiment, kept for comparison. */}
          <Route path="/hub-old" element={<Hub />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
