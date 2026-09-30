/**
 * Meanwhile, elsewhere in the solar system.
 *
 * The premise is that everybody is racing to the Moon and Mars and nobody
 * noticed Venus. The ticker is the race, told as headlines, and it notices
 * you a little more as you grow.
 */
import type { VenusSim } from "./sim";
import type { ModuleId } from "./modules";

interface Line { min?: number; max?: number; text: string }

const LINES: Line[] = [
  { max: 100, text: "MOON · Mass driver launches satellite #48,210. Elon, watching from the rim, describes it as 'fine'." },
  { max: 100, text: "MARS · Colony One reports day 412 inside the tent. Morale 'rugged'." },
  { max: 150, text: "EARTH · Analysts agree Venus is 'too intense'. None of them have been above 50 km." },
  { text: "MARS · Residents ask whether 0.38 g counts as going to the gym." },
  { text: "MOON · Railgun queue now four years long. 'For the price of electricity,' says the brochure." },
  { text: "MERCURY · Now accepting disassembly bids. 'The Saudi Arabia of planets.'" },
  { text: "SOL · Venus receives 1.9× Earth's sunlight. Nobody is doing anything with it. Allegedly." },
  { min: 60, text: "MARS · Colonist posts photo of a Venusian sunset. It is the most-liked image in the history of Mars." },
  { min: 120, text: "EARTH · 'Where is everybody going?' asks a man who has not looked up." },
  { min: 200, text: "MOON · Every thousandth mass-driver launch is now booked through to Venus." },
  { min: 300, text: "MARS · Tent committee votes to 'explore options' sunward." },
  { min: 400, text: "EARTH · Venus has a jazz scene. Critics call it 'improvised', which is the point." },
  { min: 600, text: "MARS · Second tent now empty. Third tent has a 'For Rent' sign." },
  { min: 800, text: "EARTH · Venus overtakes Mars in population. Mars disputes the figures from inside a tent." },
  { min: 1000, text: "SOLAR SYSTEM · The utopia was on the planet everyone wrote off. Nobody saw it coming." },
];

export function tickerLines(sim: VenusSim): string[] {
  const pop = sim.s.pop;
  const out = LINES.filter((l) => (l.min === undefined || pop >= l.min) && (l.max === undefined || pop < l.max)).map((l) => l.text);
  out.push(`VENUS · ${sim.s.cityName} population ${Math.round(pop).toLocaleString()}. Altitude ${sim.s.alt.toFixed(1)} km. Weather: excellent.`);
  return out;
}

export type HintAction = ModuleId | "grow" | "ballast" | "cut" | "recycle" | null;

/** One gentle nudge at a time, and what it is asking for. */
export function hint(sim: VenusSim): { text: string; act: HintAction } | null {
  const s = sim.s, d = sim.d;
  if (s.fallen) return null;
  const full = sim.freeSlots().length === 0;
  const canBuild = !full;
  if (d.zone === "cook") return { text: "The hull is cooking. Cut loose something heavy, or dump ballast. Now.", act: "cut" };
  if (d.eqAlt < 50) return { text: "Too heavy: you are sinking toward the heat. Lift Bladders, dump ballast, or cut something loose.", act: "bladder" };
  if (d.eqAlt < 53.6 && d.air.tempC > 40) return { text: `Heading down to ${d.eqAlt.toFixed(1)} km, where it is too hot to be happy. Add lift or shed weight.`, act: "bladder" };
  if (d.zone === "freeze") return { text: "Too high: the greenhouses are freezing. Vent some trim, or build something heavy.", act: null };
  if (d.eqAlt > 57.5) return { text: "Drifting up into the cold. Heavy modules, water, or venting trim will bring you down.", act: null };
  if (sim.count("dome") === 0) return { text: "Build an Air Dome. Breathable air floats on Venus, so the houses are the balloons.", act: "dome" };
  if (sim.count("harvester") === 0) return { text: "Build a Carbon Harvester. The sky is 96% CO₂, and that is your building material.", act: "harvester" };
  if (sim.count("solar") === 0) return { text: "Build a Solar Canopy before the sun goes down. Night lasts half a lap.", act: "solar" };
  if (sim.count("moxie") === 0) return { text: "Build a MOXIE Plant: every new dome needs air to fill it.", act: "moxie" };
  if (d.dry && canBuild) return { text: "Out of water. People drink and greenhouses wilt: build an Acid Still.", act: "still" };
  if (d.dry) return { text: "Out of water and out of room. Recycle something (a spare Jazz Club?) to make space for an Acid Still.", act: "recycle" };
  if (d.powered < 0.9) {
    if (d.sun < 0.5) return { text: canBuild ? "Batteries flat on the night side. A Wind Kite makes power in the dark." : "Batteries flat on the night side. Grow a Wind Kite or a Solar Canopy.", act: canBuild ? "kite" : "grow" };
    return { text: "Brownout in broad daylight. Build a Solar Canopy.", act: "solar" };
  }
  if (canBuild && d.food - s.pop < 5) return { text: "People are arriving faster than food. Build a Greenhouse.", act: "greenhouse" };
  if (canBuild && d.housing - s.pop < 5) return { text: "Every bed is full. Build another Air Dome.", act: "dome" };
  if (full && (d.food - s.pop < 5 || d.housing - s.pop < 5)) return { text: "No room left on the deck. Select a Dome or Greenhouse and Grow it.", act: "grow" };
  if (canBuild && sim.count("jazz") < 1 + Math.floor(s.pop / 350) && s.pop > 40) return { text: "Life up here needs more than air. A Jazz Club makes culture, and culture makes people stay.", act: "jazz" };
  if (canBuild && d.sun > 0.55 && d.sun < 0.9 && d.dayPhase > 0.3 && d.dayPhase < 0.45 && d.eqAlt < 55 && sim.count("bladder") < 2 + s.tiles.length / 8)
    return { text: "Dusk is coming, and the city sags at night as the air in the envelopes cools. A Lift Bladder now saves a hot night.", act: "bladder" };
  if (canBuild && sim.count("harvester") < 1 + Math.floor(s.pop / 250)) return { text: "A city this size needs more carbon. Another Carbon Harvester.", act: "harvester" };
  if (canBuild && sim.count("moxie") < 1 + Math.floor(s.pop / 300)) return { text: "Domes need air. Another MOXIE Plant.", act: "moxie" };
  if (canBuild && s.pop >= 150 && sim.count("ballroom") === 0 && !sim.whyNot("ballroom")) return { text: "You can afford a Habsburg Ballroom. Status by character, not by money.", act: "ballroom" };
  if (canBuild && s.pop >= 60 && sim.count("skyport") === 0) return { text: "A Skyport triples arrivals from Earth, the Moon and Mars.", act: "skyport" };
  if (s.pop >= 900 && d.happiness < 0.7) {
    if (d.comfort < 0.9) return { text: "Nearly there, but people are uncomfortable. Get into the green band on the altimeter.", act: "bladder" };
    return { text: "Nearly there, but people need more to do. More Jazz, a Ballroom, or grow the ones you have.", act: "jazz" };
  }
  if (!canBuild && s.tiles.some((t) => (t.level ?? 1) < 3)) return { text: "Out of room. Select a module and Grow it.", act: "grow" };
  return null;
}

export function hintFor(sim: VenusSim): string | null {
  return hint(sim)?.text ?? null;
}
