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
import golfArt from "@/assets/worlds/golf.jpg";
import islandArt from "@/assets/worlds/island.jpg";
import vibeIslandArt from "@/assets/worlds/vibe-island.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import moonArt from "@/assets/worlds/moon.jpg";
import museumArt from "@/assets/worlds/museum.jpg";
import ninjaArt from "@/assets/worlds/ninja.jpg";
import sanFranciscoArt from "@/assets/worlds/san-francisco.jpg";
import sanPalmasArt from "@/assets/worlds/san-palmas.jpg";
import dropZeroArt from "@/assets/worlds/drop-zero.jpg";
import splashRoyaleArt from "@/assets/worlds/splash-royale.jpg";
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
import fnafArt from "@/assets/worlds/fnaf.jpg";
import homeAloneArt from "@/assets/worlds/home-alone.jpg";
import iSpyArt from "@/assets/worlds/i-spy.jpg";
import strangeNewWorldsArt from "@/assets/worlds/strange-new-worlds.jpg";
import kartArt from "@/assets/worlds/kart.jpg";
import runArt from "@/assets/worlds/run.jpg";
import trekArt from "@/assets/worlds/final-frontier.jpg";

export const WORLD_ART: Record<string, string> = {
  about: aboutArt,
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
  fnaf: fnafArt,
  "home-alone": homeAloneArt,
  run: runArt,
  "i-spy": iSpyArt,
  "strange-new-worlds": strangeNewWorldsArt,
  kart: kartArt,
  trek: trekArt,
  city: cityArt,
  "edm-town": edmTownArt,
  evolve: evolveArt,
  garden: gardenArt,
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
  "san-palmas": sanPalmasArt,
  "drop-zero": dropZeroArt,
  "splash-royale": splashRoyaleArt,
  ski: skiArt,
  space: spaceArt,
  terminal: terminalArt,
  chronicle: chronicleArt,
  coin: vibeArt,
  "island-2": vibeIsland2Art,
  vibeverse: vibeverseArt,
  village: villageArt,
  // Deliberately absent, and each for the same reason — no honest capture yet:
  //   seafair  · still being art-directed
  //   globetrotter, go, agent-lobby, times, companions, world-builder,
  //   submit-world, characters, vibestar
};

/** Card art for a world, or undefined when there is no honest capture. */
export const artFor = (key: string): string | undefined => WORLD_ART[key];
