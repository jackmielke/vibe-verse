/**
 * Meanwhile, elsewhere in the solar system.
 *
 * The premise is that everybody is racing to the Moon and Mars and nobody
 * noticed Venus. The ticker is the race, told as headlines, and it notices
 * you a little more as you grow.
 */
import type { VenusSim } from "./sim";

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

/** One gentle nudge at a time, for the first few minutes. */
export function hintFor(sim: VenusSim): string | null {
  const s = sim.s, d = sim.d;
  if (s.fallen) return null;
  if (d.zone === "cook") return "Too low, the hull is cooking. Cut loose something heavy, or dump ballast.";
  if (d.eqAlt < 50.5) return "Too heavy: you are sinking. Add a Lift Bladder, dump ballast, or cut something loose.";
  if (d.zone === "freeze") return "Too high: the greenhouses are freezing. Vent some trim or build something heavy.";
  if (sim.count("dome") === 0) return "Build an Air Dome. Breathable air floats on Venus, so the houses are the balloons.";
  if (sim.count("harvester") === 0) return "Build a Carbon Harvester. The sky is 96% CO₂: that is your building material.";
  if (sim.count("solar") === 0) return "Build a Solar Canopy before the sun goes down. Night lasts half a lap.";
  if (sim.count("moxie") === 0) return "Build a MOXIE Plant: every new dome needs air to fill it.";
  if (d.food - s.pop < 5) return "People are arriving faster than food. Build a Greenhouse.";
  if (d.housing - s.pop < 5) return "Every bed is full. Build another Air Dome.";
  if (d.powered < 0.9) return "Brownout. More Solar Canopies: they also add battery for the night.";
  if (sim.count("jazz") === 0 && s.pop > 40) return "Life up here needs more than air. A Jazz Club makes culture.";
  if (s.pop >= 60 && sim.count("skyport") === 0) return "A Skyport triples arrivals from Earth, the Moon and Mars.";
  if (sim.freeSlots().length < 3 && s.tiles.some((t) => (t.level ?? 1) < 3)) return "Running out of room? Select a module and grow it.";
  return null;
}
