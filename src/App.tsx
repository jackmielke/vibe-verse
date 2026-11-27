import { Suspense, lazy } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ExplorerStamp from "./components/ExplorerStamp.tsx";
import PlayTracker from "./components/PlayTracker.tsx";
import RatePrompt from "./components/RatePrompt.tsx";
import BuildModeLauncher from "./build-mode/BuildModeLauncher.tsx";
import GlobalNav from "./components/GlobalNav.tsx";
import HomeButton from "./components/HomeButton.tsx";
import VibeRadio from "./components/VibeRadio.tsx";
import { VibeIdentityProvider } from "./hooks/use-vibe-identity.tsx";
import { CHROMELESS_ROUTES, worldByRoute } from "./worlds/registry.ts";

/* The landing grid and the 404 are the two pages that must not wait on a
   second round trip: one is what most visits open on, and the other is what a
   broken link lands on. Everything else in this file is lazy. */
import Game from "./pages/Game.tsx";
import { IOS_APP } from "@/lib/iosApp";
import SafetyLayer from "./safety/SafetyLayer.tsx";
import NotFound from "./pages/NotFound.tsx";

/**
 * ## Every route below is lazy, and that is the point
 *
 * This app is ~45 destinations sharing one bundle, and each of the big ones is
 * a game engine. Statically importing them meant the entry chunk was 7.4 MB
 * (2.26 MB gzipped) — the whole of San Palmas, Vibe Golf, Vibe City, mapbox-gl
 * and two copies of the wallet SDK downloaded before the grid of cards at `/`
 * could paint, on a phone, over conference wifi, by somebody who was going to
 * tap one card.
 *
 * So the rule here is now unconditional: **a route is `lazy()`, always.** Not
 * "if it is over a few hundred kB" — that judgement call is what left thirty
 * eager routes behind, because each one looked small on the day it was added
 * and nobody re-measured the sum. A page that really is small costs one extra
 * request when somebody opens it; a page that turns out to be big costs every
 * visitor who never opens it at all, and that is the expensive mistake.
 *
 * The two exceptions above are deliberate and should stay at two.
 */
const Index = lazy(() => import("./pages/Index.tsx"));
const Scores = lazy(() => import("./pages/Scores.tsx"));
const WhatsNew = lazy(() => import("./pages/WhatsNew.tsx"));
const Magician = lazy(() => import("./pages/Magician.tsx"));
const Oni = lazy(() => import("./pages/Oni.tsx"));
const Unit7Playground = lazy(() => import("./pages/Unit7Playground.tsx"));
const Lobby = lazy(() => import("./pages/Lobby.tsx"));
const About = lazy(() => import("./pages/About.tsx"));
const Terms = lazy(() => import("./pages/Legal.tsx").then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import("./pages/Legal.tsx").then((m) => ({ default: m.Privacy })));
const SpotifyCallback = lazy(() => import("./pages/SpotifyCallback.tsx"));
const AuthCallback = lazy(() => import("./pages/AuthCallback.tsx"));
const MemoryGarden = lazy(() => import("./pages/MemoryGarden.tsx"));
const City = lazy(() => import("./pages/City.tsx"));
const Evolve = lazy(() => import("./pages/Evolve.tsx"));
const Bestiary = lazy(() => import("./pages/Bestiary.tsx"));
const Museum = lazy(() => import("./pages/Museum.tsx"));
const VibeHub = lazy(() => import("./pages/VibeHub.tsx"));
const VibeGo = lazy(() => import("./pages/VibeGo.tsx"));
const VibeArcade = lazy(() => import("./pages/VibeArcade.tsx"));
const ArcadeCharacters = lazy(() => import("./pages/ArcadeCharacters.tsx"));
const PortalPlay = lazy(() => import("./pages/PortalPlay.tsx"));
const Chronicle = lazy(() => import("./pages/Chronicle.tsx"));
const BuildAGame = lazy(() => import("./pages/BuildAGame.tsx"));
const SubmitGame = lazy(() => import("./pages/SubmitGame.tsx"));
const AdminGames = lazy(() => import("./pages/AdminGames.tsx"));
const VibeShop = lazy(() => import("./pages/VibeShop.tsx"));
const ShopCosmos = lazy(() => import("./pages/ShopCosmos.tsx"));
const Manifesto = lazy(() => import("./pages/Manifesto.tsx"));
const Passport = lazy(() => import("./pages/Passport.tsx"));
const HomeLooks = lazy(() => import("./pages/HomeLooks.tsx"));
const Homes = lazy(() => import("./pages/Homes.tsx"));
const Home = lazy(() => import("./pages/Home.tsx"));
const Redesign = lazy(() => import("./pages/Redesign.tsx"));
const HomeThemePage = lazy(() => import("./pages/Homes.tsx").then((m) => ({ default: m.HomeThemePage })));
const Orbit = lazy(() => import("./pages/Orbit.tsx"));
const Join = lazy(() => import("./pages/Join.tsx"));
const StartFlow = lazy(() => import("./pages/StartFlow.tsx"));
const FruitNinja = lazy(() => import("./pages/FruitNinja.tsx"));
const Hub = lazy(() => import("./pages/Hub.tsx"));
const HubV2 = lazy(() => import("./pages/HubV2.tsx"));
const SubmitWorld = lazy(() => import("./pages/SubmitWorld.tsx"));
const WorldBuilder = lazy(() => import("./pages/WorldBuilder.tsx"));
const EdmTown = lazy(() => import("./pages/EdmTown.tsx"));
const AdminWorlds = lazy(() => import("./pages/AdminWorlds.tsx"));
const AgentLobby = lazy(() => import("./pages/AgentLobby.tsx"));
const VibeProfile = lazy(() => import("./pages/VibeProfile.tsx"));
const IslandExplorer = lazy(() => import("./pages/IslandExplorer.tsx"));
const Globetrotter = lazy(() => import("./pages/Globetrotter.tsx"));
const CharacterSelect = lazy(() => import("./pages/CharacterSelect.tsx"));
const Companions = lazy(() => import("./pages/Companions.tsx"));
const VibeTimes = lazy(() => import("./pages/VibeTimes.tsx"));
const Newsroom = lazy(() => import("./pages/Newsroom.tsx"));
const SanFrancisco = lazy(() => import("./pages/SanFrancisco.tsx"));
const VibeFrancisco = lazy(() => import("./pages/VibeFrancisco.tsx"));
const SanPalmas = lazy(() => import("./pages/SanPalmas.tsx"));
const FirstLight = lazy(() => import("./pages/FirstLight.tsx"));
const VibeGolf = lazy(() => import("./pages/VibeGolf.tsx"));
const VibeIsland2 = lazy(() => import("./pages/VibeIsland2.tsx"));
const Thalassa = lazy(() => import("./pages/Thalassa.tsx"));
const FogCity = lazy(() => import("./pages/FogCity.tsx"));
const CannonRun = lazy(() => import("./pages/CannonRun.tsx"));
const Boxing = lazy(() => import("./pages/Boxing.tsx"));
const GatchClip = lazy(() => import("./pages/GatchClip.tsx"));
const Terminal = lazy(() => import("./pages/Terminal.tsx"));
const Seafair = lazy(() => import("./pages/Seafair.tsx"));
const GlassLake = lazy(() => import("./pages/GlassLake.tsx"));
const DuneSea = lazy(() => import("./pages/DuneSea.tsx"));
const VibeverseExplorer = lazy(() => import("./pages/VibeverseExplorer.tsx"));
const Conservatory = lazy(() => import("./pages/Conservatory.tsx"));
const Venus = lazy(() => import("./pages/Venus.tsx"));
const Horizon = lazy(() => import("./pages/Horizon.tsx"));
const DropZero = lazy(() => import("./pages/DropZero.tsx"));
const SplashRoyale = lazy(() => import("./pages/SplashRoyale.tsx"));
const BetterFortnite = lazy(() => import("./pages/BetterFortnite.tsx"));
const VibeKart = lazy(() => import("./pages/VibeKart.tsx"));
const TheDeep = lazy(() => import("./pages/TheDeep.tsx"));
const FiveNights = lazy(() => import("./pages/FiveNights.tsx"));
const BlueAngels = lazy(() => import("./pages/BlueAngels.tsx"));
const ISpy = lazy(() => import("./pages/ISpy.tsx"));
const Airplane = lazy(() => import("./pages/Airplane.tsx"));
const StarTrek = lazy(() => import("./pages/StarTrek.tsx"));
const StrangeNewWorlds = lazy(() => import("./pages/StrangeNewWorlds.tsx"));
const HomeAlone = lazy(() => import("./pages/HomeAlone.tsx"));
const BlobWorld = lazy(() => import("./pages/Blob.tsx"));
const Coil = lazy(() => import("./pages/Coil.tsx"));
const Twenty48 = lazy(() => import("./pages/Twenty48.tsx"));
const MortsMaze = lazy(() => import("./pages/MortsMaze.tsx"));
const VibeCup = lazy(() => import("./pages/VibeCup.tsx"));
const RunVibeyRun = lazy(() => import("./pages/RunVibeyRun.tsx"));
const Empyrean = lazy(() => import("./pages/Empyrean.tsx"));
const Dipsea = lazy(() => import("./pages/Dipsea.tsx"));
const Airship = lazy(() => import("./pages/Airship.tsx"));
const DeveloperTrail = lazy(() => import("./pages/DeveloperTrail.tsx"));
const Duck = lazy(() => import("./pages/Duck.tsx"));
const Goggles = lazy(() => import("./pages/Goggles.tsx"));
const Agentocracy = lazy(() => import("./pages/Agentocracy.tsx"));
const Mars = lazy(() => import("./pages/Mars.tsx"));
const Phangan = lazy(() => import("./pages/Phangan.tsx"));
const CoastRoad = lazy(() => import("./pages/CoastRoad.tsx"));
const Beck = lazy(() => import("./pages/Beck.tsx"));
const Bots = lazy(() => import("./pages/Bots.tsx"));

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

  /* `/play/:slug` frames somebody else's game and draws its own bar across the
     top — title, author, what it has paid, and the way back. A second exit
     floating over a stranger's canvas would be one too many, and the route is
     dynamic so the registry's route-set cannot express it. */
  if (pathname.startsWith("/play/")) return null;

  /* `/homes/:id` is a front-door bake-off: each candidate draws its own nav,
     its own palette and its own idea of a header, so the global chrome would
     be a second nav sitting on top of the thing being judged. The picker's own
     bar is the way out, and `/homes` itself keeps normal chrome. */
  if (pathname.startsWith("/homes/")) return null;
  /* Same for the cover-art directions at `/redesign`: each draws its own nav. */
  if (pathname.startsWith("/redesign")) return null;
  /* The front door draws its own header too; only the radio stays, so a track
     started elsewhere keeps playing. The App Store edition keeps the flat grid
     and the normal nav. */
  if (pathname === "/" && !IOS_APP) return <VibeRadio />;

  /* OAuth landing pads. Nobody is *at* these — they are a second of spinner
     between a provider and wherever the visitor was actually going. Chrome
     here means the nav paints "Log in" over somebody mid-login, and the radio
     starts a track they will navigate away from before the first bar. */
  if (pathname.startsWith("/auth/")) return null;

  return (
    <>
      <GlobalNav />
      <VibeRadio />
    </>
  );
};

/** The near-black the app sits on. Anything not opted out of it gets this. */
const DEFAULT_BACKDROP = "#05060f";

/**
 * What you look at while a world's chunk is in flight.
 *
 * A flash of white between tapping a card and a world booting reads as a bug,
 * so the fallback paints the colour that world is about to paint — its
 * `backdrop` in the registry, which is the same one list everything else is a
 * view of. Worlds that never set one get the app's own near-black, which is
 * right for almost all of them; Splash Royale sets sky blue because that is
 * what it opens on and black would be a stutter.
 *
 * It is deliberately silent — no spinner, no "Loading…". These chunks arrive
 * in a few hundred milliseconds on anything but the worst connection, and a
 * spinner that appears and vanishes that fast is worse than nothing. The
 * worlds themselves own the real loading screens, because they are the ones
 * that take seconds.
 */
const RouteFallback = () => {
  const { pathname } = useLocation();
  const backdrop = worldByRoute(pathname)?.backdrop ?? DEFAULT_BACKDROP;
  return <div className="fixed inset-0" style={{ background: backdrop }} />;
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
          {/* Deliberately OUTSIDE AppChrome, which renders nothing on the
              chromeless routes — and chromeless routes are precisely the
              full-screen worlds where nearly every first visit happens. It
              takes no pointer events and sits above everything, so it can play
              over a crosshair without becoming part of the game. */}
          <ExplorerStamp />
          {/* Anonymous playtime and frame rate for whichever world is on
              screen, and the lore / fun / smooth card once you are back out.
              See src/lib/worldStats.ts. */}
          <PlayTracker />
          <RatePrompt />
          {/* Build mode: admins type a change to the world they are in, and a
              coding agent ships it. Renders nothing for anybody else, and
              nothing outside the worlds it covers. See src/build-mode. */}
          <BuildModeLauncher />
          {/* iOS app only: terms gate, report/block, App Store edition routing. */}
          <SafetyLayer />
          {/* One Suspense for the whole router. There used to be fifteen of
              them, one per lazy world, each with its own hand-typed hex — and
              the moment every route went lazy that would have been forty. */}
          <Suspense fallback={<RouteFallback />}>
          <Routes>
          {/* The grid of every world is the landing page. It is the clearest
              way to see what exists in one glance, and one tap gets you in.
              The 3D lobbies (/terminal, /lobby-3d) are the second way in.
              "/", "/game" and "/worlds" are all the same page — one grid, three
              names, because there is no version of this where two different
              grids of the same worlds stay in agreement. */}
          <Route path="/" element={<Home />} />
          {/* Bot Battle: X handle -> bot -> one RPS match -> share card. */}
          <Route path="/bots" element={<Bots />} />
          <Route path="/bot" element={<Bots />} />
          {/* Old Edge Esmeralda splash, kept reachable for those who want it. */}
          <Route path="/welcome" element={<Index />} />
          {/* Mario-Kart-style character + vehicle picker. */}
          <Route path="/lobby" element={<Lobby />} />
          {/* 3D About — narrative + carousel of characters. */}
          <Route path="/about" element={<About />} />
          {/* Community terms and privacy policy; the App Store listing and the iOS terms gate link here. */}
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          {/* Spotify OAuth (PKCE) callback. */}
          <Route path="/auth/spotify" element={<SpotifyCallback />} />
          {/* Where Google drops you off. One fixed path rather than one per
              route, because every one of them has to be pasted into Supabase's
              redirect allow list by hand. */}
          <Route path="/auth/callback" element={<AuthCallback />} />
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
          {/* One page about the currency, on three URLs. /wallet used to be
              a second page saying overlapping things; it is an alias now
              rather than a redirect, so an old link lands on content instead
              of on a flash of somewhere else. */}
          <Route path="/coin" element={<VibeHub />} />
          <Route path="/vibe" element={<VibeHub />} />
          <Route path="/wallet" element={<VibeHub />} />
          {/* VIBE ARCADE — the first place Vibecoin is spent rather than
              earned. Three coin-operated cabinets; the insert debits the real
              ledger and the payout is settled server-side. */}
          <Route path="/arcade" element={<VibeArcade />} />
          <Route path="/arcade/characters" element={<ArcadeCharacters />} />

          {/* The portal: games hosted somewhere else, paying real Vibey Coins.
              `/build` is the page you send somebody who wants in. */}
          <Route path="/play/:slug" element={<PortalPlay />} />
          {/* Blob Battle earns a short route of its own because it is a world
              card in the registry, and a card has to point at something the
              router serves literally. The frame still lives at /play. */}
          <Route path="/blob-battle" element={<Navigate to="/play/blob-battle" replace />} />
          <Route path="/blobbattle" element={<Navigate to="/play/blob-battle" replace />} />
          <Route path="/chronicle" element={<Chronicle />} />
          <Route path="/history" element={<Chronicle />} />
          <Route path="/build" element={<BuildAGame />} />
          <Route path="/build-a-game" element={<BuildAGame />} />
          {/* One field: a repo link or a deployed link. `/submit-world` is a
              different, older thing — it lists a world in the hub. This puts a
              playable game on the arcade shelf. */}
          <Route path="/submit-game" element={<SubmitGame />} />
          <Route path="/submit-a-game" element={<SubmitGame />} />
          <Route path="/admin/games" element={<AdminGames />} />
          {/* Lore, fun, smooth and hours played for every world. */}
          <Route path="/scores" element={<Scores />} />
          <Route path="/whats-new" element={<WhatsNew />} />
          <Route path="/whatsnew" element={<Navigate to="/whats-new" replace />} />
          <Route path="/changelog" element={<Navigate to="/whats-new" replace />} />
          <Route path="/scoreboard" element={<Scores />} />
          {/* THE VIBE SHOP — the other half of the arcade. Coins won there buy
              something here that is recorded against your wallet rather than
              your browser, so it survives a cleared history and a new device. */}
          <Route path="/shop" element={<VibeShop />} />

          {/* The same stock, in a darker room. A skin over `characterShop.ts`
              and `CATALOG`, not a second shop — see the note at the top of
              ShopCosmos for why that distinction is the whole point. */}
          <Route path="/shop/cosmos" element={<ShopCosmos />} />
          <Route path="/cosmos" element={<Navigate to="/shop/cosmos" replace />} />

          {/* Why any of this exists. The page to send somebody first. */}
          <Route path="/manifesto" element={<Manifesto />} />

          {/* The one record that spans every world. */}
          <Route path="/passport" element={<Passport />} />

          {/* Pick the front door's typography. A preview surface, not a
              setting — it goes away once one of the six wins. */}
          <Route path="/homes" element={<Homes />} />
          <Route path="/homes/:id" element={<HomeThemePage />} />
          {/* Three cover-art directions for the front door, picked by Jack. */}
          <Route path="/redesign" element={<Redesign />} />
          <Route path="/redesign/:id" element={<Redesign />} />
          <Route path="/looks" element={<HomeLooks />} />
          <Route path="/stamps" element={<Navigate to="/passport" replace />} />
          <Route path="/future" element={<Navigate to="/manifesto" replace />} />
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
          {/* /world is a friendly short URL for Vibe City. */}
          <Route path="/world" element={<City />} />
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
          {/* Every edition has an address of its own. The feed points at
              these, and a back issue can be sent to somebody. */}
          <Route path="/times/:issueNo" element={<VibeTimes />} />
          {/* …and the floor it is put together on. */}
          <Route path="/newsroom" element={<Newsroom />} />
          <Route path="/press" element={<Newsroom />} />
          <Route path="/worlds" element={<Game />} />
          {/* San Francisco: Free Fall — open-world shooter, real SF geometry. */}
          <Route path="/sf" element={<SanFrancisco />} />
          <Route path="/san-francisco" element={<SanFrancisco />} />
          <Route path="/free-fall" element={<SanFrancisco />} />
          <Route path="/frisco" element={<VibeFrancisco />} />
          <Route path="/vibe-francisco" element={<VibeFrancisco />} />
          <Route path="/toy-sf" element={<VibeFrancisco />} />
          {/* THE TERMINAL — the front door. Stand in the sky, pick a world. */}
          <Route path="/terminal" element={<Terminal />} />
          {/* Vibe Island II — the floating archipelago, rebuilt. */}
          {/* Horizon Garden: a walkable opportunity map of the future. */}
          <Route path="/horizon" element={<Horizon />} />
          <Route path="/horizon-garden" element={<Horizon />} />
          {/* Venus Rising: a city floating in the clouds of Venus, 54 km up. */}
          <Route path="/venus" element={<Venus />} />
          <Route path="/venus-rising" element={<Venus />} />
          <Route path="/cloud-city" element={<Venus />} />
          <Route path="/aphrodite" element={<Venus />} />
          <Route path="/conservatory" element={<Conservatory />} />
          <Route path="/glasshouse" element={<Conservatory />} />

          {["/fogcity", "/fog-city"].map((path) => (
            <Route key={path} path={path} element={<FogCity />} />
          ))}
          {["/boxing", "/box", "/haymaker", "/punch"].map((path) => (
            <Route key={path} path={path} element={<Boxing />} />
          ))}
          {["/cannon-run", "/cannon-chase", "/cannonchase", "/cannonrun", "/car-chase", "/chase"].map((path) => (
            <Route key={path} path={path} element={<CannonRun />} />
          ))}
          <Route path="/gatch/:id" element={<GatchClip />} />
          {["/thalassa", "/harbor", "/harbour", "/greek-harbor"].map((path) => (
            <Route key={path} path={path} element={<Thalassa />} />
          ))}
          <Route path="/island-2" element={<VibeIsland2 />} />
          <Route path="/vibe-island-2" element={<VibeIsland2 />} />
          {/* San Palmas — tropical San Francisco. The vibeverse's open-world FPS. */}
          <Route path="/first-light" element={<FirstLight />} />
          <Route path="/lake" element={<FirstLight />} />
          <Route path="/san-palmas" element={<SanPalmas />} />
          <Route path="/fps" element={<SanPalmas />} />
          {/* SEAFAIR 2117 — future Seattle during Seafair. Hydros, Blue Angels,
              and aliens holding the Space Needle. */}
          <Route path="/seafair" element={<Seafair />} />
          {/* THE GLASS LAKE — black ice at night under a live aurora. The sky
              is a raymarched function and the ice reflects it by calling the
              same function along the reflected ray. Skate, carve, collect. */}
          <Route path="/glass-lake" element={<GlassLake />} />
          {/* THE DUNE SEA — sandboarding a bowl of dunes with the sunset as
              the clock. The terrain is one function, sampled by the mesh and
              by the board's physics, so they cannot disagree. */}
          <Route path="/dunes" element={<DuneSea />} />
          <Route path="/dune-sea" element={<DuneSea />} />
          <Route path="/aurora" element={<GlassLake />} />
          {/* THE VIBEVERSE — the hub seen from orbit. Fly the survey vessel VIBEY
              through a procedural galaxy where three of the stars are real
              destinations, and land on one to walk into it. /long-silence stays
              wired up: it was the route before the remix and links exist.
              Desktop and a real GPU. */}
          {["/vibeverse", "/explorer", "/long-silence"].map((path) => (
            <Route key={path} path={path} element={<VibeverseExplorer />} />
          ))}
          {/* DROP ZERO — battle royale. Bus, island, storm, and the build loop.
              /royale and /br are aliases; the world calls itself Drop Zero. */}
          {["/drop-zero", "/royale", "/br"].map((path) => (
            <Route key={path} path={path} element={<DropZero />} />
          ))}
          {/* SOAKED — the water-gun cut of Drop Zero. Same island, same 22
              systems, `mode: "water"`. Multiplayer: a room code in the URL
              (?room=SPLASH-4B2) drops a friend straight into your match. */}
          {["/splash-royale", "/splash", "/soaked", "/water-fight", "/soak"].map((path) => (
            <Route key={path} path={path} element={<SplashRoyale />} />
          ))}
          {/* BETTER FORTNITE — the third game on the island. Same page, same
              systems, `mode: "better"`, which the page reads off the path:
              augments, a grapple, a second wind, island events. */}
          {["/better-fortnite", "/better", "/bf", "/better-royale"].map((path) => (
            <Route key={path} path={path} element={<BetterFortnite />} />
          ))}
          {/* FIVE NIGHTS AT VIBEY'S — midnight to 6 AM, two doors, one battery.
              Four animatronics walk a real twelve-room building; the security
              cameras are cameras standing in it. */}
          {["/fnaf", "/five-nights"].map((path) => (
            <Route key={path} path={path} element={<FiveNights />} />
          ))}
          {/* Vibe Golf — physics golf with portals, jetpacks and silly balls. */}
          <Route path="/golf" element={<VibeGolf />} />
          {/* Vibe Kart — arcade kart racing: drift, mini-turbos, shells.
              Single player and multiplayer are the same route: the title screen
              picks, and `?room=CODE` is an invite straight into a lobby.
              `/kart-mp` was the old multiplayer world and still answers. */}
          {["/kart", "/kart-mp"].map((path) => (
            <Route key={path} path={path} element={<VibeKart />} />
          ))}
          {/* THE MIDNIGHT ZONE — a submersible descent to the floor of the
              trench, where the only light is the light things make. */}
          {["/deep", "/midnight-zone", "/abyss"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<div className="fixed inset-0 bg-[#020913]" />}>
                  <TheDeep />
                </Suspense>
              }
            />
          ))}
          {/* BLUE ANGELS — Seafair over Lake Washington. You fly number 1 and
              the other five fly your wing, over a real Seattle. */}
          {["/blue-angels", "/angels", "/seafair-show"].map((path) => (
            <Route key={path} path={path} element={<BlueAngels />} />
          ))}
          {/* I SPY — the Geometry Dash level, in 2D, in the vibeverse. One
              button, sixty seconds, and a screen full of spikes that are not
              there. */}
          {["/i-spy", "/ispy", "/geometry-dash", "/i-spy/spire"].map((path) => (
            <Route key={path} path={path} element={<ISpy />} />
          ))}
          {/* BLOB — the petri dish. Eat pellets, dodge anything bigger, split
              to catch what runs. Twenty-four bots, one dish, phone or desktop.
              /agar and /agario answer because that is what people type. */}
          {["/blob", "/agar", "/agario", "/cells"].map((path) => (
            <Route key={path} path={path} element={<BlobWorld />} />
          ))}
          {/* COIL — slither, with the character you bought in the shop riding
              the front of the snake. /slither and /snake answer because that is
              what people type. */}
          {["/coil", "/slither", "/snake", "/worm"].map((path) => (
            <Route key={path} path={path} element={<Coil />} />
          ))}
          {/* MORT'S MAZE: a maze chase on Vibe Island. Eat the Vibey Coins,
              dodge Mad Mort's crew, soak them with a water balloon. */}
          {["/mort-maze", "/maze", "/chomp", "/munch"].map((path) => (
            <Route key={path} path={path} element={<MortsMaze />} />
          ))}
          {/* VIBE CUP: five-a-side arcade soccer in a cage. One player or two. */}
          {["/vibe-cup", "/soccer", "/football", "/futbol", "/kickabout"].map((path) => (
            <Route key={path} path={path} element={<VibeCup />} />
          ))}
          {/* NEON 2048 — the sliding-tile game in BLOB's colours. Swipe on a
              phone, arrows on a desktop, and the 2048 tile is virus green. */}
          {["/2048", "/twenty48", "/merge"].map((path) => (
            <Route key={path} path={path} element={<Twenty48 />} />
          ))}
          {/* HOUSE RULES: a trap-laying home defence game. Plan a night, lay
              the kit on the routes, then chain one trap into the next.
              /home-alone is where it used to live. */}
          {["/house-rules", "/home-alone", "/traps"].map((path) => (
            <Route key={path} path={path} element={<HomeAlone />} />
          ))}
          {/* AIRPLANE! — Trans American 209, LAX to Chicago. The crew had the
              fish. You are in the left seat of a 707 in a thunderstorm, and
              there are 187 people behind you. */}
          {["/airplane", "/flight-209", "/209"].map((path) => (
            <Route key={path} path={path} element={<Airplane />} />
          ))}
          {/* THE FINAL FRONTIER — you are the captain of a Constitution-class
              starship, and the main viewscreen is a live render of the space
              your ship is actually flying through. Five episodes. */}
          {["/trek", "/star-trek", "/final-frontier"].map((path) => (
            <Route key={path} path={path} element={<StarTrek />} />
          ))}
          {/* STRANGE NEW WORLDS — the other half of Star Trek. Twelve real
              systems on a real chart, a fold from one to the next, orbit, a
              sensor sweep, and then the transporter puts you down in front of
              somebody who will talk back. */}
          {["/strange-new-worlds", "/snw", "/starfleet"].map((path) => (
            <Route key={path} path={path} element={<StrangeNewWorlds />} />
          ))}
          {/* RUN, VIBEY, RUN — a whole life, at a run. Six chapters: the road
              out of Greenbow, a kickoff return, the treeline, a ping-pong
              match, the shrimp boat, and then across America. */}
          {["/run", "/gump", "/forrest"].map((path) => (
            <Route key={path} path={path} element={<RunVibeyRun />} />
          ))}
          {/* THE EMPYREAN — a city of glass on a rock that never landed, four
              hundred metres over a frozen lake that reflects the whole of it.
              Vibe City's jetpack, Vibe Island's cast, and a sunset. */}
          {["/empyrean", "/floating-city", "/skycity"].map((path) => (
            <Route key={path} path={path} element={<Empyrean />} />
          ))}
          {/* THE DIPSEA — Mill Valley to Stinson Beach on foot, over Mount Tam,
              with the real course profile under your feet. Effort is the only
              control; the hills, the bottle and mile four do the rest. */}
          {["/dipsea", "/quad-dipsea"].map((path) => (
            <Route key={path} path={path} element={<Dipsea />} />
          ))}
          {/* PATHFINDER — a 406-foot rigid airship over San Francisco Bay.
              Helium up, ballast down, wind from the Gate, five relief drops
              and a landing at Moffett. Everything happens twenty seconds late. */}
          {["/airship", "/pathfinder"].map((path) => (
            <Route key={path} path={path} element={<Airship />} />
          ))}
          {/* DEVELOPER TRAIL — Oregon Trail, but the wagon is a nine-lot
              cottage project and the chance cards are real. Two inks on paper;
              the rules are a pure state machine in src/devtrail. */}
          {["/developer-trail", "/devtrail"].map((path) => (
            <Route key={path} path={path} element={<DeveloperTrail />} />
          ))}
          {/* DUCK ON MY HEAD — a house party from Vibey's own camera. Look at
              whoever is talking, keep the hotspot alive, and never read a
              sub-agent's message out over somebody's sentence. */}
          {["/duck", "/vibey-party"].map((path) => (
            <Route key={path} path={path} element={<Duck />} />
          ))}
          {/* THE HALF-BLIND TRIATHLON: Lake Chelan through goggles that fogged
              on the first stroke, a bike with no top gear and no brakes, and a
              run on shoes with no cushion left. The rules are pure in src/goggles. */}
          {["/goggles", "/triathlon"].map((path) => (
            <Route key={path} path={path} element={<Goggles />} />
          ))}
          {/* AGENTOCRACY: a cardboard Bainbridge Island run by fifty AI agents
              with a treasury in Snack Bay tokens. The ferry horn opens a round;
              delegate, override or abstain, and the WHEEL meter remembers. */}
          {["/agentocracy", "/cardboard-city", "/bainbridge"].map((path) => (
            <Route key={path} path={path} element={<Agentocracy />} />
          ))}
          {/* MARS COLLEGE: ten weeks off-grid near the Salton Sea on an electric
              unicycle. Six camps, one table, water in town, solar that dies,
              dust storms off the sea, and a teardown at the end of week ten. */}
          {["/mars", "/mars-college", "/bombay-beach"].map((path) => (
            <Route key={path} path={path} element={<Mars />} />
          ))}
          {/* FLOW PHANGAN: a month on Koh Phangan as one afternoon on a scooter.
              Six guests, one secret meetup, the rain from the east and Muay
              Thai at 8:30 whether you are ready or not. Rules in src/phangan. */}
          {["/phangan", "/koh-phangan", "/flow-phangan"].map((path) => (
            <Route key={path} path={path} element={<Phangan />} />
          ))}
          {/* COAST ROAD: a longboard down a headland to the sea, in a painted
              look and an action-camera look. The road and the wind are pure in
              src/coastroad/road.ts; the paint is the only thing that changes. */}
          {["/coast-road", "/longboard", "/skate", "/downhill"].map((path) => (
            <Route key={path} path={path} element={<CoastRoad />} />
          ))}
          {/* BECK ROAD: the real neighbourhood around 8330 NE Beck Road on
              Bainbridge Island, rebuilt from Overture and OpenStreetMap data
              with the terrain tiles under it. Data and geometry in src/beck. */}
          {["/beck-road", "/beck", "/lytle-beach", "/blakely"].map((path) => (
            <Route key={path} path={path} element={<Beck />} />
          ))}
          {/* THE MAGICIAN: a valley in Japan you talk to. Vibey, a wizard's hat,
              and OpenAI's realtime voice with tools that rewrite the world as
              you speak. State, tools and renderer in src/magician. */}
          {["/magician", "/vibe-magician", "/hoshimura", "/genie"].map((path) => (
            <Route key={path} path={path} element={<Magician />} />
          ))}
          {/* ONI: infection tag at a summer festival, for a whole room at once.
              Phones, laptops and headsets in one square; ?show is the
              projector with the QR code. Rules, net and engine in src/oni. */}
          {["/zombies", "/zombie", "/oni", "/tag", "/oni-gokko"].map((path) => (
            <Route key={path} path={path} element={<Oni />} />
          ))}
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
        </VibeIdentityProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
