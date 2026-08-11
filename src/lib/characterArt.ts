/**
 * Portraits, keyed by character id.
 *
 * Same idea as `src/worlds/art.ts` one level down: the data about what is for
 * sale lives in `characterShop.ts`, which is imported by things that must stay
 * light, and the pictures live here so importing a price does not drag half a
 * megabyte of PNG into a chunk.
 *
 * Every image is a render of the real rig, produced by
 * `node scripts/character-shots.mjs`. Nobody draws these by hand, which is the
 * point: a portrait cannot flatter a design or fall behind a change to it.
 * Re-run the script after editing `PILOT_DESIGNS` — a stale portrait is the
 * one way a character can lie about itself, because everything else you see of
 * it is built at runtime from the same table.
 *
 * The backgrounds are transparent. The tint under a portrait is CSS, so the
 * violet shelf, the starfield grid and whatever comes next all share one file
 * per character instead of one file per character per surface.
 */
import auroraArt from "@/assets/characters/aurora.png";
import bumbleArt from "@/assets/characters/bumble.png";
import chromeArt from "@/assets/characters/chrome.png";
import eddieArt from "@/assets/characters/eddie.png";
import grimlockArt from "@/assets/characters/grimlock.png";
import pixelArt from "@/assets/characters/pixel.png";
import sableArt from "@/assets/characters/sable.png";
import spaceRexArt from "@/assets/characters/space-rex.png";
import vibePoliceArt from "@/assets/characters/vibe-police.png";
/* The body-plan five. Free rather than stock, but they still want portraits:
   the picker and the profile draw the same tile the shelf does, and a
   character with no photograph falls back to a drawn panel that says nothing
   about what makes it different. */
import marshmallowArt from "@/assets/characters/marshmallow.png";
import ovoidArt from "@/assets/characters/ovoid.png";
import scrapArt from "@/assets/characters/scrap.png";
import sproutArt from "@/assets/characters/sprout.png";
import tuxedoArt from "@/assets/characters/tuxedo.png";
/* The wide cast. */
import boltArt from "@/assets/characters/bolt.png";
import pipArt from "@/assets/characters/pip.png";
import giltArt from "@/assets/characters/gilt.png";
import sentryArt from "@/assets/characters/sentry.png";
import wardenArt from "@/assets/characters/warden.png";
import bountyArt from "@/assets/characters/bounty.png";
import brambleArt from "@/assets/characters/bramble.png";
import elderArt from "@/assets/characters/elder.png";
import gonkArt from "@/assets/characters/gonk.png";
import medicArt from "@/assets/characters/medic.png";
import magnateArt from "@/assets/characters/magnate.png";
import bulwarkArt from "@/assets/characters/bulwark.png";
import emeraldArt from "@/assets/characters/emerald.png";
import voltaicArt from "@/assets/characters/voltaic.png";
import seraphArt from "@/assets/characters/seraph.png";
import vantablackArt from "@/assets/characters/vantablack.png";
import crimsonArt from "@/assets/characters/crimson.png";
import stingerArt from "@/assets/characters/stinger.png";
import titanArt from "@/assets/characters/titan.png";
import phaseArt from "@/assets/characters/phase.png";
import cinderArt from "@/assets/characters/cinder.png";
import frostbiteArt from "@/assets/characters/frostbite.png";
import mothlingArt from "@/assets/characters/mothling.png";
import jellyArt from "@/assets/characters/jelly.png";
import prickleArt from "@/assets/characters/prickle.png";
import toadstoolArt from "@/assets/characters/toadstool.png";
import origamiArt from "@/assets/characters/origami.png";
import ridgebackArt from "@/assets/characters/ridgeback.png";
import striderArt from "@/assets/characters/strider.png";
import haulerArt from "@/assets/characters/hauler.png";
/* The eight-legged, the airborne and the patterned. Free characters, but the
   picker draws the same tile the shelf does — and these are the ones whose
   whole argument is the shape, so a missing portrait costs them more than it
   costs a recoloured biped. They are also what COIL draws its bots from, which
   is a roster of exactly the ids in this file. */
import pinchArt from "@/assets/characters/pinch.png";
import hermitArt from "@/assets/characters/hermit.png";
import barnacleArt from "@/assets/characters/barnacle.png";
import widowArt from "@/assets/characters/widow.png";
import harvestArt from "@/assets/characters/harvest.png";
import rooArt from "@/assets/characters/roo.png";
import pogoArt from "@/assets/characters/pogo.png";
import cricketArt from "@/assets/characters/cricket.png";
import tabbyArt from "@/assets/characters/tabby.png";
import dappleArt from "@/assets/characters/dapple.png";
import basiliskArt from "@/assets/characters/basilisk.png";
import hexenArt from "@/assets/characters/hexen.png";
import gritArt from "@/assets/characters/grit.png";
import monarchArt from "@/assets/characters/monarch.png";

export const CHARACTER_ART: Record<string, string> = {
  aurora: auroraArt,
  bumble: bumbleArt,
  chrome: chromeArt,
  eddie: eddieArt,
  grimlock: grimlockArt,
  pixel: pixelArt,
  sable: sableArt,
  "space-rex": spaceRexArt,
  "vibe-police": vibePoliceArt,
  marshmallow: marshmallowArt,
  ovoid: ovoidArt,
  scrap: scrapArt,
  sprout: sproutArt,
  tuxedo: tuxedoArt,
  bolt: boltArt,
  pip: pipArt,
  gilt: giltArt,
  sentry: sentryArt,
  warden: wardenArt,
  bounty: bountyArt,
  bramble: brambleArt,
  elder: elderArt,
  gonk: gonkArt,
  medic: medicArt,
  magnate: magnateArt,
  bulwark: bulwarkArt,
  emerald: emeraldArt,
  voltaic: voltaicArt,
  seraph: seraphArt,
  vantablack: vantablackArt,
  crimson: crimsonArt,
  stinger: stingerArt,
  titan: titanArt,
  phase: phaseArt,
  cinder: cinderArt,
  frostbite: frostbiteArt,
  mothling: mothlingArt,
  jelly: jellyArt,
  prickle: prickleArt,
  toadstool: toadstoolArt,
  origami: origamiArt,
  ridgeback: ridgebackArt,
  strider: striderArt,
  hauler: haulerArt,
  pinch: pinchArt,
  hermit: hermitArt,
  barnacle: barnacleArt,
  widow: widowArt,
  harvest: harvestArt,
  roo: rooArt,
  pogo: pogoArt,
  cricket: cricketArt,
  tabby: tabbyArt,
  dapple: dappleArt,
  basilisk: basiliskArt,
  hexen: hexenArt,
  grit: gritArt,
  monarch: monarchArt,
};

/**
 * Undefined for anything unphotographed, which callers render as a drawn
 * fallback rather than a broken image. The free roster is sixty-odd GLBs and
 * is deliberately not in here — this is the shop's art, not the world's.
 */
export const characterArt = (id: string | null | undefined): string | undefined =>
  id ? CHARACTER_ART[id] : undefined;
