/**
 * Card art, keyed by world key.
 *
 * Split out of `registry.ts` on purpose: the registry is imported by the
 * passport and by the vendored ship, and neither of those should pull a
 * megabyte of JPEGs into its chunk just to know a world's name.
 *
 * Every image in here is a real capture from the running world. A world whose
 * capture only ever produces a broken frame gets *no* entry, and the surfaces
 * fall back to a drawn panel — misleading card art is worse than none. Recapture
 * with `node scripts/route-shot.mjs <route> src/assets/worlds/<key>.jpg` when a
 * world changes enough that its card starts lying.
 */
import aboutArt from "@/assets/worlds/about.jpg";
import cityArt from "@/assets/worlds/city.jpg";
import edmTownArt from "@/assets/worlds/edm-town.jpg";
import evolveArt from "@/assets/worlds/evolve.jpg";
import gardenArt from "@/assets/worlds/garden.jpg";
import dunesArt from "@/assets/worlds/dunes.jpg";
import glassLakeArt from "@/assets/worlds/glass-lake.jpg";
import golfArt from "@/assets/worlds/golf.jpg";
import islandArt from "@/assets/worlds/island.jpg";
import vibeIslandArt from "@/assets/worlds/vibe-island.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import moonArt from "@/assets/worlds/moon.jpg";
import museumArt from "@/assets/worlds/museum.jpg";
import ninjaArt from "@/assets/worlds/ninja.jpg";
import sanFranciscoArt from "@/assets/worlds/san-francisco.jpg";
import friscoArt from "@/assets/worlds/frisco.jpg";
import sanPalmasArt from "@/assets/worlds/san-palmas.jpg";
import firstLightArt from "@/assets/worlds/first-light.jpg";
import dropZeroArt from "@/assets/worlds/drop-zero.jpg";
import splashRoyaleArt from "@/assets/worlds/splash-royale.jpg";
import betterFortniteArt from "@/assets/worlds/better-fortnite.jpg";
import skiArt from "@/assets/worlds/ski.jpg";
import spaceArt from "@/assets/worlds/space.jpg";
import terminalArt from "@/assets/worlds/terminal.jpg";
import vibeArt from "@/assets/worlds/vibe.jpg";
import vibeIsland2Art from "@/assets/worlds/vibe-island-2.jpg";
import vibeverseArt from "@/assets/worlds/vibeverse-explorer.jpg";
import villageArt from "@/assets/edge-app-icon-bg.png";
import airplaneArt from "@/assets/worlds/airplane.jpg";
import arcadeArt from "@/assets/worlds/arcade.jpg";
import orbitArt from "@/assets/worlds/orbit.jpg";
import shopArt from "@/assets/worlds/shop.jpg";
import portalArt from "@/assets/worlds/portal.jpg";
import manifestoArt from "@/assets/worlds/manifesto.jpg";
import chronicleArt from "@/assets/worlds/chronicle.jpg";
import blobArt from "@/assets/worlds/blob.jpg";
import coilArt from "@/assets/worlds/coil.jpg";
import twenty48Art from "@/assets/worlds/2048.jpg";
import blueAngelsArt from "@/assets/worlds/blue-angels.jpg";
import conservatoryArt from "@/assets/worlds/conservatory.jpg";
import fnafArt from "@/assets/worlds/fnaf.jpg";
import homeAloneArt from "@/assets/worlds/home-alone.jpg";
import iSpyArt from "@/assets/worlds/i-spy.jpg";
import strangeNewWorldsArt from "@/assets/worlds/strange-new-worlds.jpg";
import deepArt from "@/assets/worlds/deep.jpg";
import kartArt from "@/assets/worlds/kart.jpg";
import runArt from "@/assets/worlds/run.jpg";
import trekArt from "@/assets/worlds/final-frontier.jpg";
import seafairArt from "@/assets/worlds/seafair.jpg";
import newsroomArt from "@/assets/worlds/newsroom.jpg";
import vibestarArt from "@/assets/worlds/vibestar.jpg";
import empyreanArt from "@/assets/worlds/empyrean.jpg";
import dipseaArt from "@/assets/worlds/dipsea.jpg";
import airshipArt from "@/assets/worlds/airship.jpg";
import developerTrailArt from "@/assets/worlds/developer-trail.jpg";
import duckArt from "@/assets/worlds/duck.jpg";
import agentocracyArt from "@/assets/worlds/agentocracy.jpg";

export const WORLD_ART: Record<string, string> = {
  about: aboutArt,
  empyrean: empyreanArt,
  dipsea: dipseaArt,
  airship: airshipArt,
  "developer-trail": developerTrailArt,
  duck: duckArt,
  agentocracy: agentocracyArt,
  arcade: arcadeArt,
  orbit: orbitArt,
  shop: shopArt,
  portal: portalArt,
  manifesto: manifestoArt,
  airplane: airplaneArt,
  blob: blobArt,
  coil: coilArt,
  "2048": twenty48Art,
  "blue-angels": blueAngelsArt,
  conservatory: conservatoryArt,
  fnaf: fnafArt,
  "home-alone": homeAloneArt,
  run: runArt,
  "i-spy": iSpyArt,
  "strange-new-worlds": strangeNewWorldsArt,
  deep: deepArt,
  kart: kartArt,
  trek: trekArt,
  city: cityArt,
  "edm-town": edmTownArt,
  evolve: evolveArt,
  garden: gardenArt,
  dunes: dunesArt,
  "glass-lake": glassLakeArt,
  golf: golfArt,
  /* Vibe Island and Island Explorer used to share one capture. They are
     different worlds, and after the grass pass they no longer even look
     alike — so Vibe Island has its own frame now (`scripts/island-card.mjs`)
     and Island Explorer keeps the old one. */
  island: vibeIslandArt,
  "island-explorer": islandArt,
  lobby: lobbyArt,
  moon: moonArt,
  museum: museumArt,
  ninja: ninjaArt,
  sf: sanFranciscoArt,
  frisco: friscoArt,
  "san-palmas": sanPalmasArt,
  "first-light": firstLightArt,
  "drop-zero": dropZeroArt,
  "splash-royale": splashRoyaleArt,
  /* A real frame from the running world: Neon Heights plaza with a hand of
     augments dealt and the grapple pip beside the crosshair. */
  "better-fortnite": betterFortniteArt,
  ski: skiArt,
  space: spaceArt,
  terminal: terminalArt,
  chronicle: chronicleArt,
  coin: vibeArt,
  "island-2": vibeIsland2Art,
  vibeverse: vibeverseArt,
  village: villageArt,
  seafair: seafairArt,
  vibestar: vibestarArt,
  /* The newsroom is the one paper-shaped thing in here with a card, and the
     rule below is why: `times` is a front page, which is a document, and a
     photograph of a document is just the document again, smaller and
     unreadable. The newsroom is a room. */
  newsroom: newsroomArt,
  // Deliberately absent, and no longer all for the same reason:
  //
  //   globetrotter, go   · both draw the real Earth from map tiles, so a
  //     capture taken anywhere the tiles do not load is a black rectangle with
  //     "NO SATELLITE SIGNAL" in the middle of it. That is a picture of the
  //     network, not of the world. Capture these from a machine that can reach
  //     Mapbox and they will look like what they are.
  //   blob-battle        · not ours. It is a guest game the portal frames from
  //     its author's own host, so its cover belongs in `vibe_portal_games`
  //     next to the game, not screenshotted into our assets folder.
  //   agent-lobby, times, companions, world-builder, submit-world, characters,
  //   passport           · tools rather than places. A card for a form does not
  //     want a photograph of the form.
};

/** Card art for a world, or undefined when there is no honest capture. */
export const artFor = (key: string): string | undefined => WORLD_ART[key];
