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
/* The five that were built from the rig but never photographed. Same reason as
   the body-plan five above: every surface that shows a character draws this
   tile, so an unphotographed one is a character that shows up as an emoji on
   a shelf full of renders. */
import fluxArt from "@/assets/characters/flux.png";
import webslingerArt from "@/assets/characters/webslinger.png";
import nightcapeArt from "@/assets/characters/nightcape.png";
import whiskersArt from "@/assets/characters/whiskers.png";
import emberwingArt from "@/assets/characters/emberwing.png";
/* The GLB half of the roster, photographed by the same script through
   `loadCharacterRig` — see `src/dev/characterShot.ts`. */
import glb_BlueSoldier_Female from "@/assets/characters/BlueSoldier_Female.png";
import glb_BlueSoldier_Male from "@/assets/characters/BlueSoldier_Male.png";
import glb_Casual2_Female from "@/assets/characters/Casual2_Female.png";
import glb_Casual2_Male from "@/assets/characters/Casual2_Male.png";
import glb_Casual3_Female from "@/assets/characters/Casual3_Female.png";
import glb_Casual3_Male from "@/assets/characters/Casual3_Male.png";
import glb_Casual_Bald from "@/assets/characters/Casual_Bald.png";
import glb_Casual_Female from "@/assets/characters/Casual_Female.png";
import glb_Casual_Male from "@/assets/characters/Casual_Male.png";
import glb_Chef_Female from "@/assets/characters/Chef_Female.png";
import glb_Chef_Male from "@/assets/characters/Chef_Male.png";
import glb_Cow from "@/assets/characters/Cow.png";
import glb_Cowboy_Female from "@/assets/characters/Cowboy_Female.png";
import glb_Cowboy_Male from "@/assets/characters/Cowboy_Male.png";
import glb_Doctor_Female_Old from "@/assets/characters/Doctor_Female_Old.png";
import glb_Doctor_Female_Young from "@/assets/characters/Doctor_Female_Young.png";
import glb_Doctor_Male_Old from "@/assets/characters/Doctor_Male_Old.png";
import glb_Doctor_Male_Young from "@/assets/characters/Doctor_Male_Young.png";
import glb_Elf from "@/assets/characters/Elf.png";
import glb_Goblin_Female from "@/assets/characters/Goblin_Female.png";
import glb_Goblin_Male from "@/assets/characters/Goblin_Male.png";
import glb_Kimono_Female from "@/assets/characters/Kimono_Female.png";
import glb_Kimono_Male from "@/assets/characters/Kimono_Male.png";
import glb_Knight_Golden_Female from "@/assets/characters/Knight_Golden_Female.png";
import glb_Knight_Golden_Male from "@/assets/characters/Knight_Golden_Male.png";
import glb_Knight_Male from "@/assets/characters/Knight_Male.png";
import glb_Ninja_Female from "@/assets/characters/Ninja_Female.png";
import glb_Ninja_Male from "@/assets/characters/Ninja_Male.png";
import glb_Ninja_Sand from "@/assets/characters/Ninja_Sand.png";
import glb_Ninja_Sand_Female from "@/assets/characters/Ninja_Sand_Female.png";
import glb_OldClassy_Female from "@/assets/characters/OldClassy_Female.png";
import glb_OldClassy_Male from "@/assets/characters/OldClassy_Male.png";
import glb_Pirate_Anne from "@/assets/characters/Pirate_Anne.png";
import glb_Pirate_Captain_Barbarossa from "@/assets/characters/Pirate_Captain_Barbarossa.png";
import glb_Pirate_Female from "@/assets/characters/Pirate_Female.png";
import glb_Pirate_Henry from "@/assets/characters/Pirate_Henry.png";
import glb_Pirate_Mako from "@/assets/characters/Pirate_Mako.png";
import glb_Pirate_Male from "@/assets/characters/Pirate_Male.png";
import glb_Pirate_Shark from "@/assets/characters/Pirate_Shark.png";
import glb_Pirate_Sharky from "@/assets/characters/Pirate_Sharky.png";
import glb_Pirate_Skeleton from "@/assets/characters/Pirate_Skeleton.png";
import glb_Pirate_Skeleton_Headless from "@/assets/characters/Pirate_Skeleton_Headless.png";
import glb_Pirate_Tentacle from "@/assets/characters/Pirate_Tentacle.png";
import glb_Pug from "@/assets/characters/Pug.png";
import glb_Soldier_Female from "@/assets/characters/Soldier_Female.png";
import glb_Soldier_Male from "@/assets/characters/Soldier_Male.png";
import glb_Suit_Female from "@/assets/characters/Suit_Female.png";
import glb_Suit_Male from "@/assets/characters/Suit_Male.png";
import glb_Viking_Female from "@/assets/characters/Viking_Female.png";
import glb_Viking_Male from "@/assets/characters/Viking_Male.png";
import glb_Witch from "@/assets/characters/Witch.png";
import glb_Wizard from "@/assets/characters/Wizard.png";
import glb_Worker_Female from "@/assets/characters/Worker_Female.png";
import glb_Worker_Male from "@/assets/characters/Worker_Male.png";
import glb_Zombie_Female from "@/assets/characters/Zombie_Female.png";
import glb_Zombie_Male from "@/assets/characters/Zombie_Male.png";
import glb_alien from "@/assets/characters/alien.png";
import glb_vibey from "@/assets/characters/vibey.png";

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
  flux: fluxArt,
  webslinger: webslingerArt,
  nightcape: nightcapeArt,
  whiskers: whiskersArt,
  emberwing: emberwingArt,
  // ---- the GLB roster --------------------------------------------------
  BlueSoldier_Female: glb_BlueSoldier_Female,
  BlueSoldier_Male: glb_BlueSoldier_Male,
  Casual2_Female: glb_Casual2_Female,
  Casual2_Male: glb_Casual2_Male,
  Casual3_Female: glb_Casual3_Female,
  Casual3_Male: glb_Casual3_Male,
  Casual_Bald: glb_Casual_Bald,
  Casual_Female: glb_Casual_Female,
  Casual_Male: glb_Casual_Male,
  Chef_Female: glb_Chef_Female,
  Chef_Male: glb_Chef_Male,
  Cow: glb_Cow,
  Cowboy_Female: glb_Cowboy_Female,
  Cowboy_Male: glb_Cowboy_Male,
  Doctor_Female_Old: glb_Doctor_Female_Old,
  Doctor_Female_Young: glb_Doctor_Female_Young,
  Doctor_Male_Old: glb_Doctor_Male_Old,
  Doctor_Male_Young: glb_Doctor_Male_Young,
  Elf: glb_Elf,
  Goblin_Female: glb_Goblin_Female,
  Goblin_Male: glb_Goblin_Male,
  Kimono_Female: glb_Kimono_Female,
  Kimono_Male: glb_Kimono_Male,
  Knight_Golden_Female: glb_Knight_Golden_Female,
  Knight_Golden_Male: glb_Knight_Golden_Male,
  Knight_Male: glb_Knight_Male,
  Ninja_Female: glb_Ninja_Female,
  Ninja_Male: glb_Ninja_Male,
  Ninja_Sand: glb_Ninja_Sand,
  Ninja_Sand_Female: glb_Ninja_Sand_Female,
  OldClassy_Female: glb_OldClassy_Female,
  OldClassy_Male: glb_OldClassy_Male,
  Pirate_Anne: glb_Pirate_Anne,
  Pirate_Captain_Barbarossa: glb_Pirate_Captain_Barbarossa,
  Pirate_Female: glb_Pirate_Female,
  Pirate_Henry: glb_Pirate_Henry,
  Pirate_Mako: glb_Pirate_Mako,
  Pirate_Male: glb_Pirate_Male,
  Pirate_Shark: glb_Pirate_Shark,
  Pirate_Sharky: glb_Pirate_Sharky,
  Pirate_Skeleton: glb_Pirate_Skeleton,
  Pirate_Skeleton_Headless: glb_Pirate_Skeleton_Headless,
  Pirate_Tentacle: glb_Pirate_Tentacle,
  Pug: glb_Pug,
  Soldier_Female: glb_Soldier_Female,
  Soldier_Male: glb_Soldier_Male,
  Suit_Female: glb_Suit_Female,
  Suit_Male: glb_Suit_Male,
  Viking_Female: glb_Viking_Female,
  Viking_Male: glb_Viking_Male,
  Witch: glb_Witch,
  Wizard: glb_Wizard,
  Worker_Female: glb_Worker_Female,
  Worker_Male: glb_Worker_Male,
  Zombie_Female: glb_Zombie_Female,
  Zombie_Male: glb_Zombie_Male,
  alien: glb_alien,
  vibey: glb_vibey,
};

/**
 * Undefined for anything unphotographed, which callers render as a drawn
 * fallback rather than a broken image.
 *
 * This is every character built from the rig, sold or free — the shelf, the
 * picker and the profile all draw the same tile, so splitting the art by who
 * has to pay for it would only mean one of those surfaces showing emoji. What
 * is *not* in here is the roster that ships as GLBs: those have a model to
 * render and photographing them would be a second copy of the same thing.
 */
export const characterArt = (id: string | null | undefined): string | undefined =>
  id ? CHARACTER_ART[id] : undefined;
