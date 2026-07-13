import type { ChamberEvent } from "./types";

// All events live in July 2026 (the demo month) so the calendar reads well.
export const chamberEvents: ChamberEvent[] = [
  {
    id: "ev-1",
    title: "Summer Mixer at Dry Creek Cellars",
    date: "2026-07-16",
    time: "5:30–7:30 PM",
    venue: "Dry Creek Cellars, Dry Creek Rd",
    registered: 84,
    capacity: 120,
    ticketPrice: 15,
    blurb: "Wine, small bites, and the best kind of small-town networking — golden hour in the vines.",
    registrants: ["CraftWork", "Boulangerie du Plaza", "Levee Street Books", "Plaza Day Spa", "Copita del Norte", "Early Bird Farm"],
  },
  {
    id: "ev-2",
    title: "Local Business AI Series at CraftWork",
    date: "2026-07-21",
    time: "12:00–1:30 PM",
    venue: "CraftWork, Center St",
    registered: 42,
    capacity: 50,
    ticketPrice: null,
    blurb: "Hands-on lunch session: what AI can actually do for a five-person Healdsburg business.",
    registrants: ["Spoke & Vine Bicycles", "Vine & Valley Accounting", "Gather Home & Garden", "Foss Creek Design Co.", "Riverbend Kayak Co."],
  },
  {
    id: "ev-3",
    title: "Ribbon Cutting — Solstice Ceramics Studio",
    date: "2026-07-24",
    time: "10:00 AM",
    venue: "312 Center St",
    registered: 28,
    capacity: 60,
    ticketPrice: null,
    blurb: "Welcome Healdsburg's newest maker space — big scissors, bigger smiles.",
    registrants: ["The Corvid Theater", "Healdsburg Art Collective", "Plaza Mercantile"],
  },
  {
    id: "ev-4",
    title: "HTID Board Meeting",
    date: "2026-07-28",
    time: "8:30–10:00 AM",
    venue: "Chamber office, Healdsburg Ave",
    registered: 11,
    capacity: 20,
    ticketPrice: null,
    blurb: "Healdsburg Tourism Improvement District — quarterly review of assessments and marketing spend.",
    registrants: ["Madrona House Inn", "Foss Creek Lodge", "Plaza Arms Hotel"],
  },
  {
    id: "ev-5",
    title: "First Fridays on the Plaza",
    date: "2026-07-03",
    time: "6:00–9:00 PM",
    venue: "Healdsburg Plaza",
    registered: 132,
    capacity: 200,
    ticketPrice: 10,
    blurb: "Live music, open galleries, late shop hours — the whole town out on a summer evening.",
    registrants: ["Willow & Vine Kitchen", "The Noble Fig", "Fitch Mountain Coffee", "Grove Street Provisions"],
  },
];

/** Simple month grid for July 2026: starts Wednesday (day 3), 31 days. */
export const JULY_2026 = { label: "July 2026", firstWeekday: 3, days: 31, today: 13 };
